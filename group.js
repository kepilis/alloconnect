'use strict';

/* =========================================================
   ТЕСТ (ветка test/multicall): групповой звонок до GRP_MAX человек.
   Сетка «каждый с каждым»: у каждой пары своё RTCPeerConnection — голос, экран (видео) и канал 'g'
   (чат и состояние). Сигналинг идёт по каналу друзей. Если двое участников не друзья между собой,
   записку передаёт тот, кто собрал группу (хост): он друг каждого, кого позвал.
   Звонок на двоих этот модуль не трогает; пока идёт группа, обычные звонки получают «занят».
   ========================================================= */
const GRP_MAX = 6;
const G = {
  active: false, gid: null, hostId: null,
  members: new Map(),   // id → { id, nick } (вместе со мной)
  peers: new Map(),     // id → участник с его RTCPeerConnection
  connecting: new Set(),
  tiles: new Map(),     // id → плитка
  conv: null, invite: null, share: null, focus: null, joinTimer: null, stopMyMeter: null,
};

const grpMe = () => myIdent?.id || '';
const grpIsHost = () => G.active && G.hostId === grpMe();
const grpClean = (s, n = 24) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function grpNick(id) {
  if (id === grpMe()) return S.nick || 'Я';
  return friendsList.find((f) => f.id === id)?.nick || G.members.get(id)?.nick || 'Участник';
}
function grpRosterList() { return [...G.members.values()].map((m) => ({ id: m.id, nick: m.nick })); }
function grpBusy() { return G.active || S.inCall || S.busy || !!S.pc || !!S.friendCall; }

/* ---------- Собрать группу и позвать друзей ---------- */
function grpOpenPick() {
  if (!myIdent) { toast('Сеть друзей ещё не готова'); return; }
  if (!G.active && grpBusy()) { toast('Сначала заверши звонок'); return; }
  if (G.active && !grpIsHost()) { toast('Звать новых может тот, кто собрал группу'); return; }
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
  if (!G.active) { if (!(await grpStart())) return; }
  grpInvite(ids.slice(0, Math.max(0, GRP_MAX - G.members.size)));
}

async function grpStart() {
  if (grpBusy()) return false;
  if (!(await prepare())) return false;
  G.active = true;
  G.gid = newMid();
  G.hostId = grpMe();
  G.members.clear();
  G.members.set(grpMe(), { id: grpMe(), nick: S.nick });
  L('grp', { start: true });
  grpEnterUi();
  sysMsg('Групповой звонок создан. Позови друзей — «➕ Позвать».', G.conv);
  return true;
}

async function grpInvite(ids) {
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
  const gid = cleanMid(msg.gid);
  if (!gid) return;
  if (G.invite?.gid === gid || G.gid === gid) return; // повтор
  if (grpBusy() || G.invite) { window.duo.friendsSend(id, { t: 'grp-busy', gid }); return; }
  const members = (Array.isArray(msg.members) ? msg.members : []).filter((m) => ID_RE.test(String(m?.id || ''))).slice(0, GRP_MAX)
    .map((m) => ({ id: m.id, nick: grpClean(m.nick) || 'Участник' }));
  if (!members.some((m) => m.id === id)) members.unshift({ id, nick });
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
  G.active = true;
  G.gid = inv.gid;
  G.hostId = inv.id;
  G.members.clear();
  for (const m of inv.members) G.members.set(m.id, m);
  G.members.set(grpMe(), { id: grpMe(), nick: S.nick });
  L('grp', { join: true, members: G.members.size });
  grpEnterUi();
  sysMsg('Подключаюсь к группе…', G.conv);
  const r = await window.duo.friendsSend(inv.id, { t: 'grp-join', gid: inv.gid, nick: S.nick });
  if (!r.ok && G.gid === inv.gid) { grpLeave(`${inv.nick} не отвечает`); return; }
  G.joinTimer = setTimeout(() => { if (G.active && G.gid === inv.gid && !G.peers.size) grpLeave('Группа не ответила'); }, 25000);
}

