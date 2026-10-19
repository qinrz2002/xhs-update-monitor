'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {RequestPolicy,responseRestriction,retryAfter}=require('../src/request-policy.cjs');
const {CurlTransport}=require('../src/transport.cjs');
const {Scheduler}=require('../src/scheduler.cjs');
const url=n=>'https://www.xiaohongshu.com/user/profile/'+String(n).padStart(24,'0');
const response=(status=200,body='<html></html>',headers={})=>({status,headers,body});
function fixture(options={}){let now=2000000000000;const logs=[],saved=[];const p=new RequestPolicy({now:()=>now,random:()=>0.5,save:s=>saved.push(structuredClone(s)),audit:e=>logs.push(e),...options});return{p,logs,saved,get now(){return now;},advance(ms){now+=ms;}};}
test('every curl path shares a random completion gap, including search and redirects',async()=>{
 const f=fixture(),waits=[],wire=[];
 const transport=new CurlTransport({policy:f.p,wait:async ms=>{waits.push(ms);f.advance(ms);}});
 transport.perform=async(value)=>{wire.push({value,at:f.now});return response();};
 await transport.request(url(1));await transport.searchUsers('synthetic');await transport.request('https://xhslink.cn/o/synthetic');
 assert.equal(wire.length,3);assert.deepEqual(waits,[60000,60000]);assert(wire[1].at-wire[0].at>=30000);assert(wire[2].at-wire[1].at>=30000);
});
test('random gap spans 30 to 90 seconds without changing user agent or URL',()=>{
 for(const [random,min,max]of [[()=>0,30000,30000],[()=>0.999999,89999,90000]]){const f=fixture({random});const t=f.p.begin(url(1));f.p.finish(t,response());assert(f.p.waitTime()>=min&&f.p.waitTime()<=max);}
});
test('same profile floor survives restart and manual verification does not bypass it',()=>{
 const f=fixture();const t=f.p.begin(url(1));f.p.finish(t,response());f.advance(90000);
 const restored=new RequestPolicy({state:structuredClone(f.p.state),now:()=>f.now});
 assert.throws(()=>restored.begin(url(1),{verificationProbe:true}),e=>e.code==='REQUEST_POLICY'&&e.retryAfter===210);
 f.advance(210000);assert.doesNotThrow(()=>restored.begin(url(1)));
});
test('platform restrictions from search, SSR, challenge and expiry stop all curl requests',()=>{
 for(const [r,expected]of [[response(200,'{"code":300011}'),'account_restricted'],[response(200,'{"code":300015}'),'client_restricted'],[response(406),'client_restricted'],[response(471),'verification_required'],[response(302,'',{location:['/captcha']}),'verification_required'],[response(403),'login_required'],[response(200,'{"code":-100}'),'login_required'],[response(200,'<script>window.__INITIAL_STATE__={"user":{"bannedInfo":{"serverBanned":true}}}</script>'),'account_restricted']]){
  let restriction;const f=fixture({onRestriction:s=>restriction=s});const t=f.p.begin(url(1));f.p.finish(t,r);
  assert.equal(responseRestriction(r),expected);assert.equal(restriction,expected);assert.throws(()=>f.p.begin(url(2)),e=>e.status===expected);
  const restored=new RequestPolicy({state:structuredClone(f.p.state),now:()=>f.now});assert.throws(()=>restored.assertAllowed());
 }
});
test('search restriction drains already queued profiles before another wire request',async()=>{
 const f=fixture(),transport=new CurlTransport({policy:f.p,wait:async ms=>f.advance(ms)});let wires=0;
 transport.perform=async()=>{wires++;return response(200,'{"code":300011}');};
 const results=await Promise.allSettled([transport.searchUsers('test'),transport.request(url(1)),transport.request(url(2))]);
 assert.equal(wires,1);assert.equal(results[0].status,'fulfilled');assert(results.slice(1).every(r=>r.status==='rejected'&&r.reason.status==='account_restricted'));
});
test('only explicit verification can probe a block; a response alone never resumes monitoring',()=>{
 const f=fixture({state:{blocked:'account_restricted'}});assert.throws(()=>f.p.begin(url(1)));
 const ticket=f.p.begin(url(1),{verificationProbe:true});f.p.finish(ticket,response());assert.equal(f.p.state.blocked,'account_restricted');
 f.p.clearBlock();assert.doesNotThrow(()=>f.p.assertAllowed());
});
test('429 respects Retry-After plus positive jitter, persists cooldown and backs off repeated limits',()=>{
 const f=fixture();const t=f.p.begin(url(1));f.p.finish(t,response(429,'',{'retry-after':['7200']}));
 assert.equal(f.p.state.cooldownUntil-f.now,7500000);
 const restored=new RequestPolicy({state:structuredClone(f.p.state),now:()=>f.now});assert.throws(()=>restored.assertAllowed({verificationProbe:true}),e=>e.status==='rate_limited');
 f.advance(7500000);const t2=f.p.begin(url(1));f.p.finish(t2,response(429));assert.equal(f.p.state.cooldownUntil-f.now,3900000);
});
test('Retry-After date and long server delays are never shortened to local cap',()=>{
 const f=fixture(),future=new Date(f.now+48*3600000).toUTCString();assert.equal(retryAfter({'retry-after':[future]},f.now),48*3600000);
 const t=f.p.begin(url(1));f.p.finish(t,response(503,'',{'retry-after':['172800']}));assert(f.p.state.cooldownUntil>=f.now+172800000);
 assert.equal(retryAfter({'retry-after':['invalid']},f.now),0);
});
test('failed curl attempts count toward budgets, impose backoff and never retry immediately',async()=>{
 const f=fixture(),transport=new CurlTransport({policy:f.p,wait:async ms=>f.advance(ms)});let calls=0;
 transport.perform=async()=>{calls++;throw Error('offline');};await assert.rejects(transport.request(url(1)),/offline/);
 await assert.rejects(transport.request(url(2)),e=>e.code==='REQUEST_POLICY');assert.equal(calls,1);assert.equal(f.p.state.attempts.length,1);assert(f.p.state.cooldownUntil>f.now);
});
test('hourly and daily budgets are shared and not bypassed by explicit verification',()=>{
 for(const scope of ['hour','day']){const f=fixture();f.p.state.attempts=Array.from({length:scope==='hour'?60:500},(_,i)=>f.now-(scope==='hour'?1000:2*3600000)-i*1000);
  f.p.state.attempts.sort((a,b)=>a-b);assert.throws(()=>f.p.begin(url(1),{verificationProbe:true}),e=>e.status==='rate_limited');assert.equal(f.p.state.resources[ f.p.key(url(1)) ],undefined);
 }
});
test('abort while waiting consumes no request and no cookie; queued work rechecks current block',async()=>{
 const f=fixture();f.p.state.nextRequestAt=f.now+90000;let started,release,wires=0,cookies=0;
 const ready=new Promise(r=>started=r),transport=new CurlTransport({policy:f.p,cookies:async()=>{cookies++;return '';},wait:()=>{started();return new Promise(r=>release=r);}});
 transport.perform=async()=>{wires++;return response();};const c=new AbortController(),job=transport.request(url(1),{signal:c.signal});await ready;c.abort();release();await assert.rejects(job,/取消/);
 assert.equal(wires,0);assert.equal(cookies,0);assert.equal(f.p.state.attempts.length,0);
});
test('request audit contains only timing, endpoint class and status, never URLs, IDs or cookies',async()=>{
 const f=fixture(),transport=new CurlTransport({policy:f.p});transport.perform=async()=>response(200,'private-body',{'set-cookie':['web_session=secret-cookie']});
 await transport.request(url(123)+'?xsec_token=secret-token');const output=JSON.stringify(f.logs);for(const secret of ['secret-cookie','secret-token','private-body',String(123).padStart(24,'0'),'xsec_token'])assert(!output.includes(secret));assert.equal(f.logs[0].endpoint,'profile');assert.equal(f.logs[0].status,200);
});
test('scheduler restores cooldown and policy refusal neither retries immediately nor counts as five network failures',async()=>{
 const now=2000000000000,m={id:'test',enabled:true,generation:'same',status:'pending',failures:4},s={state:{config:{baseMinutes:10,jitterMinutes:5},monitors:[m],requestPolicy:{cooldownUntil:now+3600000}},commit(){}};
 const q=new Scheduler(s,{collect:async()=>{throw Object.assign(Error('冷却'),{code:'REQUEST_POLICY',status:'rate_limited',retryAfter:7200});}},{now:()=>now,random:()=>0,minimumGapMs:0});
 assert.equal(q.nextGlobal,now+3600000);q.nextGlobal=0;q.enqueue('test',true);await q.runNext();assert.equal(m.failures,4);assert(m.enabled);assert.equal(q.nextGlobal,now+7200000);assert.equal(m.status,'rate_limited');
});
test('curl invocation disables implicit curlrc retries and sends credentials only through stdin',async()=>{
 const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
 const file=path.resolve(__dirname,'../src/transport.cjs'),m=new Module(file,module),requireActual=Module.createRequire(file);let invocation,config='';
 m.filename=file;m.paths=module.paths;m.require=id=>id==='node:child_process'?{spawn:(exe,args,options)=>{
  invocation={exe,args,options};const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
  c.stdin=new Writable({write(chunk,_encoding,done){config+=chunk.toString();done();},final(done){done();setImmediate(()=>{c.stdout.end('HTTP/1.1 200 OK\r\n\r\n<html></html>');c.emit('close',0);});}});return c;
 }}:requireActual(id);
 m._compile(fs.readFileSync(file,'utf8'),file);
 const transport=new m.exports.CurlTransport({cookies:async()=> 'web_session=synthetic-private'});await transport.request(url(1));
 assert.deepEqual(invocation.args,['-q','--config','-']);assert.equal(invocation.options.shell,false);assert.equal(invocation.options.windowsHide,true);assert(!JSON.stringify(invocation.args).includes('synthetic-private'));
 for(const token of ['max-time = 25','connect-timeout = 10','Accept: text/html','Accept-Language: zh-CN','Cookie: web_session=synthetic-private'])assert(config.includes(token),token);
 assert(!config.includes('location'));assert(!config.includes('insecure'));assert(!config.includes('retry ='));
});
