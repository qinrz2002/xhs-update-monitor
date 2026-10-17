'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {instancePaths,bindDataLocation,restoreWindow,acquireSharedInstance}=require('../src/instance.cjs');
function fixture(t){const base=path.resolve(__dirname,'../test-runs/test-data');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'instance-'));t.after(()=>{assert.equal(path.dirname(dir),base);fs.rmSync(dir,{recursive:true,force:true})});return dir;}
function appAt(dir){return{getPath:key=>{assert.equal(key,'appData');return dir},setName(name){this.name=name},setPath(key,value){this.profile=value}};}
const snapshot=theme=>({schemaVersion:1,config:{theme},monitors:[],updates:[],archive:[]});
test('installer shutdown request is acknowledged and invokes the persistence/quit handler once',async()=>{
 const net=require('node:net'),pipe='\\\\.\\pipe\\XhsUpdateMonitor-test-'+randomUUID();let count=0;
 const owner=await acquireSharedInstance(pipe,()=>assert.fail('Must not activate'),{shutdownForUpdate:async()=>count++});
 try{const reply=await new Promise((resolve,reject)=>{const s=net.createConnection(pipe);let text='';s.on('error',reject);s.on('connect',()=>s.end('shutdown-for-update\n'));s.on('data',b=>text+=b);s.on('end',()=>resolve(text));});await new Promise(setImmediate);assert.equal(reply,'shutting-down\n');assert.equal(count,1);}finally{await new Promise(r=>owner.server.close(r));}
});
test('different executable/data directories share one account channel while retaining original profiles',t=>{
 const dir=fixture(t),a=appAt(dir),b=appAt(dir);
 const first=instancePaths(a,path.join(dir,'copy-a'),{XHS_MONITOR_DATA:path.join(dir,'data-a')});
 const second=instancePaths(b,path.join(dir,'copy-b'),{XHS_MONITOR_DATA:path.join(dir,'data-b')});
 assert.equal(first.pipe,second.pipe);assert.notEqual(first.profile,second.profile);assert.equal(first.profile,path.join(first.data,'desktop-profile'));assert.equal(a.name,b.name);
});
test('existing minimized/hidden windows are restored and focused without creating another',()=>{
 const calls=[],win={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')};
 assert.equal(restoreWindow(win),true);assert.deepEqual(calls,['restore','show','focus']);assert.equal(restoreWindow(null),false);assert.equal(restoreWindow({...win,isDestroyed:()=>true}),false);
});
test('shared channel admits one owner and subsequent launches activate that owner',async()=>{
 const pipe='\\\\.\\pipe\\XhsUpdateMonitor-test-'+randomUUID();let activated=0;
 const first=await acquireSharedInstance(pipe,()=>activated++);
 try{const second=await acquireSharedInstance(pipe,()=>assert.fail('Duplicate became primary'));assert(first.owner);assert.equal(second.owner,false);assert.equal(activated,1);}finally{await new Promise(resolve=>first.server.close(resolve));}
});
test('shared channel is available again after its owner exits',async()=>{
 const pipe='\\\\.\\pipe\\XhsUpdateMonitor-test-'+randomUUID();const first=await acquireSharedInstance(pipe,()=>{});await new Promise(resolve=>first.server.close(resolve));
 const next=await acquireSharedInstance(pipe,()=>{});assert(next.owner);await new Promise(resolve=>next.server.close(resolve));
});
test('another executable imports saved JSON and encrypted session into its own adjacent data folder',t=>{
 const dir=fixture(t),first=instancePaths(appAt(dir),path.join(dir,'copy-a'),{});fs.mkdirSync(first.data,{recursive:true});fs.writeFileSync(path.join(first.data,'session.enc'),'synthetic-encrypted-placeholder');bindDataLocation(first.locator,first.data);
 const second=instancePaths(appAt(dir),path.join(dir,'copy-b'),{});assert.notEqual(second.data,first.data);assert.notEqual(second.profile,first.profile);assert.equal(fs.readFileSync(path.join(first.data,'session.enc'),'utf8'),'synthetic-encrypted-placeholder');assert(fs.existsSync(path.join(dir,'copy-b/data/session.enc')));
});
