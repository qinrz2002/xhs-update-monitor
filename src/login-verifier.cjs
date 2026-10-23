'use strict';
const { httpSessionVerified } = require('./collector.cjs');
const { validAccount } = require('./account.cjs');
const restricted = new Set(['login_required','verification_required','account_restricted','client_restricted']);
class LoginVerifier {
 constructor({login,scheduler,store,transport,probe,now=Date.now,timeoutMs=150000}){Object.assign(this,{login,scheduler,store,transport,probe,now,timeoutMs});this.job=null;}
 reason(){return this.store.state.accessBlock?.reason||this.transport.policy.state.blocked;}
 blocked(reason){this.login.setState(reason==='login_required'?'expired':reason);}
 deferred(retryAt){this.login.setState('verification_deferred',{retryAt,message:'验证受请求间隔或冷却规则限制，等待下次检测成功后同步，也可在等待结束后手动验证。'});}
 current(job){return this.job===job&&!job.controller.signal.aborted&&job.revision===(this.login.revision||0);}
 cancel(){const job=this.job;this.job=null;job?.controller.abort();}
 verify({explicit=false}={}){
  const revision=this.login.revision||0;
  if(this.job&&this.job.revision!==revision)this.cancel();
  const reason=this.reason();
  if(!explicit&&reason){this.blocked(reason);return Promise.resolve();}
  if(this.job)return this.job.promise;
  const last=this.transport.policy.state.lastVerificationAt;
  if(!explicit&&Number.isFinite(last)&&last+300000>this.now()){this.deferred(last+300000);return Promise.resolve();}
  const job={revision,explicit,controller:new AbortController()};this.job=job;
  this.login.setState('verification_waiting',{message:'正在等待已有请求完成及请求间隔，不会额外提高访问频率。'});
  job.promise=this.run(job);return job.promise;
 }
 async run(job){
  let timer,aborted;
  try{
   const options={signal:job.controller.signal,verificationProbe:job.explicit,onRequestStart:()=>{if(this.current(job))this.login.setState('verifying');}};
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Session verification timed out'),{code:'SESSION_VERIFY_TIMEOUT'})),this.timeoutMs);timer.unref?.();});
   const cancelled=new Promise((_,reject)=>{aborted=()=>reject(Object.assign(Error('Verification cancelled'),{code:'ABORTED'}));job.controller.signal.addEventListener('abort',aborted,{once:true});});
   const result=await Promise.race([Promise.resolve().then(()=>this.probe(options)),timeout,cancelled]);
   if(this.current(job))this.apply(result,job.explicit);
  }catch(error){
   if(!this.current(job))return;
   if(error.code==='SESSION_VERIFY_TIMEOUT'){this.login.setState('verification_timeout',{message:'验证等待或请求超时，可稍后手动验证；监控结果成功后也会自动同步状态。'});job.controller.abort();}
   else if(error.code==='REQUEST_POLICY'){
    if(restricted.has(error.status))this.blocked(error.status);
    else this.deferred(this.now()+Math.max(1,error.retryAfter||1)*1000);
    if(job.explicit)throw error;
   }else this.login.setState('network_error');
  }finally{clearTimeout(timer);if(aborted)job.controller.signal.removeEventListener('abort',aborted);if(this.job===job)this.job=null;}
 }
 apply(result,explicit=false){
  const reason=this.reason();
  if(!explicit&&reason){this.blocked(reason);return false;}
  if(httpSessionVerified(result)||result.status==='account_verified'){
   if(validAccount(result.account))this.login.setAccount(result.account);
   this.transport.policy.state.lastVerificationAt=this.now();this.transport.policy.clearBlock();this.login.verified();
   if(this.scheduler.sessionBlocked||this.store.state.accessBlock)this.scheduler.unblock();
   return true;
  }
  if(result.status==='login_required'){this.scheduler.blockSession();this.login.invalid();}
  else if(['verification_required','account_restricted','client_restricted'].includes(result.status)){this.scheduler.blockSession(result.status);this.login.setState(result.status);}
  else if(result.status==='rate_limited')this.deferred(Math.max(this.transport.policy.state.cooldownUntil||0,this.now()+Math.max(1,result.retryAfter||600)*1000));
  else this.login.setState('http_not_verified');
  return false;
 }
 observe(result,revision){
  if(revision!==(this.login.revision||0)||this.reason()||!httpSessionVerified(result))return false;
  this.cancel();return this.apply(result);
 }
}
module.exports={LoginVerifier};
