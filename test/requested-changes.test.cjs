'use strict';const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Store}=require('../src/store.cjs'),{Scheduler}=require('../src/scheduler.cjs'),{Collector,avatarUrl,parseProfile}=require('../src/collector.cjs'),{accountFromState}=require('../src/account.cjs');
const a='000000000000000000000001',b='000000000000000000000002',u='000000000000000000000003',url=id=>'https://www.xiaohongshu.com/user/profile/'+id;
function fixture(t){const base=path.resolve(__dirname,'../test-runs/changes');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'run-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(base));fs.rmSync(dir,{recursive:true,force:true});});const store=new Store(dir);store.add({id:a,url:url(a),name:'原博主'});return store;}
test('same-author URL edit preserves baseline but invalidates older jobs; different author resets only its own baseline',t=>{
 const s=fixture(t),m=s.state.monitors[0];Object.assign(m,{initialized:true,seen:[u],identityVerified:true,coverageVerified:true,notes:[{id:u,title:'旧文章'}]});const generation=m.generation;
 const same=s.replaceProfile(a,{id:a,url:url(a)+'?xsec_source=pc_search'},null);assert(same.initialized);assert.deepEqual(same.seen,[u]);assert.notEqual(same.generation,generation);
 s.state.updates.push({userId:a,eventId:'history',ackAt:null,read:false});const changed=s.replaceProfile(a,{id:b,url:url(b)},null);assert.equal(changed.initialized,false);assert.deepEqual(changed.seen,[]);assert.equal(s.state.archive.at(-1).id,a);assert(s.state.updates[0].ackAt);assert.equal(s.state.updates[0].read,false);
});
test('duplicate target and invalid settings do not partially mutate an edited monitor',t=>{
 const s=fixture(t);s.add({id:b,url:url(b)});const previous=s.snapshot();assert.throws(()=>s.replaceProfile(a,{id:b,url:url(b)},null),/已在列表/);assert.deepEqual(s.snapshot(),previous);assert.throws(()=>s.replaceProfile(a,{id:a,url:url(a)},{baseMinutes:1,jitterMinutes:2}));assert.deepEqual(s.snapshot(),previous);
});
test('editing an active author cancels stale data and queues a fresh profile read even while paused',async t=>{
 const s=fixture(t);let resolveOld,started,calls=0,now=1000;const entered=new Promise(r=>started=r),gate=new Promise(r=>resolveOld=r);
 const fresh={loggedIn:true,usable:true,stableIdFormat:true,coverageVerified:false,status:'first_page',name:'新资料',avatar:'https://sns-avatar-qc.xhscdn.com/new.jpg',notes:[{id:u,title:'新文章',url:'https://www.xiaohongshu.com/explore/'+u}]};
 const scheduler=new Scheduler(s,{collect:async()=>{if(++calls===1){started();return gate;}return fresh;}},{now:()=>now});scheduler.enqueue(a,true);const oldJob=scheduler.runNext();await entered;
 const result=scheduler.replaceProfile(a,{id:a,url:url(a)+'?xsec_source=pc_search'},null);assert(result.refreshQueued);assert.equal(scheduler.queue.length,1);s.state.monitors[0].enabled=false;
 resolveOld({...fresh,name:'不应覆盖的新资料'});await oldJob;now+=20000;await scheduler.runNext();assert.equal(calls,2);assert.equal(s.state.monitors[0].name,'新资料');assert.equal(s.state.monitors[0].enabled,false);assert.equal(s.state.monitors[0].initialized,false);assert.equal(s.pending().length,0);
});
test('article list includes fresh samples and historical links once per ID',t=>{
 const s=fixture(t),m=s.state.monitors[0];m.notes=[{id:u,title:'旧标题',url:'https://www.xiaohongshu.com/explore/'+u}];m.previewNotes=[{id:u,title:'新标题',url:'https://www.xiaohongshu.com/explore/'+u}];s.state.updates.push({userId:a,id:u,title:'历史标题'});assert.equal(s.articleList(a).length,1);assert.equal(s.articleList(a)[0].title,'新标题');assert.throws(()=>s.articleList(b));
});
test('a profile edit blocked by login is queued after recovery even for a paused author',async t=>{
 const s=fixture(t),scheduler=new Scheduler(s,{collect:async()=>({loggedIn:true,usable:true,stableIdFormat:true,notes:[{id:u,title:'恢复后读取'}],name:'恢复资料',status:'first_page'})});
 scheduler.pause(a,false);scheduler.blockSession();const result=scheduler.replaceProfile(a,{id:a,url:url(a)+'?xsec_source=pc_search'},null);assert(!result.refreshQueued);assert(s.state.monitors[0].profileRefreshPending);
 scheduler.unblock();assert.equal(scheduler.queue.length,1);await scheduler.runNext();assert.equal(s.state.monitors[0].name,'恢复资料');assert.equal(s.state.monitors[0].profileRefreshPending,false);assert.equal(s.state.monitors[0].enabled,false);
});
test('login identity comes from current account rather than the monitored profile; avatar is official HTTPS',()=>{
 const state={user:{loggedIn:true,userInfo:{userId:u,nickname:'登录账号'},userPageData:{basicInfo:{userId:a,nickname:'监控博主'}}}};assert.deepEqual(accountFromState(state),{id:u,name:'登录账号'});delete state.user.userInfo;assert.equal(accountFromState(state),null);assert.equal(avatarUrl('javascript:alert(1)'),null);assert.equal(avatarUrl('https://evil.test/avatar.png'),null);assert.equal(avatarUrl('http://sns-avatar-qc.xhscdn.com/a.jpg'),'https://sns-avatar-qc.xhscdn.com/a.jpg');
});
function homepage({newId=false,gap=false,short=false}={}){
 const cards=Array.from({length:30},(_,i)=>{const num=gap?100+i:newId?(i?i:99):i+1;return {id:num.toString(16).padStart(24,'0'),noteCard:{displayTitle:'文章'+num,time:1792210000000-i*1000,user:{userId:a},interactInfo:{sticky:false}}};});
 if(short)cards.splice(10);const state={user:{loggedIn:true,userInfo:{userId:u,nickname:'登录账号'},userPageData:{basicInfo:{userId:a,nickname:'博主',imageb:'https://sns-avatar-qc.xhscdn.com/a.jpg'}},noteQueries:[{userId:a,num:30,hasMore:true,cursor:'opaque'}],userNoteFetchingStatus:['resolved'],notes:[cards]}};
 return {status:200,headers:{},body:'<script>window.__INITIAL_STATE__='+JSON.stringify(state)+'</script>'};
}
test('homepage-only recent baseline is silent after two stable samples; new ID emits once; no pagination/detail requests',async t=>{
 const s=fixture(t);let response=homepage(),calls=0;const collector=new Collector({request:async value=>{assert.equal(value,url(a));calls++;return response;}}),m=s.state.monitors[0];
 for(let i=0;i<2;i++){const result=await collector.collect(structuredClone(m));s.applyResult(a,m.generation,result);}assert(m.initialized);assert.equal(m.coverageScope,'recent_window');assert.equal(s.pending().length,0);
 response=homepage({newId:true});const result=await collector.collect(structuredClone(m));s.applyResult(a,m.generation,result);s.applyResult(a,m.generation,result);assert.equal(s.pending().length,1);assert.equal(calls,3);assert.equal(m.avatar,'https://sns-avatar-qc.xhscdn.com/a.jpg');
});
test('a short first screen or lost recent boundary remains incomplete in homepage-only mode',async()=>{
 let response=homepage({short:true});const c=new Collector({request:async()=>response});const first=await c.collect({id:a,url:url(a),initialized:false});assert.equal(first.coverageVerified,false);
 response=homepage({gap:true});const result=await c.collect({id:a,url:url(a),initialized:true,coverageVerified:true,seen:Array.from({length:30},(_,i)=>(i+1).toString(16).padStart(24,'0'))});assert.equal(result.coverageVerified,false);
});
