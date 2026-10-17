'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseProfile,businessFailure,httpSessionVerified}=require('../src/collector.cjs'),{Store}=require('../src/store.cjs'),{Scheduler}=require('../src/scheduler.cjs');
test('official HTTP200 account restriction is not login expiry, success, or no updates',()=>{
 const r=parseProfile({status:200,headers:{},body:JSON.stringify({code:300011,success:false,msg:'当前账号存在异常，请切换账号后重试'})},'000000000000000000000001');
 assert.equal(r.status,'account_restricted');assert.equal(r.usable,false);assert.equal(httpSessionVerified(r),false);
 for(const [code,status] of [[300012,'network_error'],[300013,'rate_limited'],[300015,'client_restricted']])assert.equal(businessFailure(code).status,status);
 assert.equal(businessFailure(0),null);
});
test('SSR account restriction overrides embedded notes and a logged-in flag',()=>{
 const r=parseProfile({status:200,headers:{},body:'<script>window.__INITIAL_STATE__='+JSON.stringify({user:{loggedIn:true,bannedInfo:{code:300011,serverBanned:true},notes:[[{id:'000000000000000000000001',noteCard:{title:'stale'}}]]}})+'</script>'},'000000000000000000000001');
 assert.equal(r.status,'account_restricted');assert.equal(r.notes.length,0);assert.equal(r.usable,false);
});
test('account restriction pauses all authors, preserves successful history, and never repeatedly logs in',async()=>{
 const base=path.resolve(__dirname,'../data/test-tmp');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'xhs-business-'));try{
  const s=new Store(dir);for(let i=1;i<=2;i++)s.add({id:String(i).padStart(24,'0'),url:'https://www.xiaohongshu.com/user/profile/'+String(i).padStart(24,'0')});
  const m=s.state.monitors[0];Object.assign(m,{notes:[{id:'000000000000000000000099',title:'prior note'}],seen:['000000000000000000000099'],initialized:true,coverageVerified:true,identityVerified:true,lastSuccess:'2026-10-16T00:00:00.000Z'});s.commit();
  const previous=structuredClone(m);let calls=0,loginEvents=0,restrictedEvents=0;
  const scheduler=new Scheduler(s,{collect:async()=>{calls++;return parseProfile({status:200,headers:{},body:'{"code":300011,"success":false}'},m.id);}});
  scheduler.on('login-required',()=>loginEvents++);scheduler.on('account-restricted',()=>restrictedEvents++);for(const author of s.state.monitors)scheduler.enqueue(author.id,true);
  await scheduler.runNext();assert(scheduler.sessionBlocked);assert.equal(scheduler.queue.length,0);assert.equal(loginEvents,0);assert.equal(restrictedEvents,1);assert.equal(calls,1);
  const after=s.state.monitors[0];assert.deepEqual(after.notes,previous.notes);assert.deepEqual(after.seen,previous.seen);assert.equal(after.lastSuccess,previous.lastSuccess);assert.equal(s.pending().length,0);assert.equal(scheduler.enqueue(s.state.monitors[1].id,true),false);
  const reopened=new Store(dir),restoredScheduler=new Scheduler(reopened,{collect:async()=>{throw Error('must not call');}});assert(restoredScheduler.sessionBlocked);assert.equal(reopened.state.accessBlock.reason,'account_restricted');assert.equal(restoredScheduler.enqueue(m.id,true),false);
  restoredScheduler.unblock();assert.equal(reopened.state.accessBlock,null);assert(!restoredScheduler.sessionBlocked);
 }finally{assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(base));fs.rmSync(dir,{recursive:true,force:true});}
});
