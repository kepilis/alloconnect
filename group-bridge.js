'use strict';
/* =========================================================
   Мост в групповом звонке (1.20): двое не соединились напрямую (строгий NAT у обоих, мобильная сеть) —
   их звук, экран, камеру и данные пересылает третий участник H, который связан с обоими.
   Протокол согласован с Android (alloconnect_android/ЗАДАЧА-группа-пересылка.md, версия 1):
   - hello: fwd: 1 (умею); glinks {ids} — с кем у меня подтверждённая связь;
   - просит тот из пары, у кого ID больше: fwd-req {a, b} → H (наименьший ID среди общих, связанных с обоими);
   - H: fwd-on {a, b, video} обоим | fwd-no {a, b, why}; по мосту H → Y отдельное соединение (fwd-offer {bid, for, sdp} →
     fwd-answer {bid, sdp}), трансиверы sendonly: 0 голос, 1 экран, 2 звук экрана, 3 камера — дорожки, полученные от X;
   - данные: X → H fwd {to, d}; H → Y fwd {from, d}; только из списка FWD_TYPES, d ≤ 16 КБ, ≤ 100 в секунду;
   - ID через мост доказывается ключом пары (friends.proof, bind 'fwd|gid|H') — H подделать не может;
   - fwd-off {a, b} — мост больше не нужен (прямая связь поднялась, кто-то ушёл, H пропал).
   У получателя пересланный участник — «виртуальный пир» (G.vpeers): тот же объект, что и обычный, только данные идут
   через H, а медиа — из соединения моста. Файлы и управление через мост не идут.
   ========================================================= */
const FWD_TYPES = new Set(['hello', 'state', 'screen', 'chat', 'chat-op', 'gdraw', 'gptr', 'gptr-off', 'gclear', 'greact', 'sp-stop', 'view', 'gcam', 'bye', 'ch', 'proof']);
const FWD_AFTER = 25000;   // прямая связь не поднялась за столько — просим мост
const FWD_MAX_H = 2;       // сколько мостов тянет один H
G.vpeers = new Map();      // id → виртуальный пир (тот, кто идёт через мост)
G.bridges = new Map();     // у H: 'a|b' → { a, b, legs: { [toId]: { bid, pc, from } } }
G.fwdAsk = new Map();      // у просящего: id → { h, at, tried: Set }
G.firstTry = new Map();    // id → когда впервые пытались соединиться напрямую

const bKey = (a, b) => [a, b].sort().join('|');
const grpLinkIds = () => [...G.peers.values()].filter((p) => p.connected).map((p) => p.id);
function grpSendLinks() { if (G.active) grpSendAll({ t: 'glinks', ids: grpLinkIds() }); }
// пир, которого показываем: прямой на связи, иначе через мост, иначе прямой (соединяется)
function grpViewPeer(id) {
  const p = G.peers.get(id);
  if (p?.connected) return p;
  const v = G.vpeers.get(id);
  return v?.connected ? v : p || v || null;
}
const grpBridged = (id) => !!G.vpeers.get(id)?.connected && !G.peers.get(id)?.connected;

/* ---------- у просящего: когда нужен мост ---------- */
function grpFwdTick() {
  if (!G.active) return;
  const me = grpMe();
  for (const id of G.members.keys()) {
    if (id === me || G.peers.get(id)?.connected || G.vpeers.has(id)) continue;
    if (!G.firstTry.has(id)) G.firstTry.set(id, Date.now());
    if (me < id) continue; // просит тот, у кого ID больше
    const p = G.peers.get(id);
    if (Date.now() - G.firstTry.get(id) < FWD_AFTER && (p?.tries || 0) < 2) continue;
    const ask = G.fwdAsk.get(id);
    if (ask && Date.now() - ask.at < 10000) continue;
    const tried = ask?.tried || new Set();
    const hs = [...G.peers.values()].filter((h) => h.connected && h.peerFwd && h.links?.has(id) && !tried.has(h.id)).map((h) => h.id).sort();
    if (!hs.length) { if (ask) G.fwdAsk.delete(id); continue; }
    const h = hs[0];
    tried.add(h);
    G.fwdAsk.set(id, { h, at: Date.now(), tried });
    grpSend(G.peers.get(h), { t: 'fwd-req', a: me, b: id });
    L('grp', { fwd: 'req', a: me.slice(0, 8), b: id.slice(0, 8), via: h.slice(0, 8) });
  }
}
setInterval(grpFwdTick, 3000);

