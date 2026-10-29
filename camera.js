'use strict';
/* =========================================================
   Вебкамера в звонке на двоих (1.18).
   Видеопоток камеры добавляется в уже идущий звонок по запросу, а не в код приглашения: код не растёт,
   а старые версии ничего не замечают. Оба сообщают в caps «cam: 1». Новый трансивер добавляет и предлагает
   только звонивший (host) — встречных предложений не бывает; гость просит его об этом (cam-need).
   Сообщения по каналу duo: cam-need, reneg {sdp, camMid} → reneg-ans {sdp}, cam {on}.
   ========================================================= */
const CAM = { stream: null, on: false, peerOn: false, busy: null, waiters: [] };

function camReady() { return !!S.tx?.cam; }
function camResolve() { const w = CAM.waiters.splice(0); for (const f of w) f(true); }
function camWaitTx(ms) {
  if (camReady()) return Promise.resolve(true);
  return new Promise((res) => {
    CAM.waiters.push(res);
    setTimeout(() => { const i = CAM.waiters.indexOf(res); if (i >= 0) { CAM.waiters.splice(i, 1); res(false); } }, ms);
  });
}

async function camToggle() {
  if (CAM.on) { camStop(); return; }
  if (!S.connected) { toast('Камера включается в звонке'); return; }
  if (G.active) { toast('В групповом звонке камеры пока нет'); return; }
  if (!S.peerCam) { toast(`У ${S.friendNick || 'друга'} старая версия — камера заработает, когда он обновится`); return; }
  const dev = settings().cam || '';
  try {
    CAM.stream = await navigator.mediaDevices.getUserMedia({
      video: { ...(dev ? { deviceId: { exact: dev } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    });
  } catch (e) {
    CAM.stream = null;
    toast(e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'Камера не найдена — выбери её в настройках' : 'Камера не включилась: ' + (e?.message || e?.name || e));
    L('cam', { startFailed: e?.name || String(e) });
    return;
  }
  CAM.on = true;
  CAM.stream.getVideoTracks()[0].onended = () => { if (CAM.on) camStop(); };
  camRender();
  const ok = await camEnsureTx();
  if (!CAM.on) return;
  if (!ok) { toast('Не получилось передать камеру другу'); camStop(); return; }
  await camAttach();
  send({ t: 'cam', on: true });
  L('cam', { on: true });
}

function camStop(notify = true) {
  for (const t of CAM.stream?.getTracks() || []) t.stop();
  CAM.stream = null;
  const was = CAM.on;
  CAM.on = false;
  try { S.tx?.cam?.sender.replaceTrack(null); } catch { /* */ }
  if (was && notify) send({ t: 'cam', on: false });
  if (was) L('cam', { on: false });
  camRender();
}

async function camAttach() {
  const tr = S.tx?.cam;
  if (!tr) return;
  try {
    await tr.sender.replaceTrack(CAM.on ? CAM.stream?.getVideoTracks()[0] || null : null);
    const p = tr.sender.getParameters();
    p.encodings = p.encodings?.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 1_200_000;
    p.degradationPreference = 'maintain-framerate';
    await tr.sender.setParameters(p).catch(() => {});
  } catch (e) { L('cam', { attachFailed: e.message }); }
}

// трансивер камеры: у звонившего — добавить и предложить; у гостя — попросить звонившего
async function camEnsureTx() {
  if (camReady()) return true;
  if (S.role !== 'host') { send({ t: 'cam-need' }); return camWaitTx(12000); }
  return camOffer();
}

async function camOffer() {
  if (camReady()) return true;
  if (CAM.busy) return CAM.busy;
  CAM.busy = (async () => {
    const pc = S.pc;
    try {
      for (let i = 0; i < 25 && pc && pc.signalingState !== 'stable'; i++) await new Promise((r) => setTimeout(r, 200));
      if (!pc || S.pc !== pc || pc.signalingState !== 'stable') return false;
      const tr = pc.addTransceiver('video', { direction: 'sendrecv' });
      const offer = await pc.createOffer();
      await pc.setLocalDescription({ type: 'offer', sdp: opusStereo(offer.sdp) });
      S.tx.cam = tr;
      send({ t: 'reneg', sdp: pc.localDescription.sdp, camMid: tr.mid });
      L('cam', { offer: true, mid: tr.mid });
      const ok = await new Promise((res) => { CAM.ansWait = res; setTimeout(() => res(false), 12000); });
      CAM.ansWait = null;
      if (!ok) { L('cam', { noAnswer: true }); return false; }
      camWatchRemote();
      camResolve();
      return true;
    } catch (e) { L('cam', { offerFailed: e.message }); return false; } finally { CAM.busy = null; }
  })();
  return CAM.busy;
}

async function camOnReneg(d) {
  const pc = S.pc;
  if (!pc || S.role === 'host' || !/^v=0/.test(String(d.sdp || ''))) return;
  try {
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
    await pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) });
    const tr = pc.getTransceivers().find((t) => t.mid === String(d.camMid));
    if (!tr) throw new Error('нет трансивера камеры');
    tr.direction = 'sendrecv';
    S.tx.cam = tr;
    if (CAM.on) await camAttach();
    const ans = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: opusStereo(ans.sdp) });
    send({ t: 'reneg-ans', sdp: pc.localDescription.sdp });
    camWatchRemote();
    camResolve();
    L('cam', { answered: true });
  } catch (e) { L('cam', { answerFailed: e.message }); }
}

async function camOnRenegAns(d) {
  const pc = S.pc;
  if (!pc || pc.signalingState !== 'have-local-offer') return;
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: String(d.sdp || '') });
    CAM.ansWait?.(true);
  } catch (e) { L('cam', { applyFailed: e.message }); CAM.ansWait?.(false); }
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
  const self = $('camSelf');
  if (CAM.on && self.srcObject !== CAM.stream) self.srcObject = CAM.stream;
  if (!CAM.on) self.srcObject = null;
  $('camFriendName').textContent = CAM.peerOn ? (S.friendNick || 'Друг') : 'Ты';
  const fv = $('camFriend');
  if (CAM.peerOn) fv.play?.().catch(() => {});
  const b = $('btnCam');
  if (b) { b.classList.toggle('on', CAM.on); b.querySelector('span').textContent = CAM.on ? 'Камера вкл' : 'Камера'; }
  window.winLayoutChanged?.();
}

function camReset() {
  camStop(false);
  CAM.peerOn = false;
  CAM.busy = null;
  CAM.ansWait?.(false);
  camResolve();
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
