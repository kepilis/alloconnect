'use strict';
/* =========================================================
   Вебкамера в звонке на двоих — порт camera.js ПК 1.18, протокол тот же.
   Видеопоток камеры добавляется в идущий звонок по запросу, а не в код приглашения: код не растёт,
   старые версии ничего не замечают. Оба сообщают в caps «cam: 1». Новый трансивер добавляет и предлагает
   только звонивший (host); гость просит его об этом (cam-need).
   Сообщения по каналу duo: cam-need, reneg {sdp, camMid} → reneg-ans {sdp}, cam {on}.
   На телефоне: фронтальная/задняя камера (🔄), окно камеры поверх звонка — касание меняет размер.
   Служба получает тип camera (alo.camState) — иначе Android гасит камеру, как только окно свёрнуто.
   ========================================================= */
const CAM = { stream: null, on: false, peerOn: false, busy: null, waiters: [], ansWait: null, facing: 'user' };

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

async function camOpen(facing) {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  });
}

// Choose before opening a stream: the other participant must never see a camera
// that the user has not selected. No getUserMedia call is made by this dialog.
function camChoose() {
  const dialog = $('camPicker');
  return new Promise(resolve => {
    const finish = value => {
      dialog.close();
      dialog.onclick = dialog.oncancel = null;
      CAM.chooseCancel = null;
      resolve(value);
    };
    CAM.chooseCancel = () => finish(null);
    dialog.onclick = e => {
      const button = e.target.closest('[data-facing]');
      if (button) finish(button.dataset.facing);
      else if (e.target.closest('[data-cam-cancel]')) finish(null);
    };
    dialog.oncancel = e => { e.preventDefault(); finish(null); };
    dialog.showModal();
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
  const facing = await camChoose();
  if (!facing || !valid()) return;
  const st = await alo.requestCam();
  if (!valid()) return;
  if (st.cam === false) { toast('Нет разрешения на камеру — разреши в настройках Android'); return; }
  CAM.facing = facing;
  try {
    const stream = await camOpen(CAM.facing);
    if (!valid()) { for (const t of stream.getTracks()) t.stop(); return; }
    CAM.stream = stream;
  } catch (e) {
    if (!valid()) return;
    CAM.stream = null;
    toast(e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'Камера не найдена' : 'Камера не включилась: ' + (e?.message || e?.name || e));
    L('cam', { startFailed: e?.name || String(e) });
    return;
  }
  CAM.on = true;
  store.set('settings', { ...settings(), camFacing: CAM.facing });
  alo.camState({ on: true });
  CAM.stream.getVideoTracks()[0].onended = () => { if (CAM.on) camStop(); };
  camRender();
  // группа (как ПК 1.19): камера каждому участнику, своё окно камеры не нужно — она в своей плитке
  if (G.active) { grpCamAll(); grpSendAll({ t: 'gcam', on: true }); grpRender(); L('cam', { on: true, group: true }); return; }
  const ok = await camEnsureTx();
  if (!valid() || !CAM.on) return;
  if (!ok) { toast('Не получилось передать камеру другу'); camStop(); return; }
  await camAttach();
  if (!valid() || !CAM.on) return;
  send({ t: 'cam', on: true });
  L('cam', { on: true, facing: CAM.facing });
  } catch (e) {
    if (valid()) { camStop(); toast('Камера не включилась: ' + (e?.message || e)); }
  } finally { if (CAM.start === start) CAM.start = null; }

}

// фронтальная ↔ задняя: новый поток и replaceTrack — без перезвона и без новых переговоров
async function camFlip() {
  if (!CAM.on || CAM.flip) return;
  const flip = {};
  CAM.flip = flip;
  const previous = CAM.facing, want = previous === 'user' ? 'environment' : 'user';
  const valid = () => CAM.flip === flip && CAM.on;
  let stream, requested = want;
  try {
    // Some phones require releasing the current camera before opening another.
    for (const t of CAM.stream?.getTracks() || []) t.stop();
    try { stream = await camOpen(want); } catch (e) {
      if (!valid()) return;
      L('cam', { flipFailed: e?.name || String(e) });
      toast('Другая камера не открылась');
      requested = previous;
      try { stream = await camOpen(previous); } catch { if (valid()) camStop(); return; }
    }
    if (!valid()) { for (const t of stream.getTracks()) t.stop(); return; }
    CAM.facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode || requested;
    CAM.stream = stream;
    stream.getVideoTracks()[0].onended = () => { if (CAM.on && CAM.stream === stream) camStop(); };
    store.set('settings', { ...settings(), camFacing: CAM.facing });
    camRender();
    if (G.active) grpCamAll(); else await camAttach();
  } finally { if (CAM.flip === flip) CAM.flip = null; }
}

function camStop(notify = true) {
  CAM.start = null;
  CAM.chooseCancel?.();
  CAM.flip = null;
  for (const t of CAM.stream?.getTracks() || []) t.stop();
  CAM.stream = null;
  const was = CAM.on;
  CAM.on = false;
  try { S.tx?.cam?.sender.replaceTrack(null); } catch { /* */ }
  if (was) alo.camState({ on: false });
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

// качество камеры (как ПК 1.21): пока я показываю экран — до 360p, 500 кбит/с, 24 к/с (стрим важнее), иначе до 720p и 1,2 Мбит/с
async function camTune(tr = S.tx?.cam) {
  const t = tr?.sender.track;
  if (!tr || !t) return;
  const sharing = !!SH;
  const h = Math.min(t.getSettings().height || 720, t.getSettings().width || 720); // у телефона кадр бывает стоя
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
  if (t && $('camFriend').srcObject?.getVideoTracks?.()[0] !== t) $('camFriend').srcObject = new MediaStream([t]);
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

// окно камеры: друг крупно, своя — маленькой в углу; только своя — она одна
function camRender() {
  const wrap = $('camWrap');
  if (!wrap) return;
  const show = !G.active && (CAM.on || CAM.peerOn); // в группе камеры — в плитках
  wrap.classList.toggle('hidden', !show);
  wrap.classList.toggle('solo-self', CAM.on && !CAM.peerOn);
  wrap.classList.toggle('self-on', CAM.on); // свой кадр в углу — только когда своя камера включена
  wrap.classList.toggle('mirror', CAM.facing === 'user');
  const self = $('camSelf');
  if (CAM.on && self.srcObject !== CAM.stream) self.srcObject = CAM.stream;
  if (!CAM.on) self.srcObject = null;
  $('camFriendName').textContent = CAM.peerOn ? (S.friendNick || 'Друг') : 'Ты';
  $('camFlip').classList.toggle('hidden', !CAM.on);
  const fv = $('camFriend');
  if (CAM.peerOn) fv.play?.().catch(() => {});
  if (CAM.on) self.play?.().catch(() => {});
  for (const b of [$('btnCam'), $('gCam')]) if (b) { b.classList.toggle('on', CAM.on); b.setAttribute('aria-pressed', String(CAM.on)); }
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
  const fv = $('camFriend');
  if (fv) fv.srcObject = null;
  $('camWrap')?.classList.remove('big');
  camRender();
}

function camBind() {
  $('btnCam').onclick = () => camToggle();
  $('camFlip').onclick = (e) => { e.stopPropagation(); camFlip(); };
  // касание — крупно / маленьким в углу
  $('camWrap').onclick = () => $('camWrap').classList.toggle('big');
}
