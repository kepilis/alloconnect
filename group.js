'use strict';

/* =========================================================
   ТЕСТ (ветка test/multicall): групповой звонок до GRP_MAX человек.
   Сетка «каждый с каждым»: у каждой пары своё RTCPeerConnection —
   трансиверы: 0 голос, 1 экран (видео), 2 звук экрана; каналы: 0 'g' (чат, состояние, пересылка записок), 1 'files',
   2 'ctl' и 3 'ctlu' — управление (как в звонке на двоих).
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
  lostTimers: new Map(), // id → таймер «потерялся» у того, кто ждёт вызова
  tiles: new Map(),     // id → плитка
  nickCache: new Map(), // ники бывших участников (из сохранённой группы) — для истории чата
  conv: null, invite: null, share: null, focus: null, joinTimer: null, stopMyMeter: null,
};

const grpMe = () => myIdent?.id || '';
// ID группы — как ID друга (43 знака): по нему же хранится история чата группы
const grpGid = (x) => (ID_RE.test(String(x || '')) ? String(x) : '');
const grpNewGid = () => b64uBytes(crypto.getRandomValues(new Uint8Array(32)));
const grpClean = (s, n = 24) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function grpNick(id) {
  if (id === 'me' || id === grpMe()) return S.nick || 'Я';
  return friendById(id)?.nick || G.members.get(id)?.nick || G.nickCache.get(id) || 'Участник';
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
// чужой список участников: добавить новых; соединиться со всеми, с кем ещё нет связи
function grpMergeRoster(list) {
  let added = false;
  for (const m of (Array.isArray(list) ? list : []).slice(0, GRP_MAX + 2)) added = grpAddMember(m) || added;
  grpSyncPeers();
  return added;
}
// принять в группу (позвал я или он собрал эту же группу сам): список ему, новость остальным
function grpAdmit(id, nick, via) {
  grpAddMember({ id, nick, via }, true);
  window.duo.friendsSend(id, { t: 'grp-roster', gid: G.gid, members: grpRosterList() });
  grpSendAll({ t: 'member', id, nick: G.members.get(id)?.nick || nick, via: grpMe() });
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

// войти в группу: новую (без gid), сохранённую или по приглашению (via — кто позвал)
async function grpStart(gid, via = '') {
  if (grpBusy() || !(await prepare())) return false;
  grpReset();
  G.active = true;
  G.gid = grpGid(gid) || grpNewGid();
  G.members.set(grpMe(), { id: grpMe(), nick: S.nick, via });
  for (const m of grpSaved().find((x) => x.gid === G.gid)?.members || []) G.nickCache.set(m.id, grpClean(m.nick));
  L('grp', { start: true, invited: !!via });
  grpEnterUi();
  if (!gid) sysMsg('Групповой звонок создан. Позови друзей — «➕ Позвать».');
  return true;
}

function grpInvite(ids) {
  for (const id of ids) {
    const nick = grpNick(id);
    sysMsg(`Зову ${nick}…`);
    window.duo.friendsSend(id, { t: 'grp-invite', gid: G.gid, nick: S.nick, members: grpRosterList() }).then((r) => {
      if (!r.ok && G.active) sysMsg(`${nick} не отвечает — не в сети?`);
    });
  }
}

/* ---------- Входящее приглашение ---------- */
function grpOnInvite(id, msg, nick) {
  const gid = grpGid(msg.gid);
  if (!gid || G.invite?.gid === gid) return; // повтор
  if (G.active && G.gid === gid) {
    // эту же группу (из сохранённых) собрал кто-то ещё — соединяем обе половины
    if (!G.peers.get(id)?.connected) grpAdmit(id, nick, '');
    return;
  }
  if (grpBusy() || G.invite) { window.duo.friendsSend(id, { t: 'grp-busy', gid }); return; }
  const members = (Array.isArray(msg.members) ? msg.members : []).filter((m) => ID_RE.test(String(m?.id || ''))).slice(0, GRP_MAX)
    .map((m) => ({ id: m.id, nick: grpClean(m.nick) || 'Участник', via: ID_RE.test(String(m.via || '')) ? m.via : '' }));
  if (!members.some((m) => m.id === id)) members.unshift({ id, nick, via: '' });
  G.invite = { id, gid, nick, members };
  $('gInvTitle').textContent = `${nick} зовёт в групповой звонок`;
  $('gInvSub').textContent = 'Уже там: ' + members.map(grpSavedNick).join(', ');
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
  if (!(await grpStart(inv.gid, inv.id))) return;
  // кого прислал позвавший — до них пока доходим через него
  for (const m of inv.members) grpAddMember({ ...m, via: m.via || (m.id === inv.id ? '' : inv.id) });
  grpRender();
  sysMsg('Подключаюсь к группе…');
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
      grpAdmit(id, grpClean(msg.nick) || nick, grpMe());
      return;
    case 'grp-decline': sysMsg(`${nick} отказался`); return;
    case 'grp-busy': sysMsg(`${nick} сейчас занят`); return;
    case 'grp-full': if (id === G.members.get(grpMe())?.via) grpLeave('В группе уже нет мест'); return;
    case 'grp-roster': if (f || G.members.has(id)) { grpAddMember({ id, nick, via: '' }, true); grpMergeRoster(msg.members); grpRender(); } return;
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
  const p = { id, pid, role, connected: false, sharing: false, muted: false, deaf: false, aud: {} };
  const pc = new RTCPeerConnection(cfg);
  p.pc = pc;
  p.dc = pc.createDataChannel('g', { negotiated: true, id: 0, ordered: true });
  p.dc.onopen = () => grpPeerOpen(p);
  p.dc.onclose = () => grpPeerLost(p, 'связь прервалась');
  p.dc.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch { return; } grpOnData(p, d); };
  const fdc = pc.createDataChannel('files', { negotiated: true, id: 1, ordered: true });
  p.chan = new FileChan(fdc, () => G.conv, {
    from: () => ({ who: id, nick: grpNick(id) }),
    chatIn: () => { sound('msg'); if (!document.hasFocus()) window.duo?.attention(); },
    avatar: (b, m) => { if (isFriend(id)) onAvatarFile(id, b, m).then(() => grpPaintAvatar(id)); },
  });
  p.cdc = pc.createDataChannel('ctl', { negotiated: true, id: 2, ordered: true });
  p.cdu = pc.createDataChannel('ctlu', { negotiated: true, id: 3, ordered: false, maxRetransmits: 0 });
  for (const ch of [p.cdc, p.cdu]) {
    ch.onmessage = (e) => {
      if (!p.connected || p.closed) return;
      let a;
      try { a = JSON.parse(e.data); } catch { return; }
      // ввод принимаю только от того, кому разрешил; ответы (вибрация, подсказки) — только от того, кем управляю
      if (Array.isArray(a) ? CS.on && CS.peer === p.id : CV.peer === p.id) onCtlMsg(a);
    };
  }
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
  if (G.peers.get(p.id) === p) { grpCtlGone(p.id, 'связь с участником пропала'); G.peers.delete(p.id); }
  p.closed = true;
  clearTimeout(p.timer);
  clearTimeout(p.discTimer);
  p.stopMeter?.();
  for (const a of Object.values(p.aud)) {
    try { a.src.disconnect(); a.gain.disconnect(); } catch { /* */ }
    a.el.srcObject = null;
  }
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
    if (was) { sysMsg(`Связь с ${grpNick(p.id)} прервалась — переподключаюсь…`); sound('leave'); }
  }
  grpRender();
  // переподключение: звонит тот, у кого ID больше; второй ждёт его вызова
  const since = Date.now() - G.lostAt.get(p.id);
  if (since > GRP_RECONNECT_FOR) { grpMemberGone(p.id, G.seen.has(p.id) ? 'потерялся — связь не восстановилась' : 'не смог подключиться'); return; }
  const tries = (p.tries || 0) + 1;
  if (grpMe() > p.id) setTimeout(() => grpConnect(p.id, tries), Math.min(8000, 1500 * tries));
  else {
    clearTimeout(G.lostTimers.get(p.id));
    G.lostTimers.set(p.id, setTimeout(() => {
      if (G.active && G.members.has(p.id) && !G.peers.get(p.id)?.connected) grpMemberGone(p.id, 'потерялся — связь не восстановилась');
    }, GRP_RECONNECT_FOR + 2000));
  }
}

