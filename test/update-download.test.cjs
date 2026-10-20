'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),{EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const {NsisUpdater}=require('electron-updater/out/NsisUpdater'),{AppUpdater}=require('electron-updater/out/AppUpdater'),{Updates}=require('../src/updater.cjs');
const digest=b=>crypto.createHash('sha512').update(b).digest('base64');
function setup(t){const base=path.resolve('test-runs/update-download');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'case-'));t.after(()=>{assert.equal(path.dirname(dir),base);fs.rmSync(dir,{recursive:true,force:true});});
 const size=32768,a=Buffer.alloc(size,65),b=Buffer.alloc(size,66),c=Buffer.alloc(size,67),old=Buffer.concat([a,b]),payload=Buffer.concat([a,c]);
 const map=parts=>({version:'2',files:[{name:'file',offset:0,checksums:parts.map(digest),sizes:parts.map(p=>p.length)}]});
 // NSIS's cache holds the inner installer, while the published block map
 // describes the outer wrapper. Mimic that mismatch with different cached bytes.
 fs.writeFileSync(path.join(dir,'installer.exe'),Buffer.concat([Buffer.alloc(size,88),b]));fs.writeFileSync(path.join(dir,'current.blockmap'),zlib.gzipSync(JSON.stringify(map([a,b]))));
 const engine=new EventEmitter(),progress=[],logs=[],counts={range:0,full:0};engine.on('download-progress',p=>progress.push(p.percent));
 const info={version:'9.9.9',files:[{url:'Setup.exe',sha512:digest(payload),size:payload.length}]},fileInfo={url:new URL('https://updates.invalid/Setup.exe'),info:info.files[0]};
 const provider={isUseMultipleRangeRequest:false,resolveFiles:()=>[fileInfo],getBlockMapFiles:async()=>[new URL('https://updates.invalid/old.blockmap'),new URL('https://updates.invalid/new.blockmap')]};
 Object.assign(engine,{app:{version:'1.1.3'},_logger:{info:s=>logs.push(s),warn:s=>logs.push(s),error:s=>logs.push(s)},downloadedUpdateHelper:{cacheDir:dir,cacheDirForPendingUpdate:path.join(dir,'pending')},setFeedURL(){},verifySignature:async()=>null});
 engine.httpExecutor={downloadToBuffer:async()=>zlib.gzipSync(JSON.stringify(map([a,c]))),createRequest(options,callback){const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{counts.range++;const[start,end]=options.headers.range.match(/\d+/g).map(Number),response=Readable.from([payload.subarray(start,end+1)]);response.statusCode=206;callback(response);});return request;},addErrorAndTimeoutHandlers(){},async download(_url,target,options){counts.full++;for(const percent of [0,25,50,100])options.onProgress({percent,total:payload.length,transferred:payload.length*percent/100});fs.writeFileSync(target,payload);}};
 engine.differentialDownloadInstaller=(...args)=>AppUpdater.prototype.differentialDownloadInstaller.apply(engine,args);
 engine.executeDownload=async options=>{const target=path.join(dir,'download.exe');await options.task(target,{onProgress:p=>engine.emit('download-progress',p)},null,async()=>{});assert.equal(digest(fs.readFileSync(target)),digest(payload));engine.emit('update-downloaded',info);return[target];};
 engine.checkForUpdates=async()=>{engine.emit('checking-for-update');engine.emit('update-available',info);return NsisUpdater.prototype.doDownloadUpdate.call(engine,{disableDifferentialDownload:engine.disableDifferentialDownload||false,disableWebInstaller:true,updateInfoAndProvider:{info,provider},cancellationToken:{cancelled:false}});};
 return{engine,progress,logs,counts};
}
test('actual NSIS downloader reproduces two progress passes after cached installer mismatch',async t=>{
 const f=setup(t);await f.engine.checkForUpdates();assert.equal(f.counts.range,1);assert.equal(f.counts.full,1);assert.deepEqual(f.progress,[100,0,25,50,100]);assert(f.logs.some(s=>s.includes('fallback to full download')));
});
test('application configuration downloads one complete installer without entering differential fallback',async t=>{
 const f=setup(t),u=new Updates({app:{getVersion:()=>'1.1.3'},engine:f.engine,installed:true,getRelease:async()=>null});const snapshots=[];u.on('change',()=>snapshots.push(u.snapshot()));await u.check();assert.equal(f.engine.disableDifferentialDownload,true);assert.equal(f.counts.range,0);assert.equal(f.counts.full,1);assert.deepEqual(f.progress,[0,25,50,100]);assert(!f.logs.some(s=>s.includes('fallback')));assert.equal(u.snapshot().status,'ready');assert.equal(u.snapshot().percent,100);assert(snapshots.some(s=>s.status==='downloading'&&s.downloadPhase==='verifying'&&s.percent<100));
});
