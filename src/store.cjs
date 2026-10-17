'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DEFAULT_CONFIG = { theme: 'light', baseMinutes: 10, jitterMinutes: 5, notifications: true, sound: true, autoLogin: true, running: false };
function interval(config) {
  const b = Number(config.baseMinutes), j = Number(config.jitterMinutes);
  if (!Number.isFinite(b) || !Number.isFinite(j) || b <= 0 || j < 0 || b - j < 1 || b > 10080) throw new Error('基础间隔减去浮动至少为 1 分钟，基础间隔最多为 7 天。');
  return { baseMinutes: b, jitterMinutes: j };
}
function randomDelay(config, random = Math.random) {
  const { baseMinutes: b, jitterMinutes: j } = interval(config);
  const min = Math.ceil((b - j) * 60), max = Math.floor((b + j) * 60);
  return min + Math.floor(random() * (max - min + 1));
}
class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.state = this.read('state.json', { schemaVersion: 1, config: DEFAULT_CONFIG, monitors: [], updates: [], archive: [] });
    this.state.config = { ...DEFAULT_CONFIG, ...this.state.config };
    if (!this.state.accessBlock || typeof this.state.accessBlock !== 'object') this.state.accessBlock = null;
    if (!['light', 'dark'].includes(this.state.config.theme)) this.state.config.theme = 'light';
    try { interval(this.state.config); } catch { Object.assign(this.state.config, { baseMinutes: 10, jitterMinutes: 5 }); }
    if (!Array.isArray(this.state.monitors) || !Array.isArray(this.state.updates) || !Array.isArray(this.state.archive)) throw new Error('数据结构异常，请从备份恢复。');
    this.commit();
  }
  read(name, fallback) {
    const file = path.join(this.directory, name);
    if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return structuredClone(fallback);
    for (const candidate of [file, file + '.bak']) {
      try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch {}
    }
    throw new Error('数据及备份均无法读取；已停止写入，防止丢失历史。');
  }
  commit() {
    // One atomic document keeps baseline and notification events in one transaction.
    const file = path.join(this.directory, 'state.json'), temp = file + '.tmp';
    const content = JSON.stringify(this.state, null, 2) + '\n';
    JSON.parse(content);
    if (fs.existsSync(file)) {
      try { JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, file + '.bak'); } catch {}
    }
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  snapshot() { return structuredClone(this.state); }
  add(identity) {
    if (!/^[a-f0-9]{24}$/i.test(identity.id)) throw new Error('博主 ID 不正确。');
    const existing = this.state.monitors.find(m => m.id === identity.id);
    if (existing) return { monitor: existing, duplicate: true };
    const monitor = { id: identity.id, name: identity.name || '新博主', url: identity.url, enabled: true, generation: randomUUID(), status: 'pending', nextDue: null, lastAttempt: null, lastSuccess: null, initialized: false, seen: [], notes: [], settings: null, failures: 0, identityVerified: false, candidate: null, coverageVerified: false };
    this.state.monitors.push(monitor); this.commit(); return { monitor, duplicate: false };
  }
  remove(id) {
    const m = this.state.monitors.find(m => m.id === id);
    if (!m) return;
    this.state.archive.push({ ...m, deletedAt: new Date().toISOString() });
    this.state.monitors = this.state.monitors.filter(m => m.id !== id);
    for (const u of this.state.updates) if (u.userId === id && !u.ackAt) u.ackAt = new Date().toISOString();
    this.commit();
  }
  restore(id) {
    if (this.state.monitors.some(m => m.id === id)) return;
    const index = this.state.archive.findLastIndex(m => m.id === id);
    if (index < 0) return;
    const m = this.state.archive.splice(index, 1)[0];
    delete m.deletedAt; m.generation = randomUUID(); m.nextDue = null;
    if (m.status === 'checking') { m.status = 'pending'; m.message = '已恢复监控，等待下次检测。'; }
    this.state.monitors.push(m); this.commit();
  }
  replaceProfile(id, identity, settings) {
    const index = this.state.monitors.findIndex(m => m.id === id);
    if (index < 0) throw new Error('博主已不存在。');
    if (!/^[a-f\d]{24}$/i.test(identity.id)) throw new Error('博主 ID 不正确。');
    if (identity.id !== id && this.state.monitors.some(m => m.id === identity.id)) throw new Error('这个链接对应的博主已在列表中，未修改原条目。');
    const cleanSettings = settings === null ? null : interval(settings);
    const previous = this.state.monitors[index];
    let next;
    if (identity.id === id) next = { ...previous, url: identity.url, generation: randomUUID(), settings: cleanSettings, status: 'pending', message: '主页链接已保存，等待重新读取博主信息。', nextDue: null, candidate: null };
    else {
      this.state.archive.push({ ...previous, deletedAt: new Date().toISOString(), replacedBy: identity.id });
      for (const u of this.state.updates) if (u.userId === id && !u.ackAt) u.ackAt = new Date().toISOString();
      next = { id: identity.id, name: identity.name || '新博主', url: identity.url, enabled: previous.enabled, generation: randomUUID(), status: 'pending', message: '等待读取新博主信息。', nextDue: null, lastAttempt: null, lastSuccess: null, initialized: false, seen: [], notes: [], previewNotes: [], settings: cleanSettings, failures: 0, identityVerified: false, candidate: null, coverageVerified: false };
    }
    next.profileRefreshPending = true;
    this.state.monitors[index] = next; this.commit(); return next;
  }
  applyProfile(id, generation, result) {
    const m = this.state.monitors.find(m => m.id === id && m.generation === generation);
    if (!m) return { stale: true, events: [] };
    m.lastProfileAttempt = new Date().toISOString();
    m.profileRefreshPending = ['login_required','verification_required','account_restricted','client_restricted'].includes(result.status);
    if (result.usable && result.loggedIn && result.stableIdFormat) {
      if (result.name) m.name = result.name;
      if (result.avatar) m.avatar = result.avatar;
      m.previewNotes = result.notes; m.lastProfileRead = m.lastProfileAttempt;
      m.status = 'profile_updated'; m.message = `博主资料已刷新，读取 ${result.notes.length} 篇近期笔记。`;
      if (!result.coverageVerified) m.message += '文章列表尚未完整覆盖。';
    } else { m.status = result.status; m.message = result.message || '本次未能读取博主信息，保留上次结果。'; }
    this.commit(); return { events: [] };
  }
  articleList(id) {
    const m = this.state.monitors.find(m => m.id === id);
    if (!m) throw new Error('博主已不存在。');
    const rows = [...(m.previewNotes || []), ...(m.candidate?.notes || []), ...m.notes, ...this.state.updates.filter(u => u.userId === id)];
    const unique = new Map();
    for (const row of rows) if (/^[a-f\d]{24}$/i.test(row.id || '') && !unique.has(row.id)) unique.set(row.id, { id: row.id, title: row.title || '无标题笔记', url: row.url || null, publishedAt: row.publishedAt || null, pinned: Boolean(row.pinned) });
    return [...unique.values()].sort((a,b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  }
  configure(patch) {
    const config = { ...this.state.config, ...patch };
    interval(config);
    if (!['light', 'dark'].includes(config.theme)) throw new Error('主题设置无效。');
    for (const key of ['notifications', 'sound', 'autoLogin', 'running']) if (typeof config[key] !== 'boolean') throw new Error('开关设置无效。');
    this.state.config = config; this.commit();
  }
  pending() { return this.state.updates.filter(u => !u.ackAt); }
  acknowledge(ids) {
    const allowed = new Set(ids);
    for (const u of this.state.updates) if (allowed.has(u.eventId) && !u.ackAt) u.ackAt = new Date().toISOString();
    this.commit();
  }
  applyResult(id, generation, result) {
    const m = this.state.monitors.find(m => m.id === id && m.generation === generation && m.enabled);
    if (!m) return { stale: true, events: [] };
    m.status = result.status; m.message = result.message || ''; m.lastAttempt = new Date().toISOString();
    if (result.name) m.name = result.name;
    if (result.avatar) m.avatar = result.avatar;
    if (!result.usable) { m.failures++; this.commit(); return { events: [] }; }
    const notes = result.notes;
    // Never trust preview IDs, even when two preview requests happen to match.
    const valid = result.loggedIn && result.stableIdFormat && notes.length > 0;
    if (!valid) { m.status = 'preview_only'; m.message = '仅有预览内容，未建立可靠监控基线。'; this.commit(); return { events: [] }; }
    m.previewNotes = notes;
    if (!m.identityVerified) {
      const candidate = m.candidate;
      const old = new Set(candidate?.ids || []);
      const sameContentDifferentId = candidate && notes.some(n => candidate.notes.some(p => p.title === n.title && p.coverPath && p.coverPath === n.coverPath && p.id !== n.id));
      if (sameContentDifferentId) {
        m.status = 'identity_unstable'; m.message = '同一内容的 ID 发生变化，已禁用新文提醒。'; m.candidate = null; this.commit(); return { events: [] };
      }
      const common = notes.filter(n => old.has(n.id)).length;
      if (!candidate || common < Math.min(3, notes.length, candidate.ids.length)) {
        m.candidate = { ids: notes.map(n => n.id), notes }; m.status = 'verifying_identity'; m.message = '等待下一次采样核验笔记 ID。'; this.commit(); return { events: [] };
      }
      m.identityVerified = true;
    }
    // Collector must have reached the saved recent boundary or the list end.
    if (!result.coverageVerified) {
      m.status = 'incomplete'; m.message = '近期列表覆盖尚未验证，暂不生成新文章提醒。'; this.commit(); return { events: [] };
    }
    const prior = new Set(m.seen), events = [];
    const batchId = this.pending().find(u => u.batchId)?.batchId || randomUUID();
    if (m.initialized) for (const note of notes) {
      if (!prior.has(note.id)) {
        const unique = id + ':' + note.id;
        if (!this.state.updates.some(u => u.key === unique)) {
          const event = { ...note, key: unique, eventId: randomUUID(), batchId, userId: id, author: m.name, discoveredAt: new Date().toISOString(), read: false, ackAt: null };
          this.state.updates.push(event); events.push(event);
        }
      }
    }
    m.seen = [...new Set([...m.seen, ...notes.map(n => n.id)])];
    m.notes = notes; m.initialized = true; m.coverageVerified = true; m.coverageScope = result.coverageScope || 'verified_boundary'; m.lastSuccess = new Date().toISOString(); m.status = 'ok'; m.message = events.length ? `发现 ${events.length} 篇新笔记` : '检测成功'; m.failures = 0; m.candidate = null;
    this.commit(); return { events };
  }
}
module.exports = { Store, interval, randomDelay, DEFAULT_CONFIG };
