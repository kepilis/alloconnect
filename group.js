'use strict';

/* =========================================================
   ТЕСТ (ветка test/multicall): групповой звонок до GRP_MAX человек.
   Сетка «каждый с каждым»: у каждой пары своё RTCPeerConnection —
   трансиверы: 0 голос, 1 экран (видео), 2 звук экрана; каналы: 0 'g' (чат, состояние, пересылка записок), 1 'files'.
   Главного нет: звать может любой участник своих друзей. Записки для соединения идут по каналу друзей,
   а если двое не друзья — через участника, с которым уже есть связь (по его каналу 'g' или каналу друзей).
   Связь с участником пропала — соединение пересоздаётся (до GRP_RECONNECT_FOR).
   Звонок на двоих этот модуль не трогает; пока идёт группа, обычные звонки получают «занят».
   ========================================================= */
const GRP_MAX = 6;
const GRP_RECONNECT_FOR = 75000;
const G = {
  active: false, gid: null,
  members: new Map(),   // id → { id, nick, via } (вместе со мной); via — кто позвал
  seen: new Set(),      // с кем уже была связь
  left: new Set(),      // ушедшие — чтобы чужой старый список их не вернул
  peers: new Map(),     // id → соединение с участником
  connecting: new Set(),
  lostAt: new Map(),    // id → когда пропала связь (переподключаемся)
  tiles: new Map(),     // id → плитка
  nickCache: new Map(), // ники бывших участников из истории
  conv: null, invite: null, share: null, focus: null, joinTimer: null, stopMyMeter: null,
};

const grpMe = () => myIdent?.id || '';
// ID группы — как ID друга (43 знака): по нему же хранится история чата группы
const grpGid = (x) => (ID_RE.test(String(x || '')) ? String(x) : '');
const grpNewGid = () => b64uBytes(crypto.getRandomValues(new Uint8Array(32)));
const grpClean = (s, n = 24) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function grpNick(id) {
  if (id === 'me' || id === grpMe()) return S.nick || 'Я';
  return friendsList.find((f) => f.id === id)?.nick || G.members.get(id)?.nick || G.nickCache.get(id) || 'Участник';
}
function grpRosterList() { return [...G.members.values()].map((m) => ({ id: m.id, nick: m.nick, via: m.via || '' })); }
function grpBusy() { return G.active || S.inCall || S.busy || !!S.pc || !!S.friendCall; }
const grpOpen = (id) => G.peers.get(id)?.dc.readyState === 'open';

function grpAddMember(m, force) {
  const id = String(m?.id || '');
  if (!ID_RE.test(id) || id === grpMe()) return false;
  if (G.left.has(id) && !force) return false;
  if (force) G.left.delete(id);
  const via = ID_RE.test(String(m.via || '')) ? m.via : '';
  const ex = G.members.get(id);
  if (ex) { if (!ex.via && via) ex.via = via; return false; }
  if (G.members.size >= GRP_MAX + 2) return false; // защита от чужого раздутого списка
  G.members.set(id, { id, nick: grpClean(m.nick) || 'Участник', via });
  return true;
}
function grpMergeRoster(list) {
  let added = false;
  for (const m of (Array.isArray(list) ? list : []).slice(0, GRP_MAX + 2)) added = grpAddMember(m) || added;
  grpRender();
  grpSyncPeers();
}

/* ---------- Позвать друзей ---------- */
function grpOpenPick() {
  if (!myIdent) { toast('Сеть друзей ещё не готова'); return; }
  if (!G.active && grpBusy()) { toast('Сначала заверши звонок'); return; }
  const list = $('gPickList');
  list.innerHTML = '';
  const room = GRP_MAX - (G.active ? G.members.size : 1);
  const cands = [...friendsList].filter((f) => !G.members.has(f.id)).sort((a, b) => (b.online - a.online) || a.nick.localeCompare(b.nick));
  if (!cands.length) list.innerHTML = '<p class="muted small">Некого звать — все друзья уже здесь</p>';
  for (const f of cands) {
    const row = document.createElement('label');
    row.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = f.id;
    cb.disabled = !f.online;
    const t = document.createElement('span');
    t.textContent = f.nick + (f.online ? '' : ' — не в сети');
    row.append(cb, t);
    list.appendChild(row);
  }
  $('gPickNote').textContent = `Можно позвать ещё ${Math.max(0, room)} (всего до ${GRP_MAX} человек, считая тебя)`;
  $('gPick').classList.remove('hidden');
}

async function grpPickGo() {
  const ids = [...$('gPickList').querySelectorAll('input:checked')].map((x) => x.value);
  $('gPick').classList.add('hidden');
  if (!ids.length) return;
  if (!G.active && !(await grpStart())) return;
  grpInvite(ids.slice(0, Math.max(0, GRP_MAX - G.members.size)));
}

async function grpStart(gid) {
  if (grpBusy()) return false;
  if (!(await prepare())) return false;
  grpReset();
  G.active = true;
  G.gid = grpGid(gid) || grpNewGid();
  G.members.set(grpMe(), { id: grpMe(), nick: S.nick, via: '' });
  L('grp', { start: true });
  grpEnterUi();
  if (!gid) sysMsg('Групповой звонок создан. Позови друзей — «➕ Позвать».', G.conv);
  return true;
}

function grpInvite(ids) {
  for (const id of ids) {
    const nick = grpNick(id);
    sysMsg(`Зову ${nick}…`, G.conv);
    window.duo.friendsSend(id, { t: 'grp-invite', gid: G.gid, nick: S.nick, members: grpRosterList() }).then((r) => {
      if (!r.ok && G.active) sysMsg(`${nick} не отвечает — не в сети?`, G.conv);
    });
  }
}

