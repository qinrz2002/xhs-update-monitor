'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const net=require('node:net'),{createHash}=require('node:crypto');
function dataLocation(appData,root,env=process.env){
 const locator=env.XHS_MONITOR_DATA||env.XHS_MONITOR_PROFILE?null:path.join(appData,'XhsUpdateMonitor','data-location.json');
 const data=path.resolve(env.XHS_MONITOR_DATA||path.join(root,'data'));
 // Import legacy saved files once. Subsequent runs always use this executable's data folder.
 if(locator&&!fs.existsSync(path.join(data,'state.json'))&&fs.existsSync(locator)){
  const source=JSON.parse(fs.readFileSync(locator,'utf8')).directory;
  if(typeof source!=='string'||!path.isAbsolute(source)||!fs.existsSync(source))throw new Error('旧数据目录不可用，请恢复原目录后重试。');
  if(path.resolve(source)!==data){
   const allowed=['state.json','state.json.bak','session.enc','desktop-profile/Local State'];
   for(const name of allowed){const a=path.join(source,name),b=path.join(data,name);if(!fs.existsSync(a))continue;fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b);if(!fs.readFileSync(a).equals(fs.readFileSync(b)))throw new Error('旧数据迁移校验失败，原目录已保留。');}
  }
 }
 return{data,locator};
}
function instancePaths(app,root,env=process.env){
 const {data,locator}=dataLocation(app.getPath('appData'),root,env);
 const profile=path.resolve(env.XHS_MONITOR_PROFILE||path.join(data,'desktop-profile'));
 const scope=env.XHS_MONITOR_INSTANCE_SCOPE||(env.XHS_MONITOR_PROFILE?profile:app.getPath('appData'));
 const pipe='\\\\.\\pipe\\XhsUpdateMonitor-'+createHash('sha256').update(scope.toLowerCase()).digest('hex').slice(0,32);
 app.setName('xhs-update-monitor');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
 return{profile,data,pipe,locator};
}
function bindDataLocation(locator,data){if(!locator)return;fs.mkdirSync(path.dirname(locator),{recursive:true});const temp=locator+'.tmp';fs.writeFileSync(temp,JSON.stringify({directory:data})+'\n');fs.renameSync(temp,locator);}
function restoreWindow(win){
 if(!win||win.isDestroyed())return false;
 if(win.isMinimized())win.restore();win.show();win.focus();return true;
}
function legacyLocations(root){
 const locations=[path.join(root,'data')];
 const containers=[path.join(root,'release'),path.resolve(root,'../../..')];
 for(const container of containers){
  if(path.basename(container)!=='release'||!fs.existsSync(container))continue;
  for(const entry of fs.readdirSync(container,{withFileTypes:true}))if(entry.isDirectory()&&/^小红书更新监控-\d+\.\d+\.\d+-win-x64$/.test(entry.name))locations.push(path.join(container,entry.name,'resources/app/data'));
 }
 return[...new Set(locations.map(p=>path.resolve(p)))];
}
function acquireSharedInstance(pipe,activate,{shutdownForUpdate}={}){
 return new Promise((resolve,reject)=>{
  let attempts=0;
  function listen(){
   const server=net.createServer(socket=>{
    let input='',handled=false;socket.setEncoding('utf8');socket.setTimeout(3000,()=>socket.destroy());socket.on('error',()=>{});
    socket.on('data',part=>{input+=part;if(input.length>64){socket.destroy();return;}if(!handled&&input.includes('\n')){handled=true;if(input.trim()==='activate'){activate();socket.end('ok\n');}else if(input.trim()==='shutdown-for-update'&&shutdownForUpdate){socket.end('shutting-down\n',()=>{void Promise.resolve().then(shutdownForUpdate).catch(()=>{});});}else socket.destroy();}});
   });
   server.once('error',error=>{
    if(!['EADDRINUSE','EACCES'].includes(error.code)){reject(error);return;}
    const socket=net.createConnection(pipe);let settled=false,reply='';
    const fail=error=>{if(settled)return;settled=true;socket.destroy();if(['ENOENT','ECONNREFUSED','EPIPE'].includes(error.code)&&attempts++<3)setTimeout(listen,50);else reject(new Error('无法与已有监控实例通信，未打开重复窗口。'));};
    socket.setTimeout(5000,()=>fail({code:'TIMEOUT'}));socket.once('error',fail);
    socket.once('end',()=>{if(!settled)fail({code:'EPIPE'});});
    socket.once('connect',()=>socket.write('activate\n'));socket.on('data',data=>{reply+=data.toString();if(!settled&&reply.includes('\n')){if(reply.trim()==='ok'){settled=true;socket.destroy();resolve({owner:false,server:null});}else fail({code:'INVALID_ACK'});}});
   });
   server.listen(pipe,()=>resolve({owner:true,server}));
  }
  listen();
 });
}
function runningLegacyInstance(root){
 const registrationFile=path.join(__dirname,'legacy-instances.json');const registered=fs.existsSync(registrationFile)?JSON.parse(fs.readFileSync(registrationFile,'utf8')):[];if(!registered.length)return null;
 const allowed=new Set(legacyLocations(root).filter(dir=>fs.existsSync(path.join(dir,'state.json'))||fs.existsSync(path.join(dir,'session.enc'))).map(dir=>path.resolve(dir,'../../..','小红书更新监控.exe').toLowerCase()));
 if(!allowed.size)return null;
 const helper=path.join(__dirname,'instance-probe.exe');if(!fs.existsSync(helper))throw new Error('缺少实例检测助手，未继续打开重复程序。');
 const result=spawnSync(helper,[String(process.pid)],{encoding:'utf8',windowsHide:true,timeout:10000});
 if(result.status!==0)throw new Error('无法确认旧版监控程序是否正在运行，请保留现有窗口。');
 for(const line of result.stdout.trim().split(/\r?\n/)){const [pid,started,encoded]=line.split('\t');if(!encoded||!registered.some(item=>item.pid===Number(pid)&&item.startedAtMs===Number(started)))continue;const executable=Buffer.from(encoded,'base64').toString('utf8');if(allowed.has(path.resolve(executable).toLowerCase()))return{pid:Number(pid),executable};}
 return null;
}
function launchActivation(executable,args){const child=spawn(executable,args,{detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();return Boolean(child.pid);}
module.exports={dataLocation,instancePaths,bindDataLocation,restoreWindow,legacyLocations,acquireSharedInstance,runningLegacyInstance,launchActivation};