/* ---------- Сообщения по каналу друзей ---------- */
function grpOnFriendMsg(id, msg, f, nick) {
  if (msg.t === 'grp-invite') { if (f) grpOnInvite(id, msg, nick); return; }
  if (!G.active || cleanMid(msg.gid) !== G.gid) {
    if (msg.t === 'grp-cancel' && G.invite?.gid === msg.gid && G.invite.id === id) { grpCloseInvite(); toast(`${nick} отменил групповой звонок`); }
    return;
  }
  switch (msg.t) {
    case 'grp-join': // мне как хосту: друг принял приглашение
      if (!grpIsHost() || !f) return;
      if (G.members.size >= GRP_MAX && !G.members.has(id)) { window.duo.friendsSend(id, { t: 'grp-full', gid: G.gid }); return; }
      G.members.set(id, { id, nick: grpClean(msg.nick) || nick });
      grpBroadcastRoster();
      grpRender();
      grpSyncPeers();
      return;
    case 'grp-decline': if (grpIsHost()) sysMsg(`${nick} отказался`, G.conv); return;
    case 'grp-busy': if (grpIsHost()) sysMsg(`${nick} сейчас занят`, G.conv); return;
    case 'grp-full': if (id === G.hostId) grpLeave('В группе уже нет мест'); return;
    case 'grp-leave':
      if (!grpIsHost() || !G.members.has(id)) return;
      grpMemberGone(id, 'вышел');
      grpBroadcastRoster();
      return;
    case 'grp-roster':
      if (id !== G.hostId) return;
      grpOnRoster(msg);
      return;
    case 'grp-relay': // мне как хосту: передать записку участнику, который не друг отправителю
      if (!grpIsHost() || !G.members.has(id) || !G.members.has(msg.to) || msg.to === grpMe()) return;
      window.duo.friendsSend(msg.to, { t: 'grp-sig', gid: G.gid, from: id, nick: G.members.get(id).nick, kind: msg.kind, pid: msg.pid, sdp: msg.sdp });
      return;
    case 'grp-sig': {
      // от хоста может прийти пересланная записка (from); от остальных — только их собственная
      const from = id === G.hostId && msg.from ? String(msg.from) : id;
      if (!ID_RE.test(from) || from === grpMe()) return;
      if (!G.members.has(from)) G.members.set(from, { id: from, nick: grpClean(msg.nick) || 'Участник' });
      if (msg.kind === 'offer') grpAnswer(from, msg);
      else if (msg.kind === 'answer') grpOnAnswer(from, msg);
      return;
    }
    default:
  }
}

function grpBroadcastRoster() {
  const members = grpRosterList();
  for (const m of members) if (m.id !== grpMe()) window.duo.friendsSend(m.id, { t: 'grp-roster', gid: G.gid, members });
}

function grpOnRoster(msg) {
  const list = (Array.isArray(msg.members) ? msg.members : []).filter((m) => ID_RE.test(String(m?.id || ''))).slice(0, GRP_MAX);
  if (!list.some((m) => m.id === grpMe())) return;
  const ids = new Set(list.map((m) => m.id));
  for (const id of [...G.members.keys()]) if (!ids.has(id)) grpMemberGone(id, 'вышел');
  for (const m of list) if (m.id !== grpMe()) G.members.set(m.id, { id: m.id, nick: grpClean(m.nick) || 'Участник' });
  grpRender();
  grpSyncPeers();
}

// пара соединяется один раз: звонит тот, у кого ID больше
function grpSyncPeers() {
  for (const id of G.members.keys()) {
    if (id === grpMe() || G.peers.has(id) || G.connecting.has(id)) continue;
    if (grpMe() > id) grpConnect(id);
  }
}

function grpSig(to, payload) {
  const msg = { gid: G.gid, nick: S.nick, ...payload };
  if (isFriend(to)) return window.duo.friendsSend(to, { t: 'grp-sig', ...msg });
  if (G.hostId && G.hostId !== grpMe() && isFriend(G.hostId)) return window.duo.friendsSend(G.hostId, { t: 'grp-relay', to, ...msg });
  return Promise.resolve({ ok: false, error: 'нет пути' });
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
  pc.ontrack = (e) => grpOnTrack(p, e);
  pc.addEventListener('connectionstatechange', () => {
    L('grp', { peer: id.slice(0, 8), state: pc.connectionState });
    if (pc.connectionState === 'failed') grpPeerLost(p, 'связь прервалась');
  });
  if (role === 'out') {
    p.atx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.vtx = pc.addTransceiver('video', { direction: 'sendrecv' });
    p.atx.sender.replaceTrack(micSendTrack()).catch(() => {});
    if (G.share) p.vtx.sender.replaceTrack(G.share.track).catch(() => {});
  }
  G.peers.set(id, p);
  return p;
}

