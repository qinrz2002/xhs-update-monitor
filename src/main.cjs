'use strict';
const e = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store.cjs');
const { CurlTransport } = require('./transport.cjs');
const { Collector, httpSessionVerified, stateFromHtml, parseProfile } = require('./collector.cjs');
const { accountFromState } = require('./account.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { LoginSession } = require('./session.cjs');
const { NativeNotifier } = require('./notifier.cjs');
const { Updates, REPOSITORY } = require('./updater.cjs');
const { AuthorDiscovery } = require('./author-discovery.cjs');
const { createMenu } = require('./menu.cjs');
const { instancePaths, bindDataLocation, restoreWindow, acquireSharedInstance, runningLegacyInstance, launchActivation } = require('./instance.cjs');
const ROOT = path.join(__dirname, '..');
e.app.setAppUserModelId('Local.XhsUpdateMonitor');
if(process.argv.includes('--xhs-activate-legacy')){
  const legacyProfile=path.join(ROOT,'data','desktop-profile');fs.mkdirSync(legacyProfile,{recursive:true});e.app.setPath('userData',legacyProfile);
  if(e.app.requestSingleInstanceLock()){e.app.releaseSingleInstanceLock();launchActivation(process.execPath,['--xhs-skip-legacy-forward']);}
  e.app.exit(0);
}
const { data: DATA, profile: PROFILE, pipe: INSTANCE_PIPE, locator: DATA_LOCATOR } = instancePaths(e.app, e.app.isPackaged ? path.dirname(process.execPath) : ROOT);
e.app.setAppUserModelId('Local.XhsUpdateMonitor');
let mainWindow, alarmWindow, tray, store, login, scheduler, transport, notifier, updates, quitting = false, testEvents = [], syncToken = 0;
let notificationStatus = 'not_yet_shown', activationPending = false, mainReady = false, instanceServer, discovery;
function recordStartup(event, details = {}) {
  const directory = !e.app.isPackaged && process.env.XHS_MONITOR_DATA ? path.join(ROOT, 'evidence') : path.join(DATA, 'logs');
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, 'desktop-startup.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, electron: process.versions.electron, ...details }) + '\n');
}
function state() {
  const snapshot = store.snapshot();
  return { ...snapshot, appVersion:require('../package.json').version, softwareUpdate:updates?.snapshot(), login: login.state, account: login.account, sessionBlocked: scheduler.sessionBlocked, queued: scheduler.queue.map(j => j.id), active: scheduler.active?.id || null, pending: [...store.pending(), ...testEvents], notificationSupported: e.Notification.isSupported(), notificationStatus, dataDirectory: DATA };
}
function broadcast() {
  if (!store || !login || !scheduler) return;
  const value = state();
  for (const w of [mainWindow, alarmWindow]) if (w && !w.isDestroyed()) w.webContents.send('monitor:state', value);
}
function localWindow(options) {
  const win = new e.BrowserWindow({ icon: path.join(ROOT, 'ui', 'app.ico'), ...options, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  return win;
}
function openMain() {
  if(mainWindow&&!mainWindow.isDestroyed()){if(mainReady)restoreWindow(mainWindow);else activationPending=true;return;}
  mainReady=false;
  mainWindow = localWindow({ title: '小红书更新监控', width: 1480, height: 960, minWidth: 1040, minHeight: 720, show: false, backgroundColor: store.state.config.theme === 'dark' ? '#101318' : '#f5f6f8', autoHideMenuBar: true });
  recordStartup('main-window-created', { windowId: mainWindow.id });
  mainWindow.loadFile(path.join(ROOT, 'ui', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => recordStartup('main-document-loaded'));
  mainWindow.webContents.on('preload-error', () => recordStartup('preload-error'));
  mainWindow.webContents.on('render-process-gone', (_event, details) => recordStartup('renderer-exit', { reason: details.reason }));
  mainWindow.once('ready-to-show', () => { mainReady=true; mainWindow.show(); broadcast();if(activationPending)activateExisting(); });
  mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
}
function activateExisting(){
  activationPending=true;if(!store||!login||!scheduler)return;
  openMain();if(!mainReady)return;
  restoreWindow(login.window);activationPending=false;
  recordStartup('existing-instance-activated',{mainWindowId:mainWindow.id,visible:mainWindow.isVisible(),minimized:mainWindow.isMinimized(),focused:mainWindow.isFocused(),windowCount:e.BrowserWindow.getAllWindows().length});
}
function acknowledge(ids) {
  store.acknowledge(ids);
  const set = new Set(ids); testEvents = testEvents.filter(u => !set.has(u.eventId));
  syncAlarm(); if (store.pending().length || testEvents.length) notifyNative(); broadcast();
}
function syncAlarm() {
  const pending = [...store.pending(), ...testEvents];
  if (!pending.length) { if (alarmWindow && !alarmWindow.isDestroyed()) alarmWindow.destroy(); alarmWindow = null; notifier?.clear(); return; }
  if (!alarmWindow || alarmWindow.isDestroyed()) {
    const { workArea } = e.screen.getPrimaryDisplay();
    alarmWindow = localWindow({ title: '新笔记提醒', width: 420, height: 310, x: Math.max(0, workArea.x + workArea.width - 440), y: Math.max(0, workArea.y + workArea.height - 330), frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: false, show: false, backgroundColor: store.state.config.theme === 'dark' ? '#1c2129' : '#ffffff' });
    alarmWindow.loadFile(path.join(ROOT, 'ui', 'alarm.html'));
    alarmWindow.once('ready-to-show', () => { alarmWindow.showInactive(); broadcast(); });
    alarmWindow.on('close', event => { if (!quitting) { event.preventDefault(); /* titlebar/Alt-F4 confirms only IDs actually rendered */ alarmWindow.webContents.send('monitor:dismiss-request'); } });
  }
  broadcast();
}
function notifyNative() {
  if (!store.state.config.notifications) { notifier?.clear(); return; }
  notifier?.show([...store.pending(), ...testEvents]);
}
async function verifyLogin({ explicit = false } = {}) {
  const token = ++syncToken;
  const m = store.state.monitors[0];
  try {
    let result;
    if (m) result = await new Collector(transport).collect(m);
    else {
      const response = await transport.request('https://www.xiaohongshu.com/explore');
      let account; try { if (response.status === 200) account = accountFromState(stateFromHtml(response.body)); } catch {}
      result = account ? { status: 'account_verified', account } : parseProfile(response, '');
    }
    if (token !== syncToken) return;
    if (httpSessionVerified(result) || result.status === 'account_verified') {
      login.setAccount(result.account);
      const reason = store.state.accessBlock?.reason;
      if (!explicit && ['account_restricted','client_restricted'].includes(reason)) { login.setState(reason); return; }
      login.verified(); scheduler.unblock();
    }
    else if (result.status === 'login_required') { scheduler.blockSession(); login.invalid(); if (store.state.config.autoLogin) login.open({ automatic: true }); }
    else if (result.status === 'verification_required') { scheduler.blockSession('verification_required'); login.setState('verification_required'); }
    else if (['account_restricted','client_restricted'].includes(result.status)) { scheduler.blockSession(result.status); login.setState(result.status); }
    else login.setState('http_not_verified');
  } catch { if (token === syncToken) login.setState('network_error'); }
}
function checkSender(event) {
  const sender = event.sender;
  if (![mainWindow, alarmWindow].some(w => w && !w.isDestroyed() && w.webContents === sender)) throw new Error('未授权窗口。');
  const url = sender.getURL();
  if (!url.startsWith('file:') || (event.senderFrame && event.senderFrame !== sender.mainFrame)) throw new Error('未授权页面。');
}
e.ipcMain.handle('monitor:command', async (event, action, value) => {
  checkSender(event);
  try {
    switch (action) {
      case 'snapshot': recordStartup('renderer-ipc-ready', { window: event.sender === mainWindow?.webContents ? 'main' : 'alarm', theme: store.state.config.theme, monitorCount: store.state.monitors.length }); return { ok: true, state: state() };
      case 'ui-ready': {
        if (!value || !['light','dark'].includes(value.theme) || typeof value.visible !== 'boolean') throw new Error('界面就绪信息无效。');
        recordStartup('renderer-theme-applied', { window: event.sender === mainWindow?.webContents ? 'main' : 'alarm', theme: value.theme, visible: value.visible, matchesSavedTheme: value.theme === store.state.config.theme });
        return { ok: true };
      }
      case 'add': {
        if (scheduler.active || scheduler.queue.length) throw new Error('正在采集，请稍后添加，避免并发请求。');
        const identity = await discovery.confirm(value?.key);
        const result = store.add(identity); if (!result.duplicate) { result.monitor.avatar=identity.avatar;scheduler.plan(result.monitor); store.commit(); } broadcast();
        return { ok: true, duplicate: result.duplicate, id: identity.id };
      }
      case 'preview-author': return { ok: true, candidate: await discovery.preview(value) };
      case 'search-authors': return { ok: true, candidates: await discovery.search(value) };
      case 'preview-author-home': return { ok: true, candidate: discovery.open(value,login) };
      case 'show-menu': mainWindow.setMenuBarVisibility(true);mainWindow.focus();break;
      case 'remove': scheduler.remove(String(value)); syncAlarm(); if (store.pending().length || testEvents.length) notifyNative(); break;
      case 'undo': store.restore(String(value)); scheduler.reschedule(); break;
      case 'pause': scheduler.pause(value.id, Boolean(value.enabled)); break;
      case 'settings': scheduler.settings(value.id || null, value.settings); break;
      case 'update-author': {
        const id = String(value.id), current = store.state.monitors.find(m => m.id === id);
        if (!current) throw new Error('博主已不存在。');
        const identity = await transport.resolve(String(value.url).slice(0,4096));
        const changed = scheduler.replaceProfile(id,identity,value.settings);
        syncAlarm(); notifyNative(); broadcast();
        return { ok: true, id: changed.monitor.id, refreshQueued: changed.refreshQueued };
      }
      case 'author-articles': {
        const m = store.state.monitors.find(m => m.id === String(value));
        if (!m) throw new Error('博主已不存在。');
        return { ok: true, author: { id: m.id, name: m.name }, notes: store.articleList(m.id), historyComplete: m.coverageScope === 'list_end', coverageVerified: m.coverageVerified, lastRead: m.lastProfileRead || m.lastAttempt };
      }
      case 'config': {
        const allowed = ['theme','notifications','sound','autoLogin','automaticUpdates'];
        const patch = {}; for (const key of allowed) if (key in value) patch[key] = value[key];
        store.configure(patch); if ('automaticUpdates' in patch) updates?.configure(patch.automaticUpdates); syncAlarm(); if ('notifications' in patch) notifyNative(); break;
      }
      case 'running': scheduler.setRunning(Boolean(value)); break;
      case 'check': {
        const ids = value ? [String(value)] : store.state.monitors.filter(m => m.enabled).map(m => m.id);
        if (scheduler.sessionBlocked) throw new Error('当前登录或验证未通过，请先重新登录并验证。');
        for (const id of ids) scheduler.enqueue(id, true);
        scheduler.tick(); break;
      }
      case 'login': login.open(); break;
      case 'check-update': await updates.check(); break;
      case 'install-update': updates.install(); break;
      case 'open-github': await e.shell.openExternal(REPOSITORY); break;
      case 'open-home': login.openHome(); break;
      case 'verify': await verifyLogin({ explicit: true }); break;
      case 'ack': acknowledge(Array.isArray(value) ? value.slice(0, 10000) : []); break;
      case 'read': for (const u of store.state.updates) if (value === 'all' || u.eventId === value) u.read = true; store.commit(); break;
      case 'view': openMain(); mainWindow.webContents.send('monitor:navigate', 'updates'); break;
      case 'open-note': {
        const item = store.state.updates.find(u => u.eventId === value) || store.state.monitors.flatMap(m => m.notes).find(n => n.id === value);
        if (!item?.url) throw new Error('尚未取得可用笔记链接。');
        const url = new URL(item.url); if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com') throw new Error('链接无效。');
        await e.shell.openExternal(url.href); break;
      }
      case 'open-author-note': {
        const item = store.articleList(String(value.userId)).find(n => n.id === String(value.noteId));
        if (!item?.url) throw new Error('这篇笔记暂时没有可用链接，请刷新博主资料。');
        const url = new URL(item.url);
        if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com' || !/^\/explore\/[a-f\d]{24}\/?$/i.test(url.pathname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('笔记链接无效。');
        await e.shell.openExternal(url.href); break;
      }
      case 'test-alarm': testEvents = [{ eventId: 'test-' + Date.now(), author: '测试提醒', title: '这是手动触发的测试，不是真实新文章', test: true }]; syncAlarm(); notifyNative(); break;
      case 'quit': quitting = true; e.app.quit(); break;
      default: throw new Error('未知操作。');
    }
    broadcast(); return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
if (!e.app.requestSingleInstanceLock({ application: 'XhsUpdateMonitor', pid: process.pid })) { recordStartup('secondary-instance-exited', { pid: process.pid }); e.app.exit(0); }
else {
  e.app.on('second-instance', activateExisting);
  acquireSharedInstance(INSTANCE_PIPE,activateExisting,{shutdownForUpdate:async()=>{
    scheduler?.stop();updates?.stop();store?.commit();
    try{if(login)await login.persist();}catch{scheduler?.startTimer();updates?.start();return;}
    quitting=true;e.app.quit();
  }}).then(async shared=>{
    if(!shared.owner){recordStartup('secondary-instance-exited',{pid:process.pid,sharedChannel:true});e.app.exit(0);return;}
    instanceServer=shared.server;
    if(!process.env.XHS_MONITOR_PROFILE&&!process.env.XHS_MONITOR_DATA&&!process.argv.includes('--xhs-skip-legacy-forward')){
      const legacy=runningLegacyInstance(ROOT);
      if(legacy){instanceServer.close();e.app.releaseSingleInstanceLock();const launched=launchActivation(legacy.executable,['--xhs-activate-legacy']);recordStartup('legacy-instance-activated',{pid:legacy.pid,activationLaunched:launched});e.app.exit(launched?0:1);}
    }
    recordStartup('primary-instance-acquired',{pid:process.pid,profile:PROFILE,sharedChannel:true});
    await e.app.whenReady();
    store = new Store(DATA);
    const installed=e.app.isPackaged&&fs.existsSync(path.join(path.dirname(process.execPath),'Uninstall 小红书更新监控.exe'));
    updates = new Updates({app:e.app,engine:require('electron-updater').autoUpdater,installed,enabled:store.state.config.automaticUpdates!==false,beforeInstall:()=>{quitting=true;scheduler?.stop();store.commit();}});
    updates.on('change',broadcast);updates.start();
    bindDataLocation(DATA_LOCATOR,DATA);
    login = new LoginSession(e, DATA);
    login.setAccount(store.state.account);
    login.on('account', account => { store.state.account = account; store.commit(); broadcast(); });
    transport = new CurlTransport({ cookies: url => login.cookieHeader(url), onSetCookies: (url, lines) => login.setCookies(url, lines) });
    discovery = new AuthorDiscovery(transport);
    scheduler = new Scheduler(store, new Collector(transport));
    notifier = new NativeNotifier(e.Notification, {
      acknowledge,
      view: () => { openMain(); mainWindow.webContents.send('monitor:navigate', 'updates'); },
      observed: (event, reason) => { recordStartup('native-notification-' + event, reason ? { reason } : {}); if (event === 'shown' || event === 'failed') { notificationStatus = event; broadcast(); } },
    });
    if (!store.state.monitors.length && !store.state.archive.length) store.add({ id: '5e314c060000000001004e26', name: '胡图图', url: 'https://www.xiaohongshu.com/user/profile/5e314c060000000001004e26' });
    scheduler.reschedule();
    scheduler.on('change', broadcast);
    scheduler.on('new-updates', () => { syncAlarm(); notifyNative(); });
    scheduler.on('login-required', () => { login.invalid(); if (store.state.config.autoLogin) login.open({ automatic: true }); });
    scheduler.on('verification-required', () => login.setState('verification_required'));
    scheduler.on('account-restricted', status => login.setState(status));
    scheduler.on('account', account => login.setAccount(account));
    login.on('change', broadcast); login.on('candidate', () => { void verifyLogin(); });
    login.on('login-page-loaded', details => recordStartup('official-login-document-loaded', details));
    await login.init();
    if (['account_restricted','client_restricted','verification_required'].includes(store.state.accessBlock?.reason)) login.setState(store.state.accessBlock.reason);
    const icon = e.nativeImage.createFromPath(path.join(ROOT, 'ui', 'tray.png'));
    tray = new e.Tray(icon); tray.setToolTip('小红书更新监控');
    tray.setContextMenu(e.Menu.buildFromTemplate([
      { label: '打开面板', click: openMain },
      { label: '暂停监控', click: () => scheduler.setRunning(false) },
      { label: '关闭当前提醒', click: () => acknowledge([...store.pending(), ...testEvents].map(u => u.eventId)) },
      { type: 'separator' }, { label: '退出应用', click: () => { quitting = true; e.app.quit(); } },
    ]));
    tray.on('double-click', openMain);
    recordStartup('tray-created', { notificationSupported: e.Notification.isSupported(), sandbox: true, contextIsolation: true });
    e.Menu.setApplicationMenu(createMenu(e,{openMain,quit:()=>{quitting=true;e.app.quit();},navigate:page=>{openMain();mainWindow.webContents.send('monitor:navigate',page);}}));
    scheduler.startTimer(); openMain();
    if(activationPending)activateExisting();
    e.powerMonitor.on('resume', () => scheduler.reschedule());
    syncAlarm(); notifyNative();
    if (login.state === 'unverified') void verifyLogin();
    else if (login.state === 'not_logged_in' && store.state.config.autoLogin) {
      scheduler.blockSession(); login.open({ automatic: true });
      recordStartup('automatic-login-opened', { hasWindow: Boolean(login.window && !login.window.isDestroyed()) });
    }
  }).catch(() => { e.dialog.showErrorBox('启动失败', '本地数据或桌面依赖无法加载。请保留 data 目录并查看交付说明。'); e.app.exit(1); });
}
e.app.on('window-all-closed', () => {});
e.app.on('before-quit', () => { quitting = true; updates?.stop(); scheduler?.stop(); if (alarmWindow && !alarmWindow.isDestroyed()) alarmWindow.destroy(); store?.commit(); instanceServer?.close(); });
