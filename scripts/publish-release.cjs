'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {validate,renderRelease,formatPublishedAt,writeNotes}=require('./release-notes.cjs');
const REPO='/repos/qinrz2002/xhs-update-monitor';
async function publish(){
 const token=process.env.GH_TOKEN;if(!token)throw Error('缺少GitHub发布授权');
 const version=require('../package.json').version,tag='v'+version,history=validate(JSON.parse(fs.readFileSync('docs/releases.json','utf8')),version),entry=history.find(e=>e.version===version);
 if(process.env.GITHUB_REF_NAME&&process.env.GITHUB_REF_NAME!==tag)throw Error('标签与版本号不一致');
 const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'xhs-update-monitor-release',Authorization:'Bearer '+token};
 async function api(route,method='GET',body){const r=await fetch('https://api.github.com'+REPO+route,{method,headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(method+' '+route+' HTTP '+r.status);return r.json();}
 const listed=await api('/releases?per_page=100');let release=listed.find(r=>r.tag_name===tag);
 if(release&&!release.draft){console.log(JSON.stringify({alreadyPublished:true,url:release.html_url,publishedAt:release.published_at}));return;}
 const commit=cp.spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim();assert(/^[a-f0-9]{40}$/.test(commit));
 const remote=await api('/git/ref/heads/main');assert.equal(remote.object.sha,commit,'待发布源码必须已推送到main');
 const folder='release/installer',installer='XhsUpdateMonitor-Setup-'+version+'.exe',names=[installer,installer+'.blockmap','latest.yml'];
 const yaml=fs.readFileSync(path.join(folder,'latest.yml'),'utf8'),payload=fs.readFileSync(path.join(folder,installer));assert(yaml.includes('version: '+version));assert(yaml.includes(crypto.createHash('sha512').update(payload).digest('base64')));
 if(!release)release=await api('/releases','POST',{tag_name:tag,target_commitish:commit,name:'小红书更新监控 '+tag,body:renderRelease(entry),draft:true,prerelease:false});
 console.log(JSON.stringify({stage:'draft',tag,id:release.id}));
 for(const name of names){const bytes=fs.readFileSync(path.join(folder,name)),digest='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');let asset=(await api('/releases/'+release.id+'/assets')).find(a=>a.name===name);
  if(!asset){const url=new URL(release.upload_url.replace(/\{.*$/,''));assert.equal(url.hostname,'uploads.github.com');assert.equal(url.pathname,REPO+'/releases/'+release.id+'/assets');url.searchParams.set('name',name);const r=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)},body:bytes,signal:AbortSignal.timeout(240000)});if(!r.ok)throw Error('上传失败 HTTP '+r.status);asset=await r.json();}
  assert.equal(asset.size,bytes.length);assert.equal(asset.digest,digest);console.log(JSON.stringify({stage:'asset-verified',name,bytes:bytes.length}));
 }
 release=await api('/releases/'+release.id,'PATCH',{draft:false,prerelease:false,make_latest:'true'});
 assert(release.published_at&&Number.isFinite(Date.parse(release.published_at)));entry.publishedAt=release.published_at;
 release=await api('/releases/'+release.id,'PATCH',{body:renderRelease(entry)});
 // Keep prior release descriptions and the append-only version history dated.
 for(const old of listed.filter(r=>!r.draft&&!r.prerelease&&r.tag_name!==tag)){const record=history.find(e=>'v'+e.version===old.tag_name);if(record){record.publishedAt=old.published_at;const body=renderRelease(record);if(old.body!==body)await api('/releases/'+old.id,'PATCH',{body});}}
 writeNotes(history,version);
 const head=await api('/git/ref/heads/main'),parent=await api('/git/commits/'+head.object.sha),files=['CHANGELOG.md','docs/releases.json','docs/RELEASE_NOTES.md'],tree=[];
 for(const file of files){const bytes=fs.readFileSync(file),blob=await api('/git/blobs','POST',{content:bytes.toString('base64'),encoding:'base64'});tree.push({path:file,mode:'100644',type:'blob',sha:blob.sha});}
 const nextTree=await api('/git/trees','POST',{base_tree:parent.tree.sha,tree}),next=await api('/git/commits','POST',{message:'docs: 记录 '+tag+' 实际发布时间与更新内容',tree:nextTree.sha,parents:[head.object.sha]});
 await api('/git/refs/heads/main','PATCH',{sha:next.sha,force:false});
 const latest=await api('/releases/latest');assert.equal(latest.tag_name,tag);assert(latest.body.includes(formatPublishedAt(latest.published_at)));assert(!latest.draft&&!latest.prerelease);
 const proof={passed:true,version,tag,url:latest.html_url,publishedAt:latest.published_at,sourceCommit:commit,historyCommit:next.sha,assets:latest.assets.map(a=>({name:a.name,size:a.size,digest:a.digest,url:a.browser_download_url})),releaseNotes:entry.changes,historyFiles:files};fs.writeFileSync(path.join(folder,'publication.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({stage:'published',...proof}));
}
if(require.main===module)publish().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={publish};
