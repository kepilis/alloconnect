'use strict';
/* =========================================================
   Вебкамера в звонке на двоих (1.18).
   Видеопоток камеры добавляется в уже идущий звонок по запросу, а не в код приглашения: код не растёт,
   а старые версии ничего не замечают. Оба сообщают в caps «cam: 1». Новый трансивер добавляет и предлагает
   только звонивший (host) — встречных предложений не бывает; гость просит его об этом (cam-need).
   Сообщения по каналу duo: cam-need, reneg {sdp, camMid} → reneg-ans {sdp}, cam {on}.
   ========================================================= */
const CAM = { stream: null, on: false, peerOn: false, busy: null, waiters: [] };

function camReady() { return !!S.tx?.cam && S.pc?.signalingState === 'stable'; }
function camResolve(ok = true) { const w = CAM.waiters.splice(0); for (const f of w) f(ok); }
function camWaitTx(ms) {
  if (camReady()) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = ok => {
      clearTimeout(timer);
      const i = CAM.waiters.indexOf(finish);
      if (i >= 0) CAM.waiters.splice(i, 1);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    CAM.waiters.push(finish);
  });
}

async function camToggle() {
  if (CAM.on || CAM.start) { camStop(); return; }
  if (!S.connected && !G.active) { toast('Камера включается в звонке'); return; }
  if (!G.active && !S.peerCam) { toast(`У ${S.friendNick || 'друга'} старая версия — камера заработает, когда он обновится`); return; }
  const start = { pc: S.pc, group: G.active ? G.gid : null };
  CAM.start = start;
  const valid = () => CAM.start === start && (start.group !== null ? G.active && G.gid === start.group : !G.active && S.connected && S.pc === start.pc);
  try {
  const dev = settings().cam || '';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { ...(dev ? { deviceId: { exact: dev } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    });
    if (!valid()) { for (const t of stream.getTracks()) t.stop(); return; }
    CAM.stream = stream;
  } catch (e) {
    if (!valid()) return;
    CAM.stream = null;
    toast(e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'Камера не найдена — выбери её в настройках' : 'Камера не включилась: ' + (e?.message || e?.name || e));
    L('cam', { startFailed: e?.name || String(e) });
    return;
  }
  CAM.on = true;
  CAM.stream.getVideoTracks()[0].onended = () => { if (CAM.on) camStop(); };
  camRender();
  if (G.active) { grpCamAll(); grpSendAll({ t: 'gcam', on: true }); grpRender(); L('cam', { on: true, group: true }); return; }
  const ok = await camEnsureTx();
  if (!valid() || !CAM.on) return;
  if (!ok) { toast('Не получилось передать камеру другу'); camStop(); return; }
  await camAttach();
  if (!valid() || !CAM.on) return;
  send({ t: 'cam', on: true });
  L('cam', { on: true });
  } catch (e) {
    if (valid()) { camStop(); toast('Камера не включилась: ' + (e?.message || e)); }
  } finally { if (CAM.start === start) CAM.start = null; }

}

function camStop(notify = true) {
  CAM.start = null;
  CAM.flip = null;
  for (const t of CAM.stream?.getTracks() || []) t.stop();
  CAM.stream = null;
  const was = CAM.on;
  CAM.on = false;
  try { S.tx?.cam?.sender.replaceTrack(null); } catch { /* */ }
  if (G.active) {
    for (const p of G.peers.values()) grpCamAttach(p);
    if (was && notify) grpSendAll({ t: 'gcam', on: false });
    grpRender();
  } else if (was && notify) send({ t: 'cam', on: false });
  if (was) L('cam', { on: false });
  camRender();
}

async function camAttach() {
  const tr = S.tx?.cam;
  if (!tr) return;
  try {
    await tr.sender.replaceTrack(CAM.on ? CAM.stream?.getVideoTracks()[0] || null : null);
    if (S.tx?.cam === tr) await camTune(tr);
  } catch (e) { L('cam', { attachFailed: e.message }); }
}

// качество камеры: пока я показываю экран — до 360p и 500 кбит/с (стрим важнее), иначе до 720p и 1,2 Мбит/с
async function camTune(tr = S.tx?.cam) {
  const t = tr?.sender.track;
  if (!tr || !t) return;
  const sharing = !!S.localScreen;
  const h = t.getSettings().height || 720;
  try {
    const p = tr.sender.getParameters();
    p.encodings = p.encodings?.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = sharing ? 500_000 : 1_200_000;
    p.encodings[0].scaleResolutionDownBy = Math.max(1, h / (sharing ? 360 : 720));
    p.encodings[0].maxFramerate = sharing ? 24 : 30;
    p.degradationPreference = 'maintain-framerate';
    await tr.sender.setParameters(p);
  } catch { /* */ }
}

// трансивер камеры: у звонившего — добавить и предложить; у гостя — попросить звонившего
async function camEnsureTx() {
  if (camReady()) return true;
  if (S.role !== 'host') { send({ t: 'cam-need' }); return camWaitTx(12000); }
  return camOffer();
}

