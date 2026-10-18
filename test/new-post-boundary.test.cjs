'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Store}=require('../src/store.cjs'),{Collector}=require('../src/collector.cjs');
const {Scheduler}=require('../src/scheduler.cjs');
const author='cccccccccccccccccccccccc',id=n=>n.toString(16).padStart(24,'0'),base=Date.parse('2026-10-01T10:00:00Z');
const note=(n,time=base-n*1000,extra={})=>({id:id(n),title:'文章'+n,publishedAt:time===null?null:new Date(time).toISOString(),pinned:false,...extra});
const result=notes=>({status:'first_page',usable:true,loggedIn:true,stableIdFormat:true,coverageVerified:true,notes});
function fixture(t){const root=path.resolve('test-runs/new-post-boundary');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'case-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(root));fs.rmSync(dir,{recursive:true,force:true});});const s=new Store(dir),m=s.add({id:author,name:'边界校验',url:'https://www.xiaohongshu.com/user/profile/'+author}).monitor;return{s,m};}
function seed(s,m,notes){s.applyResult(m.id,m.generation,result(notes));s.applyResult(m.id,m.generation,result(notes));assert(m.initialized);assert.equal(s.pending().length,0);}
test('deleting a visible post and backfilling an older post produces no new-article notification through homepage collector',async t=>{
 const{s,m}=fixture(t);let rows=Array.from({length:20},(_,i)=>note(i+1)),requests=0;
 const collector=new Collector({request:async url=>{requests++;assert.equal(url,m.url);const state={user:{loggedIn:true,userPageData:{basicInfo:{userId:author}},userNoteFetchingStatus:['resolved'],noteQueries:[{userId:author,num:20,hasMore:true}],notes:[rows.map(n=>({id:n.id,noteCard:{title:n.title,time:Date.parse(n.publishedAt),user:{userId:author},interactInfo:{sticky:n.pinned}}}))]}};return{status:200,headers:{},body:'<script>window.__INITIAL_STATE__='+JSON.stringify(state)+'</script>'};}});
 for(let i=0;i<2;i++)s.applyResult(m.id,m.generation,await collector.collect(structuredClone(m)));assert(m.initialized);
 rows=rows.filter(n=>n.id!==id(8)).concat(note(21));const r=await collector.collect(structuredClone(m));assert(r.coverageVerified);const applied=s.applyResult(m.id,m.generation,r);assert.equal(applied.events.length,0);assert.equal(s.pending().length,0);assert(m.seen.includes(id(21)));assert.equal(s.articleList(m.id).length,20);assert.equal(requests,3);
});
test('one real newer post and two historical backfills in the same response notify only the newer post, once',t=>{
 const{s,m}=fixture(t),rows=[note(1),note(2),note(3),note(4)];seed(s,m,rows);const incoming=[note(90,base+60000),note(1),note(3),note(5),note(6)];const applied=s.applyResult(m.id,m.generation,result(incoming));assert.deepEqual(applied.events.map(n=>n.id),[id(90)]);assert.equal(s.applyResult(m.id,m.generation,result(incoming)).events.length,0);assert(m.seen.includes(id(5))&&m.seen.includes(id(6)));
});
test('old newly pinned or restored posts do not notify even when placed at the front',t=>{
 const{s,m}=fixture(t);seed(s,m,[note(1),note(2),note(3)]);assert.equal(s.applyResult(m.id,m.generation,result([note(50,base-50000,{pinned:true}),note(1),note(2),note(3)])).events.length,0);assert.equal(s.applyResult(m.id,m.generation,result([note(40),note(1),note(2),note(3)])).events.length,0);
});
test('publication high-water mark survives deletion of all newest posts and process restart',t=>{
 const{s,m}=fixture(t);seed(s,m,[note(1),note(2),note(3)]);s.applyResult(m.id,m.generation,result([note(3),note(4),note(5)]));const reopened=new Store(s.directory),again=reopened.state.monitors[0];assert.equal(reopened.applyResult(again.id,again.generation,result([note(6,base-2000),note(3),note(4),note(5)])).events.length,0);assert.equal(reopened.applyResult(again.id,again.generation,result([note(90,base+1000),note(3),note(4)])).events.length,1);
});
test('equal publication timestamps need a prior regular anchor at that timestamp and a leading position',t=>{
 const{s,m}=fixture(t),time=base-1000;seed(s,m,[note(1,time),note(2,time),note(3)]);assert.equal(s.applyResult(m.id,m.generation,result([note(4,time),note(1,time),note(2,time),note(5,time),note(3)])).events.length,1);assert.equal(s.state.updates[0].id,id(4));
});
test('unknown or invalid publication dates are saved but never promoted into new-post notifications',t=>{
 const{s,m}=fixture(t);seed(s,m,[note(1),note(2),note(3)]);const rows=[note(90,null),note(91,null,{publishedAt:'invalid'}),note(1),note(2)];assert.equal(s.applyResult(m.id,m.generation,result(rows)).events.length,0);assert(m.seen.includes(id(90)));assert.equal(s.pending().length,0);
});
test('legacy monitor derives cutoff from last successful notes, never fresh preview cards',t=>{
 const{s,m}=fixture(t);Object.assign(m,{initialized:true,identityVerified:true,coverageVerified:true,seen:[id(1),id(2),id(3)],notes:[note(1),note(2),note(3)],previewNotes:[note(99,base+900000)]});const applied=s.applyResult(m.id,m.generation,result([note(90,base+1000),note(1),note(2),note(5)]));assert.deepEqual(applied.events.map(n=>n.id),[id(90)]);
});
test('legacy baseline without trustworthy publication dates establishes its first dated boundary silently',t=>{
 const{s,m}=fixture(t);Object.assign(m,{initialized:true,identityVerified:true,coverageVerified:true,seen:[id(1)],notes:[note(1,null)]});assert.equal(s.applyResult(m.id,m.generation,result([note(90),note(1)])).events.length,0);assert.equal(s.applyResult(m.id,m.generation,result([note(91,base+1000),note(90),note(1)])).events.length,1);
});
test('incomplete and profile-only reads do not advance notification cutoff or consume a genuine new post',t=>{
 const{s,m}=fixture(t);seed(s,m,[note(1),note(2),note(3)]);s.applyResult(m.id,m.generation,{...result([note(90,base+1000),note(1)]),coverageVerified:false});s.applyProfile(m.id,m.generation,result([note(91,base+2000),note(1)]));assert.equal(s.applyResult(m.id,m.generation,result([note(90,base+1000),note(1),note(2)])).events.length,1);
});
test('clearly future timestamps never notify or poison the saved publication cutoff',t=>{
 const{s,m}=fixture(t);seed(s,m,[note(1),note(2),note(3)]);assert.equal(s.applyResult(m.id,m.generation,result([note(90,Date.now()+86400000),note(1),note(2)])).events.length,0);assert.equal(s.applyResult(m.id,m.generation,result([note(91,base+1000),note(1),note(2)])).events.length,1);
});
test('scheduler emits its reminder signal only for a genuine later publication, never historical backfill',async t=>{
 const{s,m}=fixture(t);seed(s,m,[note(1),note(2),note(3)]);let rows=[note(1),note(3),note(4)],signals=0;
 const scheduler=new Scheduler(s,{collect:async()=>result(rows)},{minimumGapMs:0});scheduler.on('new-updates',()=>signals++);
 scheduler.enqueue(m.id,true);await scheduler.runNext();assert.equal(signals,0);assert.equal(s.pending().length,0);
 rows=[note(90,base+1000),note(1),note(3),note(4),note(5)];scheduler.enqueue(m.id,true);await scheduler.runNext();assert.equal(signals,1);assert.deepEqual(s.pending().map(n=>n.id),[id(90)]);
 scheduler.enqueue(m.id,true);await scheduler.runNext();assert.equal(signals,1);
});
test('editing or restoring the same author preserves the cutoff, changing author resets it',t=>{
 const{s,m}=fixture(t);seed(s,m,[note(1),note(2),note(3)]);const boundary=structuredClone(m.notificationBoundary);
 const edited=s.replaceProfile(m.id,{id:m.id,url:m.url+'?xsec_source=pc_user'},null);assert.deepEqual(edited.notificationBoundary,boundary);
 s.remove(m.id);s.restore(m.id);const restored=s.state.monitors[0];assert.deepEqual(restored.notificationBoundary,boundary);
 const replacement=s.replaceProfile(restored.id,{id:'dddddddddddddddddddddddd',url:'https://www.xiaohongshu.com/user/profile/dddddddddddddddddddddddd'},null);assert.equal(replacement.notificationBoundary,undefined);assert.equal(replacement.initialized,false);
});
