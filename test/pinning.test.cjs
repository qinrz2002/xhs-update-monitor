'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {normalize,Collector}=require('../src/collector.cjs');
test('official interactInfo.sticky pins cannot satisfy a previously saved regular boundary',async()=>{
 const cards=[1,2,3].map(i=>({id:String(i).padStart(24,'0'),noteCard:{title:'Pinned '+i,interactInfo:{sticky:true}}}));
 assert(cards.every(n=>normalize(n).pinned));assert.equal(normalize({noteCard:{sticky:'false'}}).pinned,false);
 const id='000000000000000000000099',body='<script>window.__INITIAL_STATE__='+JSON.stringify({user:{loggedIn:true,noteQueries:[{userId:id,hasMore:true}],notes:[cards]}})+'</script>';
 const collector=new Collector({request:async()=>({status:200,headers:{},body})});
 const result=await collector.collect({id,url:'https://www.xiaohongshu.com/user/profile/'+id,initialized:true,coverageVerified:true,seen:cards.map(c=>c.id)});
 assert.equal(result.coverageVerified,false);assert.equal(result.notes.filter(n=>n.pinned).length,3);
});
