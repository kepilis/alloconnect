const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto').webcrypto;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function section(s,a,b){const i=s.indexOf(a),j=s.indexOf(b,i);assert(i>=0&&j>i);return s.slice(i,j);}
(async()=>{
for(const [name,file]of [['Windows','C:/Users/user/Desktop/claude/alloconnect-src/renderer.js'],['Android','C:/Users/user/Desktop/claude/alloconnect_android/www/app.js']]){
 const source=fs.readFileSync(file,'utf8'),wait=deferred();let created=0,stopped=0;
 const S={busy:false,friendCall:{dir:'out'},connected:false,pc:null};
 const timers=[];
 const ctx=vm.createContext({S,console,crypto,G:{active:false},friendsList:[{id:'peer',nick:'Peer'}],showRejoin(){},clearTimeout(){},setTimeout(fn,ms){const t={fn,ms};timers.push(t);return t;},store:{set(){}},audio(){},L(){},$:()=>({value:'test',textContent:'',disabled:false,classList:{toggle(){},add(){},remove(){}}}),
  prepare:()=>wait.promise,showStep(){},showCallModal(){},setInfo(){},closePc(){S.pc=null;},releaseMic(){S.mic=null;},hideCallModal(){},toast(){},updateService(){},
  gatherWithFallback(){created++;throw Error('Unexpected allocation');},window:{duo:{friendsSend:async()=>({ok:true})}},alo:{requestMic:async()=>{},friendsSend:async()=>({ok:true})},acquireMic:()=>wait.promise,attachMicChain:async()=>{}});
 vm.runInContext(section(source,'function endFriendCall(text)','async function callFriend'),ctx);
 vm.runInContext(section(source,'async function startInvite()','async function applyAnswer'),ctx);
 const pending=ctx.startInvite();assert.equal(S.busy,true);
 ctx.endFriendCall();assert.equal(S.busy,false);assert.equal(S.friendCall,null);assert.equal(S.pc,null);assert.equal(S.answerWhenFree,null);
 const newer={};S.callSetup=newer;S.busy=true;wait.resolve(true);await pending;
 assert.equal(created,0);assert.equal(S.busy,true);assert.equal(S.callSetup,newer,'old finally must preserve new attempt');
 const decode=deferred();ctx.unpackCode=()=>decode.promise;ctx.setErr=()=>{};ctx.lobbyError=()=>{};S.busy=false;S.friendCall={dir:'in'};
 vm.runInContext(section(source,'async function makeAnswer(text)',name==='Android'?'function stunNote':'function armConnectTimer'),ctx);
 const answer=ctx.makeAnswer('synthetic');ctx.endFriendCall();decode.resolve({kind:'I',sdp:'test'});await answer;
 assert.equal(created,0);assert.equal(S.busy,false);assert.equal(S.pc,null);
 const micWait=deferred();ctx.acquireMic=()=>micWait.promise;S.callSetup={};const micSetup=S.callSetup;S.mic=null;
 vm.runInContext(section(source,'async function prepare(setup)',name==='Android'?'function enterCall()':'function showStep'),ctx);
 const mic=ctx.prepare(micSetup);await new Promise(r=>setImmediate(r));S.callSetup=null;
 micWait.resolve({getTracks:()=>[{stop(){stopped++;}}]});assert.equal(await mic,false);assert.equal(stopped,1);assert.equal(S.mic,null);
 vm.runInContext(section(source,'// Идентификатор относится','function onFriendMsg'),ctx);
 vm.runInContext(section(source,'async function callFriend(','async function sendFriendInvite'),ctx);
 ctx.startInvite=()=>{};S.busy=false;S.pc=null;S.friendCall=null;S.inCall=false;
 await ctx.callFriend('peer');assert.equal(timers.at(-1).ms,65000);
 S.busy=true;S.pc={};S.answerWhenFree='stale';timers.at(-1).fn();
 assert.equal(S.friendCall,null);assert.equal(S.pc,null);assert.equal(S.busy,false);assert.equal(S.answerWhenFree,null);
 console.log(`${name}: PASS cancel during preparation/decode/mic permission, old async completion cannot recreate PC or reset new busy state`);
}
})().catch(e=>{console.error(e);process.exitCode=1;});
