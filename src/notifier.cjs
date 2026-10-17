'use strict';
class NativeNotifier {
  constructor(Notification, { acknowledge, view, failed = () => {}, observed = () => {} }) {
    this.Notification = Notification; this.acknowledge = acknowledge; this.view = view; this.failed = failed; this.observed = observed; this.current = null;
  }
  clear() { const current = this.current; this.current = null; current?.close(); }
  show(events) {
    this.clear(); if (!events.length || !this.Notification.isSupported()) return;
    // Capture precisely the set of IDs displayed by this notification. Newer
    // events arriving before a delayed close callback must remain pending.
    const ids = events.map(u => u.eventId);
    const notification = new this.Notification({
      title: events.some(u => u.test) ? '测试提醒（不是真实文章）' : `发现 ${events.length} 篇新笔记`,
      body: [...new Set(events.map(u => u.author))].join('、') + ' 有更新\n' + events.slice(0, 2).map(u => u.title || '无标题笔记').join('；'),
      silent: true, timeoutType: 'never',
      actions: [{ type: 'button', text: '查看更新' }, { type: 'button', text: '关闭提醒' }],
    });
    this.current = notification;
    notification.on('show', () => this.observed('shown'));
    notification.on('click', () => this.view());
    notification.on('action', details => {
      if (details?.actionIndex === 1) this.acknowledge(ids);
      else if (details?.actionIndex === 0) this.view();
    });
    notification.on('close', details => {
      this.observed('close', details?.reason || 'unknown');
      if (details?.reason === 'userCanceled') this.acknowledge(ids);
      if (this.current === notification) this.current = null;
    });
    notification.on('failed', () => { this.observed('failed'); this.failed(); });
    notification.show();
  }
}
module.exports = { NativeNotifier };
