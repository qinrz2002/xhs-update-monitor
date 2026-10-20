'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),path=require('node:path');
const {notificationIdentity,repairNotificationRegistration,APP_ID}=require('../src/notification-registration.cjs');
const {NotificationActivation,toastXml}=require('../src/notification-activation.cjs');
const {NativeNotifier}=require('../src/notifier.cjs');
const root=path.resolve('test-runs/notification-reg'),exe=path.join(root,'安装目录','小红书更新监控.exe'),programs=path.join(root,'Programs'),oldClsid='{819A653F-9BE8-4E01-9FBF-EB8BA2085CD0}';
function registrationFixture(entries={}){const files=new Map(Object.entries(entries)),writes=[],runs=[],set=[];return{files,writes,runs,set,app:{getPath:()=>root,setToastActivatorCLSID:id=>set.push(id)},io:{existsSync:file=>files.has(file),mkdirSync(){}},shell:{readShortcutLink:file=>files.get(file),writeShortcutLink:(file,operation,options)=>{files.set(file,{...options});writes.push({file,operation,options});return true;}},run:(...args)=>{runs.push(args);return{status:0};},directory:programs,executable:exe};}
test('production, development and isolated packaged checks have distinct stable identities and names',()=>{
 const prod=notificationIdentity({packaged:true,root,env:{}}),dev=notificationIdentity({packaged:false,root,env:{}}),testRun=notificationIdentity({packaged:true,root,env:{XHS_MONITOR_DATA:root}});
 assert.equal(prod.appId,APP_ID);assert(prod.native);assert(!dev.native&&!testRun.native);assert.equal(new Set([prod.appId,dev.appId,testRun.appId]).size,3);assert.equal(new Set([prod.name,dev.name,testRun.name]).size,3);assert.equal(new Set([prod.clsid,dev.clsid,testRun.clsid]).size,3);
 assert.deepEqual(dev,notificationIdentity({packaged:false,root,env:{}}));assert.notEqual(testRun.appId,notificationIdentity({packaged:true,root,env:{XHS_MONITOR_DATA:path.join(root,'another')}}).appId);
});
test('development and ordinary packaged tests never repair production shortcuts or COM registration',()=>{
 for(const identity of [notificationIdentity({packaged:false,root,env:{}}),notificationIdentity({packaged:true,root,env:{XHS_MONITOR_DATA:root}})]){const f=registrationFixture();const r=repairNotificationRegistration({...f,identity});assert.equal(r.enabled,false);assert.equal(f.writes.length,0);assert.equal(f.runs.length,0);}
});
test('new installed registration points at quoted packaged exe, with AUMID and stable CLSID',()=>{
 const f=registrationFixture(),identity=notificationIdentity({packaged:true,root,env:{}});const r=repairNotificationRegistration({...f,identity});assert(r.enabled);assert.equal(f.writes.length,1);assert.equal(f.writes[0].options.target,exe);assert.equal(f.writes[0].options.args,'');assert.equal(f.writes[0].options.appUserModelId,APP_ID);assert.equal(f.writes[0].options.toastActivatorClsid,identity.clsid);
 assert.deepEqual(f.runs[0][1],['add','HKCU\\Software\\Classes\\CLSID\\'+identity.clsid+'\\LocalServer32','/ve','/t','REG_SZ','/d','"'+exe+'"','/f']);assert.equal(f.runs[0][2].windowsHide,true);
});
test('legacy development launcher is repaired and existing toast CLSID retained for old notifications',()=>{
 const legacy=path.join(programs,'xhs-update-monitor.lnk'),f=registrationFixture({[legacy]:{target:path.join(root,'node_modules/electron/dist/electron.exe'),args:'',appUserModelId:APP_ID,toastActivatorClsid:oldClsid}}),identity=notificationIdentity({packaged:true,root,env:{}});
 repairNotificationRegistration({...f,identity});assert.equal(identity.clsid,oldClsid);assert.equal(f.writes.length,2);assert(f.writes.every(w=>w.options.target===exe&&w.options.toastActivatorClsid===oldClsid));assert.equal(f.files.get(legacy).target,exe);
});
test('a different app shortcut and malformed CLSID are never adopted or modified',()=>{
 const legacy=path.join(programs,'xhs-update-monitor.lnk'),f=registrationFixture({[legacy]:{target:'unrelated.exe',appUserModelId:'Other.App',toastActivatorClsid:oldClsid}}),identity=notificationIdentity({packaged:true,root,env:{}}),expected=identity.clsid;
 repairNotificationRegistration({...f,identity});assert.equal(f.writes.length,1);assert.equal(f.files.get(legacy).target,'unrelated.exe');assert.equal(identity.clsid,expected);
 const g=registrationFixture({[path.join(programs,identity.name+'.lnk')]:{appUserModelId:APP_ID,toastActivatorClsid:'bad\\registry-path'}});repairNotificationRegistration({...g,identity});assert.equal(identity.clsid,expected);
});
test('persisted activator survives installer recreating or removing shortcut properties on later upgrades',()=>{
 const identity=notificationIdentity({packaged:true,root,env:{}}),f=registrationFixture();repairNotificationRegistration({...f,identity,preferredClsid:oldClsid});assert.equal(identity.clsid,oldClsid);assert(f.writes.every(w=>w.options.toastActivatorClsid===oldClsid));
 const other='{11111111-2222-5333-A444-555555555555}',g=registrationFixture({[path.join(programs,identity.name+'.lnk')]:{appUserModelId:APP_ID,toastActivatorClsid:other}});repairNotificationRegistration({...g,identity,preferredClsid:oldClsid});assert.equal(identity.clsid,oldClsid);assert.equal(g.files.get(path.join(programs,identity.name+'.lnk')).toastActivatorClsid,oldClsid);
});
test('missing shortcut permissions, failed registry and bare Electron all fail closed',()=>{
 const identity=notificationIdentity({packaged:true,root,env:{}}),f=registrationFixture();assert.throws(()=>repairNotificationRegistration({...f,identity,executable:path.join(root,'electron.exe')}),/不能/);assert.equal(f.runs.length,0);
 assert.throws(()=>repairNotificationRegistration({...f,identity,shell:{...f.shell,writeShortcutLink:()=>false}}),/快捷方式/);
 assert.throws(()=>repairNotificationRegistration({...f,identity,run:()=>({status:1})}),/启动注册/);
});
test('explicit notification integration checks use a unique test identity instead of production',()=>{
 const identity=notificationIdentity({packaged:true,root,env:{XHS_MONITOR_DATA:root,XHS_MONITOR_TEST_NOTIFICATIONS:'1',XHS_MONITOR_TEST_NOTIFICATION_NAME:'测试abcde'}});assert(identity.native);assert(!identity.production);assert.notEqual(identity.appId,APP_ID);const f=registrationFixture();repairNotificationRegistration({...f,identity});assert(f.writes.every(w=>w.options.appUserModelId===identity.appId));
});
function activationFixture(){let records={},now=1000000,views=0;const ack=[];const router=new NotificationActivation({read:()=>records,save:r=>records=r,view:()=>views++,acknowledge:ids=>ack.push(ids),now:()=>now});return{router,ack,get records(){return records;},get views(){return views;},advance:ms=>now+=ms};}
test('cold-start click queues until store is ready and then opens updates once',()=>{
 const f=activationFixture(),token=f.router.remember(['old']);f.router.handle({type:'click',arguments:'xhs='+token+'&type=click'});assert.equal(f.views,0);f.router.start();assert.equal(f.views,1);f.router.start();assert.equal(f.views,1);assert.equal(f.ack.length,0);
});
test('view button opens updates; close button only acknowledges IDs captured by that toast',()=>{
 const f=activationFixture(),token=f.router.remember(['old']);f.router.start();f.router.remember(['old','new']);f.router.handle({type:'action',actionIndex:0,arguments:'xhs='+token});assert.equal(f.views,1);f.router.handle({type:'action',actionIndex:1,arguments:'xhs='+token});assert.equal(f.views,1);assert.deepEqual(f.ack,[['old']]);
});
test('saved activation routes survive process restart and keep newer reminders pending',()=>{
 const f=activationFixture(),token=f.router.remember(['before-restart']),snapshot=JSON.parse(JSON.stringify(f.records)),ack=[];let views=0;
 const next=new NotificationActivation({read:()=>snapshot,save:()=>{},view:()=>views++,acknowledge:ids=>ack.push(ids),now:()=>1000000});next.start();next.handle({type:'action',actionIndex:1,arguments:'xhs='+token});assert.deepEqual(ack,[['before-restart']]);assert.equal(views,0);
});
test('legacy view remains supported, but unknown, expired or token-less close never clears current updates',()=>{
 const f=activationFixture(),token=f.router.remember(['old']);f.router.start();f.router.handle({type:'click',arguments:'type=click&tag=legacy'});f.router.handle({type:'action',actionIndex:0,arguments:'type=action&action=0&tag=legacy'});assert.equal(f.views,2);
 for(const args of ['','xhs=invalid','xhs=00000000-0000-0000-0000-000000000000'])f.router.handle({type:'action',actionIndex:1,arguments:args});f.advance(31*86400000);f.router.handle({type:'action',actionIndex:1,arguments:'xhs='+token});assert.equal(f.ack.length,0);
});
test('activation route retention is bounded and XML text is escaped without changing actions',()=>{
 const f=activationFixture();for(let i=0;i<250;i++)f.router.remember(['id'+i]);assert.equal(Object.keys(f.records).length,200);
 const token=Object.keys(f.records)[0],xml=toastXml('<标题 & "引用">','内容 </text><script>unsafe</script>',token);assert(xml.includes('&lt;标题 &amp; &quot;引用&quot;&gt;'));assert(!xml.includes('<script>'));assert(xml.includes('xhs='+token+'&amp;type=click'));assert(xml.includes('type=action&amp;action=0'));assert(xml.includes('type=action&amp;action=1'));
});
class FakeNotification extends EventEmitter {static isSupported(){return true;}constructor(options){super();this.options=options;FakeNotification.last=this;}show(){}close(){}}
test('global activation and instance events do not perform duplicate view or dismiss actions',()=>{
 const f=activationFixture();f.router.start();const notifier=new NativeNotifier(FakeNotification,{activation:f.router,view:()=>assert.fail('instance callback duplicated'),acknowledge:()=>assert.fail('instance action duplicated')});
 notifier.show([{eventId:'id',title:'文章',author:'作者'}]);const n=FakeNotification.last;assert(n.options.toastXml);n.emit('click');n.emit('action',{actionIndex:0});n.emit('action',{actionIndex:1});assert.equal(f.views,0);assert.equal(f.ack.length,0);
 const token=Object.keys(f.records)[0];f.router.handle({type:'click',arguments:'xhs='+token});assert.equal(f.views,1);
});
test('disabled native notifications never instantiate Electron notification APIs',()=>{
 const notifier=new NativeNotifier({isSupported(){assert.fail('must not register native presenter');}},{enabled:false,view(){},acknowledge(){}});notifier.show([{eventId:'id'}]);assert.equal(notifier.current,null);
});