function grpMemberGone(id, why, silent) {
  if (!G.members.has(id) || id === grpMe()) return;
  const known = G.seen.has(id) && !silent;
  G.members.delete(id);
  G.left.add(id);
  G.lostAt.delete(id);
  clearTimeout(G.lostTimers.get(id));
  G.lostTimers.delete(id);
  const p = G.peers.get(id);
  if (p) grpClosePeer(p);
  if (G.focus === id) G.focus = null;
  if (known && G.active) { sysMsg(`${grpNick(id)} ${why}`); sound('leave'); }
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
async function grpOnCh(p, d) {
  if (typeof d.ch !== 'string' || d.ch.length < 16 || d.ch.length > 64) return;
  const bind = callBinding(p.pc);
  const mac = bind ? await window.duo.friendsProof(p.id, grpMe(), d.ch, bind).catch(() => null) : null;
  if (mac) grpSend(p, { t: 'proof', mac });
}
async function grpOnProof(p, d) {
  if (p.connected || !p.ch || typeof d.mac !== 'string') return;
  const bind = callBinding(p.pc);
  const want = bind ? await window.duo.friendsProof(p.id, p.id, p.ch, bind).catch(() => null) : null;
  if (p.closed || p.connected) return;
  if (want && want === d.mac) grpVerified(p);
  else grpRejectPeer(p, 'выдаёт себя за другого (ключ не его)');
}
function grpRejectPeer(p, why) {
  if (p.closed) return;
  L('grp', { rejected: p.id.slice(0, 8), why });
  sysMsg(`⚠ Участник «${grpNick(p.id)}» ${why} — отключён`);
  grpClosePeer(p);
  grpMemberGone(p.id, why, true);
}

function grpVerified(p) {
  p.connected = true;
  grpAttachSenders(p);
  for (const key of Object.keys(p.aud)) grpApplyVol(p, key);
  G.seen.add(p.id);
  clearTimeout(p.timer);
  clearTimeout(G.joinTimer);
  const back = G.lostAt.has(p.id);
  G.lostAt.delete(p.id);
  clearTimeout(G.lostTimers.get(p.id));
  G.lostTimers.delete(p.id);
  grpSend(p, { t: 'hello', nick: S.nick, muted: S.muted, deaf: S.deafened, sharing: !!G.share, name: G.share?.name || '', perm: grpMyPerm(), av: myAvatar?.hash || '', members: grpRosterList() });
  if (G.share) grpTuneAll();
  if (spHighBr) grpMicBitrate(128_000);
  L('grp', { open: p.id.slice(0, 8), peers: G.peers.size, back });
  sysMsg(back ? `${grpNick(p.id)} снова на связи` : `${grpNick(p.id)} в звонке`);
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
      grpOnScreen(p, !!d.sharing, d.name, d.perm);
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
    case 'screen': grpOnScreen(p, !!d.on, d.name, d.perm); grpRender(); return;
    case 'gdraw': case 'gptr': case 'gptr-off': case 'gclear': case 'greact': grpOnMark(p, d); return;
    case 'ctl-req':
      if ((CS.on || CS.req) && CS.peer && CS.peer !== p.id) { grpSend(p, { t: 'ctl-deny', why: 'уже отдал управление другому участнику' }); return; }
      CS.peer = p.id;
      onCtlReq(d);
      if (!CS.on && !CS.req) CS.peer = null; // сразу отказал
      return;
    case 'ctl-grant': if (CV.peer === p.id && CV.state !== 'off') ctlViewStart(d); return;
    case 'ctl-deny':
      if (CV.peer === p.id && CV.state === 'req') { CV.state = 'off'; CV.peer = null; updateToolbar(); toast(`${grpNick(p.id)} ${String(d.why || 'отказал').slice(0, 60)}`); }
      return;
    case 'ctl-end': if (CV.peer === p.id) ctlViewStop(false, String(d.why || '').slice(0, 60) || `${grpNick(p.id)} забрал управление`); return;
    case 'ctl-stop': if (CS.peer === p.id) ctlEnd(`${grpNick(p.id)} отдал управление`, false); return;
    case 'view': {
      if (!['full', 'thumb', 'off'].includes(d.view) || p.view === d.view) return;
      const br = G.share && grpShareBr();
      p.view = d.view;
      L('grp', { view: d.view, peer: p.id.slice(0, 8) });
      // канал делится между смотрящими крупно: их стало больше или меньше — перенастроить всех
      if (G.share && grpShareBr() !== br) grpTuneAll(); else grpTuneVideo(p);
      return;
    }
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

function grpOnScreen(p, on, name, perm) {
  const was = p.sharing;
  p.sharing = on;
  p.perm = { draw: !!perm?.draw, react: !!perm?.react, ctl: !!perm?.ctl };
  const title = grpClean(name, 60);
  if (on && !was) { sysMsg(`${grpNick(p.id)} показывает экран${title ? ' — ' + title : ''}`); if (!G.focus) G.focus = p.id; }
  if (!on && G.focus === p.id) G.focus = null;
  if (!on && CV.peer === p.id) ctlViewStop(false, 'показ закончился');
}

function grpOnTrack(p, e) {
  if (e.track.kind === 'video') { p.vstream = new MediaStream([e.track]); grpRender(); return; }
  // трансивер 2 — звук экрана, иначе голос; громкость у каждого своя (gvol / gsvol)
  const screen = p.pc.getTransceivers().indexOf(e.transceiver) === 2;
  const stream = grpAudioSink(p, e.track, screen ? 'gsvol' : 'gvol');
  if (!screen) p.stopMeter = makeMeter(stream, (lvl) => G.tiles.get(p.id)?.classList.toggle('speaking', lvl > 0.02 && !S.deafened));
}
// Chromium отдаёт удалённый звук в WebAudio, только если поток привязан к элементу
function grpAudioSink(p, track, key) {
  const stream = new MediaStream([track]);
  const el = new Audio();
  el.srcObject = stream;
  el.muted = true;
  el.play().catch(() => {});
  const src = audio().createMediaStreamSource(stream);
  const gain = ctx.createGain();
  src.connect(gain).connect(master);
  p.aud[key] = { el, src, gain };
  grpApplyVol(p, key);
  return stream;
}
// пока участник не подтвердил свой ID — тишина
function grpApplyVol(p, key) { const a = p.aud[key]; if (a) a.gain.gain.value = p.connected ? grpVol(p.id, key) / 100 : 0; }

/* ---------- Громкость каждого, микрофон, звук ---------- */
const GV = {}; // громкости участников (gvol — голос, gsvol — звук экрана), читаются из хранилища один раз
function grpVols(key) { return (GV[key] ??= store.get(key, {})); }
function grpVol(id, key = 'gvol') { const v = Number(grpVols(key)[id]); return Number.isFinite(v) ? v : 100; }
function grpSetVol(id, v, key) {
  grpVols(key)[id] = v;
  const p = G.peers.get(id);
  if (p) grpApplyVol(p, key);
}
function grpMicBitrate(br) { for (const p of G.peers.values()) if (p.atx) tuneSender(p.atx.sender, { audio: br }); }

// микрофон, звук и шумодав — общие с звонком на двоих (setMuted, setDeafened, setNs красят и кнопки группы)
function grpUpdateControls() {
  $('gShare').classList.toggle('on', !!G.share);
  $('gShare').querySelector('span').textContent = G.share ? 'Остановить показ' : 'Показать экран';
  $('gSoundpad').classList.toggle('on-pad', !$('soundpad').classList.contains('hidden'));
  grpRender();
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
      if (url && why) sysMsg(`«${name}» дошёл не до всех: ${why}`);
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
// Каждый зритель сообщает, как смотрит экран ('view'): full — крупно, thumb — маленькой плиткой,
// off — окно свёрнуто. Полное качество идёт только тем, кто смотрит крупно; канал делится между ними.
const GRP_THUMB = { h: 360, fps: 15, br: 600_000 };
const grpViewOf = (p) => p.view || 'full';
function grpShareBr() {
  const n = Math.max(1, [...G.peers.values()].filter((p) => p.connected && grpViewOf(p) === 'full').length);
  return Math.max(1_500_000, Math.round(G.share.q.br / n)); // отдельная отправка каждому — делим канал
}
async function grpTuneVideo(p, br = G.share ? grpShareBr() : 0) {
  const sender = p.vtx?.sender;
  if (!G.share || !sender?.track) return;
  const view = grpViewOf(p);
  if (view === 'full') await tuneSender(sender, { video: { ...G.share.q, br }, mode: G.share.mode });
  const prm = sender.getParameters();
  if (!prm.encodings?.length) prm.encodings = [{}];
  const e = prm.encodings[0];
  const h = sender.track.getSettings().height || G.share.q.h;
  e.active = view !== 'off';
  e.scaleResolutionDownBy = view === 'thumb' ? Math.max(1, h / GRP_THUMB.h) : 1;
  if (view === 'thumb') { e.maxBitrate = GRP_THUMB.br; e.maxFramerate = GRP_THUMB.fps; }
  try { await sender.setParameters(prm); } catch (err) { L('grp', { tuneFailed: err.message }); }
}
async function grpTuneAll() {
  if (!G.share) return;
  const br = grpShareBr();
  for (const p of G.peers.values()) {
    if (!p.connected) continue;
    await grpTuneVideo(p, br);
    if (p.satx && G.share.atrack) await tuneSender(p.satx.sender, { audio: 128_000 });
  }
}
// у меня: как я сейчас смотрю экран каждого показывающего
function grpSendViews() {
  for (const p of G.peers.values()) {
    if (!p.connected || !p.sharing) { p.viewSent = null; continue; }
    const el = G.tiles.get(p.id);
    const view = document.hidden ? 'off'
      : G.focus === p.id || document.fullscreenElement === el ? 'full' : 'thumb';
    if (p.viewSent === view) continue;
    p.viewSent = view;
    grpSend(p, { t: 'view', view });
  }
}

async function grpBeginShare() {
  const qKey = $('quality').value;
  const mode = $('shareMode').value;
  const wantAudio = $('sysAudio').checked && S.platform === 'win32';
  store.set('settings', { ...settings(), quality: qKey, shareMode: mode, sysAudio: $('sysAudio').checked, autoRestore: $('autoRestore').checked });
  $('picker').classList.add('hidden');
  const srcId = pickedId;
  const srcName = (pickerSources.find((x) => x.id === srcId)?.name || 'Окно').slice(0, 60);
  let q = QUALITY[qKey];
  // видеокарта ничего не кодирует — выше 1080p процессор не потянет (кодеки участники согласуют сами)
  if (q.h > 1080 && !Object.values(S.caps?.enc || {}).includes('hw')) {
    q = QUALITY['1080p60'];
    toast('Видеокарта не кодирует видео для стрима — снизил до 1080p, чтобы не грузить процессор');
  }
  let atrack = null, loopback = false;
  try {
    if (wantAudio) {
      const r = await window.duo.sysAudioStart(srcId);
      if (r.ok) atrack = await startPcmTrack();
      else { loopback = true; toast('Отдельный захват звука недоступен (' + r.error + ') — пойдёт весь звук компьютера'); }
    }
    const { sc, stream, winState } = await openShareSource(srcId, srcName, q, mode, loopback);
    L('grp', { share: 'start', quality: qKey, source: srcId.split(':')[0], windowState: winState });
    await grpShareStream(stream, { q, mode, name: srcId.startsWith('window:') ? srcName : '', atrack: atrack || stream.getAudioTracks()[0] || null, srcId, win: sc });
    window.duo.ovlOpen(srcId).catch(() => {}); // рисунки, указки и реакции зрителей — поверх окна (в захват не попадает)
  } catch (e) {
    console.warn('grp share', e);
    stopPcm();
    window.duo.winWatchStop();
    toast('Не удалось начать демонстрацию: ' + (e.message || e.name));
  }
}

// окно свернули или развернули (onWinState): всем участникам — заглушка или снова окно
async function grpSetShareTrack(vt) {
  if (!G.share) return;
  G.share.track = vt;
  G.share.stream = new MediaStream([vt]); // превью на моей плитке
  for (const p of G.peers.values()) grpAttachSenders(p);
  await grpTuneAll();
  grpRender();
}

// win — контекст окна от openShareSource (заглушка/настоящий захват), нет — поток без слежения за окном
async function grpShareStream(stream, { q = QUALITY['1080p30'], mode = 'game', name = '', atrack = null, srcId = null, win = null } = {}) {
  if (G.share) grpStopShare(true);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('нет видео');
  G.share = { stream, track, atrack, q, mode, name, srcId, win };
  track.addEventListener('ended', () => { if (G.share?.stream === stream) grpStopShare(); });
  for (const p of G.peers.values()) grpAttachSenders(p);
  await grpTuneAll();
  grpSendAll({ t: 'screen', on: true, name, perm: grpMyPerm() });
  L('grp', { share: true, peers: G.peers.size, audio: !!atrack });
  sound('stream');
  grpUpdateControls();
}

function grpStopShare(silent) {
  const sh = G.share;
  if (!sh) return;
  ctlEnd('показ остановлен');
  grpCtlCancelReq();
  G.share = null;
  sh.stream.getTracks().forEach((t) => t.stop());
  sh.win?.real?.getTracks().forEach((t) => t.stop());
  sh.win?.ph?.stop();
  if (sh.win) window.duo?.winWatchStop();
  window.duo?.ovlClose();
  stopPcm();
  for (const p of G.peers.values()) grpAttachSenders(p);
  grpSendAll({ t: 'screen', on: false });
  if (G.focus === grpMe()) G.focus = null;
  if (!silent) grpUpdateControls();
}

/* ---------- Указка, рисунки и реакции поверх экрана участника ----------
   Зритель шлёт всем ('to' — чей экран): показывающий выводит их в оверлей поверх окна (как в звонке на двоих),
   остальные зрители рисуют у себя поверх плитки — оверлей в захват не попадает. Цвет — у каждого свой. */
const GRP_COLORS = ['#ff3c50', '#3ddc84', '#4fd1ff', '#ffcd1f', '#ff2bd6', '#ff8c42', '#b48cff'];
function grpColor(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return GRP_COLORS[h % GRP_COLORS.length]; }
// настройки «поверх моего стрима» поменялись — зрители узнают сразу
function grpPermChanged() { if (G.active && G.share) grpSendAll({ t: 'screen', on: true, name: G.share.name, perm: grpMyPerm() }); }
// управлять можно, только если показываю окно или экран (не тестовый поток)
function grpMyPerm() { const m = myPerm(); return { ...m, ctl: m.ctl && !!G.share?.srcId }; }
// ovlLog — только для автотеста (он сам заводит массив)
const GT = { mode: null, stroke: null, ptrAt: 0, flushAt: 0, react: [], strokes: new Map(), ptrs: new Map(), raf: 0, cv: null, ovlLog: null };
function grpOvl(m) { GT.ovlLog?.push({ t: m.t, c: m.c, nick: m.nick }); window.duo.ovlMsg(m); }
const grpToggleFs = (el) => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(() => {});

function grpAddTools(el, id) {
  const cv = document.createElement('canvas');
  cv.className = 'gdraw';
  el.cv = cv;
  const inp = document.createElement('div');
  inp.className = 'ginput';
  const bar = document.createElement('div');
  bar.className = 'gtools';
  bar.innerHTML = '<button class="tbtn" data-m="ptr" title="Указка">👆</button><button class="tbtn" data-m="draw" title="Рисовать">✏️</button>'
    + '<button class="tbtn" data-a="clear" title="Стереть рисунки">🧹</button><span class="tsep"></span>'
    + REACTIONS.map((r) => `<button class="tbtn" data-r="${r}">${r}</button>`).join('')
    + '<span class="tsep"></span><button class="tbtn wide" data-a="ctl">🎮 Управление</button><button class="tbtn wide hidden" data-a="lock" title="Для игр, где мышь крутит камеру">🖱 Захват мыши</button>'
    + '<button class="tbtn" data-a="full" title="На весь экран / обратно">⛶</button>';
  for (const x of [bar, inp]) { x.onclick = (e) => e.stopPropagation(); x.ondblclick = (e) => e.stopPropagation(); }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.m) grpSetTool(b.dataset.m);
    else if (b.dataset.r) grpReact(id, b.dataset.r);
    else if (b.dataset.a === 'clear') { grpSendAll({ t: 'gclear', to: id }); GT.strokes.clear(); grpKickMarks(); }
    else if (b.dataset.a === 'full') grpToggleFs(el);
    else if (b.dataset.a === 'ctl') grpCtlClick(id);
    else if (b.dataset.a === 'lock') {
      try { const r = inp.requestPointerLock({ unadjustedMovement: true }); r?.catch?.(() => inp.requestPointerLock()); } catch { inp.requestPointerLock(); }
      toast('Мышь захвачена для игры — Esc, чтобы отпустить');
    }
  });
  // ввод для управления: мышь (обычная или захваченная), колесо; клавиатура — общий обработчик в renderer.js
  const ctlOn = () => CV.state === 'on' && CV.peer === id;
  const pt = (e) => normPt(e, el.querySelector('video'));
  inp.tabIndex = -1;
  inp.addEventListener('mousemove', (e) => {
    if (!ctlOn() || !CV.perm.mouse) return;
    if (document.pointerLockElement === inp) { CV.rel[0] += e.movementX; CV.rel[1] += e.movementY; } else CV.moveQ = pt(e);
    queueMoveFlush();
  });
  inp.addEventListener('mousedown', (e) => {
    inp.focus();
    if (!ctlOn()) return;
    e.preventDefault();
    if (!CV.perm.mouse || MOUSE_BTN[e.button] == null) return;
    if (document.pointerLockElement !== inp) ctlSend(['m', ...pt(e).map(n4)]);
    ctlSend(['b', MOUSE_BTN[e.button], 1]);
  });
  inp.addEventListener('mouseup', (e) => grpCtlMouseUp(id, e)); // при захвате мыши — см. grpBind
  inp.addEventListener('wheel', (e) => {
    if (!ctlOn() || !CV.perm.mouse) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-1200, Math.min(1200, Math.round((-e.deltaY * k / 100) * 120)));
    const dx = Math.max(-1200, Math.min(1200, Math.round((e.deltaX * k / 100) * 120)));
    if (dy || dx) ctlSend(['w', dy, dx]);
  }, { passive: false });
  inp.addEventListener('contextmenu', (e) => { if (ctlOn() || GT.mode) e.preventDefault(); });
  inp.addEventListener('pointerdown', (e) => {
    if (GT.mode !== 'draw' || CV.state === 'on') return;
    try { inp.setPointerCapture(e.pointerId); } catch { /* */ }
    GT.stroke = { id: newMid(), to: id, pending: [pt(e)] };
    GT.strokes.set('me:' + GT.stroke.id, { c: grpColor(grpMe()), pts: [pt(e)], done: false, ts: Date.now() });
    grpKickMarks();
  });
  inp.addEventListener('pointermove', (e) => {
    const now = Date.now();
    if (GT.mode === 'ptr' && now - GT.ptrAt > 40) {
      GT.ptrAt = now;
      const [x, y] = pt(e);
      grpSendAll({ t: 'gptr', to: id, x, y });
      GT.ptrs.set(grpMe(), { x, y, ts: now, nick: '', c: grpColor(grpMe()) });
      grpKickMarks();
    }
    if (GT.mode === 'draw' && GT.stroke) {
      const q = pt(e);
      GT.stroke.pending.push(q);
      GT.strokes.get('me:' + GT.stroke.id)?.pts.push(q);
      grpKickMarks();
      if (now - GT.flushAt > 50) { GT.flushAt = now; grpFlushStroke(false); }
    }
  });
  const end = () => { if (GT.stroke) grpFlushStroke(true); };
  inp.addEventListener('pointerup', end);
  inp.addEventListener('pointercancel', end);
  inp.addEventListener('pointerleave', () => { if (GT.mode === 'ptr') grpSendAll({ t: 'gptr-off', to: id }); });
  el.append(cv, inp, bar);
}

