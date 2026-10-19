'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, randomDelay, interval } = require('../src/store.cjs');
const { Scheduler } = require('../src/scheduler.cjs');
const { parseProfile, stateFromHtml, httpSessionVerified } = require('../src/collector.cjs');
const { CurlTransport, parseResponse, checkedUrl } = require('../src/transport.cjs');
const ID = '5e314c060000000001004e26', ID2 = '5e314c060000000001004e27';
const note = (n,title='文章'+n) => ({ id: n.toString(16).padStart(24,'0'), title, coverPath:'/cover/'+n, pinned:false, publishedAt:new Date(1792100000000+n*1000).toISOString() });
function setup(t) {const root=path.resolve(__dirname,'../test-runs/test-data');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'xhs-monitor-test-'));t.after(()=>{if(path.dirname(path.resolve(dir))!==root)throw new Error('Invalid cleanup path');fs.rmSync(dir,{recursive:true,force:true})});return new Store(dir)}
const identity = id => ({id,name:'测试博主',url:'https://www.xiaohongshu.com/user/profile/'+id});
const result = notes => ({status:'first_page',usable:true,loggedIn:true,stableIdFormat:true,coverageVerified:true,notes});
test('random interval endpoints and validation over 2000 samples',()=>{
 assert.equal(randomDelay({baseMinutes:10,jitterMinutes:5},()=>0),300);
 assert.equal(randomDelay({baseMinutes:10,jitterMinutes:5},()=>.9999999),900);
 for(let i=0;i<2000;i++){const n=randomDelay({baseMinutes:10,jitterMinutes:5});assert.ok(n>=300&&n<=900&&Number.isInteger(n))}
 for(const c of [{baseMinutes:0,jitterMinutes:0},{baseMinutes:5,jitterMinutes:5},{baseMinutes:10,jitterMinutes:-1},{baseMinutes:NaN,jitterMinutes:0}])assert.throws(()=>interval(c));
});
test('multiple authors, duplicate identity, independent pause, archive and undo',t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));assert.equal(s.add(identity(ID)).duplicate,true);assert.equal(s.state.monitors.length,2);
 const q=new Scheduler(s,{});q.pause(ID,false);assert.equal(s.state.monitors[0].nextDue,null);assert.equal(s.state.monitors[1].enabled,true);
 q.remove(ID);assert.equal(s.state.monitors.length,1);assert.equal(s.state.archive.length,1);s.restore(ID);assert.equal(s.state.monitors.length,2);
});
test('atomic storage survives reopen and restores last valid backup; no session in state',t=>{
 const s=setup(t);s.add(identity(ID));s.configure({theme:'dark'});s.commit();
 const reopened=new Store(s.directory);assert.equal(reopened.state.config.theme,'dark');assert.equal(reopened.state.monitors[0].id,ID);
 fs.writeFileSync(path.join(s.directory,'state.json'),'{broken');const recovered=new Store(s.directory);assert.equal(recovered.state.config.theme,'dark');assert.equal(recovered.state.monitors.length,1);
 assert.ok(!fs.readFileSync(path.join(s.directory,'state.json'),'utf8').includes('web_session'));
 recovered.configure({theme:'light'});assert.equal(new Store(s.directory).state.config.theme,'light');
});
test('baseline only after repeated stable IDs, edits no alert, new ID exactly once',t=>{
 const s=setup(t),m=s.add(identity(ID)).monitor;const notes=[note(1),note(2),note(3)];
 assert.equal(s.applyResult(ID,m.generation,result(notes)).events.length,0);assert.equal(m.initialized,false);
 assert.equal(s.applyResult(ID,m.generation,result(notes)).events.length,0);assert.equal(m.initialized,true);
 assert.equal(s.applyResult(ID,m.generation,result([note(1,'已编辑'),note(2),note(3)])).events.length,0);
 const r=s.applyResult(ID,m.generation,result([note(4),...notes]));assert.equal(r.events.length,1);
 assert.equal(s.applyResult(ID,m.generation,result([note(4),...notes])).events.length,0);
 const last=m.lastSuccess;s.applyResult(ID,m.generation,{usable:false,status:'network_error'});assert.equal(m.lastSuccess,last);assert.equal(m.notes[0].id,note(4).id);
});
test('preview and unstable IDs never initialize or notify',t=>{
 const s=setup(t),m=s.add(identity(ID)).monitor;
 s.applyResult(ID,m.generation,{...result([note(1)]),loggedIn:false});assert.equal(m.initialized,false);
 s.applyResult(ID,m.generation,result([note(1)]));s.applyResult(ID,m.generation,result([{...note(2),title:note(1).title,coverPath:note(1).coverPath}]));assert.equal(m.status,'identity_unstable');assert.equal(s.state.updates.length,0);
});
test('coverage gate does not claim empty/partial feed is complete',t=>{
 const s=setup(t),m=s.add(identity(ID)).monitor;const r={...result([note(1)]),coverageVerified:false};
 s.applyResult(ID,m.generation,r);s.applyResult(ID,m.generation,r);assert.equal(m.status,'incomplete');assert.equal(m.initialized,false);assert.equal(s.state.updates.length,0);
});
test('acknowledgement only clears displayed IDs and preserves unread',t=>{
 const s=setup(t);s.state.updates=[{eventId:'a',read:false,ackAt:null},{eventId:'b',read:false,ackAt:null}];s.commit();s.acknowledge(['a']);assert.deepEqual(s.pending().map(x=>x.eventId),['b']);assert.equal(s.state.updates[0].read,false);
});
test('delete during in-flight request cancels and rejects stale result',async t=>{
 const s=setup(t);s.add(identity(ID));let release;const q=new Scheduler(s,{collect:()=>new Promise(r=>release=r)},{minimumGapMs:0});q.enqueue(ID,true);const running=q.runNext();q.remove(ID);release(result([note(1)]));await running;assert.equal(s.state.monitors.length,0);assert.equal(s.state.updates.length,0);assert.equal(q.active,null);
});
test('same author coalesces and global requests run sequentially',async t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));let active=0,max=0,release;
 const q=new Scheduler(s,{collect:()=>{active++;max=Math.max(max,active);return new Promise(r=>release=()=>{active--;r({usable:false,status:'incomplete'})})}},{minimumGapMs:0});
 q.enqueue(ID);q.enqueue(ID,true);q.enqueue(ID2);assert.equal(q.queue.length,2);const first=q.runNext();q.enqueue(ID,true);await q.runNext();assert.equal(q.queue.length,1);release();await first;const second=q.runNext();release();await second;assert.equal(max,1);
});
test('reschedule uses current time and updated interval; paused stays off',t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));let now=1000;const q=new Scheduler(s,{}, {now:()=>now,random:()=>0});
 assert.equal(s.state.monitors[0].nextDue,301000);q.settings(ID,{baseMinutes:20,jitterMinutes:0});assert.equal(s.state.monitors[0].nextDue,1201000);
 now=1e8;q.reschedule();assert.equal(s.state.monitors[0].nextDue,now+1200000);q.pause(ID,false);q.reschedule();assert.equal(s.state.monitors[0].nextDue,null);
});
test('rate limit defers global work and server retry wins',async t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));let now=1000;const q=new Scheduler(s,{collect:async()=>({usable:false,status:'rate_limited',retryAfter:7200})},{now:()=>now,random:()=>0.5,minimumGapMs:0});q.enqueue(ID);await q.runNext();assert.equal(q.nextGlobal,7501000);assert.ok(s.state.monitors.every(m=>m.nextDue>=7501000));
});
test('session failure blocks queued work; network errors preserve data',async t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));const q=new Scheduler(s,{collect:async()=>({usable:false,status:'login_required'})},{minimumGapMs:0});q.enqueue(ID);q.enqueue(ID2);await q.runNext();assert.equal(q.sessionBlocked,true);assert.equal(q.queue.length,0);assert.equal(q.enqueue(ID),false);q.unblock();assert.equal(q.sessionBlocked,false);
});
test('parser distinguishes login, CAPTCHA, HTTP200 shell, and authenticated feed',()=>{
 const response=(status,body='',headers={})=>({status,body,headers});
 assert.equal(parseProfile(response(302,'',{location:['/login']}),ID).status,'login_required');assert.equal(parseProfile(response(302,'',{location:['/website-login/captcha']}),ID).status,'verification_required');assert.equal(parseProfile(response(200,'{}'),ID).usable,false);
 const state={user:{loggedIn:true,notes:[[{id:note(1).id,noteCard:{displayTitle:'有效笔记',cover:{url:'/cover'},user:{userId:ID}}}]],noteQueries:[{userId:ID,hasMore:false}],userNoteFetchingStatus:['resolved']}};
 const parsed=parseProfile(response(200,'<script>window.__INITIAL_STATE__='+JSON.stringify(state)+'</script>'),ID);assert.equal(parsed.loggedIn,true);assert.equal(parsed.stableIdFormat,true);assert.equal(parsed.coverageVerified,true);
 const shell=parseProfile(response(200,'<script>window.__INITIAL_STATE__={"user":{"loggedIn":false}}</script>'),ID);assert.equal(shell.status,'login_required');
});
test('public archived fixtures classify as preview, IDs rotate',()=>{
 const root=path.resolve(__dirname,'../../../work');if(!fs.existsSync(path.join(root,'xhs-mobile.html')))return;
 const a=parseProfile({status:200,headers:{},body:fs.readFileSync(path.join(root,'xhs-mobile.html'),'utf8')},ID);
 const b=parseProfile({status:200,headers:{},body:fs.readFileSync(path.join(root,'xhs-same.html'),'utf8')},ID);
 assert.equal(a.status,'preview_only');assert.equal(a.loggedIn,false);assert.equal(a.notes.length,8);assert.notEqual(a.notes[0].id,b.notes[0].id);
});
test('transport validates host, resolves without arbitrary network and parses proxy blocks',async()=>{
 for(const u of ['http://www.xiaohongshu.com','https://evil.test','https://www.xiaohongshu.com.evil.test','https://user:secret@www.xiaohongshu.com'])assert.throws(()=>checkedUrl(u));
 const transport=new CurlTransport();transport.request=async()=>({status:302,headers:{location:['https://www.xiaohongshu.com/user/profile/'+ID]}});assert.equal((await transport.resolve('分享 https://xhslink.cn/o/abc')).id,ID);
 transport.request=async()=>({status:302,headers:{location:['https://evil.test']}});await assert.rejects(transport.resolve('https://xhslink.cn/o/abc'));
 const r=parseResponse('HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\nset-cookie: a=b\r\nset-cookie: c=d\r\n\r\n<html>ok</html>');assert.equal(r.status,200);assert.equal(r.headers['set-cookie'].length,2);assert.equal(r.body,'<html>ok</html>');
 assert.equal(stateFromHtml('<script>window.__INITIAL_STATE__={"u":undefined,"s":"undefined"}</script>').s,'undefined');
});
test('network backoff eventually pauses and retains last successful baseline',async t=>{
 const s=setup(t),m=s.add(identity(ID)).monitor;m.initialized=true;m.seen=[note(1).id];m.lastSuccess='2026-10-16T00:00:00Z';m.notes=[note(1)];
 let now=1000;const q=new Scheduler(s,{collect:async()=>{throw new Error('offline')}},{now:()=>now,minimumGapMs:0});
 for(let i=0;i<5;i++){q.enqueue(ID,true);await q.runNext();assert.ok(m.nextDue===null||m.nextDue>now);now+=4000000;}
 assert.equal(m.enabled,false);assert.equal(m.nextDue,null);assert.equal(m.status,'network_error');assert.equal(m.lastSuccess,'2026-10-16T00:00:00Z');assert.deepEqual(m.seen,[note(1).id]);
});
test('security verification suspends all queued requests until explicit recovery',async t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));const q=new Scheduler(s,{collect:async()=>({usable:false,status:'verification_required'})},{minimumGapMs:0});
 q.enqueue(ID);q.enqueue(ID2);await q.runNext();assert.equal(q.sessionBlocked,true);assert.equal(q.queue.length,0);assert.equal(q.enqueue(ID2,true),false);q.unblock();assert.equal(s.state.monitors[0].status,'pending');
});
test('resume after long tick gap does not dispatch all missed jobs',t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));s.configure({running:true});let now=1000;const q=new Scheduler(s,{}, {now:()=>now,random:()=>0});
 now+=7200000;q.tick();assert.equal(q.queue.length,0);assert.equal(q.active,null);assert.ok(s.state.monitors.every(m=>m.nextDue>now));
});
test('global interval change preserves independent author override',t=>{
 const s=setup(t);s.add(identity(ID));s.add(identity(ID2));const q=new Scheduler(s,{}, {now:()=>1000,random:()=>0});q.settings(ID,{baseMinutes:20,jitterMinutes:0});q.settings(null,{baseMinutes:4,jitterMinutes:1});assert.equal(s.state.monitors[0].nextDue,1201000);assert.equal(s.state.monitors[1].nextDue,181000);
});
test('untitled notes and duplicate cards retain stable identity without disappearing',()=>{
 const cards=[null,{id:note(1).id,sticky:true,noteCard:{cover:{url:'/one'}}},{id:note(1).id,noteCard:{cover:{url:'/one'},isTop:true}}];
 const body='<script>window.__INITIAL_STATE__='+JSON.stringify({user:{loggedIn:true,notes:[cards],noteQueries:[{hasMore:false}]}})+'</script>';
 const parsed=parseProfile({status:200,headers:{},body},ID);
 assert.equal(parsed.notes.length,1);assert.equal(parsed.notes[0].title,'无标题笔记');assert.equal(parsed.notes[0].pinned,true);
 assert.equal(parsed.stableIdFormat,true);assert.equal(httpSessionVerified(parsed),true);
});
test('a login flag on a wrong profile or empty shell cannot resume collection',()=>{
 const response=user=>({status:200,headers:{},body:'<script>window.__INITIAL_STATE__='+JSON.stringify({user})+'</script>'});
 const wrong=parseProfile(response({loggedIn:true,userPageData:{userId:ID2},notes:[[{id:note(1).id,title:'wrong'}]]}),ID);
 assert.equal(wrong.loggedIn,true);assert.equal(wrong.status,'wrong_profile');assert.equal(httpSessionVerified(wrong),false);
 const empty=parseProfile(response({loggedIn:true,notes:[]}),ID);assert.equal(empty.loggedIn,true);assert.equal(httpSessionVerified(empty),false);
});
test('pausing an in-flight request clears checking state and preserves last success',async t=>{
 const s=setup(t),m=s.add(identity(ID)).monitor;let release;
 m.lastSuccess='2026-10-16T00:00:00Z';const q=new Scheduler(s,{collect:()=>new Promise(r=>release=r)},{minimumGapMs:0});
 q.enqueue(ID,true);const running=q.runNext();assert.equal(m.status,'checking');
 q.setRunning(false);release(result([note(1)]));await running;
 assert.equal(m.status,'pending');assert.equal(m.lastSuccess,'2026-10-16T00:00:00Z');assert.equal(m.initialized,false);
});
test('removing and restoring an active author never restores a permanent checking state',async t=>{
 const s=setup(t);s.add(identity(ID));let release;const q=new Scheduler(s,{collect:()=>new Promise(r=>release=r)},{minimumGapMs:0});
 q.enqueue(ID,true);const running=q.runNext();q.remove(ID);s.restore(ID);release(result([note(1)]));await running;
 assert.equal(s.state.monitors[0].status,'pending');assert.equal(s.state.monitors[0].initialized,false);assert.equal(s.state.updates.length,0);
});
test('multiple authors share a persistent pending batch; old acknowledgement preserves new arrivals',t=>{
 const s=setup(t),a=s.add(identity(ID)).monitor,b=s.add(identity(ID2)).monitor;
 for(const m of [a,b]){s.applyResult(m.id,m.generation,result([note(1)]));s.applyResult(m.id,m.generation,result([note(1)]));}
 const first=s.applyResult(ID,a.generation,result([note(2),note(1)])).events[0];
 const second=s.applyResult(ID2,b.generation,result([note(3),note(1)])).events[0];
 assert(first.batchId);assert.equal(first.batchId,second.batchId);
 const reopened=new Store(s.directory);assert.deepEqual(reopened.pending().map(u=>u.batchId),[first.batchId,first.batchId]);
 s.acknowledge([first.eventId]);assert.deepEqual(s.pending().map(u=>u.eventId),[second.eventId]);
 s.acknowledge([second.eventId]);const third=s.applyResult(ID,a.generation,result([note(4),note(2),note(1)])).events[0];
 assert.notEqual(third.batchId,first.batchId);assert.equal(first.read,false);
});
test('HTTP200 with rejected note fetch or server ban never reuses embedded cards as success',()=>{
 const base={loggedIn:true,notes:[[{id:note(1).id,title:'stale card'}]],noteQueries:[{userId:ID,hasMore:false}]};
 for(const patch of [{userNoteFetchingStatus:['rejected']},{userFetchingStatus:'rejected'},{bannedInfo:{serverBanned:true}}]){
  const parsed=parseProfile({status:200,headers:{},body:'<script>window.__INITIAL_STATE__='+JSON.stringify({user:{...base,...patch}})+'</script>'},ID);
  assert.equal(parsed.status,'http_error');assert.equal(parsed.usable,false);assert.equal(httpSessionVerified(parsed),false);assert.equal(parsed.coverageVerified,false);
 }
});
test('profile pagination identity must match the monitored author',()=>{
 const user={loggedIn:true,notes:[[{id:note(1).id,title:'wrong card'}]],noteQueries:[{userId:ID2,hasMore:false}]};
 const parsed=parseProfile({status:200,headers:{},body:'<script>window.__INITIAL_STATE__='+JSON.stringify({user})+'</script>'},ID);
 assert.equal(parsed.status,'wrong_profile');assert.equal(parsed.usable,false);
});
test('explicit session validation failure aborts active work and clears queued authors',async t=>{
 const s=setup(t);const m=s.add(identity(ID)).monitor;s.add(identity(ID2));let release;
 const q=new Scheduler(s,{collect:()=>new Promise(r=>release=r)},{minimumGapMs:0});q.enqueue(ID,true);q.enqueue(ID2,true);
 const pending=q.runNext();assert.equal(m.status,'checking');q.blockSession();assert.equal(q.sessionBlocked,true);assert.equal(q.queue.length,0);assert.equal(q.active.controller.signal.aborted,true);
 release(result([note(1)]));await pending;assert.equal(m.initialized,false);assert.equal(m.status,'pending');assert.equal(q.enqueue(ID2,true),false);
});
