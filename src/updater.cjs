'use strict';
const {EventEmitter}=require('node:events');
const REPOSITORY='https://github.com/qinrz2002/xhs-update-monitor';
function notesText(value,version){
 if(Array.isArray(value)){const entry=value.find(item=>String(item?.version||'').replace(/^v/,'')===version);value=entry?.note||'';}
 if(typeof value!=='string')return '';
 const text=value.slice(0,64000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<li\b[^>]*>/gi,'• ').replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6]|ul|ol|pre)>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_m,key)=>{const known={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(key[0]!=='#')return known[key.toLowerCase()];const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim().slice(0,16000);
 const changes=/(?:^|\n)##\s*(?:本次更新|更新内容)\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(text);return changes?changes[1].trim():text;
}
function publishedTime(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;}
async function fetchRelease(version){
 if(!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version))return null;
 const response=await fetch('https://api.github.com/repos/qinrz2002/xhs-update-monitor/releases/tags/v'+encodeURIComponent(version),{headers:{Accept:'application/vnd.github+json','User-Agent':'xhs-update-monitor'},signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('Release metadata unavailable');
 const raw=await response.text();if(raw.length>256000)throw Error('Release metadata too large');return JSON.parse(raw);
}
class Updates extends EventEmitter {
 constructor({app,engine,installed,enabled=true,beforeInstall=()=>{},now=()=>new Date().toISOString(),getRelease=fetchRelease}){
  super();Object.assign(this,{app,engine,installed,enabled,beforeInstall,now,getRelease});this.releaseRequests=new Map();
  this.value={status:installed?'idle':'installer_required',version:app.getVersion(),latest:null,percent:0,downloadPhase:'idle',checkedAt:null,repository:REPOSITORY,automatic:enabled,installed,releaseNotes:'',publishedAt:null,releaseInfoStatus:'idle'};
  engine.autoDownload=true;engine.autoInstallOnAppQuit=false;engine.allowPrerelease=false;engine.allowDowngrade=false;
  // The published WPF wrapper and NSIS's cached inner installer have different bytes.
  // Differential reconstruction would fail its digest and then repeat the download in full.
  engine.disableDifferentialDownload=true;
  engine.setFeedURL({provider:'github',owner:'qinrz2002',repo:'xhs-update-monitor',private:false});
  engine.on('checking-for-update',()=>this.set({status:'checking',error:null,percent:0,downloadPhase:'idle'}));
  engine.on('update-available',info=>{this.set({status:'available',...this.captureInfo(info),error:null,percent:0,downloadPhase:'downloading'});void this.loadReleaseInfo(info.version);});
  engine.on('update-not-available',info=>{this.set({status:'current',...this.captureInfo(info),checkedAt:now(),error:null});if(info.version)void this.loadReleaseInfo(info.version);});
  engine.on('download-progress',p=>{
   if(!['available','downloading'].includes(this.value.status))return;
   const percent=Math.max(0,Math.min(100,Number(p.percent)||0));
   this.set({status:'downloading',percent:Math.min(99,percent),downloadPhase:percent>=100?'verifying':'downloading'});
  });
  engine.on('update-downloaded',info=>{this.set({status:'ready',...this.captureInfo(info),percent:100,downloadPhase:'complete',checkedAt:now(),error:null});void this.loadReleaseInfo(info.version);});
  engine.on('error',error=>this.failed(error));
 }
 snapshot(){return {...this.value,automatic:this.enabled};}
 captureInfo(info={}){if(!info.version)return {};const same=info.version===this.value.latest;return{latest:info.version,releaseNotes:info.releaseNotes!==undefined?notesText(info.releaseNotes,info.version):same?this.value.releaseNotes:'',publishedAt:same?this.value.publishedAt:null,releaseInfoStatus:same?this.value.releaseInfoStatus:'loading'};}
 async loadReleaseInfo(version){
  if(!version)return;
  let request=this.releaseRequests.get(version);if(!request){request=Promise.resolve().then(()=>this.getRelease(version)).catch(()=>null);this.releaseRequests.set(version,request);}
  const info=await request;if(this.value.latest!==version)return;
  if(!info||info.tag_name!=='v'+version||info.draft||info.prerelease){this.set({releaseInfoStatus:'unavailable'});return;}
  this.set({releaseNotes:notesText(info.body,version),publishedAt:publishedTime(info.published_at),releaseInfoStatus:'ready'});
 }
 set(patch){Object.assign(this.value,patch);this.emit('change');}
 failed(error){this.set({status:'error',checkedAt:this.now(),error:/404|No published versions|No releases/i.test(String(error?.message))?'GitHub 尚未发布可更新的正式版本。':'更新失败，请检查网络或稍后重试。'});}
 async check(){
  if(!this.installed){this.set({status:'installer_required'});return;}
  if(this.busy||['available','downloading','ready','installing'].includes(this.value.status))return;
  this.busy=true;this.set({status:'checking',error:null});
  try{await this.engine.checkForUpdates();}catch(error){this.failed(error);}finally{this.busy=false;}
 }
 start(){this.stop();if(!this.enabled||!this.installed)return;this.first=setTimeout(()=>void this.check(),15000);this.first.unref?.();this.timer=setInterval(()=>void this.check(),60*60*1000);this.timer.unref?.();}
 configure(enabled){this.enabled=Boolean(enabled);this.start();this.emit('change');}
 install(){if(this.value.status!=='ready')throw new Error('更新尚未下载完成。');this.beforeInstall();this.set({status:'installing'});try{this.engine.quitAndInstall(false,true);}catch(error){this.failed(error);throw error;}}
 stop(){clearTimeout(this.first);clearInterval(this.timer);}
}
module.exports={Updates,REPOSITORY,notesText,publishedTime};