/* ---------- Входящее приглашение ---------- */
function grpOnInvite(id, msg, nick) {
  const gid = grpGid(msg.gid);
  if (!gid || G.invite?.gid === gid) return; // повтор
  if (G.active && G.gid === gid) {
    // эту же группу (из сохранённых) собрал кто-то ещё — соединяем обе половины
    if (!G.peers.get(id)?.connected) {
      grpAddMember({ id, nick, via: '' }, true);
      window.duo.friendsSend(id, { t: 'grp-roster', gid, members: grpRosterList() });
      grpSendAll({ t: 'member', id, nick, via: grpMe() });
      grpRender();
      grpSyncPeers();
    }
    return;
  }
  if (grpBusy() || G.invite) { window.duo.friendsSend(id, { t: 'grp-busy', gid }); return; }
  const members = (Array.isArray(msg.members) ? msg.members : []).filter((m) => ID_RE.test(String(m?.id || ''))).slice(0, GRP_MAX)
    .map((m) => ({ id: m.id, nick: grpClean(m.nick) || 'Участник', via: ID_RE.test(String(m.via || '')) ? m.via : '' }));
  if (!members.some((m) => m.id === id)) members.unshift({ id, nick, via: '' });
  G.invite = { id, gid, nick, members };
  $('gInvTitle').textContent = `${nick} зовёт в групповой звонок`;
  $('gInvSub').textContent = 'Уже там: ' + members.map((m) => (friendsList.find((f) => f.id === m.id)?.nick || m.nick)).join(', ');
  $('gInvModal').classList.remove('hidden');
  startRing();
  window.duo.focusWindow();
  window.duo.notify({ title: `${nick} зовёт в групповой звонок`, body: 'alloconnect', kind: 'call' });
  G.invite.timer = setTimeout(() => { if (G.invite?.gid === gid) grpDeclineInvite(`Пропущен групповой звонок от ${nick}`); }, 40000);
}

function grpCloseInvite() {
  if (G.invite) clearTimeout(G.invite.timer);
  G.invite = null;
  $('gInvModal').classList.add('hidden');
  stopRing();
}

function grpDeclineInvite(text) {
  const inv = G.invite;
  if (!inv) return;
  window.duo.friendsSend(inv.id, { t: 'grp-decline', gid: inv.gid });
  grpCloseInvite();
  if (text) toast(text);
}

async function grpAcceptInvite() {
  const inv = G.invite;
  if (!inv) return;
  grpCloseInvite();
  if (grpBusy()) return;
  if (!(await prepare())) return;
  grpReset();
  G.active = true;
  G.gid = inv.gid;
  G.members.set(grpMe(), { id: grpMe(), nick: S.nick, via: inv.id });
  // кого прислал позвавший — до них пока доходим через него
  for (const m of inv.members) grpAddMember({ ...m, via: m.via || (m.id === inv.id ? '' : inv.id) });
  L('grp', { join: true, members: G.members.size });
  grpEnterUi();
  sysMsg('Подключаюсь к группе…', G.conv);
  const r = await window.duo.friendsSend(inv.id, { t: 'grp-join', gid: inv.gid, nick: S.nick });
  if (!r.ok && G.gid === inv.gid) { grpLeave(`${inv.nick} не отвечает`); return; }
  G.joinTimer = setTimeout(() => { if (G.active && G.gid === inv.gid && ![...G.peers.values()].some((p) => p.connected)) grpLeave('Группа не ответила'); }, 30000);
}

/* ---------- Канал друзей ---------- */
function grpOnFriendMsg(id, msg, f, nick) {
  if (msg.t === 'grp-invite') { if (f) grpOnInvite(id, msg, nick); return; }
  if (!G.active || grpGid(msg.gid) !== G.gid) return;
  switch (msg.t) {
    case 'grp-join': // друг принял моё приглашение
      if (!f) return;
      if (G.members.size >= GRP_MAX && !G.members.has(id)) { window.duo.friendsSend(id, { t: 'grp-full', gid: G.gid }); return; }
      grpAddMember({ id, nick: grpClean(msg.nick) || nick, via: grpMe() }, true);
      window.duo.friendsSend(id, { t: 'grp-roster', gid: G.gid, members: grpRosterList() });
      grpSendAll({ t: 'member', id, nick: G.members.get(id).nick, via: grpMe() });
      grpRender();
      grpSyncPeers();
      return;
    case 'grp-decline': sysMsg(`${nick} отказался`, G.conv); return;
    case 'grp-busy': sysMsg(`${nick} сейчас занят`, G.conv); return;
    case 'grp-full': if (id === G.members.get(grpMe())?.via) grpLeave('В группе уже нет мест'); return;
    case 'grp-roster': if (f || G.members.has(id)) { grpAddMember({ id, nick, via: '' }, true); grpMergeRoster(msg.members); } return;
    case 'grp-leave': if (G.members.has(id)) { grpMemberGone(id, 'вышел'); grpSendAll({ t: 'gone', id }); } return;
    case 'grp-relay': if (G.members.has(id)) grpRelay(id, msg); return;
    case 'grp-sig': grpOnSig(id, msg, !!f); return;
    default:
  }
}

/* ---------- Записки для соединения ---------- */
// отправить записку участнику: напрямую другу, иначе через того, кто с ним на связи
function grpSig(to, payload, tries = 0) {
  const msg = { kind: payload.kind, pid: payload.pid, sdp: payload.sdp, nick: S.nick };
  if (isFriend(to)) return window.duo.friendsSend(to, { t: 'grp-sig', gid: G.gid, ...msg });
  const me = grpMe();
  const cands = [...new Set([G.members.get(to)?.via, G.members.get(me)?.via, ...[...G.peers.values()].filter((p) => p.connected).map((p) => p.id)])]
    .filter((r) => r && r !== me && r !== to && G.members.has(r) && (grpOpen(r) || isFriend(r)));
  if (!cands.length) return Promise.resolve({ ok: false, error: 'нет пути' });
  const r = cands[tries % cands.length];
  L('grp', { relayVia: r.slice(0, 8), to: to.slice(0, 8), kind: msg.kind });
  if (grpOpen(r)) { grpSend(G.peers.get(r), { t: 'relay', to, ...msg }); return Promise.resolve({ ok: true }); }
  return window.duo.friendsSend(r, { t: 'grp-relay', gid: G.gid, to, ...msg });
}