function grpSetTool(mode) {
  GT.mode = GT.mode === mode ? null : mode;
  if (GT.mode !== 'ptr' && G.focus) grpSendAll({ t: 'gptr-off', to: G.focus });
  grpUpdateTools();
}

// панель инструментов — только на крупно открытом чужом экране
function grpUpdateTools() {
  const id = G.focus;
  const el = G.tiles.get(id);
  const bar = el?.querySelector('.gtools');
  const on = !!bar && !!G.peers.get(id)?.sharing;
  for (const t of G.tiles.values()) t.classList.toggle('tools', on && t === el);
  if (!on) { GT.mode = null; return; }
  const perm = G.peers.get(id).perm || {};
  const controlling = CV.state === 'on' && CV.peer === id;
  if (GT.mode && (!perm.draw || controlling)) GT.mode = null;
  for (const b of bar.querySelectorAll('[data-m]')) { b.classList.toggle('on', GT.mode === b.dataset.m); b.disabled = !perm.draw || controlling; b.title = perm.draw ? (b.dataset.m === 'ptr' ? 'Указка' : 'Рисовать') : 'Показывающий не разрешил указку и рисование'; }
  bar.querySelector('[data-a=clear]').disabled = !perm.draw;
  for (const b of bar.querySelectorAll('[data-r]')) { b.disabled = !perm.react; b.title = perm.react ? '' : 'Показывающий не включил реакции в настройках'; }
  const cb = bar.querySelector('[data-a=ctl]');
  const mine = CV.peer === id;
  cb.classList.toggle('on', controlling);
  cb.textContent = controlling ? '⛔ Отдать управление' : mine && CV.state === 'req' ? '⏳ Ждём ответа…' : '🎮 Управление';
  cb.disabled = !controlling && (!perm.ctl || (CV.state !== 'off' && !mine));
  cb.title = !perm.ctl ? 'Показывающий выключил запросы на управление (или показывает не окно и не экран)' : 'Попросить управление мышью, клавиатурой и геймпадом';
  bar.querySelector('[data-a=lock]').classList.toggle('hidden', !(controlling && CV.perm.mouse));
  for (const t of G.tiles.values()) t.classList.toggle('ctl-active', controlling && t === el);
  const inp = el.querySelector('.ginput');
  inp.dataset.mode = controlling ? 'ctl' : GT.mode || '';
  inp.classList.toggle('active', !!GT.mode || controlling);
}
function grpCtlMouseUp(id, e) {
  if (CV.state === 'on' && CV.peer === id && CV.perm.mouse && MOUSE_BTN[e.button] != null) ctlSend(['b', MOUSE_BTN[e.button], 0]);
}

