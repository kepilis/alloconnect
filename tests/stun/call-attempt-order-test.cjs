const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const files=[['Windows','C:/Users/user/Desktop/claude/alloconnect-src/renderer.js'],['Android','C:/Users/user/Desktop/claude/alloconnect_android/www/app.js']];
const peer='a'.repeat(43),old='11111111-1111-4111-8111-111111111111',current='22222222-2222-4222-8222-222222222222';
for(const [name,file]of files){
 const source=fs.readFileSync(file,'utf8');
 const start=source.indexOf('// Идентификатор относится'),end=source.indexOf('\nfunction acceptCall()',start);
 assert(start>=0&&end>start);
 const timers=[],sent=[],events=[],elements=new Map();let applied=0;
 const S={friendCall:null,connected:false,inCall:false,busy:false,pc:null};
 const send=(...args)=>{sent.push(args);return Promise.resolve({ok:true});};
 const ctx=vm.createContext({S,friendsList:[{id:peer,nick:'Peer'}],myIdent:{id:'z'.repeat(43)},G:{active:false,invite:null},Date,
  L:()=>{},$:id=>{if(!elements.has(id))elements.set(id,{textContent:'',classList:{add(){},remove(){}}});return elements.get(id);},
  window:{duo:{friendsSend:send,focusWindow(){events.push('focus');}}},alo:{friendsSend:send,clearPendingCall(){}},
  document:{visibilityState:'visible',hidden:false},setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:()=>{},
  isFriend:()=>true,showCallModal:()=>events.push('shown'),startRing:()=>{},stopRing:()=>{},closeDm:()=>{},updateService:()=>{},notifyUser:()=>{},
  endFriendCall:()=>{events.push('ended');S.friendCall=null;},applyAnswer:()=>applied++,armConnectTimer:()=>{},HOST_CONNECT_TIMEOUT:30000});
 vm.runInContext(source.slice(start,end),ctx);
 const receive=(t,cid,extra={})=>ctx.onFriendMsg({id:peer,msg:{t,...(cid===undefined?{}:{cid}),code:'ALOI.test',...extra}});
 receive('call',current);assert.equal(S.friendCall.cid,current);assert(events.includes('shown'));
 const timer=timers.at(-1);
 receive('cancel',old);assert.equal(S.friendCall.cid,current,'old cancel must not close current modal');
 receive('cancel',undefined);assert.equal(S.friendCall.cid,current,'untagged cancel must not close a known tagged incoming call');
 receive('cancel',current);assert.equal(S.friendCall,null);
 const shown=events.filter(e=>e==='shown').length;
 receive('call',current);assert.equal(events.filter(e=>e==='shown').length,shown,'cancel before delayed offer prevents ghost ring');
 receive('call',old);assert.equal(S.friendCall,null,'earlier cancelled attempt stays cancelled');
 receive('call',undefined);assert(S.friendCall,'legacy incoming call still works');receive('cancel',undefined);assert.equal(S.friendCall,null);
 S.friendCall={id:peer,dir:'out',cid:current};
 receive('busy',old);assert(S.friendCall);receive('decline',old);assert(S.friendCall);receive('answer',old);assert.equal(applied,0);
 receive('answer',current);assert.equal(applied,1);assert.equal(S.friendCall.requireCid,true);
 receive('decline',undefined);assert(S.friendCall);receive('decline',current);assert.equal(S.friendCall,null);
 S.friendCall={id:peer,dir:'out',cid:current};receive('answer',undefined);assert.equal(applied,2,'legacy peer response is accepted before CID support is established');
 S.friendCall=null;receive('call','33333333-3333-4333-8333-333333333333');timer.fn();assert(S.friendCall,'old timeout cannot close a newer incoming attempt');
 S.friendCall=null;S.pc={};receive('call','44444444-4444-4444-8444-444444444444');
 const args=sent.at(-1),reply=name==='Windows'?args[1]:args[0].msg;assert.equal(reply.cid,'44444444-4444-4444-8444-444444444444');assert.equal(reply.t,'busy');
 console.log(`${name}: PASS stale cancel/busy/decline/answer, cancel-before-offer, legacy compatibility, timeout identity and busy reply correlation`);
}