/* ---------- у H ---------- */
function grpFwdOnReq(p, d) {
  const a = String(d.a || ''), b = String(d.b || '');
  const no = (why) => grpSend(p, { t: 'fwd-no', a, b, why });
  if (p.id !== a && p.id !== b) return;
  const pa = G.peers.get(a), pb = G.peers.get(b);
  if (!pa?.connected || !pb?.connected) return no('нет связи с обоими');
  if (!pa.peerFwd || !pb.peerFwd) return no('старая версия');
  const key = bKey(a, b);
  if (G.bridges.has(key)) { grpSend(p, { t: 'fwd-on', a, b, video: true }); return; }
  if (G.bridges.size >= FWD_MAX_H) return no('занят');
  const br = { a, b, legs: {} };
  G.bridges.set(key, br);
  L('grp', { fwd: 'on', a: a.slice(0, 8), b: b.slice(0, 8), via: grpMe().slice(0, 8) });
  for (const x of [pa, pb]) grpSend(x, { t: 'fwd-on', a, b, video: true });
  grpFwdLeg(br, a, b); // медиа a → b
  grpFwdLeg(br, b, a); // медиа b → a
}
const bridgeTracks = (x) => [x.atx?.receiver.track, x.vtx?.receiver.track, x.satx?.receiver.track, x.ctx?.receiver.track || null];
async function grpFwdLeg(br, from, to) {
  const pf = G.peers.get(from), pt = G.peers.get(to);
  if (!pf || !pt) return;
  const bid = newMid();
  const pc = new RTCPeerConnection(rtcConfig());
  const leg = { bid, pc, from, to, tx: [] };
  br.legs[to] = leg;
  try {
    const tr = bridgeTracks(pf);
    for (let i = 0; i < 4; i++) leg.tx.push(pc.addTransceiver(i === 0 || i === 2 ? 'audio' : 'video', { direction: 'sendonly' }));
    for (let i = 0; i < 4; i++) if (tr[i]) await leg.tx[i].sender.replaceTrack(tr[i]);
    grpFwdTuneLeg(leg, 'thumb');
    pc.addEventListener('connectionstatechange', () => {
      L('grp', { fwdLeg: pc.connectionState, to: to.slice(0, 8) });
      if (pc.connectionState === 'failed') grpFwdClose(bKey(br.a, br.b), 'мост не соединился');
    });
    const g = gatherCandidates(pc, { stunCount: stunCountOf(pc) });
    await pc.setLocalDescription(await pc.createOffer());
    await g;
    if (G.bridges.get(bKey(br.a, br.b)) !== br) return;
    grpSend(pt, { t: 'fwd-offer', bid, for: from, sdp: grpSdp(pc) });
  } catch (e) { L('grp', { fwdLegFailed: e.message }); grpFwdClose(bKey(br.a, br.b), 'ошибка моста'); }
}
// как получатель смотрит экран пересылаемого: крупно — до 720p и 1,5 Мбит/с, мелко — уменьшенное, не смотрит — стоп
async function grpFwdTuneLeg(leg, view) {
  leg.view = view;
  const s = leg.tx[1]?.sender;
  if (!s) return;
  try {
    const prm = s.getParameters();
    if (!prm.encodings?.length) prm.encodings = [{}];
    const e = prm.encodings[0];
    const h = s.track?.getSettings?.().height || 720;
    e.active = view !== 'off';
    e.scaleResolutionDownBy = view === 'thumb' ? Math.max(1, h / GRP_THUMB.h) : Math.max(1, h / 720);
    e.maxBitrate = view === 'thumb' ? GRP_THUMB.br : 1_500_000;
    e.maxFramerate = view === 'thumb' ? GRP_THUMB.fps : 30;
    await s.setParameters(prm);
  } catch { /* */ }
  grpSendViews();
}
// H смотрит экран X сам по себе, а через мост его может смотреть Y крупно: просим у X лучшее из двух
function grpFwdWantView(x) {
  let best = null;
  for (const br of G.bridges.values()) for (const leg of Object.values(br.legs)) {
    if (leg.from !== x) continue;
    if (leg.view === 'full') best = 'full';
    else if (leg.view === 'thumb' && best !== 'full') best = 'thumb';
  }
  return best;
}
// дорожки источника поменялись (появилась камера) — обновить мосты
function grpFwdRefresh(x) {
  const pf = G.peers.get(x);
  if (!pf) return;
  for (const br of G.bridges.values()) for (const leg of Object.values(br.legs)) {
    if (leg.from !== x) continue;
    bridgeTracks(pf).forEach((t, i) => { if (t && leg.tx[i]?.sender.track !== t) leg.tx[i].sender.replaceTrack(t).catch(() => {}); });
  }
}
function grpFwdOnAnswer(p, d) {
  for (const br of G.bridges.values()) {
    const leg = br.legs[p.id];
    if (!leg || leg.bid !== cleanMid(d.bid) || leg.pc.signalingState !== 'have-local-offer') continue;
    leg.pc.setRemoteDescription({ type: 'answer', sdp: String(d.sdp || '') }).catch((e) => L('grp', { fwdApply: e.message }));
  }
}
// данные: от участника моста — только второму участнику того же моста
function grpFwdData(p, d) {
  const to = String(d.to || '');
  const br = G.bridges.get(bKey(p.id, to));
  if (!br || !d.d || typeof d.d !== 'object' || !FWD_TYPES.has(d.d.t)) return;
  const now = Date.now();
  p.fwdHits = (p.fwdHits || []).filter((t) => now - t < 1000);
  if (p.fwdHits.length >= 100) return;
  p.fwdHits.push(now);
  if (JSON.stringify(d.d).length > 16384) return;
  // как получатель смотрит экран — это для моего моста, отправителю не нужно
  if (d.d.t === 'view') { const leg = br.legs[p.id]; if (leg && ['full', 'thumb', 'off'].includes(d.d.view)) grpFwdTuneLeg(leg, d.d.view); return; }
  const pt = G.peers.get(to);
  if (pt?.connected) grpSend(pt, { t: 'fwd', from: p.id, d: d.d });
}
function grpFwdClose(key, why, notify = true) {
  const br = G.bridges.get(key);
  if (!br) return;
  G.bridges.delete(key);
  for (const leg of Object.values(br.legs)) try { leg.pc.close(); } catch { /* */ }
  L('grp', { fwd: 'off', a: br.a.slice(0, 8), b: br.b.slice(0, 8), why });
  if (notify) for (const x of [br.a, br.b]) { const p = G.peers.get(x); if (p?.connected) grpSend(p, { t: 'fwd-off', a: br.a, b: br.b }); }
  grpSendViews();
}

