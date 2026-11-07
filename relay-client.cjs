'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const CONTEXT = Buffer.from('alloconnect relay auth v1');
class RelayClient extends EventEmitter {
  constructor({ url, privateKey, fetchImpl = globalThis.fetch, allowLocalHttpForTest = false, retryMinMs = 500, retryMaxMs = 30000 }) {
    super();
    const u = new URL(url);
    const localTest = allowLocalHttpForTest && u.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(u.hostname);
    if ((!localTest && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('Relay requires an HTTPS origin');
    this.url = u.origin; this.privateKey = privateKey;
    this.id = crypto.createPublicKey(privateKey).export({ format:'jwk' }).x;
    this.fetch = fetchImpl; this.retryMinMs = retryMinMs; this.retryMaxMs = retryMaxMs;
    this.state = 'stopped'; this.running = false; this.token = null; this.controller = null; this.retryTimer = null; this.retryWake = null;
    this.sendActive=0;this.sendQueue=[];
  }
  setState(state) { if (this.state !== state) { this.state = state; this.emit('state',state); } }
  async request(path, data, { token = null, signal, timeout = 15000 } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(abort,timeout);
    try {
      const res = await this.fetch(this.url + '/v1/' + path,{ method:'POST', headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data),signal:controller.signal });
      if (!res.ok) { const e=Error('relay-request-failed');e.status=res.status;throw e; }
      const text = await res.text(); if (text.length > 24 * 1024 * 1024) throw Error('relay-response-too-large');
      return JSON.parse(text);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  async authenticate(signal) {
    const c = await this.request('challenge',{id:this.id},{signal});
    if (!/^[A-Za-z0-9_-]{32}$/.test(c.challenge||'') || !/^[A-Za-z0-9_-]{43}$/.test(c.nonce||'') || !/^[A-Za-z0-9_-]{43}$/.test(c.publicKey||'')) throw Error('bad-relay-challenge');
    const pub=crypto.createPublicKey({key:{kty:'OKP',crv:'X25519',x:c.publicKey},format:'jwk'});
    const shared=crypto.diffieHellman({privateKey:this.privateKey,publicKey:pub});
    const key=Buffer.from(crypto.hkdfSync('sha256',shared,Buffer.alloc(0),CONTEXT,32));
    const proof=crypto.createHmac('sha256',key).update(`alloconnect relay auth v1\n${this.id}\n${c.challenge}\n${c.nonce}`).digest('base64url');
    const a=await this.request('auth',{id:this.id,challenge:c.challenge,proof},{signal});
    if (!/^[A-Za-z0-9_-]{43}$/.test(a.token||'')) throw Error('bad-relay-session');
    return {token:a.token,until:Date.now()+Math.max(1,Math.min(3600,Number(a.expiresIn)||1)-30)*1000};
  }
  start() {
    if (this.running) return;
    this.running=true;
    this.job=this.loop();
  }
  async loop() {
    let retry=this.retryMinMs;
    while(this.running) {
      const controller=new AbortController();this.controller=controller;this.setState('connecting');
      try {
        const session=await this.authenticate(controller.signal);
        if(!this.running||controller.signal.aborted)break;
        this.token=session.token;this.setState('ready');retry=this.retryMinMs;
        while(this.running&&!controller.signal.aborted&&Date.now()<session.until) {
          const r=await this.request('poll',{}, {token:session.token,signal:controller.signal,timeout:35000});
          if(!this.running||controller.signal.aborted)break;
          if(!Array.isArray(r.packets)||r.packets.length>256)throw Error('bad-relay-packets');
          for(const p of r.packets) {
            if(typeof p!=='string'||p.length>87400)throw Error('bad-relay-packet');
            const b=Buffer.from(p,'base64url');
            if(b.length<66||b.length>65507||b.toString('base64url')!==p||b.toString('ascii',0,4)!=='ALC1')throw Error('bad-relay-packet');
            this.emit('packet',b);
          }
        }
      } catch { /* State only: no endpoint, keys, IDs, packets or tokens in logs. */ }
      finally { this.token=null;controller.abort();if(this.controller===controller)this.controller=null; }
      if(!this.running)break;
      this.setState('offline');
      await new Promise(resolve=>{this.retryWake=resolve;this.retryTimer=setTimeout(resolve,retry);});
      this.retryWake=null;this.retryTimer=null;retry=Math.min(this.retryMaxMs,retry*2);
    }
    this.setState('stopped');
  }
  async send(to,packet) {
    if(this.state!=='ready'||!this.token||this.sendQueue.length>=256)return false;
    return new Promise(resolve=>{this.sendQueue.push({to,packet:Buffer.from(packet),resolve});this.drainSends();});
  }
  drainSends() {
    while(this.sendActive<4&&this.sendQueue.length){
      const p=this.sendQueue.shift();this.sendActive++;
      this.sendNow(p.to,p.packet).then(p.resolve,()=>p.resolve(false)).finally(()=>{this.sendActive--;this.drainSends();});
    }
  }
  async sendNow(to,packet) {
    const token=this.token,controller=this.controller;
    if(this.state!=='ready'||!token||!controller)return false;
    try { const r=await this.request('send',{to,packet:Buffer.from(packet).toString('base64url')},{token,signal:controller.signal});return r.queued===true; }
    catch(e) {if(e.status===401&&this.controller===controller)controller.abort();return false;}
  }
  async iceServers() {
    if(!this.token||!this.controller)throw Error('relay-not-ready');
    const r=await this.request('ice',{}, {token:this.token,signal:this.controller.signal});
    if(!Array.isArray(r.iceServers))throw Error('bad-relay-ice');return r.iceServers;
  }
  async stop() {
    this.running=false;this.token=null;this.controller?.abort();
    for(const p of this.sendQueue.splice(0))p.resolve(false);
    clearTimeout(this.retryTimer);this.retryWake?.();await this.job;
    this.setState('stopped');
  }
  reconnect() {
    this.token=null;this.controller?.abort();
    for(const p of this.sendQueue.splice(0))p.resolve(false);
    clearTimeout(this.retryTimer);this.retryWake?.();
  }
}
module.exports={RelayClient};
