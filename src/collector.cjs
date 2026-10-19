'use strict';
const { accountFromState } = require('./account.cjs');
function avatarUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try { const url = new URL(value.startsWith('//') ? 'https:' + value : value); if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['xhscdn.com','xiaohongshu.com'].some(d => url.hostname === d || url.hostname.endsWith('.'+d)) ? url.href : null;
  } catch { return null; }
}
function stateFromHtml(body) {
  const match = /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(body);
  if (!match) return null;
  return JSON.parse(match[1].trim().replace(/;$/, '').replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g, token => token === 'undefined' ? 'null' : token));
}
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { id: '', title: '', pinned: false, coverPath: '', publishedAt: null, url: null };
  const card = raw.noteCard || raw;
  const id = String(raw.id || card.noteId || card.note_id || '');
  const image = card.cover?.urlDefault || card.cover?.url || '';
  let coverPath = '';
  try { coverPath = new URL(image, 'https://www.xiaohongshu.com').pathname; } catch {}
  const timestamp = card.time || card.publishTime || card.publish_time;
  let publishedAt = null;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) { try { publishedAt = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString(); } catch {} }
  const token = raw.xsecToken || card.xsecToken || '';
  const pinned = [raw.sticky, raw.isTop, card.sticky, card.isTop, card.interactInfo?.sticky, card.interact_info?.sticky].some(value => value === true || value === 1);
  return { id, title: String(card.displayTitle || card.title || '无标题笔记').slice(0, 1000), pinned, coverPath, publishedAt, url: /^[a-f\d]{24}$/i.test(id) ? 'https://www.xiaohongshu.com/explore/' + id + (token ? '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_user' : '') : null };
}
function businessFailure(code) {
  // These meanings are published by the current official web client (29178).
  // Account/client restrictions require manual resolution, not login retries.
  switch (Number(code)) {
    case 300011: return { status: 'account_restricted', message: '平台提示账号异常，已暂停采集。请在官方页面确认账号状态后再验证会话。' };
    case 300012: return { status: 'network_error', message: '平台提示网络连接异常，已保留最近成功结果。' };
    case 300013: return { status: 'rate_limited', retryAfter: 600, message: '平台提示访问频次异常，已延长等待。' };
    case 300015: return { status: 'client_restricted', message: '平台提示客户端异常，已暂停采集。请在官方页面确认状态。' };
    default: return null;
  }
}
function parseProfile(response, userId) {
  const base = { usable: false, notes: [], loggedIn: false, stableIdFormat: false, coverageVerified: false };
  const location = response.headers.location?.[0] || '';
  if (/captcha|verify|challenge/i.test(location) || response.status === 461 || response.status === 471) return { ...base, status: 'verification_required', message: '平台要求安全验证，请在官方窗口处理。' };
  if (/^\s*\{/.test(response.body)) {
    try { const failure = businessFailure(JSON.parse(response.body).code); if (failure) return { ...base, ...failure }; } catch {}
  }
  if (/login/i.test(location) || [401, 403].includes(response.status)) return { ...base, status: 'login_required', message: '登录失效或访问未获许可。' };
  if (response.status === 429) {
    const raw = response.headers['retry-after']?.[0];
    const seconds = /^\d+$/.test(raw || '') ? Number(raw) : Math.max(0, (Date.parse(raw) - Date.now()) / 1000);
    return { ...base, status: 'rate_limited', retryAfter: Number.isFinite(seconds) ? seconds : 600, message: '请求受限，已延长等待。' };
  }
  if (response.status !== 200) return { ...base, status: 'http_error', message: 'HTTP ' + response.status + '，本次未取得有效数据。' };
  let state;
  try { state = stateFromHtml(response.body); } catch { return { ...base, status: 'parse_error', message: '页面结构发生变化，已保留历史数据。' }; }
  if (!state) return { ...base, status: /验证码|安全验证/.test(response.body) ? 'verification_required' : 'incomplete', message: '未取得可识别的主页数据。' };
  if (state.profile) {
    const profile = state.profile;
    const notes = (Array.isArray(profile.noteData) ? profile.noteData : []).filter(n => n.user?.id === userId).map(normalize);
    return { ...base, usable: notes.length > 0, notes, name: profile.userInfo?.nickname, status: 'preview_only', message: '游客分享页仅用于预览，不用于可靠新文提醒。' };
  }
  const user = state.user;
  if (!user || user.loggedIn !== true) return { ...base, status: 'login_required', message: '未检测到有效网页登录态。' };
  const query = user.noteQueries?.[0] || user.noteQueries?.notes || {};
  const fetchStatus = Array.isArray(user.userNoteFetchingStatus) ? user.userNoteFetchingStatus[0] : user.userNoteFetchingStatus;
  const restricted = businessFailure(user.bannedInfo?.code);
  if (restricted) return { ...base, loggedIn: true, ...restricted };
  if (user.bannedInfo?.serverBanned === true || user.userFetchingStatus === 'rejected' || fetchStatus === 'rejected') return { ...base, loggedIn: true, status: 'http_error', message: '主页中的笔记请求失败或被限制，已保留最近成功数据。' };
  const profileId = user.userPageData?.basicInfo?.userId || user.userPageData?.userId;
  if ((profileId && profileId !== userId) || (typeof query.userId === 'string' && query.userId && query.userId !== userId)) return { ...base, loggedIn: true, status: 'wrong_profile', message: '响应的博主身份不匹配。' };
  const cards = Array.isArray(user.notes) ? user.notes[0] : [];
  const list = Array.isArray(cards) ? cards : [];
  // Keep readable cards for preview when an SSR slot is null, but the missing
  // owner below prevents that response from proving complete coverage.
  const normalized = list.filter(n => n != null).map(normalize);
  if (normalized.some(n => !/^[a-f\d]{24}$/i.test(n.id))) return { ...base, loggedIn: true, status: 'incomplete', message: '主页包含无法识别的笔记标识，已保留最近成功数据。' };
  const owners = list.map(n => { const card = n?.noteCard || n; return card?.user?.userId || card?.user?.user_id || card?.user?.id; });
  if (owners.some(owner => owner && owner !== userId)) return { ...base, loggedIn: true, status: 'wrong_profile', message: '笔记中的博主身份与监控对象不符，已保留最近成功数据。' };
  const notes = [...new Map(normalized.map(n => [n.id, n])).values()];
  const rawName = user.userPageData?.basicInfo?.nickname || user.userPageData?.nickname;
  const basic = user.userPageData?.basicInfo || user.userPageData || {};
  const authorCard = list.find(n => (n?.noteCard?.user?.userId || n?.noteCard?.user?.user_id) === userId)?.noteCard?.user;
  const avatar = avatarUrl(basic.imageb || basic.images || basic.image || basic.avatar || authorCard?.avatar);
  // End-of-list must be explicit. A short first page alone is not proof.
  const atEnd = query.hasMore === false || query.has_more === false;
  const regular = notes.filter(n => !n.pinned), expected = Number(query.num);
  const chronological = regular.every((n,i) => Number.isFinite(Date.parse(n.publishedAt)) && (!i || Date.parse(regular[i-1].publishedAt) >= Date.parse(n.publishedAt)));
  const pageIdentityVerified = query.userId === userId && fetchStatus === 'resolved' && owners.length > 0 && owners.every(owner => owner === userId);
  const recentWindowVerified = pageIdentityVerified && Number.isInteger(expected) && expected >= 20 && expected <= 100 && regular.length >= expected && chronological;
  return { ...base, loggedIn: true, account: accountFromState(state), avatar, usable: notes.length > 0, notes, name: typeof rawName === 'string' ? rawName : undefined,
    stableIdFormat: notes.length > 0 && notes.every(n => /^[a-f\d]{24}$/i.test(n.id)),
    recentWindowVerified, pageIdentityVerified, coverageVerified: Boolean(atEnd && pageIdentityVerified), coverageScope: atEnd && pageIdentityVerified ? 'list_end' : null, atEnd, status: notes.length ? 'first_page' : 'incomplete', message: notes.length ? '' : '已登录，但首屏笔记为空或结构未识别。' };
}
class Collector {
  constructor(transport) { this.transport = transport; }
  async collect(monitor, signal, options = {}) {
    const response = await this.transport.request(monitor.url, { ...options, signal });
    const result = parseProfile(response, monitor.id);
    // Homepage-source mode: a complete chronological first window can seed a
    // recent baseline, after Store independently verifies IDs across samples.
    // This is explicitly not proof of complete historical pagination.
    if (!monitor.initialized && result.loggedIn && result.stableIdFormat && result.recentWindowVerified) {
      result.coverageVerified = true; result.coverageScope = result.atEnd ? 'list_end' : 'recent_window';
    }
    // Later checks must reach the saved regular boundary; pinned cards alone
    // never establish continuity. A gap remains incomplete instead of guessing.
    if (result.loggedIn && result.stableIdFormat && monitor.initialized && monitor.coverageVerified) {
      const known = new Set(monitor.seen);
      const regular = result.notes.filter(n => !n.pinned);
      if (!result.coverageVerified && result.recentWindowVerified && regular.filter(n => known.has(n.id)).length >= 3) { result.coverageVerified = true; result.coverageScope = 'known_boundary'; }
    }
    return result;
  }
}
function httpSessionVerified(result) {
  // A logged-in flag alone also appears on wrong-profile and unrecognized pages.
  return result.loggedIn === true && result.usable === true && result.stableIdFormat === true && result.status === 'first_page';
}
module.exports = { Collector, parseProfile, normalize, stateFromHtml, httpSessionVerified, businessFailure, avatarUrl };