/* ---------- у участника пары ---------- */
function grpFwdOnOn(hp, d) {
  const me = grpMe();
  const a = String(d.a || ''), b = String(d.b || '');
  if (a !== me && b !== me) return;
  const other = a === me ? b : a;
  if (!G.members.has(other) || G.peers.get(other)?.connected) return;
  G.fwdAsk.delete(other);
  const old = G.vpeers.get(other);
  if (old && old.via === hp.id && !old.closed) return;
  if (old) grpVpClose(old);
  const vp = { id: other, virt: true, via: hp.id, role: 'in', connected: false, sharing: false, muted: false, deaf: false, aud: {}, noVideo: d.video === false };
  vp.dc = { get readyState() { return grpOpen(vp.via) ? 'open' : 'closed'; }, send: (s) => { if (grpOpen(vp.via)) grpSend(G.peers.get(vp.via), { t: 'fwd', to: vp.id, d: JSON.parse(s) }); }, close() {} };
  G.vpeers.set(other, vp);
  L('grp', { fwd: 'joined', other: other.slice(0, 8), via: hp.id.slice(0, 8) });
  grpPeerOpen(vp); // подтверждение ID — через мост
}
async function grpFwdOnOffer(hp, d) {
  const vp = G.vpeers.get(String(d.for || ''));
  if (!vp || vp.via !== hp.id || !/^v=0/.test(String(d.sdp || ''))) return;
  try {
    try { vp.pc?.close(); } catch { /* */ }
    const pc = new RTCPeerConnection(rtcConfig());
    vp.pc = pc;
    pc.ontrack = (e) => grpOnTrack(vp, e);
    pc.addEventListener('connectionstatechange', () => { L('grp', { fwdIn: pc.connectionState }); if (pc.connectionState === 'failed' && vp.pc === pc) grpVpClose(vp, true); });
    await pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) });
    const trs = pc.getTransceivers();
    for (const t of trs) t.direction = 'recvonly';
    vp.ctx = trs[3] || null; // камера — четвёртый (grpOnTrack отличает её от экрана)
    vp.camMid = vp.ctx?.mid ?? null;
    const g = gatherCandidates(pc, { stunCount: stunCountOf(pc) });
    await pc.setLocalDescription(await pc.createAnswer());
    await g;
    if (vp.pc !== pc) return;
    grpSend(hp, { t: 'fwd-answer', bid: cleanMid(d.bid), sdp: grpSdp(pc) });
  } catch (e) { L('grp', { fwdOfferFailed: e.message }); }
}
function grpFwdOnOff(hp, d) {
  const me = grpMe();
  const other = String(d.a) === me ? String(d.b) : String(d.a);
  const vp = G.vpeers.get(other);
  if (vp && vp.via === hp.id) grpVpClose(vp, true);
}
// закрыть «виртуального пира»; again — сразу искать другой мост
function grpVpClose(vp, again) {
  if (vp.closed) return;
  vp.closed = true;
  clearTimeout(vp.timer);
  vp.stopMeter?.();
  for (const a of Object.values(vp.aud)) { try { a.src.disconnect(); a.gain.disconnect(); } catch { /* */ } a.el.srcObject = null; }
  try { vp.pc?.close(); } catch { /* */ }
  if (G.vpeers.get(vp.id) === vp) G.vpeers.delete(vp.id);
  if (again) { G.fwdAsk.delete(vp.id); if (G.focus === vp.id && !G.peers.get(vp.id)?.connected) G.focus = null; }
  grpRender();
}

