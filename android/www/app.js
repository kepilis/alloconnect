'use strict';
/* =========================================================
   alloconnect для телефона: звонок голосом (по коду и из списка друзей),
   чат в звонке, просмотр стрима с ПК (указка, рисование, реакции, управление), показ экрана телефона,
   файлы без звонка, саундпад. Совместимо с десктопом 1.10–1.15 (доказательство ID — 1.15.1):
   те же коды, трансиверы (mic, video, saudio), каналы данных 0 duo · 1 files · 2 ctl · 3 ctlu,
   те же сообщения в канале друзей (call/answer/decline/busy/cancel/dm/rtc-restart).
   ========================================================= */
const $ = (id) => document.getElementById(id);
const VERSION = '0.16.20';

/* ---------- Лог (без IP, переписки и кодов) ---------- */
function L(tag, data) { alo.log(String(tag).slice(0, 20), typeof data === 'string' ? data : JSON.stringify(data)); }
for (const lvl of ['warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => { orig(...a); L(lvl, a.map((x) => (x instanceof Error ? (x.stack || x.message) : String(x))).join(' ').slice(0, 1500)); };
}
window.addEventListener('error', (e) => L('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => L('error', 'unhandled: ' + (e.reason?.stack || e.reason)));

const HOST_CONNECT_TIMEOUT = 25000;
const GUEST_CONNECT_TIMEOUT = 120000;

/* ---------- Настройки ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('aloc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aloc.' + k, JSON.stringify(v)); } catch { /* полно */ } },
  del(k) { try { localStorage.removeItem('aloc.' + k); } catch { /* */ } },
};
const DEFAULTS = {
  noStun: false, stunAlt: false, stunCustom: '', relayUrl: '', turnUrl: '', turnUser: '', turnPass: '', relay: false,
  minKbps: 2500, sounds: true, ringVol: 80, shareFps: 30, shareCodec: 'compatible', shareAudio: true,
  screenVol: 100, spVolOut: 100, spMonitor: true, spVolMon: 60, spWhenMuted: true, ptt: false,
  clip: true, clipSeconds: 30, updAuto: true, speakerStart: false,
  rnn: true, noise: true, echo: true, agc: true, ringMute: false, // как у ПК: шумодав RNNoise, встроенные фильтры, без мелодии
  ovlDraw: true, ovlReact: false, svidInVol: 80, svidInSound: true, // поверх моего показа экрана: рисунки друга; картинки и видео — по желанию
};
let myPresence='online';
const presenceNames={online:'В сети',away:'Нет на месте',invisible:'Невидимка',offline:'Не в сети',dnd:'Не беспокоить'};
const settings = () => ({ ...DEFAULTS, ...store.get('settings', {}) });

function bindSettingsCats(){
  const open=store.get('settingsOpen',[]);
  for(const d of document.querySelectorAll('#settings details.scat')){
    d.open=Array.isArray(open)&&open.includes(d.dataset.cat);
    d.addEventListener('toggle',()=>store.set('settingsOpen',Array.from(document.querySelectorAll('#settings details.scat[open]'),x=>x.dataset.cat)));
  }
}

const SCREEN_COMPAT={codec:alo.native?'VP8':'',perSender:false};
async function initScreenCompat(){
  if(!alo.native)return;
  try{const st=await alo.status();if(typeof st.videoSendCodec==='string')SCREEN_COMPAT.codec=st.videoSendCodec;}catch{}
  if(SCREEN_COMPAT.codec!=='VP8')return;
  const pc=new RTCPeerConnection();
  try{const tx=pc.addTransceiver('video');await pc.setLocalDescription(await pc.createOffer());const prm=tx.sender.getParameters();prm.encodings[0].codec={mimeType:'video/VP8',clockRate:90000};await tx.sender.setParameters(prm);SCREEN_COMPAT.perSender=tx.sender.getParameters().encodings[0].codec?.mimeType==='video/VP8';}catch{}finally{pc.close();}
  L('video-compat',{codec:SCREEN_COMPAT.codec,perSender:SCREEN_COMPAT.perSender});
}
function screenEncodingCodec(prm){
  if(SCREEN_COMPAT.codec!=='VP8'||!SCREEN_COMPAT.perSender)return;
  const codec=prm.codecs?.find(c=>c.mimeType==='video/VP8');
  if(!codec)throw Error('Совместимый кодек демонстрации не согласован');
  for(const encoding of prm.encodings)encoding.codec=codec;
}
async function applyScreenCodec(sender){
  if(SCREEN_COMPAT.codec!=='VP8'||!SCREEN_COMPAT.perSender)return;
  const prm=sender.getParameters();if(!prm.encodings?.length)prm.encodings=[{}];screenEncodingCodec(prm);await sender.setParameters(prm);
}

/* ---------- Темы оформления (как у ПК 1.15; стили — themes.css + themes-phone.css) ---------- */
const dialogOpeners = new WeakMap();
const focusableInDialog = 'button, input, select, textarea, summary, a[href], [tabindex]';

function topDialog() {
  let top = null;
  let level = -Infinity;
  for (const dialog of document.querySelectorAll('.modal, .sheet, .sheet-back')) {
    if (!dialog.getClientRects().length || getComputedStyle(dialog).visibility === 'hidden') continue;
    const z = Number(getComputedStyle(dialog).zIndex) || 0;
    if (z >= level) { top = dialog; level = z; }
  }
  return top;
}

function focusOpenedDialog(dialog) {
  if (!dialogOpeners.has(dialog)) dialogOpeners.set(dialog, document.activeElement);
  dialog.querySelector('[data-dialog-title]').focus();
}

function restoreDialogFocus(dialog) {
  const opener = dialogOpeners.get(dialog);
  dialogOpeners.delete(dialog);
  const top = topDialog();
  if (opener?.getClientRects().length && (!top || top.contains(opener))) {
    opener.focus({ preventScroll: true });
  } else {
    top?.querySelector('[data-dialog-title]')?.focus({ preventScroll: true });
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  const dialog = topDialog();
  if (!dialog?.matches('#settings, #callModal')) return;
  const items = [...dialog.querySelectorAll(focusableInDialog)].filter(element =>
    element.tabIndex >= 0 && !element.matches(':disabled') &&
    element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const focused = document.activeElement;
  const first = items[0];
  const last = items.at(-1);
  if (items.includes(focused) && focused !== (event.shiftKey ? first : last)) return;
  event.preventDefault();
  (event.shiftKey ? last : first)?.focus();
});

function moveThemeSelection(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const buttons = [...event.currentTarget.querySelectorAll('.theme-card')];
  const current = buttons.indexOf(event.target);
  if (current < 0) return;
  let next;
  switch (event.key) {
    case 'ArrowRight': case 'ArrowDown': next = (current + 1) % buttons.length; break;
    case 'ArrowLeft': case 'ArrowUp': next = (current - 1 + buttons.length) % buttons.length; break;
    case 'Home': next = 0; break;
    case 'End': next = buttons.length - 1; break;
    default: return;
  }
  event.preventDefault();
  buttons[next].click();
  buttons[next].focus();
}

const THEMES = [
  { id: '', name: 'Стандартная', sw: ['#111216', '#20222a', '#7c5cff', '#3ddc84'] },
  { id: 'neon', name: 'Неоновая ночь', sw: ['#07060f', '#161331', '#ff2bd6', '#00f0ff'] },
  { id: 'terminal', name: 'Терминал', sw: ['#030703', '#0a160b', '#39ff6a', '#1f9a44'] },
  { id: 'glass', name: 'Стекло', sw: ['#3b5bdb', '#9b4dff', '#12b5a6', '#f3f6ff'] },
  { id: 'pixel', name: 'Ретро-пиксель', sw: ['#1a1c3a', '#3a3d78', '#ffcd1f', '#ff4d6d'] },
  { id: 'manga', name: 'Манга', sw: ['#f3efe6', '#ffffff', '#111111', '#e63946'] },
  { id: 'space', name: 'Космос', sw: ['#04040c', '#4b3fb5', '#8b7bff', '#4fd1ff'] },
  // ПК 1.17
  { id: 'blueprint', name: 'Чертёж', sw: ['#0d3b6f', '#ffffff', '#ffd34d', '#a9c4e8'] },
  { id: 'retro98', name: 'Ретро-ОС', sw: ['#008080', '#c0c0c0', '#000080', '#ffffff'] },
  { id: 'notebook', name: 'Тетрадь', sw: ['#fdfcf6', '#b9cbea', '#1e3a8a', '#d6336c'] },
  { id: 'nord', name: 'Север', sw: ['#16242d','#20343f','#83c9ba','#e5f0f0'] },
  { id: 'linen', name: 'Лён', sw: ['#e9e4db','#faf7f1','#365e58','#272e2b'] },
  { id: 'reel', name: 'Киноплёнка', sw: ['#14110e','#716457','#f2b572','#fff5df'] },
  { id: 'vitrail', name: 'Витраж', sw: ['#232138','#26766d','#a85c79','#d8a35f'] },
  { id: 'kiln', name: 'Гончарная', sw: ['#dfbb94','#fff2d9','#357477','#85452d'] },
  { id: 'newspaper', name: 'Газета', sw: ['#efebe1', '#161616', '#f7f4ec', '#b3261e'] },
];
function applyTheme(id) {
  const t = THEMES.some((x) => x.id === id) ? id : '';
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  for (const button of document.querySelectorAll('#themeGrid .theme-card')) {
    const selected = button.dataset.id === t;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}
function buildThemeGrid() {
  const g = $('themeGrid');
  if (!g || g.childElementCount) return;
  g.addEventListener('keydown', moveThemeSelection);
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-card';
    b.setAttribute('role', 'radio');
    b.dataset.id = t.id;
    const sw = document.createElement('span');
    sw.className = 'theme-sw';
    sw.setAttribute('aria-hidden', 'true');
    const [bg, panel, accent, trim] = t.sw;
    const ink = /^(manga|notebook|linen|kiln|newspaper)$/.test(t.id) ? '#211d1b' : '#fff';
    sw.style.setProperty('--sample-bg', bg);
    sw.style.setProperty('--sample-panel', panel);
    sw.style.setProperty('--sample-accent', accent);
    sw.style.setProperty('--sample-trim', trim);
    sw.style.setProperty('--sample-ink', ink);
    for (const kind of ['person', 'person', 'mic', 'off', 'end']) {
      const mark = document.createElement('span');
      mark.className = 'pilot-sample-' + kind;
      sw.append(mark);
    }
    const n = document.createElement('span');
    n.className = 'theme-name';
    n.textContent = t.name;
    b.append(sw, n);
    b.onclick = () => { applyTheme(t.id); store.set('settings', { ...settings(), theme: t.id }); L('settings', { theme: t.id || 'standard' }); };
    g.appendChild(b);
  }
}
applyTheme(settings().theme || '');

/* ---------- Состояние ---------- */
const S = {
  pc: null, dc: null, fdc: null, cdc: null, cdu: null, fileChan: null, role: null, tx: null,
  nick: '', friendNick: '', mic: null,
  muted: false, deafened: false, speaker: true,
  connected: false, inCall: false, busy: false,
  connectTimer: null, statsTimer: null, friendCall: null, peerIdent: null, callConv: null, callPath: null,
  reconnecting: null, stunUsed: null, chatOpen: false, unread: 0, callStart: 0,
};
let capsReady = detectCaps().then((c) => { S.caps = c; L('caps', c); return c; });

/* =========================================================
   Звук: короткие сигналы, гудки, мелодия звонка
   ========================================================= */
let actx = null;
function audio() {
  if (!actx) {
    actx = new AudioContext({ latencyHint: 'interactive' });
    // звук запустился позже звонка — переключить голос на дорожку с шумодавом
    actx.onstatechange = () => { if (actx.state === 'running') resendMic().catch(() => {}); };
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
function tone(freqs, { type = 'sine', vol = 0.12, step = 0.085, len = 0.15 } = {}) {
  const c = audio();
  let t = c.currentTime + 0.01;
  const out = [];
  for (const f of freqs) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + len + 0.01);
    out.push(o);
    t += step;
  }
  return out;
}
function sound(kind) {
  if(myPresence==='dnd'&&kind==='msg')return;
  if (!settings().sounds) return;
  if (kind === 'gone') { tone([784, 587, 440], { vol: 0.3, step: 0.16, len: 0.22 }); try { navigator.vibrate?.([200, 100, 200]); } catch { /* */ } return; }
  const seq = { join: [523, 784], leave: [784, 523], msg: [988], mute: [520, 390], unmute: [390, 520], stream: [660, 880, 1046], error: [300, 220] }[kind];
  if (seq) tone(seq);
}
let ringTimer = null;
let ringOsc = [];
function ringbackBeep() {
  const c = audio();
  const t = c.currentTime + 0.02;
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = 425;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.03);
  g.gain.setValueAtTime(0.09, t + 0.97);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + 1.02);
  ringOsc.push(o);
}
function ringMelody(vol) {
  ringOsc.push(...tone([659, 784, 988, 784, 659, 784, 988, 1175], { type: 'triangle', vol: 0.25 * vol, step: 0.13, len: 0.17 }));
  try { navigator.vibrate?.([400, 200, 400]); } catch { /* */ }
}
// своя мелодия входящего (как у ПК): файл в памяти приложения, до 1,5 МБ
let ringAudio = null;
function ringFileUrl() {
  const r = store.get('ring.file', null);
  if (!r?.b64) return null;
  if (!ringFileUrl.url || ringFileUrl.hash !== r.hash) { if (ringFileUrl.url) URL.revokeObjectURL(ringFileUrl.url); ringFileUrl.url = URL.createObjectURL(new Blob([b64ToBytes(r.b64)], { type: r.mime })); ringFileUrl.hash = r.hash; }
  return ringFileUrl.url;
}
function startRing(dir = 'in') {
  stopRing();
  if(myPresence==='dnd'&&dir==='in')return;
  if (dir === 'out') { ringbackBeep(); ringTimer = setInterval(ringbackBeep, 4000); return; }
  const o = settings();
  const vib = () => { try { navigator.vibrate?.([400, 200, 400]); } catch { /* */ } };
  if (o.ringMute) { vib(); ringTimer = setInterval(vib, 2200); return; } // без мелодии — только вибрация
  const vol = Math.max(0, Math.min(1, (Number(o.ringVol) || 80) / 100));
  const url = ringFileUrl();
  if (url) {
    ringAudio = new Audio(url);
    ringAudio.loop = true;
    ringAudio.volume = vol;
    ringAudio.play().catch((e) => { L('ring', { playFailed: e.message }); ringMelody(vol); });
    vib();
    ringTimer = setInterval(vib, 2200);
    return;
  }
  ringMelody(vol);
  ringTimer = setInterval(() => ringMelody(vol), 2200);
}
function stopRing() {
  clearInterval(ringTimer);
  ringTimer = null;
  try { ringAudio?.pause(); } catch { /* */ }
  ringAudio = null;
  for (const o of ringOsc.splice(0)) { try { o.stop(); } catch { /* */ } }
  try { navigator.vibrate?.(0); } catch { /* */ }
}
async function pickRing(file) {
  if (!file) return;
  if (!/^audio\//.test(file.type) && !/\.(mp3|ogg|wav|m4a|aac|opus)$/i.test(file.name)) { toast('Нужен звук: mp3, ogg, wav, m4a'); return; }
  if (file.size > 1.5 * 1024 * 1024) { toast('Файл больше 1,5 МБ — выбери покороче'); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  store.set('ring.file', { name: file.name.slice(0, 60), mime: file.type || 'audio/mpeg', hash: await sha16(bytes), b64: bytesToB64(bytes) });
  renderRingName();
  L('ring', { custom: true });
  toast('Мелодия сохранена');
}
function renderRingName() {
  const r = store.get('ring.file', null);
  $('ringName').textContent = r?.name ? `свой: ${r.name}` : 'стандартный';
  $('ringClear').classList.toggle('hidden', !r);
}
function ringPreview() {
  if (ringTimer) { stopRing(); $('ringTest').textContent = '▶ Проверить'; return; }
  const o = { ...settings(), ringVol: Number($('optRingVol').value), ringMute: $('optRingMute').checked };
  store.set('settings', o);
  startRing('in');
  $('ringTest').textContent = '■ Стоп';
  setTimeout(() => { if (ringTimer) { stopRing(); $('ringTest').textContent = '▶ Проверить'; } }, 6000);
}

/* =========================================================
   Микрофон
   ========================================================= */
async function acquireMic() {
  const o = settings();
  const constraints = { audio: { echoCancellation: o.echo !== false, noiseSuppression: o.noise !== false, autoGainControl: o.agc !== false, channelCount: 1 }, video: false };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.warn('mic', e?.name || e);
    toast('Нет доступа к микрофону — друг тебя не услышит. Разреши микрофон в настройках телефона.');
    return audio().createMediaStreamDestination().stream; // тишина, чтобы звонок работал
  }
}
// рация (как у ПК 1.12): микрофон открыт, только пока держишь кнопку микрофона
const pttOn = () => !!settings().ptt;
function applyMicEnabled() {
  const on = !S.muted && !S.deafened && (!pttOn() || !!S.pttDown);
  S.mic?.getAudioTracks().forEach((t) => { t.enabled = on; });
  $('meCard')?.classList.toggle('ptt-open', on && pttOn());
}
function setPttDown(down) {
  if (!!S.pttDown === down) return;
  S.pttDown = down;
  applyMicEnabled();
  updateMyControls();
  if (down) { try { navigator.vibrate?.(12); } catch { /* */ } }
}
/* ---------- Шумодав RNNoise (как у ПК 1.x): микрофон → нейросеть → постоянная дорожка в звонок ----------
   Файлы — те же, что у ПК (vendor/rnnoise*, копирует sync-shared.js). Пока звук не запущен (AudioContext не «running»)
   или шумодав не загрузился — в звонок идёт сам микрофон, чтобы друг никогда не остался без голоса. */
const chain = { src: null, node: null, dest: null, failed: false, loading: null, raw: null };
const RNN_ID = '@sapphi-red/web-noise-suppressor/rnnoise';
const wasmSimd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } };
async function ensureRnnoise() {
  if (chain.node || chain.failed) return chain.node;
  if (!chain.loading) {
    chain.loading = (async () => {
      const c = audio();
      const buf = await (await fetch(wasmSimd() ? 'vendor/rnnoise_simd.wasm' : 'vendor/rnnoise.wasm')).arrayBuffer();
      await c.audioWorklet.addModule('vendor/rnnoise-worklet.js');
      chain.node = new AudioWorkletNode(c, RNN_ID, { processorOptions: { wasmBinary: buf, maxChannels: 1 }, channelCount: 1, channelCountMode: 'explicit' });
      L('ns', { ready: true, simd: wasmSimd() });
      return chain.node;
    })().catch((e) => { chain.failed = true; L('ns', { failed: String(e?.message || e).slice(0, 80) }); toast('Шумодав не запустился — микрофон работает без него'); return null; });
  }
  return chain.loading;
}
const rnnOn = () => settings().rnn !== false && !!chain.node;
function routeChain() {
  if (!chain.src || !chain.dest) return;
  try { chain.src.disconnect(); } catch { /* */ }
  try { chain.node?.disconnect(); } catch { /* */ }
  if (rnnOn()) { chain.src.connect(chain.node); chain.node.connect(chain.dest); } else chain.src.connect(chain.dest);
}
// подключить микрофон к цепочке; дорожка на выходе (chain.dest) постоянная
async function attachMicChain(raw) {
  const c = audio();
  if (!chain.dest) { chain.dest = c.createMediaStreamDestination(); chain.dest.channelCount = 1; }
  if (settings().rnn !== false) await ensureRnnoise();
  try { chain.src?.disconnect(); } catch { /* */ }
  chain.src = c.createMediaStreamSource(raw);
  chain.raw = raw;
  routeChain();
}
// шумодав выключен — сам микрофон (без лишнего звена); включён и звук идёт — выход шумодава
function micSendTrack() {
  const raw = S.mic?.getAudioTracks()[0] || null;
  if (rnnOn() && chain.dest && chain.raw === S.mic && actx?.state === 'running') return chain.dest.stream.getAudioTracks()[0];
  return raw;
}
// поменять дорожку в звонке, если сейчас не играет саундпад (у него своя смесь — она возьмёт новую сама)
async function resendMic() {
  if (G.active) { grpResendMic(); return; }
  if (!S.tx?.mic?.sender || spPlaying.size) return;
  const t = micSendTrack();
  if (S.tx.mic.sender.track !== t) await S.tx.mic.sender.replaceTrack(t).catch((e) => L('mic', { replaceFailed: e.message }));
}
// фильтры поменялись — взять микрофон заново (в звонке — без разрыва)
async function restartMic() {
  if (!S.mic) return;
  const fresh = await acquireMic();
  await attachMicChain(fresh);
  const old = S.mic;
  S.mic = fresh;
  applyMicEnabled();
  await resendMic();
  if (spNodes) spNodesGet();
  old.getTracks().forEach((t) => t.stop());
  if (S.inCall) {
    S.stopMyMeter?.();
    S.stopMyMeter = makeMeter(S.mic, (lvl) => { $('meCard').classList.toggle('speaking', lvl > 0.02 && !S.muted && !S.deafened); window.talkingAvatar?.level($('meCard'), (!S.muted && !S.deafened) ? lvl : 0); });
  }
}
async function setNs(on) {
  store.set('settings', { ...settings(), rnn: on });
  if (on && S.mic) { await ensureRnnoise(); if (chain.raw !== S.mic) await attachMicChain(S.mic); }
  routeChain();
  await resendMic();
  L('ns', { enabled: on && !!chain.node });
}
function releaseMic() {
  S.stopMyMeter?.(); S.stopMyMeter = null;
  S.mic?.getTracks().forEach((t) => t.stop());
  S.mic = null;
}
function makeMeter(stream, onLevel) {
  const c = audio();
  let src;
  try { src = c.createMediaStreamSource(stream); } catch { return () => {}; }
  const an = c.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    onLevel(Math.sqrt(sum / buf.length));
  }, 80);
  return () => { clearInterval(timer); onLevel(0); try { src.disconnect(); } catch { /* */ } };
}

/* =========================================================
   WebRTC: соединение как у десктопа
   ========================================================= */
function newPeerConnection(cfg = rtcConfig()) {
  const pc = new RTCPeerConnection(cfg);
  S.pc = pc;
  watchTogether.attach(pc);
  const dc = pc.createDataChannel('duo', { negotiated: true, id: 0, ordered: true });
  S.dc = dc;
  dc.onopen = () => { if (S.dc === dc) onConnected(); };
  dc.onclose = () => { if (S.dc === dc) friendGone('Связь закрыта'); };
  dc.onmessage = (e) => {
    if (S.dc !== dc) return;
    try { onData(JSON.parse(e.data)); } catch (err) { console.warn('bad msg', err); }
  };
  const fdc = pc.createDataChannel('files', { negotiated: true, id: 1, ordered: true });
  S.fdc = fdc;
  S.fileChan = new FileChan(fdc, () => S.callConv, {
    avatar: (blob, meta) => onAvatarFile(S.peerIdent?.id, blob, meta),
    screenimg: (blob, meta) => onShareImage(blob, meta),
    screenvid: (blob, meta) => onShareVideo(blob, meta),
    chatIn: () => { sound('msg'); if (!S.chatOpen) bumpUnread(); },
  });
  // управление: телефон управляет ПК (команды туда), ПК телефоном — нет (на ctl-req отвечаем отказом)
  S.cdc = pc.createDataChannel('ctl', { negotiated: true, id: 2, ordered: true });
  S.cdu = pc.createDataChannel('ctlu', { negotiated: true, id: 3, ordered: false, maxRetransmits: 0 });
  for (const ch of [S.cdc, S.cdu]) ch.onmessage = (e) => { if (S.pc === pc) { try { onCtlMsg(JSON.parse(e.data)); } catch { /* */ } } };
  pc.addEventListener('connectionstatechange', () => { L('pc', { connection: pc.connectionState }); if (S.pc === pc) onPcState(pc.connectionState); });
  pc.addEventListener('iceconnectionstatechange', () => L('pc', { ice: pc.iceConnectionState }));
  return pc;
}

/* ---------- Ты приглашаешь ---------- */
async function startInvite() {
  if (S.busy) return;
  const setup = {}; S.callSetup = setup;
  S.busy = true;
  if (!S.friendCall) {
    showStep('stepHost');
    try { lastClip = (await alo.paste()).text || ''; } catch { /* */ } // старый код в буфере не трогаем
  }
  if (S.callSetup !== setup) return;
  $('offerOut').value = '';
  $('answerIn').value = '';
  for (const id of ['btnCopyOffer', 'btnShareOffer', 'btnApplyAnswer']) $(id).disabled = true;
  setInfo('hostInfo', 'Готовлю приглашение…');
  try {
    const ready = await prepare(setup);
    if (S.callSetup !== setup) return;
    if (!ready) { showStep('stepHome'); if (S.friendCall) endFriendCall('Нет доступа к микрофону'); return; }
    S.role = 'host';
    const res = await gatherWithFallback('invite', (cfg) => {
      if (S.callSetup !== setup) throw new Error('call setup cancelled');
      const p = newPeerConnection(cfg);
      S.tx = {
        mic: p.addTransceiver(micSendTrack() || 'audio', { direction: 'sendrecv' }),
        video: p.addTransceiver('video', { direction: 'sendrecv' }),
        saudio: p.addTransceiver('audio', { direction: 'sendrecv' }),
      };
      preferCodecs(S.tx);
      return p;
    }, async (p) => {
      const offer = await p.createOffer();
      await p.setLocalDescription({ type: 'offer', sdp: opusStereo(offer.sdp) });
    }, (p) => S.pc === p && S.callSetup === setup);
    const pc = res?.pc;
    if (!pc || S.pc !== pc || S.callSetup !== setup) return;
    S.stunUsed = res.list;
    const sdp = pc.localDescription.sdp;
    const code = await packCode('I', sdp, S.nick);
    if (S.callSetup !== setup || S.pc !== pc) return;
    $('offerOut').value = code;
    ownCodes.add(code);
    for (const id of ['btnCopyOffer', 'btnShareOffer', 'btnApplyAnswer']) $(id).disabled = false;
    updateService();
    if (S.friendCall) sendFriendInvite(code);
    else autoCopy(code, $('btnCopyOffer'));
    const c = countCandidates(sdp);
    L('invite', { role: 'host', codeLen: code.length, candidates: c, stun: res.list, gatherMs: res.r.ms });
    setInfo('hostInfo', (c.srflx || c.relay
      ? 'Приглашение скопировано. Нажми «Отправить…» и выбери друга в мессенджере. Когда он пришлёт ответ — скопируй его и вернись сюда.'
      : 'Внешний адрес не определился (STUN недоступен) — сработает только через Tailscale или локальную сеть.') + stunNote(res.list));
  } catch (e) {
    if (S.callSetup !== setup) return;
    console.error(e);
    lobbyError(e);
    showStep('stepHome');
    if (S.friendCall) endFriendCall('Не удалось начать звонок');
  } finally {
    if (S.callSetup !== setup) return;
    S.busy = false;
    if (S.answerWhenFree) { const c = S.answerWhenFree; S.answerWhenFree = null; makeAnswer(c); }
  }
}

async function applyAnswer(text) {
  if (!S.pc || S.role !== 'host') return;
  const pc = S.pc;
  setErr('');
  let code;
  try { code = await unpackCode(text || $('answerIn').value); } catch (e) { setErr(e.message); return; }
  if (S.pc !== pc) return;
  if (code.kind !== 'A') { setErr('Это приглашение, а нужен ответ друга (начинается с ALOA.)'); return; }
  if (S.pc.signalingState !== 'have-local-offer') { setErr('Ответ уже применён. Если не соединилось — начни заново.'); return; }
  try {
    S.friendNick = code.nick || 'Друг';
    await pc.setRemoteDescription({ type: 'answer', sdp: code.sdp });
    if (S.pc !== pc) return;
    L('invite', { answerApplied: true, friendCandidates: countCandidates(code.sdp) });
    $('btnApplyAnswer').disabled = true;
    setInfo('hostInfo', 'Соединяемся…');
    armConnectTimer(HOST_CONNECT_TIMEOUT);
  } catch (e) {
    console.error(e);
    setErr('Не удалось применить ответ: ' + e.message);
  }
}

/* ---------- Тебя пригласили ---------- */
async function makeAnswer(text) {
  if (S.busy) return;
  const setup = {}; S.callSetup = setup;
  setErr('');
  let code;
  try { code = await unpackCode(text || $('offerIn').value); } catch (e) { if (S.callSetup !== setup) return; setErr(e.message); if (S.friendCall) endFriendCall('Код звонка повреждён'); return; }
  if (S.callSetup !== setup) return;
  if (code.kind !== 'I') { setErr('Это ответ, а нужно приглашение (начинается с ALOI.)'); return; }
  S.busy = true;
  $('btnMakeAnswer').disabled = true;
  setInfo('guestInfo', 'Готовлю ответ…');
  try {
    const ready = await prepare(setup);
    if (S.callSetup !== setup || !ready) return;
    closePc();
    S.role = 'guest';
    S.friendNick = code.nick || 'Друг';
    const res = await gatherWithFallback('answer', (cfg) => { if (S.callSetup !== setup) throw new Error('call setup cancelled'); return newPeerConnection(cfg); }, async (p) => {
      await p.setRemoteDescription({ type: 'offer', sdp: code.sdp });
      const trs = p.getTransceivers().filter((t) => t.mid != null).sort((a, b) => Number(a.mid) - Number(b.mid));
      if (trs.length < 3) throw new Error('Приглашение от другой версии alloconnect');
      S.tx = { mic: trs[0], video: trs[1], saudio: trs[2] };
      trs.forEach((t) => { t.direction = 'sendrecv'; });
      await S.tx.mic.sender.replaceTrack(micSendTrack());
      preferCodecs(S.tx);
      const answer = await p.createAnswer();
      await p.setLocalDescription({ type: 'answer', sdp: opusStereo(answer.sdp) });
    }, (p) => S.pc === p && S.callSetup === setup, { answer: true });
    const pc = res?.pc;
    if (!pc || S.pc !== pc || S.callSetup !== setup) return;
    S.stunUsed = res.list;
    const ans = await packCode('A', pc.localDescription.sdp, S.nick);
    if (S.callSetup !== setup || S.pc !== pc) return;
    $('answerOut').value = ans;
    ownCodes.add(ans);
    updateService();
    L('invite', { role: 'guest', codeLen: ans.length, ownCandidates: countCandidates(pc.localDescription.sdp), friendCandidates: countCandidates(code.sdp), stun: res.list, gatherMs: res.r.ms });
    if (S.friendCall) {
      const fc = S.friendCall;
      const r = await alo.friendsSend({ id: fc.id, msg: callEnvelope(fc, { t: 'answer', code: ans }) });
      if (S.callSetup !== setup || S.pc !== pc || S.friendCall !== fc) return;
      if (!r.ok) { endFriendCall(`Не удалось ответить ${fc.nick}: ${r.error || 'нет связи'}`); return; }
    } else {
      $('guestAnswerBlock').classList.remove('hidden');
      autoCopy(ans, $('btnCopyAnswer'));
      setInfo('guestInfo', `Ответ скопирован — нажми «Отправить…» и перешли его ${S.friendNick}. Ждём, когда он его применит…` + stunNote(res.list));
    }
    armConnectTimer(GUEST_CONNECT_TIMEOUT);
  } catch (e) {
    if (S.callSetup !== setup) return;
    console.error(e);
    lobbyError(e);
    $('btnMakeAnswer').disabled = false;
    if (S.friendCall) endFriendCall('Не удалось принять звонок');
  } finally {
    if (S.callSetup === setup) S.busy = false;
  }
}

function stunNote(list) {
  return list === 'alt' ? '\nSTUN: основные серверы не ответили — используются альтернативные.' : '';
}

function armConnectTimer(ms) {
  clearTimeout(S.connectTimer);
  S.connectTimer = setTimeout(() => { if (!S.connected) connectFailed('Не удалось соединиться напрямую.'); }, ms);
}
function connectFailed(text) {
  S.callSetup = null; S.answerWhenFree = null; S.busy = false;
  L('pc', { connectFailed: text, role: S.role });
  if (S.friendCall) { hideCallModal(); S.friendCall = null; }
  clearTimeout(S.connectTimer);
  closePc();
  releaseMic();
  sound('error');
  showStep('stepHome');
  $('lobbyError').textContent = text + ' Попробуйте заново (новое приглашение). Если повторяется — поставьте обоим Tailscale.';
  updateService();
}
function onPcState(state) {
  if (state === 'connected') {
    if (S.connected && !S.reconnecting) setStatus('ok', 'Соединено');
  } else if (state === 'disconnected') {
    if (S.connected && !S.reconnecting) {
      setStatus('waiting', 'Связь прерывается…');
      const pc = S.pc;
      setTimeout(() => { if (S.pc === pc && S.connected && pc.connectionState !== 'connected') startReconnect('disconnected'); }, 3000);
    }
  } else if (state === 'failed') {
    if (S.connected) startReconnect('failed');
    else connectFailed('Не удалось соединиться напрямую.');
  }
}

/* ---------- Соединились ---------- */
function onConnected() {
  clearTimeout(S.connectTimer);
  S.connected = true;
  send({ t: 'hello', nick: S.nick, muted: S.muted, deaf: S.deafened });
  capsReady.then((c) => send({ t: 'caps', dec: SCREEN_COMPAT.codec==='VP8'&&!SCREEN_COMPAT.perSender?{H264:'no',H265:'no',AV1:'no',VP9:'no',VP8:'sw'}:c.dec, enc: c.enc, cam: 1 })); // cam: 1 — умею вебкамеру (как ПК 1.18)
  enterCall();
  attachRemoteVoice(new MediaStream([S.tx.mic.receiver.track]));
  tuneAudioSender(S.tx.mic.sender, 64_000);
  setStatus('ok', 'Соединено');
  sound('join');
  sysMsg(`${S.friendNick} в звонке`);
  if (S.stunUsed === 'alt') sysMsg('STUN: основные серверы не ответили — включены альтернативные');
  L('call', { connected: true, role: S.role, viaFriends: !!S.friendCall });
  // звонок из списка друзей: SDP пришёл по зашифрованному каналу друзей — собеседник уже подтверждён ключом
  if (S.friendCall) { S.signaledBy = S.friendCall.id; hideCallModal(); S.friendCall = null; }
  sendIdent();
  sendPerm(); // что друг может делать поверх моего показа экрана
  startStats();
}

function send(obj) {
  try { if (S.dc?.readyState === 'open') S.dc.send(JSON.stringify(obj)); } catch (e) { console.warn('send', e); }
}

