const assert=require('node:assert/strict'),crypto=require('node:crypto'),dgram=require('node:dgram'),path=require('node:path'),fs=require('node:fs'),Module=require('node:module');
const root=process.env.ALLOCONNECT_DESKTOP||'C:/Users/user/Desktop/claude/alloconnect-src';
const baseline=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11);
let FriendsNet;
if(baseline){const m=new Module(path.join(root,'net-friends.js'),module);m.filename=path.join(root,'net-friends.js');m.paths=Module._nodeModulePaths(root);m._compile(fs.readFileSync(baseline,'utf8'),m.filename);FriendsNet=m.exports.FriendsNet;}
else ({FriendsNet}=require(path.join(root,'net-friends.js')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function peer(){
 const f=new FriendsNet({dir:__dirname});f.priv=crypto.generateKeyPairSync('x25519').privateKey;
 f.id=crypto.createPublicKey(f.priv).export({format:'jwk'}).x;f.idBuf=Buffer.from(f.id,'base64url');
 f.saveFriends=()=>{};f.pingAll=()=>{};f.punch=()=>{};
 const s=dgram.createSocket('udp4');await new Promise((resolve,reject)=>{s.once('error',reject);s.bind(0,'127.0.0.1',resolve);});
 s.on('message',(data,from)=>f.onPacket(data,from));f.sock=s;f.port=s.address().port;
 f.stunPlan=[{name:'test',urls:['stun:fake.invalid:3478']}];
 // The first advertised path has no listener. Only the second mapping works.
 f.stunList=async()=>({results:[{ip:'127.0.0.2',port:f.port},{ip:'127.0.0.1',port:f.port}],first:null});
 await f.runStun();return f;
}
(async()=>{
 let a,b;
 try{
  a=await peer();b=await peer();
  for(const [self,other]of [[a,b],[b,a]])self.friends.set(other.id,{id:other.id,nick:'test',addrs:other.localAddrs().filter(x=>x.kind==='stun'),online:false,lastSeen:0});
  a.ping(b.id);b.ping(a.id);await sleep(150);
  const online=a.friends.get(b.id).online&&b.friends.get(a.id).online;
  if(baseline){assert.equal(online,false);console.log('PASS baseline reproduction: single advertised mapping leaves both friends offline');return;}
  assert.equal(online,true,'both peers must receive authenticated presence over the second mapping');
  const received=[];a.on('message',(id,msg)=>received.push(msg));b.on('message',(id,msg)=>received.push(msg));
  await Promise.all([a.sendReliable(b.id,{t:'call',code:'synthetic-offer'},{tries:5,every:70}),b.sendReliable(a.id,{t:'call',code:'synthetic-answer'},{tries:5,every:70})]);
  assert.equal(received.filter(m=>m.t==='call').length,2);
  await a.sendBig(b.id,{t:'call',code:'x'.repeat(4000)});
  await sleep(20);assert(received.some(m=>m.code==='x'.repeat(4000)));
  console.log('PASS: real UDP, encrypted presence and reliable call messages in both directions, fragmented invitation delivered through the second mapping');
 }finally{a?.stop();b?.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
