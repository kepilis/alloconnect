const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const desktop = process.env.ALLOCONNECT_DESKTOP || (fs.existsSync(path.resolve(__dirname, '../../renderer.js')) ? path.resolve(__dirname, '../..') : 'C:/Users/user/Desktop/claude/alloconnect-src');
const android = process.env.ALLOCONNECT_ANDROID || path.resolve(desktop, '../alloconnect_android');
let completed = false;
process.on('beforeExit', () => { if (!completed) { console.error('FAIL: ICE scenario did not settle'); process.exitCode = 1; } });
const projects = [
  ['Windows', path.join(desktop, 'renderer.js')],
  ['Android', path.join(android, 'www/core.js')],
];
const cases = [
  {name:'srflx-quiet-window',events:['srflx','quiet'],why:'ready'},
  {name:'host-quiet-window',events:['host','quiet'],why:'ready'},
  {name:'turn-quiet-window',turn:true,events:['srflx','relay','quiet'],why:'ready'},
  {name:'multi-interface-quiet-window',events:['srflx','host','srflx','quiet'],why:'ready'},
  {name:'direct-srflx', events:['srflx','complete'], why:'complete'},
  {name:'no-stun-lan', count:0, events:['complete'], why:'complete'},
  {name:'stun-timeout', events:['fallback'], why:'timeout', fallback:true},
  {name:'stun-errors', events:['errors'], why:'all-failed', fallback:true},
  {name:'stun-empty', events:['complete'], why:'complete', fallback:true},
  {name:'public-host', events:['host','complete'], why:'complete'},
  {name:'public-host-stun-timeout', events:['host','fallback','complete'], why:'complete'},
  {name:'public-host-stun-errors', events:['host','errors','complete'], why:'complete'},
  {name:'turn-and-stun', turn:true, events:['srflx','relay','complete'], why:'complete'},
  {name:'turn-before-stun', turn:true, events:['relay','srflx','complete'], why:'complete'},
  {name:'turn-no-stun-timeout', turn:true, events:['relay','fallback','complete'], why:'complete'},
  {name:'turn-no-stun-errors', turn:true, events:['relay','errors','complete'], why:'complete'},
  {name:'turn-no-stun-complete', turn:true, events:['relay','complete'], why:'complete'},
  {name:'relay-only', turn:true, only:true, events:['relay'], why:'relay'},
  {name:'relay-only-no-answer', turn:true, only:true, events:['errors','complete'], why:'complete'},
  {name:'turn-with-stun-disabled', turn:true, count:0, events:['relay','complete'], why:'complete'},
  {name:'everything-blocked', turn:true, canFallback:false, events:['max'], why:'max-timeout'},
  {name:'multi-interface', events:['srflx','host','srflx','complete'], why:'complete'},
  {name:'fast-probe', first:true, events:['srflx'], why:'srflx'},
  {name:'fast-probe-with-turn', first:true, turn:true, events:['srflx','relay'], why:'relay'},
  {name:'slow-relay', turn:true, events:['srflx','max'], why:'max-timeout'},
];
(async () => {
  let passed = 0;
  for (const [platform, file] of projects) {
    const source = fs.readFileSync(file,'utf8');
    const start = source.indexOf('function gatherCandidates(');
    const body = source.slice(start, source.indexOf('\n// белый',start));
    for (const c of cases) {
      const timers = [], listeners = new Map();
      const ctx = vm.createContext({settings:()=>({turnUrl:c.turn?'turns:example.invalid:443':'',relay:!!c.only}),
        isPublicIp:ip=>ip==='public-test', STUN_FALLBACK_MS:2500,GATHER_TIMEOUT:5000,
        setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;}});
      vm.runInContext(body,ctx);
      const pc = {addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)};
      const p = ctx.gatherCandidates(pc,{canFallback:c.canFallback!==false,stunCount:c.count??3,firstUsable:!!c.first});
      for (const event of c.events) {
        if (event==='complete') {pc.iceGatheringState='complete';listeners.get('icegatheringstatechange')?.();}
        else if (event==='quiet') {const ready=timers.filter(t=>t.ms===150&&!t.cancelled);assert.equal(ready.length,1);ready[0].fn();}
        else if (event==='errors') for(let i=0;i<3;i++) listeners.get('icecandidateerror')?.({url:`stun:fake${i}`});
        else if (event==='fallback'||event==='max') timers.find(t=>t.ms===(event==='max'?(c.turn?15000:5000):2500))?.fn();
        else listeners.get('icecandidate')?.({candidate:{type:event,address:event==='host'?'public-test':undefined}});
      }
      const r = await p;
      assert.equal(r.why,c.why,`${platform}/${c.name}: reason`);
      assert.equal(r.fallback,!!c.fallback,`${platform}/${c.name}: fallback`);
      passed++;
    }
    const mstart=source.indexOf('function minifySdp(');
    const mend=source.indexOf('\n}',mstart)+2;
    const ctx=vm.createContext({});vm.runInContext(source.slice(mstart,mend),ctx);
    const sdp='v=0\r\na=candidate:1 1 tcp 1 192.0.2.1 9 typ host tcptype passive\r\na=candidate:2 1 udp 1 192.0.2.1 1234 typ relay\r\n';
    const result=ctx.minifySdp(sdp);
    assert(result.includes('tcptype'));assert(result.includes('typ relay'));
    console.log(`${platform}: ${cases.length} actual-source gather scenarios passed; SDP preserves ICE-TCP and relay candidates`);
  }
  console.log(`Total: ${passed} gather checks. Simulated events only; no real VPN/NAT connectivity claim.`);
  completed = true;
})().catch(e=>{console.error(e);process.exitCode=1;});
