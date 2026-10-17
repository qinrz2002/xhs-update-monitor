'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const files=fs.readdirSync(path.join(__dirname,'../test')).filter(f=>f.endsWith('.test.cjs')).map(f=>path.join(__dirname,'../test',f));
const result=spawnSync(process.execPath,['--test',...files],{encoding:'utf8',windowsHide:true});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
const evidence=path.resolve(__dirname,'../evidence');fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(evidence,'core-tests.txt'),(result.stdout||'')+(result.stderr||''));
fs.writeFileSync(path.join(evidence,'core-tests.json'),JSON.stringify({at:new Date().toISOString(),exitCode:result.status,files:files.map(f=>path.basename(f)),runtime:process.version},null,2)+'\n');
process.exitCode=result.status||0;
