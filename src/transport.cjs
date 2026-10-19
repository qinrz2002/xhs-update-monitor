'use strict';
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { RequestPolicy } = require('./request-policy.cjs');
const ALLOWED = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.cn', 'xhslink.com', 'www.xhslink.com']);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('只支持小红书官方 HTTPS 主页及分享链接。');
  return url;
}
function quote(value) {
  if (/[\x00\r\n]/.test(value)) throw new Error('请求参数格式错误。');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function parseResponse(raw) {
  let rest = raw, output;
  while (/^HTTP\//.test(rest)) {
    const separator = /\r?\n\r?\n/.exec(rest);
    if (!separator) break;
    const header = rest.slice(0, separator.index), headers = {};
    for (const line of header.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':'); if (colon < 1) continue;
      const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
      (headers[key] ||= []).push(value);
    }
    output = { status: Number(/^HTTP\/\S+\s+(\d+)/.exec(header)?.[1] || 0), headers };
    rest = rest.slice(separator.index + separator[0].length);
  }
  if (!output) throw new Error('无法识别 HTTP 响应。');
  return { ...output, body: rest };
}
class CurlTransport {
  constructor({ cookies = async () => '', onSetCookies = async () => {}, policy = new RequestPolicy(), wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) { this.cookies = cookies; this.onSetCookies = onSetCookies; this.policy = policy; this.wait = wait; this.tail = Promise.resolve(); }
  searchUsers(keyword){return this.request(require('./user-search.cjs').SEARCH_API,{searchKeyword:keyword});}
  async request(value, { signal, userAgent = USER_AGENT, searchKeyword, verificationProbe = false } = {}) {
    if (!(searchKeyword !== undefined && value === require('./user-search.cjs').SEARCH_API)) checkedUrl(value);
    const previous = this.tail; let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) throw new Error('请求已取消');
      this.policy.assertAllowed({ verificationProbe });
      const wait = this.policy.waitTime();
      if (wait) await this.wait(wait, signal);
      if (signal?.aborted) throw new Error('请求已取消');
      const ticket = this.policy.begin(value, { verificationProbe });
      let response;
      try { response = await this.perform(value, { signal, userAgent, searchKeyword }); }
      catch (error) { this.policy.finish(ticket, null, error); throw error; }
      this.policy.finish(ticket, response);
      if (!this.policy.state.blocked && ['www.xiaohongshu.com', 'edith.xiaohongshu.com'].includes(new URL(value).hostname) && response.headers['set-cookie']) await this.onSetCookies(value, response.headers['set-cookie']);
      return response;
    } finally { release(); }
  }
  async perform(value, { signal, userAgent = USER_AGENT, searchKeyword } = {}) {
    const api=searchKeyword!==undefined&&value===require('./user-search.cjs').SEARCH_API;
    const url = api?new URL(value):checkedUrl(value);
    const cookie = api||url.hostname === 'www.xiaohongshu.com' ? await this.cookies(url.href) : '';
    const config = ['silent', 'show-error', 'compressed', 'max-time = 25', 'connect-timeout = 10', 'proto = "=https"', 'dump-header = "-"', 'url = ' + quote(url.href), 'user-agent = ' + quote(userAgent)];
    config.push('header = ' + quote('Accept: ' + (api ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8')), 'header = ' + quote('Accept-Language: zh-CN,zh;q=0.9'));
    if (cookie) config.push('header = ' + quote('Cookie: ' + cookie));
    if(api){const signed=require('./user-search.cjs').signedSearch(searchKeyword,cookie,userAgent);for(const[k,v]of Object.entries(signed.headers))config.push('header = '+quote(k+': '+v));config.push('data-binary = '+quote(signed.body));}
    const response = await new Promise((resolve, reject) => {
      const executable = process.env.SystemRoot ? require('node:path').join(process.env.SystemRoot, 'System32', 'curl.exe') : 'curl.exe';
      // Ignore a machine/user curlrc: hidden retries or redirects would escape
      // the per-attempt budget and could send more requests than the queue records.
      const child = spawn(executable, ['-q', '--config', '-'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let raw = '', size = 0, finished = false;
      const end = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
      const abort = () => { child.kill(); end(Object.assign(new Error('请求已取消'), { code: 'ABORTED' })); };
      const timer = setTimeout(() => { child.kill(); end(new Error('网络请求超时')); }, 30000);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 8 * 1024 * 1024) { child.kill(); end(new Error('响应超过大小限制')); } else raw += chunk; });
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', () => end(new Error('无法运行 Windows curl.exe')));
      child.on('close', code => { if (code !== 0) return end(new Error('网络请求失败（curl ' + code + '）')); try { end(null, parseResponse(raw)); } catch (error) { end(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      child.stdin.end(config.join('\n') + '\n');
    });
    return response;
  }
  async resolve(input, signal) {
    const match = String(input).match(/https:\/\/[^\s<>"，。]+/);
    if (!match) throw new Error('请粘贴完整主页或分享链接。');
    let url = checkedUrl(match[0].replace(/[）)>]+$/, ''));
    for (let step = 0; step < 6; step++) {
      const id = /^\/user\/profile\/([a-f\d]{24})\/?$/i.exec(url.pathname)?.[1];
      if (url.hostname === 'www.xiaohongshu.com' && id) return { id, url: url.href };
      const response = await this.request(url.href, { signal });
      const target = response.headers.location?.[0];
      if (response.status < 300 || response.status >= 400 || !target) throw new Error('无法解析到博主主页；请检查链接是否仍有效。');
      url = checkedUrl(new URL(target, url).href);
    }
    throw new Error('分享链接跳转次数过多。');
  }
}
module.exports = { CurlTransport, parseResponse, checkedUrl, quote, USER_AGENT };