function grpCtlClick(id) {
  if (CV.state === 'on' && CV.peer === id) { ctlViewStop(true); toast('Управление отдано'); return; }
  if (CV.state !== 'off') return;
  CV.peer = id;
  ctlRequest();
}
// участник пропал или вышел — управление с ним заканчивается
function grpCtlGone(id, why) {
  if (CV.peer === id && CV.state !== 'off') ctlViewStop(false, why);
  else if (CV.peer === id) CV.peer = null;
  if (CS.peer === id) { if (CS.on) ctlEnd(why, false); grpCtlCancelReq(); CS.peer = null; }
}
function grpCtlCancelReq() {
  if (!CS.req) return;
  clearTimeout(CS.reqTimer);
  $('ctlModal').classList.add('hidden');
  CS.req = null;
  if (!CS.on) CS.peer = null;
}

function grpFlushStroke(done) {
  const st = GT.stroke;
  if (!st) return;
  const pts = st.pending.splice(0).map(([x, y]) => [n4(x), n4(y)]);
  if (pts.length || done) grpSendAll({ t: 'gdraw', to: st.to, id: st.id, pts, done: !!done });
  if (done) { const ls = GT.strokes.get('me:' + st.id); if (ls) { ls.done = true; ls.ts = Date.now(); } GT.stroke = null; }
}

