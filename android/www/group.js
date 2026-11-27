'use strict';
/* =========================================================
   Групповой звонок до GRP_MAX человек — как у ПК 1.16 (group.js), версия для телефона, протокол тот же.
   Сетка «каждый с каждым»: у каждой пары своё RTCPeerConnection — трансиверы 0 голос, 1 экран, 2 звук экрана;
   каналы 0 'g' (чат, состояние, пересылка записок), 1 'files', 2 'ctl', 3 'ctlu' (управление в группе с телефона
   не поддерживается — на 'ctl-req' отвечаем отказом). Звонит тот, у кого ID больше. ID группы — 43 знака.
   Записки для соединения — по каналу друзей ('grp-*'), не-друзьям — через участника на связи ('relay').
   Каждый доказывает свой ID ('ch'/'proof', ключ пары + отпечатки DTLS); до подтверждения ему не идут
   ни звук, ни экран, ни сообщения. Обрыв — соединение пересоздаётся до GRP_RECONNECT_FOR.
   Пока идёт группа, обычные звонки получают «занят».
   Указка, рисунки, реакции ('gptr'/'gdraw'/'gclear'/'greact', 'to' — чей экран) — как у ПК: на моём экране — в окно
   поверх приложений (OverlayWin), на экране, который я смотрю крупно, — на плитку.
   Управление (как у ПК 1.16, CV.link): 🎮 над экраном участника → 'ctl-req' ему → разрешил — открывается тот же экран
   управления, что в звонке на двоих (касания/тачпад/клавиатура/геймпад), команды — по его каналам ctl/ctlu.
   Один управляющий на показывающего. Управлять телефоном с ПК нельзя (на 'ctl-req' — 'ctl-deny').
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
  lostTimers: new Map(),
  tiles: new Map(),     // id → плитка
  nickCache: new Map(),
  conv: null, invite: null, share: null, focus: null, joinTimer: null, stopMyMeter: null, manualPending: null, chatOpen: false, unread: 0,
};

const grpMe = () => myIdent?.id || '';
const grpGid = (x) => (ID_RE.test(String(x || '')) ? String(x) : '');
const grpNewGid = () => b64uBytes(crypto.getRandomValues(new Uint8Array(32)));
const grpClean = (s, n = 24) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const grpFriend = (id) => friendsList.find((f) => f.id === id);
function grpNick(id) {
  if (id === 'me' || id === grpMe()) return S.nick || 'Я';
  return grpFriend(id)?.nick || G.members.get(id)?.nick || G.nickCache.get(id) || 'Участник';
}
function grpRosterList() { return [...G.members.values()].map((m) => ({ id: m.id, nick: m.nick, via: m.via || '' })); }
function grpBusy() { return G.active || S.inCall || S.busy || !!S.pc || !!S.friendCall; }
const grpOpen = (id) => { const p = G.peers.get(id); return !!p?.connected && p.dc.readyState === 'open'; };
const grpSys = (text) => sysMsg(text, G.conv);
const grpFriendsSend = (id, msg) => alo.friendsSend({ id, msg });

function grpAddMember(m, force) {
  const id = String(m?.id || '');
  if (!ID_RE.test(id) || id === grpMe()) return false;
  if (G.left.has(id) && !force) return false;
  if (force) G.left.delete(id);
  const via = ID_RE.test(String(m.via || '')) ? m.via : '';
  const ex = G.members.get(id);
  if (ex) { if (!ex.via && via) ex.via = via; return false; }
  if (G.members.size >= GRP_MAX + 2) return false;
  G.members.set(id, { id, nick: grpClean(m.nick) || 'Участник', via });
  return true;
}
function grpMergeRoster(list) {
  let added = false;
  for (const m of (Array.isArray(list) ? list : []).slice(0, GRP_MAX + 2)) added = grpAddMember(m) || added;
  grpSyncPeers();
  return added;
}
function grpAdmit(id, nick, via) {
  grpAddMember({ id, nick, via }, true);
  grpFriendsSend(id, { t: 'grp-roster', gid: G.gid, members: grpRosterList() });
  grpSendAll({ t: 'member', id, nick: G.members.get(id)?.nick || nick, via: grpMe() });
  grpRender();
  grpSyncPeers();
}

/* ---------- Позвать друзей ---------- */
function grpOpenPick() {
  if (!myIdent?.id) { toast('Сеть друзей ещё не готова'); return; }
  if (!G.active && grpBusy()) { toast('Сначала заверши звонок'); return; }
  const list = $('gPickList');
  list.replaceChildren();
  const room = GRP_MAX - (G.active ? G.members.size : 1);
  const cands = [...friendsList].filter((f) => !G.members.has(f.id)).sort((a, b) => (b.online - a.online) || a.nick.localeCompare(b.nick));
  if (!cands.length) { const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'Некого звать — все друзья уже здесь'; list.appendChild(p); }
  for (const f of cands) {
    const row = document.createElement('label');
    row.className = 'switch';
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
  if (!gid) grpSys('Групповой звонок создан. Позови друзей — «➕ Позвать».');
  return true;
}
function grpInvite(ids) {
  for (const id of ids) {
    const nick = grpNick(id);
    grpSys(`Зову ${nick}…`);
    grpFriendsSend(id, { t: 'grp-invite', gid: G.gid, nick: S.nick, members: grpRosterList() }).then((r) => {
      if (!r.ok && G.active) grpSys(`${nick} не отвечает — не в сети?`);
    });
  }
}

async function grpManualPack(kind, data) { return `ALOG${kind}.` + b64uEnc(await deflate(JSON.stringify(data))); }
async function grpManualRead(text, kind) {
  const m = new RegExp(`ALOG${kind}\\.([A-Za-z0-9_-]{100,100000})`).exec(String(text || '').replace(/\s+/g, ''));
  if (!m) throw new Error('Нужен полный код приглашения в группу');
  let d;
  try { d = JSON.parse(await inflate(b64uDec(m[1]))); } catch { throw new Error('Код группы повреждён'); }
  if (!Number.isFinite(d.at) || !ID_RE.test(String(d.nonce || '')) || d.v !== 1 || !grpGid(d.gid) || !ID_RE.test(String(d.id || '')) || !/^v=0/.test(String(d.sdp || '')) || Math.abs(Date.now() - d.at) > 5 * 60_000) throw new Error('Код группы повреждён или устарел');
  return d;
}
async function grpManualCreate() {
  if (S.inCall) { toast('Заверши звонок на двоих перед созданием группы'); return; }
  if (!G.active && !(await grpStart())) return;
  if (G.members.size >= GRP_MAX) { toast('В группе уже максимум участников'); return; }
  if (G.manualPending) { grpClosePeer(G.manualPending.p); G.manualPending = null; }
  const temp = grpNewGid(), nonce = grpNewGid();
  let p;
  try {
    const res = await gatherWithFallback('grp-manual', cfg => {
      if (p) grpClosePeer(p);
      p = grpMakePeer(temp, nonce, 'out', cfg);
      return p.pc;
    }, async pc => { await pc.setLocalDescription(await pc.createOffer()); }, pc => G.active && G.peers.get(temp)?.pc === pc);
    if (!res || !G.active || G.peers.get(temp) !== p) return;
    G.manualPending = { p, temp, nonce, gid: G.gid };
    $('frGroupManualOffer').value = await grpManualPack('I', { v: 1, gid: G.gid, id: grpMe(), nick: S.nick, nonce, at: Date.now(), sdp: grpSdp(p.pc) });
    $('frGroupManualCopy').disabled = false;
    $('frGroupManualApply').disabled = false;
    toast('Код группы готов — отправь его участнику');
  } catch (e) { if (p) grpClosePeer(p); G.manualPending = null; toast('Не удалось создать код группы: ' + e.message); }
}
async function grpManualJoin(text) {
  let d;
  try { d = await grpManualRead(text, 'I'); } catch (e) { toast(e.message); return; }
  if (d.id === grpMe()) { toast('Это твоё приглашение'); return; }
  if (grpBusy()) { toast('Сначала заверши текущий звонок'); return; }
  if (!(await grpStart(d.gid, d.id))) return;
  grpAddMember({ id: d.id, nick: grpClean(d.nick), via: '' }, true);
  grpRender();
  let p;
  try {
    const res = await gatherWithFallback('grp-manual-answer', cfg => {
      if (p) grpClosePeer(p);
      p = grpMakePeer(d.id, d.nonce, 'in', cfg);
      return p.pc;
    }, async pc => {
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      [p.atx, p.vtx, p.satx] = pc.getTransceivers();
      grpScreenCodecPreference(p.vtx);
      for (const t of [p.atx, p.vtx, p.satx]) if (t) t.direction = 'sendrecv';
      grpAttachSenders(p);
      await pc.setLocalDescription(await pc.createAnswer());
    }, pc => G.active && G.peers.get(d.id)?.pc === pc, { answer: true });
    if (!res || !G.active || G.peers.get(d.id) !== p) return;
    p.manual = true;
    $('groupManualReplyCode').value = await grpManualPack('A', { v: 1, gid: d.gid, id: grpMe(), nick: S.nick, nonce: d.nonce, at: Date.now(), sdp: grpSdp(p.pc) });
    $('gPick').classList.add('hidden');
    $('groupManualReply').classList.remove('hidden');
    autoCopy($('groupManualReplyCode').value, $('groupManualReplyCopy'));
    p.timer = setTimeout(() => { if (!p.connected) grpLeave('Ответ на приглашение не был применён'); }, 90_000);
  } catch (e) { if (p) grpClosePeer(p); grpLeave('Не удалось ответить на приглашение: ' + e.message); }
}
async function grpManualApply(text) {
  const pending = G.manualPending;
  if (!G.active || !pending || pending.gid !== G.gid) { toast('Создай новое приглашение в группу'); return; }
  let d;
  try { d = await grpManualRead(text, 'A'); } catch (e) { toast(e.message); return; }
  if (d.gid !== G.gid || d.nonce !== pending.nonce || d.id === grpMe() || G.members.has(d.id)) { toast('Ответ не относится к этому приглашению'); return; }
  if (G.members.size >= GRP_MAX) { toast('В группе уже максимум участников'); return; }
  const p = pending.p;
  try {
    G.peers.delete(pending.temp);
    p.id = d.id;
    p.manual = true;
    G.peers.set(d.id, p);
    grpAddMember({ id: d.id, nick: grpClean(d.nick), via: grpMe() }, true);
    G.manualPending = null;
    await p.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    p.timer = setTimeout(() => { if (!p.connected) grpPeerLost(p, 'не удалось соединиться'); }, 30_000);
    grpRender();
    $('gPick').classList.add('hidden');
    toast('Ответ применён — соединяемся');
  } catch (e) { grpClosePeer(p); grpMemberGone(d.id, 'не смог подключиться', true); toast('Не удалось применить ответ: ' + e.message); }
}

/* ---------- Входящее приглашение ---------- */
function grpOnInvite(id, msg, nick) {
  const gid = grpGid(msg.gid);
  if (!gid || G.invite?.gid === gid) return;
  if (G.active && G.gid === gid) {
    if (!G.peers.get(id)?.connected) grpAdmit(id, nick, '');
    return;
  }
  if (grpBusy() || G.invite) { grpFriendsSend(id, { t: 'grp-busy', gid }); return; }
  const members = (Array.isArray(msg.members) ? msg.members : []).filter((m) => ID_RE.test(String(m?.id || ''))).slice(0, GRP_MAX)
    .map((m) => ({ id: m.id, nick: grpClean(m.nick) || 'Участник', via: ID_RE.test(String(m.via || '')) ? m.via : '' }));
  if (!members.some((m) => m.id === id)) members.unshift({ id, nick, via: '' });
  G.invite = { id, gid, nick, members };
  $('gInvTitle').textContent = `${nick} зовёт в групповой звонок`;
  $('gInvSub').textContent = 'Уже там: ' + members.map(grpSavedNick).join(', ');
  showIncomingCallModal('gInvModal');
  startRing(); // уведомление, если окно свёрнуто, — у Hub.java
  G.invite.timer = setTimeout(() => { if (G.invite?.gid === gid) grpDeclineInvite(`Пропущен групповой звонок от ${nick}`); }, 40000);
  updateService();
}
function grpCloseInvite(restore = true) {
  if (G.invite) clearTimeout(G.invite.timer);
  G.invite = null;
  $('gInvModal').classList.add('hidden');
  if (restore) restoreCallOverlays();
  stopRing();
}
function grpDeclineInvite(text) {
  const inv = G.invite;
  if (!inv) return;
  grpFriendsSend(inv.id, { t: 'grp-decline', gid: inv.gid });
  grpCloseInvite();
  updateService();
  if (text) toast(text);
}
async function grpAcceptInvite() {
  const inv = G.invite;
  if (!inv) return;
  suspendCallOverlays();
  grpCloseInvite(false);
  if (!(await grpStart(inv.gid, inv.id))) { restoreCallOverlays(); return; }
  for (const m of inv.members) grpAddMember({ ...m, via: m.via || (m.id === inv.id ? '' : inv.id) });
  grpRender();
  grpSys('Подключаюсь к группе…');
  const r = await grpFriendsSend(inv.id, { t: 'grp-join', gid: inv.gid, nick: S.nick });
  if (!r.ok && G.gid === inv.gid) { grpLeave(`${inv.nick} не отвечает`); return; }
  G.joinTimer = setTimeout(() => { if (G.active && G.gid === inv.gid && ![...G.peers.values()].some((p) => p.connected)) grpLeave('Группа не ответила'); }, 30000);
}

/* ---------- Канал друзей ---------- */
function grpOnFriendMsg(id, msg, f, nick) {
  if (msg.t === 'grp-invite') { if (f) grpOnInvite(id, msg, nick); return; }
  if (!G.active || grpGid(msg.gid) !== G.gid) return;
  switch (msg.t) {
    case 'grp-join':
      if (!f) return;
      if (G.members.size >= GRP_MAX && !G.members.has(id)) { grpFriendsSend(id, { t: 'grp-full', gid: G.gid }); return; }
      grpAdmit(id, grpClean(msg.nick) || nick, grpMe());
      return;
    case 'grp-decline': grpSys(`${nick} отказался`); return;
    case 'grp-busy': grpSys(`${nick} сейчас занят`); return;
    case 'grp-full': if (id === G.members.get(grpMe())?.via) grpLeave('В группе уже нет мест'); return;
    case 'grp-roster': if (f || G.members.has(id)) { grpAddMember({ id, nick, via: '' }, true); grpMergeRoster(msg.members); grpRender(); } return;
    case 'grp-leave': if (G.members.has(id)) { grpMemberGone(id, 'вышел'); grpSendAll({ t: 'gone', id }); } return;
    case 'grp-relay': if (G.members.has(id)) grpRelay(id, msg); return;
    case 'grp-sig': grpOnSig(id, msg, !!f); return;
    default:
  }
}

/* ---------- Записки для соединения ---------- */
function grpSig(to, payload, tries = 0) {
  const msg = { kind: payload.kind, pid: payload.pid, sdp: payload.sdp, nick: S.nick };
  if (isFriend(to)) return grpFriendsSend(to, { t: 'grp-sig', gid: G.gid, ...msg });
  const me = grpMe();
  const cands = [...new Set([G.members.get(to)?.via, G.members.get(me)?.via, ...[...G.peers.values()].filter((p) => p.connected).map((p) => p.id)])]
    .filter((r) => r && r !== me && r !== to && G.members.has(r) && (grpOpen(r) || isFriend(r)));
  if (!cands.length) return Promise.resolve({ ok: false, error: 'нет пути' });
  const r = cands[tries % cands.length];
  L('grp', { relayVia: r.slice(0, 8), to: to.slice(0, 8), kind: msg.kind });
  if (grpOpen(r)) { grpSend(G.peers.get(r), { t: 'relay', to, ...msg }); return Promise.resolve({ ok: true }); }
  return grpFriendsSend(r, { t: 'grp-relay', gid: G.gid, to, ...msg });
}
function grpRelay(from, msg) {
  const to = String(msg.to || '');
  if (!G.members.has(to) || to === grpMe() || to === from) return;
  const out = { from, nick: G.members.get(from)?.nick || grpClean(msg.nick), kind: msg.kind, pid: msg.pid, sdp: msg.sdp };
  if (grpOpen(to)) grpSend(G.peers.get(to), { t: 'sig', ...out });
  else if (isFriend(to)) grpFriendsSend(to, { t: 'grp-sig', gid: G.gid, ...out });
}
function grpOnSig(sender, msg, senderIsFriend) {
  let from = sender;
  if (msg.from) {
    if (!G.members.has(sender)) return;
    from = String(msg.from);
  } else if (!senderIsFriend && !G.members.has(sender)) return;
  if (!ID_RE.test(from) || from === grpMe()) return;
  if (!G.members.has(from)) grpAddMember({ id: from, nick: msg.nick, via: msg.from ? sender : '' }, true);
  if (msg.kind === 'offer') grpAnswer(from, msg);
  else if (msg.kind === 'answer') grpOnAnswer(from, msg);
}
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
    chatIn: () => { sound('msg'); grpBumpUnread(); },
    avatar: (b, m) => { if (isFriend(id)) onAvatarFile(id, b, m).then(() => grpPaintAvatar(id)); },
    screenimg: () => {},
    screenvid: () => {},
  });
  // управление: я шлю команды тому, кем управляю; от него — подсказки (ctl-info)
  p.cdc = pc.createDataChannel('ctl', { negotiated: true, id: 2, ordered: true });
  p.cdu = pc.createDataChannel('ctlu', { negotiated: true, id: 3, ordered: false, maxRetransmits: 0 });
  for (const ch of [p.cdc, p.cdu]) ch.onmessage = (e) => { if (p.connected && !p.closed && CV.link?.id === p.id) { try { onCtlMsg(JSON.parse(e.data)); } catch { /* */ } } };
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
    grpScreenCodecPreference(p.vtx);
    p.satx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    grpAttachSenders(p);
  }
  G.peers.set(id, p);
  return p;
}
function grpScreenCodecPreference(tx){
  if(!tx||SCREEN_COMPAT.codec!=='VP8'||SCREEN_COMPAT.perSender)return;
  const vc=RTCRtpReceiver.getCapabilities('video').codecs;tx.setCodecPreferences(vc.filter(c=>c.mimeType==='video/VP8'||/video\/(rtx|red|ulpfec|flexfec-03)/i.test(c.mimeType)));
}
async function grpAttachSenders(p) {
  const ok=p.connected,epoch=p.screenAttach=(p.screenAttach||0)+1;
  p.atx?.sender.replaceTrack(ok?grpMicTrack():null).catch(()=>{});
  p.satx?.sender.replaceTrack(ok?G.share?.atrack||null:null).catch(()=>{});
  grpCamAttach(p);
  const sender=p.vtx?.sender,track=ok?G.share?.track||null:null;if(!sender)return;
  try{if(track)await applyScreenCodec(sender);if(p.screenAttach!==epoch)return;await sender.replaceTrack(track);if(track&&p.screenAttach===epoch)await grpTuneVideo(p);}catch(e){L('grp',{screenAttachError:e.message});}
}

