'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { randomDelay, interval } = require('./store.cjs');
class Scheduler extends EventEmitter {
  constructor(store, collector, { now = Date.now, random = Math.random, minimumGapMs = 10000 } = {}) {
    super(); this.store = store; this.collector = collector; this.now = now; this.random = random; this.minimumGapMs = minimumGapMs;
    this.queue = []; this.active = null; this.nextGlobal = store.state.requestPolicy?.cooldownUntil || 0; this.sessionBlocked = Boolean(store.state.accessBlock || store.state.requestPolicy?.blocked); this.lastTick = this.now(); this.timer = null;
    this.reschedule();
  }
  changed() { this.emit('change'); }
  reschedule() {
    for (const m of this.store.state.monitors) this.plan(m);
    this.store.commit(); this.changed();
  }
  plan(m) {
    if (!m.enabled) { m.nextDue = null; return; }
    m.delaySeconds = randomDelay(m.settings || this.store.state.config, this.random);
    m.nextDue = this.now() + m.delaySeconds * 1000;
  }
  startTimer() { this.timer ||= setInterval(() => this.tick(), 1000); }
  stop() { clearInterval(this.timer); this.timer = null; this.queue = []; this.active?.controller.abort(); }
  setRunning(running) {
    this.store.configure({ running });
    if (!running) { this.queue = []; this.active?.controller.abort(); }
    this.reschedule();
  }
  pause(id, enabled) {
    const m = this.store.state.monitors.find(m => m.id === id);
    if (!m) throw new Error('博主已不存在。');
    m.enabled = enabled; m.generation = randomUUID();
    if (m.status === 'checking') { m.status = 'pending'; m.message = enabled ? '已恢复，等待下次检测。' : '检测已暂停。'; }
    this.queue = this.queue.filter(item => item.id !== id);
    if (this.active?.id === id) this.active.controller.abort();
    this.plan(m); this.store.commit(); this.changed();
  }
  remove(id) {
    this.queue = this.queue.filter(item => item.id !== id);
    if (this.active?.id === id) this.active.controller.abort();
    this.store.remove(id); this.changed();
  }
  settings(id, value) {
    if (id) {
      const m = this.store.state.monitors.find(m => m.id === id); if (!m) throw new Error('博主不存在。');
      m.settings = value === null ? null : interval(value); this.plan(m);
    } else {
      this.store.configure(interval(value));
      for (const m of this.store.state.monitors) if (!m.settings) this.plan(m);
    }
    this.store.commit(); this.changed();
  }
  replaceProfile(id, identity, settings) {
    const m = this.store.replaceProfile(id, identity, settings);
    this.queue = this.queue.filter(job => job.id !== id && job.id !== m.id);
    if (this.active?.id === id) this.active.controller.abort();
    this.plan(m); this.store.commit();
    const refreshQueued = this.enqueue(m.id, true, { profileRefresh: true });
    this.changed(); this.tick(); return { monitor: m, refreshQueued };
  }
  enqueue(id, manual = false, { profileRefresh = false } = {}) {
    const m = this.store.state.monitors.find(m => m.id === id);
    if (!m || (!m.enabled && !profileRefresh) || this.sessionBlocked || m.status === 'verification_required') return false;
    if (this.active?.id === id && !this.active.controller.signal.aborted) return true;
    const queued = this.queue.find(item => item.id === id);
    if (queued) { queued.manual ||= manual; queued.profileRefresh ||= profileRefresh; }
    else this.queue.push({ id, manual, profileRefresh });
    this.changed(); return true;
  }
  unblock() { this.sessionBlocked = false; this.store.state.accessBlock = null; for (const m of this.store.state.monitors) { if (['login_required','verification_required','account_restricted','client_restricted'].includes(m.status)) m.status = 'pending'; } this.reschedule(); for (const m of this.store.state.monitors) if (m.profileRefreshPending) this.enqueue(m.id, true, { profileRefresh: true }); }
  blockSession(reason = 'login_required') { this.sessionBlocked = true; this.store.state.accessBlock = { reason, since: new Date(this.now()).toISOString() }; this.queue = []; this.active?.controller.abort(); this.store.commit(); this.changed(); }
  tick() {
    const now = this.now();
    if (now - this.lastTick > 60000) this.reschedule();
    this.lastTick = now;
    if (this.store.state.config.running && !this.sessionBlocked) for (const m of this.store.state.monitors) {
      if (m.enabled && m.nextDue !== null && m.nextDue <= now) this.enqueue(m.id);
    }
    if (!this.active && this.queue.length && now >= this.nextGlobal) void this.runNext();
  }
  async runNext() {
    if (this.active || this.sessionBlocked || this.now() < this.nextGlobal) return;
    const job = this.queue.shift(); if (!job) return;
    const m = this.store.state.monitors.find(m => m.id === job.id && (m.enabled || job.profileRefresh)); if (!m) return;
    const controller = new AbortController(), generation = m.generation;
    this.active = { id: m.id, controller }; m.status = 'checking'; m.lastAttempt = new Date(this.now()).toISOString(); this.plan(m); this.store.commit(); this.changed();
    let result;
    try {
      result = await this.collector.collect(structuredClone(m), controller.signal);
      if (controller.signal.aborted) return;
      const applied = job.profileRefresh ? this.store.applyProfile(m.id, generation, result) : this.store.applyResult(m.id, generation, result);
      if (applied.stale) return;
      if (result.loggedIn && result.account) this.emit('account', result.account);
      if (result.status === 'login_required') { this.blockSession(); this.emit('login-required'); }
      if (result.status === 'verification_required') { this.blockSession('verification_required'); this.emit('verification-required'); }
      if (['account_restricted', 'client_restricted'].includes(result.status)) { this.blockSession(result.status); this.emit('account-restricted', result.status); }
      const current = this.store.state.monitors.find(n => n.id === m.id);
      if (result.status === 'rate_limited') {
        const wait = Math.max(1800, result.retryAfter || 0) * 1000 + Math.floor(this.random() * 600001);
        this.nextGlobal = this.now() + wait;
        for (const item of this.store.state.monitors) if (item.enabled) item.nextDue = Math.max(item.nextDue || 0, this.nextGlobal);
      } else if (current && !result.usable && current.failures > 0) {
        current.nextDue = Math.max(current.nextDue || 0, this.now() + Math.min(3600000, 60000 * 2 ** Math.min(current.failures, 6)));
        if (current.failures >= 5) { current.enabled = false; current.nextDue = null; current.message += ' 连续失败 5 次，已暂停该博主。'; }
      }
      this.store.commit();
      if (applied.events?.length) this.emit('new-updates', applied.events);
    } catch (error) {
      if (error.code === 'REQUEST_POLICY' && !controller.signal.aborted) {
        if (error.status === 'rate_limited') {
          this.nextGlobal = Math.max(this.nextGlobal, this.now() + error.retryAfter * 1000);
          for (const item of this.store.state.monitors) if (item.enabled) item.nextDue = Math.max(item.nextDue || 0, this.nextGlobal);
          const current = this.store.state.monitors.find(n => n.id === m.id && n.generation === generation);
          if (current) { current.status = 'rate_limited'; current.message = error.message; }
        } else { this.blockSession(error.status); }
        this.store.commit(); return;
      }
      if (!controller.signal.aborted) this.store[job.profileRefresh ? 'applyProfile' : 'applyResult'](m.id, generation, { status: 'network_error', usable: false, message: '网络请求失败，已保留最近成功数据。' });
      const current = this.store.state.monitors.find(n => n.id === m.id && n.generation === generation);
      if (!controller.signal.aborted && current) {
        current.nextDue = Math.max(current.nextDue || 0, this.now() + Math.min(3600000, 60000 * 2 ** Math.min(current.failures, 6)));
        if (current.failures >= 5) { current.enabled = false; current.nextDue = null; }
        this.store.commit();
      }
    } finally {
      const current = this.store.state.monitors.find(n => n.id === m.id && n.generation === generation);
      if (controller.signal.aborted && current?.status === 'checking') {
        current.status = 'pending'; current.message = '本次检测已取消，保留最近成功结果。'; this.store.commit();
      }
      const gap = this.minimumGapMs ? this.minimumGapMs + Math.floor(this.random() * this.minimumGapMs) : 0;
      this.active = null; this.nextGlobal = Math.max(this.nextGlobal, this.store.state.requestPolicy?.cooldownUntil || 0, this.now() + gap); this.changed();
    }
  }
}
module.exports = { Scheduler };
