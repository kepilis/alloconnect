const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto'),dgram=require('node:dgram'),assert=require('node:assert/strict');
const root=process.env.ALLOCONNECT_DESKTOP||'C:/Users/user/Desktop/claude/alloconnect-src';
const baseline=process.argv.find(x=>x.startsWith('--baseline='))?.slice(11);
let FriendsNet;
if(baseline){const m=new Module(path.join(root,'net-friends.js'),module);m.filename=path.join(root,'net-friends.js');m.paths=Module._nodeModulePaths(root);m._compile(fs.readFileSync(baseline,'utf8'),m.filename);FriendsNet=m.exports.FriendsNet;}
else ({FriendsNet}=require(path.join(root,'net-friends.js')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function peer(){
 const f=new FriendsNet({dir:__dirname});f.priv=crypto.generateKeyPairSync('x25519').privateKey;
 f.id=crypto.createPublicKey(f.priv).export({format:'jwk'}).x;f.idBuf=Buffer.from(f.id,'base64url');f.saveFriends=()=>{};f.punch=()=>{};
 const socket=dgram.createSocket('udp4');await new Promise(r=>socket.bind(0,'127.0.0.1',r));f.port=socket.address().port;
 f.sizes=[];f.dropped=0;
 f.sock={send(buf,port,ip,cb){f.sizes.push(buf.length);if(buf.length>1000){f.dropped++;cb?.(null);return;}socket.send(buf,port,ip,cb);},close(){socket.close();}};
 socket.on('message',(buf,from)=>f.onPacket(buf,from));
 const reliable=f.sendReliable.bind(f);f.sendReliable=(id,msg,opts={})=>reliable(id,msg,{tries:5,every:60,...opts});
 return f;
}
(async()=>{
 let a,b;try{
  a=await peer();b=await peer();
  for(const [self,other]of [[a,b],[b,a]])self.friends.set(other.id,{id:other.id,nick:'test',addrs:[{kind:'lan',ip:'127.0.0.1',port:other.port}],online:false,lastSeen:0});
  a.ping(b.id);b.ping(a.id);await sleep(50);assert(a.friends.get(b.id).online&&b.friends.get(a.id).online);
  const received=[];b.on('message',(_,msg)=>received.push(msg));a.on('message',(_,msg)=>received.push(msg));
  const invite={t:'call',code:'ALOI.'+'A'.repeat(2300),nick:'test'};
  if(baseline){await assert.rejects(a.sendBig(b.id,invite));assert(a.dropped>0);console.log('REPRODUCED: presence passes but invitation times out when the path drops UDP payloads over 1000 bytes');return;}
  await a.sendBig(b.id,invite);await sleep(10);assert(received.some(m=>m.code===invite.code));
  const unicode={t:'dm',text:'🙂Привет\\\"\n'.repeat(300)};
  await b.sendBig(a.id,unicode);await sleep(10);assert(received.some(m=>m.text===unicode.text));
  assert.equal(a.dropped+b.dropped,0);assert(Math.max(...a.sizes,...b.sizes)<=1000);
  const echoes=[];a.on('probe-size',r=>echoes.push(r));a.probe(b.id);await sleep(80);
  assert.deepEqual([...new Set(echoes.filter(r=>r.fullEcho).map(r=>r.requested))].sort((x,y)=>x-y),[256,768,1000]);
  assert(!echoes.some(r=>r.requested===1200));assert(a.dropped>0);
  console.log('PASS: real encrypted UDP, online presence, long invitation and Unicode survive 1000-byte limit; size diagnostics confirm 256/768/1000 and detect missing 1200-byte path');
 }finally{a?.stop();b?.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