/* ---------- события группы ---------- */
// прямая связь подтвердилась — мост больше не нужен
function grpFwdDirectUp(id) {
  G.firstTry.delete(id);
  G.fwdAsk.delete(id);
  const vp = G.vpeers.get(id);
  if (vp) {
    const h = G.peers.get(vp.via);
    if (h?.connected) grpSend(h, { t: 'fwd-off', a: grpMe(), b: id });
    grpVpClose(vp);
    L('grp', { fwd: 'direct', other: id.slice(0, 8) });
  }
  grpSendLinks();
}
// связь с участником пропала: я H — его мосты закрываются; он был мостом — ищу другой
function grpFwdPeerDown(id) {
  for (const [key, br] of G.bridges) if (br.a === id || br.b === id) grpFwdClose(key, 'участник пропал');
  for (const vp of [...G.vpeers.values()]) if (vp.via === id) grpVpClose(vp, true);
  grpSendLinks();
}
function grpFwdMemberGone(id) {
  grpFwdPeerDown(id);
  const vp = G.vpeers.get(id);
  if (vp) grpVpClose(vp);
  G.firstTry.delete(id);
  G.fwdAsk.delete(id);
}
function grpFwdReset() {
  for (const key of [...G.bridges.keys()]) grpFwdClose(key, 'выход', false);
  for (const vp of [...G.vpeers.values()]) grpVpClose(vp);
  G.fwdAsk.clear();
  G.firstTry.clear();
}
// сообщения моста по каналу 'g' (возвращает true, если это они)
function grpFwdOnData(p, d) {
  switch (d.t) {
    case 'glinks': p.links = new Set((Array.isArray(d.ids) ? d.ids : []).filter((x) => ID_RE.test(String(x)))); return true;
    case 'fwd-req': grpFwdOnReq(p, d); return true;
    case 'fwd-on': grpFwdOnOn(p, d); return true;
    case 'fwd-no': { const other = String(d.a) === grpMe() ? String(d.b) : String(d.a); const ask = G.fwdAsk.get(other); if (ask?.h === p.id) ask.at = 0; L('grp', { fwd: 'no', why: String(d.why || '').slice(0, 40) }); return true; }
    case 'fwd-off':
      if (G.bridges.has(bKey(String(d.a), String(d.b)))) grpFwdClose(bKey(String(d.a), String(d.b)), 'не нужен');
      else grpFwdOnOff(p, d);
      return true;
    case 'fwd-offer': grpFwdOnOffer(p, d); return true;
    case 'fwd-answer': grpFwdOnAnswer(p, d); return true;
    case 'fwd': {
      if (d.to) { grpFwdData(p, d); return true; } // я H
      const vp = G.vpeers.get(String(d.from || ''));
      if (vp && vp.via === p.id && d.d && typeof d.d === 'object' && FWD_TYPES.has(d.d.t)) grpOnData(vp, d.d);
      return true;
    }
    default: return false;
  }
}
