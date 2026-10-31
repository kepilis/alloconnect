const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto'),dgram=require('node:dgram'),assert=require('node:assert/strict');
const root=process.env.ALLOCONNECT_DESKTOP||'C:/Users/user/Desktop/claude/alloconnect-src';
const baseline=process.argv.find(x=>x.startsWith('--baseline='))?.slice(11);let FriendsNet;
if(baseline){const m=new Module(path.join(root,'net-friends.js'),module);m.filename=path.join(root,'net-friends.js');m.paths=Module._nodeModulePaths(root);m._compile(fs.readFileSync(baseline,'utf8'),m.filename);FriendsNet=m.exports.FriendsNet;}
else ({FriendsNet}=require(path.join(root,'net-friends.js')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function peer(blockObserved){
 const f=new FriendsNet({dir:__dirname});f.priv=crypto.generateKeyPairSync('x25519').privateKey;f.id=crypto.createPublicKey(f.priv).export({format:'jwk'}).x;f.idBuf=Buffer.from(f.id,'base64url');f.saveFriends=()=>{};f.punch=()=>{};
 const socket=dgram.createSocket('udp4');await new Promise(r=>socket.bind(0,'0.0.0.0',r));f.port=socket.address().port;f.blocked=0;
 f.sock={send(buf,port,ip,cb){if(blockObserved&&ip==='127.0.0.1'){f.blocked++;cb?.(null);return;}socket.send(buf,port,ip,cb);},close(){socket.close();}};
 socket.on('message',(b,r)=>f.onPacket(b,r));const reliable=f.sendReliable.bind(f);f.sendReliable=(id,o,opts={})=>reliable(id,o,{tries:5,every:60,...opts});return f;
}
(async()=>{let a,b;try{
 a=await peer(false);b=await peer(true);
 a.friends.set(b.id,{id:b.id,nick:'B',addrs:[{kind:'lan',ip:'127.0.0.1',port:b.port}],online:false,lastSeen:0});
 b.friends.set(a.id,{id:a.id,nick:'A',addrs:[{kind:'stun',ip:'127.0.0.2',port:a.port}],online:false,lastSeen:0});
 const messages=[];b.on('message',(_,m)=>messages.push(m));a.on('message',(_,m)=>messages.push(m));
 a.ping(b.id);await sleep(60);assert(b.friends.get(a.id).online,'incoming requests reach the VPN peer');
 const call={t:'call',code:'ALOI.'+'x'.repeat(2500)};
 if(baseline){await assert.rejects(a.sendBig(b.id,call));assert(b.blocked>0);console.log('REPRODUCED: invitation reaches peer but caller times out because ACK only uses blocked observed return path');return;}
 await a.sendBig(b.id,call);await b.sendBig(a.id,{t:'answer',code:'ALOA.'+'y'.repeat(2500)});await sleep(30);
 assert(messages.some(m=>m.code===call.code));assert(messages.some(m=>m.t==='answer'));
 assert(a.friends.get(b.id).online&&b.friends.get(a.id).online);assert(b.blocked>0);
 console.log('PASS: real encrypted UDP presence, fragmented invitation and answer succeed while the observed return path is blocked; published alternate path delivers ACKs');
}finally{a?.stop();b?.stop();}})().catch(e=>{console.error(e);process.exitCode=1;});