function onData(d) {
  if (!d || typeof d !== 'object') return;
  if (camOnData(d)) return; // вебкамера (camera.js)
  switch (d.t) {
    case 'friend-contact':
      receiveFriendContact(d);
      break;
    case 'hello':
      S.friendNick = String(d.nick || S.friendNick || 'Друг').slice(0, 24);
      setFriendPresent(true);
      setFriendBadges(d.muted, d.deaf);
      break;
    case 'state':
      setFriendBadges(d.muted, d.deaf);
      break;
    case 'ident':
      onPeerIdent(d);
      break;
    case 'ident-proof':
      onPeerIdentProof(d);
      break;
    case 'friend-added':
      toast(`${S.friendNick} добавил тебя в друзья`);
      if (S.peerIdent && !isFriend(S.peerIdent.id)) $('btnAddFriend').textContent = '➕ Добавить в ответ';
      break;
    case 'caps':
      S.friendCaps = d.dec || {};
      S.peerCam = d.cam === 1; // 1.18: умеет вебкамеру
      break;
    case 'chat': {
      const text = String(d.text || '').slice(0, 2000);
      const mid = cleanMid(d.mid) || newMid();
      if (S.callConv?.msgs?.has(mid) || (S.callConv?.id && histGet(S.callConv.id).some(e => e.mid === mid))) return;
      const re = reIn(d.re);
      chatMsg(S.callConv, S.friendNick, text, false, d.ts, null, { mid, re });
      record(S.callConv, { mid, ts: Number(d.ts) || Date.now(), who: 'peer', nick: S.friendNick, type: 'text', text, re: re || undefined });
      noteUnseen(S.callConv, mid);
      sound('msg');
      if (!S.chatOpen) { bumpUnread(); toast(`💬 ${S.friendNick}: ${text.slice(0, 60)}`); }
      break;
    }
    case 'read': onReadMids(S.callConv, d.mids); break;
    case 'sp-stop': spStopAll(); break; // друг нажал «убрать всё с экрана» — глушим свой саундпад
    case 'screen-start':
      L('watch', { friendStarted: d.quality });
      showRemoteScreen();
      break;
    case 'screen-stop':
      hideRemoteScreen();
      break;
    case 'sstats': {
      const why = { cpu: 'не хватает процессора', bandwidth: 'не хватает скорости интернета', other: 'тормозит захват' }[d.reason];
      $('remoteReason').textContent = why ? `⚠ У ${S.friendNick}: ${why}` : '';
      break;
    }
    case 'bye':
      friendGone(`${S.friendNick} завершил звонок`, 'peer');
      break;
    case 'av-hash':
      onPeerAvatarHash(S.peerIdent?.id, String(d.av || '').slice(0, 32), () => send({ t: 'av-want' }));
      break;
    case 'av-want': {
      const f = myAvatarFile();
      if (f && S.fileChan) S.fileChan.queue([f], 'avatar');
      break;
    }
    case 'draw': case 'ptr': case 'ptr-off': case 'draw-clear': case 'react':
      onOverlayData(d);
      break;
    case 'chat-op':
      if (S.callConv) applyOp(S.callConv, d, 'peer');
      break;
    case 'svid-play':
      if(d.fid==null||d.fid===svidOut?.fid)startVideoEcho();
      break;
    case 'svid-stop':
      if(Number.isInteger(d.fid)&&d.fid===svidOut?.fid) { const old=svidOut; old.end?.(); old.status.remove(); URL.revokeObjectURL(old.url); svidOut=null; }
      break;
    case 'svid-cancel':
      if(Number.isInteger(d.fid)&&SH)cancelShareVideo(d.fid);
      break;
    case 'svid-no':
      onVideoRefused(String(d.why || ''));
      break;
    case 'ctl-req':
      // ПК просит управление телефоном — этого нет (Android не пускает чужой ввод без спецвозможностей)
      send({ t: 'ctl-deny', why: 'с телефона управление недоступно' });
      break;
    case 'perm': // что друг разрешил поверх своего экрана
      S.friendPerm = { draw: d.draw !== false, react: !!d.react, ctl: d.ctl !== false, vid: d.vid === 1, mediaLong: d.mediaLong === 1, ops: d.ops === 1 };
      if (!S.friendPerm.draw && (tools.mode === 'draw' || tools.mode === 'ptr')) tools.mode = null;
      updateToolbar();
      break;
    case 'ctl-grant':
      if (CV.state !== 'off') ctlViewStart(d);
      break;
    case 'ctl-deny':
      if (CV.state === 'req') { CV.state = 'off'; clearTimeout(CV.reqTimer); updateToolbar(); toast(`${S.friendNick} ${String(d.why || 'отказал').slice(0, 60)}`); }
      break;
    case 'ctl-end':
      ctlViewStop(false, String(d.why || '').slice(0, 60) || `${S.friendNick} забрал управление`);
      break;
    default:
      break; // рисование, реакции и пр. — не для телефона
  }
}

async function tuneAudioSender(sender, br) {
  if (!sender || !sender.track) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = br;
  p.encodings[0].networkPriority = 'high';
  try { await sender.setParameters(p); } catch {
    p.encodings.forEach((e) => delete e.networkPriority);
    try { await sender.setParameters(p); } catch (e2) { console.warn('setParameters', e2); }
  }
}

function attachRemoteVoice(stream) {
  // голос друга — обычным <audio>: так Android сам гасит эхо и выводит звук в нужный динамик
  const el = $('remoteVoice');
  el.srcObject = stream;
  el.muted = S.deafened;
  el.volume = Number($('friendVol').value) / 100;
  el.play().catch(() => {});
  S.stopFriendMeter?.();
  S.stopFriendMeter = makeMeter(stream, (lvl) => { $('friendCard').classList.toggle('speaking', lvl > 0.02 && !S.deafened); window.talkingAvatar?.level($('friendCard'), (!S.deafened) ? lvl : 0); });
}

// delay — дать последнему сообщению («bye») уйти; состояние звонка очищается сразу
function closePc(delay = 0) {
  watchTogether.reset();
  stopShare(true);
  const { pc, dc, fdc, fileChan: chan } = S;
  S.pc = null; S.dc = null; S.fdc = null; S.cdc = null; S.cdu = null; S.fileChan = null; S.tx = null;
  chan?.fail('звонок завершён');
  setTimeout(() => {
    try { fdc?.close(); } catch { /* */ }
    try { dc?.close(); } catch { /* */ }
    try { pc?.close(); } catch { /* */ }
  }, delay);
}

/* ---------- Друг ушёл / связь потеряна ---------- */
function friendGone(reason, cause = 'network') {
  if (!S.connected) return;
  L('call', { ended: reason === 'Связь закрыта' ? 'closed' : 'other', cause });
  callEvent(cause === 'peer' ? reason : 'Связь потеряна — кто прервал соединение, определить не удалось.', cause);
  if (S.reconnecting) { clearTimeout(S.reconnecting.timer); S.reconnecting = null; $('call').classList.remove('reconnecting'); }
  S.connected = false;
  hideRemoteScreen();
  stopStats();
  spStopAll();
  S.stopFriendMeter?.(); S.stopFriendMeter = null;
  $('remoteVoice').srcObject = null;
  closePc();
  setFriendPresent(false);
  sound('gone');
  if (document.hidden) alo.notifyMsg({ nick: S.friendNick || 'Друг', text: reason });
  // как у ПК 1.16: друг (ID подтверждён ключом) может вернуться в этот же звонок — ждём его
  const id = canSignal() ? S.peerIdent.id : null;
  const nick = S.friendNick;
  S.waiting = id ? { id, nick } : null;
  $('waitBar').classList.remove('hidden');
  $('btnCallAgain').classList.toggle('hidden', !id);
  if (id) {
    $('waitText').textContent = `${nick} больше не в звонке — ждём, может вернуться`;
    sysMsg(`${reason}. Ждём — ${nick} может вернуться, или позвони снова.`);
    setStatus('waiting', `Ждём ${nick}…`);
    alo.friendsSend({ id, msg: { t: 'call-wait' } }); // у него в лобби появится «Вернуться»
  } else {
    $('waitText').textContent = `${nick} больше не в звонке. Вернуться в этот звонок нельзя — вы не в друзьях`;
    sysMsg(`${reason}. Вернуться в этот звонок нельзя — вы не в друзьях. После звонка добавьте друг друга, чтобы созваниваться в один клик.`);
    setStatus('bad', 'Звонок завершён');
  }
  clearInterval(S.timerInt);
  updateService();
}

/* ---------- Возврат в звонок (как у ПК 1.16) ----------
   Ушедший видит в лобби «Вернуться» (пока я жду — 'call-wait', перестал ждать — 'call-closed').
   «Вернуться» — обычный звонок другу с пометкой rejoin: тот, кто ждёт именно его, принимает без звонка. */
const REJOIN_FOR = 30 * 60 * 1000;
function showRejoin() {
  const r = S.rejoin;
  const on = !!r && Date.now() < r.until && !S.inCall;
  if (r && !on && Date.now() >= r.until) S.rejoin = null;
  $('rejoinBar').classList.toggle('hidden', !on);
  if (on) $('rejoinText').textContent = `Звонок с ${r.nick} ещё идёт — ${r.nick} ждёт тебя`;
}
function rejoinCall() {
  const r = S.rejoin;
  S.rejoin = null;
  showRejoin();
  if (!r || !isFriend(r.id)) return;
  callFriend(r.id, true);
}
// я жду, а позвонить хочу сам: выхожу из пустого звонка и звоню
function callAgain() {
  const w = S.waiting;
  if (!w) return;
  S.waiting = null;
  leaveCall();
  callFriend(w.id, true);
}
// он вернулся (звонок от того, кого жду): выходим из пустого звонка и сразу отвечаем
function acceptRejoin(id, nick, code, attempt) {
  L('friend-call', { rejoin: 'accepted' });
  S.waiting = null;
  leaveCall();
  S.friendCall = { id, nick, dir: 'in', code, accepted: true, cid: attempt?.cid, requireCid: validCallAttempt(attempt?.cid) };
  showCallModal('in', nick);
  $('callTitle').textContent = `${nick} возвращается`;
  $('callSub').textContent = 'Соединяемся…';
  $('btnCallAccept').classList.add('hidden');
  $('btnCallDecline').classList.add('hidden');
  S.nick = $('nick').value.trim() || 'Без имени';
  updateService();
  makeAnswer(code);
}

/* =========================================================
   Стрим друга: на весь экран, поворот, громкость
   ========================================================= */
function showRemoteScreen() {
  if (!S.tx) return;
  const v = $('remoteScreen');
  try { S.tx.video.receiver.jitterBufferTarget = 100; S.tx.saudio.receiver.jitterBufferTarget = 100; } catch { /* */ }
  v.srcObject = new MediaStream([S.tx.video.receiver.track, S.tx.saudio.receiver.track]);
  v.muted = S.deafened;
  v.volume = Number($('screenVol').value) / 100;
  v.play().catch(() => {});
  $('remoteScreenOwner').textContent = S.friendNick || 'друг';
  $('remoteScreenWrap').classList.remove('hidden');
  $('screenVolRow').classList.remove('hidden');
  $('people').classList.remove('hidden');
  alo.keepScreenOn({ on: true });
  alo.audioRoute({}).then((r) => {
    if (r.headset || !S.inCall) return; // и если уже «громкая» — подтвердить, чтобы датчик точно выключился
    alo.audioRoute({ speaker: true }).then((r2) => { S.speaker = !!r2.speaker; updateMyControls(); });
  });
  sound('stream');
  refreshClip();
  sysMsg(`${S.friendNick} показывает экран — нажми ⛶, чтобы смотреть на весь экран`);
}

function hideRemoteScreen() {
  ctlViewStop(false, 'показ закончился');
  cancelPlacement();
  tools.mode = null;
  if (tools.stroke) { clearInterval(tools.flushT); tools.stroke = null; }
  tools.local.clear();
  tools.myPtr = null;
  kickLocal();
  $('reactBar').classList.add('hidden');
  updateToolbar();
  if ($('remoteScreenWrap').classList.contains('fs')) setFullscreen(false);
  $('remoteScreen').srcObject = null;
  $('remoteReason').textContent = '';
  $('remoteStats').textContent = '';
  $('remoteScreenWrap').classList.add('hidden');
  $('screenVolRow').classList.add('hidden');
  $('people').classList.remove('hidden');
  alo.keepScreenOn({ on: false });
  refreshClip();
}

let fsOrient = 'landscape';
function setFullscreen(on) {
  $('remoteScreenWrap').classList.toggle('fs', on);
  $('fsControls').classList.add('hidden');
  alo.fullscreen({ on, orientation: on ? fsOrient : 'sensor' });
  L('watch', { fullscreen: on });
}
let fsHideTimer = null;
function showFsControls() {
  const c = $('fsControls');
  c.classList.remove('hidden');
  $('remoteScreenWrap').classList.add('fsctl');
  $('btnFsMute').classList.toggle('off', S.muted);
  clearTimeout(fsHideTimer);
  fsHideTimer = setTimeout(() => { c.classList.add('hidden'); $('remoteScreenWrap').classList.remove('fsctl'); }, 4000);
}

/* =========================================================
   Повтор последних секунд (как у ПК 1.11): пока смотришь стрим друга, в памяти держатся последние ~30 с
   (clip.js + mp4-muxer — те же файлы, что у ПК). ⏪ — собрать MP4: сохранить или отправить.
   Свой показ экрана телефон не пишет: видеочип и так занят (экран + звонок), а в фоне кодировщик повтора
   задерживал кадры — показ замирал. Свой экран друг может записать у себя.
   ========================================================= */
function clipAudioMix(tracks) {
  const c = audio();
  const dest = c.createMediaStreamDestination();
  const srcs = [];
  for (const t of tracks) {
    if (!t || t.readyState === 'ended') continue;
    try { const s = c.createMediaStreamSource(new MediaStream([t])); s.connect(dest); srcs.push(s); } catch { /* */ }
  }
  return { track: dest.stream.getAudioTracks()[0] || null, stop() { for (const s of srcs) { try { s.disconnect(); } catch { /* */ } } } };
}

function clipTarget() {
  if (!settings().clip || !window.ClipRecorder || !window.ClipRecorder.supported()) return null;
  if (!$('remoteScreenWrap').classList.contains('hidden') && S.tx?.video?.receiver?.track) {
    return { key: 'remote', video: S.tx.video.receiver.track, audio: [S.tx.saudio?.receiver?.track, S.tx.mic?.receiver?.track, micSendTrack()] };
  }
  return null;
}

async function refreshClip() {
  const t = clipTarget();
  const key = t ? t.key + ':' + (t.video?.id || '') : null;
  if (key === S.clipKey) return;
  stopClip();
  if (!t || !t.video) return;
  S.clipKey = key;
  // звук в повтор — только если включено (как у ПК 1.17, по умолчанию выкл)
  const mix = settings().clipAudio === true ? clipAudioMix(t.audio) : { track: null, stop() {} };
  S.clipMix = mix;
  const rec = new window.ClipRecorder(Math.max(5, Math.min(120, Number(settings().clipSeconds) || 30)));
  S.clip = rec;
  const ok = await rec.start(t.video, mix.track);
  if (!ok) { const st = t.video.getSettings?.() || {}; L('clip', { startFailed: rec.err, size: `${st.width}x${st.height}` }); stopClip(); }
  else L('clip', { started: t.key, seconds: rec.seconds });
  updateClipBtns();
}

function stopClip() {
  try { S.clip?.stop(); } catch { /* */ }
  try { S.clipMix?.stop(); } catch { /* */ }
  S.clip = null;
  S.clipMix = null;
  S.clipKey = null;
  updateClipBtns();
}
function updateClipBtns() { $('toolClip').classList.toggle('hidden', !S.clip); }

async function saveClip() {
  const rec = S.clip;
  if (!rec || !rec.running) { toast('Повтор работает, пока смотришь стрим друга'); return; }
  if (rec.secondsBuffered() < 2) { toast('Ещё нечего сохранить — подожди пару секунд'); return; }
  if (S.clipSaving) return;
  S.clipSaving = true;
  toast('Собираю повтор…');
  let blob = null;
  try { blob = await rec.save(); } catch (e) { L('clip', { saveFailed: e.message }); }
  S.clipSaving = false;
  if (!blob) { toast('Не удалось собрать повтор'); return; }
  const secs = Math.round(Math.min(rec.seconds, rec.secondsBuffered()));
  const name = `повтор-${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }).replace(':', '-')}.mp4`;
  const file = new File([blob], name, { type: 'video/mp4' });
  L('clip', { saved: true, seconds: secs, sizeKB: Math.round(blob.size / 1024) });
  showClipPreview(file, secs, blob.frameTimes);
}

function showClipPreview(file, secs, frames) {
  if (S.clipUrl) URL.revokeObjectURL(S.clipUrl);
  const url = URL.createObjectURL(file);
  S.clipUrl = url;
  S.clipFile = file;
  watchTogether.preview(file, frames);
  $('clipVideo').src = url;
  $('clipInfo').textContent = `Последние ${secs} с · ${fmtSize(file.size)}`;
  $('clipModal').classList.remove('hidden');
  $('clipSend').disabled = !S.connected;
}
function closeClipPreview() {
  for (const id of ['clipWatch', 'clipPrev', 'clipNext']) $(id).onclick = null;
  $('clipModal').classList.add('hidden');
  $('clipVideo').pause();
  $('clipVideo').removeAttribute('src');
  $('clipVideo').load();
  if (S.clipUrl) URL.revokeObjectURL(S.clipUrl);
  S.clipUrl = S.clipFile = null;
}

/* =========================================================
   Показ экрана с телефона. WebView сам экран захватить не умеет: Android (MediaProjection) жмёт экран
   видеочипом в H.264 и отдаёт поток вместе со звуком телефона (ScreenCap.java). Окно распаковывает кадры
   (WebCodecs) и кладёт их в видеодорожку, звук — через AudioWorklet в звуковую дорожку стрима.
   Дальше как у ПК: трансиверы video + saudio, 'screen-start' / 'screen-stop', 'sstats'.
   ========================================================= */
// режимы: как в Discord — плавный для игр и видео, «текстовый» для слабой связи (чётко, но мало кадров)
const SHARE_Q = {
  60: { fps: 60, maxSide: 1280, kbps: 6000, srcKbps: 12000, hint: 'motion', name: '60 кадров' },
  30: { fps: 30, maxSide: 1280, kbps: 4000, srcKbps: 8000, hint: 'motion', name: '30 кадров' },
  15: { fps: 15, maxSide: 1280, kbps: 1500, srcKbps: 4000, hint: 'detail', name: '15 кадров · текстовый' },
};
const shareQ = () => SHARE_Q[settings().shareFps] || SHARE_Q[60];
let SH = null;

// дорожка, в которую кладём кадры. MediaStreamTrackGenerator не зависит от отрисовки страницы — работает и в фоне,
// когда приложение свёрнуто (а показывают как раз другое приложение); холст — запасной путь
async function makeFrameSink(fps) {
  if (typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function') {
    const paced = await makePacedFrameSink(fps);
    if (paced) return paced;
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    let pending = 0;
    return {
      kind: 'generator', track: gen,
      // кадр (VideoFrame) отдаётся дорожке и закрывается ею; если дорожка не успевает — лишний выкидываем
      put(frame) {
        if (pending > 2) { frame.close(); return false; }
        pending++;
        writer.write(frame).catch(() => frame.close()).finally(() => { pending--; });
        return true;
      },
      stop() { writer.close().catch(() => {}); gen.stop(); },
    };
  }
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const track = c.captureStream(fps).getVideoTracks()[0];
  return {
    kind: 'canvas', track,
    put(frame) {
      const w = frame.displayWidth || frame.width, h = frame.displayHeight || frame.height;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      g.drawImage(frame, 0, 0);
      frame.close();
      return true;
    },
    stop() { track.stop(); },
  };
}

/* ---------- H.264 от телефона → кадры ---------- */
// экран телефона стоит — новых кадров нет (кодировщик повторяет не везде); раз в секунду повторяем последний,
// чтобы у друга картинка не «зависала» и тот, кто подключился позже, сразу её увидел
// One local clock for captured frames and idle repeats. Keep source intervals instead of stamping an IPC batch at once.
function frameTs(sh, sourceUs) {
  return screenFrameTime(sh, sourceUs, Math.round(performance.now() * 1000));
}
function putFrame(sh, f0) {
  sh.frameFormat = f0.format || 'opaque';
  let f = f0;
  if (!sh.dbg.noTs) { try { f = new VideoFrame(f0, { timestamp: frameTs(sh, f0.timestamp) }); f0.close(); } catch { f = f0; } }
  const now = Date.now();
  // Release the previous decoder surface promptly; retaining an old GPU frame can exhaust its pool.
  sh.snap?.close(); sh.snap = f.clone(); sh.snapAt = now;
  sh.lastOut = now;
  if (sh.sink.put(f)) sh.frames++; else sh.sinkDrops++;
}
function keepAlive(sh) {
  if (SH !== sh) return;
  const now = Date.now();
  if (sh.dbg.noWatch) { if (sh.snap && now - sh.lastOut >= 1000) { sh.lastOut = now; try { sh.sink.put(new VideoFrame(sh.snap, { timestamp: frameTs(sh) })); } catch { /* */ } } return; }
  // поток с телефона молчит (кодировщик и при неподвижном экране повторяет кадр раз в 100 мс) — открываем заново
  if (sh.lastMsg && now - sh.lastMsg > 4000 && now - sh.reopenAt > 4000) {
    sh.reopenAt = now;
    L('share', { streamStall: Math.round((now - sh.lastMsg) / 1000) });
    sh.stream?.close();
    sh.stream = alo.screenStream((type, flags, ts, data) => onScreenMsg(sh, type, flags, ts, data));
  }
  // кадры идут, а распаковщик ничего не отдаёт — завис (бывает с видеочипом телефона): пересоздаём
  if (sh.dec && sh.fmt && now - sh.lastIn < 1000 && now - Math.max(sh.lastDecOut, sh.decAt) > 3000) {
    L('share', { decoderStall: true, queue: sh.dec.decodeQueueSize });
    sh.decStalls++;
    configureDecoder(sh, sh.fmt);
    alo.screenKey();
  }
  if (!sh.snap || now - sh.lastOut < 1000) return;
  sh.lastOut = Date.now();
  try { sh.sink.put(new VideoFrame(sh.snap, { timestamp: frameTs(sh) })); } catch { /* */ }
}

function configureDecoder(sh, fmt) {
  try { if (sh.dec && sh.dec.state !== 'closed') sh.dec.close(); } catch { /* */ }
  sh.fmt = fmt;
  sh.needKey = true;
  sh.decAt = Date.now();
  const preferSoftware = SCREEN_COMPAT.codec === 'VP8' && !sh.hardwareDecodeFallback;
  const dec = new VideoDecoder({
    output: (f) => { if (SH === sh && sh.dec === dec) { sh.lastDecOut = Date.now(); sh.decoded++; putFrame(sh, f); } else f.close(); },
    error: (e) => {
      if (SH !== sh || sh.dec !== dec) return;
      sh.decErrors++;
      L('share', { decoderError: String(e?.message || e).slice(0, 200) });
      if (preferSoftware) sh.hardwareDecodeFallback = true;
      // пересоздаём и просим у телефона ключевой кадр
      if (SH === sh && sh.dec === dec) setTimeout(() => { if (SH === sh) { configureDecoder(sh, sh.fmt); alo.screenKey(); } }, 300);
    },
  });
  sh.dec = dec;
  const config = { codec: fmt.codec, codedWidth: fmt.w, codedHeight: fmt.h, optimizeForLatency: true,
    hardwareAcceleration: preferSoftware ? 'prefer-software' : 'no-preference' };
  try { dec.configure(config); } catch (e) {
    if (!preferSoftware) throw e;
    sh.hardwareDecodeFallback = true;
    dec.configure({ ...config, hardwareAcceleration: 'no-preference' });
  }
  if (!sh.size || sh.size[0] !== fmt.w || sh.size[1] !== fmt.h) { sh.size = [fmt.w, fmt.h]; L('share', { format: fmt }); }
}

function onScreenMsg(sh, type, flags, ts, data) {
  if (SH !== sh) return;
  sh.lastMsg = Date.now();
  if (type === 3) { // формат: перед первым кадром и после поворота
    try { configureDecoder(sh, JSON.parse(new TextDecoder().decode(data))); } catch (e) { L('share', { formatError: e.message }); }
  } else if (type === 1) { // кадр H.264
    const dec = sh.dec;
    if (!dec || dec.state !== 'configured') return;
    sh.lastIn = Date.now();
    sh.inFrames++;
    const key = (flags & 1) === 1;
    if (sh.needKey && !key) { sh.skipped++; return; }
    // не успеваем — ждём ключевой (дальше ссылаться не на что: начинать можно только с него)
    if (dec.decodeQueueSize > (sh.dbg.q || 8)) { sh.needKey = true; sh.queueDrops++; sh.skipped++; alo.screenKey(); return; }
    sh.needKey = false;
    try { dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data })); } catch (e) { sh.needKey = true; L('share', { decodeError: e.message }); }
  } else if (type === 4) { // JPEG (запасной путь): берём только последний
    sh.jpeg = { data, ts };
    if (!sh.jpegBusy) drainJpeg(sh);
  } else if (type === 2) { // звук телефона: PCM s16le 48 кГц стерео
    if (sh.pcm) { const ab = data.slice().buffer; sh.pcm.port.postMessage(ab, [ab]); }
  }
}

async function drainJpeg(sh) {
  sh.jpegBusy = true;
  try {
    while (sh.jpeg && SH === sh) {
      const d = sh.jpeg; sh.jpeg = null;
      const bmp = await createImageBitmap(new Blob([d.data], { type: 'image/jpeg' }));
      if (SH !== sh) { bmp.close(); break; }
      const f = new VideoFrame(bmp, { timestamp: d.ts });
      bmp.close();
      putFrame(sh, f);
    }
  } catch (e) { L('share', { jpegError: String(e?.message || e).slice(0, 200) }); }
  sh.jpegBusy = false;
}

// звук телефона → дорожка saudio. Отдельный AudioContext на 48 кГц — как приходит из Android
async function startShareAudio(sh) {
  // звук звонка уже идёт через основной звуковой движок — им же и играем звук экрана (второй движок Android
  // иногда не запускает: тогда в звонок не уходило ни байта). Другая частота — тогда отдельный, как раньше.
  const main = audio();
  const own = main.sampleRate !== 48000;
  const ctx = own ? new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }) : main;
  if (!ctx.__pcm) { await ctx.audioWorklet.addModule('pcm-worklet.js'); ctx.__pcm = true; }
  const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  node.connect(dest); // только в звонок, не в свой динамик
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  if (ctx.state !== 'running') L('share', { audioCtx: ctx.state, own });
  sh.actx = own ? ctx : null; // основной движок не закрываем
  sh.pcmDest = dest;
  sh.pcm = node;
  return dest.stream.getAudioTracks()[0];
}

async function startShare() {
  if (SH || (!G.active && (!S.connected || !S.tx))) return;
  const ownerPc = S.pc, ownerGroup = G.active ? G.gid : null;
  const shareOwner = () => ownerGroup ? G.active && G.gid === ownerGroup : !G.active && S.pc === ownerPc && S.connected && !!S.tx;
  const q = { ...shareQ() };
  // Software VP8 should receive CPU-backed YUV frames; full-size GPU readbacks made the 60 FPS preset stall.
  if (SCREEN_COMPAT.codec === 'VP8' && q.fps > 30) q.maxSide = Math.min(q.maxSide, 960);
  const withAudio = settings().shareAudio !== false;
  $('btnScreen').disabled = true;
  try {
    // H.264 — если окно умеет его распаковывать; иначе телефон пришлёт JPEG
    let h264 = false;
    try { h264 = typeof VideoDecoder === 'function' && (await VideoDecoder.isConfigSupported({ codec: 'avc1.42e01f', codedWidth: 1280, codedHeight: 720 })).supported; } catch { /* */ }
    const r = await alo.screenStart({ maxSide: q.maxSide, fps: q.fps, kbps: q.srcKbps, codec: h264 ? 'h264' : 'jpeg', audio: withAudio });
    if (!r.ok) {
      L('share', { start: false, error: r.error || 'нет' });
      if (r.error !== 'cancel') toast('Не удалось начать показ экрана' + (r.error ? ': ' + r.error : ''));
      return;
    }
    if (!shareOwner()) { alo.screenStop(); return; }
    const sink = await makeFrameSink(q.fps);
    if (!shareOwner()) { sink.stop(); alo.screenStop(); return; }
    sink.track.contentHint = q.hint; // motion — плавность, detail — чёткий текст
    const sh = { q, sink, dec: null, fmt: null, needKey: true, frames: 0, jpeg: null, jpegBusy: false, actx: null, pcm: null, stream: null, snap: null, snapAt: 0, lastOut: 0,
      // для сторожей и лога: когда что приходило и сколько чего выброшено
      lastMsg: 0, lastIn: 0, lastDecOut: 0, decAt: 0, reopenAt: 0, inFrames: 0, decoded: 0, skipped: 0, queueDrops: 0, sinkDrops: 0,
      decErrors: 0, decStalls: 0, encStuck: 0, encResets: 0, lastEnc: -1, logAt: Date.now(), logPrev: null,
      dbg: store.get('dbg', {}) }; // переключатели для замеров (автотест): noTs, deg
    SH = sh;
    sink.onError = error => { if (SH === sh) { L('share', { pacerError: String(error) }); stopShare(); toast('Показ экрана остановлен: ошибка обработки кадров'); } };
    sh.stream = alo.screenStream((type, flags, ts, data) => onScreenMsg(sh, type, flags, ts, data));
    let at = null;
    if (withAudio && r.audio === 'on') {
      try { at = await startShareAudio(sh); } catch (e) { L('share', { audioError: e.message }); }
    }
    if (SH !== sh) return;
    if (G.active) await grpShareStart(sink.track, at, q);
    else {
      await applyScreenCodec(S.tx.video.sender);
      await S.tx.video.sender.replaceTrack(sink.track);
      await S.tx.saudio.sender.replaceTrack(at);
      await tuneVideoSender(S.tx.video.sender, q);
      if (at) await tuneAudioSender(S.tx.saudio.sender, 128_000);
      send({ t: 'screen-start', quality: `phone${q.fps}`, name: '' });
      camTune(); // пока показываю экран — камера скромнее
    }
    sh.stats = setInterval(() => shareStats(sh), 2000);
    ovlStart().catch(() => {});
    sh.keep = setInterval(() => keepAlive(sh), 500);
    L('share', { start: true, size: `${r.w}x${r.h}`, mode: r.mode, fps: r.fps, audio: at ? 'on' : (r.audio || 'off'), sink: sink.kind });
    $('shareBar').classList.remove('hidden');
    $('shareMode').textContent = q.name + (at ? ' · со звуком' : '');
    $('btnScreen').classList.add('on');
    $('btnScreen').querySelector('span').textContent = 'Стоп';
    sound('stream');
    sysMsg('Ты показываешь экран — сверни alloconnect и открой то, что хочешь показать');
    if (withAudio && !at) sysMsg(r.audio === 'old-android' ? 'Звук телефона передаётся с Android 10 — здесь только картинка' : 'Звук телефона захватить не удалось — идёт только картинка');
    if (r.fps && r.fps < q.fps) sysMsg(`Телефон не тянет ${q.fps} кадров — показываю ${r.fps}`);
  } finally { $('btnScreen').disabled = false; }
}

function stopShare(silent) {
  const sh = SH;
  if (!sh) return;
  SH = null;
  ovlStop();
  if (!G.active) camTune();
  clearInterval(sh.stats);
  clearInterval(sh.keep);
  sh.snap?.close();
  alo.screenStop();
  sh.stream?.close();
  try { if (sh.dec && sh.dec.state !== 'closed') sh.dec.close(); } catch { /* */ }
  if (G.active) grpShareStop();
  else if (S.tx) {
    S.tx.video.sender.replaceTrack(null).catch(() => {});
    S.tx.saudio.sender.replaceTrack(null).catch(() => {});
  }
  sh.sink.stop();
  try { sh.pcm?.disconnect(); } catch { /* */ }
  sh.actx?.close().catch(() => {});
  if (!silent && !G.active) send({ t: 'screen-stop' });
  L('share', { stop: true, frames: sh.frames });
  if (G.active) grpUpdateControls();
  $('shareBar').classList.add('hidden');
  $('shareStats').textContent = '';
  $('btnScreen').classList.remove('on');
  $('btnScreen').querySelector('span').textContent = 'Экран';
}

async function tuneVideoSender(sender, q) {
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  screenEncodingCodec(p);
  p.encodings[0].maxBitrate = q.kbps * 1000;
  // The source worker owns the FPS limit. Leave headroom here so timer/IPC jitter is not filtered twice.
  p.encodings[0].maxFramerate = SH?.sink?.paced ? q.fps * 1.5 : q.fps;
  p.encodings[0].active = true;
  // CPU VP8 may reduce resolution to preserve cadence; hardware encoders keep a stable size.
  p.degradationPreference = SH?.dbg?.deg || (SCREEN_COMPAT.codec === 'VP8' ? 'maintain-framerate' : 'maintain-resolution');
  try { await sender.setParameters(p); } catch (e) { console.warn('video setParameters', e); }
}

// кодировщик звонка встал (кадры ему даём, а закодированных нет) — выключаем и включаем поток: WebRTC создаст новый
async function kickVideoSender(sender, sh) {
  sh.encResets++;
  L('share', { encoderStuck: true, n: sh.encResets });
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].active = false;
    await sender.setParameters(p);
    await new Promise((r) => setTimeout(r, 150));
    const p2 = sender.getParameters();
    p2.encodings[0].active = true;
    await sender.setParameters(p2);
  } catch (e) { L('share', { kickFailed: e.message }); }
  alo.screenKey();
}

// раз в 10 с — в лог телефона, чтобы по «Отправить лог» было видно, где теряется картинка
function shareLog(sh, info) {
  const now = Date.now();
  if (now - sh.logAt < 10000) return;
  const sec = (now - sh.logAt) / 1000;
  const p = sh.logPrev || { inFrames: 0, decoded: 0, frames: 0 };
  sh.logAt = now;
  sh.logPrev = { inFrames: sh.inFrames, decoded: sh.decoded, frames: sh.frames };
  L('share', {
    st: { ...info, inFps: Math.round((sh.inFrames - p.inFrames) / sec), decFps: Math.round((sh.decoded - p.decoded) / sec), outFps: Math.round((sh.frames - p.frames) / sec),
      skipped: sh.skipped, queueDrops: sh.queueDrops, sinkDrops: sh.sinkDrops, decErrors: sh.decErrors, decStalls: sh.decStalls, encResets: sh.encResets,
      hidden: document.hidden, sourceFormat: sh.frameFormat || null, pacing: sh.sink.stats || null },
  });
}

// как у ПК: размер, fps и причина, если тормозит, — ПК покажет «⚠ У друга: …»
let shLastBytes = 0, shLastTs = 0;
// Group calls use one sender per peer and do not populate S.tx.
// Keep the capture/pacer and encoder counters in the same diagnostic record.
async function groupShareStats(sh) {
  sh.groupEncoderSamples ||= new Map();
  const peers = await Promise.all([...G.peers.values()].filter(p => p.connected && p.vtx?.sender.track).map(async p => {
    const report = [...(await p.vtx.sender.getStats()).values()];
    const video = report.find(r => r.type === 'outbound-rtp' && r.kind === 'video');
    if (!video) return null;
    const previous = sh.groupEncoderSamples.get(p.id), at = video.timestamp;
    const fps = previous && at > previous.at && video.framesEncoded >= previous.frames ?
      (video.framesEncoded - previous.frames) * 1000 / (at - previous.at) : (video.framesPerSecond || 0);
    sh.groupEncoderSamples.set(p.id, { at, frames: video.framesEncoded });
    return { view: p.view || 'full', fps: Number(fps.toFixed(1)), frames: video.framesEncoded,
      sent: video.framesSent, bytes: video.bytesSent, w: video.frameWidth, h: video.frameHeight,
      reason: video.qualityLimitationReason, encodeSeconds: video.totalEncodeTime,
      encoder: video.encoderImplementation, software: video.powerEfficientEncoder === false || /libvpx/i.test(video.encoderImplementation || ''),
      nack: video.nackCount, pli: video.pliCount };
  }));
  if (SH !== sh || !G.share) return;
  const now = performance.now(), fed = sh.frames;
  const previous = sh.groupFeed;
  const feedFps = previous && now > previous.at ? (fed - previous.frames) * 1000 / (now - previous.at) : 0;
  sh.groupFeed = { at: now, frames: fed };
  const samples = peers.filter(Boolean);
  if (SCREEN_COMPAT.codec === 'VP8' && grpUpdateSoftwareBudget(G.share, samples, feedFps)) {
    await grpTuneAll();
    L('share', { softwareBudget: true, fullViewers: samples.filter(p => p.view === 'full').length });
  }
  shareLog(sh, { group: true, softwareBudget: !!G.share?.softwareBudget, peers: samples });
}