// я посредник: передаю записку от from к to
function grpRelay(from, msg) {
  const to = String(msg.to || '');
  if (!G.members.has(to) || to === grpMe() || to === from) return;
  const out = { from, nick: G.members.get(from)?.nick || grpClean(msg.nick), kind: msg.kind, pid: msg.pid, sdp: msg.sdp };
  if (grpOpen(to)) grpSend(G.peers.get(to), { t: 'sig', ...out });
  else if (isFriend(to)) window.duo.friendsSend(to, { t: 'grp-sig', gid: G.gid, ...out });
}

// записка пришла: сам автор (друг) или пересланная участником (from)
function grpOnSig(sender, msg, senderIsFriend) {
  let from = sender;
  if (msg.from) {
    if (!G.members.has(sender)) return; // пересылать может только участник
    from = String(msg.from);
  } else if (!senderIsFriend && !G.members.has(sender)) return;
  if (!ID_RE.test(from) || from === grpMe()) return;
  if (!G.members.has(from)) grpAddMember({ id: from, nick: msg.nick, via: msg.from ? sender : '' }, true);
  if (msg.kind === 'offer') grpAnswer(from, msg);
  else if (msg.kind === 'answer') grpOnAnswer(from, msg);
}

// пара соединяется один раз: звонит тот, у кого ID больше
function grpSyncPeers() {
  for (const id of G.members.keys()) {
    if (id === grpMe() || G.peers.has(id) || G.connecting.has(id)) continue;
    if (grpMe() > id) grpConnect(id);
  }
}

/* ---------- Соединение с одним участником ---------- */
function grpMakePeer(id, pid, role, cfg) {
  const p = { id, pid, role, connected: false, sharing: false, shareName: '', muted: false, deaf: false, lvl: 0 };
  const pc = new RTCPeerConnection(cfg);
  p.pc = pc;
  p.dc = pc.createDataChannel('g', { negotiated: true, id: 0, ordered: true });
  p.dc.onopen = () => grpPeerOpen(p);
  p.dc.onclose = () => grpPeerLost(p, 'связь прервалась');
  p.dc.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch { return; } grpOnData(p, d); };
  const fdc = pc.createDataChannel('files', { negotiated: true, id: 1, ordered: true });
  p.chan = new FileChan(fdc, () => grpConvOf(id), {
    chatIn: (conv, meta) => { grpFixWho(fmid(meta.fid), id); sound('msg'); if (!document.hasFocus()) window.duo?.attention(); },
    avatar: (b, m) => { if (isFriend(id)) onAvatarFile(id, b, m).then(() => grpPaintAvatar(id)); },
  });
  pc.ontrack = (e) => grpOnTrack(p, e);
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState;
    L('grp', { peer: id.slice(0, 8), state: st });
    clearTimeout(p.discTimer);
    if (st === 'failed') grpPeerLost(p, 'связь прервалась');
    else if (st === 'disconnected') p.discTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') grpPeerLost(p, 'связь прервалась'); }, 6000);
  });
  if (role === 'out') {
    p.atx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.vtx = pc.addTransceiver('video', { direction: 'sendrecv' });
    p.satx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    grpAttachSenders(p);
  }
  G.peers.set(id, p);
  return p;
}

function grpAttachSenders(p) {
  const ok = p.connected; // пока участник не подтвердил свой ID, ему ничего не шлём
  p.atx?.sender.replaceTrack(ok ? micSendTrack() : null).catch(() => {});
  p.vtx?.sender.replaceTrack(ok ? G.share?.track || null : null).catch(() => {});
  p.satx?.sender.replaceTrack(ok ? G.share?.atrack || null : null).catch(() => {});
}

function grpSend(p, obj) { try { if (p?.dc.readyState === 'open') p.dc.send(JSON.stringify(obj)); } catch { /* */ } }
function grpSendAll(obj) { for (const p of G.peers.values()) grpSend(p, obj); }
const grpSdp = (pc) => opusStereo(minifySdp(pc.localDescription.sdp));

async function grpConnect(id, tries = 0) {
  if (!G.active || G.peers.has(id) || G.connecting.has(id) || !G.members.has(id)) return;
  G.connecting.add(id);
  const gid = G.gid;
  const pid = newMid();
  let p = null;
  try {
    const res = await gatherWithFallback('grp', (cfg) => {
      if (p) grpClosePeer(p);
      p = grpMakePeer(id, pid, 'out', cfg);
      p.tries = tries;
      return p.pc;
    }, async (pc) => { await pc.setLocalDescription(await pc.createOffer()); }, (pc) => G.peers.get(id)?.pc === pc);
    if (!res || G.gid !== gid || G.peers.get(id) !== p) return;
    const r = await grpSig(id, { kind: 'offer', pid, sdp: grpSdp(p.pc) }, tries);
    if (!r.ok) { grpPeerLost(p, 'не удалось передать вызов'); return; }
    p.timer = setTimeout(() => { if (!p.connected) grpPeerLost(p, 'не удалось соединиться'); }, 20000);
  } catch (e) {
    L('grp', { connectFailed: e.message });
    if (p) grpPeerLost(p, 'ошибка соединения');
  } finally { G.connecting.delete(id); }
}

async function grpAnswer(from, msg) {
  if (!/^v=0/.test(String(msg.sdp || ''))) return;
  const pid = cleanMid(msg.pid);
  const ex = G.peers.get(from);
  if (ex) { if (ex.pid === pid) return; grpClosePeer(ex); } // новый вызов от него — прежнее соединение уже не нужно
  const gid = G.gid;
  let p = null;
  try {
    const res = await gatherWithFallback('grp', (cfg) => {
      if (p) grpClosePeer(p);
      p = grpMakePeer(from, pid, 'in', cfg);
      return p.pc;
    }, async (pc) => {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      [p.atx, p.vtx, p.satx] = pc.getTransceivers();
      for (const t of [p.atx, p.vtx, p.satx]) if (t) t.direction = 'sendrecv';
      grpAttachSenders(p);
      await pc.setLocalDescription(await pc.createAnswer());
    }, (pc) => G.peers.get(from)?.pc === pc, { answer: true });
    if (!res || G.gid !== gid || G.peers.get(from) !== p) return;
    const r = await grpSig(from, { kind: 'answer', pid, sdp: grpSdp(p.pc) });
    if (!r.ok) { grpPeerLost(p, 'не удалось ответить'); return; }
    p.timer = setTimeout(() => { if (!p.connected) grpPeerLost(p, 'не удалось соединиться'); }, 20000);
  } catch (e) {
    L('grp', { answerFailed: e.message });
    if (p) grpPeerLost(p, 'ошибка соединения');
  }
}

