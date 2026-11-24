'use strict';
// Bounded retry bursts after a friend stops responding. This schedules packets;
// only an authenticated response to our traffic can stop recovery.
class FriendRecovery {
 constructor({ping,log=()=>{},onlineWindow=65000,coldDelay=30000,interval=2000,packets=6,backoff=15000,maxBackoff=300000}){Object.assign(this,{ping,log,onlineWindow,coldDelay,interval,packets,backoff,maxBackoff});this.peers=new Map()}
 tick(friends,presence,now=Date.now()){
  if(presence==='offline'){this.peers.clear();return}
  const keep=new Set();
  for(const f of friends){keep.add(f.id);let r=this.peers.get(f.id);
   if(f.lastRoundTrip>0&&now-f.lastRoundTrip<this.onlineWindow){if(r?.round)this.log({friend:f.id.slice(0,8),state:'restored',round:r.round,ms:Math.max(0,now-r.started)});this.peers.delete(f.id);continue}
   if(!r){r={round:0,left:0,next:now+(f.lastRoundTrip>0?0:this.coldDelay),started:now};this.peers.set(f.id,r)}
   if(now<r.next)continue;
   if(!r.left){r.round++;r.left=this.packets;this.log({friend:f.id.slice(0,8),state:'retry',round:r.round,packets:this.packets})}
   try{this.ping(f.id)}catch{this.log({friend:f.id.slice(0,8),state:'send-error',round:r.round})}
   r.left--;r.next=now+(r.left?this.interval:Math.min(this.maxBackoff,this.backoff*2**Math.min(r.round-1,20)));
  }
  for(const id of this.peers.keys())if(!keep.has(id))this.peers.delete(id);
 }
}
module.exports={FriendRecovery};
