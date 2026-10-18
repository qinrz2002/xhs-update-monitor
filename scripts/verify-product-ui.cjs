const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {Store}=require('../src/store.cjs');
const base=path.resolve('test-runs/product-ui');fs.mkdirSync(base,{recursive:true});const run=fs.mkdtempSync(path.join(base,'run-'));const data=path.join(run,'data'),store=new Store(data);
store.configure({theme:'light',running:true,autoLogin:false,sound:false,notifications:false,automaticUpdates:false});
const names=['清野日记','北屿研究室','周末慢生活','林间书房'];
for(let i=0;i<names.length;i++){
 const id=String(i+1).padStart(24,'0');const m=store.add({id,name:names[i],url:'https://www.xiaohongshu.com/user/profile/'+id}).monitor;
 const colors=[['#c3d4c3','#698b70'],['#c9d9e7','#65849b'],['#f0d9c0','#b28b68'],['#d8d2e3','#90839f']][i];
 m.avatar='data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="${colors[0]}"/><circle cx="52" cy="18" r="9" fill="#fff" opacity=".7"/><path d="M0 58L24 24 52 62 72 40V72H0" fill="${colors[1]}"/><path d="M0 64L20 48 40 68 60 52 72 60V72H0" fill="#fff" opacity=".35"/></svg>`).toString('base64');
 m.notes=[{id:'a'+String(i+1).padStart(23,'0'),title:['把普通的日子，过成喜欢的模样','一周好物观察：值得留下的生活细节','城市漫步计划 · 在周末重新发现生活','十月书单｜留一点时间给自己'][i],url:'https://www.xiaohongshu.com/explore/a'+String(i+1).padStart(23,'0'),publishedAt:new Date(Date.now()-3600000*(i+1)).toISOString()}];
 Object.assign(m,{initialized:true,identityVerified:true,coverageVerified:true,seen:m.notes.map(n=>n.id),status:i===3?'network_error':'ok',message:i===3?'网络请求失败，已保留最近成功数据。':'检测成功',lastSuccess:new Date(Date.now()-60000*(i+2)).toISOString(),lastAttempt:new Date().toISOString(),enabled:i!==2});
 if(i===1)m.settings={baseMinutes:20,jitterMinutes:5};
 if(i<2)store.state.updates.push({...m.notes[0],eventId:'demo-event-'+i,userId:id,author:m.name,discoveredAt:new Date(Date.now()-60000*(i+1)).toISOString(),read:i===1,ackAt:new Date().toISOString()});
}
store.commit();
const r=cp.spawnSync(path.resolve('node_modules/electron/dist/electron.exe'),[path.resolve('scripts/verify-product-ui-child.cjs')],{env:{...process.env,XHS_MONITOR_DATA:data,XHS_MONITOR_PROFILE:path.join(run,'profile'),XHS_MONITOR_INSTANCE_SCOPE:run},windowsHide:true,encoding:'utf8',timeout:90000});
console.log(r.stdout||'');if(r.status!==0)console.error(r.stderr||r.error||r.status);process.exitCode=r.status===0?0:1;