async function grpOnAnswer(from, msg) {
  const p = G.peers.get(from);
  if (!p || p.role !== 'out' || p.pid !== cleanMid(msg.pid) || p.pc.signalingState !== 'have-local-offer') return;
  try { await p.pc.setRemoteDescription({ type: 'answer', sdp: String(msg.sdp || '') }); } catch (e) { L('grp', { applyFailed: e.message }); grpPeerLost(p, 'ошибка соединения'); }
}

function grpClosePeer(p) {
  if (G.peers.get(p.id) === p) G.peers.delete(p.id);
  p.closed = true;
  clearTimeout(p.timer);
  clearTimeout(p.discTimer);
  p.stopMeter?.();
  for (const n of [p.src, p.gain, p.ssrc, p.sgain]) { try { n?.disconnect(); } catch { /* */ } }
  if (p.audioEl) p.audioEl.srcObject = null;
  if (p.saudioEl) p.saudioEl.srcObject = null;
  p.chan?.fail('связь прервалась');
  try { p.dc.close(); } catch { /* */ }
  try { p.pc.close(); } catch { /* */ }
}

function grpPeerLost(p, why) {
  if (p.closed || G.peers.get(p.id) !== p) return;
  const was = p.connected;
  grpClosePeer(p);
  L('grp', { lost: why, was, tries: p.tries || 0 });
  if (!G.active || !G.members.has(p.id)) return;
  if (!G.lostAt.has(p.id)) {
    G.lostAt.set(p.id, Date.now());
    if (was) { sysMsg(`Связь с ${grpNick(p.id)} прервалась — переподключаюсь…`, G.conv); sound('leave'); }
  }
  grpRender();
  // переподключение: звонит тот, у кого ID больше; второй ждёт его вызова
  const since = Date.now() - G.lostAt.get(p.id);
  if (since > GRP_RECONNECT_FOR) { grpMemberGone(p.id, G.seen.has(p.id) ? 'потерялся — связь не восстановилась' : 'не смог подключиться'); return; }
  const tries = (p.tries || 0) + 1;
  if (grpMe() > p.id) setTimeout(() => grpConnect(p.id, tries), Math.min(8000, 1500 * tries));
  else {
    clearTimeout(G.lostTimer?.[p.id]);
    G.lostTimer = G.lostTimer || {};
    G.lostTimer[p.id] = setTimeout(() => {
      if (G.active && G.members.has(p.id) && !G.peers.get(p.id)?.connected && Date.now() - (G.lostAt.get(p.id) || Date.now()) > GRP_RECONNECT_FOR) grpMemberGone(p.id, 'потерялся — связь не восстановилась');
    }, GRP_RECONNECT_FOR + 2000);
  }
}

function grpMemberGone(id, why) {
  if (!G.members.has(id) || id === grpMe()) return;
  const known = G.seen.has(id);
  G.members.delete(id);
  G.left.add(id);
  G.lostAt.delete(id);
  const p = G.peers.get(id);
  if (p) grpClosePeer(p);
  if (G.focus === id) G.focus = null;
  if (known && G.active) { sysMsg(`${grpNick(id)} ${why}`, G.conv); sound('leave'); }
  grpRender();
}

// Записки могли прийти через посредника — поэтому каждый доказывает, что ID его (как в звонке по коду, 1.15.1):
// ключ пары вычисляется из двух ID и без дружбы, посчитать ответ могут только двое.
function grpPeerOpen(p) {
  if (p.closed) return;
  p.ch = b64uBytes(crypto.getRandomValues(new Uint8Array(18)));
  grpSend(p, { t: 'ch', ch: p.ch });
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { if (!p.connected) grpRejectPeer(p, 'не подтвердил свой ID'); }, 15000);
}
function grpBinding(pc) {
  const fps = (sdp) => [...String(sdp || '').matchAll(/^a=fingerprint:(.+)$/gm)].map((m) => m[1].trim().toLowerCase());
  const all = [...new Set([...fps(pc.localDescription?.sdp), ...fps(pc.remoteDescription?.sdp)])].sort();
  return all.length >= 2 ? all.join('|') : '';
}
async function grpOnCh(p, d) {
  if (typeof d.ch !== 'string' || d.ch.length < 16 || d.ch.length > 64) return;
  const bind = grpBinding(p.pc);
  const mac = bind ? await window.duo.friendsProof(p.id, grpMe(), d.ch, bind).catch(() => null) : null;
  if (mac) grpSend(p, { t: 'proof', mac });
}
async function grpOnProof(p, d) {
  if (p.connected || !p.ch || typeof d.mac !== 'string') return;
  const bind = grpBinding(p.pc);
  const want = bind ? await window.duo.friendsProof(p.id, p.id, p.ch, bind).catch(() => null) : null;
  if (p.closed || p.connected) return;
  if (want && want === d.mac) grpVerified(p);
  else grpRejectPeer(p, 'выдаёт себя за другого (ключ не его)');
}
function grpRejectPeer(p, why) {
  if (p.closed) return;
  L('grp', { rejected: p.id.slice(0, 8), why });
  sysMsg(`⚠ Участник «${grpNick(p.id)}» ${why} — отключён`, G.conv);
  G.members.delete(p.id);
  G.left.add(p.id);
  G.lostAt.delete(p.id);
  grpClosePeer(p);
  grpRender();
}

