'use strict';
const fs=require('node:fs');
const DISCLAIMER='**免责声明：仅供学习、技术交流与研究使用，请勿用于任何非法用途。** 请遵守适用法律法规和平台规则，尊重隐私及其他合法权益。本项目与小红书官方没有关联，完整声明见 [DISCLAIMER.md](https://github.com/qinrz2002/xhs-update-monitor/blob/main/DISCLAIMER.md)。';
function formatPublishedAt(value){
 if(!value)return '正式发布后自动记录';
 if(!Number.isFinite(Date.parse(value)))throw Error('发布时间格式无效');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
 return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（北京时间 UTC+08:00）`;
}
function validate(history,version){
 if(!Array.isArray(history)||!history.length)throw Error('缺少版本更新记录');const seen=new Set();
 for(const entry of history){if(!/^\d+\.\d+\.\d+$/.test(entry.version)||seen.has(entry.version))throw Error('版本号无效或重复');seen.add(entry.version);if(!Array.isArray(entry.changes)||!entry.changes.length||entry.changes.some(s=>typeof s!=='string'||!s.trim()||s.length>1000))throw Error('每次发布必须填写更新内容');if(entry.publishedAt!==null&&!Number.isFinite(Date.parse(entry.publishedAt)))throw Error('发布时间无效');}
 if(version&&!seen.has(version))throw Error('当前版本尚未填写更新内容：'+version);
 return history;
}
function renderRelease(entry){
 return `# 小红书更新监控 v${entry.version}\n\n发布时间：${formatPublishedAt(entry.publishedAt)}\n\n## 本次更新\n\n${entry.changes.map(s=>'- '+s).join('\n')}\n\n## 安装与更新\n\n下载并运行 \`XhsUpdateMonitor-Setup-${entry.version}.exe\`。\`latest.yml\` 和 \`.blockmap\` 用于软件自动更新，无需手动打开。升级保留程序旁的 data 文件夹；建议更新前备份。\n\n${DISCLAIMER}\n`;
}
function renderChangelog(history){return '# 更新日志\n\n按版本记录更新内容，发布时间以 GitHub 正式 Release 的实际发布时间为准，统一显示北京时间。\n\n'+history.map(entry=>`## [v${entry.version}](https://github.com/qinrz2002/xhs-update-monitor/releases/tag/v${entry.version})\n\n发布时间：${formatPublishedAt(entry.publishedAt)}\n\n${entry.changes.map(s=>'- '+s).join('\n')}`).join('\n\n')+'\n';}
function writeNotes(history,version){validate(history,version);fs.writeFileSync('docs/releases.json',JSON.stringify(history,null,2)+'\n');fs.writeFileSync('CHANGELOG.md',renderChangelog(history));fs.writeFileSync('docs/RELEASE_NOTES.md',renderRelease(history.find(e=>e.version===version)));}
if(require.main===module){const version=require('../package.json').version,history=validate(JSON.parse(fs.readFileSync('docs/releases.json','utf8')),version);if(!process.argv.includes('--check'))writeNotes(history,version);console.log(JSON.stringify({version,releaseNotesChecked:true,versions:history.length}));}
module.exports={validate,formatPublishedAt,renderRelease,renderChangelog,writeNotes};
