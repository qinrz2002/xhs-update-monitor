'use strict';
const {Xhshow,CryptoConfig}=require('@ikenxuan/xhshow-ts');
const SEARCH_API='https://edith.xiaohongshu.com/api/sns/web/v1/search/usersearch';
function signedSearch(keyword,cookie,userAgent){
 const cookies=Object.fromEntries(cookie.split(';').map(part=>{const i=part.indexOf('=');return i<1?null:[part.slice(0,i).trim(),part.slice(i+1).trim()];}).filter(Boolean));
 if(!cookies.web_session||!cookies.a1)throw Error('名称搜索需要有效登录，请重新登录并验证会话。');
 const client=new Xhshow(new CryptoConfig().forUserAgent(userAgent));
 const body={search_user_request:{keyword,search_id:client.getSearchId(),page:1,page_size:20,biz_type:'web_search_user',request_id:client.getSearchRequestId()}};
 const headers=client.signHeadersPost(new URL(SEARCH_API).pathname,cookies,'xhs-pc-web',body,undefined,undefined,'xys',undefined,true);
 return{body:JSON.stringify(body),headers:{...headers,'Content-Type':'application/json;charset=UTF-8',Origin:'https://www.xiaohongshu.com',Referer:'https://www.xiaohongshu.com/'}};
}
module.exports={SEARCH_API,signedSearch};
