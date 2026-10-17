'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {LoginSession} = require('../src/session.cjs');
function fixture(t, initial = []) {
  const base = path.resolve(__dirname, '../test-runs/test-data');
  fs.mkdirSync(base, {recursive:true});
  const dir = fs.mkdtempSync(path.join(base, 'session-'));
  t.after(() => { assert(dir.startsWith(base + path.sep)); fs.rmSync(dir, {recursive:true, force:true}); });
  const jar = new EventEmitter(); jar.values = initial;
  jar.get = async () => jar.values.map(c=>({...c}));
  jar.set = async c => {
    const next = {...c, domain:c.domain || new URL(c.url).hostname};
    jar.values = jar.values.filter(x=>x.name!==c.name).concat(next);
    jar.emit('changed', {}, next, 'explicit', false);
  };
  const partition = {cookies:jar, setPermissionRequestHandler(){}, setPermissionCheckHandler(){}, setUserAgent(){}};
  // Synthetic encryption adapter tests lifecycle ordering, not Windows encryption.
  const safeStorage = {isAsyncEncryptionAvailable:async()=>true,
    encryptStringAsync:async s=>Buffer.from(s), decryptStringAsync:async b=>({result:b.toString()})};
  const session = new LoginSession({session:{fromPartition:()=>partition}, safeStorage}, dir);
  return {session, jar, dir, safeStorage};
}
const cookie = value => ({name:'web_session', value, domain:'.xiaohongshu.com', path:'/', secure:true});
test('persisted browser session without export remains unverified; empty profile is logged out', async t=>{
  const a=fixture(t,[cookie('synthetic-existing')]); await a.session.init(); assert.equal(a.session.state,'unverified');
  const b=fixture(t); await b.session.init(); assert.equal(b.session.state,'not_logged_in');
});
test('restoring cookies suppresses capture and candidate events until curl validation', async t=>{
  const f=fixture(t); let candidates=0; f.session.on('candidate',()=>candidates++);
  fs.writeFileSync(path.join(f.dir,'session.enc'), JSON.stringify({cookies:[cookie('synthetic-restored')]}));
  await f.session.init(); assert.equal(f.session.state,'unverified'); assert.equal(candidates,0);
  assert.equal(f.session.captureBusy,false); assert.equal(f.session.restoring,false);
});
test('an older encrypted export never overwrites a newer browser partition session', async t=>{
  const f=fixture(t,[cookie('synthetic-newer')]);
  fs.writeFileSync(path.join(f.dir,'session.enc'),JSON.stringify({cookies:[cookie('synthetic-older')]}));
  await f.session.init();assert.equal(f.session.state,'unverified');
  assert.equal(f.jar.values.find(c=>c.name==='web_session').value,'synthetic-newer');
  assert.equal(f.session.restoring,false);
});
test('failed encrypted save can retry the same session value', async t=>{
  const f=fixture(t,[cookie('synthetic-retry')]); let count=0;
  f.safeStorage.encryptStringAsync=async s=>{if(++count===1)throw Error('synthetic failure'); return Buffer.from(s)};
  await f.session.capture(); assert.equal(f.session.state,'session_unavailable'); assert.equal(f.session.lastSession,null);
  await f.session.capture(); assert.equal(f.session.lastSession,'synthetic-retry'); assert.equal(f.session.state,'verifying');
});
test('cookie changes during capture are drained and persistence is serialized', async t=>{
  const f=fixture(t,[cookie('synthetic-first')]); let active=0,max=0,unblock,started;
  const entered=new Promise(r=>started=r); const gate=new Promise(r=>unblock=r);
  f.safeStorage.encryptStringAsync=async s=>{active++;max=Math.max(max,active);if(s.includes('synthetic-first')){started();await gate}active--;return Buffer.from(s)};
  const running=f.session.capture(); await entered;
  await f.jar.set(cookie('synthetic-second')); const extra=f.session.persist(); unblock();
  await Promise.all([running,extra]); await f.session.persistTail;
  assert.equal(max,1); assert.equal(f.session.lastSession,'synthetic-second');
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'session.enc'),'utf8'));
  assert.equal(saved.cookies[0].value,'synthetic-second');
});
test('Set-Cookie rejects foreign domains and insecure origins; max-age overrides expires', async t=>{
  const f=fixture(t);
  await f.session.setCookies('http://www.xiaohongshu.com/', ['bad=1']);
  await f.session.setCookies('https://www.xiaohongshu.com/a/b', [
    'foreign=1; Domain=example.com', 'sibling=1; Domain=other.xiaohongshu.com',
    'valid=1; Domain=.xiaohongshu.com; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; Secure'
  ]);
  assert.deepEqual(f.jar.values.map(c=>c.name),['valid']);
  assert.equal(f.jar.values[0].path,'/a'); assert.equal(f.jar.values[0].sameSite,'lax');
  assert(f.jar.values[0].expirationDate>Date.now()/1000+55);
  assert.equal(f.session.isXhs(undefined),false);
});
class LoginWindow extends EventEmitter {
  constructor(){super();this.destroyed=false;this.url='https://www.xiaohongshu.com/login';this.webContents=new EventEmitter();this.webContents.getURL=()=>this.url;this.webContents.setWindowOpenHandler=()=>{};}
  isDestroyed(){return this.destroyed;}focus(){}loadURL(url){this.url=url;return Promise.resolve();}
  close(){this.destroyed=true;this.emit('closed');}
}
test('same session value can be revalidated without declaring it logged in',async t=>{
  const f=fixture(t,[cookie('synthetic-unchanged')]);let candidates=0;f.session.on('candidate',()=>candidates++);
  await f.session.capture();await f.session.capture();assert.equal(candidates,1);
  await f.session.capture({verifyExisting:true});assert.equal(candidates,2);assert.equal(f.session.state,'verifying');
});
test('official SPA navigation revalidates unchanged cookie once after the probe gap',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  const f=fixture(t,[cookie('synthetic-navigation')]);f.session.e.BrowserWindow=LoginWindow;let candidates=0;f.session.on('candidate',()=>candidates++);
  await f.session.capture();f.session.open();const win=f.session.window;
  win.webContents.emit('did-navigate-in-page',{},'https://www.xiaohongshu.com/explore',true);
  win.webContents.emit('did-navigate-in-page',{},'https://www.xiaohongshu.com/explore',true);
  t.mock.timers.tick(9999);await new Promise(setImmediate);assert.equal(candidates,1);
  t.mock.timers.tick(1);await new Promise(setImmediate);assert.equal(candidates,2);assert.equal(f.session.state,'verifying');win.close();
});
test('verification pages, subframes and cancelled windows do not trigger navigation probes',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  const f=fixture(t,[cookie('synthetic-cancel')]);f.session.e.BrowserWindow=LoginWindow;let candidates=0;f.session.on('candidate',()=>candidates++);
  await f.session.capture();f.session.open();const win=f.session.window;
  for(const url of ['https://www.xiaohongshu.com/login','https://www.xiaohongshu.com/website-login/captcha','https://evil.test/'])win.webContents.emit('did-navigate-in-page',{},url,true);
  win.webContents.emit('did-navigate-in-page',{},'https://www.xiaohongshu.com/explore',false);
  t.mock.timers.tick(20000);await new Promise(setImmediate);assert.equal(candidates,1);
  win.webContents.emit('did-navigate-in-page',{},'https://www.xiaohongshu.com/explore',true);
  win.webContents.emit('did-navigate-in-page',{},'https://www.xiaohongshu.com/website-login/captcha',true);
  t.mock.timers.tick(20000);await new Promise(setImmediate);assert.equal(candidates,1);
  win.webContents.emit('did-navigate-in-page',{},'https://www.xiaohongshu.com/explore',true);win.close();
  t.mock.timers.tick(20000);await new Promise(setImmediate);assert.equal(candidates,1);assert.equal(f.session.state,'login_cancelled');
});