async function shareStats(sh) {
  if (SH !== sh) return;
  if (G.active) { try { await groupShareStats(sh); } catch { /* peer may leave during the sample */ } return; }
  if (!S.tx) return;
  if (sh.dbg.noWatch) return;
  try {
    const rep = await S.tx.video.sender.getStats();
    let bwe = null, rtt = null;
    rep.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
        if (r.availableOutgoingBitrate) bwe = Number((r.availableOutgoingBitrate / 1e6).toFixed(1));
        if (r.currentRoundTripTime != null) rtt = Math.round(r.currentRoundTripTime * 1000);
      }
    });
    rep.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
      let mbps = 0;
      if (shLastTs && r.timestamp > shLastTs) mbps = ((r.bytesSent - shLastBytes) * 8) / ((r.timestamp - shLastTs) / 1000) / 1e6;
      shLastBytes = r.bytesSent; shLastTs = r.timestamp;
      const hw = r.powerEfficientEncoder === true ? 'аппаратный' : (r.powerEfficientEncoder === false ? 'программный' : '');
      const info = { w: r.frameWidth || 0, h: r.frameHeight || 0, fps: Math.round(r.framesPerSecond || 0), mbps: Number(mbps.toFixed(1)), reason: r.qualityLimitationReason || 'none', enc: r.encoderImplementation || '', hw, gpu: null };
      $('shareStats').textContent = info.w ? `${info.w}×${info.h} · ${info.fps} fps · ${info.mbps} Мбит/с` : '';
      send({ t: 'sstats', ...info });
      // сторож кодировщика: за 4 с отдали ему кадры, а закодированных не прибавилось — перезапуск
      const enc = r.framesEncoded ?? -1;
      const fed = sh.frames - (sh.fedAt ?? sh.frames);
      sh.fedAt = sh.frames;
      if (enc >= 0 && enc === sh.lastEnc && fed > 5) { if (++sh.encStuck >= 2) { sh.encStuck = 0; kickVideoSender(S.tx.video.sender, sh); } } else sh.encStuck = 0;
      sh.lastEnc = enc;
      // Программному кодировщику разрешаем уменьшать картинку ради плавности.
      // Аппаратному оставляем постоянный размер, чтобы не перезапускать его при адаптации.
      if ((r.powerEfficientEncoder === false || r.qualityLimitationReason === 'cpu' || SCREEN_COMPAT.codec === 'VP8') && !sh.degBalanced) {
        sh.degBalanced = true;
        const p = S.tx.video.sender.getParameters();
        p.degradationPreference = SCREEN_COMPAT.codec === 'VP8' ? 'maintain-framerate' : 'balanced';
        S.tx.video.sender.setParameters(p).then(() => L('share', { degradation: p.degradationPreference, enc: info.enc })).catch(() => {});
      }
      shareLog(sh, { ...info, bwe, rtt, nack: r.nackCount, pli: r.pliCount });
    });
  } catch { /* */ }
}

/* =========================================================
   Поверх стрима друга (как у ПК): указка, рисование, реакции, управление его компьютером.
   Сообщения те же: 'ptr' / 'ptr-off' / 'draw' / 'draw-clear' / 'react' по каналу duo; управление —
   'ctl-req' → 'ctl-grant' / 'ctl-deny' / 'ctl-end' / 'ctl-stop', команды массивами по ctl (надёжно) и ctlu (быстро):
   ['m', x, y] (0..1), ['b', кнопка, 1/0], ['w', dy, dx], ['k', code, 1/0], ['p', …геймпад], ['hb'] раз в секунду.
   Палец: касание — клик, долгое — правый клик, провести — перетащить с зажатой кнопкой, двумя пальцами — прокрутка.
   ========================================================= */
const REACTIONS = ['😂', '🔥', '👍', '❤️', '😮', '👏', '💀', '🤡'];
const COLORS = ['#ff3c50', '#ffd23c', '#3ddc84', '#3cc8ff', '#ffffff', '#ff8a1f', '#b06bff', '#111111'];
/* Кисти и фигуры (как у ПК 1.17). Фигура уходит другу обычной линией из точек — её видят и старые версии.
   w — толщина, hl — маркер (полупрозрачный); старые версии рисуют их обычной линией */
const DRAW_KINDS = [
  { id: 'pen', icon: '✏️', name: 'Карандаш' }, { id: 'hl', icon: '🖍', name: 'Маркер' },
  { id: 'line', icon: '➖', name: 'Линия' }, { id: 'arrow', icon: '↗', name: 'Стрелка' },
  { id: 'rect', icon: '▭', name: 'Прямоугольник' }, { id: 'oval', icon: '◯', name: 'Овал' },
];
const DRAW_SIZES = [{ w: 3, name: 'Тонкая' }, { w: 5, name: 'Средняя' }, { w: 9, name: 'Толстая' }];
// точки фигуры от a до b (доли экрана); asp — ширина/высота картинки, чтобы стрелка не сплющивалась
function shapePts(kind, a, b, asp = 16 / 9) {
  const [x1, y1] = a, [x2, y2] = b;
  if (kind === 'rect') return [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
  if (kind === 'oval') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    return Array.from({ length: 49 }, (_, i) => { const t = (i / 48) * Math.PI * 2; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; });
  }
  if (kind === 'arrow') {
    const dx = (x2 - x1) * asp, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-6;
    const h = Math.min(0.04, len * 0.35), ang = Math.atan2(dy, dx);
    const wing = (s) => [x2 - (h * Math.cos(ang + s)) / asp, y2 - h * Math.sin(ang + s)];
    return [a, b, wing(0.5), b, wing(-0.5)];
  }
  return [a, b];
}
const tools = { mode: null, color: COLORS[0], kind: 'pen', w: 5, stroke: null, flushT: null, ptrLast: 0, local: new Map(), raf: 0, myPtr: null };

// меню кисти: вид, толщина, цвет (открывается кнопкой цвета в режиме рисования)
function buildDrawMenu() {
  const box = $('drawMenu');
  if (!box) return;
  box.replaceChildren();
  const add = (cls, on, title, fill, pick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbtn ' + cls + (on ? ' on' : '');
    b.title = title;
    fill(b);
    b.onclick = (e) => { e.stopPropagation(); pick(); buildDrawMenu(); updateToolbar(); };
    box.appendChild(b);
  };
  for (const k of DRAW_KINDS) add('', k.id === tools.kind, k.name, (b) => { b.textContent = k.icon; }, () => { tools.kind = k.id; });
  const sep = () => { const s = document.createElement('span'); s.className = 'tsep'; box.appendChild(s); };
  sep();
  for (const z of DRAW_SIZES) add('', z.w === tools.w, z.name, (b) => { const i = document.createElement('i'); i.className = 'tsize'; i.style.height = z.w + 'px'; b.appendChild(i); }, () => { tools.w = z.w; });
  sep();
  for (const c of COLORS) add('color', c === tools.color, 'Цвет', (b) => { b.style.background = c; }, () => { tools.color = c; });
  $('toolDraw').textContent = DRAW_KINDS.find((k) => k.id === tools.kind)?.icon || '✏️';
}
const CV = { state: 'off', perm: {}, link: null, hbTimer: null, reqTimer: null, padTimer: null, lastPad: '', lastPadSent: 0, hadPad: false, keys: new Set() };
const n4 = (x) => Math.round(x * 10000) / 10000;

// с кем идёт управление: в звонке на двоих — с собеседником (CV.link = null), в группе — с участником (как CV.link у ПК)
function ctlSend(a, fast) {
  if (CV.link) { CV.link.raw(a, fast); return; }
  const ch = fast ? S.cdu : S.cdc;
  try { if (ch?.readyState === 'open') ch.send(JSON.stringify(a)); } catch { /* */ }
}
const ctlSig = (o) => (CV.link ? CV.link.sig(o) : send(o));
const ctlNick = () => (CV.link ? CV.link.nick() : S.friendNick);
const ctlSys = (text) => sysMsg(text, CV.link ? G.conv : S.callConv);

// где на экране настоящая картинка видео (без чёрных полос)
function videoRect() {
  const v = $('remoteScreen');
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s, h = vh * s;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}
function normPt(e) {
  const r = videoRect();
  return [Math.max(0, Math.min(1, (e.clientX - r.x) / r.w)), Math.max(0, Math.min(1, (e.clientY - r.y) / r.h))];
}

function setTool(mode) {
  if (CV.state === 'on') return;
  tools.mode = tools.mode === mode ? null : mode;
  if (tools.mode !== 'ptr') { send({ t: 'ptr-off' }); tools.myPtr = null; kickLocal(); }
  $('reactBar').classList.add('hidden');
  if (tools.mode !== 'draw') $('drawMenu').classList.add('hidden');
  updateToolbar();
}

function updateToolbar() {
  const fp = S.friendPerm || { draw: true, react: false, ctl: true };
  const controlling = CV.state === 'on';
  const set = (id, on, disabled) => { const b = $(id); b.classList.toggle('on', !!on); b.disabled = !!disabled; };
  set('toolPtr', tools.mode === 'ptr', !fp.draw || controlling);
  set('toolDraw', tools.mode === 'draw', !fp.draw || controlling);
  set('toolClear', false, !fp.draw || controlling);
  set('toolReact', !$('reactBar').classList.contains('hidden'), !fp.react);
  set('toolImg', false, !fp.react || controlling);
  $('toolColor').style.background = tools.color;
  $('toolColor').classList.toggle('hidden', tools.mode !== 'draw');
  const cb = $('toolCtl');
  cb.classList.toggle('on', controlling);
  cb.textContent = controlling ? '⛔' : CV.state === 'req' ? '⏳' : '🎮';
  cb.disabled = fp.ctl === false && !controlling;
  for (const id of ['toolKb', 'toolKeys']) $(id).classList.toggle('hidden', !(controlling && CV.perm.kb));
  // при управлении рисование и картинки недоступны — прячем, чтобы влезли кнопки управления
  for (const id of ['toolPtr', 'toolDraw', 'toolClear', 'toolImg']) $(id).classList.toggle('hidden', controlling);
  for (const id of ['toolReact', 'toolClip']) if (CV.link) $(id).classList.add('hidden');
  if (controlling) { $('toolColor').classList.add('hidden'); $('drawMenu').classList.add('hidden'); }
  $('toolColor').classList.toggle('on', !$('drawMenu').classList.contains('hidden'));
  $('toolTouchpad').classList.toggle('hidden', !(controlling && CV.perm.mouse));
  $('toolTouchpad').classList.toggle('on', !!CV.touchpad);
  $('toolVpad').classList.toggle('hidden', !(controlling && CV.perm.pad));
  $('toolVpad').classList.toggle('on', VP.on);
  if (!(controlling && CV.perm.kb)) $('keysBar').classList.add('hidden');
  const active = !!tools.mode || controlling;
  $('inputLayer').classList.toggle('active', active);
  $('inputLayer').dataset.mode = controlling ? 'ctl' : (tools.mode || '');
  $('remoteScreenWrap').classList.toggle('tools-on', active);
}

/* ---------- у себя: свои штрихи (у друга их рисует его оверлей) ---------- */
function drawLocal() {
  tools.raf = 0;
  const c = $('drawLayer');
  const box = $('screenView');
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(box.clientWidth * dpr) || c.height !== Math.round(box.clientHeight * dpr)) {
    c.width = Math.round(box.clientWidth * dpr); c.height = Math.round(box.clientHeight * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  const br = box.getBoundingClientRect();
  const r = videoRect();
  const X = (x) => r.x - br.left + x * r.w, Y = (y) => r.y - br.top + y * r.h;
  const now = Date.now();
  let alive = false;
  for (const [id, s] of tools.local) {
    const age = s.done ? now - s.ts : 0;
    const a = age < 2500 ? 1 : 1 - (age - 2500) / 1500;
    if (a <= 0) { tools.local.delete(id); continue; }
    alive = true;
    g.globalAlpha = a * (s.hl ? 0.45 : 1); g.strokeStyle = s.c; g.lineWidth = s.w || 4; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    s.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    if (s.pts.length === 1) g.lineTo(X(s.pts[0][0]) + 0.1, Y(s.pts[0][1]));
    g.stroke();
  }
  g.globalAlpha = 1;
  if (tools.myPtr && now - tools.myPtr.ts < 1500) {
    alive = true;
    g.fillStyle = 'rgba(255,60,80,.3)'; g.beginPath(); g.arc(X(tools.myPtr.x), Y(tools.myPtr.y), 14, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff3c50'; g.beginPath(); g.arc(X(tools.myPtr.x), Y(tools.myPtr.y), 6, 0, Math.PI * 2); g.fill();
  }
  if (alive) tools.raf = requestAnimationFrame(drawLocal);
}
function kickLocal() { if (!tools.raf) tools.raf = requestAnimationFrame(drawLocal); }

function flushStroke(done) {
  const st = tools.stroke;
  if (!st) return;
  let pts = st.pending.splice(0);
  if (st.shape) { if (!done) return; pts = tools.local.get(st.id)?.pts || [st.a]; } // фигура уходит целиком, когда отпустил
  if (pts.length || done) send({ t: 'draw', id: st.id, c: st.c, w: st.w, hl: st.hl ? 1 : 0, pts: pts.slice(0, 300), done: !!done });
  if (done) tools.stroke = null;
}

function floatReaction(e) {
  const el = document.createElement('div');
  el.className = 'react-float';
  el.textContent = e;
  el.style.left = (10 + Math.random() * 80) + '%';
  $('screenView').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
let reactLast = [];
function sendReaction(e) {
  if (!(S.friendPerm?.react)) return;
  const now = Date.now();
  reactLast = reactLast.filter((t) => now - t < 2000);
  if (reactLast.length >= 6) return; // не больше 6 за 2 секунды, как у ПК
  reactLast.push(now);
  send({ t: 'react', e });
  floatReaction(e);
}

/* ---------- Картинка, гифка или видео поверх экрана друга (как у ПК 1.13) ----------
   Файл с p:'screenimg' / 'screenvid' и местом pl {x, y — центр, w — ширина, доли экрана}; у видео ещё vol и snd.
   Друг (если включил у себя «картинки на экран») показывает его поверх своего экрана; видео — до 1 минуты и 100 МБ,
   он отвечает 'svid-play' (началось — показываем у себя там же) или 'svid-no'. */
const IMG_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const VID_TYPES = /^video\/(mp4|webm|quicktime|x-matroska|ogg)$/;
const SVID_MAX = 512 * 1024 * 1024;
const SVID_SEC = 6 * 3600;
let placer = null; // { file, url, x, y, w, aspect, el, vid: { dur, snd, vol } | null }
let svidOut = null;

function probeVideo(file) {
  return new Promise((resolve) => {
    if (!S.friendPerm?.vid) { toast(`У ${S.friendNick} старая версия alloconnect — видео на экран появится, когда он обновится`); resolve(null); return; }
    if (svidOut && !svidOut.echo) { toast('Подожди — предыдущее видео ещё отправляется'); resolve(null); return; }
    if (/^audio\//.test(file.type) && !S.friendPerm?.mediaLong) { toast('Для звука на демонстрации другу нужно обновить alloconnect'); resolve(null); return; }
    if (file.size > SVID_MAX) { toast('Медиа больше 512 МБ'); resolve(null); return; }
    if (file.size > 100 * 1048576 && !S.friendPerm?.mediaLong) { toast('Для большого медиа другу нужно обновить alloconnect'); resolve(null); return; }
    if (file.size > 100 * 1048576 && !confirm('Файл больше 100 МБ. Отправить его другу?')) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = (res, msg) => { clearTimeout(t); v.removeAttribute('src'); v.load(); if (msg) toast(msg); if (!res) URL.revokeObjectURL(url); resolve(res); };
    const t = setTimeout(() => done(null, 'Не получилось открыть видео'), 8000);
    v.onloadedmetadata = async () => {
      // у роликов, записанных браузером (webm), длина в заголовке не записана — узнаём, перемотав в конец
      if (v.duration === Infinity && !v.__seek) { v.__seek = true; v.ontimeupdate = () => { v.ontimeupdate = null; v.currentTime = 0; v.onloadedmetadata(); }; v.currentTime = 1e9; return; }
      const dur = v.duration;
      if (!/^audio\//.test(file.type) && (!v.videoWidth || !v.videoHeight)) { done(null, 'В файле нет видео, которое можно показать'); return; }
      if (!S.friendPerm?.mediaLong && dur > 60.5) { done(null, 'Для видео длиннее минуты другу нужно обновить alloconnect'); return; }
      if (!Number.isFinite(dur) || dur > SVID_SEC + 0.5) { done(null, Number.isFinite(dur) ? `Медиа длиннее 6 часов` : 'Не удалось определить длительность медиа'); return; }
      const prepared = /webm/i.test(file.type) ? await webmWithDuration(file,dur) : file;
      done({ url, dur, file: prepared, aspect: /^audio\//.test(file.type) ? 0.2 : v.videoHeight / v.videoWidth });
    };
    v.onerror = () => done(null, 'Этот формат видео не поддерживается — лучше mp4 (H.264) или webm');
    v.src = url;
  });
}

function startPlacement(file) {
  if (!file || $('remoteScreenWrap').classList.contains('hidden')) return;
  if (!S.friendPerm?.react) { toast(`${S.friendNick} не включил картинки и видео на экран в настройках`); return; }
  if (/^audio\//.test(file.type || '') || VID_TYPES.test(file.type || '') || (!file.type && /\.(mp4|webm|mov|mkv)$/i.test(file.name || ''))) {
    probeVideo(file).then((info) => { if (info && !$('remoteScreenWrap').classList.contains('hidden')) openPlacer(info.file || file, info); else if (info) URL.revokeObjectURL(info.url); });
    return;
  }
  if (!IMG_TYPES.test(file.type)) { toast('Нужна картинка, гифка или видео (png, jpg, gif, webp, mp4, webm)'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('Картинка больше 8 МБ — выбери поменьше'); return; }
  openPlacer(file, null);
}

function openPlacer(file, vinfo) {
  cancelPlacement();
  if (tools.mode) setTool(tools.mode);
  const url = vinfo ? vinfo.url : URL.createObjectURL(file);
  const o = settings();
  const el = document.createElement('div');
  el.className = 'placer';
  const media = vinfo ? `<video src="${url}" muted loop playsinline autoplay></video>` : `<img src="${url}" alt="">`;
  const vidCtl = vinfo
    ? `<label class="placer-snd"><input type="checkbox" class="placer-sound"> 🔊</label><input type="range" class="placer-vol" min="0" max="100" step="5"><b class="placer-volval small"></b>`
    : '';
  el.innerHTML = `<div class="placer-box">${media}</div>` +
    `<div class="placer-bar"><span class="placer-hint small">Двигай пальцем · размер — ползунок</span><input type="range" class="placer-size" min="5" max="90" step="1">` +
    `<button type="button" class="btn small-btn placer-rl" title="Повернуть влево">⟲</button><button type="button" class="btn small-btn placer-rr" title="Повернуть вправо">⟳</button>` +
    (vinfo ? '' : `<button type="button" class="btn small-btn placer-bg" title="Убрать однотонный фон. Ещё раз — вернуть">✂ Фон</button>`) + `${vidCtl}<label class="placer-snd"><input type="checkbox" class="placer-frame"> Рамка</label><label class="placer-snd"><input type="checkbox" class="placer-nick"> Имя</label>` +
    `<button type="button" class="btn primary small-btn placer-send">Отправить</button><button type="button" class="btn small-btn placer-cancel">✕</button></div>`;
  placer = { file, url, x: 0.5, y: 0.35, w: vinfo ? 0.35 : 0.3, r: 0, aspect: vinfo ? vinfo.aspect : 1, el,
    vid: vinfo ? { dur: vinfo.dur, snd: o.svidSound !== false, vol: Number.isFinite(o.svidVol) ? o.svidVol : 70 } : null };
  $('screenView').appendChild(el);
  el.querySelector('.placer-frame').checked=o.mediaFrame!==false;
  el.querySelector('.placer-nick').checked=o.mediaNick!==false;
  if (!vinfo) {
    const img = el.querySelector('img');
    img.onload = () => { if (placer?.el === el) { placer.aspect = img.naturalHeight / Math.max(1, img.naturalWidth); layoutPlacer(); } };
  } else applyPreviewVol();
  const box = el.querySelector('.placer-box');
  let drag = null;
  box.addEventListener('pointerdown', (e) => { e.preventDefault(); try { box.setPointerCapture(e.pointerId); } catch { /* */ } drag = { sx: e.clientX, sy: e.clientY, x: placer.x, y: placer.y }; });
  box.addEventListener('pointermove', (e) => {
    if (!drag || !placer) return;
    const r = videoRect();
    placer.x = drag.x + (e.clientX - drag.sx) / r.w;
    placer.y = drag.y + (e.clientY - drag.sy) / r.h;
    layoutPlacer();
  });
  const end = () => { drag = null; };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  el.querySelector('.placer-size').addEventListener('input', (e) => { placer.w = Number(e.target.value) / 100; layoutPlacer(); });
  if (placer.vid) {
    el.querySelector('.placer-sound').addEventListener('change', (e) => { placer.vid.snd = e.target.checked; applyPreviewVol(); });
    el.querySelector('.placer-vol').addEventListener('input', (e) => { placer.vid.vol = Number(e.target.value); applyPreviewVol(); });
  }
  // поворот по 90° (ПК 1.21: угол уходит другу в pl.r, −180…180)
  const rot = (deg) => { let r = ((Math.round(deg) + 180) % 360 + 360) % 360 - 180; if (r === -180) r = 180; placer.r = r; layoutPlacer(); };
  el.querySelector('.placer-rl').onclick = () => rot(placer.r - 90);
  el.querySelector('.placer-rr').onclick = () => rot(placer.r + 90);
  // ✂ Фон (ПК 1.21): однотонный фон по краям — прозрачный (картинки и гифки); второе нажатие — вернуть исходник
  const bgBtn = el.querySelector('.placer-bg');
  if(bgBtn){const mode=document.createElement('select');mode.className='placer-bg-mode';mode.setAttribute('aria-label','Способ удаления фона');for(const [value,text] of [['normal','Обычный фон'],['person','Нейросеть: человек'],['object','Нейросеть: предмет']]){const o=document.createElement('option');o.value=value;o.textContent=text;mode.appendChild(o);}bgBtn.before(mode);}
  if (bgBtn) bgBtn.onclick = async () => {
    const p = placer;
    if (!p || p.bgBusy) return;
    if (p.orig) {
      URL.revokeObjectURL(p.url);
      Object.assign(p, { file: p.orig.file, url: URL.createObjectURL(p.orig.file), orig: null });
      el.querySelector('img').src = p.url;
      bgBtn.classList.remove('on');
      return;
    }
    p.bgBusy = true;
    bgBtn.textContent = '✂ …';
    try {
      const kind = window.sniffImage?.(new Uint8Array(await p.file.slice(0, 256 * 1024).arrayBuffer()));
      const type = kind?.mime || p.file.type;
      const mode=el.querySelector('.placer-bg-mode')?.value||'normal';
      if(mode!=='normal')await aiPrepare(mode);
      let r = mode==='normal' ? await window.removeBg?.(p.file,type) : await window.removeBgAi?.(p.file,type,mode,(i,n)=>{bgBtn.textContent=i+'/'+n;});
      if (mode==='normal' && r && r.blob.size > 7.5 * 1024 * 1024) r = await window.removeBg?.(p.file, type, 40, 360); // у друга лимит 8 МБ
      if (placer !== p) return;
      if (!r || r.share < 0.02) { toast(mode==='normal'?'Однотонного фона по краям не нашлось':'Нейросеть не выделила фон на этом изображении'); return; }
      if(r.blob.size>8*1024*1024){toast('После обработки файл больше 8 МБ. Выбери изображение поменьше');return;}
      const name = (p.file.name || 'картинка').replace(/\.[^.]+$/, '') + (r.blob.type === 'image/gif' ? '.gif' : '.png');
      p.orig = { file: p.file };
      p.file = new File([r.blob], name, { type: r.blob.type });
      URL.revokeObjectURL(p.url);
      p.url = URL.createObjectURL(p.file);
      el.querySelector('img').src = p.url;
      bgBtn.classList.add('on');
      L('screenimg', { bgRemoved: Math.round(r.share * 100) });
    } catch (e) { toast('Не получилось убрать фон: ' + (e.message || e)); } finally { p.bgBusy = false; bgBtn.textContent = '✂ Фон'; }
  };
  el.querySelector('.placer-send').onclick = commitPlacement;
  el.querySelector('.placer-cancel').onclick = cancelPlacement;
  layoutPlacer();
}

function applyPreviewVol() {
  if (!placer?.vid) return;
  const { snd, vol } = placer.vid;
  placer.el.querySelector('.placer-sound').checked = snd;
  const r = placer.el.querySelector('.placer-vol');
  r.value = String(vol);
  r.disabled = !snd;
  placer.el.querySelector('.placer-volval').textContent = snd ? vol + '%' : 'без звука';
}

function layoutPlacer() {
  if (!placer) return;
  const r = videoRect();
  const br = $('screenView').getBoundingClientRect();
  if (!r.w || !r.h) return;
  const { width: wpx, height: hpx, x, y } = mediaPlacement(r, placer, placer.aspect);
  placer.x = x / r.w;
  placer.y = y / r.h;
  const box = placer.el.querySelector('.placer-box');
  Object.assign(box.style, { left: (r.x - br.left + x - wpx / 2) + 'px', top: (r.y - br.top + y - hpx / 2) + 'px', width: wpx + 'px', height: hpx + 'px', rotate: placer.r ? placer.r + 'deg' : '' });
  placer.el.querySelector('.placer-size').value = String(Math.round(placer.w * 100));
}

function cancelPlacement() {
  if (!placer) return;
  const v = placer.el.querySelector('video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  placer.el.remove();
  URL.revokeObjectURL(placer.url);
  placer = null;
}

// у себя показываем там же, где увидит друг (его оверлей в стрим не попадает)
function placeEcho(box, pl, aspect) {
  const r = videoRect();
  const br = $('screenView').getBoundingClientRect();
  const { width: wpx, height: hpx, x, y } = mediaPlacement(r, pl, aspect);
  Object.assign(box.style, { left: (r.x - br.left + x - wpx / 2) + 'px', top: (r.y - br.top + y - hpx / 2) + 'px', width: wpx + 'px', height: hpx + 'px', rotate: pl.r ? pl.r + 'deg' : '' });
}

function commitPlacement() {
  if (!placer) return;
  const p = placer;
  const frame=p.el.querySelector('.placer-frame').checked,nick=p.el.querySelector('.placer-nick').checked;
  store.set('settings',{...settings(),mediaFrame:frame,mediaNick:nick});
  const pl = { x: n4(p.x), y: n4(p.y), w: n4(p.w), frame,nick,...(p.r ? { r: p.r } : {}) };
  const pv = p.el.querySelector('video');
  if (pv) { pv.pause(); pv.removeAttribute('src'); pv.load(); }
  p.el.remove();
  placer = null;
  if (!S.friendPerm?.react || !S.fileChan) { URL.revokeObjectURL(p.url); toast(`${S.friendNick} выключил картинки на экран`); return; }
  if (p.vid) { sendScreenVideo(p, pl); return; }
  S.fileChan.queue([p.file], 'screenimg', { pl });
  L('screenimg', { sent: true, w: pl.w });
  const box = document.createElement('div');
  box.className = 'screenimg-echo';
  const im = document.createElement('img');
  im.src = p.url;
  box.appendChild(im);
  $('screenView').appendChild(box);
  placeEcho(box, pl, p.aspect);
  setTimeout(() => { box.remove(); URL.revokeObjectURL(p.url); }, 6500);
}

function sendScreenVideo(p, pl) {
  const vol = p.vid.vol / 100;
  const snd = p.vid.snd && p.vid.vol > 0;
  store.set('settings', { ...settings(), svidVol: p.vid.vol, svidSound: p.vid.snd });
  const status = document.createElement('div');
  status.className = 'svid-status';
  status.textContent = '🎬 Видео → ' + S.friendNick + ': 0%';
  $('screenView').appendChild(status);
  const size = p.file.size;
  svidOut = { fid: crypto.getRandomValues(new Uint32Array(1))[0], url: p.url, aspect: p.aspect, pl, vol, snd, status, echo: null };
  const my = svidOut;
  const ui = {
    progress: (n) => { if (svidOut === my) status.textContent = `🎬 Видео → ${S.friendNick}: ${Math.floor((100 * n) / Math.max(1, size))}%`; },
    done: () => {
      if (svidOut !== my) return;
      status.textContent = `🎬 Видео у ${S.friendNick}, запускается…`;
      setTimeout(() => { if (svidOut === my && !my.echo) { status.remove(); URL.revokeObjectURL(my.url); svidOut = null; } }, 15000);
    },
    fail: (msg) => { if (svidOut !== my) return; status.remove(); URL.revokeObjectURL(my.url); svidOut = null; toast('Видео не отправилось: ' + msg); },
  };
  S.fileChan.queue([p.file], 'screenvid', { fid:my.fid, pl, vol: Math.round(vol * 100) / 100, snd, ui });
  L('screenvid', { sent: true, w: pl.w, mb: Math.round(size / 1048576), snd });
}

function startVideoEcho() {
  const my = svidOut;
  if (!my || my.echo) return;
  my.status.remove();
  const box = document.createElement('div');
  box.className = 'screenimg-echo';
  const v = document.createElement('video');
  v.src = my.url;
  v.playsInline = true;
  v.volume = my.vol;
  v.muted = !my.snd || S.deafened;
  box.appendChild(v);
  $('screenView').appendChild(box);
  placeEcho(box, my.pl, my.aspect);
  my.echo = box;
  const end = () => { if (!box.isConnected) return; v.pause(); box.remove(); URL.revokeObjectURL(my.url); if (svidOut === my) svidOut = null; };
  my.end=end;
  v.onended = end;
  v.onerror = end;
  v.play().catch(() => { v.muted = true; v.play().catch(end); });
  setTimeout(end, (SVID_SEC + 2) * 1000);
}

function onVideoRefused(why) {
  if (!svidOut) return;
  svidOut.status.remove();
  URL.revokeObjectURL(svidOut.url);
  svidOut = null;
  const txt = { off: `${S.friendNick} выключил картинки и видео на экран`, big: 'Видео слишком большое для друга', fmt: `У ${S.friendNick} это видео не открылось`, long: 'Видео длиннее минуты', busy: `${S.friendNick} сейчас не стримит` }[why];
  toast(txt || 'Друг не принял видео');
}

/* ---------- управление компьютером друга ---------- */
function ctlRequest() {
  if (!CV.link && (!S.connected || $('remoteScreenWrap').classList.contains('hidden'))) return;
  if (CV.state === 'on') { ctlViewStop(true); toast('Управление отдано'); return; }
  if (CV.state === 'req') return;
  CV.state = 'req';
  tools.mode = null;
  if (!CV.link) send({ t: 'ptr-off' });
  ctlSig({ t: 'ctl-req', mouse: true, kb: true, pad: true });
  updateToolbar();
  if (CV.link) grpUpdateTools();
  toast(`Запрос отправлен — ${ctlNick()} должен нажать «Разрешить»`);
  clearTimeout(CV.reqTimer);
  CV.reqTimer = setTimeout(() => { if (CV.state === 'req') { CV.state = 'off'; if (CV.link) { CV.link = null; grpUpdateTools(); } updateToolbar(); toast(`${ctlNick()} не ответил на запрос`); } }, 35000);
}

function ctlViewStart(perm) {
  clearTimeout(CV.reqTimer);
  CV.state = 'on';
  CV.perm = { mouse: !!perm.mouse, kb: !!perm.kb, pad: !!perm.pad };
  tools.mode = null;
  const what = [CV.perm.mouse && 'мышь', CV.perm.kb && 'клавиатура', CV.perm.pad && 'геймпад'].filter(Boolean).join(', ');
  toast(`Управление разрешено: ${what}. Касание — клик, долгое — правый клик, двумя пальцами — прокрутка`);
  ctlSys(`Ты управляешь компьютером ${ctlNick()} (${what})`);
  L('control', { view: 'start', perm: CV.perm });
  CV.hbTimer = setInterval(() => ctlSend(['hb']), 1000);
  if (CV.perm.pad) { CV.hadPad = false; CV.padTimer = setInterval(padPoll, 16); }
  updateToolbar();
}

function ctlViewStop(notify, why) {
  if (CV.state === 'off') return;
  const was = CV.state;
  touchCtl.reset(true);
  for (const code of CV.keys) ctlSend(['k', code, 0]);
  CV.keys.clear();
  if (CV.hadPad) ctlSend(['p', 0, 0, 0, 0, 0, 0, 0]);
  if (notify && was === 'on') ctlSig({ t: 'ctl-stop' });
  CV.state = 'off';
  CV.touchpad = false;
  if (VP.on) setVpad(false);
  clearInterval(CV.hbTimer); clearInterval(CV.padTimer); clearTimeout(CV.reqTimer);
  CV.hbTimer = CV.padTimer = null;
  $('kbInput').blur();
  if (was === 'on') { ctlSys(why ? `Управление закончено: ${why}` : 'Управление закончено'); L('control', { view: 'stop', why }); }
  if (CV.link) grpCtlClose(); // группа: закрыть экран управления, вернуться к плиткам
  updateToolbar();
}

// экранный геймпад: кнопки и стики на экране телефона → тот же отчёт 'p', что у физического геймпада
const VP = { on: false, btn: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
const VP_BTN = [['LB', 0x0100], ['RB', 0x0200], ['Back', 0x0020], ['Start', 0x0010], ['Y', 0x8000], ['X', 0x4000], ['B', 0x2000], ['A', 0x1000],
  ['▲', 0x0001], ['◀', 0x0004], ['▶', 0x0008], ['▼', 0x0002], ['L3', 0x0040], ['R3', 0x0080]];
function buildVpad() {
  const host = $('vpad');
  if (host.childElementCount) return;
  const btn = (label, cls, onDown, onUp) => {
    const b = document.createElement('div');
    b.className = 'vp-btn ' + cls;
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); try { b.setPointerCapture(e.pointerId); } catch { /* */ } b.classList.add('on'); onDown(); try { navigator.vibrate?.(8); } catch { /* */ } });
    const up = (e) => { e.stopPropagation(); if (!b.classList.contains('on')) return; b.classList.remove('on'); onUp(); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    host.appendChild(b);
    return b;
  };
  for (const [name, bit] of VP_BTN) btn(name, 'vp-' + ({ '▲': 'up', '◀': 'left', '▶': 'right', '▼': 'down' }[name] || name), () => { VP.btn |= bit; }, () => { VP.btn &= ~bit; });
  btn('LT', 'vp-LT', () => { VP.lt = 255; }, () => { VP.lt = 0; });
  btn('RT', 'vp-RT', () => { VP.rt = 255; }, () => { VP.rt = 0; });
  for (const side of ['l', 'r']) {
    const st = document.createElement('div');
    st.className = 'vp-stick vp-stick-' + side;
    const knob = document.createElement('i');
    st.appendChild(knob);
    let id = null;
    const set = (e) => {
      const r = st.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
      const d = Math.hypot(dx, dy);
      if (d > 1) { dx /= d; dy /= d; }
      knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
      VP[side + 'x'] = Math.round(dx * 32767);
      VP[side + 'y'] = Math.round(-dy * 32767);
    };
    st.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); id = e.pointerId; try { st.setPointerCapture(id); } catch { /* */ } set(e); });
    st.addEventListener('pointermove', (e) => { if (e.pointerId === id) { e.stopPropagation(); set(e); } });
    const up = (e) => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; VP[side + 'x'] = 0; VP[side + 'y'] = 0; };
    st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
    host.appendChild(st);
  }
}
function setVpad(on) {
  VP.on = on && CV.state === 'on' && !!CV.perm.pad;
  if (VP.on) { buildVpad(); if (!$('remoteScreenWrap').classList.contains('fs')) setFullscreen(true); }
  else { Object.assign(VP, { btn: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 }); $('vpad')?.querySelectorAll('.on').forEach((b) => b.classList.remove('on')); }
  $('vpad').classList.toggle('hidden', !VP.on);
  $('remoteScreenWrap').classList.toggle('vpad-on', VP.on);
  updateToolbar();
}

// геймпад, подключённый к телефону (Bluetooth/USB) — как у ПК, раскладка Xbox
function padPoll() {
  if (VP.on) {
    const rep = [VP.btn, VP.lt, VP.rt, VP.lx, VP.ly, VP.rx, VP.ry];
    const key = rep.join(',');
    if (key !== CV.lastPad || Date.now() - CV.lastPadSent > 100) { ctlSend(['p', ...rep], true); CV.lastPad = key; CV.lastPadSent = Date.now(); }
    CV.hadPad = true;
    return;
  }
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  const p = pads.find((x) => x.mapping === 'standard' && x.connected) || pads.find((x) => x.connected);
  if (!p) {
    if (CV.hadPad) { ctlSend(['p', 0, 0, 0, 0, 0, 0, 0]); CV.hadPad = false; CV.lastPad = ''; }
    return;
  }
  if (!CV.hadPad) { CV.hadPad = true; toast(`Геймпад «${p.id.replace(/\(.*\)/, '').trim().slice(0, 40)}» передаётся другу`); }
  const B = (i) => !!p.buttons[i]?.pressed;
  const MAP = [[0, 0x1000], [1, 0x2000], [2, 0x4000], [3, 0x8000], [4, 0x0100], [5, 0x0200], [8, 0x0020], [9, 0x0010], [10, 0x0040], [11, 0x0080], [12, 0x0001], [13, 0x0002], [14, 0x0004], [15, 0x0008], [16, 0x0400]];
  let btn = 0;
  for (const [i, bit] of MAP) if (B(i)) btn |= bit;
  const tr = (i) => Math.round(Math.max(0, Math.min(1, p.buttons[i]?.value || 0)) * 255);
  const ax = (i, inv) => Math.round(Math.max(-1, Math.min(1, p.axes[i] || 0)) * (inv ? -32767 : 32767));
  const rep = [btn, tr(6), tr(7), ax(0), ax(1, true), ax(2), ax(3, true)];
  const key = rep.join(',');
  if (key !== CV.lastPad || Date.now() - CV.lastPadSent > 100) {
    ctlSend(['p', ...rep], true);
    CV.lastPad = key;
    CV.lastPadSent = Date.now();
  }
}

// палец → мышь
// тачпад (как «Захват мыши» у ПК — для игр, где мышь крутит камеру): палец двигает мышь ПК на столько же,
// касание — клик там, где курсор, долгое — правый, двойное касание и вести — с зажатой кнопкой, двумя пальцами — прокрутка
const PAD_SENS = 2.5;
const touchpad = () => CV.touchpad && CV.state === 'on';
const touchCtl = {
  pts: new Map(), // pointerId → { x, y, x0, y0 }
  mode: null,     // null | 'pending' | 'drag' | 'scroll' | 'done' | 'rel' | 'reldrag'
  timer: null, lastMid: null, moveQ: null, raf: 0, rel: [0, 0], lastTap: 0,
  down(e) {
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY });
    if (this.pts.size === 1 && touchpad()) {
      const dbl = Date.now() - this.lastTap < 300;
      this.mode = dbl ? 'reldrag' : 'pending';
      clearTimeout(this.timer);
      if (dbl) { ctlSend(['b', 0, 1]); return; }
      this.timer = setTimeout(() => {
        if (this.mode !== 'pending') return;
        this.mode = 'done';
        ctlSend(['b', 1, 1]); ctlSend(['b', 1, 0]);
        try { navigator.vibrate?.(20); } catch { /* */ }
      }, 550);
      return;
    }
    if (this.pts.size === 2 && touchpad()) {
      clearTimeout(this.timer);
      if (this.mode === 'reldrag') ctlSend(['b', 0, 0]);
      this.mode = 'scroll';
      this.lastMid = this.mid();
      return;
    }
    if (this.pts.size === 1) {
      this.mode = 'pending';
      this.start = normPt(e).map(n4);
      clearTimeout(this.timer);
      // долгое нажатие на месте — правый клик
      this.timer = setTimeout(() => {
        if (this.mode !== 'pending') return;
        this.mode = 'done';
        ctlSend(['m', ...this.start]); ctlSend(['b', 1, 1]); ctlSend(['b', 1, 0]);
        try { navigator.vibrate?.(20); } catch { /* */ }
      }, 550);
    } else if (this.pts.size === 2) {
      // второй палец — прокрутка (если уже тащили — сначала отпускаем кнопку)
      clearTimeout(this.timer);
      if (this.mode === 'drag') ctlSend(['b', 0, 0]);
      this.mode = 'scroll';
      this.lastMid = this.mid();
    }
  },
  mid() { const a = [...this.pts.values()]; return [a.reduce((s, p) => s + p.x, 0) / a.length, a.reduce((s, p) => s + p.y, 0) / a.length]; },
  move(e) {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (touchpad() && this.mode !== 'scroll') {
      if (this.mode === 'pending' && Math.hypot(p.x - p.x0, p.y - p.y0) > 6) { clearTimeout(this.timer); this.mode = 'rel'; }
      if (this.mode === 'rel' || this.mode === 'reldrag') {
        this.rel[0] += (p.x - p.lx) * PAD_SENS; this.rel[1] += (p.y - p.ly) * PAD_SENS;
        if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
      }
      p.lx = p.x; p.ly = p.y;
      return;
    }
    if (this.mode === 'pending' && Math.hypot(p.x - p.x0, p.y - p.y0) > 10) {
      clearTimeout(this.timer);
      this.mode = 'drag';
      ctlSend(['m', ...this.start]); ctlSend(['b', 0, 1]);
    }
    if (this.mode === 'drag') { this.moveQ = normPt(e).map(n4); if (!this.raf) this.raf = requestAnimationFrame(() => this.flush()); }
    else if (this.mode === 'scroll' && this.pts.size >= 2) {
      const m = this.mid();
      const dy = Math.round((m[1] - this.lastMid[1]) * 4), dx = Math.round((this.lastMid[0] - m[0]) * 4);
      if (Math.abs(dy) >= 12 || Math.abs(dx) >= 12) {
        ctlSend(['w', Math.max(-1200, Math.min(1200, dy)), Math.max(-1200, Math.min(1200, dx))]);
        this.lastMid = m;
      }
    }
  },
  flush() {
    this.raf = 0;
    if (this.moveQ) { ctlSend(['m', ...this.moveQ], true); this.moveQ = null; }
    const dx = Math.trunc(this.rel[0]), dy = Math.trunc(this.rel[1]);
    if (dx || dy) { ctlSend(['r', dx, dy], true); this.rel[0] -= dx; this.rel[1] -= dy; }
  },
  up(e) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    clearTimeout(this.timer);
    if (touchpad()) {
      if (this.mode === 'pending') { ctlSend(['b', 0, 1]); ctlSend(['b', 0, 0]); this.lastTap = Date.now(); this.mode = 'done'; }
      else if (this.mode === 'reldrag') { this.flush(); ctlSend(['b', 0, 0]); this.mode = 'done'; }
      else if (this.mode === 'rel') { this.flush(); this.mode = 'done'; }
      if (!this.pts.size) this.mode = null;
      return;
    }
    if (this.mode === 'pending') { ctlSend(['m', ...this.start]); ctlSend(['b', 0, 1]); ctlSend(['b', 0, 0]); this.mode = 'done'; }
    else if (this.mode === 'drag') { this.flush(); ctlSend(['m', ...normPt(e).map(n4)]); ctlSend(['b', 0, 0]); this.mode = 'done'; }
    if (!this.pts.size) this.mode = null;
  },
  reset(release) {
    clearTimeout(this.timer);
    if (release && (this.mode === 'drag' || this.mode === 'reldrag')) ctlSend(['b', 0, 0]);
    this.rel = [0, 0];
    this.pts.clear();
    this.mode = null;
  },
};

/* ---------- клавиатура телефона → клавиши ПК ---------- */
// буквы идут кодами клавиш (как физическая клавиатура): русские — по раскладке ЙЦУКЕН, поэтому на ПК должна
// быть включена нужная раскладка
const KEY_OF = (() => {
  const m = new Map();
  const add = (chars, codes, shift) => [...chars].forEach((c, i) => m.set(c, [codes[i], shift]));
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  add(letters, [...letters].map((c) => 'Key' + c.toUpperCase()), false);
  add(letters.toUpperCase(), [...letters].map((c) => 'Key' + c.toUpperCase()), true);
  const ru = 'йцукенгшщзхъфывапролджэячсмитьбюё';
  const ruCodes = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight',
    'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote',
    'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Backquote'];
  add(ru, ruCodes, false);
  add(ru.toUpperCase(), ruCodes, true);
  add('1234567890', [...'1234567890'].map((d) => 'Digit' + d), false);
  add('!@#$%^&*()', [...'1234567890'].map((d) => 'Digit' + d), true);
  add(' -=[]\\;\',./`', ['Space', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote'], false);
  add('_+{}|:"<>?~', ['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote'], true);
  m.set('\n', ['Enter', false]);
  return m;
})();
function tapKey(code, shift) {
  if (!CV.perm.kb || CV.state !== 'on') return;
  if (shift) ctlSend(['k', 'ShiftLeft', 1]);
  ctlSend(['k', code, 1]);
  ctlSend(['k', code, 0]);
  if (shift) ctlSend(['k', 'ShiftLeft', 0]);
}
// поле ввода живёт своей жизнью (подсказки, автозамена) — шлём разницу: стёрто → Backspace, добавлено → буквы
let kbPrev = '';
function onKbInput() {
  const v = $('kbInput').value;
  let i = 0;
  while (i < kbPrev.length && i < v.length && kbPrev[i] === v[i]) i++;
  for (let k = kbPrev.length; k > i; k--) tapKey('Backspace', false);
  for (const ch of v.slice(i)) { const k = KEY_OF.get(ch); if (k) tapKey(k[0], k[1]); }
  kbPrev = v;
  if (v.length > 100) { $('kbInput').value = ''; kbPrev = ''; }
}

function bindLiveTools() {
  const layer = $('inputLayer');
  layer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { layer.setPointerCapture(e.pointerId); } catch { /* */ }
    if (CV.state === 'on') { if (CV.perm.mouse) touchCtl.down(e); return; }
    if (tools.mode === 'draw' && !tools.stroke) {
      const id = newMid();
      const p = normPt(e).map(n4);
      const hl = tools.kind === 'hl';
      const w = hl ? Math.min(14, tools.w * 2 + 4) : tools.w;
      const shape = !['pen', 'hl'].includes(tools.kind) ? tools.kind : null;
      $('drawMenu').classList.add('hidden');
      tools.stroke = { id, c: tools.color, w, hl, shape, a: p, pending: shape ? [] : [p], pointer: e.pointerId };
      tools.local.set(id, { c: tools.color, w, hl, pts: [p], done: false, ts: Date.now() });
      clearInterval(tools.flushT);
      if (!shape) tools.flushT = setInterval(() => flushStroke(false), 50);
      kickLocal();
    } else if (tools.mode === 'ptr') {
      const [x, y] = normPt(e);
      tools.myPtr = { x, y, ts: Date.now() };
      kickLocal();
      send({ t: 'ptr', x: n4(x), y: n4(y) });
    }
  });
  layer.addEventListener('pointermove', (e) => {
    if (CV.state === 'on') { if (CV.perm.mouse) touchCtl.move(e); return; }
    if (tools.mode === 'draw' && tools.stroke && tools.stroke.pointer === e.pointerId) {
      const p = normPt(e).map(n4);
      const st = tools.stroke;
      const l = tools.local.get(st.id);
      if (st.shape) {
        const r = videoRect();
        if (l) l.pts = shapePts(st.shape, st.a, p, r.w / Math.max(1, r.h)).map((q) => q.map(n4));
      } else {
        st.pending.push(p);
        l?.pts.push(p);
      }
      kickLocal();
    } else if (tools.mode === 'ptr' && e.buttons) {
      const [x, y] = normPt(e);
      tools.myPtr = { x, y, ts: Date.now() };
      kickLocal();
      if (Date.now() - tools.ptrLast > 33) { tools.ptrLast = Date.now(); send({ t: 'ptr', x: n4(x), y: n4(y) }); }
    }
  });
  const up = (e) => {
    if (CV.state === 'on') { touchCtl.up(e); return; }
    if (tools.stroke && tools.stroke.pointer === e.pointerId) {
      clearInterval(tools.flushT);
      const l = tools.local.get(tools.stroke.id);
      if (l) { l.done = true; l.ts = Date.now(); }
      flushStroke(true);
      kickLocal();
    } else if (tools.mode === 'ptr') { send({ t: 'ptr-off' }); tools.myPtr = null; kickLocal(); }
  };
  layer.addEventListener('pointerup', up);
  layer.addEventListener('pointercancel', up);
  layer.addEventListener('contextmenu', (e) => e.preventDefault());

  $('toolPtr').onclick = () => setTool('ptr');
  $('toolDraw').onclick = () => setTool('draw');
  $('toolColor').onclick = () => { $('drawMenu').classList.toggle('hidden'); $('reactBar').classList.add('hidden'); buildDrawMenu(); updateToolbar(); };
  buildDrawMenu();
  $('toolClear').onclick = () => { tools.local.clear(); kickLocal(); send({ t: 'draw-clear' }); };
  $('toolReact').onclick = () => { $('reactBar').classList.toggle('hidden'); updateToolbar(); };
  $('toolCtl').onclick = () => ctlRequest();
  $('toolTouchpad').onclick = () => {
    touchCtl.reset(true);
    CV.touchpad = !CV.touchpad;
    toast(CV.touchpad ? 'Тачпад: веди пальцем — мышь двигается; касание — клик, двойное и вести — с зажатой кнопкой' : 'Касание — клик в это место экрана');
    updateToolbar();
  };
  $('toolVpad').onclick = () => setVpad(!VP.on);
  $('toolClip').onclick = () => saveClip();
  $('btnWatchReplay').onclick = () => saveClip();
  $('clipClose').onclick = () => closeClipPreview();
  $('clipSave').onclick = () => { if (S.clipFile) saveBlob(S.clipFile, S.clipFile.name, 'video/mp4'); };
  $('clipSend').onclick = () => {
    if (!S.connected || !S.fileChan || !S.clipFile) { toast('Друг не в звонке'); return; }
    S.fileChan.queue([S.clipFile]);
    closeClipPreview();
    toast('Повтор отправляется другу');
  };
  $('toolImg').onclick = () => $('toolImgFile').click();
  $('toolImgFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; startPlacement(f); };
  $('toolKb').onclick = () => { const i = $('kbInput'); i.value = ''; kbPrev = ''; i.focus(); };
  $('toolKeys').onclick = () => $('keysBar').classList.toggle('hidden');
  const rb = $('reactBar');
  for (const e of REACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbtn';
    b.textContent = e;
    b.onclick = () => sendReaction(e);
    rb.appendChild(b);
  }
  for (const b of document.querySelectorAll('#keysBar [data-key]')) b.onclick = () => tapKey(b.dataset.key, false);
  $('kbInput').addEventListener('input', onKbInput);
  $('kbInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tapKey('Enter', false); } });
  updateToolbar();
}

// сообщения стримящего по каналам управления (ему — массивы, нам — объекты)
function onCtlMsg(a) {
  if (!a || Array.isArray(a) || typeof a !== 'object' || CV.state !== 'on') return;
  if (a.t === 'ctl-info') {
    const INFO = {
      local: `${ctlNick()} сам двигает мышью — твоё управление на паузе`,
      nobus: `У ${ctlNick()} не установлен драйвер ViGEmBus — геймпад не передаётся`,
      padok: 'Геймпад подключён у друга',
      elev: `Окно у ${ctlNick()} запущено от администратора — Windows не пропускает туда управление`,
    };
    if (INFO[a.what]) { const now = Date.now(); if (now - (CV.infoTs?.[a.what] || 0) > 8000) { CV.infoTs = { ...CV.infoTs, [a.what]: now }; toast(INFO[a.what]); } }
  }
}

/* ---------- Статистика: качество стрима на экране + реальный путь звонка для канала друзей ---------- */
let lastBytes = 0, lastTs = 0, pairLogged = false, statN = 0;
function startStats() {
  stopStats();
  lastBytes = 0; lastTs = 0; pairLogged = false; statN = 0;
  S.statsTimer = setInterval(collectStats, 1000);
}
function stopStats() { clearInterval(S.statsTimer); S.statsTimer = null; }
async function collectStats() {
  const pc = S.pc, tx = S.tx;
  if (!pc || !tx) return;
  let report;
  try { report = await pc.getStats(); } catch { return; }
  if (S.pc !== pc) return;
  const watching = !$('remoteScreenWrap').classList.contains('hidden');
  const codecs = {};
  report.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
  let line = null, log = null;
  report.forEach((r) => {
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && !pairLogged) {
      const l = report.get(r.localCandidateId), rm = report.get(r.remoteCandidateId);
      L('pair', { local: `${l?.candidateType}/${l?.protocol}/${l?.networkType || ''}`, remote: `${rm?.candidateType}/${rm?.protocol}`, rttMs: Math.round((r.currentRoundTripTime || 0) * 1000) });
      pairLogged = true;
      S.callPath = { localIp: l?.address, localType: l?.candidateType, remoteIp: rm?.address, remoteType: rm?.candidateType };
      sendCallPath();
    }
    if (watching && r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === tx.video.receiver.track?.id) {
      let mbps = '';
      if (lastTs) { const sec = (r.timestamp - lastTs) / 1000; if (sec > 0) mbps = ` · ${(((r.bytesReceived - lastBytes) * 8) / sec / 1e6).toFixed(1)} Мбит/с`; }
      lastBytes = r.bytesReceived; lastTs = r.timestamp;
      line = (r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : '') + (r.framesPerSecond ? ` · ${Math.round(r.framesPerSecond)} fps` : '') + mbps;
      log = { codec: codecs[r.codecId], dec: r.decoderImplementation, hw: r.powerEfficientDecoder, res: `${r.frameWidth || 0}x${r.frameHeight || 0}`, fps: r.framesPerSecond, lost: r.packetsLost, freezes: r.freezeCount, dropped: r.framesDropped };
    }
  });
  if (watching && line != null) $('remoteStats').textContent = line;
  if (log && ++statN % 10 === 0) L('stats', { recv: log });
}

/* =========================================================
   Звонок: экран, кнопки
   ========================================================= */
async function prepare(setup) {
  const active = () => !setup || S.callSetup === setup;
  if (!active()) return false;
  S.nick = $('nick').value.trim() || 'Без имени';
  store.set('nick', S.nick);
  $('lobbyError').textContent = '';
  audio();
  if (!S.mic) {
    await alo.requestMic();
    if (!active()) return false;
    const fresh = await acquireMic();
    if (!active()) { fresh.getTracks().forEach((t) => t.stop()); return false; }
    S.mic = fresh;
    await attachMicChain(S.mic).catch((e) => L('ns', { attachFailed: e.message }));
    if (!active()) { if (S.mic === fresh) releaseMic(); return false; }
    const t = S.mic.getAudioTracks()[0];
    L('mic', { ok: !!t && !!t.label, settings: t?.getSettings?.() ? { ec: t.getSettings().echoCancellation, ns: t.getSettings().noiseSuppression } : null });
  }
  return true;
}

function enterCall() {
  S.inCall = true;
  showScreen('call');
  $('meName').textContent = S.nick;
  $('meInitial').textContent = initial(S.nick);
  $('friendTop').textContent = S.friendNick;
  S.callConv = tempConv(S.friendNick);
  mountConv(S.callConv, $('messages'));
  S.unread = 0; updateUnread();
  setFriendPresent(true);
  updateMyControls();
  S.stopMyMeter?.();
  S.stopMyMeter = makeMeter(S.mic, (lvl) => { $('meCard').classList.toggle('speaking', lvl > 0.02 && !S.muted && !S.deafened); window.talkingAvatar?.level($('meCard'), (!S.muted && !S.deafened) ? lvl : 0); });
  S.callStart = Date.now();
  clearInterval(S.timerInt);
  S.timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - S.callStart) / 1000);
    $('callTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  updateService();
  refreshAvatars();
  setTimeout(() => alo.audioRoute({}).then((r) => { S.speaker = !!r.speaker; updateMyControls(); }), 500);
}

