'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),framework=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319'),metadata=path.join(process.env.SystemRoot,'System32/WinMetadata');
const refs=fs.readdirSync(metadata).filter(f=>f.endsWith('.winmd')).map(f=>'/reference:'+path.join(metadata,f));
const gac=path.join(process.env.SystemRoot,'Microsoft.NET/assembly/GAC_MSIL/System.Runtime');
const runtime=fs.readdirSync(gac).map(v=>path.join(gac,v,'System.Runtime.dll')).find(f=>fs.existsSync(f));if(!runtime)throw Error('Missing .NET System.Runtime facade');refs.push('/reference:'+runtime,'/reference:'+path.join(framework,'System.Runtime.WindowsRuntime.dll'));
const result=cp.spawnSync(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/utf8output',...refs,'/out:'+path.join(root,'src/notification-history.exe'),path.join(root,'scripts/NotificationHistory.cs')],{encoding:'utf8',windowsHide:true});
if(result.status!==0)throw Error(result.stdout+result.stderr);console.log(JSON.stringify({compiled:true}));
