'use strict';
// Motion follows state changes. Routine snapshots and countdown ticks stay quiet.
(() => {
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const metricValues=new Map();let previousRows='',firstRender=true;
 const active=new WeakMap();
 function animate(node,frames,options={}){
  if(!node||reduced.matches)return null;
  active.get(node)?.cancel();
  const animation=node.animate(frames,{duration:230,easing:'cubic-bezier(.2,.75,.25,1)',...options});
  active.set(node,animation);animation.finished.catch(()=>{});return animation;
 }
 function page(node){animate(node,[{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],{duration:260});}
 function render(state){
  const ids=[...document.querySelectorAll('#authors tr')].map(row=>row.dataset.authorId).join(',');
  if(ids!==previousRows){document.querySelectorAll('#authors tr').forEach((row,index)=>animate(row,[{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:190,delay:Math.min(index,7)*24}));previousRows=ids;}
  for(const id of ['total','enabled','unread','pending-count']){const node=document.getElementById(id),value=node.textContent;if(!firstRender&&metricValues.get(id)!==value)animate(node,[{opacity:.4,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}]);metricValues.set(id,value);}
  const checking=!!state.active||state.queued?.length>0;
  const all=document.getElementById('check-all');all.classList.toggle('is-loading',checking);all.setAttribute('aria-busy',String(checking));all.disabled=checking;all.title=checking?'正在按顺序检测，结果会自动更新':'立即检测所有启用的博主';
  document.querySelectorAll('#authors tr').forEach(row=>{const monitor=state.monitors.find(m=>m.id===row.dataset.authorId);const busy=monitor?.status==='checking'||state.queued?.includes(monitor?.id);row.classList.toggle('is-checking',!!busy);const check=row.querySelector('.actions button');check.disabled=!!busy||!monitor?.enabled;check.classList.toggle('is-loading',!!busy);check.setAttribute('aria-busy',String(!!busy));if(busy)check.textContent='检测中';});
  firstRender=false;
 }
 document.addEventListener('click',event=>{
  const b=event.target.closest('button,[role=button]');if(!b||b.disabled)return;
  const svg=b.querySelector('.icon');if(svg&&!b.classList.contains('is-loading'))animate(svg,[{transform:'scale(.84)'},{transform:'scale(1)'}],{duration:180});
 },true);
 document.querySelectorAll('.metric').forEach((metric,index)=>{
  metric.setAttribute('role','button');metric.tabIndex=0;metric.title=['查看全部监控博主','查看正在监控的博主','查看未读更新','查看待确认提醒'][index];
  const activate=()=>{if(index===2)document.querySelector('[data-page=updates]').click();else if(index===3)document.querySelector('[data-page=alerts]').click();else{document.querySelector('[data-page=overview]').click();document.getElementById('author-filter').value='';document.querySelector('[data-filter='+ (index===1?'running':'all')+']').click();document.querySelector('.author-card').scrollIntoView({block:'nearest',behavior:reduced.matches?'instant':'smooth'});}};
  metric.addEventListener('click',activate);metric.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();activate();}});
 });
 const tabs=[document.getElementById('add-tab-link'),document.getElementById('add-tab-search')];tabs.forEach((tab,index)=>tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?0:event.key==='End'?1:1-index;if(!tabs[target].disabled){tabs[target].click();tabs[target].focus();}}}));
 reduced.addEventListener('change',()=>{if(reduced.matches)document.getAnimations().forEach(a=>a.cancel());});
 window.productMotion={render,page,animate};
})();