function grpSend(p, obj) { try { if (p.dc.readyState === 'open') p.dc.send(JSON.stringify(obj)); } catch { /* */ } }
function grpSendAll(obj) { for (const p of G.peers.values()) grpSend(p, obj); }

async function grpConnect(id, tries = 0) {
  if (!G.active || G.peers.has(id) || G.connecting.has(id)) return;
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
    const r = await grpSig(id, { kind: 'offer', pid, sdp: minifySdp(p.pc.localDescription.sdp) });
    if (!r.ok) { grpPeerLost(p, 'не удалось передать вызов'); return; }
    p.timer = setTimeout(() => { if (!p.connected) grpPeerLost(p, 'не удалось соединиться'); }, 30000);
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
      const [a, v] = pc.getTransceivers();
      p.atx = a; p.vtx = v;
      if (a) { a.direction = 'sendrecv'; await a.sender.replaceTrack(micSendTrack()); }
      if (v) { v.direction = 'sendrecv'; if (G.share) await v.sender.replaceTrack(G.share.track); }
      await pc.setLocalDescription(await pc.createAnswer());
    }, (pc) => G.peers.get(from)?.pc === pc, { answer: true });
    if (!res || G.gid !== gid || G.peers.get(from) !== p) return;
    const r = await grpSig(from, { kind: 'answer', pid, sdp: minifySdp(p.pc.localDescription.sdp) });
    if (!r.ok) { grpPeerLost(p, 'не удалось ответить'); return; }
    p.timer = setTimeout(() => { if (!p.connected) grpPeerLost(p, 'не удалось соединиться'); }, 30000);
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
  p.stopMeter?.();
  try { p.src?.disconnect(); } catch { /* */ }
  try { p.gain?.disconnect(); } catch { /* */ }
  if (p.audioEl) p.audioEl.srcObject = null;
  try { p.dc.close(); } catch { /* */ }
  try { p.pc.close(); } catch { /* */ }
  if (G.focus === p.id) G.focus = null;
}

function grpPeerLost(p, why) {
  if (p.closed || G.peers.get(p.id) !== p) return;
  const was = p.connected;
  grpClosePeer(p);
  L('grp', { lost: why, was });
  if (!G.active) return;
  if (was) { sysMsg(`${grpNick(p.id)}: ${why}`, G.conv); sound('leave'); }
  grpRender();
  // участник ещё в группе — пробуем ещё раз (звонит тот, у кого ID больше)
  const tries = (p.tries || 0) + 1;
  if (G.members.has(p.id) && grpMe() > p.id && tries <= 3) setTimeout(() => grpConnect(p.id, tries), 2000 * tries);
}

function grpMemberGone(id, why) {
  G.members.delete(id);
  const p = G.peers.get(id);
  if (p) { const was = p.connected; grpClosePeer(p); if (was) { sysMsg(`${grpNick(id)} ${why}`, G.conv); sound('leave'); } }
  if (id === G.hostId && G.active) sysMsg('Собравший группу вышел — разговор продолжается, но новых позвать уже нельзя', G.conv);
  grpRender();
}

function grpPeerOpen(p) {
  if (p.closed) return;
  p.connected = true;
  clearTimeout(p.timer);
  clearTimeout(G.joinTimer);
  grpSend(p, { t: 'hello', nick: S.nick, muted: S.muted, deaf: S.deafened, sharing: !!G.share, name: G.share?.name || '', av: myAvatar?.hash || '' });
  if (G.share) grpTuneAll();
  L('grp', { open: p.id.slice(0, 8), peers: G.peers.size });
  sysMsg(`${grpNick(p.id)} в звонке`, G.conv);
  sound('join');
  grpRender();
}

function grpOnData(p, d) {
  if (p.closed || !d || typeof d.t !== 'string') return;
  switch (d.t) {
    case 'hello':
      if (!isFriend(p.id) && G.members.has(p.id)) G.members.get(p.id).nick = grpClean(d.nick) || G.members.get(p.id).nick;
      p.muted = !!d.muted; p.deaf = !!d.deaf;
      grpOnScreen(p, !!d.sharing, d.name);
      grpRender();
      return;
    case 'state': p.muted = !!d.muted; p.deaf = !!d.deaf; grpRender(); return;
    case 'screen': grpOnScreen(p, !!d.on, d.name); grpRender(); return;
    case 'chat': {
      const text = String(d.text || '').slice(0, 2000);
      if (!text) return;
      chatMsg(G.conv, grpNick(p.id), text, false, Number(d.ts) || Date.now());
      sound('msg');
      if (!document.hasFocus()) window.duo?.attention();
      return;
    }
    case 'bye': grpMemberGone(p.id, 'вышел'); return;
    default:
  }
}

