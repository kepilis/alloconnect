const fs = require('fs'), vm = require('vm'), assert = require('assert/strict'), path = require('path');
// Run with: node tests/stream-performance/control-latency.cjs (no UI or native input).
const root = process.env.APP_FROM || path.join(__dirname, '../..');
const src = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const group = fs.readFileSync(path.join(root, 'group.js'), 'utf8');
function part(start, end) { const a = src.indexOf(start), b = src.indexOf(end, a); assert(a >= 0 && b > a); return src.slice(a, b); }
let now = 0, id = 0, jobs = new Map(), messages = [], target = 20;
const CV = { state: 'on', moveTimer: null, moveSentAt: -Infinity, moveQ: null, rel: [0, 0], receiveBuffers: new Map(), keys: new Set(), perm: {} };
const video = { jitterBufferTarget: 100 }, audio = { jitterBufferTarget: 100 }, other = { jitterBufferTarget: 70 };
let receivers = [video, audio];
const context = { console, CV, CS: {on: false}, performance: {now: () => now}, setTimeout: (f, t) => { jobs.set(++id, {f, at: now+t}); return id; }, clearTimeout: i => jobs.delete(i), clearInterval: () => {}, ctlSend: a => messages.push(a), n4: n => Math.round(n*10000)/10000, settings: () => ({ctlBufferMs: target}), ctlLink: () => ({receivers: () => receivers}), L: () => {}, ctlSig: () => {}, document: {}, navigator: {}, setRumble: () => {}, updateToolbar: () => {}, sysMsg: () => {} };
vm.createContext(context);
vm.runInContext(part('function flushMove()', '\nfunction padPoll()') + part('function ctlBufferValue(', '\nfunction ctlViewStart(') + part('function ctlViewStop(', '\nconst MOUSE_BTN'), context);
function advance(ms) { now += ms; for (const [i,j] of [...jobs]) if (j.at <= now) {jobs.delete(i); j.f();} }
const run = s => vm.runInContext(s, context);
CV.moveQ = [.1, .2]; run('queueMoveFlush()'); assert.equal(messages.length, 1); assert.equal(jobs.size, 0);
for(let n=1;n<=30;n++) { CV.moveQ = [n/100, .5]; run('queueMoveFlush()'); }
assert.equal(jobs.size, 1); advance(4); assert.equal(messages.length, 2); assert.equal(messages[1][1], .3);
CV.rel = [4, -2]; run('queueMoveFlush()'); run('flushMove()'); assert.equal(messages.at(-1)[0], 'r'); assert.equal(jobs.size, 0);
run('ctlReceiveLatency(true)'); assert.equal(video.jitterBufferTarget, 20); assert.equal(audio.jitterBufferTarget, 20); assert.equal(other.jitterBufferTarget, 70);
for(target of [0, 20, 50, 100]) {run('ctlReceiveLatency(true)'); assert.equal(video.jitterBufferTarget, target);}
target = 999; run('ctlReceiveLatency(true)'); assert.equal(video.jitterBufferTarget, 20);
run('ctlReceiveLatency(false)'); assert.equal(video.jitterBufferTarget, 100); assert.equal(audio.jitterBufferTarget, 100);
const groupVideo = {jitterBufferTarget:null}, groupAudio = {jitterBufferTarget:null}; receivers = [groupVideo,groupAudio];
run('ctlReceiveLatency(true)'); assert.equal(groupVideo.jitterBufferTarget, 20); run('ctlReceiveLatency(false)'); assert.equal(groupVideo.jitterBufferTarget, null);
receivers = [{}, {get jitterBufferTarget(){return 100},set jitterBufferTarget(v){throw Error('unsupported')}}, undefined]; run('ctlReceiveLatency(true);ctlReceiveLatency(false)');
receivers = [video,audio]; run('ctlReceiveLatency(true)'); CV.moveQ=[.9,.9]; run('queueMoveFlush()'); assert(jobs.size); run('ctlViewStop(false)');
assert.equal(jobs.size,0); assert.equal(CV.moveQ,null); assert.equal(CV.rel[0],0); assert.equal(video.jitterBufferTarget,100); assert.equal(CV.state,'off');
const count=messages.length; advance(100); assert.equal(messages.length,count);
CV.state='on'; CV.moveQ=[.05,.05]; run('queueMoveFlush()'); assert.equal(messages.length,count+1);
assert(group.includes('receivers: () => [peer()?.vtx?.receiver, peer()?.satx?.receiver]'));
assert(/flushMove\(\);\s+if \(document\.pointerLockElement !== inp\)/.test(group));
assert(src.includes("flushMove(); ctlSend(['b', MOUSE_BTN[e.button], 0])"));
// Dynamic file limits must change on the next polling tick, even if control starts while waiting.
const fc = {bufferedAmount: 500000, readyState:'open', addEventListener(){}, removeEventListener(){}};
let tick;
context.setInterval = f => {tick=f;return 1};
vm.runInContext(part('const ctlFileBusy =', '\nclass FileChan'),context);
(async () => {
 let done=false; context.fc=fc; const pending=run('waitLow(fc)'); pending.then(()=>done=true);
 tick(); await Promise.resolve(); assert.equal(done,false);
 CV.state='off'; tick(); await pending; assert.equal(done,true);
 CV.state='on'; fc.bufferedAmount=60000; const low=run('waitLow(fc)'); tick(); await low;
 console.log('PASS: immediate/coalesced mouse, relative flush, pending-input cleanup, buffer profiles, restore, group isolation, unsupported runtime, dynamic file limits');
})().catch(e=>{console.error(e);process.exitCode=1});