function grpReact(to, e) {
  const now = Date.now();
  GT.react = GT.react.filter((t) => now - t < 2000);
  if (GT.react.length >= 6) return; // не больше 6 за 2 секунды
  GT.react.push(now);
  grpSendAll({ t: 'greact', to, e });
  const el = G.tiles.get(to);
  if (el) floatReaction(e, el);
}

// чужая отметка: на моём экране — в оверлей; на экране, который я смотрю, — на плитку
function grpOnMark(p, d) {
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const toMe = d.to === grpMe() && !!G.share;
  const sharer = toMe ? null : G.peers.get(d.to);
  const perm = toMe ? grpMyPerm() : sharer?.perm;
  if (!perm || (!toMe && !sharer?.sharing)) return;
  const viewing = !toMe && G.focus === d.to;
  const key = p.id.slice(0, 12) + ':' + String(d.id || '').slice(0, 20);
  const c = grpColor(p.id);
  switch (d.t) {
    case 'gdraw': {
      if (!perm.draw || !Array.isArray(d.pts)) return;
      const pts = d.pts.slice(0, 300).map((q) => [clamp(q?.[0]), clamp(q?.[1])]);
      if (toMe) grpOvl({ t: 'stroke', id: key, c, w: 5, pts, done: !!d.done });
      else if (viewing) {
        let st = GT.strokes.get(key);
        if (!st) { st = { c, pts: [], done: false, ts: Date.now() }; GT.strokes.set(key, st); }
        st.pts.push(...pts);
        if (d.done) { st.done = true; st.ts = Date.now(); }
        grpKickMarks();
      }
      return;
    }
    case 'gptr':
      if (!perm.draw) return;
      if (toMe) grpOvl({ t: 'ptr', pid: p.id, x: clamp(d.x), y: clamp(d.y), nick: grpNick(p.id), c });
      else if (viewing) { GT.ptrs.set(p.id, { x: clamp(d.x), y: clamp(d.y), ts: Date.now(), nick: grpNick(p.id), c }); grpKickMarks(); }
      return;
    case 'gptr-off':
      if (toMe) grpOvl({ t: 'ptr-off', pid: p.id });
      else { GT.ptrs.delete(p.id); grpKickMarks(); }
      return;
    case 'gclear':
      if (!perm.draw) return;
      if (toMe) grpOvl({ t: 'clear' });
      else if (viewing) { GT.strokes.clear(); grpKickMarks(); }
      return;
    case 'greact': {
      if (!perm.react || !REACTIONS.includes(d.e)) return;
      p.reactIn = (p.reactIn || []).filter((t) => Date.now() - t < 2000);
      if (p.reactIn.length >= 8) return;
      p.reactIn.push(Date.now());
      if (toMe) { grpOvl({ t: 'react', e: d.e }); const el = G.tiles.get(grpMe()); if (el) floatReaction(d.e, el); }
      else if (viewing) { const el = G.tiles.get(d.to); if (el) floatReaction(d.e, el); }
      return;
    }
    default:
  }
}

