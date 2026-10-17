'use strict';
const {EventEmitter}=require('node:events');
const REPOSITORY='https://github.com/qinrz2002/xhs-update-monitor';
class Updates extends EventEmitter {
 constructor({app,engine,installed,enabled=true,beforeInstall=()=>{},now=()=>new Date().toISOString()}){
  super();Object.assign(this,{app,engine,installed,enabled,beforeInstall,now});
  this.value={status:installed?'idle':'installer_required',version:app.getVersion(),latest:null,percent:0,checkedAt:null,repository:REPOSITORY,automatic:enabled,installed};
  engine.autoDownload=true;engine.autoInstallOnAppQuit=false;engine.allowPrerelease=false;engine.allowDowngrade=false;
  engine.setFeedURL({provider:'github',owner:'qinrz2002',repo:'xhs-update-monitor',private:false});
  engine.on('checking-for-update',()=>this.set({status:'checking',error:null,percent:0}));
  engine.on('update-available',info=>this.set({status:'available',latest:info.version,error:null}));
  engine.on('update-not-available',()=>this.set({status:'current',checkedAt:now(),error:null}));
  engine.on('download-progress',p=>this.set({status:'downloading',percent:Math.max(0,Math.min(100,Number(p.percent)||0))}));
  engine.on('update-downloaded',info=>this.set({status:'ready',latest:info.version,percent:100,checkedAt:now(),error:null}));
  engine.on('error',error=>this.failed(error));
 }
 snapshot(){return {...this.value,automatic:this.enabled};}
 set(patch){Object.assign(this.value,patch);this.emit('change');}
 failed(error){this.set({status:'error',checkedAt:this.now(),error:/404|No published versions|No releases/i.test(String(error?.message))?'GitHub 尚未发布可更新的正式版本。':'更新失败，请检查网络或稍后重试。'});}
 async check(){
  if(!this.installed){this.set({status:'installer_required'});return;}
  if(this.busy||['available','downloading','ready'].includes(this.value.status))return;
  this.busy=true;this.set({status:'checking',error:null});
  try{await this.engine.checkForUpdates();}catch(error){this.failed(error);}finally{this.busy=false;}
 }
 start(){this.stop();if(!this.enabled||!this.installed)return;this.first=setTimeout(()=>void this.check(),15000);this.first.unref?.();this.timer=setInterval(()=>void this.check(),60*60*1000);this.timer.unref?.();}
 configure(enabled){this.enabled=Boolean(enabled);this.start();this.emit('change');}
 install(){if(this.value.status!=='ready')throw new Error('更新尚未下载完成。');this.beforeInstall();this.engine.quitAndInstall(false,true);}
 stop(){clearTimeout(this.first);clearInterval(this.timer);}
}
module.exports={Updates,REPOSITORY};
