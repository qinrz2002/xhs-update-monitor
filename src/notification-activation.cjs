'use strict';
const { randomUUID } = require('node:crypto');
const TOKEN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
function escapeXml(value) { return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[c]); }
function toastXml(title, body, token) {
  const arg = type => escapeXml('xhs=' + token + '&' + type);
  return '<toast scenario="reminder" launch="' + arg('type=click') + '"><visual><binding template="ToastGeneric"><text>' + escapeXml(title) + '</text><text>' + escapeXml(body) + '</text></binding></visual><audio silent="true"/><actions><action activationType="system" arguments="dismiss" content="关闭"/><action activationType="foreground" arguments="' + arg('type=action&action=0') + '" content="查看更新"/><action activationType="foreground" arguments="' + arg('type=action&action=1') + '" content="关闭提醒"/></actions></toast>';
}
class NotificationActivation {
  constructor({ read, save, view, acknowledge, now = Date.now, observed = () => {} }) { Object.assign(this, { read, save, view, acknowledge, now, observed }); this.queue = []; this.started = false; }
  remember(ids) {
    const records = Object.fromEntries(Object.entries(this.read()).filter(([,r]) => r && r.expires > this.now()).slice(-199));
    const token = randomUUID(); records[token] = { ids: [...new Set(ids)].slice(0,10000), expires: this.now() + 30*86400000 }; this.save(records); return token;
  }
  handle(details) { if (!this.started) { this.queue.push(details); return; } this.dispatch(details); }
  start() { this.started = true; for (const details of this.queue.splice(0)) this.dispatch(details); }
  dispatch(details = {}) {
    const args = new URLSearchParams(typeof details.arguments === 'string' ? details.arguments : '');
    const token = args.get('xhs'), type = details.type || args.get('type') || 'click';
    const action = details.actionIndex ?? (args.has('action') ? Number(args.get('action')) : NaN);
    const record = TOKEN.test(token || '') ? this.read()[token] : null;
    if (token && (!record || record.expires <= this.now())) { this.observed('stale-activation'); return; }
    if (type === 'click' || (type === 'action' && action === 0)) { this.observed('view-activation'); this.view(); }
    else if (type === 'action' && action === 1 && record && Array.isArray(record.ids)) { this.observed('close-activation'); this.acknowledge(record.ids); }
    // Old notifications have no saved token. Never dismiss all current IDs for one.
  }
}
module.exports = { NotificationActivation, toastXml, escapeXml };
