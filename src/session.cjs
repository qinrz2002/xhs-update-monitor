'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { USER_AGENT } = require('./transport.cjs');
const { validAccount } = require('./account.cjs');
class LoginSession extends EventEmitter {
  constructor(electron, directory) {
    super(); this.e = electron; this.directory = directory; this.window = null; this.state = 'unknown'; this.openedCycle = false; this.captureBusy = false;
    this.session = electron.session.fromPartition('persist:xhs-monitor-login');
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.setUserAgent(USER_AGENT);
    this.lastSession = null; this.restoring = false; this.capturePending = false; this.captureExisting = false; this.persistTail = Promise.resolve(); this.lastCandidateAt = 0; this.navigationTimer = null;
    this.account = null; this.windowPurpose = 'login'; this.revision = 0; this.verification = null;
    this.session.cookies.on('changed', (_event, cookie, _cause, removed) => { if (!this.restoring && cookie.name === 'web_session' && this.isXhs(cookie.domain) && !removed && cookie.value !== this.lastSession) void this.capture(); });
  }
  isXhs(domain) { if (typeof domain !== 'string') return false; const d = domain.toLowerCase().replace(/^\./, ''); return d === 'xiaohongshu.com' || d.endsWith('.xiaohongshu.com'); }
  async init() {
    const file = path.join(this.directory, 'session.enc');
    this.restoring = true;
    try {
      // The browser partition can contain a newer server-rotated session than
      // the encrypted export (for example after an interrupted shutdown).
      const live = await this.session.cookies.get({ url: 'https://www.xiaohongshu.com/' });
      if (live.some(c => c.name === 'web_session' && c.value && this.isXhs(c.domain) && (!c.expirationDate || c.expirationDate > Date.now()/1000))) {
        this.setState('unverified'); return;
      }
      if (fs.existsSync(file)) {
      const encoded = fs.readFileSync(file);
      const secret = this.e.safeStorage.decryptStringAsync ? (await this.e.safeStorage.decryptStringAsync(encoded)).result : this.e.safeStorage.decryptString(encoded);
      const saved = JSON.parse(secret);
      for (const cookie of saved.cookies || []) {
        if (!this.isXhs(cookie.domain) || (cookie.expirationDate && cookie.expirationDate < Date.now() / 1000)) continue;
        const clean = { ...cookie, url: 'https://' + cookie.domain.replace(/^\./, '') + (cookie.path || '/') };
        delete clean.hostOnly; delete clean.session;
        if (cookie.hostOnly) delete clean.domain;
        await this.session.cookies.set(clean);
      }
      }
      const cookies = await this.session.cookies.get({ url: 'https://www.xiaohongshu.com/' });
      this.setState(cookies.some(c => c.name === 'web_session' && c.value && this.isXhs(c.domain)) ? 'unverified' : 'not_logged_in');
    } catch { this.setState('session_unavailable'); }
    finally { this.restoring = false; }
  }
  setState(state, details = null) { this.state = state; this.verification = details; this.emit('change'); }
  setAccount(value) { const account = validAccount(value); if (JSON.stringify(this.account) === JSON.stringify(account)) return; this.account = account; this.emit('account', account); this.emit('change'); }
  async readPageAccount(win) {
    if (win.isDestroyed() || !win.webContents.getURL().startsWith('https://www.xiaohongshu.com/')) return;
    try {
      const account = await win.webContents.executeJavaScript(`(() => {const user=window.__INITIAL_STATE__?.user;if(user?.loggedIn!==true)return null;const info=user.userInfo;if(!info)return null;return {id:String(info.userId||info.user_id||info.id||''),name:String(info.nickname||info.nickName||info.name||'')};})()`);
      if (win.isDestroyed() || this.window !== win) return;
      if (validAccount(account)) {
        this.setAccount(account);
        const profile = 'https://www.xiaohongshu.com/user/profile/' + this.account.id;
        if (this.window === win && this.windowPurpose === 'home' && new URL(win.webContents.getURL()).pathname !== new URL(profile).pathname) await win.loadURL(profile);
      }
    } catch { /* Public account metadata is optional; never infer it from the viewed author. */ }
  }
  async cookieHeader(url) {
    const cookies = await this.session.cookies.get({ url });
    return cookies.filter(c => this.isXhs(c.domain)).map(c => c.name + '=' + c.value).join('; ');
  }
  persist() {
    const operation = this.persistTail.then(() => this.writeSession());
    this.persistTail = operation.catch(() => {});
    return operation;
  }
  async writeSession() {
    const cookies = (await this.session.cookies.get({})).filter(c => this.isXhs(c.domain));
    const payload = JSON.stringify({ cookies, savedAt: new Date().toISOString() });
    const safe = this.e.safeStorage;
    const available = safe.isAsyncEncryptionAvailable ? await safe.isAsyncEncryptionAvailable() : safe.isEncryptionAvailable();
    if (!available) throw new Error('Windows 会话加密不可用，未明文保存凭据。');
    const encrypted = safe.encryptStringAsync ? await safe.encryptStringAsync(payload) : safe.encryptString(payload);
    const file = path.join(this.directory, 'session.enc');
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(file + '.tmp', encrypted); fs.renameSync(file + '.tmp', file);
  }
  async capture({ verifyExisting = false } = {}) {
    this.capturePending = true;
    this.captureExisting ||= verifyExisting;
    if (this.captureBusy) return;
    this.captureBusy = true;
    try {
      do {
      this.capturePending = false;
      const verifyExisting = this.captureExisting; this.captureExisting = false;
      const cookies = await this.session.cookies.get({ url: 'https://www.xiaohongshu.com/' });
      const current = cookies.find(c => c.name === 'web_session' && c.value && this.isXhs(c.domain));
      if (current && (current.value !== this.lastSession || verifyExisting)) {
        if (current.value !== this.lastSession) { this.revision++; this.setAccount(null); }
        await this.persist(); this.lastSession = current.value;
        this.lastCandidateAt = Date.now();
        this.setState('unverified'); this.emit('candidate');
      }
      } while (this.capturePending);
    } catch { this.setState('session_unavailable'); }
    finally { this.captureBusy = false; }
  }
  async setCookies(url, lines) {
    // Only update cookies issued by the exact official response origin.
    const origin = new URL(url);
    if (origin.protocol !== 'https:' || !['www.xiaohongshu.com','edith.xiaohongshu.com'].includes(origin.hostname)) return;
    let changed = false;
    for (const line of lines) {
      const parts = line.split(';'), index = parts[0].indexOf('='); if (index < 1) continue;
      const defaultPath = origin.pathname.slice(0, origin.pathname.lastIndexOf('/')) || '/';
      const cookie = { url, name: parts[0].slice(0,index).trim(), value: parts[0].slice(index+1), path: defaultPath };
      let invalidDomain = false, maxAge;
      for (const field of parts.slice(1)) {
        const i = field.indexOf('='), key = (i < 0 ? field : field.slice(0,i)).trim().toLowerCase(), value = i < 0 ? '' : field.slice(i+1).trim();
        if (key === 'domain') {
          const domain = value.toLowerCase().replace(/^\./, '');
          if (!this.isXhs(domain) || !(origin.hostname === domain || origin.hostname.endsWith('.' + domain))) invalidDomain = true;
          else cookie.domain = value;
        }
        if (key === 'path' && value.startsWith('/')) cookie.path = value;
        if (key === 'secure') cookie.secure = true;
        if (key === 'httponly') cookie.httpOnly = true;
        if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expirationDate = Date.parse(value) / 1000;
        if (key === 'max-age' && /^-?\d+$/.test(value) && Number.isFinite(Number(value))) maxAge = Number(value);
        if (key === 'samesite' && ['strict','lax','none'].includes(value.toLowerCase())) cookie.sameSite = value.toLowerCase() === 'none' ? 'no_restriction' : value.toLowerCase();
      }
      if (invalidDomain) continue;
      if (maxAge !== undefined) cookie.expirationDate = Date.now()/1000 + maxAge;
      // A cookie rotated by an already-completed curl response must not enqueue
      // another login probe. Browser login still uses capture() normally.
      const priorSession = this.lastSession;
      if (cookie.name === 'web_session') this.lastSession = cookie.value;
      try { await this.session.cookies.set(cookie); changed = true; } catch { this.lastSession = priorSession; }
    }
    if (changed) await this.persist();
  }
  openHome() { this.open({ purpose: 'home' }); }
  openAuthor(value) {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'www.xiaohongshu.com' || !/^\/user\/profile\/[a-f\d]{24}\/?$/i.test(u.pathname) || u.username || u.password || (u.port && u.port !== '443')) throw new Error('博主主页链接无效。');
    this.open({ purpose: 'author', authorUrl: u.href });
  }
  open({ automatic = false, purpose = 'login', authorUrl } = {}) {
    const title = purpose === 'home' ? '我的小红书主页' : purpose === 'author' ? '确认博主 · 核对后返回面板' : '小红书官方扫码登录';
    const target = purpose === 'author' ? authorUrl : purpose === 'home' ? (this.account ? 'https://www.xiaohongshu.com/user/profile/' + this.account.id : 'https://www.xiaohongshu.com/explore') : 'https://www.xiaohongshu.com/login';
    if (this.window && !this.window.isDestroyed()) {
      if (automatic) return;
      this.windowPurpose = purpose; this.window.setTitle(title);
      if (this.window.isMinimized?.()) this.window.restore(); this.window.show?.(); this.window.focus();
      if (this.window.webContents.getURL() !== target) this.window.loadURL(target).catch(() => this.setState('network_error'));
      if (purpose === 'login') { this.openedCycle = true; this.setState('waiting_scan'); }
      return;
    }
    if (automatic && this.openedCycle) return;
    if (purpose === 'login') this.openedCycle = true;
    this.windowPurpose = purpose;
    const win = this.window = new this.e.BrowserWindow({ title, icon: path.join(__dirname, '..', 'ui', 'app.ico'), width: 1000, height: 800, autoHideMenuBar: true, webPreferences: { session: this.session, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    const allowed = value => { try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'www.xiaohongshu.com' || u.hostname === 'xiaohongshu.com'); } catch { return false; } };
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    const afterNavigation = url => {
      clearTimeout(this.navigationTimer); this.navigationTimer = null;
      if (!allowed(url) || this.state === 'logged_in') return;
      const pathname = new URL(url).pathname;
      if (/login|captcha|verify|challenge/i.test(pathname)) return;
      // A server-side login can keep web_session unchanged. Revalidate after
      // leaving the login page, coalescing navigation events and spacing probes.
      this.navigationTimer = setTimeout(() => {
        this.navigationTimer = null;
        if (this.window !== win || win.isDestroyed() || this.state === 'logged_in' || this.state === 'verification_required') return;
        if (Date.now() - this.lastCandidateAt < 10000) { afterNavigation(url); return; }
        void this.capture({ verifyExisting: true });
      }, Math.max(1000, 10000 - (Date.now() - this.lastCandidateAt)));
    };
    win.webContents.on('did-finish-load', () => { const url = win.webContents.getURL(); void this.capture(); void this.readPageAccount(win); afterNavigation(url); if (allowed(url)) { const page = new URL(url); this.emit('login-page-loaded', { page: page.origin + page.pathname }); } });
    win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) { afterNavigation(url); void this.readPageAccount(win); } });
    win.on('closed', () => { clearTimeout(this.navigationTimer); this.navigationTimer = null; this.window = null; if (this.windowPurpose === 'login' && this.state !== 'logged_in') this.setState('login_cancelled'); });
    if (purpose === 'login') this.setState('waiting_scan');
    win.loadURL(target).catch(() => this.setState('network_error'));
  }
  verified() { this.openedCycle = false; this.setState('logged_in'); if (this.windowPurpose === 'login') this.window?.close(); }
  invalid() { this.setAccount(null); this.setState('expired'); }
}
module.exports = { LoginSession };
