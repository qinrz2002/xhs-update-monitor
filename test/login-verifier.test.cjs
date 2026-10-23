'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{LoginVerifier}=require('../src/login-verifier.cjs');
const account={id:'a'.repeat(24),name:'当前账号'},valid=()=>({status:'first_page',loggedIn:true,usable:true,stableIdFormat:true});
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(probe=async()=>valid()){
 const f={now:2000000000000,calls:0,unblocks:0,clears:0,verified:0};
 f.store={state:{accessBlock:null}};f.login={revision:0,state:'unverified',account,setState(state,details=null){this.state=state;this.verification=details;},setAccount(value){this.account=value;},verified(){f.verified++;this.setState('logged_in');},invalid(){this.account=null;this.setState('expired');}};
 f.scheduler={sessionBlocked:false,unblock(){f.unblocks++;this.sessionBlocked=false;f.store.state.accessBlock=null;},blockSession(reason='login_required'){this.sessionBlocked=true;f.store.state.accessBlock={reason};}};
 f.transport={policy:{state:{},clearBlock(){f.clears++;this.state.blocked=null;}}};f.verifier=new LoginVerifier({...f,now:()=>f.now,probe:options=>{f.calls++;return probe(options);}});return f;
}
test('automatic verification cooldown is waiting, never a stuck active verification',async()=>{
 const f=fixture();f.transport.policy.state.lastVerificationAt=f.now-1000;await f.verifier.verify();assert.equal(f.calls,0);assert.equal(f.login.state,'verification_deferred');assert.equal(f.login.verification.retryAt,f.now+299000);
});
test('queued verification becomes active only when the actual transport starts, preserves known account',async()=>{
 const pending=gate();let options;const f=fixture(o=>{options=o;return pending.promise;});const job=f.verifier.verify();await new Promise(setImmediate);assert.equal(f.login.state,'verification_waiting');assert.equal(f.verifier.verify(),job);assert.equal(f.calls,1);
 options.onRequestStart();assert.equal(f.login.state,'verifying');pending.resolve(valid());await job;assert.equal(f.login.state,'logged_in');assert.deepEqual(f.login.account,account);assert.equal(f.unblocks,0,'successful normal validation must not reset every monitor schedule');
});
test('rate policy refusal exits verification and manual refusal still reports the existing policy error',async()=>{
 const refusal=Object.assign(Error('cooldown'),{code:'REQUEST_POLICY',status:'rate_limited',retryAfter:123});const f=fixture(async o=>{o.onRequestStart();throw refusal;});await f.verifier.verify();assert.equal(f.login.state,'verification_deferred');assert.equal(f.login.verification.retryAt,f.now+123000);
 await assert.rejects(f.verifier.verify({explicit:true}),e=>e===refusal);assert.equal(f.login.state,'verification_deferred');assert.equal(f.verifier.job,null);
});
test('account restrictions suppress automatic probes and passive success cannot bypass them',async()=>{
 for(const reason of ['account_restricted','client_restricted','verification_required','login_required']){const f=fixture();f.store.state.accessBlock={reason};f.transport.policy.state.blocked=reason;await f.verifier.verify();assert.equal(f.calls,0);assert.equal(f.login.state,reason==='login_required'?'expired':reason);assert.equal(f.verifier.observe(valid(),0),false);assert.equal(f.clears,0);}
});
test('only an explicit successful HTTP verification can recover a blocked session',async()=>{
 const f=fixture();f.store.state.accessBlock={reason:'account_restricted'};f.transport.policy.state.blocked='account_restricted';f.scheduler.sessionBlocked=true;await f.verifier.verify({explicit:true});assert.equal(f.login.state,'logged_in');assert.equal(f.transport.policy.state.blocked,null);assert.equal(f.store.state.accessBlock,null);assert.equal(f.unblocks,1);
});
test('old requests cannot verify or expire a different browser session',async()=>{
 const first=gate(),second=gate();let count=0;const f=fixture(()=>++count===1?first.promise:second.promise);const old=f.verifier.verify();await new Promise(setImmediate);f.login.revision++;const current=f.verifier.verify();await old;await new Promise(setImmediate);assert.equal(f.calls,2);first.resolve({status:'login_required'});await new Promise(setImmediate);assert.notEqual(f.login.state,'expired');second.resolve(valid());await current;assert.equal(f.login.state,'logged_in');assert.equal(f.store.state.accessBlock,null);
});
test('a current collection result repairs pending login without another request or rescheduling',async()=>{
 const f=fixture();f.login.state='verifying';assert.equal(f.verifier.observe(valid(),0),true);assert.equal(f.login.state,'logged_in');assert.equal(f.calls,0);assert.equal(f.unblocks,0);
 f.login.revision=1;assert.equal(f.verifier.observe(valid(),0),false);for(const status of ['wrong_profile','incomplete','preview_only','http_error'])assert.equal(f.verifier.observe({...valid(),status},1),false);
});
test('successful collection cancels a queued probe and ignores its later failure',async()=>{
 const pending=gate();const f=fixture(()=>pending.promise);const job=f.verifier.verify();await new Promise(setImmediate);assert.equal(f.verifier.observe(valid(),0),true);await job;pending.resolve({status:'login_required'});await new Promise(setImmediate);assert.equal(f.login.state,'logged_in');assert.equal(f.store.state.accessBlock,null);
});
test('deadline aborts a hanging verification and late success cannot change timeout state',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const pending=gate();let signal;const f=fixture(o=>{signal=o.signal;o.onRequestStart();return pending.promise;});const job=f.verifier.verify();await new Promise(setImmediate);assert.equal(f.login.state,'verifying');t.mock.timers.tick(150000);await job;assert(signal.aborted);assert.equal(f.login.state,'verification_timeout');assert.equal(f.verifier.job,null);pending.resolve(valid());await new Promise(setImmediate);assert.equal(f.login.state,'verification_timeout');
});
test('empty or wrong profile results and network failure do not claim login success',async()=>{
 for(const status of ['wrong_profile','incomplete','preview_only','http_error']){const f=fixture(async()=>({...valid(),status}));await f.verifier.verify();assert.equal(f.login.state,'http_not_verified');assert.equal(f.verified,0);}
 const f=fixture(async()=>{throw Error('network');});await f.verifier.verify();assert.equal(f.login.state,'network_error');
});
test('platform rate limit is deferred rather than treated as login expiration',async()=>{const f=fixture(async()=>({status:'rate_limited',retryAfter:600}));await f.verifier.verify();assert.equal(f.login.state,'verification_deferred');assert.equal(f.store.state.accessBlock,null);});
test('scheduler forwards a verified collection even when page has no current-account metadata',async()=>{
 const {Scheduler}=require('../src/scheduler.cjs');const f=fixture(),m={id:'a'.repeat(24),generation:'same',enabled:true,status:'pending',failures:0};let calls=0;
 Object.assign(f.store,{state:{...f.store.state,config:{baseMinutes:10,jitterMinutes:5},monitors:[m]},commit(){},applyResult(){return{stale:false};}});
 const scheduler=new Scheduler(f.store,{collect:async()=>{calls++;return valid();}},{now:()=>f.now,sessionRevision:()=>f.login.revision,minimumGapMs:0});scheduler.on('session-verified',({result,revision})=>f.verifier.observe(result,revision));f.login.state='verifying';scheduler.enqueue(m.id,true);await scheduler.runNext();assert.equal(f.login.state,'logged_in');assert.equal(calls,1);assert.equal(f.calls,0);assert.equal(f.unblocks,0);
});
test('scheduler carries the original revision so a previous-session collection cannot verify the new one',async()=>{
 const {Scheduler}=require('../src/scheduler.cjs');const f=fixture(),pending=gate(),m={id:'a'.repeat(24),generation:'same',enabled:true,status:'pending',failures:0};
 Object.assign(f.store,{state:{...f.store.state,config:{baseMinutes:10,jitterMinutes:5},monitors:[m]},commit(){},applyResult(){return{stale:false};}});
 const scheduler=new Scheduler(f.store,{collect:()=>pending.promise},{now:()=>f.now,sessionRevision:()=>f.login.revision,minimumGapMs:0});scheduler.on('session-verified',({result,revision})=>f.verifier.observe(result,revision));scheduler.enqueue(m.id,true);const task=scheduler.runNext();f.login.revision++;f.login.state='unverified';pending.resolve(valid());await task;assert.equal(f.login.state,'unverified');assert.equal(f.verified,0);
});
test('a previous-session login failure cannot expire the newly captured browser session',async()=>{
 const {Scheduler}=require('../src/scheduler.cjs');const f=fixture(),pending=gate(),m={id:'a'.repeat(24),generation:'same',enabled:true,status:'pending',failures:0};let applied=0,expired=0;
 Object.assign(f.store,{state:{...f.store.state,config:{baseMinutes:10,jitterMinutes:5},monitors:[m]},commit(){},applyResult(){applied++;return{stale:false};}});
 const scheduler=new Scheduler(f.store,{collect:()=>pending.promise},{now:()=>f.now,sessionRevision:()=>f.login.revision,minimumGapMs:0});scheduler.on('login-required',()=>expired++);scheduler.enqueue(m.id,true);const task=scheduler.runNext();f.login.revision++;pending.resolve({status:'login_required'});await task;assert.equal(applied,0);assert.equal(expired,0);assert.equal(scheduler.sessionBlocked,false);assert.equal(m.status,'pending');
});