function grpVerified(p) {
  p.connected = true;
  grpAttachSenders(p);
  if (p.gain) p.gain.gain.value = grpVol(p.id) / 100;
  if (p.sgain) p.sgain.gain.value = grpVol(p.id, 'gsvol') / 100;
  G.seen.add(p.id);
  clearTimeout(p.timer);
  clearTimeout(G.joinTimer);
  const back = G.lostAt.has(p.id);
  G.lostAt.delete(p.id);
  grpSend(p, { t: 'hello', nick: S.nick, muted: S.muted, deaf: S.deafened, sharing: !!G.share, name: G.share?.name || '', av: myAvatar?.hash || '', members: grpRosterList() });
  if (G.share) grpTuneAll();
  if (spHighBr) grpMicBitrate(128_000);
  L('grp', { open: p.id.slice(0, 8), peers: G.peers.size, back });
  sysMsg(back ? `${grpNick(p.id)} снова на связи` : `${grpNick(p.id)} в звонке`, G.conv);
  sound('join');
  grpSaveCurrent();
  grpRender();
  for (const d of (p.queue || []).splice(0)) grpOnData(p, d);
}

function grpOnData(p, d) {
  if (p.closed || !d || typeof d.t !== 'string') return;
  if (d.t === 'ch') { grpOnCh(p, d); return; }
  if (d.t === 'proof') { grpOnProof(p, d); return; }
  if (!p.connected) { p.queue = p.queue || []; if (p.queue.length < 50) p.queue.push(d); return; } // до подтверждения ID — ждём
  switch (d.t) {
    case 'hello':
      if (!isFriend(p.id) && G.members.has(p.id)) G.members.get(p.id).nick = grpClean(d.nick) || G.members.get(p.id).nick;
      p.muted = !!d.muted; p.deaf = !!d.deaf;
      grpOnScreen(p, !!d.sharing, d.name);
      if (isFriend(p.id)) onPeerAvatarHash(p.id, String(d.av || '').slice(0, 32), () => grpSend(p, { t: 'av-want' })).then(() => grpPaintAvatar(p.id)).catch(() => {});
      grpMergeRoster(d.members);
      grpRender();
      return;
    case 'av-want': { const f = myAvatarFile(); if (f) p.chan.queue([f], 'avatar'); return; }
    case 'member': if (grpAddMember({ id: d.id, nick: d.nick, via: d.via || p.id }, true)) { grpRender(); grpSyncPeers(); } return;
    case 'gone': if (d.id !== grpMe() && G.members.has(d.id) && !grpOpen(d.id)) grpMemberGone(d.id, 'вышел'); return;
    case 'relay': grpRelay(p.id, d); return;
    case 'sig': grpOnSig(p.id, d, false); return;
    case 'state': p.muted = !!d.muted; p.deaf = !!d.deaf; grpRender(); return;
    case 'screen': grpOnScreen(p, !!d.on, d.name); grpRender(); return;
    case 'chat': {
      const text = String(d.text || '').slice(0, 2000);
      if (!text) return;
      const mid = cleanMid(d.mid) || newMid();
      let re = reIn(d.re);
      if (re) re.by = d.re.mine ? p.id : (G.conv.msgs.get(re.mid)?.e.who || 'peer');
      const ts = Number(d.ts) || Date.now();
      chatMsg(G.conv, grpNick(p.id), text, false, ts, null, { mid, re, who: p.id });
      record(G.conv, { mid, ts, who: p.id, nick: grpNick(p.id), type: 'text', text, re: re || undefined });
      sound('msg');
      if (!document.hasFocus()) window.duo?.attention();
      return;
    }
    case 'chat-op': applyOp(G.conv, d, p.id); return;
    case 'bye': grpMemberGone(p.id, 'вышел'); grpSendAll({ t: 'gone', id: p.id }); return;
    default:
  }
}

// чьё сообщение: в группе вместо 'peer' — ID автора (править и удалять он может только свои)
function grpFixWho(mid, id) { const it = G.conv?.msgs.get(mid); if (it && it.e.who === 'peer') it.e.who = id; }
// разговор для файлов от участника: общий, но с его ником в пузырях
function grpConvOf(id) { return G.conv ? Object.create(G.conv, { nick: { value: grpNick(id) }, whoId: { value: id } }) : null; }

function grpOnScreen(p, on, name) {
  const was = p.sharing;
  p.sharing = on;
  p.shareName = grpClean(name, 60);
  if (on && !was) { sysMsg(`${grpNick(p.id)} показывает экран${p.shareName ? ' — ' + p.shareName : ''}`, G.conv); if (!G.focus) G.focus = p.id; }
  if (!on && G.focus === p.id) G.focus = null;
}

function grpOnTrack(p, e) {
  const t = e.track;
  const idx = p.pc.getTransceivers().indexOf(e.transceiver);
  const c = audio();
  // Chromium отдаёт удалённый звук в WebAudio, только если поток привязан к элементу
  const bindEl = (stream) => { const el = new Audio(); el.srcObject = stream; el.muted = true; el.play().catch(() => {}); return el; };
  if (t.kind === 'video') { p.vstream = new MediaStream([t]); grpRender(); return; }
  if (idx === 2) { // звук экрана
    p.sastream = new MediaStream([t]);
    p.saudioEl = bindEl(p.sastream);
    p.ssrc = c.createMediaStreamSource(p.sastream);
    p.sgain = c.createGain();
    p.sgain.gain.value = p.connected ? grpVol(p.id, 'gsvol') / 100 : 0;
    p.ssrc.connect(p.sgain).connect(master);
    return;
  }
  p.astream = new MediaStream([t]);
  p.audioEl = bindEl(p.astream);
  p.src = c.createMediaStreamSource(p.astream);
  p.gain = c.createGain();
  p.gain.gain.value = p.connected ? grpVol(p.id) / 100 : 0;
  p.src.connect(p.gain).connect(master);
  p.stopMeter = makeMeter(p.astream, (lvl) => {
    p.lvl = lvl;
    G.tiles.get(p.id)?.classList.toggle('speaking', lvl > 0.02 && !S.deafened);
  });
}

/* ---------- Громкость каждого, микрофон, звук ---------- */
function grpVol(id, key = 'gvol') { const v = Number(store.get(key, {})[id]); return Number.isFinite(v) ? v : 100; }
function grpSetVol(id, v, key = 'gvol') {
  const all = store.get(key, {});
  all[id] = v;
  store.set(key, all);
  const p = G.peers.get(id);
  const g = key === 'gsvol' ? p?.sgain : p?.gain;
  if (g) g.gain.value = v / 100;
}
function grpMicBitrate(br) { for (const p of G.peers.values()) if (p.atx) tuneSender(p.atx.sender, { audio: br }); }