/* ---------- Вебкамера в группе (как ПК 1.19) ----------
   Видеопоток камеры добавляется в соединение пары по запросу. Добавляет и предлагает тот, кто звонил в этой паре
   (role 'out'); второй просит его (gcam-need). По каналу 'g': greneg {sdp, camMid} → greneg-ans, gcam {on};
   в hello — cam: 1 (умею) и camOn. Через мост камера идёт в отдельном соединении моста (group-bridge.js). */
async function grpCamEnsure(p, asked) {
  if (p.virt || p.closed || !p.connected || p.ctx) return;
  if (p.role !== 'out') { if (!p.camAsked) { p.camAsked = true; grpSend(p, { t: 'gcam-need' }); } return; }
  if (!p.peerCam && !asked) return;
  if (p.camBusy) return;
  p.camBusy = true;
  try {
    for (let i = 0; i < 25 && p.pc.signalingState !== 'stable'; i++) await new Promise((r) => setTimeout(r, 200));
    if (p.closed || p.pc.signalingState !== 'stable' || p.ctx) return;
    const tr = p.pc.addTransceiver('video', { direction: 'sendrecv' });
    await p.pc.setLocalDescription(await p.pc.createOffer());
    p.ctx = tr;
    p.camMid = tr.mid;
    grpCamAttach(p);
    grpSend(p, { t: 'greneg', sdp: p.pc.localDescription.sdp, camMid: tr.mid });
    L('grp', { camOffer: p.id.slice(0, 8) });
  } catch (e) { L('grp', { camOfferFailed: e.message }); } finally { p.camBusy = false; }
}
async function grpOnReneg(p, d) {
  if (p.virt || p.role === 'out' || !/^v=0/.test(String(d.sdp || ''))) return;
  try {
    p.camMid = String(d.camMid);
    if (p.pc.signalingState === 'have-local-offer') await p.pc.setLocalDescription({ type: 'rollback' });
    await p.pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) });
    const tr = p.pc.getTransceivers().find((t) => t.mid === p.camMid);
    if (!tr) throw new Error('нет трансивера камеры');
    tr.direction = 'sendrecv';
    p.ctx = tr;
    grpCamAttach(p);
    await p.pc.setLocalDescription(await p.pc.createAnswer());
    grpSend(p, { t: 'greneg-ans', sdp: p.pc.localDescription.sdp });
    grpCamWatch(p);
  } catch (e) { L('grp', { camAnswerFailed: e.message }); }
}
async function grpOnRenegAns(p, d) {
  if (p.virt || p.pc.signalingState !== 'have-local-offer') return;
  try { await p.pc.setRemoteDescription({ type: 'answer', sdp: String(d.sdp || '') }); grpCamWatch(p); } catch (e) { L('grp', { camApplyFailed: e.message }); }
}
function grpCamWatch(p) {
  const t = p.ctx?.receiver.track;
  if (t && p.cstream?.getVideoTracks()[0] !== t) p.cstream = new MediaStream([t]);
  if (!p.virt) grpFwdRefresh(p.id);
  grpRender();
}
function grpCamAttach(p) {
  const tr = p.ctx;
  if (!tr || p.virt) return;
  tr.sender.replaceTrack(p.connected && CAM.on ? CAM.stream?.getVideoTracks()[0] || null : null).catch(() => {});
  try {
    const prm = tr.sender.getParameters();
    prm.encodings = prm.encodings?.length ? prm.encodings : [{}];
    prm.encodings[0].maxBitrate = 600_000; // в группе камера уходит каждому — скромнее
    tr.sender.setParameters(prm).catch(() => {});
  } catch { /* */ }
}
function grpCamAll() { for (const p of G.peers.values()) { if (CAM.on) grpCamEnsure(p); grpCamAttach(p); } }
// голос в группу: при саундпаде — смесь (как в звонке на двоих), иначе микрофон (через шумодав)
function grpMicTrack() { return spPlaying.size && spNodes ? spNodes.dest.stream.getAudioTracks()[0] : micSendTrack(); }
function grpResendMic() { for (const p of G.peers.values()) if (p.connected) p.atx?.sender.replaceTrack(grpMicTrack()).catch(() => {}); }
function grpSend(p, obj) { try { if (p?.dc.readyState === 'open') p.dc.send(JSON.stringify(obj)); } catch { /* */ } }
function grpSendAll(obj) {
  for (const p of G.peers.values()) if (p.connected) grpSend(p, obj); // до подтверждения ID — ничего
  // кто идёт через мост — им то же через H (только разрешённое мостом)
  if (FWD_TYPES.has(obj.t)) for (const v of G.vpeers?.values() || []) if (v.connected && !G.peers.get(v.id)?.connected) grpSend(v, obj);
}
const grpSdp = (pc) => opusStereo(minifySdp(pc.localDescription.sdp));