async function camOffer() {
  if (CAM.busy) return CAM.busy;
  if (camReady()) return true;
  const pc = S.pc, tx = S.tx, session = CAM.session, operation = {};
  if (!pc || !tx) return false;
  CAM.offer = operation;
  const valid = () => S.pc === pc && S.tx === tx && CAM.session === session && CAM.offer === operation;
  let finish, timer;
  const task = (async () => {
    try {
      let tr = tx.cam;
      const retry = tr && pc.signalingState === 'have-local-offer' && pc.localDescription?.type === 'offer';
      if (!retry) {
        for (let i = 0; i < 25 && valid() && pc.signalingState !== 'stable'; i++) await new Promise(r => setTimeout(r, 200));
        if (!valid() || pc.signalingState !== 'stable') return false;
        tr = pc.addTransceiver('video', { direction: 'sendrecv' });
        const offer = await pc.createOffer();
        if (!valid()) return false;
        await pc.setLocalDescription({ type: 'offer', sdp: opusStereo(offer.sdp) });
        if (!valid()) return false;
        tx.cam = tr;
      }
      const answered = new Promise(resolve => {
        finish = ok => { clearTimeout(timer); resolve(ok); };
        CAM.ansWait = finish;
        timer = setTimeout(() => finish(false), 12000);
      });
      send({ t: 'reneg', sdp: pc.localDescription.sdp, camMid: tr.mid });
      L('cam', { offer: true, mid: tr.mid });
      const ok = await answered;
      if (!valid()) return false;
      if (!ok) { L('cam', { noAnswer: true }); return false; }
      camWatchRemote();
      camResolve();
      return true;
    } catch (e) { if (valid()) L('cam', { offerFailed: e.message }); return false; }
    finally {
      clearTimeout(timer);
      if (CAM.ansWait === finish) CAM.ansWait = null;
      if (CAM.offer === operation) CAM.offer = null;
    }
  })();
  CAM.busy = task;
  try { return await task; } finally { if (CAM.busy === task) CAM.busy = null; }
}

async function camOnReneg(d) {
  const pc = S.pc, tx = S.tx, session = CAM.session;
  if (!pc || !tx || S.role === 'host' || !/^v=0/.test(String(d.sdp || ''))) return;
  const valid = () => S.pc === pc && S.tx === tx && CAM.session === session;
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setLocalDescription({ type: 'rollback' });
      if (!valid()) return;
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) });
    if (!valid()) return;
    const tr = pc.getTransceivers().find(t => t.mid === String(d.camMid));
    if (!tr) throw new Error('нет трансивера камеры');
    tr.direction = 'sendrecv';
    tx.cam = tr;
    if (CAM.on) { await camAttach(); if (!valid()) return; }
    const ans = await pc.createAnswer();
    if (!valid()) return;
    await pc.setLocalDescription({ type: 'answer', sdp: opusStereo(ans.sdp) });
    if (!valid()) return;
    send({ t: 'reneg-ans', sdp: pc.localDescription.sdp });
    camWatchRemote();
    camResolve();
    L('cam', { answered: true });
  } catch (e) { if (valid()) L('cam', { answerFailed: e.message }); }
}

async function camOnRenegAns(d) {
  const pc = S.pc, session = CAM.session, finish = CAM.ansWait;
  if (!pc || pc.signalingState !== 'have-local-offer') return;
  const valid = () => S.pc === pc && CAM.session === session && CAM.ansWait === finish;
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: String(d.sdp || '') });
    if (valid()) finish?.(true);
  } catch (e) { if (valid()) { L('cam', { applyFailed: e.message }); finish?.(false); } }
}

function camWatchRemote() {
  const t = S.tx?.cam?.receiver.track;
  if (t) $('camFriend').srcObject = new MediaStream([t]);
  camRender();
}

function camOnData(d) {
  switch (d.t) {
    case 'cam-need': if (S.role === 'host') camOffer(); return true;
    case 'reneg': camOnReneg(d); return true;
    case 'reneg-ans': camOnRenegAns(d); return true;
    case 'cam':
      CAM.peerOn = !!d.on;
      if (CAM.peerOn && !camReady()) camEnsureTx();
      if (CAM.peerOn) { camWatchRemote(); sysMsg(`${S.friendNick} включил камеру`); } else camRender();
      return true;
    default: return false;
  }
}

// окно камеры: друг крупно, своя — маленькой в углу; только своя — она крупно
function camRender() {
  const wrap = $('camWrap');
  if (!wrap) return;
  const show = CAM.on || CAM.peerOn;
  wrap.classList.toggle('hidden', !show);
  wrap.classList.toggle('solo-self', CAM.on && !CAM.peerOn);
  wrap.classList.toggle('self-on', CAM.on);
  const self = $('camSelf');
  if (CAM.on && self.srcObject !== CAM.stream) self.srcObject = CAM.stream;
  if (!CAM.on) self.srcObject = null;
  $('camFriendName').textContent = CAM.peerOn ? (S.friendNick || 'Друг') : 'Ты';
  const fv = $('camFriend');
  if (CAM.peerOn) fv.play?.().catch(() => {});
  for (const b of [$('btnCam'), $('gCam')]) if (b) { b.classList.toggle('on', CAM.on); b.querySelector('span').textContent = CAM.on ? 'Камера вкл' : 'Камера'; }
  window.winLayoutChanged?.();
}

function camReset() {
  CAM.session = {};
  CAM.offer = null;
  camStop(false);
  CAM.peerOn = false;
  CAM.busy = null;
  CAM.ansWait?.(false);
  CAM.ansWait = null;
  camResolve(false);
  $('camFriend').srcObject = null;
  camRender();
}

// список камер в настройках
async function fillCameras() {
  const sel = $('camSelect');
  if (!sel) return;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { /* */ }
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = devs.length ? 'Как в системе' : 'Камер не найдено';
  sel.appendChild(def);
  devs.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Камера ${i + 1}`; sel.appendChild(o); });
  sel.value = settings().cam || '';
  if (sel.value !== (settings().cam || '')) sel.value = '';
}
