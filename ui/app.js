'use strict';
let snapshot, page = 'overview', filter = 'all', deleting = null, messageTimer, intervalDirty = false, highlightedAuthor = null, locateOnRender = false, listingAuthor = null, articleRequest = 0;
const $ = id => document.getElementById(id);
const statusLabels = { pending:'待检测',checking:'检测中',ok:'正常',preview_only:'仅预览',verifying_identity:'核验标识',identity_unstable:'标识不稳定',incomplete:'数据不完整',login_required:'需要登录',verification_required:'需要验证',account_restricted:'账号受限',client_restricted:'客户端受限',network_error:'网络异常',http_error:'访问失败',parse_error:'解析失败',rate_limited:'等待限流',wrong_profile:'身份不匹配' };
const loginLabels = {unknown:'待验证',not_logged_in:'未登录',unverified:'待验证',logged_in:'已登录',waiting_scan:'等待扫码',verifying:'HTTP 验证中',verification_waiting:'验证排队中',verification_deferred:'等待验证',verification_timeout:'验证超时',expired:'登录失效',verification_required:'需要安全验证',account_restricted:'账号受限',client_restricted:'客户端受限',network_error:'网络异常',http_not_verified:'HTTP 未通过',login_cancelled:'登录已取消',session_unavailable:'会话不可用'};
statusLabels.profile_updated='资料已刷新';
function el(tag, text, cls) {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
function labeled(node,name,text){if(node.dataset.labelIcon===name&&node.textContent===text)return;node.dataset.labelIcon=name;node.replaceChildren(icon(name),document.createTextNode(text));}
function time(value, date=false){if(!value)return '—';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(date?{month:'2-digit',day:'2-digit'}:{}),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));}
async function call(action,value){const result=await window.monitor.call(action,value);if(!result.ok){message(result.error);throw new Error(result.error)}if(result.state)render(result.state);return result;}
function hideMessage(){clearTimeout(messageTimer);const toast=$('message');if(toast.matches(':popover-open'))toast.hidePopover();toast.hidden=true;}
function message(text, undo){
 clearTimeout(messageTimer);const toast=$('message');toast.replaceChildren(el('span',text,'message-copy'));
 if(undo){const b=el('button','撤销删除','message-undo');b.onclick=()=>{void call('undo',undo).catch(()=>{});hideMessage();};toast.append(b);}
 const close=el('button','×','message-close');close.type='button';close.setAttribute('aria-label','关闭提示');close.title='关闭提示';close.onclick=hideMessage;toast.append(close);
 if(toast.matches(':popover-open'))toast.hidePopover();
 const host=document.querySelector('dialog:modal')||document.body;if(toast.parentElement!==host)host.append(toast);
 toast.hidden=false;toast.showPopover();messageTimer=setTimeout(hideMessage,10000);
}
document.addEventListener('close',event=>{const toast=$('message');if(event.target.tagName==='DIALOG'&&event.target.contains(toast)){if(toast.matches(':popover-open'))toast.hidePopover();document.body.append(toast);if(!toast.hidden)toast.showPopover();}},true);
function navigate(value){const changed=page!==value;page=value;for(const id of ['overview','updates','alerts','settings','about'])$(id).hidden=id!==page;document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('selected',b.dataset.page===page));$('breadcrumb-page').textContent={overview:'监控总览',updates:'更新记录',alerts:'提醒中心',settings:'设置',about:'关于与更新'}[page];$('page-title').textContent={overview:'监控总览',updates:'更新记录',alerts:'提醒中心',settings:'设置',about:'关于与更新'}[page];if(changed){window.scrollTo({top:0,behavior:'instant'});window.productMotion?.page($(page));}}
function button(text,action){const b=el('button',text);b.onclick=()=>{Promise.resolve().then(action).catch(()=>{})};return b;}
function render(state){snapshot=state;document.documentElement.dataset.theme=state.config.theme;document.body.hidden=false;
 for(const t of ['light','dark'])$(t).classList.toggle('active',t===state.config.theme);
 $('login').textContent=loginLabels[state.login]||state.login;$('login').className='pill '+(state.login==='logged_in'?'ok':'');
 $('account-name').hidden=!state.account;$('account-name').textContent=state.account?.name||'账号信息待获取';$('account-name').title=state.account?.name||'打开主页可读取当前登录账号信息';
 labeled($('run'),state.config.running?'pause':'play',state.config.running?'暂停监控':'开始监控');
 $('account-label').textContent=state.account?.name||(state.login==='logged_in'?'已登录':'连接账号');
 $('account-trigger').title=state.loginDetails?.message||(loginLabels[state.login]||state.login);$('account-status').textContent=loginLabels[state.login]||state.login;$('account-status').className='account-status '+(state.login==='logged_in'?'connected':'');
 let detail=$('login-detail');if(!detail){detail=el('p',undefined,'login-detail');detail.id='login-detail';detail.setAttribute('role','status');$('account-actions').insertBefore(detail,$('verify'));}detail.textContent=(state.loginDetails?.message||'')+(state.loginDetails?.retryAt?' 可重试时间：'+time(state.loginDetails.retryAt):'');detail.hidden=!detail.textContent;
 $('today-label').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(new Date());
 const running=state.config.running&&!state.sessionBlocked;
 $('run-label').textContent=state.sessionBlocked?'等待账号验证':running?'监控正在运行':'监控已暂停';
 $('run-indicator').classList.toggle('running',running);$('run-indicator').classList.toggle('blocked',state.sessionBlocked);
 $('health-tag').textContent=state.sessionBlocked?'需要处理':running?'自动守候':'手动检测可用';
 $('schedule-summary').textContent=state.config.baseMinutes+' ± '+state.config.jitterMinutes+' 分钟';
 $('notification-summary').textContent=[state.config.notifications?'Windows 弹窗':null,state.config.sound?'循环提示音':null].filter(Boolean).join(' / ')||'应用内提醒';
 $('summary-text').textContent=state.sessionBlocked?(['account_restricted','client_restricted'].includes(state.login)?'平台访问受限 · 采集已暂停，请在官方页面确认状态':'采集已暂停，等待重新登录或完成验证'):state.config.running?'监控运行中 · 请求按独立随机计划执行':'监控已暂停 · 可手动检测';
 const unread=state.updates.filter(u=>!u.read).length;
 $('total').textContent=state.monitors.length;$('enabled').textContent=state.config.running&&!state.sessionBlocked?state.monitors.filter(m=>m.enabled).length:0;
 $('unread').textContent=unread;$('unread-badge').textContent=unread;$('unread-badge').hidden=unread===0;$('pending-count').textContent=state.pending.length;$('alert-badge').textContent=state.pending.length;$('alert-badge').hidden=state.pending.length===0;
 if(!intervalDirty){$('base').value=state.config.baseMinutes;$('jitter').value=state.config.jitterMinutes;}
 updateRange();for(const [id,key] of [['notifications','notifications'],['sound','sound'],['auto-login','autoLogin']])$(id).checked=state.config[key];
 $('stop-alarm').hidden=!state.pending.length;
 const dataDirectory=$('data-directory');if(dataDirectory)dataDirectory.textContent=state.dataDirectory||'应用 data 目录';
 const nativeStatus=$('native-status');if(nativeStatus)nativeStatus.textContent=!state.config.notifications?'Windows 弹窗已关闭':state.notificationSupported===false?'系统弹窗不可用，使用应用提醒窗口':state.notificationStatus==='failed'?'系统弹窗未能显示；应用提醒窗口仍保留':state.notificationStatus==='shown'?'系统已报告弹窗展示；勿扰等设置可能影响可见性':'系统弹窗将在有新文章时触发';
 const body=$('authors');body.replaceChildren();
 const query=$('author-filter').value.trim().toLocaleLowerCase();
 const rows=state.monitors.filter(m=>(filter==='paused'?!m.enabled:filter==='new'?state.updates.some(u=>u.userId===m.id&&!u.read):filter==='running'?m.enabled&&state.config.running&&!state.sessionBlocked:true)&&(!query||(m.name+' '+m.id).toLocaleLowerCase().includes(query)));
 $('authors-count').textContent=state.monitors.length+' 位';$('list-summary').textContent=rows.length===state.monitors.length?'共 '+rows.length+' 位博主':'显示 '+rows.length+' / '+state.monitors.length+' 位博主';
 const emptyList=state.monitors.length===0;
 $('empty-title').textContent=emptyList?'从一位你关心的创作者开始':'没有找到符合条件的博主';
 $('empty-copy').textContent=emptyList?'添加博主主页，或通过名字搜索，确认后即可开始关注。':'试试其他名称，或切换列表筛选条件。';
 $('empty-add-author').hidden=!emptyList;
 for(const m of rows){const tr=el('tr'),author=el('td'),wrap=el('div',undefined,'author');tr.dataset.authorId=m.id;tr.classList.toggle('located',m.id===highlightedAuthor);const placeholder=el('span',undefined,'avatar-placeholder');placeholder.append(icon('user'));placeholder.title='头像尚未读取';wrap.append(placeholder);if(m.avatar){const img=el('img');img.className='author-avatar';img.alt=m.name+'的头像';img.referrerPolicy='no-referrer';img.src=m.avatar;placeholder.hidden=true;img.onerror=()=>{img.hidden=true;placeholder.hidden=false;};wrap.append(img);}const meta=el('div',undefined,'author-meta');meta.append(el('strong',m.name));const settings=m.settings||state.config;meta.append(el('span',(m.settings?'独立 ':'全局 ')+settings.baseMinutes+'±'+settings.jitterMinutes+' 分钟','detail'));wrap.append(meta);author.append(wrap);author.title=m.url;
 const note=el('td'),latest=m.previewNotes?.[0]||m.notes[0]||m.candidate?.notes?.[0];note.append(el('span',latest?.title||'尚无可靠采集结果','note-title'),el('span',(!m.notes.length&&latest?'主页采样 · ':'')+(m.message||'等待有效登录和采集验证'),'detail'));
 const status=el('td');status.append(el('span',m.enabled?(statusLabels[m.status]||m.status):'已暂停','pill '+(!m.enabled?'':m.status==='ok'?'ok':m.status.includes('error')?'error':'')));
 const last=el('td',time(m.lastSuccess));last.title='最近尝试：'+time(m.lastAttempt,true);const scheduled=m.enabled&&state.config.running&&!state.sessionBlocked;const next=el('td',scheduled?time(m.nextDue):!m.enabled?'已暂停':state.sessionBlocked?'等待验证':'等待恢复');next.dataset.due=scheduled&&m.nextDue?m.nextDue:'';const remain=el('span',scheduled?'':'恢复监控后重新安排','detail');if(scheduled)remain.dataset.countdown=m.nextDue||'';next.append(remain);if(m.delaySeconds)next.title='本轮随机间隔：'+Math.floor(m.delaySeconds/60)+'分'+m.delaySeconds%60+'秒';
 const actions=el('td'),group=el('div',undefined,'actions');const check=button('检测',()=>call('check',m.id));check.title='立即检测 '+m.name;const articles=button('文章',()=>openArticles(m.id));articles.title='查看 '+m.name+' 的文章';const more=button('',()=>openAuthorMenu(m,more));more.className='row-more';more.append(icon('more'));more.setAttribute('aria-label',m.name+' 的更多操作');more.title='更多操作';group.append(check,articles,more);actions.append(group);tr.append(author,note,status,last,next,actions);body.append(tr);}
 $('empty').hidden=rows.length>0;
 if(locateOnRender){const target=[...body.rows].find(row=>row.dataset.authorId===highlightedAuthor);if(target){target.scrollIntoView({block:'nearest'});locateOnRender=false;}}
 renderUpdates($('updates-list'),state.updates.toReversed(),true);renderUpdates($('recent'),state.updates.toReversed().slice(0,5),false);renderUpdates($('alerts-list'),state.pending,false);
 renderSoftwareUpdate(state);tick();window.productMotion?.render(state);
}
function renderUpdates(container,updates,controls){container.replaceChildren();if(!updates.length){const empty=el('div',undefined,'empty-updates');empty.append(icon(container.id==='alerts-list'?'bell':'updates'));const copy=el('div');copy.append(el('strong',container.id==='alerts-list'?'暂无待确认提醒':'暂时没有新的动态'),el('p',container.id==='alerts-list'?'有新文章时，会按照你的设置提醒。':'首次可靠检测会建立基线，之后发现的新文章会出现在这里。'));empty.append(copy);container.append(empty);return;}
for(const u of updates){const row=el('div',undefined,'row '+(!u.read?'unread':'')),copy=el('div',undefined,'copy');copy.append(el('strong',u.title),el('p',u.author+' · 发现 '+time(u.discoveredAt,true)+' · 发布 '+(u.publishedAt?time(u.publishedAt,true):'未知')));row.append(copy);if(controls){if(u.url)row.append(button('查看笔记',()=>call('open-note',u.eventId)));if(!u.read)row.append(button('标为已读',()=>call('read',u.eventId)));}if(container.id==='recent'&&u.url)row.append(button('查看',()=>call('open-note',u.eventId)));container.append(row);}}
function tick(){document.querySelectorAll('[data-countdown]').forEach(n=>{if(!n.dataset.countdown){n.textContent='';return}const sec=Math.ceil((Number(n.dataset.countdown)-Date.now())/1000);n.textContent=sec>0?'剩余 '+String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'):'已到期 · 排队/暂停中';});}
function updateRange(){const b=Number($('base').value),j=Number($('jitter').value);$('range').textContent=(b-j)+'～'+(b+j)+' 分钟';}
function locateAuthor(id){$('author-filter').value='';highlightedAuthor=id;locateOnRender=true;filter='all';document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter==='all'));navigate('overview');if(snapshot)render(snapshot);}
$('authors').addEventListener('click',event=>{if(!event.target.closest('tr[data-author-id]'))return;highlightedAuthor=null;locateOnRender=false;for(const row of $('authors').querySelectorAll('tr.located'))row.classList.remove('located');});
let editingAuthor;
function authorRange(){const global=$('author-global').checked;$('author-custom').disabled=global;const b=global?snapshot.config.baseMinutes:Number($('author-base').value),j=global?snapshot.config.jitterMinutes:Number($('author-jitter').value);$('author-range').textContent='实际随机范围：'+(b-j)+'～'+(b+j)+' 分钟';}
function perAuthor(m){editingAuthor=m.id;$('author-settings-title').textContent=m.name+' · 博主设置';$('author-url').value=m.url;$('author-global').checked=!m.settings;$('author-base').value=m.settings?.baseMinutes??snapshot.config.baseMinutes;$('author-jitter').value=m.settings?.jitterMinutes??snapshot.config.jitterMinutes;$('author-settings-error').hidden=true;authorRange();$('author-settings').showModal();}
$('author-global').onchange=authorRange;$('author-base').oninput=authorRange;$('author-jitter').oninput=authorRange;
$('cancel-author-settings').onclick=()=>$('author-settings').close();
$('author-settings-form').onsubmit=async event=>{event.preventDefault();const settings=$('author-global').checked?null:{baseMinutes:Number($('author-base').value),jitterMinutes:Number($('author-jitter').value)};if(settings&&(!Number.isFinite(settings.baseMinutes)||!Number.isFinite(settings.jitterMinutes)||settings.jitterMinutes<0||settings.baseMinutes-settings.jitterMinutes<1)){$('author-settings-error').textContent='实际最短间隔至少为1分钟，浮动不能为负数。';$('author-settings-error').hidden=false;return;}$('save-author-settings').disabled=true;try{const result=await call('update-author',{id:editingAuthor,url:$('author-url').value,settings});$('author-settings').close();locateAuthor(result.id);message(result.refreshQueued?'主页链接已保存，正在重新读取博主信息。':'主页链接已保存；当前登录或验证受限，资料将在恢复后读取。');}catch(error){$('author-settings-error').textContent=error.message;$('author-settings-error').hidden=false;}finally{$('save-author-settings').disabled=false;}};
async function openArticles(id){listingAuthor=id;const ticket=++articleRequest;$('article-dialog-title').textContent='博主文章列表';$('article-scope').textContent='正在读取已保存的文章…';$('article-list').replaceChildren();if(!$('article-dialog').open)$('article-dialog').showModal();try{const result=await call('author-articles',id);if(ticket!==articleRequest||!$('article-dialog').open)return;$('article-dialog-title').textContent=result.author.name+' · 文章列表';$('article-scope').textContent='已读取 '+result.notes.length+' 篇。'+(result.historyComplete?'已读取到主页笔记列表末尾，包含已保存的更新记录。':'主页源代码可能仅包含部分笔记，这不是全部历史文章。');if(!result.notes.length){$('article-list').append(el('p','尚未读取到文章，请在博主设置中保存并刷新资料。'));return;}for(const n of result.notes){const row=el('div',undefined,'article-row'),copy=el('div',undefined,'copy');copy.append(el('strong',n.title),el('p',(n.pinned?'置顶 · ':'')+'发布 '+(n.publishedAt?time(n.publishedAt,true):'未知')));if(n.url){const link=el('a',n.url,'article-link');link.href=n.url;link.onclick=event=>{event.preventDefault();void call('open-author-note',{userId:id,noteId:n.id}).catch(()=>{});};copy.append(link);row.append(copy,button('打开文章',()=>call('open-author-note',{userId:id,noteId:n.id})));}else{copy.append(el('p','链接暂不可用，请刷新资料'));row.append(copy);} $('article-list').append(row);}}catch(error){$('article-scope').textContent=error.message;}}
$('close-articles').onclick=()=>{$('article-dialog').close();listingAuthor=null;articleRequest++;};
$('open-home').onclick=()=>{void call('open-home').catch(()=>{});};
function settingsDrawer(open){const drawer=$('monitor-settings');if(open&&!drawer.open)drawer.showModal();else if(!open&&drawer.open)drawer.close();$('open-settings').setAttribute('aria-expanded',String(drawer.open));}
$('open-settings').onclick=()=>settingsDrawer(true);$('close-settings').onclick=()=>settingsDrawer(false);$('settings-shortcut').onclick=()=>settingsDrawer(true);document.querySelectorAll('[data-open-monitor-settings]').forEach(b=>b.onclick=()=>settingsDrawer(true));
$('monitor-settings').addEventListener('close',()=>{$('open-settings').setAttribute('aria-expanded','false');});
$('author-filter').oninput=()=>snapshot&&render(snapshot);
$('view-all-updates').onclick=()=>navigate('updates');
$('empty-add-author').onclick=()=>$('add-button').click();
$('account-actions').addEventListener('click',event=>{if(event.target.closest('button')&&$('account-actions').matches(':popover-open'))$('account-actions').hidePopover();});
function openAuthorMenu(m,anchor){
 const menu=$('author-actions');if(menu.matches(':popover-open'))menu.hidePopover();menu.replaceChildren(el('div',m.name,'menu-title'));
 const action=(name,text,fn,cls)=>{const b=button('',()=>{menu.hidePopover();return fn();});labeled(b,name,text);if(cls)b.className=cls;menu.append(b);};
 action(m.enabled?'pause':'play',m.enabled?'暂停监控':'恢复监控',()=>call('pause',{id:m.id,enabled:!m.enabled}));
 action('settings','博主设置',()=>perAuthor(m));
 action('close','移除博主',()=>{deleting=m;$('delete-name').textContent=m.name;$('confirm').showModal();},'delete');
 menu.showPopover();const rect=anchor.getBoundingClientRect();menu.style.left=Math.min(window.innerWidth-menu.offsetWidth-16,Math.max(16,rect.right-menu.offsetWidth))+'px';menu.style.top=Math.min(window.innerHeight-menu.offsetHeight-16,rect.bottom+6)+'px';
}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>navigate(b.dataset.page));document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));render(snapshot)});
for(const t of ['light','dark'])$(t).onclick=()=>{void call('config',{theme:t}).catch(()=>{});};
$('login-button').onclick=()=>{void call('login').catch(()=>{});};$('verify').onclick=async()=>{const b=$('verify');b.disabled=true;b.classList.add('is-loading');try{await call('verify');}catch{}finally{b.disabled=false;b.classList.remove('is-loading');}};$('run').onclick=()=>{void call('running',!snapshot.config.running).catch(()=>{});};$('check-all').onclick=()=>{void call('check').catch(()=>{});};
$('interval-form').onsubmit=event=>{event.preventDefault();void call('settings',{settings:{baseMinutes:Number($('base').value),jitterMinutes:Number($('jitter').value)}}).then(()=>{intervalDirty=false;message('检测间隔已保存，下一次时间已重新抽样。');}).catch(()=>{});};for(const id of ['base','jitter'])$(id).oninput=()=>{intervalDirty=true;updateRange();};
for(const [id,key]of [['notifications','notifications'],['sound','sound'],['auto-login','autoLogin']])$(id).onchange=()=>{void call('config',{[key]:$(id).checked}).catch(()=>{});};
$('test-alarm').onclick=()=>{void call('test-alarm').catch(()=>{});};for(const id of ['stop-alarm','ack-all'])$(id).onclick=()=>{void call('ack',snapshot.pending.map(u=>u.eventId)).catch(()=>{});};$('read-all').onclick=()=>{void call('read','all').catch(()=>{});};$('quit').onclick=()=>{void call('quit').catch(()=>{});};
$('cancel-delete').onclick=()=>$('confirm').close();$('confirm-delete').onclick=async()=>{const m=deleting;$('confirm').close();try{await call('remove',m.id);message('已移除 '+m.name,m.id);}catch{}};
function renderSoftwareUpdate(state){
 const u=state.softwareUpdate||{},version=state.appVersion||u.version||'未知';
 $('app-version').textContent='v'+version;$('about-version').textContent='v'+version;
 $('automatic-updates').checked=u.automatic!==false;
 const labels={idle:'等待检查',checking:'正在检查 GitHub 新版本…',available:'发现新版本 v'+u.latest+'，正在开始下载…',current:'当前已是最新正式版本',downloading:u.downloadPhase==='verifying'?'下载完成，正在校验安装包…':'正在下载 v'+u.latest+'：'+Math.floor(u.percent||0)+'%',ready:'v'+u.latest+' 下载完成，等待重启安装',installing:'正在准备安装，安装进度窗口即将打开…',error:u.error||'更新失败，请重试',installer_required:'安装 Setup 版本后启用自动更新'};
 $('update-status').textContent=labels[u.status]||'等待检查';$('update-progress').hidden=u.status!=='downloading';$('update-progress').value=u.percent||0;
 $('update-checked').textContent=u.checkedAt?'最近检查：'+time(u.checkedAt,true):'';
 $('install-update').hidden=u.status!=='ready';$('update-installer-note').hidden=u.status!=='installer_required';if(u.status==='installer_required')$('update-installer-note').textContent='请使用 Setup 安装版以启用自动更新。';
 $('check-update').hidden=u.status==='ready';
 $('check-update').disabled=['checking','available','downloading','ready','installing'].includes(u.status);
 renderReleaseDetails('about',u);
 renderUpdateNotice(u,version);
}
function releaseTime(value){if(!value||!Number.isFinite(Date.parse(value)))return '';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value))+'（北京时间）';}
function renderReleaseDetails(prefix,u){
 const section=$(prefix+'-release-details');section.hidden=!u.latest;
 $(prefix+'-release-heading').textContent=(u.latest?'v'+u.latest+' · ':'')+'更新内容';
 $(prefix+'-release-time').textContent=u.publishedAt?'发布时间：'+releaseTime(u.publishedAt):u.releaseInfoStatus==='loading'?'发布时间：正在读取…':'发布时间：暂未获取';
 $(prefix+'-release-notes').textContent=u.releaseNotes||(u.releaseInfoStatus==='loading'?'正在读取此版本的更新内容…':'此版本暂未提供可显示的更新说明。');
}
const updateNoticesSeen=new Set();let latestSoftwareUpdate=null,updateInstallPending=false;
function renderUpdateNotice(update,currentVersion){
 latestSoftwareUpdate={...update,currentVersion};
 if(update.status==='error')updateInstallPending=false;
 const installing=updateInstallPending||update.status==='installing';
 const available=!!update.latest&&update.latest!==currentVersion&&['available','downloading','ready','installing','error'].includes(update.status);
 $('software-update-badge').hidden=!available;
 $('software-update-badge').title=available?'发现新版本 v'+update.latest:'';
 const dialog=$('software-update-dialog');
 dialog.classList.toggle('is-installing',installing);dialog.setAttribute('aria-busy',String(installing));
 $('close-software-update').disabled=$('postpone-software-update').disabled=installing;
 $('software-update-prompt-title').textContent=installing?'正在准备更新，请稍候':'检测到新版本，是否更新？';
 if(dialog.open){
  renderReleaseDetails('prompt',update);
  $('software-update-version').textContent='当前版本 v'+currentVersion+' → 新版本 v'+update.latest;
  const ready=update.status==='ready',failed=update.status==='error',verifying=update.status==='downloading'&&update.downloadPhase==='verifying',percent=Math.floor(update.percent||0);
  $('software-update-prompt-status').textContent=installing?'正在保存数据并启动安装程序，安装进度窗口即将打开。完成后会自动打开新版，请勿重复操作。':ready?'新版已下载并校验完成。是否现在重启并更新？':failed?(update.error||'新版下载未完成，请前往软件更新查看。'):verifying?'下载完成，正在校验安装包，校验通过后即可重启更新。':'新版正在后台下载'+(update.status==='downloading'?'（'+percent+'%）':'')+'，完成后即可重启更新。';
  $('software-update-prompt-progress').hidden=!['available','downloading'].includes(update.status);$('software-update-prompt-progress').value=update.percent||0;
  $('confirm-software-update').disabled=installing||!ready&&!failed;
  $('confirm-software-update').textContent=installing?'正在启动安装…':ready?'重启并更新':failed?'查看更新':verifying?'正在校验…':'正在下载…';
  if(!available)dialog.close();
 }
 maybeShowUpdateNotice();
}
function maybeShowUpdateNotice(){
 const u=latestSoftwareUpdate,dialog=$('software-update-dialog');
 if(!u||!u.latest||u.latest===u.currentVersion||!['available','downloading','ready'].includes(u.status)||updateNoticesSeen.has(u.latest)||document.querySelector('dialog[open]'))return;
 updateNoticesSeen.add(u.latest);dialog.showModal();renderUpdateNotice(u,u.currentVersion);$('postpone-software-update').focus();
}
document.addEventListener('close',()=>queueMicrotask(maybeShowUpdateNotice),true);
$('software-update-dialog').addEventListener('cancel',event=>{if(updateInstallPending||latestSoftwareUpdate?.status==='installing')event.preventDefault();});
$('postpone-software-update').onclick=()=>{if(!updateInstallPending&&latestSoftwareUpdate?.status!=='installing')$('software-update-dialog').close();};
$('close-software-update').onclick=$('postpone-software-update').onclick;
async function beginUpdateInstall(){
 if(updateInstallPending||latestSoftwareUpdate?.status!=='ready')return;
 updateInstallPending=true;const dialog=$('software-update-dialog');if(!dialog.open)dialog.showModal();renderUpdateNotice(latestSoftwareUpdate,latestSoftwareUpdate.currentVersion);
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 try{await call('install-update');}catch(error){updateInstallPending=false;renderUpdateNotice(latestSoftwareUpdate,latestSoftwareUpdate.currentVersion);$('software-update-prompt-status').textContent=error.message;}
}
$('confirm-software-update').onclick=async()=>{
 const u=latestSoftwareUpdate;if(u?.status==='error'){$('software-update-dialog').close();navigate('about');return;}
 await beginUpdateInstall();
};
 $('github-link').onclick=event=>{event.preventDefault();void call('open-github').catch(()=>{});};
 $('automatic-updates').onchange=()=>{void call('config',{automaticUpdates:$('automatic-updates').checked}).catch(()=>{});};
 $('check-update').onclick=()=>{void call('check-update').catch(()=>{});};
 $('install-update').onclick=()=>{void beginUpdateInstall();};
 initializeAuthorDialog();
 window.monitor.subscribe(render);window.monitor.onNavigate(navigate);window.addEventListener('unhandledrejection',event=>event.preventDefault());setInterval(tick,1000);void call('snapshot').then(result=>{render(result.state);return call('ui-ready',{theme:document.documentElement.dataset.theme,visible:!document.body.hidden});});