async function grpConnect(id, tries = 0) {
  if (!G.active || G.peers.has(id) || G.connecting.has(id) || !G.members.has(id)) return;
  if (window.GRP_BLOCK === id) return; // автотест моста: напрямую с ним «не соединяется»
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
  if (window.GRP_BLOCK === from) return;
  const pid = cleanMid(msg.pid);
  const ex = G.peers.get(from);
  if (ex) { if (ex.pid === pid) return; grpClosePeer(ex); }
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
  if (G.peers.get(p.id) === p) { grpCtlGone(p.id, 'связь с участником пропала'); G.peers.delete(p.id); if (p.connected) grpFwdPeerDown(p.id); }
  p.closed = true;
  clearTimeout(p.timer);
  clearTimeout(p.discTimer);
  p.stopMeter?.();
  for (const a of Object.values(p.aud)) { try { a.el.pause(); } catch { /* */ } a.el.srcObject = null; }
  p.chan?.fail('связь прервалась');
  try { p.dc.close(); } catch { /* */ }
  try { p.pc.close(); } catch { /* */ }
  if (G.active && G.share?.softwareBudget) grpTuneAll();
}
function grpPeerLost(p, why) {
  if (p.closed || G.peers.get(p.id) !== p) return;
  const was = p.connected;
  grpClosePeer(p);
  L('grp', { lost: why, was, tries: p.tries || 0 });
  if (!G.active || !G.members.has(p.id)) return;
  if (p.manual && !isFriend(p.id) && ![...G.peers.values()].some(x => x.connected)) { grpMemberGone(p.id, why, true); grpSys('Ручное соединение прервалось. Создай новое приглашение для повторного входа.'); return; }
  if (!G.lostAt.has(p.id)) {
    G.lostAt.set(p.id, Date.now());
    if (was) { grpSys(`Связь с ${grpNick(p.id)} прервалась — переподключаюсь…`); sound('leave'); }
  }
  grpRender();
  const since = Date.now() - G.lostAt.get(p.id);
  const tries = (p.tries || 0) + 1;
  // идёт через мост — не «потерялся»: прямые попытки реже, раз в минуту
  if (since > GRP_RECONNECT_FOR && grpBridged(p.id)) { if (grpMe() > p.id) setTimeout(() => grpConnect(p.id, tries), 60000); return; }
  if (since > GRP_RECONNECT_FOR) { grpMemberGone(p.id, G.seen.has(p.id) ? 'потерялся — связь не восстановилась' : 'не смог подключиться'); return; }
  if (grpMe() > p.id) setTimeout(() => grpConnect(p.id, tries), Math.min(8000, 1500 * tries));
  else {
    clearTimeout(G.lostTimers.get(p.id));
    G.lostTimers.set(p.id, setTimeout(() => {
      if (G.active && G.members.has(p.id) && !G.peers.get(p.id)?.connected && !grpBridged(p.id)) grpMemberGone(p.id, 'потерялся — связь не восстановилась');
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
  grpFwdMemberGone(id);
  if (G.focus === id) G.focus = null;
  if (known && G.active) { grpSys(`${grpNick(id)} ${why}`); sound('leave'); }
  grpRender();
}

// каждый доказывает, что ID его (как в звонке по коду): записки могли прийти через посредника
function grpPeerOpen(p) {
  if (p.closed) return;
  p.ch = b64uBytes(crypto.getRandomValues(new Uint8Array(18)));
  grpSend(p, { t: 'ch', ch: p.ch });
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { if (!p.connected) grpRejectPeer(p, 'не подтвердил свой ID'); }, 15000);
}
// через мост прямого соединения нет — привязка к группе и мосту (H подделать не может: ключ пары у двоих)
const grpProofBind = (p) => (p.virt ? `fwd|${G.gid}|${p.via}` : callBinding(p.pc));
async function grpOnCh(p, d) {
  if (typeof d.ch !== 'string' || d.ch.length < 16 || d.ch.length > 64) return;
  const bind = grpProofBind(p);
  const r = bind ? await alo.friendsProof({ id: p.id, prover: grpMe(), nonce: d.ch, bind }) : null;
  if (r?.mac) grpSend(p, { t: 'proof', mac: r.mac });
}
async function grpOnProof(p, d) {
  if (p.connected || !p.ch || typeof d.mac !== 'string') return;
  const bind = grpProofBind(p);
  const r = bind ? await alo.friendsProof({ id: p.id, prover: p.id, nonce: p.ch, bind }) : null;
  if (p.closed || p.connected) return;
  if (r?.mac && r.mac === d.mac) grpVerified(p);
  else grpRejectPeer(p, 'выдаёт себя за другого (ключ не его)');
}
function grpRejectPeer(p, why) {
  if (p.closed) return;
  if (p.virt) { // через мост: закрываем только мост, участник остаётся (прямые попытки идут дальше)
    L('grp', { fwdRejected: p.id.slice(0, 8), why });
    if (/ключ/.test(why)) grpSys(`⚠ Через ${grpNick(p.via)} пришёл не ${grpNick(p.id)} (ключ не его) — мост закрыт`);
    grpVpClose(p, !/ключ/.test(why));
    return;
  }
  L('grp', { rejected: p.id.slice(0, 8), why });
  grpSys(`⚠ Участник «${grpNick(p.id)}» ${why} — отключён`);
  grpClosePeer(p);
  grpMemberGone(p.id, why, true);
}
function grpVerified(p) {
  p.connected = true;
  if (!p.virt) grpFwdDirectUp(p.id);
  grpAttachSenders(p);
  for (const a of Object.values(p.aud)) grpApplyVol(p, a);
  G.seen.add(p.id);
  clearTimeout(p.timer);
  clearTimeout(G.joinTimer);
  const back = G.lostAt.has(p.id);
  G.lostAt.delete(p.id);
  clearTimeout(G.lostTimers.get(p.id));
  G.lostTimers.delete(p.id);
  grpSend(p, { t: 'hello', fwd: 1, cam: 1, camOn: CAM.on, nick: S.nick, muted: S.muted, deaf: S.deafened, sharing: !!G.share, name: '', perm: grpMyPerm(), av: myAvatar?.hash || '', members: grpRosterList() });
  if (G.share) grpTuneAll();
  L('grp', { open: p.id.slice(0, 8), peers: G.peers.size, back, virt: !!p.virt });
  grpSys((back ? `${grpNick(p.id)} снова на связи` : `${grpNick(p.id)} в звонке`) + (p.virt ? ` (через ${grpNick(p.via)})` : ''));
  if (!p.virt) setTimeout(grpSendLinks, 300);
  sound('join');
  grpSaveCurrent();
  if (p.manual) grpSendAll({ t: 'member', id: p.id, nick: grpNick(p.id), via: grpMe() });
  grpRender();
  for (const d of (p.queue || []).splice(0)) grpOnData(p, d);
}

function grpOnData(p, d) {
  if (p.closed || !G.active || !d || typeof d.t !== 'string') return;
  if (d.t === 'ch') { grpOnCh(p, d); return; }
  if (d.t === 'proof') { grpOnProof(p, d); return; }
  if (!p.connected) { p.queue = p.queue || []; if (p.queue.length < 50) p.queue.push(d); return; }
  if (!p.virt && grpFwdOnData(p, d)) return; // мост (group-bridge.js)
  if (p.virt && !FWD_TYPES.has(d.t)) return;
  switch (d.t) {
    case 'hello':
      if (!isFriend(p.id) && G.members.has(p.id)) G.members.get(p.id).nick = grpClean(d.nick) || G.members.get(p.id).nick;
      p.muted = !!d.muted; p.deaf = !!d.deaf;
      p.peerCam = d.cam === 1 && !p.virt;
      p.peerFwd = d.fwd === 1;
      p.camOn = !!d.camOn;
      if (p.peerCam && CAM.on) grpCamEnsure(p);
      grpOnScreen(p, !!d.sharing, d.name, d.perm);
      if (isFriend(p.id)) onPeerAvatarHash(p.id, String(d.av || '').slice(0, 32), () => grpSend(p, { t: 'av-want' }));
      grpMergeRoster(d.members);
      grpRender();
      return;
    case 'av-want': { const f = myAvatarFile(); if (f) p.chan.queue([f], 'avatar'); return; }
    case 'chat-op': applyOp(G.conv,d,p.id);return;
    case 'member': if (grpAddMember({ id: d.id, nick: d.nick, via: d.via || p.id }, true)) { grpRender(); grpSyncPeers(); } return;
    case 'gone': if (d.id !== grpMe() && G.members.has(d.id) && !grpOpen(d.id)) grpMemberGone(d.id, 'вышел'); return;
    case 'relay': grpRelay(p.id, d); return;
    case 'sig': grpOnSig(p.id, d, false); return;
    case 'state': p.muted = !!d.muted; p.deaf = !!d.deaf; grpRender(); return;
    case 'screen': grpOnScreen(p, !!d.on, d.name, d.perm); grpRender(); return;
    case 'gdraw': case 'gptr': case 'gptr-off': case 'gclear': case 'greact': grpOnMark(p, d); return;
    case 'ctl-req': grpSend(p, { t: 'ctl-deny', why: 'телефоном управлять нельзя' }); return;
    case 'ctl-grant': if (CV.link?.id === p.id && CV.state !== 'off') grpCtlOpen(p, d); return;
    case 'ctl-deny':
      if (CV.link?.id === p.id && CV.state === 'req') { clearTimeout(CV.reqTimer); CV.state = 'off'; CV.link = null; grpUpdateTools(); toast(`${grpNick(p.id)} ${String(d.why || 'отказал').slice(0, 60)}`); }
      return;
    case 'ctl-end': if (CV.link?.id === p.id) ctlViewStop(false, String(d.why || '').slice(0, 60) || `${grpNick(p.id)} забрал управление`); return;
    case 'view': {
      if (!['full', 'thumb', 'off'].includes(d.view) || p.view === d.view) return;
      p.view = d.view;
      if (G.share) grpTuneAll();
      return;
    }
    case 'chat': {
      const text = String(d.text || '').slice(0, 2000);
      if (!text) return;
      const mid = cleanMid(d.mid) || newMid();
      const re = reIn(d.re);
      if(re)re.by=d.re.mine?p.id:(G.conv.msgs.get(re.mid)?.e.who||'peer');
      const ts = Number(d.ts) || Date.now();
      chatMsg(G.conv, grpNick(p.id), text, false, ts, null, { mid, re,who:p.id });
      record(G.conv, { mid, ts, who: p.id, nick: grpNick(p.id), type: 'text', text, re: re || undefined });
      sound('msg');
      grpBumpUnread();
      return;
    }
    case 'sp-stop': spStopAll(); return; // участник убрал всё со своего экрана (ПК 1.17)
    case 'gcam': p.camOn = !!d.on; if (p.camOn) { grpSys(`${grpNick(p.id)} включил камеру`); grpCamWatch(p); } grpRender(); return;
    case 'gcam-need': p.peerCam = true; if (p.role === 'out') grpCamEnsure(p, true); return;
    case 'greneg': grpOnReneg(p, d); return;
    case 'greneg-ans': grpOnRenegAns(p, d); return;
    case 'bye': grpMemberGone(p.id, 'вышел'); grpSendAll({ t: 'gone', id: p.id }); return;
    default:
  }
}
function grpOnScreen(p, on, name, perm) {
  const was = p.sharing;
  p.sharing = on;
  p.perm = { draw: !!perm?.draw, react: !!perm?.react, ctl: !!perm?.ctl };
  const title = grpClean(name, 60);
  if (on && !was) { grpSys(`${grpNick(p.id)} показывает экран${title ? ' — ' + title : ''}. Нажми на плитку — крупно`); if (!G.focus) G.focus = p.id; }
  if (!on && G.focus === p.id) G.focus = null;
  if (!on) grpCtlGone(p.id, 'показ закончился');
}
function grpOnTrack(p, e) {
  if (e.track.kind === 'video') {
    // камера (своя пара — по mid из greneg, мост — 4-й трансивер) отдельно от экрана
    if (e.transceiver === p.ctx || (p.camMid != null && e.transceiver.mid === p.camMid)) { p.cstream = new MediaStream([e.track]); grpRender(); return; }
    p.vstream = new MediaStream([e.track]); grpRender(); return;
  }
  // трансивер 2 — звук экрана, иначе голос
  const screen = p.pc.getTransceivers().indexOf(e.transceiver) === 2;
  const stream = new MediaStream([e.track]);
  const el = new Audio();
  el.srcObject = stream;
  el.autoplay = true;
  const a = { el, screen };
  p.aud[screen ? 'screen' : 'voice'] = a;
  grpApplyVol(p, a);
  el.play().catch(() => {});
  if (!screen) p.stopMeter = makeMeter(stream, (lvl) => { const tile = G.tiles.get(p.id); tile?.classList.toggle('speaking', lvl > 0.02 && !S.deafened); window.talkingAvatar?.level(tile, (!S.deafened) ? lvl : 0); });
}
// пока участник не подтвердил свой ID — тишина; «Звук» выключает всех
function grpApplyVol(p, a) { a.el.muted = !p.connected || S.deafened; a.el.volume = a.screen ? Number($('gScreenVol')?.value || 100) / 100 : 1; }
function grpApplyAllVols() { for (const p of [...G.peers.values(), ...G.vpeers.values()]) for (const a of Object.values(p.aud)) grpApplyVol(p, a); }

/* ---------- Файлы всем ---------- */
function grpQueueFiles(list, extra = {}) {
  const chans = [...G.peers.values()].filter((x) => x.connected).map((x) => x.chan);
  const viaBridge = [...G.vpeers.values()].filter((v) => v.connected && !G.peers.get(v.id)?.connected);
  if (viaBridge.length) grpSys(`Файлы до ${viaBridge.map((v) => grpNick(v.id)).join(', ')} не дойдут: нет прямой связи`);
  if (!chans.length) { toast('В группе пока никого нет на связи'); return; }
  for (const f of list) {
    if (!f) continue;
    if (f.size > MAX_FILE) { toast(`${f.name}: слишком большой — не отправлю`); continue; }
    const fid = crypto.getRandomValues(new Uint32Array(1))[0];
    const name = f.name || `картинка-${Date.now()}.${((f.type || '').split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const meta = { fid, name, size: f.size, mime: f.type || 'application/octet-stream', p: 'chat', kind: fileKind(f.type || ''), ...(extra.st ? { st: 1 } : {}) };
    const ui = fileBubble(G.conv, S.nick || 'Я', meta, true, { mid: fmid(fid) });
    ui.progress(0);
    const prog = new Array(chans.length).fill(0);
    let settled = 0, url = null, why = '';
    const settle = () => {
      if (++settled < chans.length) return;
      if (url) ui.done(url); else ui.fail(why || 'не дошло');
      if (url && why) grpSys(`«${name}» дошёл не до всех: ${why}`);
    };
    chans.forEach((ch, i) => ch.queue([f], 'chat', { fid, st: extra.st, ui: {
      progress(n) { prog[i] = n; ui.progress(Math.min(...prog)); },
      done(u) { if (!url) url = u; else URL.revokeObjectURL(u); settle(); },
      fail(w) { why = w; settle(); },
      loading() {}, gone() {},
    } }));
  }
}

/* ---------- Показ экрана телефона в группу ----------
   Тот же захват, что в звонке на двоих (startShare): дорожки видео и звука идут каждому участнику.
   Каждый зритель сообщает, как смотрит ('view'): full — полное качество, thumb — маленькой плиткой, off — свернул. */
const GRP_THUMB = { h: 360, fps: 15, br: 600_000 };
async function grpShareStart(track, atrack, q) {
  G.share = { track, atrack, q };
  await Promise.all(Array.from(G.peers.values(),p=>grpAttachSenders(p)));
  await grpTuneAll();
  grpSendAll({ t: 'screen', on: true, name: '', perm: grpMyPerm() });
  L('grp', { share: true, peers: G.peers.size, audio: !!atrack });
  grpRender();
}
function grpShareStop() {
  if (!G.share) return;
  G.share = null;
  for (const p of G.peers.values()) grpAttachSenders(p);
  grpSendAll({ t: 'screen', on: false });
  grpRender();
}
// A software encoder per full-size receiver can overload smaller phones even
// when WebRTC does not report CPU limitation. Act only on sustained measured load.
function grpUpdateSoftwareBudget(share, peers, feedFps) {
  if (!share) return false;
  const full = peers.filter(p => p.view === 'full');
  const target = share.q.fps;
  const average = full.reduce((sum, p) => sum + p.fps, 0) / Math.max(1, full.length);
  const eligible = full.length > 1 && feedFps >= target * 0.85 &&
    full.every(p => p.software && (p.reason === 'none' || p.reason === 'cpu'));
  share.softwareVideoRates = eligible ? [...(share.softwareVideoRates || []), average].slice(-3) : [];
  share.slowVideoSamples = eligible && average < target * 0.94 ? (share.slowVideoSamples || 0) + 1 : 0;
  const rates = share.softwareVideoRates;
  if (rates.length < 3 || rates.filter(rate => rate < target * 0.94).length < 2 ||
      rates.reduce((sum, rate) => sum + rate, 0) / rates.length >= target * 0.94) return false;
  const factor = share.softwareBudget ? Math.min(1.5, (share.softwareBudgetFactor || 1) * 1.25) : 1;
  if (share.softwareBudget && factor === share.softwareBudgetFactor) return false;
  share.softwareBudget = true;
  share.softwareBudgetFactor = factor;
  share.softwareVideoRates = [];
  return true;
}
function grpFullVideoScale(share, peers) {
  if (!share?.softwareBudget) return 1;
  const full = peers.filter(p => p.connected && (p.view || 'full') === 'full').length;
  return full < 2 ? 1 : Math.sqrt(full) * (share.softwareBudgetFactor || 1);
}

async function grpTuneVideo(p) {
  const sender = p.vtx?.sender;
  if (!G.share || !sender?.track) return;
  const view = p.view || 'full';
  const prm = sender.getParameters();
  if (!prm.encodings?.length) prm.encodings = [{}];
  screenEncodingCodec(prm);
  const e = prm.encodings[0];
  const h = sender.track.getSettings().height || 1280;
  e.active = view !== 'off';
  e.scaleResolutionDownBy = view === 'thumb' ? Math.max(1, h / GRP_THUMB.h) : grpFullVideoScale(G.share, [...G.peers.values()]);
  e.maxBitrate = view === 'thumb' ? GRP_THUMB.br : G.share.q.kbps * 1000;
  e.maxFramerate = view === 'thumb' ? GRP_THUMB.fps : G.share.q.fps * (SH?.sink?.paced ? 1.5 : 1);
  // как в звонке на двоих: видеочипу — постоянный размер (прыжки ломали кодировщик), программному — можно уменьшать
  prm.degradationPreference = SCREEN_COMPAT.codec === 'VP8' ? 'maintain-framerate' : p.swEnc ? 'balanced' : 'maintain-resolution';
  if (p.swEnc == null) sender.getStats().then((rep) => rep.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video' && r.powerEfficientEncoder === false && !p.swEnc) { p.swEnc = true; grpTuneVideo(p); }
  })).catch(() => {});
  try { await sender.setParameters(prm); } catch (err) { L('grp', { tuneFailed: err.message }); }
}
async function grpTuneAll() {
  if (!G.share) return;
  for (const p of G.peers.values()) {
    if (!p.connected) continue;
    await grpTuneVideo(p);
    if (p.satx && G.share.atrack) await tuneAudioSender(p.satx.sender, 128_000);
  }
}
// у меня: как я сейчас смотрю экран каждого показывающего (крупно — только выбранный)
function grpSendViews() {
  for (const p of [...G.peers.values(), ...G.vpeers.values()]) {
    if (!p.connected || !p.sharing || (p.virt && G.peers.get(p.id)?.connected)) { p.viewSent = null; continue; }
    const mine = document.hidden ? 'off' : G.focus === p.id ? 'full' : 'thumb';
    // я мост: через меня экран могут смотреть крупно — просим у источника лучшее из двух
    const fw = p.virt ? null : grpFwdWantView(p.id);
    const view = fw === 'full' || mine === 'full' ? 'full' : fw === 'thumb' || mine === 'thumb' ? 'thumb' : 'off';
    if (p.viewSent === view) continue;
    p.viewSent = view;
    grpSend(p, { t: 'view', view });
  }
}

/* ---------- Указка, рисунки и реакции поверх экрана участника ----------
   Зритель шлёт всем ('to' — чей экран): показывающий выводит их в окно поверх экрана, остальные зрители — поверх плитки.
   Цвет — у каждого свой (как у ПК). */
const GRP_COLORS = ['#ff3c50', '#3ddc84', '#4fd1ff', '#ffcd1f', '#ff2bd6', '#ff8c42', '#b48cff'];
function grpColor(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return GRP_COLORS[h % GRP_COLORS.length]; }
function grpMyPerm() { return { ...myPerm(), ctl: false }; }
// настройки «поверх моего экрана» поменялись — участники узнают сразу
function grpPermChanged() { if (G.active && G.share) grpSendAll({ t: 'screen', on: true, name: '', perm: grpMyPerm() }); }
const GT = { mode: null, stroke: null, ptrAt: 0, flushAt: 0, react: [], strokes: new Map(), ptrs: new Map(), raf: 0, cv: null, reactOpen: false };

// где на плитке настоящая картинка видео (без чёрных полос)
function grpVideoRect(v) {
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const k = Math.min(r.width / vw, r.height / vh);
  const w = vw * k, h = vh * k;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}
function grpPt(e, el) {
  const r = grpVideoRect(el.querySelector('video'));
  return [n4(Math.max(0, Math.min(1, (e.clientX - r.x) / r.w))), n4(Math.max(0, Math.min(1, (e.clientY - r.y) / r.h)))];
}
function grpAddTools(el, id) {
  const cv = document.createElement('canvas');
  cv.className = 'gdraw';
  const inp = document.createElement('div');
  inp.className = 'ginput';
  inp.addEventListener('pointerdown', (e) => {
    if (!GT.mode || G.focus !== id) return;
    e.preventDefault();
    e.stopPropagation();
    try { inp.setPointerCapture(e.pointerId); } catch { /* */ }
    const q = grpPt(e, el);
    if (GT.mode === 'draw') {
      GT.stroke = { id: newMid(), to: id, pending: [q], pointer: e.pointerId };
      GT.strokes.set('me:' + GT.stroke.id, { c: grpColor(grpMe()), pts: [q], done: false, ts: Date.now() });
    } else if (GT.mode === 'ptr') {
      grpSendAll({ t: 'gptr', to: id, x: q[0], y: q[1] });
      GT.ptrs.set(grpMe(), { x: q[0], y: q[1], ts: Date.now(), nick: '', c: grpColor(grpMe()) });
    }
    grpKickMarks();
  });
  inp.addEventListener('pointermove', (e) => {
    if (!GT.mode || G.focus !== id) return;
    const now = Date.now();
    const q = grpPt(e, el);
    if (GT.mode === 'ptr' && e.buttons && now - GT.ptrAt > 40) {
      GT.ptrAt = now;
      grpSendAll({ t: 'gptr', to: id, x: q[0], y: q[1] });
      GT.ptrs.set(grpMe(), { x: q[0], y: q[1], ts: now, nick: '', c: grpColor(grpMe()) });
      grpKickMarks();
    }
    if (GT.mode === 'draw' && GT.stroke && GT.stroke.pointer === e.pointerId) {
      GT.stroke.pending.push(q);
      GT.strokes.get('me:' + GT.stroke.id)?.pts.push(q);
      grpKickMarks();
      if (now - GT.flushAt > 50) { GT.flushAt = now; grpFlushStroke(false); }
    }
  });
  const end = () => {
    if (GT.stroke) grpFlushStroke(true);
    if (GT.mode === 'ptr') { grpSendAll({ t: 'gptr-off', to: id }); GT.ptrs.delete(grpMe()); grpKickMarks(); }
  };
  inp.addEventListener('pointerup', end);
  inp.addEventListener('pointercancel', end);
  el.append(cv, inp);
  el.cv = cv;
}
function grpFlushStroke(done) {
  const st = GT.stroke;
  if (!st) return;
  const pts = st.pending.splice(0);
  if (pts.length || done) grpSendAll({ t: 'gdraw', to: st.to, id: st.id, pts, done: !!done });
  if (done) { const ls = GT.strokes.get('me:' + st.id); if (ls) { ls.done = true; ls.ts = Date.now(); } GT.stroke = null; }
}
function grpSetTool(mode) {
  GT.mode = GT.mode === mode ? null : mode;
  if (GT.mode !== 'ptr' && G.focus) grpSendAll({ t: 'gptr-off', to: G.focus });
  grpUpdateTools();
}
function grpReact(to, e) {
  const now = Date.now();
  GT.react = GT.react.filter((t) => now - t < 2000);
  if (GT.react.length >= 6) return; // не больше 6 за 2 секунды
  GT.react.push(now);
  grpSendAll({ t: 'greact', to, e });
  grpFloat(e, G.tiles.get(to));
}
function grpFloat(e, el) {
  if (!el) return;
  const f = document.createElement('div');
  f.className = 'gfloat';
  f.textContent = e;
  f.style.left = (10 + Math.random() * 75) + '%';
  el.appendChild(f);
  setTimeout(() => f.remove(), 2600);
}
// панель инструментов — только над крупно открытым чужим экраном
function grpUpdateTools() {
  const id = G.focus;
  const p = id ? G.peers.get(id) : null;
  const on = !!p?.connected && !!p.sharing;
  $('gTools').classList.toggle('hidden', !on);
  if (!on) { GT.mode = null; GT.reactOpen = false; }
  const perm = p?.perm || {};
  if (GT.mode && !perm.draw) GT.mode = null;
  for (const b of $('gTools').querySelectorAll('[data-m]')) { b.classList.toggle('on', GT.mode === b.dataset.m); b.disabled = !perm.draw; }
  $('gToolClear').disabled = !perm.draw;
  $('gToolReact').disabled = !perm.react;
  const mine = CV.link?.id === id;
  $('gToolCtl').disabled = !(perm.ctl || mine) || (CV.state !== 'off' && !mine);
  $('gToolCtl').classList.toggle('on', mine && CV.state === 'on');
  $('gToolCtl').textContent = mine && CV.state === 'req' ? '⏳' : '🎮';
  if (!perm.react) GT.reactOpen = false;
  $('gToolReact').classList.toggle('on', GT.reactOpen);
  $('gReactBar').classList.toggle('hidden', !on || !GT.reactOpen);
  $('gToolHint').textContent = on && !perm.draw && !perm.react && !perm.ctl ? 'Показывающий не разрешил рисовать, реакции и управление' : '';
  for (const [tid, t] of G.tiles) t.querySelector('.ginput')?.classList.toggle('active', !!GT.mode && tid === id);
}
// чужая отметка: на моём экране — в окно поверх приложений; на экране, который я смотрю крупно, — на плитку
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
      if (toMe) ovlMsg({ t: 'stroke', id: key, c, w: 5, pts, done: !!d.done });
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
      if (toMe) ovlMsg({ t: 'ptr', pid: p.id, x: clamp(d.x), y: clamp(d.y), nick: grpNick(p.id), c });
      else if (viewing) { GT.ptrs.set(p.id, { x: clamp(d.x), y: clamp(d.y), ts: Date.now(), nick: grpNick(p.id), c }); grpKickMarks(); }
      return;
    case 'gptr-off':
      if (toMe) ovlMsg({ t: 'ptr-off', pid: p.id });
      else { GT.ptrs.delete(p.id); grpKickMarks(); }
      return;
    case 'gclear':
      if (!perm.draw) return;
      if (toMe) ovlMsg({ t: 'clear' });
      else if (viewing) { GT.strokes.clear(); grpKickMarks(); }
      return;
    case 'greact': {
      if (!perm.react || !REACTIONS.includes(d.e)) return;
      p.reactIn = (p.reactIn || []).filter((t) => Date.now() - t < 2000);
      if (p.reactIn.length >= 8) return;
      p.reactIn.push(Date.now());
      if (toMe) ovlMsg({ t: 'react', e: d.e });
      else if (viewing) grpFloat(d.e, G.tiles.get(d.to));
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
  if (!cv || !el.classList.contains('sharing')) { GT.strokes.clear(); GT.ptrs.clear(); return; }
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(el.clientWidth * dpr) || cv.height !== Math.round(el.clientHeight * dpr)) { cv.width = Math.round(el.clientWidth * dpr); cv.height = Math.round(el.clientHeight * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  const er = el.getBoundingClientRect();
  const r = grpVideoRect(el.querySelector('video'));
  const X = (x) => r.x - er.left + x * r.w, Y = (y) => r.y - er.top + y * r.h;
  const now = Date.now();
  let alive = false;
  for (const [k, s] of GT.strokes) {
    const age = s.done ? now - s.ts : 0;
    const a = age < 2500 ? 1 : 1 - (age - 2500) / 1500;
    if (a <= 0) { GT.strokes.delete(k); continue; }
    alive = true;
    g.globalAlpha = a; g.strokeStyle = s.c; g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    s.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    if (s.pts.length === 1) g.lineTo(X(s.pts[0][0]) + 0.1, Y(s.pts[0][1]));
    g.stroke();
  }
  g.globalAlpha = 1;
  for (const [k, q] of GT.ptrs) {
    if (now - q.ts > 1500) { GT.ptrs.delete(k); continue; }
    alive = true;
    g.globalAlpha = 0.3; g.fillStyle = q.c; g.beginPath(); g.arc(X(q.x), Y(q.y), 14, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1; g.beginPath(); g.arc(X(q.x), Y(q.y), 6, 0, Math.PI * 2); g.fill();
    if (q.nick) {
      g.font = '600 12px system-ui, sans-serif';
      const tw = g.measureText(q.nick).width;
      g.fillStyle = 'rgba(15,16,20,.85)'; g.fillRect(X(q.x) + 10, Y(q.y) + 8, tw + 10, 18);
      g.fillStyle = '#fff'; g.fillText(q.nick, X(q.x) + 15, Y(q.y) + 21);
    }
  }
  if (alive) GT.raf = requestAnimationFrame(grpDrawMarks);
}

/* ---------- Управление участником (как у ПК: CV.link, один управляющий на показывающего) ---------- */
function grpCtlLink(id) {
  const peer = () => G.peers.get(id);
  const raw = (ch, a) => { try { if (ch?.readyState === 'open') ch.send(JSON.stringify(a)); } catch { /* */ } };
  return { id, sig: (o) => grpSend(peer(), o), raw: (a, fast) => raw(fast ? peer()?.cdu : peer()?.cdc, a), nick: () => grpNick(id) };
}
function grpCtlClick() {
  const id = G.focus;
  if (!id) return;
  if (CV.state === 'on' && CV.link?.id === id) { ctlViewStop(true); toast('Управление отдано'); return; }
  if (CV.state !== 'off') return;
  CV.link = grpCtlLink(id);
  GT.mode = null;
  grpSendAll({ t: 'gptr-off', to: id });
  ctlRequest();
}
// разрешил: экран управления звонка на двоих — поверх группы, с его экраном
let grpCtlHome = null;
function grpCtlOpen(p, perm) {
  const wrap = $('remoteScreenWrap');
  if (!grpCtlHome) grpCtlHome = { parent: wrap.parentElement, next: wrap.nextSibling };
  $('gStage').appendChild(wrap);
  wrap.classList.add('gctl-view');
  wrap.classList.remove('hidden');
  $('remoteScreen').srcObject = p.vstream || null;
  $('remoteScreen').muted = true; // звук его экрана уже играет в группе
  $('remoteScreen').play().catch(() => {});
  $('remoteScreenOwner').textContent = grpNick(p.id);
  $('remoteStats').textContent = '';
  $('remoteReason').textContent = '';
  ctlViewStart(perm);
  grpUpdateTools();
  L('grp', { control: 'start', peer: p.id.slice(0, 8) });
}
// управление закончилось (отдал, он забрал, связь пропала) — обратно к плиткам
function grpCtlClose() {
  const wrap = $('remoteScreenWrap');
  if ($('remoteScreenWrap').classList.contains('fs')) setFullscreen(false);
  wrap.classList.add('hidden');
  wrap.classList.remove('gctl-view');
  $('remoteScreen').srcObject = null;
  if (grpCtlHome) { grpCtlHome.parent.insertBefore(wrap, grpCtlHome.next); grpCtlHome = null; }
  CV.link = null;
  if (G.active) grpUpdateTools();
}
function grpCtlGone(id, why) {
  if (CV.link?.id !== id) return;
  if (CV.state === 'on') { ctlViewStop(false, why); return; }
  clearTimeout(CV.reqTimer); // ещё ждали ответа на запрос
  if (CV.state === 'req') toast(`Управление: ${why}`);
  CV.state = 'off';
  CV.link = null;
  if (G.active) grpUpdateTools();
}

/* ---------- Экран группы ---------- */
function grpEnterUi() {
  closeDm();
  setCompose(composers.grp, null);
  $('gChatInput').value = '';
  showScreen('group');
  G.conv = { id: G.gid, nick: 'Группа', box: newConvBox(), loaded: false, unread: 0, pending: [], msgs: new Map(),group:true,nickOf:id=>grpNick(id) };
  mountConv(G.conv, $('gMessages'));
  loadHistory(G.conv);
  G.tiles.clear();
  $('gGrid').replaceChildren();
  G.chatOpen = false;
  G.unread = 0;
  $('gChatPanel').classList.add('hidden');
  G.stopMyMeter?.();
  G.stopMyMeter = makeMeter(S.mic, (lvl) => { const tile = G.tiles.get(grpMe()); tile?.classList.toggle('speaking', lvl > 0.02 && !S.muted && !S.deafened); window.talkingAvatar?.level(tile, (!S.muted && !S.deafened) ? lvl : 0); });
  updateService();
  setTimeout(() => alo.audioRoute({}).then((r) => { S.speaker = !!r.speaker; grpUpdateControls(); }), 500);
  grpUpdateControls();
}
function grpUpdateControls() {
  const micOff = S.muted || S.deafened;
  $('gMute').classList.toggle('off', micOff);
  $('gMute').classList.toggle('mic-muted', micOff);
  $('gMute').setAttribute('aria-label', micOff ? 'Микрофон выключен' : 'Микрофон');
  $('gMute').querySelector('span').textContent = micOff ? 'Выкл.' : 'Микр.';
  $('gSpeaker').classList.toggle('on', !!S.speaker);
  $('gDeafen').classList.toggle('off', S.deafened);
  $('gShare').classList.toggle('on', !!SH);
  $('gShare').querySelector('span').textContent = SH ? 'Стоп' : 'Экран';
  $('gChatBtn').classList.toggle('on', G.chatOpen);
  $('gBadge').classList.toggle('hidden', !G.unread);
  $('gBadge').textContent = G.unread > 99 ? '99+' : String(G.unread);
}
function grpBumpUnread() { if (!G.chatOpen) { G.unread++; grpUpdateControls(); } }
function grpToggleChat(open = !G.chatOpen) {
  if (!open) {
    pauseMediaIn($('gMessages'));
    if ($('gChatPanel').contains(document.activeElement)) document.activeElement.blur();
  }
  G.chatOpen = open;
  $('gChatPanel').classList.toggle('hidden', !open);
  if (open) { G.unread = 0; scrollEnd(G.conv, true); }
  grpUpdateControls();
}

/* ---------- Сохранённые группы: собрать тех же ещё раз (история чата общая) ---------- */
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
const grpSavedNick = (m) => grpFriend(m.id)?.nick || grpClean(m.nick) || 'Участник';
function grpRenderSaved() {
  const box = $('groupsBox');
  if (!box || G.active) return;
  const list = grpSaved().filter((g) => g.members.length);
  box.classList.toggle('hidden', !list.length);
  const el = $('groupsList');
  el.replaceChildren();
  for (const g of list) {
    const online = g.members.filter((m) => grpFriend(m.id)?.online).length;
    const row = document.createElement('div');
    row.className = 'friend' + (online ? ' online' : '');
    const av = document.createElement('div');
    av.className = 'favatar';
    av.textContent = '👥';
    const name = document.createElement('div');
    name.className = 'fmeta';
    const b = document.createElement('b');
    b.textContent = g.members.map(grpSavedNick).join(', ');
    const st = document.createElement('small');
    st.textContent = online ? `в сети из друзей: ${online}` : 'никого из друзей нет в сети';
    name.append(b, st);
    const call = document.createElement('button');
    call.className = 'btn small-btn primary';
    call.textContent = 'Собрать';
    call.onclick = () => grpCallSaved(g.gid);
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Убрать группу');
    confirmBtn(del, '✕?', () => { store.set('groups', grpSaved().filter((x) => x.gid !== g.gid)); store.del('hist.' + g.gid); grpRenderSaved(); });
    row.append(av, name, call, del);
    el.appendChild(row);
  }
}
async function grpCallSaved(gid) {
  const g = grpSaved().find((x) => x.gid === gid);
  if (!g) return;
  const online = g.members.filter((m) => grpFriend(m.id)?.online);
  if (!online.length) { toast('Никого из друзей этой группы нет в сети'); return; }
  if (!(await grpStart(gid))) return;
  grpInvite(online.map((m) => m.id));
  const others = g.members.filter((m) => !isFriend(m.id)).map(grpSavedNick);
  if (others.length) grpSys(`${others.join(', ')} — не у тебя в друзьях: их позовёт кто-то из группы («➕ Позвать»)`);
}

function grpPaintAvatar(id) {
  const el = G.tiles.get(id);
  if (el) paintAvatar(el.querySelector('.avatar'), id === grpMe() ? myAvatarUrl() : friendAvatar(id)?.url);
}
function grpTile(id) {
  let el = G.tiles.get(id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'gtile';
  el.dataset.id = id;
  const v = document.createElement('video');
  v.autoplay = true; v.playsInline = true; v.muted = true;
  // камера участника (ПК 1.19): без показа экрана — вместо аватарки, при показе — маленькой в углу
  const cv = document.createElement('video');
  cv.className = 'gcam';
  cv.autoplay = true; cv.playsInline = true; cv.muted = true;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.appendChild(document.createElement('span'));
  const nm = document.createElement('div');
  nm.className = 'gname';
  const n = document.createElement('span');
  const b = document.createElement('em');
  b.className = 'badges';
  nm.append(n, ' ', b);
  el.append(v, cv, av, nm);
  if (id === grpMe()) el.classList.add('me');
  if (id !== grpMe()) grpAddTools(el, id);
  // экран участника: нажатие — крупно / обратно (пока выбрана указка или карандаш — касания рисуют)
  el.onclick = () => {
    if (GT.mode && G.focus === id) return;
    if (el.classList.contains('sharing') && id !== grpMe()) { G.focus = G.focus === id ? null : id; GT.strokes.clear(); GT.ptrs.clear(); grpRender(); grpKickMarks(); }
  };
  G.tiles.set(id, el);
  grpPaintAvatar(id);
  return el;
}
let grpRenderQueued = false;
function grpRender() {
  if (grpRenderQueued) return;
  grpRenderQueued = true;
  queueMicrotask(() => { grpRenderQueued = false; grpRenderNow(); });
}
function grpRenderNow() {
  if (!G.active) return;
  const grid = $('gGrid');
  const me = grpMe();
  const ids = [me, ...[...G.members.keys()].filter((id) => id !== me)];
  for (const [id, el] of G.tiles) if (!G.members.has(id) && id !== me) { el.remove(); G.tiles.delete(id); }
  ids.forEach((id, i) => {
    const el = grpTile(id);
    const p = grpViewPeer(id); // прямой или через мост
    const mine = id === me;
    const on = mine || !!p?.connected;
    const sharing = mine ? !!G.share : !!(p?.connected && p.sharing);
    const v = el.querySelector('video');
    // свой показ на телефоне не выводим (это и так мой экран)
    const want = sharing && !mine ? p.vstream || null : null;
    if (v.srcObject !== want) v.srcObject = want;
    const camSt = mine ? (CAM.on ? CAM.stream : null) : (p?.connected && p.camOn ? p.cstream || null : null);
    const cv = el.querySelector('.gcam');
    if (cv.srcObject !== camSt) { cv.srcObject = camSt; if (camSt) cv.play().catch(() => {}); }
    el.classList.toggle('cam', !!camSt);
    // мост-телефон экран не пересылает — так и пишем
    const noScr = !mine && p?.virt && p.noVideo && p.sharing;
    el.classList.toggle('sharing', sharing && !mine);
    el.classList.toggle('me-sharing', mine && sharing);
    el.classList.toggle('ghost', !on);
    el.classList.toggle('focused', G.focus === id);
    el.querySelector('.avatar span').textContent = initial(grpNick(id));
    el.querySelector('.gname span').textContent = grpNick(id) + (mine ? ' (я)' : '') + (mine && sharing ? ' · показываю экран' : '');
    const muted = mine ? S.muted || S.deafened : p?.muted || p?.deaf;
    const deaf = mine ? S.deafened : p?.deaf;
    const wait = on ? (p?.virt ? ` · через ${grpNick(p.via)}` + (noScr ? ' (экран не виден)' : '') : '') : G.lostAt.has(id) ? ' · переподключаюсь…' : ' · соединяюсь…';
    el.querySelector('.badges').textContent = (on && deaf ? '🔇' : '') + (on && muted ? '🎙̸' : '') + wait;
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
  });
  if (G.focus && !G.tiles.get(G.focus)?.classList.contains('sharing')) G.focus = null;
  grid.classList.toggle('focus', !!G.focus);
  const n = 1 + [...G.members.keys()].filter((id) => id !== me && grpViewPeer(id)?.connected).length; // и те, кто через мост
  $('gStatus').querySelector('span').textContent = `В звонке: ${n} из ${G.members.size}`;
  $('gStatus').className = 'status ' + (n > 1 ? 'ok' : 'waiting');
  $('gScreenVolRow').classList.toggle('hidden', ![...G.peers.values(), ...G.vpeers.values()].some((p) => p.connected && p.sharing));
  grpSendViews();
  grpUpdateTools();
  grpUpdateControls();
}
function grpReset() {
  if(typeof composers!=='undefined'&&composers.grp.bar)setCompose(composers.grp,null);
  if (G.manualPending?.p) grpClosePeer(G.manualPending.p);
  G.manualPending = null;
  $('groupManualReply').classList.add('hidden');
  for (const t of G.lostTimers.values()) clearTimeout(t);
  GT.mode = null; GT.stroke = null; GT.strokes.clear(); GT.ptrs.clear(); GT.reactOpen = false;
  for (const m of [G.members, G.left, G.seen, G.peers, G.connecting, G.lostAt, G.lostTimers, G.tiles, G.nickCache]) m.clear();
  G.gid = null; G.focus = null; G.conv = null; G.share = null;
}
function grpLeave(text) {
  if (!G.active) return;
  L('grp', { leave: text || 'self' });
  if (CV.link) { if (CV.state !== 'off') ctlViewStop(true, 'ты вышел из группы'); else grpCtlClose(); }
  grpSendAll({ t: 'bye' });
  for (const id of G.members.keys()) if (id !== grpMe() && !grpOpen(id) && isFriend(id)) grpFriendsSend(id, { t: 'grp-leave', gid: G.gid });
  if (SH) stopShare(true);
  camReset();
  grpFwdReset();
  spStopAll();
  const peers = [...G.peers.values()];
  G.active = false;
  clearTimeout(G.joinTimer);
  setTimeout(() => peers.forEach(grpClosePeer), 300); // даём «bye» уйти
  grpReset();
  G.stopMyMeter?.(); G.stopMyMeter = null;
  releaseMic();
  S.muted = false;
  S.deafened = false;
  $('gGrid').replaceChildren();
  showScreen('lobby');
  showStep('stepHome');
  renderFriends();
  grpRenderSaved();
  restoreCallOverlays();
  updateService();
  if (text) toast(text);
}

function grpBind() {
  $('frGroupManualCreate').onclick = grpManualCreate;
  $('frGroupManualCopy').onclick = () => autoCopy($('frGroupManualOffer').value, $('frGroupManualCopy'));
  $('frGroupManualApply').onclick = () => grpManualApply($('frGroupManualAnswer').value);
  $('groupManualJoin').onclick = () => grpManualJoin($('groupManualInput').value);
  $('groupManualReplyCopy').onclick = () => autoCopy($('groupManualReplyCode').value, $('groupManualReplyCopy'));
  $('groupManualReplyClose').onclick = () => $('groupManualReply').classList.add('hidden');
  $('btnGroup').onclick = grpOpenPick;
  $('gPickGo').onclick = grpPickGo;
  $('gPickClose').onclick = () => $('gPick').classList.add('hidden');
  $('gInviteMore').onclick = grpOpenPick;
  $('gInvAccept').onclick = grpAcceptInvite;
  $('gInvDecline').onclick = () => grpDeclineInvite();
  $('gMute').onclick = () => { setMuted(!S.muted); grpSendAll({ t: 'state', muted: S.muted, deaf: S.deafened }); grpRender(); };
  $('gDeafen').onclick = () => { setDeafened(!S.deafened); grpApplyAllVols(); grpSendAll({ t: 'state', muted: S.muted, deaf: S.deafened }); grpRender(); };
  $('gSpeaker').onclick = async () => { const r = await alo.audioRoute({ speaker: !S.speaker }); S.speaker = !!r.speaker; grpUpdateControls(); };
  $('gShare').onclick = () => { if (SH) stopShare(); else startShare(); };
  $('gCam').onclick = () => camToggle();
  $('gLeave').onclick = () => grpLeave();
  $('gChatBtn').onclick = () => grpToggleChat();
  $('gToolPtr').onclick = () => grpSetTool('ptr');
  $('gToolDraw').onclick = () => grpSetTool('draw');
  $('gToolClear').onclick = () => { if (!G.focus) return; grpSendAll({ t: 'gclear', to: G.focus }); GT.strokes.clear(); grpKickMarks(); };
  $('gToolReact').onclick = () => { GT.reactOpen = !GT.reactOpen; grpUpdateTools(); };
  $('gToolCtl').onclick = () => grpCtlClick();
  for (const r of REACTIONS) {
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.textContent = r;
    b.onclick = () => { if (G.focus) grpReact(G.focus, r); };
    $('gReactBar').appendChild(b);
  }
  $('gScreenVol').oninput = () => grpApplyAllVols();
  $('gAttach').onclick = () => $('gFileInput').click();
  $('gFileInput').onchange = (e) => { grpQueueFiles([...e.target.files]); e.target.value = ''; };
  $('gChatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('gChatInput').value.trim();
    if (!text || !G.active) return;
    if(composeSubmitEdit(composers.grp,G.conv,text))return;
    const re=composeTakeReply(composers.grp);
    const ts = Date.now();
    const mid = newMid();
    grpSendAll({ t: 'chat', text, ts, mid,re:reOut(re) });
    chatMsg(G.conv, S.nick, text, true, ts, null, { mid,re });
    record(G.conv, { mid, ts, who: 'me', nick: S.nick, type: 'text', text,re:re||undefined });
    $('gChatInput').value = '';
  };
  document.addEventListener('visibilitychange', () => { if (G.active) grpSendViews(); });
  window.addEventListener('beforeunload', () => { if (G.active) grpSendAll({ t: 'bye' }); });
  grpRenderSaved();
}
