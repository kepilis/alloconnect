const assert=require('node:assert/strict');
const {FriendsNet}=require(process.env.ALLOCONNECT_DESKTOP?process.env.ALLOCONNECT_DESKTOP+'/net-friends.js':'C:/Users/user/Desktop/claude/alloconnect-src/net-friends.js');
const pending=[];function result(ip){return {results:[{ip,port:12345}],first:null};}
(async()=>{
 const f=new FriendsNet({dir:__dirname});f.sock={};f.port=12345;f.punch=()=>{};f.pingAll=()=>{};
 f.stunPlan=[{name:'test',urls:['stun:example.invalid:3478']}];f.stunList=()=>new Promise(resolve=>pending.push(resolve));
 const old=f.runStun(),fresh=f.runStun();pending[1](result('192.0.2.2'));await fresh;
 pending[0](result('192.0.2.1'));await old;assert.equal(f.stun.ip,'192.0.2.2');
 const disabled=f.runStun();f.setStunConfig({noStun:true});pending[2](result('192.0.2.3'));await disabled;assert.equal(f.stun,null);assert.equal(f.stunAddrs.length,0);
 f.stunEnabled=true;f.stun={ip:'192.0.2.1',port:12345};f.stunAddrs=[f.stun];
 const states=[];f.on('stun',s=>states.push(s.stun));f.runStun=async()=>{assert.equal(f.stun,null);assert.equal(f.stunAddrs.length,0);f.stun={ip:'192.0.2.4',port:12345};};
 await f.networkChanged();assert.deepEqual(states,[false,true]);assert.equal(f.stun.ip,'192.0.2.4');
 console.log('PASS: old probe cannot overwrite new route, disabled STUN cannot reappear, network change clears stale mappings and reports new state');
})().catch(e=>{console.error(e);process.exitCode=1;});