function grpSetMuted(v) {
  S.muted = v;
  applyMicEnabled();
  grpSendAll({ t: 'state', muted: S.muted, deaf: S.deafened });
  grpUpdateControls();
  sound(v ? 'mute' : 'unmute');
}
function grpSetDeafened(v) {
  S.deafened = v;
  if (master) master.gain.value = v ? 0 : 1;
  applyMicEnabled();
  grpSendAll({ t: 'state', muted: S.muted, deaf: S.deafened });
  grpUpdateControls();
  sound(v ? 'mute' : 'unmute');
}
function grpUpdateControls() {
  const micOff = S.muted || S.deafened;
  $('gMute').classList.toggle('off', micOff);
  $('gMute').querySelector('span').textContent = micOff ? 'Микрофон выкл' : 'Микрофон';
  $('gDeafen').classList.toggle('off', S.deafened);
  $('gDeafen').querySelector('span').textContent = S.deafened ? 'Звук выкл' : 'Звук';
  const ns = rnnOn();
  $('gNs').classList.toggle('on', ns);
  $('gNs').querySelector('span').textContent = ns ? 'Шумодав вкл' : 'Шумодав выкл';
  $('gShare').classList.toggle('on', !!G.share);
  $('gShare').querySelector('span').textContent = G.share ? 'Остановить показ' : 'Показать экран';
  $('gSoundpad').classList.toggle('on-pad', !$('soundpad').classList.contains('hidden'));
  grpRender();
}

// хоткеи (Ctrl+Shift+M/D/N, выход) во время группы
function grpHotkey(what) {
  if (what === 'leave') { grpLeave(); return true; }
  if (what === 'mute') { $('gMute').click(); return true; }
  if (what === 'deafen') { grpSetDeafened(!S.deafened); return true; }
  if (what === 'ns') { setNs(!(settings().rnn !== false)).then(grpUpdateControls); return true; }
  return false;
}

