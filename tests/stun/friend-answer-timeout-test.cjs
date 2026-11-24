const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const desktop = process.env.ALLOCONNECT_DESKTOP || path.resolve(__dirname, '../..');
const android = process.env.ALLOCONNECT_ANDROID || path.resolve(__dirname, '../../android');

for (const [platform, file, until] of [
  ['Windows', path.join(desktop, 'renderer.js'), 'function armConnectTimer('],
  ['Android', path.join(android, 'www/app.js'), 'function stunNote('],
]) test(`${platform}: a late failure sending the answer leaves the next incoming call alone`, async () => {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('async function makeAnswer(text)');
  const end = source.indexOf(until, start);
  assert.ok(start >= 0 && end > start);
  const first = { id: 'first', nick: 'Friend' };
  const next = { id: 'next', nick: 'Friend' };
  const S = { friendCall: first, busy: false };
  const pc = { localDescription: { sdp: 'fixture' } };
  let finishSend;
  let startedSend;
  const waitingForSend = new Promise(resolve => { startedSend = resolve; });
  const friendsSend = () => new Promise(resolve => { finishSend = resolve; startedSend(); });
  const fields = new Map();
  const ctx = vm.createContext({
    S, console, ownCodes: new Set(),
    $(id) { if (!fields.has(id)) fields.set(id, {}); return fields.get(id); },
    unpackCode: async () => ({ kind: 'I', sdp: 'fixture' }),
    prepare: async () => true, closePc() {}, setErr() {}, setInfo() {}, countCandidates() {}, L() {},
    async gatherWithFallback() { S.pc = pc; return { pc, r: {} }; },
    packCode: async () => 'fixture', callEnvelope: (_call, answer) => answer, updateService() {},
    window: { duo: { friendsSend } }, alo: { friendsSend },
    endFriendCall() { S.friendCall = null; S.pc = null; },
    armConnectTimer() { assert.fail('old answer armed a new timer'); },
  });
  vm.runInContext(source.slice(start, end), ctx);
  const answer = ctx.makeAnswer('fixture');
  await waitingForSend;
  const nextPc = {};
  Object.assign(S, { callSetup: {}, pc: nextPc, friendCall: next });
  finishSend({ ok: false, error: 'timeout' });
  await answer;
  assert.equal(S.friendCall, next);
  assert.equal(S.pc, nextPc);
});