function leaveCall() {
  L('call', { leave: true });
  camReset();
  S.peerCam = false;
  if (S.waiting) { alo.friendsSend({ id: S.waiting.id, msg: { t: 'call-closed' } }); S.waiting = null; }
  $('waitBar').classList.add('hidden');
  $('btnAddFriend').classList.add('hidden');
  S.peerIdent = null;
  S.friendPerm = null;
  S.peerClaim = null;
  S.identCh = null;
  S.signaledBy = null;
  S.callPath = null;
  if (S.reconnecting) { clearTimeout(S.reconnecting.timer); S.reconnecting = null; $('call').classList.remove('reconnecting'); }
  send({ t: 'bye' });
  const wasConnected = S.connected;
  S.connected = false;
  hideRemoteScreen();
  stopStats();
  spStopAll();
  spOpen(false);
  stopClip();
  S.stopFriendMeter?.(); S.stopFriendMeter = null;
  $('remoteVoice').srcObject = null;
  closePc(wasConnected ? 300 : 0); // даём «bye» уйти
  releaseMic();
  clearInterval(S.timerInt);
  S.inCall = false;
  S.muted = false;
  S.deafened = false;
  S.friendNick = '';
  if(S.callConv&&!S.callConv.id&&S.callConv.fileCacheId)historyFiles.clear(S.callConv.fileCacheId).catch(()=>{});
  S.callConv = null;
  S.chatOpen = false;
  $('chatPanel').classList.add('hidden');
  showScreen('lobby');
  showStep('stepHome');
  renderFriends();
  restoreCallOverlays();
  updateService();
}

function updateService() {
  const inCall = !!(S.inCall || S.pc || S.friendCall?.accepted || S.friendCall?.dir === 'out' || G.active);
  // поверх экрана блокировки — пока звонит входящий и в разговоре (как у обычного звонка), иначе телефон блокируется сам
  const overLock = inCall || S.friendCall?.dir === 'in' || !!G.invite;
  alo.callState({ inCall, overLock, speakerStart: !!settings().speakerStart, friend: G.active ? 'группа' : S.friendNick || S.friendCall?.nick || '' });
}

function setMuted(v) {
  S.muted = v;
  applyMicEnabled();
  spUpdateGains();
  updateMyControls();
  send({ t: 'state', muted: S.muted, deaf: S.deafened });
  sound(v ? 'mute' : 'unmute');
}
function setDeafened(v) {
  S.deafened = v;
  spUpdateGains();
  $('remoteVoice').muted = v;
  $('remoteScreen').muted = v;
  applyMicEnabled();
  updateMyControls();
  send({ t: 'state', muted: S.muted, deaf: S.deafened });
  sound(v ? 'mute' : 'unmute');
}
function updateMyControls() {
  const micOff = S.muted || S.deafened;
  const ptt = pttOn() && !micOff;
  $('btnMute').classList.toggle('off', micOff || (ptt && !S.pttDown));
  $('btnMute').classList.toggle('mic-muted', micOff);
  $('btnMute').setAttribute('aria-label', micOff ? 'Микрофон выключен' : ptt ? 'Нажми и держи, чтобы говорить' : 'Микрофон');
  $('btnMute').classList.toggle('ptt', ptt);
  $('btnMute').classList.toggle('on', ptt && !!S.pttDown);
  $('btnMute').querySelector('span').textContent = micOff ? 'Выкл.' : ptt ? (S.pttDown ? 'Говорю' : 'Держи') : 'Микр.';
  $('btnDeafen').classList.toggle('off', S.deafened);
  $('btnDeafen').querySelector('span').textContent = S.deafened ? 'Без зв.' : 'Звук';
  $('btnSpeaker').classList.toggle('on', S.speaker);
  $('btnSpeaker').querySelector('span').textContent = S.speaker ? 'Динам.' : 'У уха';
  $('meBadges').textContent = (S.deafened ? '🔇' : '') + (micOff ? '🎙̸' : '');
  if (micOff) $('meCard').classList.remove('speaking');
}
function setFriendBadges(muted, deaf) { $('friendBadges').textContent = (deaf ? '🔇' : '') + (muted || deaf ? '🎙̸' : ''); }
function setFriendPresent(on) {
  $('friendCard').classList.toggle('ghost', !on);
  $('friendName').textContent = on ? S.friendNick : 'не в звонке';
  $('friendInitial').textContent = on ? initial(S.friendNick) : '…';
  $('friendTop').textContent = S.friendNick || '…';
  if (!on) { $('friendBadges').textContent = ''; $('friendCard').classList.remove('speaking'); }
}
function setStatus(kind, text) {
  const el = $('status');
  el.className = 'status ' + kind;
  el.querySelector('span').textContent = text;
}
const initial = (s) => (s || '?').trim().charAt(0).toUpperCase() || '?';

function toggleChat(open = !S.chatOpen) {
  S.chatOpen = open;
  $('chatPanel').classList.toggle('hidden', !open);
  $('btnChat').classList.toggle('on', open);
  if (open) { S.unread = 0; updateUnread(); if (S.callConv) { scrollEnd(S.callConv, true); setTimeout(() => flushRead(S.callConv), 50); } spOpen(false); }
}
function bumpUnread() { S.unread++; updateUnread(); }
function updateUnread() {
  const b = $('chatBadge');
  b.classList.toggle('hidden', !S.unread);
  b.textContent = S.unread > 99 ? '99+' : String(S.unread);
}

/* =========================================================
   Экраны лобби
   ========================================================= */
function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
}
function showStep(id) {
  document.querySelectorAll('.step').forEach((s) => s.classList.toggle('active', s.id === id));
  document.querySelectorAll('[data-err]').forEach((e) => { e.textContent = ''; });
  if (id === 'stepGuest') {
    $('guestAnswerBlock').classList.add('hidden');
    $('btnMakeAnswer').disabled = false;
    $('answerOut').value = '';
    setInfo('guestInfo', '');
  }
}
const activeStep = () => document.querySelector('.step.active')?.id;
function backToHome() {
  S.callSetup = null; S.answerWhenFree = null; S.busy = false;
  clearTimeout(S.connectTimer);
  closePc();
  releaseMic();
  $('lobbyError').textContent = '';
  showStep('stepHome');
  updateService();
}
function setInfo(id, text, ok) { const el = $(id); el.textContent = text; el.classList.toggle('ok', !!ok); }
function setErr(text) {
  const st = activeStep();
  const el = st && st !== 'stepHome' ? $(st).querySelector('[data-err]') : $('lobbyError');
  if (el) el.textContent = text;
  if (text) sound('error');
}
function lobbyError(e) { setErr(e?.message || 'Что-то пошло не так'); }

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

/* ---------- Буфер обмена: сами замечаем код друга и копируем свой ---------- */
const ownCodes = new Set();
let lastClip = '';
async function autoCopy(text, btn) {
  await alo.copy({ text });
  if (btn) { const old = btn.textContent; btn.textContent = 'Скопировано ✓'; setTimeout(() => { btn.textContent = old; }, 2000); }
}
async function checkClipboard() {
  if (S.inCall || S.busy || S.friendCall || !$('lobby').classList.contains('active')) return;
  const text = (await alo.paste()).text || '';
  if (text === lastClip) return;
  lastClip = text;
  const fc = /ALOF\.[A-Za-z0-9_-]{60,400}/.exec(text.replace(/\s+/g, ''));
  if (fc && !ownCodes.has(fc[0]) && activeStep() === 'stepHome') { L('clipboard', 'friend code detected'); fcOpen(fc[0]); return; }
  const m = /ALO([IA])\.[A-Za-z0-9_-]{200,}/.exec(text.replace(/\s+/g, ''));
  if (!m || ownCodes.has(m[0])) return;
  const code = m[0];
  const step = activeStep();
  if (m[1] === 'I' && (step === 'stepHome' || (step === 'stepGuest' && $('guestAnswerBlock').classList.contains('hidden')))) {
    L('clipboard', 'invite detected');
    showStep('stepGuest');
    $('offerIn').value = code;
    toast('Нашёл приглашение в буфере — готовлю ответ');
    makeAnswer();
  } else if (m[1] === 'A' && step === 'stepHost' && S.pc?.signalingState === 'have-local-offer') {
    L('clipboard', 'answer detected');
    $('answerIn').value = code;
    toast('Нашёл ответ друга в буфере — подключаюсь');
    applyAnswer();
  }
}

/* =========================================================
   Разговоры: чат в звонке и без звонка, история на телефоне (только текст)
   ========================================================= */
const convs = new Map();
const HIST_MAX = 400;
function newConvBox() { const b = document.createElement('div'); b.className = 'conv'; return b; }
function getConv(id, nick) {
  if (!id) return null;
  let c = convs.get(id);
  if (!c) { c = { id, nick: nick || 'Друг', box: newConvBox(), loaded: false, unread: 0, pending: [] }; convs.set(id, c); }
  if (nick) c.nick = nick;
  return c;
}
function tempConv(nick) { return { id: null, nick: nick || 'Друг', box: newConvBox(), loaded: true, unread: 0, pending: [] }; }
// лента «прилипает» к низу (как у ПК 1.17): был внизу — остаётся внизу, даже когда картинка догрузилась и выросла.
// «Отлип» — только если ленту сдвинули вверх от места, куда её поставили мы
const atBottom = (s) => s.scrollHeight - s.scrollTop - s.clientHeight < 40;
function toEnd(s) { s.scrollTop = s.scrollHeight; s.progTop = s.scrollTop; s.stick = true; }
const boxSizes = typeof ResizeObserver === 'function' ? new ResizeObserver((list) => {
  for (const e of list) { const s = e.target.parentElement; if (s && s.stick !== false) toEnd(s); }
}) : null;
function mountConv(conv, host) {
  host.replaceChildren(conv.box);
  if (!host.stickInit) {
    host.stickInit = true;
    host.addEventListener('scroll', () => {
      if (host.progTop != null && host.scrollTop >= host.progTop - 2) return; // это мы прокрутили
      host.progTop = null;
      host.stick = atBottom(host);
    }, { passive: true });
    // клавиатура открылась/закрылась — окно стало другим, низ не теряем
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (host.stick !== false) toEnd(host); }).observe(host);
  }
  if (boxSizes && !conv.box.observed) { conv.box.observed = true; boxSizes.observe(conv.box); }
  toEnd(host);
}
function scrollEnd(conv, force) {
  const s = conv?.box.parentElement;
  if (s && (force || s.stick !== false || atBottom(s))) toEnd(s);
}
const newMid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function histGet(id) { return window.accountLabData?.ready?accountLabData.getHistory(id):store.get('hist.' + id, []); }
function accountHistorySet(id,rows){if(window.accountLabData?.ready)return accountLabData.setHistory(id,rows);store.set('hist.'+id,rows)}
function record(conv, entry) {
  if (!conv) return;
  if (!conv.id) { conv.pending.push(entry); return; }
  const h = histGet(conv.id);
  h.push(entry);
  const keep=window.accountLabData?.ready?65536:HIST_MAX;
  for(const old of h.slice(0,Math.max(0,h.length-keep))) if(old.type==='file'&&old.mid) historyFiles.remove(conv.id,old.mid).catch(()=>{});
  accountHistorySet(conv.id, h.slice(-keep));
}
function recordStatus(conv, mid, st) {
  if (!conv?.id) return;
  const h = histGet(conv.id);
  const e = h.find((x) => x.mid === mid);
  if (e) { e.st = st; accountHistorySet(conv.id, h); }
}
function clearHistory(conv) {
  if (!conv?.id) return;
  historyFiles.clear(conv.id).catch(e=>L('history',{fileClearError:String(e.message)}));
  store.del('hist.' + conv.id);
  window.accountLabData?.ready&&accountLabData.clearHistory(conv.id);
  conv.box.replaceChildren();
  conv.msgs?.clear?.();
  conv.loaded = true;
  L('history', { cleared: 'one' });
}
function clearAllHistory() {
  window.accountLabData?.ready&&accountLabData.clearHistory();
  historyFiles.clear().catch(e=>L('history',{fileClearError:String(e.message)}));
  for (const k of Object.keys(localStorage)) if (k.startsWith('aloc.hist.')) localStorage.removeItem(k);
  for (const c of convs.values()) { c.box.replaceChildren(); c.msgs?.clear?.(); c.loaded = true; }
  L('history', { cleared: 'all' });
}
// кнопка «удалить»: первое нажатие — «Точно?», второе в течение 4 с — действие
function confirmBtn(btn, ask, act) {
  btn.onclick = () => {
    if (btn.dataset.armed) { clearTimeout(Number(btn.dataset.armed)); delete btn.dataset.armed; btn.textContent = btn.dataset.text; btn.classList.remove('bad'); act(); return; }
    btn.dataset.text = btn.textContent;
    btn.textContent = ask;
    btn.classList.add('bad');
    btn.dataset.armed = String(setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.text; btn.classList.remove('bad'); }, 4000));
  };
}
function loadHistory(conv) {
  if (!conv?.id || conv.loaded) return;
  conv.loaded = true;
  const items = foldOps(histGet(conv.id));
  const frag = document.createElement('div');
  for (const e of items) {
    const mine = e.who === 'me';
    const who = mine ? (S.nick || 'Я') : (e.nick || conv.nick);
    const opt = { who:e.who, mid: cleanMid(e.mid) || undefined, re: e.re, react: e.react, edited: e.edited, deleted: e.deleted };
    if (e.type === 'text') {
      const m = chatMsg(conv, who, String(e.text || ''), mine, e.ts, frag, opt);
      if (e.st === 'fail') markUndelivered(m);
      else if (mine) { setTickEl(m, e.st==='queued'?'queued':e.st === 'read' ? 'read' : 'sent'); if (e.st === 'read' && opt.mid) { const it = conv.msgs?.get(opt.mid); if (it) it.read = true; } }
    }
    else if (e.type === 'file') {
      const placeholder=chatMsg(conv, who, e.st ? '🙂 Стикер' : '📄 '+(e.name||'файл'), mine, e.ts, frag, { ...opt, type:'file',etext:e.name||'файл' });
      const epoch=historyFiles.stamp(conv.id);
      historyFiles.get(conv.id,e.mid).then(saved=>{
        if(!saved||e.deleted||epoch!==historyFiles.stamp(conv.id)||!placeholder.parentNode)return;
        const box=document.createDocumentFragment(), restored=fileBubble({...conv,box},who,saved.meta,mine,{...opt,restored:true});
        restored.done(URL.createObjectURL(saved.blob),saved.blob);placeholder.replaceWith(...box.childNodes);
      }).catch(err=>L('history',{fileLoadError:String(err.message)}));
    }
  }
  if (items.length) { const sep = document.createElement('div'); sep.className = 'msg sys'; sep.textContent = '— раньше —'; frag.appendChild(sep); }
  conv.box.prepend(...frag.childNodes);
}
function adoptConv(temp, id, nick) {
  const conv = getConv(id, nick);
  for (const el of [...temp.box.children]) conv.box.appendChild(el);
  for (const [k, v] of temp.msgs || []) { conv.msgs ??= new Map(); conv.msgs.set(k, v); }
  for (const e of temp.pending) record(conv, e);
  temp.pending = [];
  if(temp.fileCacheId){const epoch=historyFiles.stamp(id),saves=(temp.fileTickets||[]).map(t=>t.saved).filter(Boolean);for(const ticket of temp.fileTickets||[]){ticket.id=id;ticket.epoch=epoch;}
    conv.filesAdopted=Promise.all(saves).then(()=>historyFiles.migrate(temp.fileCacheId,id,epoch)).catch(e=>L('history',{fileAdoptError:String(e.message)}));}
  return conv;
}
async function adoptCallConv(id) {
  const temp = S.callConv;
  if (!temp || temp.id) return;
  const conv = getConv(id, S.friendNick);
  loadHistory(conv);
  adoptConv(temp, id, S.friendNick);
  S.callConv = conv;
  conv.unread = 0;
  mountConv(conv, $('messages'));
}

function timeStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (new Date().toDateString() === d.toDateString()) return t;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + t;
}
function appendLinkified(parent, text) {
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[1]; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = m[1];
    parent.appendChild(a);
    last = m.index + m[1].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
function chatMsg(conv, who, text, mine, ts, into, opt = {}) {
  if (!conv) return null;
  const m = document.createElement('div');
  m.className = 'msg' + (mine ? ' me' : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${who} · ${timeStr(ts)}`;
  const b = document.createElement('div');
  b.className = 'bubble';
  const t = document.createElement('span');
  t.className = 'btext';
  appendLinkified(t, text);
  b.appendChild(t);
  m.append(meta, b);
  if (opt.mid) regMsg(conv, m, { mid: opt.mid, who: opt.who || (mine ? 'me' : 'peer'), type: opt.type || 'text', text: opt.etext ?? text, re: opt.re, react: opt.react, edited: opt.edited, deleted: opt.deleted });
  (into || conv.box).appendChild(m);
  if (!into) scrollEnd(conv, mine);
  return m;
}
/* ---------- Прочитано (как у ПК 1.17): ✓ — дошло, ✓✓ — друг открыл чат и увидел. Только разговор на двоих.
   В звонке — 'read' по duo, без звонка — 'dm-read' по каналу друзей, в обоих список mids ---------- */
function setTickEl(m, st) {
  const meta = m?.querySelector('.meta');
  if (!meta) return;
  let t = meta.querySelector('.tick');
  if (!t) { t = document.createElement('span'); t.className = 'tick'; meta.appendChild(t); }
  if (t.classList.contains('read')) return; // прочитанное назад не откатываем
  t.dataset.state=st;
  t.textContent = st==='queued'?' ◷':st === 'read' ? ' ✓✓' : ' ✓';
  t.title=st==='queued'?'В очереди — отправится, когда друг будет доступен':st==='read'?'Прочитано':'Доставлено';
  t.classList.toggle('read', st === 'read');
}
function onReadMids(conv, mids) {
  if (!conv || !Array.isArray(mids)) return;
  for (const raw of mids.slice(0, 200)) {
    const mid = cleanMid(raw);
    const it = mid && conv.msgs?.get(mid);
    if (!it || it.e.who !== 'me' || it.read) continue;
    it.read = true;
    setTickEl(it.el, 'read');
    recordStatus(conv, mid, 'read');
  }
}
function convVisible(conv) {
  if (!conv || document.hidden) return false;
  if (dmOpen === conv && $('dm').classList.contains('active')) return true;
  return S.inCall && S.callConv === conv && S.chatOpen;
}
function noteUnseen(conv, mid) {
  if (!conv || !mid) return;
  (conv.unseen ??= []).push(mid);
  flushRead(conv);
}
function flushRead(conv) {
  if (!conv?.unseen?.length || !convVisible(conv)) return;
  const mids = conv.unseen.splice(0, 200);
  if (S.inCall && S.callConv === conv && S.connected) send({ t: 'read', mids });
  else if (conv.id) alo.friendsSend({ id: conv.id, msg: { t: 'dm-read', mids } });
}
function flushReadAll() { for (const c of convs.values()) flushRead(c); if (S.callConv && !S.callConv.id) flushRead(S.callConv); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(flushReadAll, 300); });

function markUndelivered(m) {
  if (!m || m.querySelector('.undel')) return;
  const s = document.createElement('span');
  s.className = 'undel';
  s.textContent = ' · не доставлено';
  m.querySelector('.meta').appendChild(s);
}
function callEvent(text, cause) {
  sysMsg(text, S.callConv, 'call-event ' + cause);
}

function sysMsg(text, conv = S.callConv, kind = '') {
  if (!conv) return;
  const m = document.createElement('div');
  m.className = 'msg sys' + (kind ? ' ' + kind : '');
  m.textContent = text;
  conv.box.appendChild(m);
  scrollEnd(conv, true);
}

function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text || !S.connected) return;
  if (composeSubmitEdit(composers.call, S.callConv, text)) return;
  $('chatInput').value = '';
  const ts = Date.now(), mid = newMid();
  const re = composeTakeReply(composers.call);
  send({ t: 'chat', text, ts, mid, re: reOut(re) });
  setTickEl(chatMsg(S.callConv, S.nick, text, true, ts, null, { mid, re }), 'sent');
  record(S.callConv, { mid, ts, who: 'me', nick: S.nick, type: 'text', text, re: re || undefined });
}

/* =========================================================
   Действия с сообщениями (как у ПК 1.14): реакции, ответ с цитатой, правка и удаление своих, поиск по истории.
   Сообщения и файлы адресуются по mid (у файлов — 'f' + номер передачи, он общий у обоих).
   Правки идут тем же путём, что и текст: в звонке — 'chat-op' по каналу звонка, без звонка — 'dm-op' по каналу друзей.
   Долгое нажатие на сообщение — реакции и действия.
   ========================================================= */
const MSG_REACTS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const fmid = (fid) => 'f' + (Number(fid) >>> 0).toString(36);
const cleanMid = (m) => (typeof m === 'string' && /^[a-z0-9]{1,24}$/i.test(m) ? m : '');
const snip = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// цитата: в сети — «mine» с точки зрения отправителя, в истории — by: me/peer с моей
function reOut(re) { return re ? { mid: re.mid, mine: re.by === 'me', text: re.text } : undefined; }
function reIn(r) {
  if (!r || typeof r !== 'object' || !cleanMid(r.mid)) return null;
  return { mid: r.mid, by: r.mine ? 'peer' : 'me', text: snip(r.text) };
}
const verGe = (v, min) => { const a = String(v).split('.').map(Number), b = min.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; } return true; };

function regMsg(conv, el, e) {
  el.dataset.mid = e.mid;
  conv.msgs ??= new Map();
  conv.msgs.set(e.mid, { el, e });
  if (e.re) {
    const q = document.createElement('div');
    q.className = 'quote';
    const b = document.createElement('b');
    b.textContent = e.re.by === 'me' ? (S.nick || 'Я') : conv.nickOf?.(e.re.by) || conv.nick;
    q.append(b, document.createTextNode(' ' + (e.re.text || '…')));
    q.onclick = (ev) => { ev.stopPropagation(); jumpToMsg(conv, e.re.mid); };
    el.querySelector('.bubble').prepend(q);
  }
  if (e.edited) markEdited(el);
  if (e.deleted) renderDeleted(el, e);
  renderReacts(conv, el, e);
}
function markEdited(el) {
  const meta = el.querySelector('.meta');
  if (meta && !meta.querySelector('.edited')) { const s = document.createElement('span'); s.className = 'edited'; s.textContent = ' · изменено'; meta.appendChild(s); }
}
function renderDeleted(el, e) {
  e.deleted = true;
  e.react = {};
  el.classList.add('deleted');
  const b = el.querySelector('.bubble');
  b.className = 'bubble';
  b.replaceChildren(Object.assign(document.createElement('i'), { textContent: 'Сообщение удалено' }));
  el.querySelector('.reacts')?.remove();
  el.querySelector('.meta .edited')?.remove();
}
function renderReacts(conv, el, e) {
  el.querySelector('.reacts')?.remove();
  const r = e.react || {};
  const list = Object.entries(r).filter(([, v]) => MSG_REACTS.includes(v));
  if (!list.length || e.deleted) return;
  const row = document.createElement('div');
  row.className = 'reacts';
  const by = new Map();
  for (const [who, v] of list) { if (!by.has(v)) by.set(v, []); by.get(v).push(who); }
  for (const [v, whos] of by) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'react-chip' + (whos.includes('me') ? ' mine' : '');
    c.textContent = v + (whos.length > 1 ? ' '+whos.length : '');
    c.onclick = (ev) => { ev.stopPropagation(); sendMsgOp(conv, { op: 'react', ref: e.mid, e: r.me === v ? '' : v }); };
    row.appendChild(c);
  }
  el.querySelector('.bubble').after(row);
}

function canOps(conv) {
  if(G.active && G.conv===conv)return true;
  if (S.inCall && S.callConv === conv) return !!S.friendPerm?.ops;
  const f = friendsList.find((x) => x.id === conv.id);
  return !f?.ver || verGe(f.ver, '1.14.0');
}
function cleanOp(o) {
  if (!o || typeof o !== 'object' || !['react', 'edit', 'del'].includes(o.op) || !cleanMid(o.ref)) return null;
  const op = { op: o.op, ref: o.ref, ts: Number(o.ts) || Date.now() };
  if (o.op === 'react') op.e = MSG_REACTS.includes(o.e) ? o.e : '';
  if (o.op === 'edit') { op.text = String(o.text || '').slice(0, 2000); if (!op.text.trim()) return null; }
  return op;
}
async function sendMsgOp(conv, raw) {
  const op = cleanOp({ ...raw, ts: Date.now() });
  if (!op || !conv) return false;
  if (op.op !== 'react' && window.accountLab?.ownsRelayedDm?.(conv.id, op.ref)) {
    toast('Сообщение можно изменить или удалить на компьютере, через который оно отправлено');
    return false;
  }
  if (!canOps(conv)) { toast(`У ${conv.nick} старая версия alloconnect — это заработает, когда он обновится`); return false; }
  let ok = false;
  const queued=conv.msgs?.get(op.ref)?.el.querySelector('.tick')?.dataset.state==='queued';
  if(queued&&conv.id){const r=await alo.friendsSend({id:conv.id,msg:{t:'dm-op',...op}});ok=!!r.ok;if(!ok){toast(r.error||'Не удалось изменить сообщение в очереди');return false;}}
  else if(G.active && G.conv===conv){grpSendAll({t:'chat-op',...op});ok=true;}
  else if (S.inCall && S.callConv === conv && S.dc?.readyState === 'open') { send({ t: 'chat-op', ...op }); ok = true; }
  else if (conv.id) { const r = await alo.friendsSend({ id: conv.id, msg: { t: 'dm-op', ...op } }); ok = !!r.ok; if(!ok&&r.error){toast(r.error);return false;} }
  if (!ok) { toast(`Не доставлено — ${conv.nick} не в сети`); return false; }
  applyOp(conv, op, 'me');
  return true;
}
// применить действие (своё или друга): на экране, если сообщение загружено, и в историю
function applyOp(conv, raw, by) {
  const op = cleanOp(raw);
  if (!op || !conv) return;
  const it = conv.msgs?.get(op.ref);
  if (it) {
    if (op.op !== 'react' && it.e.who !== by) return; // править и удалять можно только свои
    if (it.e.deleted) return;
    if (op.op === 'react') {
      it.e.react = { ...(it.e.react || {}) };
      if (op.e) it.e.react[by] = op.e; else delete it.e.react[by];
      renderReacts(conv, it.el, it.e);
      if (by === 'peer' && op.e && it.e.who === 'me') {
        const visible = (dmOpen === conv && $('dm').classList.contains('active')) || (S.inCall && S.callConv === conv && S.chatOpen);
        if (!visible) toast(`${conv.nick}: ${op.e} на «${snip(it.e.text, 40)}»`);
      }
    } else if (op.op === 'edit') {
      if (it.e.type !== 'text') return;
      it.e.text = op.text;
      it.e.edited = op.ts;
      const t = it.el.querySelector('.btext');
      if (t) { t.replaceChildren(); appendLinkified(t, op.text); }
      markEdited(it.el);
    } else if (op.op === 'del') renderDeleted(it.el, it.e);
  }
  if(op.op==='del'&&conv.id&&(it||histGet(conv.id).some(e=>e.mid===op.ref&&e.who===by))) historyFiles.remove(conv.id,op.ref).catch(()=>{});
  record(conv, { type: 'op', op: op.op, ref: op.ref, who: by, e: op.e, text: op.text, ts: op.ts });
}
// история: действия применяются к записям, к которым относятся (как это делает ПК при загрузке)
function foldOps(items) {
  const byMid = new Map();
  const out = [];
  for (const e of items) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !['text', 'file', 'call', 'op', 'status'].includes(e.type)) continue;
    if (e.type === 'op') {
      const t = byMid.get(e.ref);
      if (!t || t.deleted) continue;
      if (e.op === 'react') { t.react = { ...(t.react || {}) }; if (e.e) t.react[e.who] = e.e; else delete t.react[e.who]; }
      else if (e.who !== t.who) continue;
      else if (e.op === 'edit' && t.type === 'text') { t.text = e.text; t.edited = e.ts; }
      else if (e.op === 'del') t.deleted = true;
      continue;
    }
    if (e.type === 'status') { const t = byMid.get(e.ref), rank = { fail: 0, queued: 1, sent: 2, read: 3 }; if (t && Object.hasOwn(rank, e.st) && (t.st == null || !Object.hasOwn(rank, t.st) || rank[e.st] >= rank[t.st])) t.st = e.st; continue; }
    const c = { ...e };
    if (c.mid) byMid.set(c.mid, c);
    out.push(c);
  }
  return out;
}

/* ---------- Ответ и правка: полоска над полем ввода ---------- */
const composers = {
  call: { input: 'chatInput', form: 'chatForm', conv: () => S.callConv, mode: null, item: null, bar: null },
  grp: { input:'gChatInput', form:'gChatForm', conv:()=>G.conv, mode:null,item:null,bar:null },
  dm: { input: 'dmInput', form: 'dmForm', conv: () => dmOpen, mode: null, item: null, bar: null },
};
function setCompose(cp, mode, item) {
  cp.mode = mode;
  cp.item = item || null;
  if (!cp.bar) {
    cp.bar = document.createElement('div');
    cp.bar.className = 'compose-bar hidden';
    cp.bar.innerHTML = '<span class="cb-ico"></span><div class="cb-text"><b></b><small></small></div><button type="button" class="icon-btn cb-x" aria-label="Отмена">✕</button>';
    cp.bar.querySelector('.cb-x').onclick = () => cancelCompose(cp);
    $(cp.form).before(cp.bar);
  }
  cp.bar.classList.toggle('hidden', !mode);
  if (!mode) return;
  const conv = cp.conv();
  cp.bar.querySelector('.cb-ico').textContent = mode === 'edit' ? '✏' : '↩';
  cp.bar.querySelector('b').textContent = mode === 'edit' ? 'Редактирование' : 'Ответ ' + (item.e.who === 'me' ? 'себе' : conv?.nickOf?.(item.e.who) || conv?.nick || '');
  cp.bar.querySelector('small').textContent = snip(item.e.type === 'file' ? '📎 ' + item.e.text : item.e.text, 80);
  const inp = $(cp.input);
  if (mode === 'edit') inp.value = item.e.text;
  inp.focus();
}
function cancelCompose(cp) {
  const wasEdit = cp.mode === 'edit';
  setCompose(cp, null);
  if (wasEdit) $(cp.input).value = '';
}
function composeTakeReply(cp) {
  if (cp.mode !== 'reply' || !cp.item) return null;
  const e = cp.item.e;
  setCompose(cp, null);
  return { mid: e.mid, by: e.who, text: snip(e.type === 'file' ? '📎 ' + e.text : e.text) };
}
function composeSubmitEdit(cp, conv, text) {
  if (cp.mode !== 'edit' || !cp.item) return false;
  const it = cp.item;
  setCompose(cp, null);
  $(cp.input).value = '';
  if (text !== it.e.text) sendMsgOp(conv, { op: 'edit', ref: it.e.mid, text });
  return true;
}

function jumpToMsg(conv, mid) {
  const it = conv.msgs?.get(mid);
  if (!it || !it.el.isConnected) { toast('Это сообщение не загружено'); return false; }
  it.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  it.el.classList.remove('flash');
  void it.el.offsetWidth;
  it.el.classList.add('flash');
  return true;
}

/* ---------- Долгое нажатие на сообщение: реакции, ответить, изменить, удалить ---------- */
let actFor = null;
function showMsgActs(el, cp) {
  const conv = cp.conv();
  const it = conv?.msgs?.get(el.dataset.mid);
  if (!it || it.e.deleted) return;
  actFor = { conv, it, cp };
  const sheet = $('msgActs');
  sheet.querySelector('[data-a=edit]').classList.toggle('hidden', !(it.e.who === 'me' && it.e.type === 'text'));
  sheet.querySelector('[data-a=del]').classList.toggle('hidden', it.e.who !== 'me');
  for (const b of sheet.querySelectorAll('.ma-react')) b.classList.toggle('on', it.e.react?.me === b.dataset.r);
  sheet.querySelector('.ma-preview').textContent = snip(it.e.type === 'file' ? '📎 ' + it.e.text : it.e.text, 120);
  sheet.classList.remove('hidden');
  try { navigator.vibrate?.(15); } catch { /* */ }
}
function hideMsgActs() { $('msgActs').classList.add('hidden'); actFor = null; }

function bindMsgUi() {
  const sheet = $('msgActs');
  sheet.querySelector('.ma-row').innerHTML = MSG_REACTS.map((r) => `<button type="button" class="ma-react" data-r="${r}">${r}</button>`).join('');
  for (const [host, cp] of [['messages', composers.call], ['dmMessages', composers.dm], ['gMessages',composers.grp]]) {
    $(host).addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.msg[data-mid]');
      if (!el || e.target.closest('a, audio, video, button')) return;
      e.preventDefault();
      showMsgActs(el, cp);
    });
  }
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) { hideMsgActs(); return; }
    const b = e.target.closest('button');
    if (!b || !actFor) return;
    const { conv, it, cp } = actFor;
    if (b.dataset.r) sendMsgOp(conv, { op: 'react', ref: it.e.mid, e: it.e.react?.me === b.dataset.r ? '' : b.dataset.r });
    else if (b.dataset.a === 'reply') setCompose(cp, 'reply', it);
    else if (b.dataset.a === 'edit') setCompose(cp, 'edit', it);
    else if (b.dataset.a === 'del') sendMsgOp(conv, { op: 'del', ref: it.e.mid });
    else if (b.dataset.a === 'copy') alo.copy({ text: it.e.text || '' }).then(() => toast('Скопировано'));
    hideMsgActs();
  });
  $('chatSearchBtn').onclick = () => toggleSearch('call');
  $('dmSearchBtn').onclick = () => toggleSearch('dm');
}

/* ---------- Поиск по истории (она на телефоне — в памяти окна) ---------- */
const searches = {
  call: { host: 'messages', conv: () => S.callConv, el: null, t: 0 },
  dm: { host: 'dmMessages', conv: () => dmOpen, el: null, t: 0 },
};
function toggleSearch(kind) {
  const sr = searches[kind];
  if (sr.el && !sr.el.classList.contains('hidden')) { sr.el.classList.add('hidden'); return; }
  const conv = sr.conv();
  if (!conv?.id) { toast('Поиск работает в чате с другом из списка друзей'); return; }
  if (!sr.el) {
    sr.el = document.createElement('div');
    sr.el.className = 'msg-search';
    sr.el.innerHTML = '<input type="search" placeholder="Поиск по переписке" maxlength="100"><div class="ms-results"></div>';
    $(sr.host).before(sr.el);
    sr.el.querySelector('input').addEventListener('input', () => { clearTimeout(sr.t); sr.t = setTimeout(() => runSearch(sr), 250); });
  }
  sr.el.classList.remove('hidden');
  sr.el.querySelector('.ms-results').replaceChildren();
  const inp = sr.el.querySelector('input');
  inp.value = '';
  inp.focus();
}
function runSearch(sr) {
  const conv = sr.conv();
  const q = sr.el.querySelector('input').value.trim();
  const box = sr.el.querySelector('.ms-results');
  box.replaceChildren();
  if (!conv?.id || q.length < 2) return;
  const ql = q.toLowerCase();
  const list = foldOps(histGet(conv.id)).filter((e) => !e.deleted && (e.type === 'text' || e.type === 'file') && String(e.text || e.name || '').toLowerCase().includes(ql)).reverse().slice(0, 50);
  if (!list.length) { box.appendChild(Object.assign(document.createElement('div'), { className: 'ms-none', textContent: 'Ничего не нашлось' })); return; }
  for (const r of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ms-row';
    const head = document.createElement('small');
    head.textContent = `${r.who === 'me' ? (S.nick || 'Я') : (r.nick || conv.nick)} · ${timeStr(r.ts)}`;
    const body = document.createElement('div');
    const txt = (r.type === 'file' ? '📎 ' : '') + (r.text || r.name || '');
    const i = txt.toLowerCase().indexOf(ql);
    const from = Math.max(0, i - 40);
    body.append(document.createTextNode((from ? '…' : '') + txt.slice(from, i)), Object.assign(document.createElement('mark'), { textContent: txt.slice(i, i + q.length) }), document.createTextNode(txt.slice(i + q.length, i + q.length + 80)));
    row.append(head, body);
    row.onclick = () => { loadHistory(conv); if (jumpToMsg(conv, r.mid)) sr.el.classList.add('hidden'); };
    box.appendChild(row);
  }
}

/* =========================================================
   Файлы в звонке: тот же формат, что у десктопа (канал files)
   ========================================================= */
const CHUNK = 64 * 1024;
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1073741824).toFixed(2) + ' ГБ');
const fileKind = (mime) => (/^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'file');
const FICON = { image: '🖼', video: '🎬', audio: '🎵', file: '📄' };
const NOUI = { progress() {}, done() {}, fail() {} };

function fileBubble(conv, who, meta, mine, opt = {}) {
  const ticket={id:conv.id||(conv.fileCacheId ||= 'temp-'+newMid()),epoch:null,saved:null};ticket.epoch=historyFiles.stamp(ticket.id);
  if(!conv.id)(conv.fileTickets ||= []).push(ticket);
  const m = document.createElement('div');
  m.className = 'msg' + (mine ? ' me' : '') + (meta.st ? ' sticker' : '');
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `${who} · ${timeStr()}`;
  const b = document.createElement('div');
  b.className = 'bubble';
  const line = document.createElement('div');
  line.className = 'fileline';
  line.textContent = meta.st ? '🙂' : `${FICON[meta.kind] || '📄'} ${meta.name} · ${fmtSize(meta.size)}`;
  const prog = document.createElement('div');
  prog.className = 'prog';
  prog.innerHTML = '<i></i>';
  b.append(line, prog);
  m.append(head, b);
  if (opt.mid) regMsg(conv, m, { mid: opt.mid, who: opt.who || (mine ? 'me' : 'peer'), type: 'file', text: meta.name });
  conv.box.appendChild(m);
  scrollEnd(conv, mine);
  return {
    progress(done) { prog.firstChild.style.width = Math.min(100, (100 * done) / Math.max(1, meta.size)) + '%'; },
    done(url, blob) {
      if(!opt.restored&&blob&&opt.mid) ticket.saved=historyFiles.put(ticket.id,opt.mid,meta,blob,ticket.epoch).catch(e=>{L('history',{fileSaveError:String(e.message)});toast('Файл получен, но не сохранён в истории: недостаточно места или хранилище недоступно');});
      prog.remove();
      // полученный файл — кнопка «Сохранить» (в WebView ссылка на blob сама ничего не скачивает)
      // звук для саундпада от друга
      if (!mine && blob && meta.p === 'sound') {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn small-btn save-btn';
        add.textContent = '➕ В саундпад';
        add.onclick = async () => {
          add.disabled = true;
          if (await spAddFiles([new File([blob], meta.name, { type: blob.type || meta.mime })])) add.textContent = 'Добавлено ✓';
          else add.disabled = false;
        };
        b.append(add);
      }
      if (!mine && blob && !meta.st) {
        const sv = document.createElement('button');
        sv.type = 'button';
        sv.className = 'btn small-btn save-btn';
        sv.textContent = '💾 Сохранить';
        sv.onclick = async () => { sv.disabled = true; const ok = await saveBlob(blob, meta.name, blob.type || meta.mime); sv.disabled = false; if (ok) sv.textContent = '✔ В «Загрузках»'; };
        b.append(sv);
      }
      if (meta.kind === 'image') {
        const img = document.createElement('img');
        img.src = url; img.alt = meta.name;
        img.onload = () => {
          // мелкий стикер (смайлики по 20–40 px) — крупнее: до 96 px, не больше чем втрое (как ПК)
          if (meta.st) { const n = Math.max(img.naturalWidth, img.naturalHeight); if (n && n < 96) { const k = Math.min(3, 96 / n); img.style.width = Math.round(img.naturalWidth * k) + 'px'; img.style.height = Math.round(img.naturalHeight * k) + 'px'; } }
          scrollEnd(conv);
        };
        b.replaceChildren(img);
        // чужой стикер — можно забрать себе (набор «Полученные»)
        if (meta.st && !mine && blob) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'stk-take';
          add.setAttribute('aria-label', 'Добавить в мои стикеры');
          add.textContent = '＋';
          add.onclick = async (e) => {
            e.stopPropagation();
            add.disabled = true;
            if (await stkTake(blob, meta.name.replace(/\.[^.]+$/, ''))) { add.textContent = '✓'; toast('Стикер добавлен в набор «Полученные»'); }
            else { add.disabled = false; toast('Не получилось добавить стикер'); }
          };
          b.appendChild(add);
        }
      } else if (meta.kind === 'video' || meta.kind === 'audio') {
        const el = document.createElement(meta.kind);
        el.src = url; el.controls = true; el.preload = 'metadata';
        b.append(el);
      }
    },
    fail(why) { prog.remove(); const s = document.createElement('div'); s.className = 'undel'; s.textContent = 'Не доставлено: ' + why; b.append(s); },
  };
}

// файл → «Загрузки/alloconnect» частями по 512 КБ (через мост — base64)
async function saveBlob(blob, name, mime) {
  const st = await alo.saveStart({ name: String(name || 'файл').slice(0, 120), mime: mime || 'application/octet-stream' });
  if (!st.token) { toast('Не удалось сохранить'); return false; }
  const PART = 512 * 1024;
  try {
    for (let off = 0; off < blob.size; off += PART) {
      const r = await alo.saveChunk({ token: st.token, data: bytesToB64(new Uint8Array(await blob.slice(off, off + PART).arrayBuffer())) });
      if (!r.ok) throw new Error('запись');
    }
    const r = await alo.saveEnd({ token: st.token });
    if (!r.ok) throw new Error('запись');
    toast(r.shared ? 'Выбери, куда сохранить' : `Сохранено в «Загрузки/alloconnect»: ${name}`);
    L('file', { saved: blob.size });
    return true;
  } catch (e) {
    alo.saveEnd({ token: st.token, cancel: true });
    toast('Не удалось сохранить: ' + e.message);
    return false;
  }
}

function waitLow(fdc) {
  return new Promise((res) => {
    const done = () => { fdc.removeEventListener('bufferedamountlow', done); clearInterval(t); res(); };
    const t = setInterval(() => { if (fdc.readyState !== 'open' || fdc.bufferedAmount < (4 << 20)) done(); }, 200);
    fdc.addEventListener('bufferedamountlow', done);
  });
}

class FileChan {
  constructor(fdc, getConvFn, handlers = {}) {
    this.fdc = fdc;
    this.getConv = getConvFn;
    this.handlers = handlers;
    this.incoming = new Map();
    this.outgoing = [];
    this.sending = null;
    fdc.binaryType = 'arraybuffer';
    fdc.bufferedAmountLowThreshold = 1 << 20;
    this.lastActive = Date.now();
    fdc.addEventListener('message', (e) => { this.lastActive = Date.now(); this.onMsg(e.data); });
    fdc.addEventListener('close', () => this.fail('связь прервалась'));
  }
  queue(list, p = 'chat', extra = {}) {
    for (const f of list) {
      if (!f) continue;
      if (f.size > MAX_FILE) { toast(`${f.name}: больше 2 ГБ — не отправлю`); continue; }
      const name = f.name || `картинка-${Date.now()}.png`;
      const meta = { fid: extra.fid ?? crypto.getRandomValues(new Uint32Array(1))[0], name, size: f.size, mime: f.type || 'application/octet-stream', p }; // fid — общий, если файл уходит нескольким (группа)
      if (extra.pl) meta.pl = extra.pl; // картинка/видео на экран друга: место
      if (extra.st && p === 'chat') meta.st = 1; // стикер (ПК 1.21): у получателя — без плашки файла
      if (p === 'screenvid') { meta.vol = extra.vol; meta.snd = extra.snd ? 1 : 0; }
      meta.kind = fileKind(meta.mime);
      const conv = this.getConv();
      const baseUi = extra.ui || ((p === 'chat' || p === 'sound') && conv ? fileBubble(conv, S.nick || 'Я', meta, true, { mid: fmid(meta.fid) }) : NOUI);
      const ui = ['avatar'].includes(p) ? baseUi : trackTransfer(meta, 'out', baseUi);
      ui.progress(0);
      this.outgoing.push({ file: f, meta, ui, conv });
    }
    this.pump();
  }
  async pump() {
    if (this.sending) return;
    while (this.outgoing.length) {
      const job = this.outgoing.shift();
      this.sending = job;
      const fdc = this.fdc;
      try {
        if (job.cancelled || fdc.readyState !== 'open') throw new Error('нет связи');
        fdc.send(JSON.stringify({ t: 'file-start', fid: job.meta.fid, name: job.meta.name, size: job.meta.size, mime: job.meta.mime, p: job.meta.p, pl: job.meta.pl, vol: job.meta.vol, snd: job.meta.snd, st: job.meta.st }));
        let last = 0;
        for (let off = 0; off < job.meta.size; off += CHUNK) {
          if (fdc.bufferedAmount > (8 << 20)) await waitLow(fdc);
          if (job.cancelled || fdc.readyState !== 'open') throw new Error('связь прервалась');
          const buf = await job.file.slice(off, off + CHUNK).arrayBuffer();
          if (job.cancelled || fdc.readyState !== 'open') throw new Error('передача остановлена');
          const pkt = new Uint8Array(4 + buf.byteLength);
          new DataView(pkt.buffer).setUint32(0, job.meta.fid);
          pkt.set(new Uint8Array(buf), 4);
          fdc.send(pkt.buffer);
          if (Date.now() - last > 150) { job.ui.progress(off + buf.byteLength); last = Date.now(); }
        }
        fdc.send(JSON.stringify({ t: 'file-end', fid: job.meta.fid }));
        this.lastActive = Date.now();
        if (job.meta.p !== 'chat' && job.meta.p !== 'sound') job.ui.done?.();
        else if (job.ui !== NOUI) {
          job.ui.done(URL.createObjectURL(job.file), job.file);
          record(job.conv, { mid: fmid(job.meta.fid), ts: Date.now(), who: 'me', nick: S.nick, type: 'file', name: job.meta.name, ...(job.meta.st ? { st: 1 } : {}) });
        }
        L('file', { sent: job.meta.kind, size: job.meta.size, p: job.meta.p });
      } catch (e) {
        job.ui.fail(e.message);
        L('file', { sendFailed: e.message });
      }
      this.sending = null;
    }
  }
  onMsg(data) {
    if (typeof data === 'string') {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      if (m.t === 'file-start') {
        if(!Number.isInteger(m.fid)||m.fid<0||m.fid>0xffffffff||!Number.isSafeInteger(m.size)||m.size<0)return;
        const p = ['chat', 'sound', 'avatar', 'screenimg', 'screenvid'].includes(m.p) ? m.p : 'chat';
        const meta = { fid: m.fid >>> 0, name: String(m.name || 'файл').slice(0, 200), size: Math.max(0, Number(m.size) || 0), mime: String(m.mime || 'application/octet-stream').slice(0, 100), p };
        // поверх моего показа: место, громкость (как у ПК); видео без разрешения или слишком большое — сразу отказ
        if (p === 'screenimg' || p === 'screenvid') { meta.pl = m.pl && typeof m.pl === 'object' ? m.pl : null; meta.vol = Number(m.vol) || 0; meta.snd = !!m.snd; }
        if(p==='screenvid'&&ovlVideoCancelled(meta.fid))return;
        if (p === 'screenvid' && (!SH || !myPerm().react || meta.size > SVID_IN_MAX)) { send({ t: 'svid-no', why: !SH ? 'busy' : !myPerm().react ? 'off' : 'big' }); return; }
        if (p === 'chat' && m.st === 1 && /^image\/(gif|png|jpeg|webp)$/.test(meta.mime) && meta.size <= 3 * 1024 * 1024) meta.st = 1; // стикер
        if (meta.size > MAX_FILE) return;
        if ((p === 'avatar' && meta.size > 2 * 1024 * 1024) || (p === 'screenimg' && meta.size > 8 * 1024 * 1024)) return;
        meta.kind = fileKind(meta.mime);
        const previous=this.incoming.get(meta.fid);
        if(previous){previous.ui.fail('передача заменена');this.incoming.delete(meta.fid);}
        const conv = this.getConv();
        const from = this.handlers.from?.(); // в группе — кто прислал
        const baseUi = (p === 'chat' || p === 'sound') && conv ? fileBubble(conv, from?.nick || conv.nick, meta, false, { mid: fmid(meta.fid),who:from?.who||'peer' }) : NOUI;
        const ui = p === 'avatar' ? baseUi : trackTransfer(meta, 'in', baseUi);
        ui.progress(0);
        this.incoming.set(meta.fid, { meta, parts: [], got: 0, ui, last: 0, conv, from });
      } else if (m.t === 'file-end') {
        if (!Number.isInteger(m.fid) || m.fid < 0 || m.fid > 0xffffffff) return;
        const e = this.incoming.get(m.fid >>> 0);
        if (!e) return;
        this.incoming.delete(m.fid >>> 0);
        if(e.got!==e.meta.size){e.ui.fail('файл получен не полностью');return;}
        const safeMime = /svg|html|xml/i.test(e.meta.mime) ? 'application/octet-stream' : e.meta.mime;
        if (safeMime !== e.meta.mime) e.meta.kind = 'file';
        const blob = new Blob(e.parts, { type: safeMime });
        L('file', { received: e.meta.kind, size: e.got, p: e.meta.p });
        if (e.meta.p !== 'chat' && e.meta.p !== 'sound') { e.ui.done(); this.handlers[e.meta.p]?.(blob, e.meta); return; }
        e.ui.done(URL.createObjectURL(blob), blob);
        const from = this.handlers.from?.();
        record(e.conv, { mid: fmid(e.meta.fid), ts: Date.now(), who: from?.who || 'peer', nick: from?.nick || e.conv?.nick, type: 'file', name: e.meta.name, ...(e.meta.st ? { st: 1 } : {}) });
        this.handlers.chatIn?.(e.conv, e.meta);
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return;
    const fid = new DataView(data).getUint32(0);
    const e = this.incoming.get(fid);
    if (!e) return;
    e.parts.push(data.slice(4));
    e.got += data.byteLength - 4;
    if (e.got > e.meta.size) { this.incoming.delete(fid); e.ui.fail('ошибка размера'); return; }
    if (Date.now() - e.last > 150) { e.ui.progress(e.got); e.last = Date.now(); }
  }
  fail(why) {
    if (this.sending) this.sending.cancelled = true;
    for (const [, e] of this.incoming) e.ui.fail(why);
    this.incoming.clear();
    for (const j of this.outgoing.splice(0)) j.ui.fail(why);
  }
}

/* =========================================================
   Саундпад (как у ПК): звуки хранятся на телефоне (IndexedDB), в звонке подмешиваются в голос.
   Пока звук играет, в звонок идёт смесь «микрофон + звуки» (WebAudio), потом снова чистый микрофон —
   обычный голос не проходит через лишнюю обработку. Поделиться звуком — файл с p:'sound', как у ПК.
   ========================================================= */
const spDb = (() => {
  let dbp = null;
  const open = () => (dbp = dbp || new Promise((res, rej) => {
    const r = indexedDB.open('aloc-sounds', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sounds', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('sounds', mode);
      const req = fn(t.objectStore('sounds'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx('readonly', (s) => s.getAll()),
    get: (id) => tx('readonly', (s) => s.get(id)),
    put: (v) => tx('readwrite', (s) => s.put(v)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
  };
})();

let spList = [];             // { id, name, vol, mime, ext, at } — без самих байтов
const spBuffers = new Map(); // id → AudioBuffer
const spPlaying = new Map(); // id → AudioBufferSourceNode
let spNodes = null;          // { bus, mon, dest, micSrc, mic }
let spEditId = null;
let spCategory = '', spBatchEdit = false;
const spSelected = new Set();
let spBackTimer = null;
const SOUND_MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };

function spNodesGet() {
  const c = audio();
  if (!spNodes) {
    spNodes = { bus: c.createGain(), mon: c.createGain(), dest: c.createMediaStreamDestination(), micSrc: null, mic: null };
    spNodes.dest.channelCount = 1;
    spNodes.bus.connect(spNodes.dest);
    spNodes.mon.connect(c.destination);
    spUpdateGains();
  }
  // микрофон звонка → в ту же смесь (выключенный микрофон даёт тишину — звуки всё равно идут)
  const mt = micSendTrack();
  if (mt && spNodes.mic !== mt) {
    try { spNodes.micSrc?.disconnect(); } catch { /* */ }
    spNodes.micSrc = c.createMediaStreamSource(new MediaStream([mt]));
    spNodes.micSrc.connect(spNodes.dest);
    spNodes.mic = mt;
  }
  return spNodes;
}

function spUpdateGains() {
  if (!spNodes) return;
  const o = settings();
  spNodes.bus.gain.value = (S.muted || S.deafened) && !o.spWhenMuted ? 0 : (Number(o.spVolOut) || 0) / 100;
  spNodes.mon.gain.value = o.spMonitor && !S.deafened ? (Number(o.spVolMon) || 0) / 100 : 0;
}

async function spLoadList() {
  try { spList = ((await spDb.all()) || []).map(({ blob, ...rest }) => rest).sort((a, b) => a.at - b.at); } catch (e) { console.warn('sounds', e); spList = []; }
  spRender();
}

function spRender() {
  const g = $('spGrid');
  g.replaceChildren();
  $('spEmpty').classList.toggle('hidden', spList.length > 0);
  spRenderBatch();
  for (const s of spList.filter(s => !spCategory || (s.category || '') === spCategory)) {
    const t = document.createElement('div');
    t.className = 'sp-tile' + (spPlaying.has(s.id) ? ' playing' : '');
    t.dataset.id = s.id;
    if (spBatchEdit && spSelected.has(s.id)) t.style.outline = '3px solid var(--accent, #88aaff)';
    const n = document.createElement('div');
    n.className = 'sp-name';
    n.textContent = s.name;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sp-more';
    more.textContent = '⋯';
    more.setAttribute('aria-label', 'Настроить');
    more.onclick = (e) => { e.stopPropagation(); spOpenEdit(s.id); };
    t.append(n, more);
    t.onclick = () => { if (spBatchEdit) { if(spSelected.has(s.id)) spSelected.delete(s.id); else spSelected.add(s.id); spRender(); } else if(spPlaying.has(s.id)) spStop(s.id); else spPlay(s.id); };
    t.oncontextmenu = (e) => { e.preventDefault(); spOpenEdit(s.id); }; // долгое нажатие
    g.appendChild(t);
  }
  $('btnSoundpad').classList.toggle('on', spPlaying.size > 0);
}

async function spGetBuffer(id) {
  if (spBuffers.has(id)) return spBuffers.get(id);
  const rec = await spDb.get(id);
  if (!rec) throw new Error('звук не найден');
  const buf = await audio().decodeAudioData(await rec.blob.arrayBuffer());
  spBuffers.set(id, buf);
  return buf;
}

// в звонок: пока что-то играет — смесь, потом (через секунду тишины) обратно чистый микрофон
async function spRoute() {
  if (G.active) { clearTimeout(spBackTimer); if (spPlaying.size) grpResendMic(); else spBackTimer = setTimeout(() => { if (!spPlaying.size) grpResendMic(); }, 1000); return; }
  if (!S.tx) return;
  clearTimeout(spBackTimer);
  if (spPlaying.size) {
    const t = spNodesGet().dest.stream.getAudioTracks()[0];
    if (S.tx.mic.sender.track !== t) {
      await S.tx.mic.sender.replaceTrack(t).catch((e) => L('soundpad', { routeFailed: e.message }));
      tuneAudioSender(S.tx.mic.sender, 128_000); // музыка не превращается в кашу
    }
  } else {
    spBackTimer = setTimeout(async () => {
      if (spPlaying.size || !S.tx) return;
      await S.tx.mic.sender.replaceTrack(micSendTrack()).catch(() => {});
      tuneAudioSender(S.tx.mic.sender, 64_000);
    }, 1000);
  }
}

async function spPlay(id) {
  const s = spList.find((x) => x.id === id);
  if (!s) return;
  try {
    const buf = await spGetBuffer(id);
    spStop(id, true);
    const c = audio();
    const nodes = spNodesGet();
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = (Number(s.vol) || 100) / 100;
    src.connect(g);
    g.connect(nodes.bus);
    g.connect(nodes.mon);
    src.onended = () => { if (spPlaying.get(id) === src) { spPlaying.delete(id); spRender(); spRoute(); } };
    spPlaying.set(id, src);
    src.start();
    spRender();
    spRoute();
    L('soundpad', { play: true, dur: Math.round(buf.duration * 10) / 10 });
  } catch (e) {
    toast(`Не удалось воспроизвести «${s.name}»: ${e.message || e}`);
    L('soundpad', { playFailed: e.message || String(e) });
  }
}

function spStop(id, quiet) {
  const src = spPlaying.get(id);
  if (!src) return;
  spPlaying.delete(id);
  try { src.stop(); } catch { /* */ }
  if (!quiet) { spRender(); spRoute(); }
}
function spStopAll() { for (const id of [...spPlaying.keys()]) spStop(id); }

// AudioBuffer → WAV 16 бит (как у ПК 1.17). Не влезает в max — сначала моно, потом обрезаем
function toWav(buf, max) {
  let ch = Math.min(2, buf.numberOfChannels);
  const rate = buf.sampleRate;
  if (44 + buf.length * ch * 2 > max) ch = 1;
  const frames = Math.min(buf.length, Math.floor((max - 44) / (ch * 2)));
  const out = new DataView(new ArrayBuffer(44 + frames * ch * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + frames * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, frames * ch * 2, true);
  const data = [];
  for (let c = 0; c < buf.numberOfChannels; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let v = ch === 1 && data.length > 1 ? (data[0][i] + data[1][i]) / 2 : data[c][i];
      v = Math.max(-1, Math.min(1, v));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return { bytes: new Uint8Array(out.buffer), cut: frames < buf.length, sec: frames / rate };
}
const SP_VIDEO = /\.(mp4|m4v|mkv|mov|3gp|webm)$/i;
const SP_SOUND_MAX = 15 * 1024 * 1024; // как у ПК (SOUND_MAX)

async function spAddFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!f) continue;
    const ext = ((/\.(\w+)$/.exec(f.name || '') || [])[1] || '').toLowerCase();
    // видео — берём из него звук (как ПК 1.17)
    const isVideo = /^video\//.test(f.type) || (SP_VIDEO.test(f.name || '') && !/^audio\//.test(f.type));
    if (!isVideo && !/^audio\//.test(f.type) && !SOUND_MIME[ext]) { toast(`${f.name}: это не звук и не видео`); continue; }
    if (isVideo ? f.size > 300 * 1024 * 1024 : f.size > 20 * 1024 * 1024) { toast(`${f.name}: слишком большой для саундпада`); continue; }
    try {
      let bytes = await f.arrayBuffer();
      // проверяем, что файл вообще декодируется (у видео заодно достаём звуковую дорожку)
      const buf = await audio().decodeAudioData(bytes.slice(0)).catch(() => { throw new Error(isVideo ? 'в видео нет звука или формат не читается' : 'не получилось прочитать звук'); });
      let mime = f.type || SOUND_MIME[ext] || 'audio/mpeg', sext = ext || 'mp3';
      if (isVideo || bytes.byteLength > SP_SOUND_MAX) {
        const r = toWav(buf, SP_SOUND_MAX);
        bytes = r.bytes.buffer;
        mime = 'audio/wav'; sext = 'wav';
        if (r.cut) toast(`${f.name}: звук длинный — взяты первые ${Math.floor(r.sec)} с`);
      }
      const id = newMid();
      const name = String(f.name || 'звук').replace(/\.\w+$/, '').slice(0, 40) || 'звук';
      await spDb.put({ id, name, vol: 100, mime, ext: sext, at: Date.now(), blob: new Blob([bytes], { type: mime }) });
      added++;
    } catch (e) { toast(`${f.name}: ${e.message || 'не получилось добавить'}`); }
  }
  if (added) { toast(added === 1 ? 'Звук добавлен' : `Добавлено звуков: ${added}`); await spLoadList(); }
  return added;
}

function spOpenEdit(id) {
  const s = spList.find((x) => x.id === id);
  if (!s) return;
  spEditId = id;
  $('spEditName').value = s.name;
  $('spEditCategory').value = s.category || '';
  $('spEditVol').value = s.vol || 100;
  $('spEdit').classList.remove('hidden');
}
async function spSaveEdit() {
  const id = spEditId;
  spEditId = null;
  $('spEdit').classList.add('hidden');
  const rec = id && await spDb.get(id);
  if (!rec) return;
  rec.category = $('spEditCategory').value.trim().slice(0,40);
  rec.name = $('spEditName').value.trim().slice(0, 40) || rec.name;
  rec.vol = Math.max(0, Math.min(200, Number($('spEditVol').value) || 100));
  await spDb.put(rec);
  await spLoadList();
}

// поделиться звуком с другом в звонке — у него «➕ В саундпад» (как у ПК)
async function spShare(id) {
  const rec = await spDb.get(id);
  if (!rec) return;
  if (!S.connected || !S.fileChan) { toast('Поделиться звуком можно в звонке'); return; }
  const mime = SOUND_MIME[rec.ext] || rec.mime || 'audio/mpeg';
  S.fileChan.queue([new File([rec.blob], `${rec.name}.${rec.ext || 'mp3'}`, { type: mime })], 'sound');
  toast(`«${rec.name}» отправлен ${S.friendNick} — он сможет добавить его в свой саундпад`);
}

function spOpen(open = $('soundpad').classList.contains('hidden')) {
  $('soundpad').classList.toggle('hidden', !open);
  if (open) {
    if (S.chatOpen) toggleChat(false); // вдвоём с чатом на экране телефона тесно
    const o = settings();
    $('spVolOut').value = o.spVolOut;
    $('spMonitor').checked = !!o.spMonitor;
    $('spVolMon').value = o.spVolMon;
    $('spWhenMuted').checked = !!o.spWhenMuted;
    spLoadList();
  } else $('spEdit').classList.add('hidden');
}


async function spBatch(action, category) {
  if(spBatch.busy)return;spBatch.busy=true;try {
  const ids=[...spSelected];
  for(const id of ids){const rec=await spDb.get(id);if(!rec)continue;
    if(action==='delete'){spStop(id);await spDb.del(id);spBuffers.delete(id);}
    else if(action==='copy')await spDb.put({...rec,id:newMid(),name:rec.name+' (копия)',at:Date.now()});
    else if(action==='category')await spDb.put({...rec,category:String(category||'').trim().slice(0,40)});
  }
  spSelected.clear();await spLoadList();
  } finally {spBatch.busy=false;}
}
function spRenderBatch(){
 const bar=$('spBatchBar');if(!bar)return;bar.replaceChildren();
 const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.className='btn small-btn';b.textContent=text;b.onclick=fn;bar.appendChild(b);return b;};
 const cats=[...new Set(spList.map(s=>s.category||'').filter(Boolean))].sort();
 if(spCategory&&!cats.includes(spCategory))spCategory='';
 const filter=document.createElement('select');filter.setAttribute('aria-label','Категория звуков');
 for(const [value,text] of [['','Все категории'],...cats.map(c=>[c,c])]){const o=document.createElement('option');o.value=value;o.textContent=text;filter.appendChild(o);}filter.value=spCategory;filter.onchange=()=>{spCategory=filter.value;spSelected.clear();spRender();};bar.appendChild(filter);
 button(spBatchEdit?'Готово':'Редактировать',()=>{spBatchEdit=!spBatchEdit;spSelected.clear();spRender();});
 if(!spBatchEdit)return;
 button('Выбрать все',()=>{for(const s of spList.filter(s=>!spCategory||(s.category||'')===spCategory))spSelected.add(s.id);spRender();});
 const input=document.createElement('input');input.placeholder='Категория';input.maxLength=40;input.setAttribute('aria-label','Категория выбранных звуков');bar.appendChild(input);
 const run=(action)=>spBatch(action,input.value).catch(e=>toast('Не удалось изменить звуки: '+e.message));
 for(const [text,action] of [['Назначить категорию','category'],['Копировать','copy'],['Удалить','delete']]){const b=button(text,()=>run(action));b.disabled=!spSelected.size;if(action==='delete')confirmBtn(b,'Точно удалить выбранные?',()=>run(action));}
}

function spBind() {
  const bar=document.createElement('div');bar.id='spBatchBar';bar.className='row';bar.style.flexWrap='wrap';$('spGrid').before(bar);
  $('btnSoundpad').onclick = () => spOpen();
  $('spClose').onclick = () => spOpen(false);
  $('spAdd').onclick = () => $('spFile').click();
  $('spFile').onchange = (e) => { spAddFiles([...e.target.files]); e.target.value = ''; };
  $('spStop').onclick = () => spStopAll();
  const saveOpt = () => {
    store.set('settings', { ...settings(), spVolOut: Number($('spVolOut').value), spMonitor: $('spMonitor').checked, spVolMon: Number($('spVolMon').value), spWhenMuted: $('spWhenMuted').checked });
    spUpdateGains();
  };
  for (const el of ['spVolOut', 'spMonitor', 'spVolMon', 'spWhenMuted']) $(el).addEventListener('input', saveOpt);
  $('spEditDone').onclick = () => spSaveEdit();
  $('spEditShare').onclick = async () => { const id = spEditId; await spSaveEdit(); if (id) spShare(id); };
  $('spEditDel').onclick = async () => {
    const id = spEditId;
    spEditId = null;
    $('spEdit').classList.add('hidden');
    if (!id) return;
    spStop(id);
    spBuffers.delete(id);
    await spDb.del(id);
    await spLoadList();
  };
}

/* =========================================================
   Аватарки (как у десктопа: хэш = sha256 первые 16 hex)
   ========================================================= */
const avCache = new Map();
let myAvatar = store.get('av.me', null); // { hash, mime, b64 }
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
async function sha16(bytes) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); return [...h].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16); }
function friendAvatar(id) {
  if (!id) return null;
  if (avCache.has(id)) return avCache.get(id);
  const a = store.get('av.' + id, null);
  const v = a ? { hash: a.hash, url: URL.createObjectURL(new Blob([b64ToBytes(a.b64)], { type: a.mime })) } : null;
  avCache.set(id, v);
  return v;
}
function paintAvatar(el, url) {
  if (!el) return;
  el.style.backgroundImage = url ? `url("${url}")` : '';
  el.classList.toggle('has-img', !!url);
  window.talkingAvatar?.bind(el, url);
}
function myAvatarUrl() {
  if (!myAvatar) return null;
  if (!myAvatar.url) myAvatar.url = URL.createObjectURL(new Blob([b64ToBytes(myAvatar.b64)], { type: myAvatar.mime }));
  return myAvatar.url;
}
function refreshAvatars() {
  paintAvatar(document.querySelector('#meCard .avatar'), myAvatarUrl());
  paintAvatar($('myAvPrev'), myAvatarUrl());
  $('myAvPrev')?.querySelector('span') && ($('myAvPrev').querySelector('span').textContent = myAvatar ? '' : initial($('nick').value || 'Я'));
  $('myAvClear')?.classList.toggle('hidden', !myAvatar);
  const pid = S.peerIdent?.id;
  paintAvatar(document.querySelector('#friendCard .avatar'), pid && S.connected ? friendAvatar(pid)?.url : null);
  if (S.friendCall) paintAvatar($('callAvatar'), friendAvatar(S.friendCall.id)?.url);
  for (const el of document.querySelectorAll('#friendsList .favatar')) paintAvatar(el, friendAvatar(el.dataset.id)?.url);
  if (G.active) for (const id of G.tiles.keys()) grpPaintAvatar(id);
}
function onPeerAvatarHash(id, av, want) {
  if (!id) return;
  const cur = friendAvatar(id);
  if (!av) { if (cur) { store.del('av.' + id); avCache.set(id, null); refreshAvatars(); } return; }
  if (!cur || cur.hash !== av) want();
}
async function onAvatarFile(id, blob, meta) {
  if (!id || !/^image\/(png|jpeg|webp|gif)$/.test(meta.mime)) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = await sha16(bytes);
  store.set('av.' + id, { hash, mime: meta.mime, b64: bytesToB64(bytes) });
  avCache.set(id, { hash, url: URL.createObjectURL(blob) });
  refreshAvatars();
}
function myAvatarFile() {
  return myAvatar ? new File([b64ToBytes(myAvatar.b64)], 'avatar', { type: myAvatar.mime }) : null;
}
async function pickAvatar(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) { toast('Нужна картинка: png, jpg, webp или gif'); return; }
  let bytes, mime;
  try {
    if (file.type === 'image/gif') {
      // как у ПК 1.17: большая гифка уменьшается сама (gif-shrink.js). Друзья принимают до 2 МБ, но своя хранится
      // в localStorage (~5 МБ на всё, там же история) — держим 1 МБ
      const AV_LIMIT = 1024 * 1024;
      if (file.size > 60 * 1024 * 1024) { toast('Гифка больше 60 МБ — выбери поменьше'); return; }
      if (file.size <= AV_LIMIT) bytes = new Uint8Array(await file.arrayBuffer());
      else {
        toast('Гифка большая — уменьшаю…');
        bytes = await window.shrinkGif?.(file, AV_LIMIT);
        if (!bytes) { toast('Не получилось уменьшить гифку — выбери поменьше'); return; }
        L('avatar', { gifShrunk: true, fromKB: Math.round(file.size / 1024), toKB: Math.round(bytes.length / 1024) });
      }
      mime = 'image/gif';
    } else {
      // обрезаем по центру в квадрат 256×256
      const bmp = await createImageBitmap(file);
      const side = Math.min(bmp.width, bmp.height);
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
      bytes = new Uint8Array(await blob.arrayBuffer());
      mime = blob.type || 'image/webp';
    }
    const hash = await sha16(bytes);
    if (myAvatar?.url) URL.revokeObjectURL(myAvatar.url);
    myAvatar = { hash, mime, b64: bytesToB64(bytes) };
    store.set('av.me', { hash, mime, b64: myAvatar.b64 });
    refreshAvatars();
    if(window.accountLab?.engine.account)await window.accountLab.sync.mutate(async()=>{});
    announceAvatar(hash);
    L('avatar', { set: true });
    toast('Аватарка сохранена — друзья увидят её при следующей связи');
  } catch (e) { toast('Не получилось: ' + (e.message || e)); }
}
async function clearAvatar() {
  if (myAvatar?.url) URL.revokeObjectURL(myAvatar.url);
  myAvatar = null;
  store.del('av.me');
  refreshAvatars();
  if(window.accountLab?.engine.account)await window.accountLab.sync.mutate(async()=>{});
  announceAvatar('');
}
function announceAvatar(hash) {
  if (S.connected) send({ t: 'av-hash', av: hash });
  for (const l of links.values()) { try { if (l.dc.readyState === 'open') l.dc.send(JSON.stringify({ t: 'ident', av: hash })); } catch { /* */ } }
}

/* =========================================================
   Друзья: список, звонок в один клик, входящие
   ========================================================= */
let friendsList = [];
let myIdent = null;
const isFriend = (id) => friendsList.some((f) => f.id === id);

async function outboxDelivered(data){
  if(!data?.id||!cleanMid(data.mid))return;const conv=getConv(data.id);const item=conv.msgs?.get(data.mid);if(item){item.el.querySelector('.undel')?.remove();item.el.classList.remove('sending');setTickEl(item.el,'sent');}if(histGet(conv.id).find(e=>e.mid===data.mid)?.st!=='read')recordStatus(conv,data.mid,'sent');await alo.outboxAck({id:data.id,mid:data.mid});
}
async function restoreOutbox(){const state=await alo.outboxState();for(const receipt of state.delivered||[])await outboxDelivered(receipt);}
async function bindPresence(){
 const current=await alo.presenceGet();myPresence=presenceNames[current.mode]?current.mode:'online';$('presenceMode').value=myPresence;
 $('presenceMode').onchange=async()=>{const select=$('presenceMode'),previous=myPresence;select.disabled=true;try{const mode=select.value,result=await alo.presenceSet({mode});if(!result.ok)throw Error('Не удалось сменить статус');myPresence=mode;stopRing();}catch(e){select.value=previous;toast(e.message);}finally{select.disabled=false;}};
 let lastTouch=0;const touch=()=>{if(Date.now()-lastTouch<10000)return;lastTouch=Date.now();alo.presenceTouch();};document.addEventListener('pointerdown',touch,{passive:true});document.addEventListener('keydown',touch);
}
async function initFriends() {
  alo.on('friends', (e) => { friendsList = e.list || []; renderFriends(); updateDmHead(); });
  alo.on('friendMsg',async e=>{if(e.inboxKey&&!myIdent?.id)return;try{await onFriendMsg(e);if(e.inboxKey)await alo.inboxAck({key:e.inboxKey});}catch(error){L('inbox',{applyError:String(error.message)});}});
  alo.on('stun', (info) => { S.netStun = info; });
  alo.netConfig(netCfg());
  for (let i = 0; i < 30 && !myIdent?.id; i++) {
    myIdent = await alo.friendsInfo();
    if (!myIdent?.id) await new Promise((r) => setTimeout(r, 300));
  }
  if (myIdent?.id) { friendsList = myIdent.list || []; renderFriends(); }
  L('friends', { ready: !!myIdent?.id, friends: friendsList.length });
}
function netCfg() {
  const o = settings();
  return { noStun: !!o.noStun, stunAlt: !!o.stunAlt, stunCustom: STUN_LISTS.parse(o.stunCustom), relayUrl: o.relayUrl || '' };
}

function renderFriends() {
  const box = $('friendsBox');
  box.classList.toggle('hidden', friendsList.length === 0);
  const list = $('friendsList');
  list.innerHTML = '';
  const sorted = [...friendsList].filter(f=>!window.accountLab?.ownDeviceIds().includes(f.id)).sort((a, b) => (b.online - a.online) || a.nick.localeCompare(b.nick));
  for (const f of sorted) {
    const row = document.createElement('div');
    row.className = 'friend' + (f.online ? ' online' : '');
    const av = document.createElement('div');
    av.className = 'avatar favatar';
    av.dataset.id = f.id;
    const avi = document.createElement('span');
    avi.textContent = initial(f.nick);
    const dot = document.createElement('i');
    dot.className = 'fdot';
    av.append(avi, dot);
    paintAvatar(av, friendAvatar(f.id)?.url);
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = f.nick;
    const st = document.createElement('small');
    st.textContent = f.online ? (presenceNames[f.presence]||'В сети') + (f.act?.game ? ` · 🎮 ${f.act.game}` : '') : (f.lastSeen ? 'не в сети' : 'ещё не был в сети');
    name.appendChild(st);
    name.onclick = () => friendMenu(f);
    const chat = document.createElement('button');
    chat.className = 'btn fchat';
    chat.textContent = '💬';
    const unread = convs.get(f.id)?.unread || 0;
    if (unread) { const b = document.createElement('i'); b.className = 'badge'; b.textContent = unread > 99 ? '99+' : String(unread); chat.appendChild(b); }
    chat.onclick = () => openDm(f.id);
    const call = document.createElement('button');
    call.className = 'btn primary';
    call.textContent = 'Позвонить';
    call.onclick = () => callFriend(f.id);
    row.append(av, name, chat, call);
    list.appendChild(row);
  }
}
function friendMenu(f) {
  const nick = prompt(`Имя друга (пусто — удалить ${f.nick} из друзей):`, f.nick);
  if (nick == null) return;
  if (!nick.trim()) { if (confirm(`Удалить ${f.nick} из друзей?`)) alo.friendsRemove({ id: f.id }).then(()=>{const conv=getConv(f.id);for(const e of histGet(f.id)){if(e.st==='queued'){const item=conv.msgs?.get(e.mid);if(item){item.el.querySelector('.tick')?.remove();markUndelivered(item.el);}recordStatus(conv,e.mid,'fail');}}}).catch(e=>toast(e.message||'Не удалось удалить контакт')); return; }
  alo.friendsRename({ id: f.id, nick: nick.trim().slice(0, 24) });
}

// Keep unfinished forms intact while an incoming call owns the screen.
const incomingCallOverlays = new Set();
function suspendCallOverlays() {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement) focused.blur();
  for (const el of document.querySelectorAll('.modal:not(.hidden), .sheet:not(.hidden), .sheet-back:not(.hidden)')) {
    if (el.id === 'callModal' || el.id === 'gInvModal') continue;
    incomingCallOverlays.add(el);
    el.classList.add('hidden');
  }
  alo.hideKeyboard();
}
function restoreCallOverlays() {
  for (const el of incomingCallOverlays) if (el.isConnected) el.classList.remove('hidden');
  incomingCallOverlays.clear();
}
function showIncomingCallModal(id) {
  suspendCallOverlays();
  const modal = $(id);
  modal.classList.remove('hidden');
  modal.tabIndex = -1;
  modal.focus({ preventScroll: true });
}

function showCallModal(dir, nick) {
  if (!dialogOpeners.has($('callModal'))) dialogOpeners.set($('callModal'), document.activeElement);
  if (dir === 'in') showIncomingCallModal('callModal');
  else $('callModal').classList.remove('hidden');
  $('callAvatar').querySelector('span').textContent = initial(nick);
  paintAvatar($('callAvatar'), S.friendCall?.id ? friendAvatar(S.friendCall.id)?.url : null);
  $('callTitle').textContent = dir === 'in' ? `${nick} звонит` : `Звоним ${nick}`;
  $('callSub').textContent = dir === 'in' ? 'Входящий звонок' : 'Связываемся…';
  $('btnCallAccept').classList.toggle('hidden', dir !== 'in');
  $('btnCallDecline').classList.toggle('hidden', dir !== 'in');
  $('btnCallCancel').classList.toggle('hidden', dir === 'in');
  focusOpenedDialog($('callModal'));
}
function hideCallModal() {
  $('callModal').classList.add('hidden');
  if (!S.inCall && !G.active) restoreCallOverlays();
  if (dialogOpeners.has($('callModal'))) restoreDialogFocus($('callModal'));
  stopRing();
  if (S.friendCall?.timer) clearTimeout(S.friendCall.timer);
  if (S.friendCall?.setupTimer) clearTimeout(S.friendCall.setupTimer);
}
function endFriendCall(text) {
  const fc = S.friendCall;
  if (!S.connected) { S.callSetup = null; S.answerWhenFree = null; S.busy = false; }
  hideCallModal();
  S.friendCall = null;
  if (!S.connected) {
    clearTimeout(S.connectTimer);
    closePc();
    releaseMic();
    if (!S.inCall) showStep('stepHome');
  }
  if (text) { toast(text); L('friend-call', { ended: true, dir: fc?.dir }); }
  updateService();
}
async function callFriend(id, rejoin = false) {
  if (S.busy || S.pc || S.friendCall || S.inCall) return;
  const f = friendsList.find((x) => x.id === id);
  if (!f) return;
  S.nick = $('nick').value.trim() || 'Без имени';
  if (S.rejoin?.id === id) { S.rejoin = null; showRejoin(); }
  S.friendCall = { id, nick: f.nick, dir: 'out', rejoin, cid: makeCallAttemptId() };
  const attempt = S.friendCall;
  attempt.setupTimer = setTimeout(() => {
    if (S.friendCall !== attempt || S.connected) return;
    alo.friendsSend({ id: attempt.id, msg: callEnvelope(attempt, { t: 'cancel' }) });
    endFriendCall('Не удалось установить звонок — попробуйте снова');
  }, 65000);
  L('friend-call', { out: true, friendOnline: f.online, addrKinds: f.addrKinds });
  showCallModal('out', f.nick);
  updateService();
  startInvite();
}
async function sendFriendInvite(code) {
  const fc = S.friendCall;
  if (!fc || fc.dir !== 'out') return; // встречный звонок уже принят — своё приглашение не шлём
  $('callSub').textContent = 'Отправляю вызов…';
  const r = await alo.friendsSend({ id: fc.id, msg: callEnvelope(fc, { t: 'call', code, nick: S.nick, ...(fc.rejoin ? { rejoin: 1 } : {}) }) });
  if (S.friendCall !== fc) return;
  if (!r.ok) { endFriendCall(`${fc.nick} не отвечает — у него закрыт alloconnect или до него не достучаться`); return; }
  $('callSub').textContent = 'Вызов доставлен — ждём ответа';
  startRing('out');
  fc.timer = setTimeout(() => {
    if (S.friendCall !== fc) return;
    alo.friendsSend({ id: fc.id, msg: callEnvelope(fc, { t: 'cancel' }) });
    endFriendCall(`${fc.nick} не ответил`);
  }, 40000);
}

// Идентификатор относится к одной попытке, а не ко всем звонкам этого друга.
const cancelledCallAttempts = new Map();
function makeCallAttemptId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
function validCallAttempt(cid) { return typeof cid === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cid); }
function callEnvelope(fc, msg) { return validCallAttempt(fc?.cid) ? { ...msg, cid: fc.cid } : msg; }
function callControlMatches(fc, msg) {
  if (!fc) return false;
  if (msg.cid == null) return !fc.requireCid; // совместимость со старыми клиентами
  if (!validCallAttempt(msg.cid) || msg.cid !== fc.cid) return false;
  fc.requireCid = true;
  return true;
}
function rememberCallCancel(id, msg) {
  const now = Date.now();
  for (const [key, until] of cancelledCallAttempts) if (until <= now) cancelledCallAttempts.delete(key);
  if (!validCallAttempt(msg.cid)) return;
  cancelledCallAttempts.set(id + '|' + msg.cid, now + 180000);
  while (cancelledCallAttempts.size > 256) cancelledCallAttempts.delete(cancelledCallAttempts.keys().next().value);
}
function callWasCancelled(id, msg) {
  if (msg.cid == null) return false;
  if (!validCallAttempt(msg.cid)) return true;
  const key = id + '|' + msg.cid, until = cancelledCallAttempts.get(key);
  if (until && until > Date.now()) return true;
  cancelledCallAttempts.delete(key);
  return false;
}

function onFriendMsg({ id, msg }) {
  if (!msg || typeof msg !== 'object') return;
  const f = friendsList.find((x) => x.id === id);
  const nick = f?.nick || String(msg.nick || 'Друг').slice(0, 24);
  const fc = S.friendCall;
  L('friend-msg', { t: msg.t, from: id.slice(0, 8) });
  if (/^grp-/.test(String(msg.t))) { grpOnFriendMsg(id, msg, f, nick); return; } // групповой звонок (group.js)
  switch (msg.t) {
    case 'call':
      incomingCall(id, nick, msg, 0);
      return;
    case 'answer':
      if (fc?.dir !== 'out' || fc.id !== id || !callControlMatches(fc, msg)) return;
      clearTimeout(fc.timer);
      stopRing();
      $('callSub').textContent = 'Соединяемся…';
      applyAnswer(String(msg.code || ''));
      armConnectTimer(HOST_CONNECT_TIMEOUT);
      return;
    case 'decline':
      if (fc?.id === id && fc.dir === 'out' && callControlMatches(fc, msg)) endFriendCall(`${nick} отклонил звонок`);
      return;
    case 'busy':
      if (fc?.id === id && fc.dir === 'out' && callControlMatches(fc, msg)) endFriendCall(`${nick} сейчас занят`);
      return;
    case 'cancel':
      rememberCallCancel(id, msg);
      if (fc?.id === id && fc.dir === 'in' && callControlMatches(fc, msg)) endFriendCall(fc.accepted ? `${nick} отменил звонок` : `Пропущенный звонок от ${nick}`);
      return;
    case 'call-wait': // я вышел, а он остался и ждёт
      if (!f || S.inCall || S.friendCall) return;
      S.rejoin = { id, nick, until: Date.now() + REJOIN_FOR };
      showRejoin();
      if (document.hidden) alo.notifyMsg({ nick, text: 'ждёт тебя в звонке — открой и нажми «Вернуться»' });
      return;
    case 'call-closed':
      if (S.rejoin?.id === id) { S.rejoin = null; showRejoin(); }
      return;
    case 'dm':
      if (f) onDmText(id, nick, msg);
      return;
    case 'dm-op':
      if (f) { const conv = getConv(id, nick); loadHistory(conv); applyOp(conv, msg, 'peer'); }
      return;
    case 'dm-read':
      if (f) { const conv = getConv(id, nick); loadHistory(conv); onReadMids(conv, msg.mids); }
      return;
    case 'link-offer':
      if (f) onLinkOffer(id, msg);
      return;
    case 'link-answer':
      onLinkAnswer(id, msg);
      return;
    case 'rtc-restart':
      onRtcRestart(id, msg);
      return;
    case 'rtc-restart-ans':
      onRtcRestartAns(id, msg);
      return;
    default:
  }
}

// age — сколько мс назад пришёл вызов (если он пришёл, пока окна не было)
function incomingCall(id, nick, msg, age) {
  if (callWasCancelled(id, msg)) return;
  const fc = S.friendCall;
  // встречный звонок: оба нажали «Позвонить» одновременно → звонит тот, у кого ID больше
  if (fc && fc.dir === 'out' && fc.id === id && !S.connected) {
    L('friend-call', { glare: true, iWin: myIdent?.id > id });
    if (myIdent?.id > id) return;
    if (!/^ALOI\./.test(String(msg.code || ''))) return;
    clearTimeout(fc.timer);
    stopRing();
    S.friendCall = { id, nick, dir: 'in', cid: msg.cid, requireCid: validCallAttempt(msg.cid), code: msg.code, accepted: true };
    showCallModal('in', nick);
    $('callSub').textContent = 'Соединяемся…';
    $('btnCallAccept').classList.add('hidden');
    $('btnCallDecline').classList.add('hidden');
    if (S.busy) S.answerWhenFree = msg.code;
    else makeAnswer(msg.code);
    return;
  }
  if (fc?.dir === 'in' && fc.id === id && (!msg.cid || fc.cid === msg.cid)) return; // повтор того же вызова
  // он возвращается в звонок, где я жду именно его («Вернуться» или просто «Позвонить» — неважно)
  if (isFriend(id) && S.waiting?.id === id && S.inCall && !S.connected && !S.busy && !fc && /^ALOI\./.test(String(msg.code || ''))) {
    acceptRejoin(id, nick, msg.code, msg);
    return;
  }
  if (S.inCall || S.busy || S.pc || fc || G.active || G.invite) { alo.friendsSend({ id, msg: callEnvelope(msg, { t: 'busy' }) }); return; }
  if (!/^ALOI\./.test(String(msg.code || ''))) return;
  alo.clearPendingCall();
  S.friendCall = { id, nick, dir: 'in', cid: msg.cid, requireCid: validCallAttempt(msg.cid), code: msg.code };
  updateService();
  closeDm();
  showCallModal('in', nick);
  if (document.visibilityState === 'visible') startRing();
  const incoming = S.friendCall;
  incoming.timer = setTimeout(() => {
    if (S.friendCall === incoming && !incoming.accepted) {
      alo.friendsSend({ id, msg: callEnvelope(incoming, { t: 'decline' }) });
      endFriendCall(`Пропущенный звонок от ${nick}`);
    }
  }, Math.max(5000, 40000 - age));
}

function acceptCall() {
  const fc = S.friendCall;
  if (!fc || fc.dir !== 'in' || fc.accepted) return;
  suspendCallOverlays();
  fc.accepted = true;
  clearTimeout(fc.timer);
  stopRing();
  $('callSub').textContent = 'Соединяемся…';
  $('btnCallAccept').classList.add('hidden');
  $('btnCallDecline').classList.add('hidden');
  S.nick = $('nick').value.trim() || 'Без имени';
  updateService();
  makeAnswer(fc.code);
}
function declineCall() {
  const fc = S.friendCall;
  if (!fc) return;
  alo.friendsSend({ id: fc.id, msg: callEnvelope(fc, { t: 'decline' }) });
  endFriendCall();
}
function cancelCall() {
  const fc = S.friendCall;
  if (!fc) return;
  alo.friendsSend({ id: fc.id, msg: callEnvelope(fc, { t: 'cancel' }) });
  endFriendCall();
}

/* ---------- В звонке: обмен ID и «Добавить в друзья» ---------- */
// ID в 'ident' — только заявка (как в десктопе 1.15.1). В звонке по коду собеседник доказывает, что ключ его:
// мы шлём вызов ch, он отвечает 'ident-proof' (HMAC ключом пары, привязан к DTLS-отпечаткам звонка).
// Без доказательства звонок не привязывается к другу: ни истории, ни смены его адресов.
async function sendIdent() {
  const info = await alo.friendsInfo();
  if (!info?.id) return;
  const ch = b64uBytes(crypto.getRandomValues(new Uint8Array(18)));
  S.identCh = ch;
  send({ t: 'ident', id: info.id, addrs: info.addrs || [], av: myAvatar?.hash || '', ch });
}
function b64uBytes(u8) { return btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
// DTLS-отпечатки обеих сторон этого соединения (одинаковая строка у обоих)
function callBinding(pc = S.pc) {
  const fps = (sdp) => [...String(sdp || '').matchAll(/^a=fingerprint:(.+)$/gm)].map((m) => m[1].trim().toLowerCase());
  const all = [...new Set([...fps(pc?.localDescription?.sdp), ...fps(pc?.remoteDescription?.sdp)])].sort();
  return all.length >= 2 ? all.join('|') : '';
}
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
async function onPeerIdent(d) {
  if (!d || !ID_RE.test(String(d.id || ''))) return;
  if (S.peerIdent && S.peerIdent.id !== d.id) { L('friends', { identChanged: true }); return; } // ID посреди звонка не меняется
  const claim = { id: d.id, addrs: Array.isArray(d.addrs) ? d.addrs : [], av: String(d.av || '').slice(0, 32) };
  if (S.signaledBy && S.signaledBy === d.id) { acceptPeerIdent(claim); return; }
  S.peerClaim = claim;
  // отвечаем на его вызов: доказываем, что мой ключ мой
  if (typeof d.ch === 'string' && d.ch.length >= 16 && d.ch.length <= 64) {
    const me = await alo.friendsInfo();
    const bind = callBinding();
    const r = me?.id && bind ? await alo.friendsProof({ id: d.id, prover: me.id, nonce: d.ch, bind }) : null;
    if (r?.mac) send({ t: 'ident-proof', mac: r.mac });
  } else {
    L('friends', { peerIdent: 'no-proof', alreadyFriend: isFriend(d.id) });
    if (isFriend(d.id)) sysMsg(`⚠ Собеседник назвался ${friendNickOf(d.id)}, но не подтвердил это ключом (у него старая alloconnect?). Звонок не привязан к другу.`);
  }
}
async function onPeerIdentProof(d) {
  const claim = S.peerClaim;
  if (!claim || !S.identCh || typeof d?.mac !== 'string') return;
  const bind = callBinding();
  const r = bind ? await alo.friendsProof({ id: claim.id, prover: claim.id, nonce: S.identCh, bind }) : null;
  if (S.peerClaim !== claim) return;
  S.peerClaim = null;
  if (r?.mac && r.mac === d.mac) { acceptPeerIdent(claim); return; }
  if (S.peerIdent?.id === claim.id) return; // уже подтверждён раньше (опоздавший ответ после переподключения)
  L('friends', { peerIdent: 'bad-proof', alreadyFriend: isFriend(claim.id) });
  sysMsg(isFriend(claim.id)
    ? `⚠ Собеседник выдаёт себя за ${friendNickOf(claim.id)}, но ключ не его. Звонок не привязан к другу.`
    : '⚠ Собеседник не подтвердил свой ID — добавить его в друзья нельзя.');
}
function friendNickOf(id) { return friendsList.find((f) => f.id === id)?.nick || 'друга'; }
function sendCallPath() {
  if (!S.callPath || !S.peerIdent || !isFriend(S.peerIdent.id)) return;
  if (S.callPath.remoteType === 'relay') return;
  alo.friendsCallPath({ id: S.peerIdent.id, ...S.callPath });
}
// Periodic contacts are scoped to this exact verified data channel, not a saved online flag.
let friendContactTimer = null;
function startFriendContact() {
  clearTimeout(friendContactTimer);
  const dc = S.dc, peer = S.peerIdent;
  const alive = () => S.connected && S.dc === dc && S.peerIdent === peer && dc?.readyState === 'open';
  const pulse = async () => {
    if (!alive() || !isFriend(peer?.id)) return;
    const info = await alo.friendsInfo().catch(() => null);
    if (!alive()) return;
    if (info?.id) send({ t: 'friend-contact', id: info.id, addrs: info.addrs || [] });
    friendContactTimer = setTimeout(pulse, 5000);
  };
  pulse();
}
function receiveFriendContact(d) {
  if (!S.connected || S.dc?.readyState !== 'open' || !S.peerIdent || d.id !== S.peerIdent.id || !isFriend(d.id)) return;
  alo.friendsContact?.({ id: d.id, addrs: Array.isArray(d.addrs) ? d.addrs.slice(0, 8) : [] });
}
function acceptPeerIdent(d) {
  S.peerIdent = { id: d.id, addrs: d.addrs };
  if (isFriend(d.id)) {
    alo.friendsContact?.({ id: d.id, addrs: d.addrs });
    startFriendContact();
  }
  adoptCallConv(d.id);
  onPeerAvatarHash(d.id, d.av, () => send({ t: 'av-want' }));
  refreshAvatars();
  L('friends', { peerIdent: true, verified: true, peerAddrKinds: S.peerIdent.addrs.map((a) => a.kind), alreadyFriend: isFriend(d.id) });
  if (isFriend(d.id)) {
    alo.friendsAdd({ id: d.id, nick: friendsList.find((f) => f.id === d.id)?.nick || S.friendNick, addrs: S.peerIdent.addrs }).then(() => sendCallPath());
    $('btnAddFriend').classList.add('hidden');
  } else {
    $('btnAddFriend').textContent = '➕ В друзья';
    $('btnAddFriend').classList.remove('hidden');
  }
}
async function addPeerFriend() {
  if (!S.peerIdent) return;
  const r = await alo.friendsAdd({ id: S.peerIdent.id, nick: S.friendNick, addrs: S.peerIdent.addrs });
  if (!r.ok) { toast('Не удалось добавить'); return; }
  send({ t: 'friend-added' });
  $('btnAddFriend').classList.add('hidden');
  setTimeout(sendCallPath, 300);
  toast(`${S.friendNick} в друзьях — в следующий раз звони прямо из списка`);
}

/* =========================================================
   Автопереподключение: связь пропала → перезапуск ICE через канал друзей
   (на телефоне это частый случай: Wi-Fi ↔ мобильный интернет)
   ========================================================= */
const RECONNECT_FOR = 75000;
function canSignal() { return !!(S.peerIdent && isFriend(S.peerIdent.id)); }

function startReconnect(why, peerLed) {
  if (!S.connected || S.reconnecting || !S.pc) return;
  const pc = S.pc;
  S.reconnecting = { t0: Date.now(), pc, applied: false, attempts: 0, nextAt: S.role === 'host' && !peerLed ? 0 : 20000 };
  L('reconnect', { start: why, canSignal: canSignal(), role: S.role });
  setStatus('waiting', 'Переподключение…');
  $('call').classList.add('reconnecting');
  callEvent(canSignal() ? 'Связь прервалась — переподключаюсь…' : 'Связь прервалась — жду, вдруг вернётся…', 'network');
  const tick = () => {
    const r = S.reconnecting;
    if (!r || S.pc !== pc) return;
    const ok = pc.connectionState === 'connected' && (r.applied || r.wentDown);
    if (ok) { finishReconnect(true); return; }
    if (pc.connectionState !== 'connected') r.wentDown = true;
    const age = Date.now() - r.t0;
    if (age > (canSignal() ? RECONNECT_FOR : 25000)) { finishReconnect(false); return; }
    if (canSignal() && age >= r.nextAt) { r.attempts++; r.nextAt = age + 10000; doIceRestart(); }
    r.timer = setTimeout(tick, 700);
  };
  tick();
}
function finishReconnect(ok) {
  const r = S.reconnecting;
  if (!r) return;
  clearTimeout(r.timer);
  S.reconnecting = null;
  $('call').classList.remove('reconnecting');
  L('reconnect', { ok, sec: Math.round((Date.now() - r.t0) / 1000), attempts: r.attempts });
  if (ok) {
    setStatus('ok', 'Соединено');
    callEvent('Связь восстановлена', 'recovered');
    sound('join');
    pairLogged = false;
  } else {
    friendGone(canSignal() ? 'Связь потеряна' : 'Связь потеряна (чтобы звонок переподключался сам — добавьте друг друга в друзья)');
  }
}
async function doIceRestart() {
  const pc = S.pc;
  const id = S.peerIdent?.id;
  if (!pc || !id) return;
  try {
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
    if (pc.signalingState !== 'stable') return;
    const offer = await pc.createOffer({ iceRestart: true });
    const g = gatherCandidates(pc, { stunCount: stunCountOf(pc) });
    await pc.setLocalDescription({ type: 'offer', sdp: opusStereo(offer.sdp) });
    await g;
    if (S.pc !== pc) return;
    const sdp = bitrateHints(opusStereo(minifySdp(pc.localDescription.sdp)));
    const r = await alo.friendsSend({ id, msg: { t: 'rtc-restart', sdp } });
    L('reconnect', { offerSent: !!r.ok, error: r.ok ? undefined : r.error });
  } catch (e) { L('reconnect', { offerFailed: e.message }); }
}
async function onRtcRestart(id, msg) {
  const pc = S.pc;
  if (!pc || !S.connected || S.peerIdent?.id !== id || !/^v=0/.test(String(msg.sdp || ''))) return;
  try {
    if (!S.reconnecting) startReconnect('peer', true);
    if (pc.signalingState === 'have-local-offer') {
      if (S.role === 'host') return; // оба начали одновременно: уступает тот, кто отвечал на приглашение
      await pc.setLocalDescription({ type: 'rollback' });
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    const ans = await pc.createAnswer();
    const g = gatherCandidates(pc, { stunCount: stunCountOf(pc) });
    await pc.setLocalDescription({ type: 'answer', sdp: opusStereo(ans.sdp) });
    await g;
    if (S.pc !== pc) return;
    if (S.reconnecting) S.reconnecting.applied = true;
    const r = await alo.friendsSend({ id, msg: { t: 'rtc-restart-ans', sdp: bitrateHints(opusStereo(minifySdp(pc.localDescription.sdp))) } });
    L('reconnect', { answerSent: !!r.ok });
  } catch (e) { L('reconnect', { answerFailed: e.message }); }
}
async function onRtcRestartAns(id, msg) {
  const pc = S.pc;
  if (!pc || S.peerIdent?.id !== id || pc.signalingState !== 'have-local-offer') return;
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: String(msg.sdp || '') });
    if (S.reconnecting) S.reconnecting.applied = true;
    L('reconnect', { answerApplied: true });
  } catch (e) { L('reconnect', { applyFailed: e.message }); }
}

/* =========================================================
   Чат с другом без звонка (текст — через канал друзей)
   ========================================================= */
let dmOpen = null;
function openDm(id) {
  const f = friendsList.find((x) => x.id === id);
  if (!f) return;
  const conv = getConv(id, f.nick);
  dmOpen = conv;
  conv.unread = 0;
  $('dmTitle').textContent = f.nick;
  updateDmHead();
  loadHistory(conv);
  showScreen('dm');
  mountConv(conv, $('dmMessages'));
  scrollEnd(conv, true);
  renderFriends();
  setTimeout(() => flushRead(conv), 50);
}
function updateDmHead() {
  if (!dmOpen) return;
  const f = friendsList.find((x) => x.id === dmOpen.id);
  $('dmSub').textContent = f?.online ? 'в сети' + (f.act?.game ? ` · 🎮 ${f.act.game}` : '')
    : window.accountLab?.canRouteDm?.(dmOpen.id) ? 'нет прямой связи — попробуем через привязанный ПК'
    : 'не в сети — сообщение дойдёт, когда друг будет доступен';
}
function closeDm() {
  if (!dmOpen) return;
  dmOpen = null;
  if ($('dm').classList.contains('active')) showScreen(S.inCall ? 'call' : 'lobby');
}
async function dmSendText() {
  const conv = dmOpen;
  const text = $('dmInput').value.trim();
  if (!conv || !text) return;
  if (composeSubmitEdit(composers.dm, conv, text)) return;
  $('dmInput').value = '';
  S.nick = $('nick').value.trim() || 'Без имени';
  const ts = Date.now();
  const mid = newMid();
  const re = composeTakeReply(composers.dm);
  const m = chatMsg(conv, S.nick, text, true, ts, null, { mid, re });
  m.classList.add('sending');
  record(conv, { mid, ts, who: 'me', nick: S.nick, type: 'text', text, re: re || undefined });
  const message = { t: 'dm', mid, text, ts, nick: S.nick, re: reOut(re) };
  const r = await window.accountLab?.routeDm?.(conv.id, message) ?? await alo.friendsSend({ id: conv.id, msg: message });
  m.classList.remove('sending');
  if (!r.ok) { markUndelivered(m); recordStatus(conv, mid, 'fail'); } else {const previous=foldOps(histGet(conv.id)).find(e=>e.mid===mid)?.st;const delivered=previous==='sent'||previous==='read';const state=previous==='read'?'read':r.queued&&!delivered?'queued':'sent';setTickEl(m,state);recordStatus(conv,mid,state);}
}
function applyLinkedDmSent(id, mid) {
  const conv = getConv(id);
  if (foldOps(histGet(id)).some(e => e.mid === mid && e.st === 'read')) return;
  const element = conv.msgs?.get(mid)?.el;
  if (element) { element.classList.remove('sending'); setTickEl(element, 'sent'); }
  recordStatus(conv, mid, 'sent');
}
function onDmText(id, nick, msg) {
  const conv = getConv(id, nick);
  loadHistory(conv);
  const text = String(msg.text || '').slice(0, 2000);
  const ts = Number(msg.ts) || Date.now();
  const mid = cleanMid(msg.mid) || newMid();
  const re = reIn(msg.re);
  if(conv.msgs?.has(mid)||histGet(id).some(e=>e.mid===mid))return;
  chatMsg(conv, nick, text, false, ts, null, { mid, re });
  record(conv, { mid, ts, who: 'peer', nick, type: 'text', text, re: re || undefined });
  dmNotice(conv, text, false);
  noteUnseen(conv, mid);
}

// новое сообщение не на виду → счётчик, звук; окно свёрнуто — уведомление (текст его уже показал Android)
function dmNotice(conv, text, notify = true) {
  const visible = (dmOpen === conv && $('dm').classList.contains('active')) || (S.inCall && S.callConv === conv && S.chatOpen);
  if (!visible) { conv.unread++; renderFriends(); toast(`💬 ${conv.nick}: ${String(text).slice(0, 60)}`); }
  sound('msg');
  if (notify && document.hidden && myPresence!=='dnd') alo.notifyMsg({ nick: conv.nick, text: String(text).slice(0, 200) });
}

/* ---------- Файлы без звонка: отдельное прямое соединение только для файлов (как у ПК; поднимается по требованию,
   договариваемся через канал друзей: link-offer / link-answer; 3 минуты без передач — закрывается) ---------- */
const links = new Map(); // ID друга → { lid, role, pc, dc, chan, open }
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

function makeLink(id, lid, role, cfg = rtcConfig()) {
  const l = { lid, role };
  const pc = new RTCPeerConnection(cfg);
  const dc = pc.createDataChannel('duo', { negotiated: true, id: 0, ordered: true });
  const fdc = pc.createDataChannel('files', { negotiated: true, id: 1, ordered: true });
  l.pc = pc;
  l.dc = dc;
  l.chan = new FileChan(fdc, () => getConv(id), {
    avatar: (b, m) => onAvatarFile(id, b, m),
    chatIn: (conv, meta) => { if (conv) dmNotice(conv, `${FICON[meta.kind] || '📄'} ${meta.name}`); },
  });
  l.open = new Promise((res, rej) => { l.res = res; l.rej = rej; });
  l.open.catch(() => {});
  fdc.addEventListener('open', () => l.res());
  dc.onopen = () => { try { dc.send(JSON.stringify({ t: 'ident', av: myAvatar?.hash || '' })); } catch { /* */ } };
  dc.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.t === 'ident') onPeerAvatarHash(id, String(d.av || '').slice(0, 32), () => { try { dc.send(JSON.stringify({ t: 'av-want' })); } catch { /* */ } });
    else if (d.t === 'av-want') { const f = myAvatarFile(); if (f) l.chan.queue([f], 'avatar'); }
    else if (d.t === 'upd-req') { try { dc.send(JSON.stringify({ t: 'upd-none' })); } catch { /* */ } } // обновления ПК — не с телефона
  };
  pc.addEventListener('connectionstatechange', () => {
    L('link', { state: pc.connectionState, role });
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropLink(id, l, 'связь прервалась');
  });
  l.idle = setInterval(() => { if (!l.chan.sending && !l.chan.outgoing.length && !l.chan.incoming.size && Date.now() - (l.chan.lastActive || 0) > 180000) dropLink(id, l, 'закрыто'); }, 15000);
  links.set(id, l);
  return l;
}

function dropLink(id, l, why) {
  if (links.get(id) === l) links.delete(id);
  clearInterval(l.idle);
  l.chan.fail(why || 'связь прервалась');
  l.rej?.(new Error(why || 'связь прервалась'));
  try { l.pc.close(); } catch { /* */ }
}

async function getLink(id) {
  const ex = links.get(id);
  if (ex) return ex;
  const lid = newMid();
  let l = null;
  const res = await gatherWithFallback('link', (cfg) => {
    if (l) dropLink(id, l, 'переподключение');
    l = makeLink(id, lid, 'out', cfg);
    return l.pc;
  }, async (pc) => { await pc.setLocalDescription(await pc.createOffer()); }, (pc) => links.get(id)?.pc === pc);
  if (!res || !l || links.get(id) !== l) return links.get(id) || Promise.reject(new Error('связь прервалась'));
  const r = await alo.friendsSend({ id, msg: { t: 'link-offer', lid: l.lid, sdp: minifySdp(l.pc.localDescription.sdp) } });
  if (!r.ok) { dropLink(id, l, 'друг не в сети'); throw new Error('друг не в сети'); }
  return l;
}

async function onLinkOffer(id, msg) {
  if (!/^v=0/.test(String(msg.sdp || ''))) return;
  const ex = links.get(id);
  if (ex) {
    // встречные запросы: остаётся запрос того, у кого ID больше
    if (ex.role === 'out' && ex.pc.signalingState === 'have-local-offer' && myIdent?.id > id) return;
    dropLink(id, ex, 'переподключение');
  }
  const lid = String(msg.lid || '').slice(0, 20);
  let l = null;
  try {
    const res = await gatherWithFallback('link', (cfg) => {
      if (l) dropLink(id, l, 'переподключение');
      l = makeLink(id, lid, 'in', cfg);
      return l.pc;
    }, async (pc) => {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
    }, (pc) => links.get(id)?.pc === pc, { answer: true });
    if (!res || links.get(id) !== l) return;
    const r = await alo.friendsSend({ id, msg: { t: 'link-answer', lid: l.lid, sdp: minifySdp(l.pc.localDescription.sdp) } });
    if (!r.ok) dropLink(id, l, 'друг не ответил');
  } catch (e) { L('link', { answerFailed: e.message }); if (l) dropLink(id, l, 'ошибка'); }
}

async function onLinkAnswer(id, msg) {
  const l = links.get(id);
  if (!l || l.lid !== msg.lid || l.pc.signalingState !== 'have-local-offer') return;
  try { await l.pc.setRemoteDescription({ type: 'answer', sdp: String(msg.sdp || '') }); } catch (e) { L('link', { applyFailed: e.message }); dropLink(id, l, 'ошибка'); }
}

async function dmSendFiles(list, extra = {}) {
  const conv = dmOpen;
  if (!conv || !list.length) return;
  if (S.connected && S.fileChan && S.callConv?.id === conv.id) { S.fileChan.queue(list, 'chat', extra); return; } // уже в звонке с ним
  const f = friendsList.find((x) => x.id === conv.id);
  if (!f?.online) { toast(`${conv.nick} не в сети — файл можно отправить, когда он в сети`); return; }
  toast('Соединяюсь с ' + conv.nick + '…');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const l = await getLink(conv.id);
      await withTimeout(l.open, 25000, 'не удалось соединиться напрямую');
      l.chan.queue(list, 'chat', extra);
      return;
    } catch (e) {
      L('link', { sendFailed: e.message });
      if (attempt === 1 || !links.get(conv.id)) { toast('Файл не отправлен: ' + e.message); return; }
    }
  }
}

/* =========================================================
   Настройки
   ========================================================= */
async function openSettings() {
  const o = settings();
  $('optMinKbps').value = o.minKbps;
  $('optStunAlt').checked = !!o.stunAlt;
  $('optNoStun').checked = !!o.noStun;
  $('optStunCustom').value = o.stunCustom || '';
  $('optRelayUrl').value = o.relayUrl || '';
  $('relayDeviceId').value = myIdent?.id || '';
  const relayInfo = await alo.friendsInfo();
  $('relayStatus').textContent = !o.relayUrl ? 'Резерв выключен' : relayInfo.relayState === 'ready' ? 'Резерв доступен' : 'Нет подтверждённого подключения к резерву';
  $('optTurnUrl').value = o.turnUrl || '';
  $('optTurnUser').value = o.turnUser || '';
  $('optTurnPass').value = o.turnPass || '';
  $('optRelay').checked = !!o.relay;
  $('optShareFps').value = String(o.shareFps);
  $('optShareAudio').checked = o.shareAudio !== false;
  $('optPtt').checked = !!o.ptt;
  $('optSpeakerStart').checked = !!o.speakerStart;
  $('optOvlDraw').checked = o.ovlDraw !== false;
  $('optOvlReact').checked = !!o.ovlReact;
  $('optSvidSound').checked = o.svidInSound !== false;
  $('optSvidVol').value = String(o.svidInVol ?? 80);
  refreshOvlOk().then(renderOvlState);
  $('optRnn').checked = o.rnn !== false;
  $('optNoise').checked = o.noise !== false;
  $('optEcho').checked = o.echo !== false;
  $('optAgc').checked = o.agc !== false;
  $('optSounds').checked = o.sounds !== false;
  $('optRingMute').checked = !!o.ringMute;
  $('optRingVol').value = String(o.ringVol ?? 80);
  renderRingName();
  refreshAvatars();
  $('optUpdAuto').checked = o.updAuto !== false;
  $('optClip').checked = o.clip !== false;
  $('optClipSec').value = String(o.clipSeconds || 30);
  const showClipSeconds = () => { $('optClipSecValue').textContent = `${$('optClipSec').value} с`; };
  $('optClipSec').oninput = showClipSeconds;
  showClipSeconds();
  $('optClipAudio').checked = o.clipAudio === true;
  buildThemeGrid();
  applyTheme(o.theme || '');
  $('settings').classList.remove('hidden');
  focusOpenedDialog($('settings'));
  await renderStatus();
}
function closeSettings() {
  const o = settings();
  const next = {
    ...o,
    minKbps: Math.max(300, Math.min(8000, Number($('optMinKbps').value) || 2500)),
    stunAlt: $('optStunAlt').checked, noStun: $('optNoStun').checked, stunCustom: $('optStunCustom').value,
    relayUrl: $('optRelayUrl').value.trim(),
    turnUrl: $('optTurnUrl').value.trim(), turnUser: $('optTurnUser').value, turnPass: $('optTurnPass').value, relay: $('optRelay').checked,
    shareCodec: Number($('optShareFps').value)>30?'h264':'compatible', shareFps: Number($('optShareFps').value) || 30, shareAudio: $('optShareAudio').checked, ptt: $('optPtt').checked, updAuto: $('optUpdAuto').checked, speakerStart: $('optSpeakerStart').checked,
    ovlDraw: $('optOvlDraw').checked, ovlReact: $('optOvlReact').checked, svidInSound: $('optSvidSound').checked, svidInVol: Number($('optSvidVol').value),
    rnn: $('optRnn').checked, noise: $('optNoise').checked, echo: $('optEcho').checked, agc: $('optAgc').checked,
    sounds: $('optSounds').checked, ringMute: $('optRingMute').checked, ringVol: Number($('optRingVol').value),
    clip: $('optClip').checked, clipSeconds: Math.max(5, Math.min(120, Number($('optClipSec').value) || 30)), clipAudio: $('optClipAudio').checked,
  };
  store.set('settings', next);
  S.pttDown = false;
  applyMicEnabled();
  updateMyControls();
  if (!next.clip) stopClip(); else {
    if (next.clipSeconds !== o.clipSeconds || next.clipAudio !== !!o.clipAudio) S.clipKey = null;
    refreshClip();
  }
  stopRing();
  if (next.ovlDraw !== (o.ovlDraw !== false) || next.ovlReact !== !!o.ovlReact) { sendPerm(); grpPermChanged(); if (SH) { ovlStop(); ovlStart(); } }
  if (next.rnn !== (o.rnn !== false)) setNs(next.rnn);
  if (next.noise !== (o.noise !== false) || next.echo !== (o.echo !== false) || next.agc !== (o.agc !== false)) restartMic().catch((e) => L('mic', { restartFailed: e.message }));
  alo.netConfig(netCfg());
  $('settings').classList.add('hidden');
  restoreDialogFocus($('settings'));
}
function kv(ul, rows) {
  ul.innerHTML = '';
  for (const [k, v] of rows) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = k + ': ';
    li.append(b, document.createTextNode(v));
    ul.appendChild(li);
  }
}
async function renderStatus() {
  const st = await alo.status();
  $('optOnlineBg').checked = !!st.onlineBg;
  const box = $('bgChecks');
  box.innerHTML = '';
  const check = (ok, text, btnText, fn) => {
    const d = document.createElement('div');
    d.className = 'check ' + (ok ? 'ok' : 'bad');
    d.append(document.createTextNode(text));
    if (!ok && btnText) { const b = document.createElement('button'); b.className = 'btn'; b.textContent = btnText; b.onclick = fn; d.appendChild(b); }
    box.appendChild(d);
  };
  if (st.onlineBg) {
    check(st.notifications, st.notifications ? 'Уведомления разрешены' : 'Уведомления запрещены — входящий звонок не покажется', 'Разрешить', async () => { await alo.requestNotifications(); const s2 = await alo.status(); if (!s2.notifications) alo.openSettings({ what: 'notifications' }); renderStatus(); });
    check(st.fullScreen, st.fullScreen ? 'Звонок может открыться на весь экран' : 'Звонок не откроется поверх блокировки', 'Разрешить', () => alo.openSettings({ what: 'fullscreen' }));
    check(st.battery, st.battery ? 'Экономия батареи не мешает' : 'Экономия батареи может усыпить приложение', 'Отключить', () => alo.openSettings({ what: 'battery' }));
  }
  const n = S.netStun;
  kv($('netInfo'), [
    ['STUN', STUN_NAME[stunPlan()[0].name] + (lastStun ? `; последний раз — ${STUN_NAME[lastStun.list]}${lastStun.first ? ', первым ответил ' + lastStun.first : ', никто не ответил'}` : '')],
    ['Внешний адрес порта друзей', n ? (n.stun ? 'определён' : 'не определён') : 'проверяю…'],
    ['Тип NAT', { cone: 'обычный — пробивка работает', symmetric: 'строгий — входящие звонки вряд ли пройдут', unknown: 'неизвестно' }[n?.natType] || '—'],
  ]);
  kv($('appInfo'), [
    ['Версия', `${st.version || VERSION} (совместима с ПК 1.10–1.15)`],
    ['Мой ID', myIdent?.id ? myIdent.id.slice(0, 12) + '…' : '—'],
    ['Порт друзей (UDP)', String(myIdent?.port || '—')],
    ['Микрофон', st.mic ? 'разрешён' : 'не разрешён'],
  ]);
  updateBgHint(st);
}
function updateBgHint(st) {
  const h = $('bgHint');
  if (!friendsList.length) { h.classList.add('hidden'); return; }
  h.classList.remove('hidden');
  h.textContent = st.onlineBg
    ? '🟢 В сети в фоне: друзья дозвонятся, даже когда приложение закрыто.'
    : 'Друзья дозвонятся, пока приложение открыто. Чтобы и в фоне — «⚙ → Быть в сети в фоне».';
}

/* =========================================================
   Кнопки
   ========================================================= */
function bind() {
  $('nick').value = store.get('nick', '');
  // ник сохраняется сразу и уходит друзьям в пингах (как ПК 1.21)
  {
    let t = null;
    const push = () => alo.friendsNick({ nick: $('nick').value.trim() }).catch(() => {});
    $('nick').addEventListener('input', () => {
      const v = $('nick').value.trim();
      store.set('nick', v);
      if (!S.inCall) S.nick = v || S.nick;
      clearTimeout(t);
      t = setTimeout(push, 800);
    });
    setTimeout(push, 1500); // канал друзей поднимается чуть позже окна
  }
  $('entryCode').addEventListener('input', entryCodePreview);
  $('entryCodeGo').onclick = entryCodeContinue;
  $('btnManualGroup').onclick = grpOpenPick;
  $('btnInvite').onclick = () => startInvite();
  $('btnHaveInvite').onclick = async () => {
    showStep('stepGuest');
    const t = (await alo.paste()).text || '';
    const m = /ALOI\.[A-Za-z0-9_-]{200,}/.exec(t.replace(/\s+/g, ''));
    if (m && !ownCodes.has(m[0])) { $('offerIn').value = m[0]; lastClip = t; }
  };
  document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = backToHome; });
  $('btnCopyOffer').onclick = () => autoCopy($('offerOut').value, $('btnCopyOffer'));
  $('btnShareOffer').onclick = () => alo.share({ text: $('offerOut').value, title: 'Приглашение alloconnect' });
  $('btnPasteAnswer').onclick = async () => { const t = (await alo.paste()).text || ''; $('answerIn').value = t; if (/ALOA\./.test(t)) applyAnswer(t); };
  $('btnApplyAnswer').onclick = () => applyAnswer();
  $('btnPasteOffer').onclick = async () => { $('offerIn').value = (await alo.paste()).text || ''; };
  $('btnMakeAnswer').onclick = () => makeAnswer();
  $('btnCopyAnswer').onclick = () => autoCopy($('answerOut').value, $('btnCopyAnswer'));
  $('btnShareAnswer').onclick = () => alo.share({ text: $('answerOut').value, title: 'Ответ alloconnect' });

  // в режиме рации кнопка микрофона — «держи и говори»; долгое нажатие не открывает меню
  $('btnMute').onclick = () => { if (!pttOn() || S.muted || S.deafened) setMuted(!S.muted); };
  $('btnMute').addEventListener('pointerdown', (e) => { if (pttOn() && !S.muted && !S.deafened) { e.preventDefault(); try { $('btnMute').setPointerCapture(e.pointerId); } catch { /* */ } setPttDown(true); } });
  for (const ev of ['pointerup', 'pointercancel']) $('btnMute').addEventListener(ev, () => { if (S.pttDown) setPttDown(false); });
  $('btnMute').addEventListener('contextmenu', (e) => { if (pttOn()) e.preventDefault(); });
  $('btnDeafen').onclick = () => setDeafened(!S.deafened);
  $('btnSpeaker').onclick = async () => {
    const r = await alo.audioRoute({ speaker: !S.speaker });
    S.speaker = r.speaker != null ? !!r.speaker : !S.speaker;
    updateMyControls();
    if (r.headset && !S.speaker) toast('Звук — в наушники');
  };
  $('btnChat').onclick = () => toggleChat();
  $('btnScreen').onclick = () => (SH ? stopShare() : startShare());
  spBind();
  bindLiveTools();
  camBind();
  bindMsgUi();
  $('btnShareStop').onclick = () => stopShare();
  // показ остановили из шторки Android
  alo.on('screenStopped', (e) => { if (SH) { stopShare(); if (e.why === 'system') toast('Показ экрана остановлен'); else if(e.why==='capture-error')toast('Захват экрана прервался. Попробуй запустить показ снова в совместимом режиме'); } });
  $('btnLeave').onclick = () => leaveCall();
  $('btnAddFriend').onclick = () => addPeerFriend();
  $('chatForm').onsubmit = (e) => { e.preventDefault(); sendChat(); };
  $('btnAttach').onclick = () => $('fileInput').click();
  $('fileInput').onchange = () => {
    const list = [...$('fileInput').files];
    $('fileInput').value = '';
    if (!S.connected || !S.fileChan) { toast('Файлы можно отправить только в звонке'); return; }
    S.fileChan.queue(list);
  };
  $('friendVol').oninput = () => { $('remoteVoice').volume = Number($('friendVol').value) / 100; };
  const screenVolume = Math.max(0, Math.min(100, Number(settings().screenVol ?? 100)));
  $('screenVol').value = String(screenVolume);
  $('fsVol').value = String(screenVolume);
  $('screenVol').oninput = () => { const value = Number($('screenVol').value); $('remoteScreen').volume = value / 100; $('fsVol').value = String(value); store.set('settings', { ...settings(), screenVol: value }); };
  $('fsVol').oninput = () => { $('screenVol').value = $('fsVol').value; $('screenVol').oninput(); showFsControls(); };

  // стрим: ⛶ / двойное касание — на весь экран, касание в полноэкранном — кнопки
  $('btnFull').onclick = () => setFullscreen(true);
  let lastTap = 0;
  $('remoteScreen').addEventListener('click', () => {
    const fs = $('remoteScreenWrap').classList.contains('fs');
    if (fs) { if ($('fsControls').classList.contains('hidden')) showFsControls(); else { $('fsControls').classList.add('hidden'); $('remoteScreenWrap').classList.remove('fsctl'); } return; }
    if (Date.now() - lastTap < 350) setFullscreen(true);
    lastTap = Date.now();
  });
  $('btnFsExit').onclick = (e) => { e.stopPropagation(); setFullscreen(false); };
  $('btnFsRotate').onclick = (e) => {
    e.stopPropagation();
    fsOrient = fsOrient === 'landscape' ? 'portrait' : 'landscape';
    alo.fullscreen({ on: true, orientation: fsOrient });
    showFsControls();
  };
  $('btnFsMute').onclick = (e) => { e.stopPropagation(); setMuted(!S.muted); showFsControls(); };

  $('btnCallAccept').onclick = acceptCall;
  $('btnCallDecline').onclick = declineCall;
  $('btnCallCancel').onclick = cancelCall;

  $('btnDmBack').onclick = closeDm;
  $('dmForm').onsubmit = (e) => { e.preventDefault(); dmSendText(); };
  $('btnDmAttach').onclick = () => $('dmFileInput').click();
  $('dmFileInput').onchange = () => { const list = [...$('dmFileInput').files]; $('dmFileInput').value = ''; dmSendFiles(list); };
  $('btnDmCall').onclick = () => { const id = dmOpen?.id; closeDm(); if (id) callFriend(id); };

  for(const id of ['btnSettings','btnCallSettings','btnGroupSettings']) $(id).onclick = openSettings;
  $('btnCloseSettings').onclick = closeSettings;
  $('optOnlineBg').onchange = async () => {
    const on = $('optOnlineBg').checked;
    if (on) await alo.requestNotifications();
    await alo.setOnlineBg({ on });
    L('settings', { onlineBg: on });
    renderStatus();
  };
  $('btnShareLog').onclick = () => alo.shareLog();
  $('btnAppSettings').onclick = () => alo.openSettings({ what: 'app' });

  // аппаратная «Назад»
  alo.on('back', () => {
    if (watchTogether.back()) return;
    if(window.accountLab?.closePanel?.())return;
    if (window.talkingAvatar?.closeEditor()) return;
    if (!$('settings').classList.contains('hidden')) { closeSettings(); return; }
    if ($('remoteScreenWrap').classList.contains('fs')) { setFullscreen(false); return; }
    if ($('dm').classList.contains('active')) { closeDm(); return; }
    if (G.active && G.chatOpen) { grpToggleChat(false); return; }
    if (G.active && CV.state === 'on') { ctlViewStop(true); toast('Управление отдано'); return; }
    if (S.inCall && S.chatOpen) { toggleChat(false); return; }
    if (!S.inCall && !S.friendCall && activeStep() !== 'stepHome' && !S.pc) { backToHome(); return; }
    alo.moveToBack(); // звонок продолжается в фоне
  });
  // уведомление «Принять» / «Открыть» входящий звонок
  alo.on('launch', (e) => onLaunch(e.action));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      setTimeout(checkClipboard, 300);
      takePending();
      renderStatus().catch(() => {});
      setTimeout(updAuto, 2000);
      if (S.friendCall?.dir === 'in' && !S.friendCall.accepted && !ringTimer) startRing();
    }
  });
}

async function takePending() {
  const r = await alo.takePendingCall();
  if (r?.call?.id) {
    const { id, msg, age } = r.call;
    const f = friendsList.find((x) => x.id === id);
    incomingCall(id, f?.nick || String(msg.nick || 'Друг').slice(0, 24), msg, Number(age) || 0);
  }
}
async function onLaunch(action) {
  L('launch', { action });
  await takePending();
  if (action === 'accept') setTimeout(acceptCall, 200);
}

/* =========================================================
   Обновления с GitHub — своя ветка телефона (android-updates-next) в репозитории ПК. Описание версии подписано
   ключом Ed25519 нового Android-канала. Порядок: скачать описание → проверить
   подпись → новее моей? → по кнопке скачать APK (Updater.java сверяет размер, SHA-256, имя пакета, версию и что
   APK подписан тем же ключом, что установленное приложение) → установщик Android. Ставит всегда сам пользователь.
   ========================================================= */
const UPD_REPO = 'kepilis/alloconnect';
const UPD_BASE = `https://raw.githubusercontent.com/${UPD_REPO}/android-updates-next/`;
// Открытый ключ Ed25519 нового Android-канала
const UPD_PUBKEY = 'pnioX5R1v2K7jP8nKK6vO5Vr6F9lnBus6ih+bVCgy4A=';
const UPD_EVERY = 12 * 3600 * 1000; // сами проверяем не чаще раза в 12 часов
const U = { transfer:null, busy: false, found: null, none: false, err: '', dl: false, pct: 0, ready: null };

function verCmp(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}
const b64bytes = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
// откуда брать: GitHub; подставной адрес и ключ — только в отладочной сборке (автотесты)
async function updSource() {
  const t = store.get('updTest', null);
  if (t?.base && (await alo.status()).debug) return { base: t.base, pub: t.pub || UPD_PUBKEY };
  let base = UPD_BASE;
  try {
    const r = await alo.updGet({ url: `https://api.github.com/repos/${UPD_REPO}/commits/android-updates-next` });
    const head = JSON.parse(r.text || '{}');
    if (/^[0-9a-f]{40}$/i.test(head.sha || '')) base = `https://raw.githubusercontent.com/${UPD_REPO}/${head.sha}/`;
  } catch { L('update', { snapshotFallback: true }); }
  return { base, pub: UPD_PUBKEY };
}
async function updVerify(u, pub) {
  if (!u || typeof u.m !== 'string' || typeof u.sig !== 'string' || u.m.length > 4000) return { error: 'плохое описание' };
  let good = false;
  try {
    const { verifyAsync } = await import('./vendor/noble-ed25519.js');
    good = await verifyAsync(b64bytes(u.sig), new TextEncoder().encode(u.m), b64bytes(pub));
  } catch { good = false; }
  if (!good) return { error: 'подпись не сходится' };
  let man;
  try { man = JSON.parse(u.m); } catch { return { error: 'плохое описание' }; }
  const a = man?.apk;
  if (man?.app !== 'alloconnect-android' || !/^\d+\.\d+\.\d+$/.test(String(man.v)) || !a || !/^[\w.-]+\.apk$/.test(String(a.n))
    || !/^[a-f0-9]{64}$/.test(String(a.sha256)) || !(a.size > 0 && a.size < 100 * 1024 * 1024)) return { error: 'плохое описание' };
  return { man };
}
async function updCheck(manual) {
  if (U.busy) return;
  U.busy = true;
  U.err = '';
  updRender();
  try {
    const src = await updSource();
    const r = await alo.updGet({ url: `${src.base}update-android.json?t=${Date.now()}` });
    if (typeof r.text !== 'string') throw new Error(r.error || 'нет связи с GitHub');
    let u;
    try { u = JSON.parse(r.text); } catch { throw new Error('плохое описание'); }
    const c = await updVerify(u, src.pub);
    if (c.error) { L('update', { rejected: c.error }); throw new Error(c.error); }
    store.set('updLast', Date.now());
    const newer = verCmp(c.man.v, VERSION) > 0;
    U.found = newer ? { v: c.man.v, notes: String(c.man.notes || '').slice(0, 400), apk: c.man.apk, base: src.base } : null;
    U.none = !newer;
    L('update', newer ? { found: c.man.v } : { none: c.man.v });
  } catch (e) {
    U.err = String(e.message || e).slice(0, 120);
    if (!manual) L('update', { checkFailed: U.err });
  } finally {
    U.busy = false;
    updRender();
  }
}
function updAuto() {
  if (settings().updAuto === false || S.inCall || S.pc || U.busy || U.dl) return;
  if (!alo.native && !store.get('updTest', null)) return; // стенд автотестов на настоящий GitHub не ходит
  if (Date.now() - (Number(store.get('updLast', 0)) || 0) < UPD_EVERY) return;
  updCheck(false);
}
async function updInstall() {
  const f = U.found;
  if (!f || U.dl) return;
  U.dl = true;
  U.err = '';
  U.pct = 0;
  updRender();
  try {
    if (U.ready !== f.v) {
      const progress=U.transfer=trackTransfer({name:'Обновление Android '+f.v,size:f.apk.size},'in',NOUI);
      try{const r = await alo.updDownload({ url: `${f.base}${f.apk.n}?t=${Date.now()}`, sha256: f.apk.sha256, size: f.apk.size });
      if (!r.ok) throw new Error(r.error || 'не скачалось');progress.done();}catch(e){progress.fail(e.message);throw e;}finally{U.transfer=null;}
      U.ready = f.v;
    }
    const r = await alo.updInstall();
    if (r.needPermission) toast('Разреши alloconnect «Установку приложений», вернись и нажми «Обновить» ещё раз');
    else if (!r.ok) throw new Error(r.error || 'не открылась установка');
    L('update', { install: r.ok ? 'opened' : 'permission' });
  } catch (e) {
    U.err = String(e.message || e).slice(0, 120);
    L('update', { installFailed: U.err });
    toast('Обновление: ' + U.err);
  } finally {
    U.dl = false;
    updRender();
  }
}
function updRender() {
  const f = U.found;
  const btnText = U.dl ? (U.ready === f?.v ? 'Открываю…' : `Скачиваю… ${U.pct}%`) : 'Обновить';
  // плашка на главном экране — пока не скрыли эту версию
  const bar = $('updBar');
  bar.classList.toggle('hidden', !f || store.get('updSkip', '') === f.v);
  if (f) {
    $('updBarTitle').textContent = `Вышла версия ${f.v}`;
    $('updBarNotes').textContent = f.notes;
    $('updBarNotes').classList.toggle('hidden', !f.notes);
    $('updBarGo').textContent = btnText;
    $('updBarGo').disabled = U.dl;
  }
  // настройки
  const last = Number(store.get('updLast', 0)) || 0;
  $('updState').textContent = U.busy ? 'Проверяю…'
    : f ? `Есть версия ${f.v}${f.notes ? ' — ' + f.notes : ''}`
      : U.err ? `Не удалось проверить: ${U.err}`
        : U.none ? 'У тебя последняя версия'
          : last ? 'Последняя проверка — ' + new Date(last).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Ещё не проверял';
  $('updGo').classList.toggle('hidden', !f);
  $('updGo').textContent = btnText;
  $('updGo').disabled = U.dl;
  $('updCheck').disabled = U.busy || U.dl;
}
/* =========================================================
   Поверх моего показа экрана (как у ПК): рисунки и указка друга, реакции, картинки и видео — в окне поверх всех
   приложений (OverlayWin.java + overlay.js с ПК). Нужно разрешение «Поверх других приложений». Управлять телефоном
   с ПК нельзя (ctl:false).
   ========================================================= */
let ovlOk = false; // разрешение «Поверх других приложений»
const SVID_IN_MAX = 60 * 1024 * 1024; // видео на экран телефона: через мост окна — меньше, чем у ПК (100 МБ)
function myPerm() {
  const o = settings();
  return { draw: ovlOk && o.ovlDraw !== false, react: ovlOk && !!o.ovlReact, ctl: false };
}
function sendPerm() { if (S.connected) send({ t: 'perm', ...myPerm(), vid: myPerm().react ? 1 : 0, mediaLong: 1, mediaMax: SVID_IN_MAX, ops: 1 }); }
async function refreshOvlOk() {
  const was = ovlOk;
  ovlOk = !!(await alo.status()).overlay;
  if (was !== ovlOk) { sendPerm(); grpPermChanged(); }
  return ovlOk;
}
function ovlAllowed(kind) { return !!SH && myPerm()[kind]; }
const ovlMsg = (m) => alo.overlayMsg({ json: JSON.stringify(m) });
let ovlEpoch=0;
const ovlCancelledVideos=new Map();
function ovlVideoCancelled(fid){const at=ovlCancelledVideos.get(fid);if(at&&Date.now()-at<120000)return true;ovlCancelledVideos.delete(fid);return false;}
function cancelShareVideo(fid){
  ovlCancelledVideos.set(fid,Date.now());while(ovlCancelledVideos.size>128)ovlCancelledVideos.delete(ovlCancelledVideos.keys().next().value);
  const pending=S.fileChan?.incoming.get(fid);
  if(pending?.meta.p==='screenvid'){S.fileChan.incoming.delete(fid);pending.ui.fail('отменено отправителем');}
  ovlMsg({t:'vid-stop',fid});
}
async function ovlBytes(blob,active=()=>true) {
  const id=newMid(),epoch=ovlEpoch;
  const current=()=>epoch===ovlEpoch&&active();
  try{
    for(let offset=0;offset<blob.size;offset+=512*1024){
      if(!current())throw Error('media cancelled');
      const bytes=new Uint8Array(await blob.slice(offset,offset+512*1024).arrayBuffer());
      if(!current())throw Error('media cancelled');
      const result=await alo.overlayChunk({id,b64:bytesToB64(bytes)});
      if(alo.native&&result.ok!==true)throw Error('overlay unavailable');
    }
    if(!current())throw Error('media cancelled');
    return id;
  }catch(e){await ovlMsg({t:'bytes-drop',ref:id});throw e;}
}
async function ovlStart() {
  if (!(await refreshOvlOk()) || !(myPerm().draw || myPerm().react)) return;
  const r = await alo.overlayShow();
  L('overlay', { show: !!r.ok });
}
function ovlStop() { ovlEpoch++; ovlCancelledVideos.clear(); alo.overlayHide(); }
let ovlReactIn = [];
let ovlImgLast = 0, ovlVidLast = 0;
function onOverlayData(d) {
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  switch (d.t) {
    case 'draw':
      if (!ovlAllowed('draw') || !Array.isArray(d.pts)) return;
      ovlMsg({ t: 'stroke', id: String(d.id).slice(0, 20), c: (/^#[0-9a-f]{6}$/i.test(d.c) ? d.c : '#ff3c50') + (d.hl ? '73' : ''),
        w: Math.max(2, Math.min(14, Number(d.w) || 5)), pts: d.pts.slice(0, 300).map((p) => [clamp(p[0]), clamp(p[1])]), done: !!d.done });
      return;
    case 'ptr':
      if (ovlAllowed('draw')) ovlMsg({ t: 'ptr', x: clamp(d.x), y: clamp(d.y), nick: S.friendNick });
      return;
    case 'ptr-off':
      if (SH) ovlMsg({ t: 'ptr-off' });
      return;
    case 'draw-clear':
      if (SH) ovlMsg({ t: 'clear' });
      return;
    case 'react': {
      if (!ovlAllowed('react') || !['😂', '🔥', '👍', '❤️', '😮', '👏', '💀', '🤡'].includes(d.e)) return;
      const now = Date.now();
      ovlReactIn = ovlReactIn.filter((t) => now - t < 2000);
      if (ovlReactIn.length >= 8) return;
      ovlReactIn.push(now);
      ovlMsg({ t: 'react', e: d.e });
      return;
    }
    default:
  }
}
async function onShareImage(blob, meta) {
  if (!ovlAllowed('react') || !/^image\/(png|jpeg|gif|webp)$/.test(meta.mime)) return;
  if (Date.now() - ovlImgLast < 3000) return;
  ovlImgLast = Date.now();
  const share=SH;let ref;try{ref=await ovlBytes(blob,()=>SH===share&&ovlAllowed('react'));}catch(e){L('screenimg',{cancelled:true});return;}
  ovlMsg({ t: 'img', ref, mime: meta.mime, nick: S.friendNick, pl: meta.pl || null });
  L('screenimg', { shown: true });
}
async function onShareVideo(blob, meta) {
  if (!SH) { send({ t: 'svid-no', why: 'busy' }); return; }
  if(ovlVideoCancelled(meta.fid))return;
  if (!myPerm().react) { send({ t: 'svid-no', why: 'off' }); return; }
  if (!/^(video|audio)\//.test(meta.mime) || blob.size > SVID_IN_MAX) { send({ t: 'svid-no', why: blob.size > SVID_IN_MAX ? 'big' : 'fmt' }); return; }
  if (Date.now() - ovlVidLast < 3000) return;
  ovlVidLast = Date.now();
  const o = settings();
  const mine = o.svidInSound !== false ? Math.max(0, Math.min(100, Number(o.svidInVol ?? 80))) / 100 : 0;
  const vol = meta.snd && !S.deafened ? Math.round((Number(meta.vol) || 0) * mine * 100) / 100 : 0;
  const share=SH;let ref;try{ref=await ovlBytes(blob,()=>SH===share&&myPerm().react&&!ovlVideoCancelled(meta.fid));}catch(e){if(SH===share&&!ovlVideoCancelled(meta.fid))send({t:'svid-no',why:'busy'});L('screenvid',{cancelled:true});return;}
  ovlMsg({ t: 'vid', fid:meta.fid, ref, mime: meta.mime, nick: S.friendNick, pl: meta.pl || null, vol });
  if(!alo.native)send({ t: 'svid-play',fid:meta.fid });
  L('screenvid', { received: true, mb: Math.round(blob.size / 1048576), vol });
}
function renderOvlState() {
  $('ovlState').textContent = ovlOk ? 'Разрешено поверх других приложений' : 'Нужно разрешить «Поверх других приложений» — иначе друг не сможет рисовать на твоём экране';
  $('ovlState').classList.toggle('bad-text', !ovlOk);
  $('ovlAllow').classList.toggle('hidden', ovlOk);
}

/* ---------- Код дружбы (как у ПК 1.16): добавить друга одним коротким кодом, без звонка ----------
   Я отправляю свой код → друг вставляет → мне приходит запрос → принял — оба в списке.
   Не достучаться напрямую — у друга есть ответный код: вставляю его, и программы стучатся друг к другу сами. */
const FC = { reqs: [], cur: null, wait: null, replyTimer: null, seq: 0 };
const fcNick = () => $('nick').value.trim() || 'Без имени';
function fcStatus(text, cls = '') { const el = $('fcStatus'); el.textContent = text; el.className = 'small ' + cls; }
async function fcOpen(code) {
  if (!myIdent?.id) { toast('Сеть друзей ещё не готова'); return; }
  $('fcModal').classList.remove('hidden');
  if (!FC.wait) { fcStatus(''); $('fcReplyBlock').classList.add('hidden'); }
  $('fcIn').value = code || '';
  fcCheckInput();
  $('fcCopy').disabled = $('fcShare').disabled = true;
  const r = await alo.fcMake({ nick: fcNick() });
  if (!r?.code) { $('fcMine').value = ''; $('fcMine').placeholder = 'Не получилось — сеть друзей не запущена'; return; }
  ownCodes.add(r.code);
  $('fcMine').value = r.code;
  $('fcCopy').disabled = $('fcShare').disabled = false;
}
async function fcCheckInput() {
  const code = $('fcIn').value.trim();
  const seq = ++FC.seq;
  $('fcAdd').disabled = true;
  if (!code) { if (!FC.wait) fcStatus(''); return; }
  const r = await alo.fcParse({ code });
  if (seq !== FC.seq) return;
  if (!r.ok) fcStatus('Код не читается — скопируй его целиком', 'bad-text');
  else if (r.own) fcStatus('Это твой собственный код — его нужно отправить другу', 'bad-text');
  else if (r.already) fcStatus(`${friendNickOf(r.id)} уже в друзьях`);
  else { fcStatus(r.reply ? `Ответный код от ${r.nick} — нажми «Добавить»` : `Код дружбы от ${r.nick} — нажми «Добавить»`); $('fcAdd').disabled = false; }
}
async function fcAdd() {
  $('fcAdd').disabled = true;
  const r = await alo.fcUse({ code: $('fcIn').value.trim(), nick: fcNick() });
  if (!r.ok || r.own || r.already) { fcCheckInput(); return; }
  $('fcIn').value = '';
  L('friends', { friendCode: r.added ? 'reply-used' : 'used' });
  if (r.added) {
    FC.wait = null;
    $('fcReplyBlock').classList.add('hidden');
    fcStatus(`${r.nick} — в друзьях ✓ «В сети» появится, как только ваши программы найдут друг друга`, 'ok-text');
    return;
  }
  FC.wait = { id: r.id, nick: r.nick, seen: false };
  fcStatus(`Стучусь к ${r.nick}…`);
  ownCodes.add(r.replyCode);
  $('fcReply').value = r.replyCode;
  $('fcReplyNick').textContent = r.nick;
  $('fcReplyBlock').classList.add('hidden');
  clearTimeout(FC.replyTimer);
  FC.replyTimer = setTimeout(() => {
    if (FC.wait?.id !== r.id || FC.wait.seen) return;
    fcStatus(`${r.nick} пока не отвечает`);
    $('fcReplyBlock').classList.remove('hidden');
  }, 8000);
}
function fcOnEvent(e) {
  if(window.accountLab?.handlesFriendCode(e))return;
  if (!e || !/^[A-Za-z0-9_-]{43}$/.test(String(e.id || ''))) return;
  if (e.type === 'request') {
    if (FC.cur?.id !== e.id && !FC.reqs.some((x) => x.id === e.id)) FC.reqs.push({ id: e.id, nick: String(e.nick || 'Без имени') });
    fcNextReq();
    return;
  }
  const mine = FC.wait?.id === e.id;
  if (e.st === 'seen' && mine) {
    FC.wait.seen = true;
    $('fcReplyBlock').classList.add('hidden');
    fcStatus(`Запрос дошёл — ждём, пока ${e.nick} примет`);
  } else if (e.st === 'added') {
    if (mine) { FC.wait = null; clearTimeout(FC.replyTimer); $('fcReplyBlock').classList.add('hidden'); fcStatus(`${e.nick} — в друзьях ✓`, 'ok-text'); }
    toast(`${e.nick} теперь в друзьях — звони прямо из списка`);
    sound('join');
  } else if (e.st === 'declined' || e.st === 'expired') {
    if (mine) { FC.wait = null; clearTimeout(FC.replyTimer); $('fcReplyBlock').classList.add('hidden'); }
    const text = e.st === 'declined' ? `${e.nick} отклонил(а) запрос в друзья` : `Запрос в друзья к ${e.nick} не дошёл за сутки — попроси новый код`;
    if (mine) fcStatus(text, 'bad-text');
    toast(text);
  }
}
function fcNextReq() {
  if (FC.cur || !FC.reqs.length) return;
  FC.cur = FC.reqs.shift();
  $('fcReqTitle').textContent = `${FC.cur.nick} хочет в друзья`;
  $('fcReqAvatar').querySelector('span').textContent = initial(FC.cur.nick);
  $('fcReqModal').classList.remove('hidden');
  sound('msg');
  try { navigator.vibrate?.([120, 80, 120]); } catch { /* */ }
}
async function fcAnswer(ok) {
  const r = FC.cur;
  if (!r) return;
  FC.cur = null;
  $('fcReqModal').classList.add('hidden');
  if (!ok) alo.fcDecline({ id: r.id });
  else if ((await alo.fcAccept({ id: r.id, nick: fcNick() })).ok) {
    toast(`${r.nick} теперь в друзьях — звони прямо из списка`);
    $('fcModal').classList.add('hidden');
  } else toast('Не удалось добавить');
  fcNextReq();
}
function fcBind() {
  alo.on('friendCode', (e) => fcOnEvent(e));
  $('btnAddFriendCode').onclick = () => fcOpen();
  $('fcClose').onclick = () => $('fcModal').classList.add('hidden');
  $('fcCopy').onclick = () => { alo.copy({ text: $('fcMine').value }); toast('Код скопирован — отправь его другу'); };
  $('fcShare').onclick = () => alo.share({ text: $('fcMine').value, title: 'Код дружбы alloconnect' });
  $('fcReplyCopy').onclick = () => { alo.copy({ text: $('fcReply').value }); toast('Ответный код скопирован'); };
  $('fcReplyShare').onclick = () => alo.share({ text: $('fcReply').value, title: 'Ответный код alloconnect' });
  $('fcPaste').onclick = async () => { $('fcIn').value = (await alo.paste()).text || ''; fcCheckInput(); };
  $('fcIn').oninput = fcCheckInput;
  $('fcAdd').onclick = fcAdd;
  $('fcReqAccept').onclick = () => fcAnswer(true);
  $('fcReqDecline').onclick = () => fcAnswer(false);
  // запросы, пришедшие, пока окна не было
  alo.fcPending().then((p) => { for (const r of p?.incoming || []) fcOnEvent({ type: 'request', ...r }); }).catch(() => {});
}

/* ---------- «Поделиться → alloconnect» из других приложений: кому отправить ---------- */
let shareIn = null; // { files: File[], text }
async function onShared(incoming) {
  const r = incoming?.files ? incoming : await alo.takeShared();
  if (!r || (!r.files?.length && !r.text)) { if (r?.tooBig) toast('Слишком большой файл — отправь через 📎 в чате'); return; }
  shareIn = r;
  if (r.tooBig) toast('Что-то больше 200 МБ — его отправь через 📎 в чате');
  L('share-in', { files: r.files.length, text: !!r.text });
  const what = r.files.length ? (r.files.length === 1 ? r.files[0].name : `${r.files.length} файла(ов)`) : 'текст';
  $('shareInTitle').textContent = `Отправить: ${what}`;
  const list = $('shareInList');
  list.replaceChildren();
  const add = (label, sub, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn wide share-to';
    b.textContent = label;
    if (sub) { const s2 = document.createElement('small'); s2.className = 'muted'; s2.textContent = ' ' + sub; b.appendChild(s2); }
    b.onclick = () => { $('shareIn').classList.add('hidden'); fn(); };
    list.appendChild(b);
  };
  if (S.connected && S.fileChan) add(`📞 В звонок — ${S.friendNick}`, '', () => shareToCall());
  const fl = [...friendsList].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  for (const f of fl) add(f.nick, f.online ? 'в сети' : 'не в сети', () => shareToFriend(f.id));
  // в тексте ссылка (пин Pinterest, страница с видео) — можно отправить само видео/картинку
  const link = !r.files.length && /https?:\/\/[^\s<>"]+/i.exec(r.text || '')?.[0];
  if (link) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn wide share-web';
    b.textContent = '🎬 Взять видео/картинку по ссылке';
    b.onclick = async () => {
      b.disabled = true; b.textContent = '⏳ Скачиваю…';
      try {
        const f = await fetchWebMedia(link);
        if (shareIn !== r) return;
        r.files = [f]; r.text = '';
        $('shareInTitle').textContent = `Отправить: ${f.name}`;
        b.remove();
      } catch (e) { b.disabled = false; b.textContent = '🎬 Взять видео/картинку по ссылке'; toast('Не получилось: ' + e.message); }
    };
    list.appendChild(b);
  }
  if (!fl.length && !S.connected) { const p2 = document.createElement('p'); p2.className = 'muted small'; p2.textContent = 'Пока некому: сначала добавь друга (после первого звонка — «В друзья»).'; list.appendChild(p2); }
  $('shareIn').classList.remove('hidden');
}
// ссылка на страницу (пин Pinterest и т. п.) — ищем в ней настоящее видео, иначе картинку страницы (как mediaFromPage ПК 1.21)
function mediaFromPage(html, base) {
  const un = (s) => String(s).replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const abs = (s) => { try { return new URL(un(s), base).href; } catch { return null; } };
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
    const tag = re.exec(html)?.[0];
    return tag ? /content=["']([^"']+)["']/i.exec(tag)?.[1] || null : null;
  };
  const found = [];
  // Pinterest: видео лежит mp4 на pinimg.com (720p лучше, hls/m3u8 не годится)
  const pins = [...html.matchAll(/https?:(?:\\?\/){2}v\d*\.pinimg\.com(?:\\?\/)videos(?:\\?\/)[^"'\s<>]+?\.mp4/gi)].map((m) => un(m[0]));
  pins.sort((a, b) => (/720p/.test(b) ? 1 : 0) - (/720p/.test(a) ? 1 : 0));
  found.push(...pins);
  for (const p of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) { const v = meta(p); if (v) found.push(v); }
  for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+\.(?:mp4|webm|mov)[^"]*)"/gi)) found.push(m[1]);
  for (const m of html.matchAll(/<(?:video|source)[^>]+src=["'](https?:[^"']+)["']/gi)) found.push(m[1]);
  const vids = found.map(abs).filter((x) => x && /^https?:/.test(x) && !/\.m3u8(\?|$)/i.test(x));
  if (vids.length) return vids[0];
  const img = meta('og:image:secure_url') || meta('og:image') || meta('twitter:image');
  return img ? abs(img) : null;
}
// скачать картинку/видео по ссылке (Java качает — без CORS); страница → ищем в ней медиа и качаем его
async function fetchWebMedia(url) {
  if(youtubeLink(url))return youtubeFetchFile(url);
  let r = await alo.webMedia({ url, page: true });
  if (r?.html) {
    const media = mediaFromPage(r.html, r.url || url);
    L('share-in', { page: true, found: media ? (new URL(media).pathname.split('.').pop() || '').slice(0, 5) : null });
    if (!media) throw new Error('на странице нет картинки или видео');
    r = await alo.webMedia({ url: media, page: false });
  }
  if (!r || r.error || (!r.key && !r.b64)) throw new Error({ 'too-big': 'больше 100 МБ', 'not-media': 'по ссылке нет картинки или видео', timeout: 'не дождался ответа' }[r?.error] || 'не получилось скачать');
  const blob = r.key ? await (await fetch('/_alo/shared/' + encodeURIComponent(r.key), { cache: 'no-store' })).blob()
    : new Blob([Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0))]);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[r.mime] || '';
  let name = String(r.name || '').trim() || 'файл';
  if (ext && !/\.[a-z0-9]{2,4}$/i.test(name)) name += '.' + ext;
  return new File([blob], name, { type: r.mime });
}
function shareToCall() {
  const r = shareIn; shareIn = null;
  if (!r) return;
  if (r.files.length) S.fileChan.queue(r.files);
  if (r.text) { if (!S.chatOpen) toggleChat(true); $('chatInput').value = r.text; }
}
function shareToFriend(id) {
  const r = shareIn; shareIn = null;
  if (!r) return;
  if (S.connected && S.callConv?.id === id) { S.fileChan.queue(r.files); if (r.text) { if (!S.chatOpen) toggleChat(true); $('chatInput').value = r.text; } return; }
  openDm(id);
  if (r.text) $('dmInput').value = r.text;
  if (r.files.length) dmSendFiles(r.files);
}

function bindProfile() {
  alo.on('shared', () => onShared());
  $('btnRejoin').onclick = () => rejoinCall();
  $('rejoinClose').onclick = () => { S.rejoin = null; showRejoin(); };
  $('btnCallAgain').onclick = () => callAgain();
  setInterval(showRejoin, 30000);
  $('ovlAllow').onclick = () => alo.openSettings({ what: 'overlay' });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshOvlOk().then(() => { if (!$('settings').classList.contains('hidden')) renderOvlState(); }); });
  refreshOvlOk();
  $('shareInCancel').onclick = () => { shareIn = null; $('shareIn').classList.add('hidden'); };
  setTimeout(onShared, 1500); // приложение открыли через «Поделиться»
  $('myAvPick').onclick = () => $('myAvFile').click();
  $('myAvFile').onchange = (e) => { pickAvatar(e.target.files[0]); e.target.value = ''; };
  $('myAvClear').onclick = () => clearAvatar();
  $('myAvTalk').onclick = () => window.talkingAvatar.edit(myAvatarUrl(), async (bytes, mime) => {
    const hash = await sha16(bytes);
    if (myAvatar?.url) URL.revokeObjectURL(myAvatar.url);
    myAvatar = { hash, mime, b64: bytesToB64(bytes) };
    store.set('av.me', { hash, mime, b64: myAvatar.b64 }); refreshAvatars();
    if(window.accountLab?.engine.account)await window.accountLab.sync.mutate(async()=>{});
    announceAvatar(hash); toast('Настройка говорящей аватарки сохранена');
  });
  $('ringPick').onclick = () => $('ringFile').click();
  $('ringFile').onchange = (e) => { pickRing(e.target.files[0]); e.target.value = ''; };
  $('ringClear').onclick = () => { store.del('ring.file'); renderRingName(); };
  $('ringTest').onclick = () => ringPreview();
  confirmBtn($('btnClearAll'), 'Точно удалить всё?', () => { clearAllHistory(); toast('История всех чатов удалена'); });
  confirmBtn($('dmClearBtn'), '🗑?', () => { clearHistory(dmOpen); toast('История с другом удалена'); });
}
function bindUpdates() {
  alo.on('updProgress', (p) => { U.transfer?.progress(Number(p.got)||0); U.pct = Math.min(100, Math.round((Number(p.got) || 0) * 100 / (Number(p.total) || 1))); updRender(); });
  $('updBarGo').onclick = () => updInstall();
  $('updGo').onclick = () => updInstall();
  $('updBarLater').onclick = () => { if (U.found) store.set('updSkip', U.found.v); updRender(); };
  $('updCheck').onclick = () => updCheck(true);
  updRender();
  setTimeout(updAuto, 8000);
  setInterval(updAuto, 3600 * 1000);
}

// поля сообщений (textarea): Enter — отправить (как раньше у однострочного), поле растёт под текст
function growMsgInput(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + (el.offsetHeight - el.clientHeight) + 'px';
}
function bindMsgInputs() {
  for (const el of document.querySelectorAll('.msg-input')) {
    const send = () => el.form?.requestSubmit();
    // IME Enter may confirm a suggested/composed word rather than send a message.
    let composing = false;
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => { composing = false; });
    el.addEventListener('beforeinput', (e) => { if (!composing && !e.isComposing && (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph')) { e.preventDefault(); send(); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); } });
    el.addEventListener('input', () => growMsgInput(el));
    el.addEventListener('focus', () => growMsgInput(el));
    // после отправки/вставки текста кодом (value = …) — подогнать высоту
    el.form?.addEventListener('submit', () => setTimeout(() => growMsgInput(el), 0));
    const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(el, 'value', { get() { return d.get.call(this); }, set(v) { d.set.call(this, v); requestAnimationFrame(() => growMsgInput(el)); }, configurable: true });
  }
}


let entryCodeGeneration = 0;
async function entryCodePreview() {
 const generation=++entryCodeGeneration, text=$('entryCode').value.trim();let hint='',ok=false;
 try {
  if(/ALOGI\./.test(text)){const d=await grpManualRead(text,'I');hint='Приглашение в группу от '+grpClean(d.nick);ok=true;}
  else if(/ALOGA\./.test(text))hint='Это ответ на групповое приглашение. Примени его в окне, где создавал код группы.';
  else if(/ALOF\./.test(text)){hint='Код дружбы — откроется подтверждение добавления';ok=true;}
  else if(/ALO[IA]\./.test(text)){const d=await unpackCode(text);if(d.kind==='I'){hint='Приглашение в звонок от '+String(d.nick||'друга').slice(0,24);ok=true;}else hint='Это ответ на твой код звонка. Вставь его в поле «Ответ друга».';}
  else if(text)hint='Нужен полный код alloconnect';
 }catch(e){hint=e.message;}
 if(generation!==entryCodeGeneration)return;
 $('entryCodeHint').textContent=hint;$('entryCodeGo').disabled=!ok;
}
async function entryCodeContinue(){
 const text=$('entryCode').value.trim();if(!text)return;
 if(grpBusy()){toast('Сначала заверши текущий звонок');return;}
 if(/ALOGI\./.test(text))await grpManualJoin(text);
 else if(/ALOF\./.test(text))await fcOpen(text);
 else {try{const d=await unpackCode(text);if(d.kind!=='I')return;showStep('stepGuest');$('offerIn').value=text;}catch(e){toast(e.message);}}
}

/* =========================================================
   Старт
   ========================================================= */
(async function main() {
  bindSettingsCats();
  bind();
  bindUpdates();
  bindTransfers();
  bindYoutube();
  alo.on('overlayVideoState', state=>{if(SH&&S.connected&&Number.isInteger(state.fid))send({t:state.playing?'svid-play':'svid-stop',fid:state.fid});});
  bindProfile();
  fcBind();
  grpBind();
  stkBind();
  bindMsgInputs();
  L('app', { start: VERSION, native: alo.native, ua: navigator.userAgent.replace(/.*Chrome\/(\d+).*/, 'Chrome $1') });
  await initScreenCompat();
  await bindPresence();
  await initFriends();
  const inbox=await alo.inboxState();for(const item of inbox.items||[]){await onFriendMsg(item);await alo.inboxAck({key:item.key});}
  alo.on('outboxDelivered',outboxDelivered);
  await restoreOutbox();
  await takePending();
  renderStatus().catch(() => {});
  setTimeout(checkClipboard, 800);
})();
