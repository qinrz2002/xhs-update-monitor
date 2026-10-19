'use strict';
const {randomUUID}=require('node:crypto');
const {stateFromHtml,avatarUrl,businessFailure}=require('./collector.cjs');
const ID=/^[a-f\d]{24}$/i;
function normalizeUser(raw){
 if(!raw||typeof raw!=='object')return null;
 const id=String(raw.userId||raw.user_id||raw.id||''),name=raw.nickname||raw.nickName||raw.name||raw.title;
 if(!ID.test(id)||typeof name!=='string'||!name.trim())return null;
 const token=raw.xsecToken||raw.xsec_token;
 return{id,name:name.trim().slice(0,100),avatar:avatarUrl(raw.imageb||raw.images||raw.image||raw.avatar||raw.avatarUrl),description:String(raw.desc||raw.description||'').slice(0,300),url:'https://www.xiaohongshu.com/user/profile/'+id+(typeof token==='string'&&token?'?xsec_token='+encodeURIComponent(token)+'&xsec_source=pc_search':'')};
}
function failure(response,state){
 const location=response.headers?.location?.[0]||'';
 if(response.status===429)return '搜索过于频繁，请稍后再试。';
 if([461,471].includes(response.status)||/captcha|verify|challenge/i.test(location))return '平台要求安全验证，请在官方窗口完成后重试。';
 if([401,403].includes(response.status)||/login/i.test(location))return '本次访问需要有效登录，请重新登录并验证会话。';
 if(response.status!==200)return '搜索请求失败（HTTP '+response.status+'），请稍后重试。';
 if(state?.user?.bannedInfo?.serverBanned)return '平台限制了本次访问，请在官方窗口确认账号状态。';
 return null;
}
function searchFromResponse(response){
 let state;try{state=stateFromHtml(response.body);}catch{throw Error('搜索页面结构变化，未取得可靠结果。');}
 const error=failure(response,state);if(error)throw Error(error);
 const search=state?.search;if(!search)throw Error('官方搜索页未提供可识别的用户列表。');
 const users=Array.isArray(search.userLists)?search.userLists:[];
 const normalized=[...new Map(users.map(normalizeUser).filter(Boolean).map(u=>[u.id,u])).values()].slice(0,50);
 if(!normalized.length&&state.user?.loggedIn!==true)throw Error('官方搜索页未返回已登录用户结果，请重新登录并验证。');
 if(!normalized.length&&!['success','resolved'].includes(search.fetchUserListsStatus))throw Error('官方搜索页只返回动态页面，curl 未取得博主列表；请使用链接添加。');
 return normalized;
}
function searchFromApi(response){
 const error=failure(response);if(error)throw Error(error);
 let payload;try{payload=JSON.parse(response.body);}catch{throw Error('用户搜索接口未返回可识别的数据。');}
 if(payload.success!==true||![0,1000].includes(payload.code)){
  const restricted=businessFailure(payload.code);
  throw Error(restricted?restricted.message:([-100,10001].includes(payload.code)?'名称搜索登录已失效，请重新登录并验证会话。':'用户搜索未成功（代码 '+String(payload.code??'未知')+'），请稍后重试。'));
 }
 const users=payload.data?.users;if(!Array.isArray(users))throw Error('用户搜索结果结构变化，未取得可靠博主列表。');
 const normalized=[...new Map(users.map(normalizeUser).filter(Boolean).map(u=>[u.id,u])).values()].slice(0,50);
 if(users.length&&!normalized.length)throw Error('搜索返回了无法核验的博主资料，请稍后重试。');
 return normalized;
}
class AuthorDiscovery{
 constructor(transport,{now=Date.now}={}){this.transport=transport;this.now=now;this.candidates=new Map();this.busy=false;this.nextSearch=0;}
 async serial(work){if(this.busy)throw Error('正在读取博主信息，请等待当前请求完成。');this.busy=true;try{return await work();}finally{this.busy=false;}}
 remember(profile,{source='link',notes=[]}={}){const key=randomUUID(),candidate={...profile,key,source,notes,profileVerifiedAt:source==='link'?this.now():null,expires:this.now()+10*60*1000,opened:false};this.candidates.set(key,candidate);for(const[k,v]of this.candidates)if(v.expires<this.now())this.candidates.delete(k);return this.public(candidate);}
 public(c){return{key:c.key,id:c.id,name:c.name,avatar:c.avatar,url:c.url,description:c.description||'',source:c.source};}
 get(key){const c=this.candidates.get(String(key));if(!c||c.expires<this.now())throw Error('预览已过期，请重新读取博主。');return c;}
 async profile(input){
  const identity=await this.transport.resolve(String(input).slice(0,4096));
  const response=await this.transport.request(identity.url);let state;try{state=stateFromHtml(response.body);}catch{throw Error('主页结构变化，暂时无法核验博主。');}
  const error=failure(response,state);if(error)throw Error(error);
  const user=state?.user,basic=user?.userPageData?.basicInfo||user?.userPageData;
  const restricted=businessFailure(user?.bannedInfo?.code);if(restricted)throw Error(restricted.message);
  // Empty-note accounts are valid; require an explicit profile ID rather than note IDs.
  const raw=basic?{...basic,userId:basic.userId||user.userPageData?.userId||user.noteQueries?.[0]?.userId}:state?.profile?.userInfo;
  const profile=normalizeUser(raw);
  if(!profile||profile.id!==identity.id)throw Error(user?.loggedIn===false?'主页未返回可核验的博主资料，请先登录。':'链接没有返回匹配的博主资料，可能已失效或受到平台限制。');
  return{...profile,url:identity.url};
 }
 preview(input){return this.serial(async()=>this.remember(await this.profile(input)));}
 search(input){return this.serial(async()=>{
  const keyword=String(input||'').trim();if(!keyword||keyword.length>80||/[\x00-\x1f]/.test(keyword))throw Error('请输入 1～80 个字的博主名称。');
  if(this.now()<this.nextSearch)throw Error('请等待 '+Math.ceil((this.nextSearch-this.now())/1000)+' 秒后再搜索。');this.nextSearch=this.now()+10000;
  const users=searchFromApi(await this.transport.searchUsers(keyword));
  return users.map(profile=>this.remember(profile,{source:'search'}));
 });}
 open(key,login){const c=this.get(key);login.openAuthor(c.url);c.opened=true;return this.public(c);}
 async confirm(key){const c=this.get(key);if(c.source==='search'&&!c.opened)throw Error('请先打开此博主主页，核对后再确认。');return this.serial(async()=>{this.transport.policy?.assertAllowed();const fresh=c.source==='link'&&c.profileVerifiedAt!==null&&this.now()-c.profileVerifiedAt<5*60000;const verified=fresh?this.public(c):await this.profile(c.url);return{...verified,key:c.key};});}
}
module.exports={AuthorDiscovery,normalizeUser,searchFromResponse,searchFromApi};