function grpKickMarks() { if (!GT.raf) GT.raf = requestAnimationFrame(grpDrawMarks); }
function grpDrawMarks() {
  GT.raf = 0;
  const el = G.tiles.get(G.focus);
  const cv = el?.cv;
  if (GT.cv && GT.cv !== cv) GT.cv.width = 0; // экран сменился — старые отметки стереть
  GT.cv = cv || null;
  if (!cv) { GT.strokes.clear(); GT.ptrs.clear(); return; }
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(el.clientWidth * dpr) || cv.height !== Math.round(el.clientHeight * dpr)) { cv.width = Math.round(el.clientWidth * dpr); cv.height = Math.round(el.clientHeight * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  const er = el.getBoundingClientRect();
  const r = videoRect(el.querySelector('video'));
  const X = (x) => r.x - er.left + x * r.w, Y = (y) => r.y - er.top + y * r.h;
  const now = Date.now();
  let alive = paintStrokes(g, GT.strokes, X, Y, now);
  for (const [k, q] of GT.ptrs) {
    if (now - q.ts > 1500) { GT.ptrs.delete(k); continue; }
    alive = true;
    g.globalAlpha = 0.3; g.fillStyle = q.c; g.beginPath(); g.arc(X(q.x), Y(q.y), 14, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1; g.beginPath(); g.arc(X(q.x), Y(q.y), 6, 0, Math.PI * 2); g.fill();
    if (q.nick) {
      g.font = '600 12px "Segoe UI", sans-serif';
      const tw = g.measureText(q.nick).width;
      g.fillStyle = 'rgba(15,16,20,.85)'; g.fillRect(X(q.x) + 10, Y(q.y) + 8, tw + 10, 18);
      g.fillStyle = '#fff'; g.fillText(q.nick, X(q.x) + 15, Y(q.y) + 21);
    }
  }
  if (alive) GT.raf = requestAnimationFrame(grpDrawMarks);
}

/* ---------- Экран группы ---------- */
function grpEnterUi() {
  closeDm();
  $('lobby').classList.remove('active');
  $('group').classList.add('active');
  G.conv = { id: G.gid, nick: 'Группа', box: newConvBox(), loaded: false, histStart: null, unread: 0, blobs: [], pending: [], msgs: new Map(), nickOf: (w) => grpNick(w) };
  mountConv(G.conv, $('gMessages'));
  loadHistory(G.conv);
  G.tiles.clear();
  $('gGrid').innerHTML = '';
  G.stopMyMeter?.();
  G.stopMyMeter = makeMeter(S.mic, (lvl) => G.tiles.get(grpMe())?.classList.toggle('speaking', lvl > 0.02 && !S.muted && !S.deafened));
  updateMyControls();
  updateNsBtn();
  grpUpdateControls();
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
}
const grpSavedNick = (m) => friendById(m.id)?.nick || grpClean(m.nick) || 'Участник';

// список в лобби; во время группы лобби не видно — перерисуем после выхода
function grpRenderSaved() {
  const box = $('groupsBox');
  if (!box || G.active) return;
  const list = grpSaved().filter((g) => g.members.length);
  box.classList.toggle('hidden', !list.length);
  const el = $('groupsList');
  el.innerHTML = '';
  for (const g of list) {
    const online = g.members.filter((m) => friendById(m.id)?.online).length;
    const row = document.createElement('div');
    row.className = 'friend' + (online ? ' online' : '');
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
  const online = g.members.filter((m) => friendById(m.id)?.online);
  if (!online.length) { toast('Никого из друзей этой группы нет в сети'); return; }
  if (!(await grpStart(gid))) return;
  grpInvite(online.map((m) => m.id));
  const others = g.members.filter((m) => !isFriend(m.id)).map(grpSavedNick);
  if (others.length) sysMsg(`${others.join(', ')} — не у тебя в друзьях: их позовёт кто-то из группы («➕ Позвать»)`);
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
  if (id !== grpMe()) { grpAddTools(el, id); grpAddVols(el, id); } else {
    // кто мной управляет + «Забрать»
    const badge = document.createElement('div');
    badge.className = 'ctl-badge gctl hidden';
    const t = document.createElement('span');
    const b = document.createElement('button');
    b.className = 'btn small danger-btn';
    b.textContent = 'Забрать';
    b.onclick = (e) => { e.stopPropagation(); ctlEnd('ты забрал управление'); };
    badge.append(t, ' ', b);
    el.appendChild(badge);
  }
  el.onclick = () => { if (el.classList.contains('sharing')) { G.focus = G.focus === id ? null : id; GT.strokes.clear(); GT.ptrs.clear(); grpRender(); grpKickMarks(); } };
  el.ondblclick = () => { if (el.classList.contains('sharing')) grpToggleFs(el); };
  G.tiles.set(id, el);
  grpPaintAvatar(id);
  return el;
}

// громкость голоса и звука экрана участника; сохраняется, когда ползунок отпустили
function grpAddVols(el, id) {
  const vols = document.createElement('div');
  vols.className = 'gvols';
  for (const [key, ico, title] of [['gvol', '🎙', 'Громкость голоса'], ['gsvol', '🖥', 'Громкость звука экрана']]) {
    const lab = document.createElement('label');
    lab.className = 'gv-' + key;
    lab.title = title;
    const r = document.createElement('input');
    r.type = 'range'; r.min = '0'; r.max = '200'; r.value = String(grpVol(id, key));
    r.oninput = () => grpSetVol(id, Number(r.value), key);
    r.onchange = () => store.set(key, grpVols(key));
    lab.append(ico, r);
    lab.onclick = (e) => e.stopPropagation();
    lab.ondblclick = (e) => e.stopPropagation();
    vols.appendChild(lab);
  }
  el.appendChild(vols);
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
  const badge = G.tiles.get(me)?.querySelector('.gctl');
  if (badge) { badge.classList.toggle('hidden', !CS.on); badge.querySelector('span').textContent = CS.on ? `🎮 ${grpNick(CS.peer)} управляет` : ''; }
  grpUpdateTools();
  const n = 1 + [...G.peers.values()].filter((p) => p.connected).length;
  $('gStatus').querySelector('span').textContent = `В звонке: ${n} из ${G.members.size}`;
  $('gStatus').className = 'status ' + (n > 1 ? 'ok' : 'waiting');
  grpSendViews();
}

function grpReset() {
  for (const t of G.lostTimers.values()) clearTimeout(t);
  for (const m of [G.members, G.left, G.seen, G.peers, G.connecting, G.lostAt, G.lostTimers, G.tiles, G.nickCache]) m.clear();
  GT.mode = null; GT.stroke = null; GT.strokes.clear(); GT.ptrs.clear();
  CV.peer = null; CS.peer = null;
  G.gid = null; G.focus = null; G.conv = null; G.share = null;
}

function grpLeave(text) {
  if (!G.active) return;
  L('grp', { leave: text || 'self' });
  grpSendAll({ t: 'bye' });
  // до кого нет прямой связи — сообщаем по каналу друзей
  for (const id of G.members.keys()) if (id !== grpMe() && !grpOpen(id) && isFriend(id)) window.duo.friendsSend(id, { t: 'grp-leave', gid: G.gid });
  ctlViewStop(true);
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
  setCompose(composers.grp, null);
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
  // те же действия, что у кнопок звонка на двоих
  $('gMute').onclick = () => $('btnMute').click();
  $('gDeafen').onclick = () => $('btnDeafen').click();
  $('gNs').onclick = () => $('btnNs').click();
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
  document.addEventListener('visibilitychange', () => { if (G.active) grpSendViews(); });
  document.addEventListener('fullscreenchange', () => { if (G.active) grpSendViews(); });
  // кнопка мыши отпущена при захваченной мыши — событие приходит не на слой ввода
  document.addEventListener('mouseup', (e) => { const inp = document.pointerLockElement; if (inp?.classList.contains('ginput')) grpCtlMouseUp(inp.closest('.gtile')?.dataset.id, e); });
}
// group.js грузится раньше renderer.js (чтобы G был всегда), а кнопки привязываем, когда готов весь интерфейс
document.addEventListener('DOMContentLoaded', grpBind);
