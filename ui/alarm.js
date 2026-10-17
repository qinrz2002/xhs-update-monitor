'use strict';
let shownIds=[];
const audio=document.getElementById('audio');audio.volume=.5;
function render(state){document.documentElement.dataset.theme=state.config.theme;document.body.hidden=false;shownIds=state.pending.map(u=>u.eventId);document.getElementById('title').textContent=state.pending.some(u=>u.test)?'测试提醒':'发现 '+shownIds.length+' 篇新笔记';document.getElementById('authors').textContent=[...new Set(state.pending.map(u=>u.author))].join('、')+' 有更新';document.getElementById('detail').textContent=state.pending[0]?.title||'';
if(state.config.sound&&shownIds.length){if(audio.paused)audio.play().then(()=>{document.getElementById('audio-state').textContent='♫ 提示音循环中'}).catch(()=>{document.getElementById('audio-state').textContent='声音未能播放，请检查音频设备。'});}else{audio.pause();document.getElementById('audio-state').textContent='提示音已关闭';}}
function dismiss(){void window.monitor.call('ack',[...shownIds]);}
window.monitor.onDismiss(dismiss);
document.getElementById('dismiss').onclick=dismiss;document.getElementById('dismiss-x').onclick=dismiss;document.getElementById('view').onclick=()=>{void window.monitor.call('view')};window.monitor.subscribe(render);void window.monitor.call('snapshot').then(r=>{if(r.ok)render(r.state)});