/* ---------- Файлы всем: одна отправка на каждого, один пузырь у меня ---------- */
function grpQueueFiles(list, p = 'chat') {
  const chans = [...G.peers.values()].filter((x) => x.connected).map((x) => x.chan);
  if (!chans.length) { toast('В группе пока никого нет на связи'); return; }
  for (const f of list) {
    if (!f) continue;
    if (f.size > MAX_FILE) { toast(`${f.name}: больше 2 ГБ — не отправлю`); continue; }
    const fid = crypto.getRandomValues(new Uint32Array(1))[0];
    const name = f.name || `картинка-${Date.now()}.${((f.type || '').split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const meta = { fid, name, size: f.size, mime: f.type || 'application/octet-stream', p, kind: fileKind(f.type || '') };
    const ui = fileBubble(G.conv, S.nick || 'Я', meta, true, { mid: fmid(fid) });
    ui.progress(0);
    const prog = new Array(chans.length).fill(0);
    let settled = 0, url = null, why = '';
    const settle = () => {
      if (++settled < chans.length) return;
      if (url) ui.done(url); else ui.fail(why || 'не дошло');
      if (url && why) sysMsg(`«${name}» дошёл не до всех: ${why}`, G.conv);
    };
    chans.forEach((ch, i) => ch.queue([f], p, { fid, ui: {
      progress(n) { prog[i] = n; ui.progress(Math.min(...prog)); },
      done(u) { if (!url) url = u; else URL.revokeObjectURL(u); settle(); },
      fail(w) { why = w; settle(); },
      loading() {}, gone() {},
    } }));
  }
}

/* ---------- Показ экрана в группу (видео + звук приложения/компьютера) ---------- */
function grpShareBr() {
  const n = Math.max(1, [...G.peers.values()].filter((p) => p.connected).length);
  return Math.max(1_500_000, Math.round(G.share.q.br / n)); // отдельная отправка каждому — делим канал
}
async function grpTuneAll() {
  if (!G.share) return;
  for (const p of G.peers.values()) {
    if (p.vtx) await tuneSender(p.vtx.sender, { video: { ...G.share.q, br: grpShareBr() }, mode: G.share.mode });
    if (p.satx && G.share.atrack) await tuneSender(p.satx.sender, { audio: 128_000 });
  }
}

async function grpBeginShare() {
  const qKey = $('quality').value;
  const mode = $('shareMode').value;
  const wantAudio = $('sysAudio').checked && S.platform === 'win32';
  store.set('settings', { ...settings(), quality: qKey, shareMode: mode, sysAudio: $('sysAudio').checked });
  $('picker').classList.add('hidden');
  const srcId = pickedId;
  const name = srcId.startsWith('window:') ? (pickerSources.find((x) => x.id === srcId)?.name || '').slice(0, 60) : '';
  let atrack = null, loopback = false;
  try {
    if (wantAudio) {
      const r = await window.duo.sysAudioStart(srcId);
      if (r.ok) atrack = await startPcmTrack();
      else { loopback = true; toast('Отдельный захват звука недоступен (' + r.error + ') — пойдёт весь звук компьютера'); }
    }
    const stream = await captureSource(srcId, QUALITY[qKey], mode, loopback);
    await grpShareStream(stream, { q: QUALITY[qKey], mode, name, atrack: atrack || stream.getAudioTracks()[0] || null });
  } catch (e) {
    console.warn('grp share', e);
    stopPcm();
    toast('Не удалось начать демонстрацию: ' + (e.message || e.name));
  }
}

async function grpShareStream(stream, { q = QUALITY['1080p30'], mode = 'game', name = '', atrack = null } = {}) {
  if (G.share) grpStopShare(true);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('нет видео');
  G.share = { stream, track, atrack, q, mode, name };
  track.addEventListener('ended', () => { if (G.share?.stream === stream) grpStopShare(); });
  for (const p of G.peers.values()) grpAttachSenders(p);
  await grpTuneAll();
  grpSendAll({ t: 'screen', on: true, name });
  L('grp', { share: true, peers: G.peers.size, audio: !!atrack });
  sound('stream');
  grpUpdateControls();
}

function grpStopShare(silent) {
  const sh = G.share;
  if (!sh) return;
  G.share = null;
  sh.stream.getTracks().forEach((t) => t.stop());
  stopPcm();
  for (const p of G.peers.values()) grpAttachSenders(p);
  grpSendAll({ t: 'screen', on: false });
  if (G.focus === grpMe()) G.focus = null;
  if (!silent) grpUpdateControls();
}

/* ---------- Экран группы ---------- */
function grpEnterUi() {
  closeDm();
  document.body.classList.add('grp-mode');
  $('lobby').classList.remove('active');
  $('group').classList.add('active');
  G.conv = { id: G.gid, nick: 'Группа', box: newConvBox(), loaded: false, histStart: null, unread: 0, blobs: [], pending: [], msgs: new Map(), nickOf: (w) => grpNick(w) };
  mountConv(G.conv, $('gMessages'));
  grpLoadHistory(G.conv);
  G.tiles.clear();
  $('gGrid').innerHTML = '';
  G.stopMyMeter?.();
  G.stopMyMeter = makeMeter(S.mic, (lvl) => G.tiles.get(grpMe())?.classList.toggle('speaking', lvl > 0.02 && !S.muted && !S.deafened));
  grpUpdateControls();
}

async function grpLoadHistory(conv) {
  const r = await window.duo.histLoad(conv.id, 500).catch(() => null);
  for (const e of r?.items || []) if (e.who && e.who !== 'me' && e.nick && !G.nickCache.has(e.who)) G.nickCache.set(e.who, grpClean(e.nick));
  if (G.conv === conv) await loadHistory(conv);
}

/* ---------- Сохранённые группы: позвать тех же ещё раз, история чата общая ---------- */
function grpSaved() { const l = store.get('groups', []); return Array.isArray(l) ? l.filter((g) => grpGid(g?.gid) && Array.isArray(g.members)) : []; }
function grpSaveCurrent() {
  if (!G.active) return;
  const list = grpSaved();
  let g = list.find((x) => x.gid === G.gid);
  if (!g) { g = { gid: G.gid, members: [] }; list.unshift(g); }
  for (const m of G.members.values()) {
    if (m.id === grpMe() || !G.seen.has(m.id)) continue;
    const ex = g.members.find((x) => x.id === m.id);
    if (ex) ex.nick = m.nick; else g.members.push({ id: m.id, nick: m.nick });
  }
  g.members = g.members.slice(0, GRP_MAX + 4);
  g.last = Date.now();
  list.sort((a, b) => (b.last || 0) - (a.last || 0));
  store.set('groups', list.filter((x) => x.members.length).slice(0, 20));
  grpRenderSaved();
}
const grpSavedNick = (m) => friendsList.find((f) => f.id === m.id)?.nick || grpClean(m.nick) || 'Участник';

function grpRenderSaved() {
  const box = $('groupsBox');
  if (!box) return;
  const list = grpSaved().filter((g) => g.members.length);
  box.classList.toggle('hidden', !list.length);
  const el = $('groupsList');
  el.innerHTML = '';
  for (const g of list) {
    const online = g.members.filter((m) => friendsList.find((f) => f.id === m.id)?.online).length;
    const row = document.createElement('div');
    row.className = 'friend group-row' + (online ? ' online' : '');
    const av = document.createElement('div');
    av.className = 'favatar';
    av.textContent = '👥';
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = g.members.map(grpSavedNick).join(', ');
    name.title = name.textContent;
    const st = document.createElement('small');
    st.textContent = online ? `в сети из друзей: ${online}` : 'никого из друзей нет в сети';
    name.appendChild(st);
    const call = document.createElement('button');
    call.className = 'btn primary fcall';
    call.textContent = 'Собрать';
    call.title = 'Позвать этих же людей — с прежней историей чата';
    call.onclick = () => grpCallSaved(g.gid);
    const del = document.createElement('button');
    del.className = 'icon-btn fdel';
    del.title = 'Убрать группу и её историю';
    del.textContent = '✕';
    del.onclick = async () => {
      if (!confirm('Убрать эту группу и историю её чата? Только у тебя.')) return;
      store.set('groups', grpSaved().filter((x) => x.gid !== g.gid));
      await window.duo.histClear(g.gid).catch(() => {});
      grpRenderSaved();
    };
    row.append(av, name, call, del);
    el.appendChild(row);
  }
}

async function grpCallSaved(gid) {
  const g = grpSaved().find((x) => x.gid === gid);
  if (!g) return;
  const online = g.members.filter((m) => isFriend(m.id) && friendsList.find((f) => f.id === m.id)?.online);
  if (!online.length) { toast('Никого из друзей этой группы нет в сети'); return; }
  if (!(await grpStart(gid))) return;
  grpInvite(online.map((m) => m.id));
  const others = g.members.filter((m) => !isFriend(m.id)).map(grpSavedNick);
  if (others.length) sysMsg(`${others.join(', ')} — не у тебя в друзьях: их позовёт кто-то из группы («➕ Позвать»)`, G.conv);
}

function grpPaintAvatar(id) {
  const el = G.tiles.get(id);
  if (!el) return;
  (id === grpMe() ? Promise.resolve(myAvatar) : friendAvatar(id)).then((a) => paintAvatar(el.querySelector('.avatar'), a?.url)).catch(() => {});
}

function grpTile(id) {
  let el = G.tiles.get(id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'gtile';
  el.dataset.id = id;
  const v = document.createElement('video');
  v.autoplay = true; v.playsInline = true; v.muted = true;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.appendChild(document.createElement('span'));
  const nm = document.createElement('div');
  nm.className = 'gname';
  const n = document.createElement('span');
  const b = document.createElement('em');
  b.className = 'badges';
  nm.append(n, ' ', b);
  el.append(v, av, nm);
  if (id !== grpMe()) {
    const vols = document.createElement('div');
    vols.className = 'gvols';
    for (const [key, ico, title] of [['gvol', '🎙', 'Громкость голоса'], ['gsvol', '🖥', 'Громкость звука экрана']]) {
      const lab = document.createElement('label');
      lab.className = 'gv-' + key;
      lab.title = title;
      const r = document.createElement('input');
      r.type = 'range'; r.min = '0'; r.max = '200'; r.value = String(grpVol(id, key));
      r.oninput = () => grpSetVol(id, Number(r.value), key);
      lab.append(ico, r);
      lab.onclick = (e) => e.stopPropagation();
      lab.ondblclick = (e) => e.stopPropagation();
      vols.appendChild(lab);
    }
    el.appendChild(vols);
  }
  el.onclick = () => { if (el.classList.contains('sharing')) { G.focus = G.focus === id ? null : id; grpRender(); } };
  el.ondblclick = () => { if (el.classList.contains('sharing')) { if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {}); } };
  G.tiles.set(id, el);
  grpPaintAvatar(id);
  return el;
}

function grpRender() {
  if (!G.active) return;
  const grid = $('gGrid');
  const me = grpMe();
  const ids = [me, ...[...G.members.keys()].filter((id) => id !== me)];
  for (const [id, el] of G.tiles) if (!G.members.has(id) && id !== me) { el.remove(); G.tiles.delete(id); }
  ids.forEach((id, i) => {
    const el = grpTile(id);
    const p = G.peers.get(id);
    const mine = id === me;
    const on = mine || !!p?.connected;
    const sharing = mine ? !!G.share : !!(p?.connected && p.sharing);
    const v = el.querySelector('video');
    const want = sharing ? (mine ? G.share.stream : p.vstream || null) : null;
    if (v.srcObject !== want) v.srcObject = want;
    el.classList.toggle('sharing', sharing);
    el.classList.toggle('ghost', !on);
    el.classList.toggle('focused', G.focus === id);
    el.querySelector('.avatar span').textContent = initial(grpNick(id));
    el.querySelector('.gname span').textContent = grpNick(id) + (mine ? ' (я)' : '');
    const muted = mine ? S.muted || S.deafened : p?.muted || p?.deaf;
    const deaf = mine ? S.deafened : p?.deaf;
    const wait = on ? '' : G.lostAt.has(id) ? ' · переподключаюсь…' : ' · соединяюсь…';
    el.querySelector('.badges').textContent = (on && deaf ? '🔇' : '') + (on && muted ? '🎙̸' : '') + wait;
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
  });
  if (G.focus && !G.tiles.get(G.focus)?.classList.contains('sharing')) G.focus = null;
  grid.classList.toggle('focus', !!G.focus);
  const n = 1 + [...G.peers.values()].filter((p) => p.connected).length;
  $('gStatus').querySelector('span').textContent = `В звонке: ${n} из ${G.members.size}`;
  $('gStatus').className = 'status ' + (n > 1 ? 'ok' : 'waiting');
}

function grpReset() {
  G.members.clear(); G.left.clear(); G.seen.clear(); G.peers.clear(); G.connecting.clear(); G.lostAt.clear(); G.tiles.clear();
  for (const t of Object.values(G.lostTimer || {})) clearTimeout(t);
  G.lostTimer = {};
  G.nickCache.clear();
  G.gid = null; G.focus = null; G.conv = null; G.share = null;
}

function grpLeave(text) {
  if (!G.active) return;
  L('grp', { leave: text || 'self' });
  grpSendAll({ t: 'bye' });
  // до кого нет прямой связи — сообщаем по каналу друзей
  for (const id of G.members.keys()) if (id !== grpMe() && !grpOpen(id) && isFriend(id)) window.duo.friendsSend(id, { t: 'grp-leave', gid: G.gid });
  grpStopShare(true);
  spStopAll();
  $('soundpad').classList.add('hidden');
  const peers = [...G.peers.values()];
  G.active = false;
  clearTimeout(G.joinTimer);
  setTimeout(() => peers.forEach(grpClosePeer), 300); // даём «bye» уйти
  grpReset();
  G.stopMyMeter?.(); G.stopMyMeter = null;
  releaseMic();
  S.muted = false;
  S.deafened = false;
  if (master) master.gain.value = 1;
  for (const cp of [composers.grp]) setCompose(cp, null);
  document.body.classList.remove('grp-mode');
  $('gGrid').innerHTML = '';
  $('group').classList.remove('active');
  $('lobby').classList.add('active');
  showStep('stepHome');
  renderFriends();
  if (text) toast(text);
}

function grpBind() {
  $('btnGroup').onclick = grpOpenPick;
  $('gPickGo').onclick = grpPickGo;
  $('gPickClose').onclick = () => $('gPick').classList.add('hidden');
  $('gInviteMore').onclick = grpOpenPick;
  $('gInvAccept').onclick = grpAcceptInvite;
  $('gInvDecline').onclick = () => grpDeclineInvite();
  $('gMute').onclick = () => {
    if (S.deafened) { grpSetDeafened(false); if (S.muted) grpSetMuted(false); return; }
    grpSetMuted(!S.muted);
  };
  $('gDeafen').onclick = () => grpSetDeafened(!S.deafened);
  $('gNs').onclick = () => setNs(!(settings().rnn !== false)).then(grpUpdateControls);
  $('gShare').onclick = openPicker;
  $('gLeave').onclick = () => grpLeave();
  $('gSettings').onclick = openSettings;
  $('gSoundpad').onclick = () => {
    const p = $('soundpad');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) spLoadList();
    grpUpdateControls();
  };
  $('gAttach').onclick = () => $('gFileInput').click();
  $('gFileInput').onchange = (e) => { grpQueueFiles([...e.target.files]); e.target.value = ''; };
  $('gChatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('gChatInput').value.trim();
    if (!text || !G.active) return;
    if (composeSubmitEdit(composers.grp, G.conv, text)) return;
    const ts = Date.now();
    const mid = newMid();
    const re = composeTakeReply(composers.grp);
    grpSendAll({ t: 'chat', text, ts, mid, re: reOut(re) });
    chatMsg(G.conv, S.nick, text, true, ts, null, { mid, re });
    record(G.conv, { mid, ts, who: 'me', nick: S.nick, type: 'text', text, re: re || undefined });
    $('gChatInput').value = '';
  };
  window.addEventListener('beforeunload', () => { if (G.active) grpSendAll({ t: 'bye' }); });
}
grpBind();