let addMode='link',addCandidate=null,addRequest=0,addBusy=false,linkTimer;
function initializeAuthorDialog(){
 const status=text=>{$('add-author-status').textContent=text;};
 function selection(candidate){addCandidate=candidate;$('selected-author').replaceChildren();$('selected-author').hidden=!candidate;$('confirm-add-author').disabled=!candidate||addBusy;if(candidate){$('selected-author').append(el('strong','待添加：'+candidate.name),el('p',candidate.source==='search'?'已打开主页，请核对后点击确认添加。':'主页信息已核验，请确认是目标博主。'));}}
 function invalidate(){++addRequest;clearTimeout(linkTimer);selection(null);$('link-candidate').replaceChildren();}
 function mode(value){const previous=addMode;invalidate();addMode=value;status('');$('author-search-results').replaceChildren();for(const name of ['link','search']){$('add-tab-'+name).setAttribute('aria-selected',String(name===value));$('add-tab-'+name).classList.toggle('selected',name===value);$('add-'+name+'-panel').hidden=name!==value;}if(previous!==value)window.productMotion?.page($('add-'+value+'-panel'));$(value==='link'?'share-link':'author-search-keyword').focus();}
 function close(){if(addBusy)return;invalidate();$('add-author-dialog').close();}
 function busy(value){addBusy=value;for(const name of ['preview-author','search-author']){const active=value&&((name==='preview-author'&&addMode==='link')||(name==='search-author'&&addMode==='search'));$(name).classList.toggle('is-loading',active);$(name).setAttribute('aria-busy',String(active));}for(const id of ['preview-author','search-author','confirm-add-author','close-add-author','cancel-add-author','add-tab-link','add-tab-search'])$(id).disabled=value||id==='confirm-add-author'&&!addCandidate;}
 function card(candidate,search){const row=el('div',undefined,'discovery-card'),avatar=el('span','—','avatar-placeholder'),copy=el('div',undefined,'copy');row.append(avatar);if(candidate.avatar){const img=el('img');img.className='author-avatar';img.alt=candidate.name+'的头像';img.referrerPolicy='no-referrer';img.src=candidate.avatar;img.onerror=()=>{img.hidden=true;avatar.hidden=false;};avatar.hidden=true;row.append(img);}copy.append(el('strong',candidate.name),el('p','ID：'+candidate.id));if(candidate.description)copy.append(el('p',candidate.description));row.append(copy);if(search){row.append(button('查看主页并选择',async()=>{if(addBusy)return;busy(true);const ticket=++addRequest;try{await call('preview-author-home',candidate.key);if(ticket!==addRequest||!$('add-author-dialog').open)return;selection(candidate);status('已在内嵌浏览器打开 '+candidate.name+' 的主页。核对后返回面板，点击“确认添加”。');}catch(error){status(error.message);}finally{busy(false);}}));}return row;}
 async function preview(){const input=$('share-link').value.trim();if(!input||addBusy)return;selection(null);const ticket=++addRequest;busy(true);status('正在读取并核验博主资料…');$('link-candidate').replaceChildren();try{const r=await call('preview-author',input);if(ticket!==addRequest||!$('add-author-dialog').open)return;$('link-candidate').append(card(r.candidate,false));selection(r.candidate);status(r.candidate.avatar?'链接有效，已读取博主昵称和头像。':'链接有效，已读取昵称；该主页暂未返回头像。');}catch(error){if(ticket===addRequest)status(error.message);}finally{busy(false);if(ticket!==addRequest&&addMode==='link'&&$('add-author-dialog').open&&/https:\/\//.test($('share-link').value))linkTimer=setTimeout(()=>void preview(),900);}}
 $('add-button').onclick=()=>{if(!$('add-author-dialog').open)$('add-author-dialog').showModal();mode('link');};
 $('add-tab-link').onclick=()=>mode('link');$('add-tab-search').onclick=()=>mode('search');
 $('close-add-author').onclick=close;$('cancel-add-author').onclick=close;
 $('add-author-dialog').addEventListener('cancel',event=>{event.preventDefault();close();});
 $('share-link').oninput=()=>{invalidate();status('');if(/https:\/\//.test($('share-link').value))linkTimer=setTimeout(()=>void preview(),900);};
 $('author-search-keyword').oninput=()=>{++addRequest;selection(null);$('author-search-results').replaceChildren();status('');};
 $('add-link-form').onsubmit=event=>{event.preventDefault();clearTimeout(linkTimer);void preview();};
 $('author-search-form').onsubmit=async event=>{event.preventDefault();if(addBusy)return;selection(null);const ticket=++addRequest;busy(true);$('author-search-results').replaceChildren();status('正在通过 curl 搜索官方博主列表…');try{const r=await call('search-authors',$('author-search-keyword').value);if(ticket!==addRequest||!$('add-author-dialog').open)return;for(const c of r.candidates)$('author-search-results').append(card(c,true));status(r.candidates.length?'找到 '+r.candidates.length+' 位博主，请打开主页核对。':'搜索已完成，当前没有匹配的博主。');}catch(error){if(ticket===addRequest)status(error.message);}finally{busy(false);}};
 $('confirm-add-author').onclick=async()=>{if(!addCandidate||addBusy)return;const chosen=addCandidate;busy(true);status('正在再次核验并保存…');try{const result=await call('add',{key:chosen.key});busy(false);close();locateAuthor(result.id);message(result.duplicate?'该博主已存在，已定位到原条目。':'已添加 '+chosen.name+'，首次可靠采集将建立基线。');}catch(error){status(error.message);}finally{busy(false);}};
 $('show-menu').onclick=()=>{void call('show-menu').catch(()=>{});};
}
