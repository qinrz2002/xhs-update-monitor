'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto'), { spawnSync } = require('node:child_process');
const APP_ID = 'Local.XhsUpdateMonitor', NAME = '小红书更新监控';
const GUID = /^\{[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\}$/i;
function guid(value) {
  const h = createHash('sha256').update(value).digest('hex');
  return `{${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}}`.toUpperCase();
}
function notificationIdentity({ packaged, root, env = process.env }) {
  const isolated = Boolean(env.XHS_MONITOR_DATA || env.XHS_MONITOR_PROFILE || env.XHS_MONITOR_INSTANCE_SCOPE);
  const scope = createHash('sha256').update(path.resolve(env.XHS_MONITOR_INSTANCE_SCOPE || env.XHS_MONITOR_PROFILE || env.XHS_MONITOR_DATA || root).toLowerCase()).digest('hex').slice(0,16);
  const production = packaged && !isolated;
  const appId = production ? APP_ID : APP_ID + (packaged ? '.Test.' : '.Dev.') + scope;
  const testName = /^测试[\da-f]{5}$/.test(env.XHS_MONITOR_TEST_NOTIFICATION_NAME || '') ? env.XHS_MONITOR_TEST_NOTIFICATION_NAME : null;
  return { appId, name: production ? NAME : testName || NAME + (packaged ? '-测试-' : '-开发-') + scope, clsid: guid(appId), production,
    native: production || Boolean(packaged && isolated && testName && env.XHS_MONITOR_TEST_NOTIFICATIONS === '1') };
}
function repairNotificationRegistration({ app, shell, identity, executable = process.execPath, io = fs, run = spawnSync, directory, preferredClsid }) {
  if (!identity.native) return { enabled: false, reason: 'isolated-or-development' };
  if (/^electron\.exe$/i.test(path.basename(executable))) throw Error('正式通知不能绑定到开发用 Electron。');
  const programs = directory || path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const primary = path.join(programs, identity.name + '.lnk'), shortcuts = [primary];
  if (identity.production) {
    const legacy = path.join(programs, 'xhs-update-monitor.lnk');
    if (io.existsSync(legacy)) {
      try { if (shell.readShortcutLink(legacy).appUserModelId === APP_ID) shortcuts.push(legacy); } catch {}
    }
  }
  // Preserve our existing activator so notifications already in Action Center
  // also launch the installed app. Other apps' shortcut identities are untouched.
  if (GUID.test(preferredClsid || '')) identity.clsid = preferredClsid;
  for (const file of GUID.test(preferredClsid || '') ? [] : shortcuts) {
    if (!io.existsSync(file)) continue;
    try { const old = shell.readShortcutLink(file); if (old.appUserModelId === identity.appId && GUID.test(old.toastActivatorClsid || '')) { identity.clsid = old.toastActivatorClsid; break; } } catch {}
  }
  app.setToastActivatorCLSID(identity.clsid);
  io.mkdirSync(programs, { recursive: true });
  const options = { target: executable, cwd: path.dirname(executable), args: '', description: identity.name, icon: executable, iconIndex: 0, appUserModelId: identity.appId, toastActivatorClsid: identity.clsid };
  for (const file of shortcuts) if (!shell.writeShortcutLink(file, io.existsSync(file) ? 'replace' : 'create', options)) throw Error('无法保存通知启动快捷方式。');
  const registry = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const result = run(registry, ['add', 'HKCU\\Software\\Classes\\CLSID\\' + identity.clsid + '\\LocalServer32', '/ve', '/t', 'REG_SZ', '/d', '"' + executable + '"', '/f'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw Error('无法修复通知启动注册。');
  return { enabled: true, appId: identity.appId, clsid: identity.clsid, target: executable, shortcutCount: shortcuts.length };
}
module.exports = { APP_ID, NAME, notificationIdentity, repairNotificationRegistration };
