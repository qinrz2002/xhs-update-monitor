'use strict';
const { createHash } = require('node:crypto');
const { businessFailure, stateFromHtml } = require('./collector.cjs');
const HOUR = 3600000, DAY = 24 * HOUR;
function retryAfter(headers, now) {
  const raw = headers?.['retry-after']?.[0];
  if (!raw) return 0;
  const value = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
function responseRestriction(response) {
  const location = response.headers?.location?.[0] || '';
  if ([461, 471].includes(response.status) || /captcha|verify|challenge/i.test(location)) return 'verification_required';
  if ([401, 403].includes(response.status) || /login/i.test(location)) return 'login_required';
  if (response.status === 406) return 'client_restricted';
  if (response.status === 429) return 'rate_limited';
  let state;
  try {
    const payload = /^\s*\{/.test(response.body) ? JSON.parse(response.body) : null;
    const failure = businessFailure(payload?.code);
    if (failure && failure.status !== 'network_error') return failure.status;
    if ([-100, 10001].includes(payload?.code)) return 'login_required';
    state = payload ? null : stateFromHtml(response.body);
  } catch {}
  const failure = businessFailure(state?.user?.bannedInfo?.code);
  if (failure && failure.status !== 'network_error') return failure.status;
  if (state?.user?.bannedInfo?.serverBanned) return 'account_restricted';
  if (state?.user?.loggedIn === false) return 'login_required';
  if (/验证码|安全验证/.test(response.body) && !state) return 'verification_required';
  return null;
}
function policyError(status, until, now) {
  const messages = {
    account_restricted: '平台提示账号异常，所有 curl 采集已停止。请先在官方客户端确认账号状态，再手动验证会话。',
    client_restricted: '平台限制了请求，所有 curl 采集已停止。请先在官方客户端确认状态，再手动验证会话。',
    verification_required: '平台要求安全验证，所有 curl 采集已停止。完成官方验证后，请手动验证会话。',
    login_required: '登录已失效，所有 curl 采集已停止。请手动重新登录并验证会话。'
  };
  return Object.assign(new Error(messages[status] || '请求处于限频冷却中，请在 ' + Math.max(1, Math.ceil((until - now) / 60000)) + ' 分钟后重试。'), {
    code: 'REQUEST_POLICY', status, retryAfter: Math.max(1, Math.ceil((until - now) / 1000))
  });
}
class RequestPolicy {
  constructor({ state = {}, now = Date.now, random = Math.random, save = () => {}, audit = () => {}, onRestriction = () => {} } = {}) {
    Object.assign(this, { state, now, random, save, audit, onRestriction });
    state.attempts = Array.isArray(state.attempts) ? state.attempts.filter(t => Number.isFinite(t) && t > now() - DAY) : [];
    state.resources ||= {};
  }
  key(url) { return createHash('sha256').update(new URL(url).origin + new URL(url).pathname).digest('hex').slice(0, 24); }
  gap() { return 30000 + Math.min(60000, Math.floor(Math.max(0, Math.min(1, this.random())) * 60001)); }
  persist() { this.save(this.state); }
  assertAllowed({ verificationProbe = false } = {}) {
    const now = this.now(), s = this.state;
    if (s.blocked && !verificationProbe) throw policyError(s.blocked, 0, now);
    if (s.cooldownUntil > now) throw policyError('rate_limited', s.cooldownUntil, now);
    s.attempts = s.attempts.filter(t => t > now - DAY);
    const recent = s.attempts.filter(t => t > now - HOUR);
    if (recent.length >= 60 || s.attempts.length >= 500) {
      const until = Math.max(recent.length >= 60 ? recent[recent.length - 60] + HOUR : 0, s.attempts.length >= 500 ? s.attempts[s.attempts.length - 500] + DAY : 0);
      throw policyError('rate_limited', until, now);
    }
  }
  waitTime() { return Math.max(0, (this.state.nextRequestAt || 0) - this.now()); }
  begin(url, options = {}) {
    this.assertAllowed(options);
    const s = this.state, now = this.now(), key = this.key(url), previous = s.resources[key];
    // A single failed request counts too. Manual actions cannot bypass these floors.
    const floor = options.verificationProbe || /\/user\/profile\//.test(new URL(url).pathname) ? 5 * 60000 : 60000;
    if (previous !== undefined && previous + floor > now) throw policyError('rate_limited', previous + floor, now);
    s.attempts.push(now); s.resources[key] = now;
    for (const k of Object.keys(s.resources)) if (s.resources[k] < now - DAY) delete s.resources[k];
    s.nextRequestAt = now + this.gap(); this.persist();
    return { startedAt: now, endpoint: /\/user\/profile\//.test(new URL(url).pathname) ? 'profile' : /usersearch/.test(url) ? 'search' : /xhslink/.test(url) ? 'share' : 'session', host: new URL(url).hostname };
  }
  finish(ticket, response, error) {
    const s = this.state, now = this.now();
    s.nextRequestAt = Math.max(s.nextRequestAt || 0, now + this.gap());
    const restriction = response ? responseRestriction(response) : null;
    if (restriction === 'rate_limited' || response?.status >= 500 || error) {
      s.failures = Math.min(12, (s.failures || 0) + 1);
      const base = restriction === 'rate_limited' ? 30 * 60000 : error ? 60000 : 5 * 60000;
      const backoff = Math.min(6 * HOUR, base * 2 ** Math.min(s.failures - 1, 8));
      s.cooldownUntil = Math.max(s.cooldownUntil || 0, now + Math.max(backoff, retryAfter(response?.headers, now)) + Math.floor(this.random() * 600001));
    } else if (restriction) {
      s.blocked = restriction;
    } else if (response?.status === 200) s.failures = 0;
    this.persist();
    // No URLs, query strings, user IDs, response bodies, request headers or cookies.
    this.audit({ at: new Date(now).toISOString(), ...ticket, status: response?.status || null, result: restriction || (error ? 'network_error' : 'response'), durationMs: Math.max(0, now - ticket.startedAt), nextRequestAt: s.nextRequestAt, cooldownUntil: s.cooldownUntil || null });
    if (restriction && restriction !== 'rate_limited') this.onRestriction(restriction);
  }
  clearBlock() { this.state.blocked = null; this.persist(); }
}
module.exports = { RequestPolicy, responseRestriction, retryAfter, policyError };