function grpOnScreen(p, on, name) {
  const was = p.sharing;
  p.sharing = on;
  p.shareName = grpClean(name, 60);
  if (on && !was) { sysMsg(`${grpNick(p.id)} показывает экран${p.shareName ? ' — ' + p.shareName : ''}`, G.conv); if (!G.focus) G.focus = p.id; }
  if (!on && G.focus === p.id) G.focus = null;
}

function grpOnTrack(p, e) {
  const t = e.track;
  if (t.kind === 'audio') {
    p.astream = new MediaStream([t]);
    // Chromium отдаёт удалённый звук в WebAudio, только если поток привязан к элементу
    p.audioEl = new Audio();
    p.audioEl.srcObject = p.astream;
    p.audioEl.muted = true;
    p.audioEl.play().catch(() => {});
    const c = audio();
    p.src = c.createMediaStreamSource(p.astream);
    p.gain = c.createGain();
    p.gain.gain.value = grpVol(p.id) / 100;
    p.src.connect(p.gain).connect(master);
    p.stopMeter = makeMeter(p.astream, (lvl) => {
      p.lvl = lvl;
      G.tiles.get(p.id)?.classList.toggle('speaking', lvl > 0.02 && !S.deafened);
    });
  } else {
    p.vstream = new MediaStream([t]);
    grpRender();
  }
}

/* ---------- Громкость каждого, микрофон, звук ---------- */
function grpVol(id) { const v = Number(store.get('gvol', {})[id]); return Number.isFinite(v) ? v : 100; }
function grpSetVol(id, v) {
  const all = store.get('gvol', {});
  all[id] = v;
  store.set('gvol', all);
  const p = G.peers.get(id);
  if (p?.gain) p.gain.gain.value = v / 100;
}

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
  for (const el of G.tiles.values()) el.querySelector('video').muted = true; // звук экрана в группе пока не передаём
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
  $('gInviteMore').classList.toggle('hidden', !grpIsHost());
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

/* ---------- Показ экрана в группу (видео без звука) ---------- */
function grpShareBr() {
  const n = Math.max(1, [...G.peers.values()].filter((p) => p.connected).length);
  return Math.max(1_500_000, Math.round(G.share.q.br / n)); // одна выгрузка на каждого — делим канал
}
async function grpTuneAll() {
  if (!G.share) return;
  for (const p of G.peers.values()) if (p.vtx) await tuneSender(p.vtx.sender, { video: { ...G.share.q, br: grpShareBr() }, mode: G.share.mode });
}

async function grpBeginShare() {
  const qKey = $('quality').value;
  const mode = $('shareMode').value;
  store.set('settings', { ...settings(), quality: qKey, shareMode: mode });
  $('picker').classList.add('hidden');
  const srcId = pickedId;
  const name = srcId.startsWith('window:') ? (pickerSources.find((x) => x.id === srcId)?.name || '').slice(0, 60) : '';
  try {
    const stream = await captureSource(srcId, QUALITY[qKey], mode, false);
    await grpShareStream(stream, { q: QUALITY[qKey], mode, name });
  } catch (e) {
    console.warn('grp share', e);
    toast('Не удалось начать демонстрацию: ' + (e.message || e.name));
  }
}

async function grpShareStream(stream, { q = QUALITY['1080p30'], mode = 'game', name = '' } = {}) {
  if (G.share) grpStopShare(true);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('нет видео');
  G.share = { stream, track, q, mode, name };
  track.addEventListener('ended', () => { if (G.share?.stream === stream) grpStopShare(); });
  for (const p of G.peers.values()) if (p.vtx) await p.vtx.sender.replaceTrack(track).catch(() => {});
  await grpTuneAll();
  grpSendAll({ t: 'screen', on: true, name });
  L('grp', { share: true, peers: G.peers.size });
  sound('stream');
  grpUpdateControls();
}

function grpStopShare(silent) {
  const sh = G.share;
  if (!sh) return;
  G.share = null;
  sh.stream.getTracks().forEach((t) => t.stop());
  for (const p of G.peers.values()) p.vtx?.sender.replaceTrack(null).catch(() => {});
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
  G.conv = tempConv('Группа');
  mountConv(G.conv, $('gMessages'));
  G.tiles.clear();
  $('gGrid').innerHTML = '';
  G.stopMyMeter?.();
  G.stopMyMeter = makeMeter(S.mic, (lvl) => G.tiles.get(grpMe())?.classList.toggle('speaking', lvl > 0.02 && !S.muted && !S.deafened));
  grpUpdateControls();
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
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '200'; vol.value = String(grpVol(id));
    vol.className = 'gvol';
    vol.title = 'Громкость';
    vol.oninput = () => grpSetVol(id, Number(vol.value));
    vol.onclick = (e) => e.stopPropagation();
    el.appendChild(vol);
  }
  el.onclick = () => { if (el.classList.contains('sharing')) { G.focus = G.focus === id ? null : id; grpRender(); } };
  el.ondblclick = () => { if (el.classList.contains('sharing')) { if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {}); } };
  (id === grpMe() ? Promise.resolve(myAvatar) : friendAvatar(id)).then((a) => paintAvatar(av, a?.url)).catch(() => {});
  G.tiles.set(id, el);
  return el;
}

function grpRender() {
  if (!G.active) return;
  const grid = $('gGrid');
  const me = grpMe();
  const ids = [me, ...[...G.members.keys()].filter((id) => id !== me)];
  for (const [id, el] of G.tiles) if (!G.members.has(id) && id !== me) { el.remove(); G.tiles.delete(id); }
  for (const id of ids) {
    const el = grpTile(id);
    const p = G.peers.get(id);
    const mine = id === me;
    const sharing = mine ? !!G.share : !!(p?.connected && p.sharing);
    const v = el.querySelector('video');
    const want = mine ? G.share?.stream || null : (sharing ? p.vstream || null : null);
    if (v.srcObject !== want) v.srcObject = want;
    el.classList.toggle('sharing', sharing);
    el.classList.toggle('ghost', !mine && !p?.connected);
    el.classList.toggle('focused', G.focus === id);
    el.classList.toggle('host', id === G.hostId);
    el.querySelector('.avatar span').textContent = initial(grpNick(id));
    el.querySelector('.gname span').textContent = grpNick(id) + (mine ? ' (я)' : '') + (id === G.hostId ? ' ★' : '');
    const muted = mine ? S.muted || S.deafened : p?.muted || p?.deaf;
    const deaf = mine ? S.deafened : p?.deaf;
    el.querySelector('.badges').textContent = (deaf ? '🔇' : '') + (muted ? '🎙̸' : '') + (!mine && !p?.connected ? ' · соединяюсь…' : '');
    if (el.parentElement !== grid || grid.children[ids.indexOf(id)] !== el) grid.insertBefore(el, grid.children[ids.indexOf(id)] || null);
  }
  if (G.focus && !G.tiles.get(G.focus)?.classList.contains('sharing')) G.focus = null;
  grid.classList.toggle('focus', !!G.focus);
  const n = 1 + [...G.peers.values()].filter((p) => p.connected).length;
  $('gStatus').querySelector('span').textContent = `В звонке: ${n} из ${G.members.size}`;
  $('gStatus').className = 'status ' + (n > 1 ? 'ok' : 'waiting');
}

function grpLeave(text) {
  if (!G.active) return;
  L('grp', { leave: text || 'self' });
  grpSendAll({ t: 'bye' });
  if (!grpIsHost() && G.hostId && isFriend(G.hostId)) window.duo.friendsSend(G.hostId, { t: 'grp-leave', gid: G.gid });
  grpStopShare(true);
  const peers = [...G.peers.values()];
  G.active = false;
  clearTimeout(G.joinTimer);
  setTimeout(() => peers.forEach(grpClosePeer), 300); // даём «bye» уйти
  G.peers.clear();
  G.connecting.clear();
  G.members.clear();
  G.tiles.clear();
  G.gid = null; G.hostId = null; G.focus = null; G.conv = null;
  G.stopMyMeter?.(); G.stopMyMeter = null;
  releaseMic();
  S.muted = false;
  S.deafened = false;
  if (master) master.gain.value = 1;
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
  $('gChatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('gChatInput').value.trim();
    if (!text || !G.active) return;
    const ts = Date.now();
    grpSendAll({ t: 'chat', text, ts });
    chatMsg(G.conv, S.nick, text, true, ts);
    $('gChatInput').value = '';
  };
  window.addEventListener('beforeunload', () => { if (G.active) grpSendAll({ t: 'bye' }); });
}
grpBind();
