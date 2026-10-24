'use strict';

/* =========================================================
   alloconnect — звонок и демонстрация экрана на двоих.
   Чистый WebRTC без серверов: приглашение и ответ пересылаются вручную.
   ========================================================= */

const $ = (id) => document.getElementById(id);

/* ---------- Лог (тестовая сборка) ---------- */
function L(tag, data) {
  try { window.duo?.log(tag, typeof data === 'string' ? data : JSON.stringify(data)); } catch { /* */ }
}
for (const lvl of ['warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => {
    orig(...a);
    L(lvl, a.map((x) => (x instanceof Error ? (x.stack || x.message) : (typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x)))).join(' ').slice(0, 2000));
  };
}
window.addEventListener('error', (e) => L('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => L('error', 'unhandled: ' + (e.reason?.stack || e.reason)));

const GATHER_TIMEOUT = 5000;     // сколько ждать сбора адресов перед выдачей кода (максимум)
const STUN_FALLBACK_MS = 2500;   // основной STUN молчит столько — переходим на альтернативный
const HOST_CONNECT_TIMEOUT = 25000;
const GUEST_CONNECT_TIMEOUT = 120000;

const QUALITY = {
  '720p30':  { w: 1280, h: 720,  fps: 30, br: 2_500_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, br: 4_500_000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, br: 8_000_000 },
  '1440p60': { w: 2560, h: 1440, fps: 60, br: 12_000_000 },
};

/* ---------- Хранилище настроек ---------- */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('duo.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('duo.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const DEFAULTS = {
  mic: '', out: '', noise: true, echo: true, agc: true, sounds: true,
  noStun: false, stunAlt: false, stunCustom: '', turnUrl: '', turnUser: '', turnPass: '', relay: false, quality: '1080p60', minKbps: 2500, rnn: true,
  ringVol: 80, ringMute: false, spVolOut: 100, spVolMon: 60, spMonitor: true, spWhenMuted: true,
  duckOn: true, duckAmount: 50, duckOthers: true, duckMe: false, duckStream: true,
  ovlDraw: true, ovlReact: false, ctlAllow: true,
  clip: true, clipSeconds: 30,
  ptt: false, pttVk: 0, pttName: '', activity: false, autoUpdate: true,
  svidVol: 70, svidSound: true,      // видео на экран друга: как отправляю
  svidInSound: true, svidInVol: 80,  // видео от друга поверх моего экрана: как слышу
};
const settings = () => ({ ...DEFAULTS, ...store.get('settings', {}) });

/* ---------- Темы оформления (стили — themes.css) ---------- */
const THEMES = [
  { id: '', name: 'Стандартная', sw: ['#111216', '#20222a', '#7c5cff', '#3ddc84'] },
  { id: 'neon', name: 'Неоновая ночь', sw: ['#07060f', '#161331', '#ff2bd6', '#00f0ff'] },
  { id: 'terminal', name: 'Терминал', sw: ['#030703', '#0a160b', '#39ff6a', '#1f9a44'] },
  { id: 'glass', name: 'Стекло', sw: ['#3b5bdb', '#9b4dff', '#12b5a6', '#f3f6ff'] },
  { id: 'pixel', name: 'Ретро-пиксель', sw: ['#1a1c3a', '#3a3d78', '#ffcd1f', '#ff4d6d'] },
  { id: 'manga', name: 'Манга', sw: ['#f3efe6', '#ffffff', '#111111', '#e63946'] },
  { id: 'space', name: 'Космос', sw: ['#04040c', '#4b3fb5', '#8b7bff', '#4fd1ff'] },
];
function applyTheme(id) {
  const t = THEMES.some((x) => x.id === id) ? id : '';
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  document.querySelectorAll('#themeGrid .theme-card').forEach((b) => b.classList.toggle('selected', b.dataset.id === t));
}
function buildThemeGrid() {
  const g = $('themeGrid');
  if (!g || g.childElementCount) return;
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-card';
    b.dataset.id = t.id;
    const sw = document.createElement('span');
    sw.className = 'theme-sw';
    sw.style.background = `linear-gradient(135deg, ${t.sw[0]} 0 40%, ${t.sw[1]} 40% 60%, ${t.sw[2]} 60% 80%, ${t.sw[3]} 80%)`;
    const n = document.createElement('span');
    n.textContent = t.name;
    b.append(sw, n);
    b.onclick = () => { applyTheme(t.id); store.set('settings', { ...settings(), theme: t.id }); L('settings', { theme: t.id || 'standard' }); };
    g.appendChild(b);
  }
}
applyTheme(settings().theme || '');

/* ---------- Состояние ---------- */
const S = {
  pc: null, dc: null, role: null,      // role: 'host' | 'guest'
  tx: null,                            // { mic, video, saudio } — трансиверы
  nick: '', friendNick: '',
  mic: null, localScreen: null, quality: '1080p60',
  muted: false, deafened: false,
  connected: false, inCall: false, busy: false,
  connectTimer: null, statsTimer: null,
  stopMyMeter: null, stopFriendMeter: null,
  platform: 'win32',
};

/* =========================================================
   Упаковка SDP в короткий текстовый код
   ========================================================= */
function b64uEnc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDec(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deflate(text) {
  const st = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
async function inflate(bytes) {
  const st = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(st).text();
}

// Выкидываем из SDP строки, без которых соединение спокойно обходится
function minifySdp(sdp) {
  const drop = [
    /^a=extmap:\d+ urn:3gpp:video-orientation/,
    /^a=extmap:\d+ http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/(playout-delay|video-content-type|video-timing|color-space)/,
    /^a=extmap:\d+ urn:ietf:params:rtp-hdrext:toffset/,
    /^a=extmap:\d+ urn:ietf:params:rtp-hdrext:sdes:(rtp-stream-id|repaired-rtp-stream-id)/,
    /^a=candidate:.* tcp /,              // TCP-кандидаты почти никогда не помогают в P2P
    /^a=candidate:.* typ host .*(fe80|::1)/i,
  ];
  return sdp.split(/\r?\n/).filter((l) => l && !drop.some((re) => re.test(l))).join('\r\n') + '\r\n';
}

// Просим у собеседника стерео-звук (для звука игр/видео в демонстрации)
function opusStereo(sdp) {
  const pts = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000\/2/gm)].map((m) => m[1]);
  let out = sdp;
  for (const pt of pts) {
    out = out.replace(new RegExp(`^(a=fmtp:${pt} [^\\r\\n]*)`, 'gm'), (line) =>
      (/stereo=1/.test(line) ? line : line + ';stereo=1;sprop-stereo=1;maxaveragebitrate=128000'));
  }
  return out;
}

async function packCode(kind, sdp, nick) {
  const payload = (nick || '').replace(/\n/g, ' ').slice(0, 24) + '\n' + bitrateHints(opusStereo(minifySdp(sdp)));
  return `ALO${kind}.` + b64uEnc(await deflate(payload));
}

async function unpackCode(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const m = /ALO([IA])\.([A-Za-z0-9_-]+)/.exec(t);
  if (!m) throw new Error('Это не код alloconnect — скопируй его целиком');
  let raw;
  try { raw = await inflate(b64uDec(m[2])); } catch { throw new Error('Код повреждён или скопирован не полностью'); }
  const nl = raw.indexOf('\n');
  const nick = raw.slice(0, nl);
  const sdp = raw.slice(nl + 1);
  if (!sdp.startsWith('v=0')) throw new Error('Код повреждён или скопирован не полностью');
  return { kind: m[1], nick, sdp };
}

/* =========================================================
   Звук: WebAudio-граф для голоса друга (громкость до 200%)
   ========================================================= */
let ctx = null, master = null, friendGain = null, fxOut = null, remoteSrc = null;

function audio() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    master = ctx.createGain();
    master.connect(ctx.destination);
    friendGain = ctx.createGain();
    friendGain.gain.value = Number($('friendVol').value) / 100;
    friendGain.connect(master);
    fxOut = ctx.createGain();
    fxOut.connect(ctx.destination);
    applyOutputDevice();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

async function applyOutputDevice() {
  const id = settings().out;
  try { if (ctx && ctx.setSinkId) await ctx.setSinkId(id || ''); } catch (e) { console.warn('sink ctx', e); }
  try { const v = $('remoteScreen'); if (v.setSinkId) await v.setSinkId(id || ''); } catch (e) { console.warn('sink video', e); }
}

function makeMeter(stream, onLevel) {
  const c = audio();
  const src = c.createMediaStreamSource(stream);
  const an = c.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    onLevel(Math.sqrt(sum / buf.length));
  }, 60);
  return () => { clearInterval(timer); try { src.disconnect(); } catch { /* ignore */ } };
}

function sound(kind) {
  if (!settings().sounds) return;
  const c = audio();
  const seq = {
    join: [523, 784], leave: [784, 523], msg: [988],
    mute: [520, 390], unmute: [390, 520], stream: [660, 880, 1046], error: [300, 220],
  }[kind];
  if (!seq) return;
  let t = c.currentTime + 0.01;
  for (const f of seq) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o.connect(g).connect(fxOut);
    o.start(t);
    o.stop(t + 0.16);
    t += 0.085;
  }
}

/* =========================================================
   Микрофон
   ========================================================= */
async function acquireMic() {
  const o = settings();
  const constraints = {
    audio: {
      deviceId: o.mic ? { exact: o.mic } : undefined,
      echoCancellation: o.echo,
      noiseSuppression: o.noise,
      autoGainControl: o.agc,
      channelCount: 1,
    },
    video: false,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (o.mic) {
      constraints.audio.deviceId = undefined;
      try { return await navigator.mediaDevices.getUserMedia(constraints); } catch { /* ниже */ }
    }
    console.warn('mic', e);
    toast('Микрофон не найден — друг тебя не услышит');
    return audio().createMediaStreamDestination().stream; // тишина, чтобы звонок работал
  }
}

function applyMicEnabled() {
  const on = !S.muted && !S.deafened && (!settings().ptt || !settings().pttVk || S.pttDown);
  S.mic?.getAudioTracks().forEach((t) => { t.enabled = on; });
  $('meCard')?.classList.toggle('ptt-open', on && settings().ptt && !!settings().pttVk);
  if (typeof spUpdateGains === 'function') spUpdateGains();
}
function setPttDown(down) {
  if (S.pttDown === down) return;
  S.pttDown = down;
  applyMicEnabled();
}

/* ---------- Шумодав RNNoise: микрофон → нейросеть → дорожка в звонок ---------- */
const chain = { src: null, node: null, dest: null, failed: false, loading: null };
const RNN_ID = '@sapphi-red/web-noise-suppressor/rnnoise';
const wasmSimd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } };

async function ensureRnnoise() {
  if (chain.node || chain.failed) return chain.node;
  if (!chain.loading) {
    chain.loading = (async () => {
      const c = audio();
      const bin = await window.duo.readAsset(wasmSimd() ? 'vendor/rnnoise_simd.wasm' : 'vendor/rnnoise.wasm');
      const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
      await c.audioWorklet.addModule('vendor/rnnoise-worklet.js');
      chain.node = new AudioWorkletNode(c, RNN_ID, { processorOptions: { wasmBinary: buf, maxChannels: 1 }, channelCount: 1, channelCountMode: 'explicit' });
      L('ns', { ready: true, simd: wasmSimd() });
      return chain.node;
    })().catch((e) => { chain.failed = true; L('ns', { failed: String(e && e.message || e) }); toast('Шумодав не запустился — микрофон работает без него'); return null; });
  }
  return chain.loading;
}

function rnnOn() { return settings().rnn !== false && !!chain.node; }

function routeChain() {
  if (!chain.src || !chain.dest) return;
  try { chain.src.disconnect(); } catch { /* */ }
  try { chain.node?.disconnect(); } catch { /* */ }
  if (rnnOn()) { chain.src.connect(chain.node); chain.node.connect(chain.dest); } else chain.src.connect(chain.dest);
  updateNsBtn();
}

// подключить сырой микрофон к цепочке; дорожка на выходе (chain.dest) постоянная
async function attachMicChain(raw) {
  const c = audio();
  if (!chain.dest) { chain.dest = c.createMediaStreamDestination(); chain.dest.channelCount = 1; }
  spBus().connect(chain.dest); // звуки саундпада — после шумодава
  if (settings().rnn !== false) await ensureRnnoise();
  try { chain.src?.disconnect(); } catch { /* */ }
  chain.src = c.createMediaStreamSource(raw);
  routeChain();
}

function micSendTrack() {
  return chain.dest?.stream.getAudioTracks()[0] || S.mic?.getAudioTracks()[0] || null;
}

async function setNs(on) {
  store.set('settings', { ...settings(), rnn: on });
  if (on) await ensureRnnoise();
  routeChain();
  L('ns', { enabled: on && !!chain.node });
  toast(on ? (chain.node ? 'Шумодав включён' : 'Шумодав недоступен') : 'Шумодав выключен');
  sound(on ? 'unmute' : 'mute');
}

function updateNsBtn() {
  const b = $('btnNs');
  if (!b) return;
  const on = rnnOn();
  b.classList.toggle('on', on);
  b.querySelector('span').textContent = on ? 'Шумодав вкл' : 'Шумодав выкл';
}

async function restartMic() {
  if (!S.mic) return;
  const fresh = await acquireMic();
  await attachMicChain(fresh); // выходная дорожка та же — в звонке ничего переподключать не нужно
  S.mic.getTracks().forEach((t) => t.stop());
  S.mic = fresh;
  applyMicEnabled();
  startMyMeter();
}

function startMyMeter() {
  S.stopMyMeter?.();
  if (!S.mic) return;
  S.stopMyMeter = makeMeter(S.mic, (lvl) => {
    $('meCard').classList.toggle('speaking', lvl > 0.02 && !S.muted && !S.deafened);
    duckFeed('me', lvl);
  });
}

/* =========================================================
   WebRTC
   ========================================================= */
/* ---------- STUN: основной список → (если молчит) альтернативный; свои — вместо всех ---------- */
// по порядку: какие списки пробовать
function stunPlan() {
  const o = settings();
  if (o.noStun) return [{ name: 'off', urls: [] }];
  const custom = STUN_LISTS.parse(o.stunCustom);
  if (custom.length) return [{ name: 'custom', urls: custom }];
  if (o.stunAlt) return [{ name: 'alt', urls: STUN_LISTS.alt }];
  return [{ name: 'primary', urls: STUN_LISTS.primary }, { name: 'alt', urls: STUN_LISTS.alt }];
}
const STUN_NAME = { primary: 'основные', alt: 'альтернативные', custom: 'свои', off: 'выключен' };
const stunHost = (url) => String(url || '').replace(/^stuns?:/, '').replace(/\?.*$/, '');
let lastStun = null; // { list, first, ok, at } — для диагностики в настройках

function rtcConfig(urls = stunPlan()[0].urls) {
  const o = settings();
  const iceServers = [];
  if (urls.length) iceServers.push({ urls });
  if (o.turnUrl) iceServers.push({ urls: o.turnUrl, username: o.turnUser, credential: o.turnPass });
  return {
    iceServers,
    iceTransportPolicy: o.relay && o.turnUrl ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };
}

function newPeerConnection(cfg = rtcConfig()) {
  const pc = new RTCPeerConnection(cfg);
  S.pc = pc;
  // Канал данных (чат и служебные сообщения) договорён заранее — одинаковый id у обоих
  const dc = pc.createDataChannel('duo', { negotiated: true, id: 0, ordered: true });
  S.dc = dc;
  dc.onopen = () => { if (S.dc === dc) onConnected(); };
  dc.onclose = () => { if (S.dc === dc) friendGone('Связь закрыта'); };
  dc.onmessage = (e) => {
    if (S.dc !== dc) return;
    try { onData(JSON.parse(e.data)); } catch (err) { console.warn('bad msg', err); }
  };
  // Отдельный канал для файлов — большие передачи не тормозят чат и служебные сообщения
  const fdc = pc.createDataChannel('files', { negotiated: true, id: 1, ordered: true });
  S.fdc = fdc;
  S.fileChan = new FileChan(fdc, () => S.callConv, {
    avatar: (blob, meta) => onAvatarFile(S.peerIdent?.id, blob, meta),
    screenimg: (blob, meta) => onScreenImage(blob, meta),
    screenvid: (blob, meta) => onScreenVideo(blob, meta),
    screenvidBig: () => send({ t: 'svid-no', why: 'big' }),
    chatIn: () => { sound('msg'); if (!document.hasFocus()) window.duo?.attention(); },
    update: (blob, meta) => onUpdateFile(S.peerIdent?.id, blob, meta),
  });
  // Управление: надёжный канал (клавиши, кнопки) и быстрый без повторов (движение мыши, геймпад)
  const cdc = pc.createDataChannel('ctl', { negotiated: true, id: 2, ordered: true });
  const cdu = pc.createDataChannel('ctlu', { negotiated: true, id: 3, ordered: false, maxRetransmits: 0 });
  S.cdc = cdc;
  S.cdu = cdu;
  for (const ch of [cdc, cdu]) ch.onmessage = (e) => { if (S.pc === pc) { try { onCtlMsg(JSON.parse(e.data)); } catch { /* */ } } };
  pc.addEventListener('connectionstatechange', () => { L('pc', { connection: pc.connectionState }); if (S.pc === pc) onPcState(pc.connectionState); });
  pc.addEventListener('iceconnectionstatechange', () => L('pc', { ice: pc.iceConnectionState }));
  pc.addEventListener('icegatheringstatechange', () => L('pc', { gathering: pc.iceGatheringState }));
  pc.addEventListener('icecandidateerror', (e) => L('pc', { candidateError: e.errorCode, text: e.errorText, url: e.url }));
  return pc;
}

// Список кодеков. H.264 первым — это кодек по умолчанию; при старте стрима
// отправитель сам выбирает лучший из согласованных (см. pickCodec).
function preferCodecs() {
  try {
    const ac = RTCRtpReceiver.getCapabilities('audio').codecs;
    const opus = ac.filter((c) => /opus/i.test(c.mimeType));
    const red = ac.filter((c) => /audio\/red/i.test(c.mimeType));
    if (opus.length) {
      // RED для голоса: каждый пакет несёт копию предыдущего — меньше «бульканья» при потерях
      S.tx.mic.setCodecPreferences([...red, ...opus]);
      S.tx.saudio.setCodecPreferences(opus);
    }
    const vc = RTCRtpReceiver.getCapabilities('video').codecs;
    const rank = (c) => {
      const f = c.sdpFmtpLine || '';
      if (c.mimeType === 'video/H264' && /packetization-mode=1/.test(f) && /42e01f/.test(f)) return 1;
      if (c.mimeType === 'video/H265') return 2;
      if (c.mimeType === 'video/AV1') return 3;
      if (c.mimeType === 'video/VP9' && (!f || /profile-id=0/.test(f))) return 4;
      if (c.mimeType === 'video/VP8') return 5;
      return 0;
    };
    const main = vc.filter((c) => rank(c) > 0).sort((a, b) => rank(a) - rank(b));
    const rtx = vc.filter((c) => c.mimeType === 'video/rtx');
    // защита от потерь: избыточные пакеты (RED + ULPFEC / FlexFEC), Chromium включает их сам при потерях
    const fec = vc.filter((c) => /video\/(red|ulpfec|flexfec-03)/i.test(c.mimeType));
    if (main.length) S.tx.video.setCodecPreferences([...main, ...rtx, ...fec]);
  } catch (e) {
    console.warn('codec prefs', e);
  }
}

/* ---------- Что умеет видеокарта: кодирование и декодирование ---------- */
const CODECS = {
  AV1: 'video/AV1',
  H265: 'video/H265',
  H264: 'video/H264;profile-level-id=42e01f;packetization-mode=1',
  VP9: 'video/VP9',
  VP8: 'video/VP8',
};
const CODEC_ORDER = ['AV1', 'H265', 'H264', 'VP9', 'VP8']; // лучший по качеству — первым

async function detectCaps() {
  const caps = { enc: {}, dec: {} };
  const video = { width: 2560, height: 1440, bitrate: 12_000_000, framerate: 60 };
  for (const [name, ct] of Object.entries(CODECS)) {
    for (const kind of ['enc', 'dec']) {
      try {
        const fn = kind === 'enc' ? 'encodingInfo' : 'decodingInfo';
        const i = await navigator.mediaCapabilities[fn]({ type: 'webrtc', video: { contentType: ct, ...video } });
        caps[kind][name] = i.supported ? (i.powerEfficient ? 'hw' : 'sw') : 'no';
      } catch { caps[kind][name] = 'no'; }
    }
  }
  return caps;
}
const capsReady = detectCaps().then((c) => { S.caps = c; L('caps', c); return c; });

// Выбор кодека для стрима: аппаратное кодирование у меня + декодирование у друга
function pickCodec() {
  if (!S.tx) return null;
  const negotiated = S.tx.video.sender.getParameters().codecs || [];
  const find = (name) => negotiated.find((c) => {
    const f = c.sdpFmtpLine || '';
    const mime = CODECS[name].split(';')[0].toLowerCase();
    if (c.mimeType.toLowerCase() !== mime) return false;
    if (name === 'H264') return /packetization-mode=1/.test(f);
    if (name === 'VP9') return !/profile-id=[123]/.test(f);
    return true;
  });
  const enc = S.caps?.enc || {};
  const dec = S.friendCaps || {};
  const okDec = (n, strict) => dec[n] === 'hw' || (!strict && dec[n] === 'sw' && n !== 'AV1' && n !== 'H265');
  for (const strict of [true, false]) {
    for (const n of CODEC_ORDER) {
      const c = find(n);
      if (c && enc[n] === 'hw' && okDec(n, strict)) return { name: n, codec: c, hw: true };
    }
  }
  // Видеокарта не кодирует ничего подходящего — VP8 самый лёгкий для процессора
  const vp8 = find('VP8');
  return vp8 ? { name: 'VP8', codec: vp8, hw: false } : null;
}

/* ---------- Подсказки битрейта: стрим сразу стартует не мыльным ---------- */
function bitrateHints(sdp) {
  const lines = sdp.split('\r\n');
  const pts = new Set();
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\//.exec(l);
    if (m) pts.add(m[1]);
  }
  const minK = Math.max(300, Math.min(8000, Number(settings().minKbps) || 2500));
  const hint = `x-google-start-bitrate=${Math.max(4000, minK)};x-google-min-bitrate=${minK}`;
  const out = [];
  const hasFmtp = new Set(lines.map((l) => (/^a=fmtp:(\d+) /.exec(l) || [])[1]).filter(Boolean));
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && pts.has(f[1]) && !/x-google-start-bitrate/.test(l)) { out.push(`${l};${hint}`); continue; }
    out.push(l);
    const r = /^a=rtpmap:(\d+) /.exec(l);
    if (r && pts.has(r[1]) && !hasFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} ${hint}`);
  }
  return out.join('\r\n');
}

/* Сбор адресов для кода. Не ждём таймаута: как только пришёл внешний адрес (srflx) — готово.
   С TURN ждём ещё и адрес TURN. Подписываться нужно ДО setLocalDescription. */
function gatherCandidates(pc, { canFallback = false, stunCount = 0 } = {}) {
  const t0 = Date.now();
  const o = settings();
  const wantRelay = !!o.turnUrl;
  const relayOnly = !!(o.relay && o.turnUrl);
  let srflx = null, srflxIp = null, relay = false, done = false, publicHost = false;
  const errs = new Set();
  return new Promise((resolve) => {
    const finish = (why, fallback = false) => {
      if (done) return;
      done = true;
      pc.removeEventListener('icecandidate', onCand);
      pc.removeEventListener('icecandidateerror', onErr);
      pc.removeEventListener('icegatheringstatechange', onState);
      clearTimeout(tFall); clearTimeout(tMax);
      resolve({ srflx: !!srflx, first: srflx, srflxIp, relay, why, fallback, ms: Date.now() - t0 });
    };
    const allStunFailed = () => stunCount > 0 && errs.size >= stunCount;
    const onCand = (e) => {
      const c = e.candidate;
      if (!c) return;
      if (c.type === 'host' && isPublicIp(c.address)) publicHost = true;
      if (c.type === 'srflx' && !srflx) {
        srflx = c.url || e.url || 'stun';
        srflxIp = c.address || null;
        if (!wantRelay || relay) finish('srflx');
      } else if (c.type === 'relay') {
        relay = true;
        if (relayOnly || srflx || !stunCount) finish('relay');
      }
    };
    const onErr = (e) => {
      if (/^stuns?:/.test(e.url || '')) errs.add(e.url);
      // все серверы списка ответили ошибкой — дальше ждать нечего
      if (!srflx && canFallback && allStunFailed()) finish('all-failed', true);
    };
    const onState = () => {
      if (pc.iceGatheringState !== 'complete') return;
      // собрали всё, а внешнего адреса нет. Если на сетевой карте белый адрес — srflx просто совпал
      // с ним, всё в порядке. Иначе серверы не ответили (ошибки могут прийти позже «complete») — запасной список
      finish('complete', !srflx && canFallback && stunCount > 0 && !publicHost);
    };
    pc.addEventListener('icecandidate', onCand);
    pc.addEventListener('icecandidateerror', onErr);
    pc.addEventListener('icegatheringstatechange', onState);
    const tFall = canFallback && stunCount && !relayOnly ? setTimeout(() => { if (!srflx) finish('timeout', true); }, STUN_FALLBACK_MS) : null;
    const tMax = setTimeout(() => finish('max-timeout'), GATHER_TIMEOUT);
  });
}

// белый (публичный) IPv4/IPv6 прямо на сетевой карте
function isPublicIp(ip) {
  if (!ip || /\.local$/i.test(ip)) return false;
  if (ip.includes(':')) return !/^(fe80|fc|fd|::1|::$)/i.test(ip);
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return false;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // CGNAT / Tailscale
  if (p[0] === 25 || p[0] === 26) return false;               // Hamachi / Radmin
  if ((p[0] === 192 && p[1] === 0 && p[2] === 2) || (p[0] === 198 && p[1] === 51 && p[2] === 100) || (p[0] === 203 && p[1] === 0 && p[2] === 113)) return false;
  return true;
}

// какой список STUN сейчас отвечает: пробное соединение, ни с кем не связанное (для отвечающей стороны)
async function probeStunPlan(label, plan) {
  if (plan.length < 2) return plan[0];
  const pc = new RTCPeerConnection(rtcConfig(plan[0].urls));
  pc.createDataChannel('probe');
  const g = gatherCandidates(pc, { canFallback: true, stunCount: plan[0].urls.length });
  try { await pc.setLocalDescription(await pc.createOffer()); } catch { /* */ }
  const r = await g;
  try { pc.close(); } catch { /* */ }
  L('stun', { for: label, probe: plan[0].name, srflx: r.srflx, firstReply: r.first ? stunHost(r.first) : null, why: r.why, ms: r.ms });
  if (!r.fallback) return plan[0];
  L('stun', { for: label, switching: plan[1].name, reason: r.why });
  return plan[1];
}

// создать соединение и собрать адреса.
// Приглашающая сторона: если основной STUN молчит — соединение пересоздаётся с альтернативным
// (до отправки кода до него никто не может достучаться — это безопасно).
// Отвечающая сторона (answer: true) пересоздавать НЕЛЬЗЯ: первое соединение уже стучится к другу
// и начинает шифрованное рукопожатие. Поэтому сначала пробой выясняем рабочий список, потом одно соединение.
// make(cfg) → pc; prep(pc) — дойти до setLocalDescription; alive(pc) — попытка ещё актуальна
async function gatherWithFallback(label, make, prep, alive, { answer = false } = {}) {
  let plan = stunPlan();
  if (answer && plan.length > 1) plan = [await probeStunPlan(label, plan)];
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const canFallback = i < plan.length - 1;
    const pc = make(rtcConfig(step.urls));
    const g = gatherCandidates(pc, { canFallback, stunCount: step.urls.length });
    await prep(pc);
    const r = await g;
    L('stun', { for: label, list: step.name, servers: step.urls.length, srflx: r.srflx, firstReply: r.first ? stunHost(r.first) : null, why: r.why, ms: r.ms });
    if (!r.fallback || !alive(pc)) {
      if (step.urls.length) lastStun = { list: step.name, first: r.first ? stunHost(r.first) : null, ok: r.srflx, at: Date.now() };
      return { pc, list: step.name, r };
    }
    L('stun', { for: label, switching: plan[i + 1].name, reason: r.why });
    try { pc.close(); } catch { /* */ }
  }
  return null;
}

// для перезапуска ICE в звонке: те же серверы, что сработали, без запасного списка
function stunCountOf(pc) {
  try { return (pc.getConfiguration().iceServers || []).reduce((n, s) => n + [].concat(s.urls).filter((u) => /^stuns?:/.test(u)).length, 0); } catch { return 0; }
}

function countCandidates(sdp) {
  const c = { host: 0, srflx: 0, relay: 0 };
  for (const m of sdp.matchAll(/typ (host|srflx|relay)/g)) c[m[1]]++;
  return c;
}

/* ---------- Ты приглашаешь ---------- */
async function startInvite() {
  if (S.busy) return;
  S.busy = true;
  if (!S.friendCall) {
    showStep('stepHost');
    try { lastClip = (await window.duo.paste()) || ''; } catch { /* */ } // старый код в буфере не трогаем
  }
  $('offerOut').value = '';
  $('answerIn').value = '';
  $('btnCopyOffer').disabled = true;
  $('btnApplyAnswer').disabled = true;
  setInfo('hostInfo', 'Готовлю приглашение…');
  try {
    if (!(await prepare())) { showStep('stepHome'); if (S.friendCall) endFriendCall('Нет доступа к микрофону'); return; }
    S.role = 'host';
    const res = await gatherWithFallback('invite', (cfg) => {
      const p = newPeerConnection(cfg);
      S.tx = {
        mic: p.addTransceiver(micSendTrack() || 'audio', { direction: 'sendrecv' }),
        video: p.addTransceiver('video', { direction: 'sendrecv' }),
        saudio: p.addTransceiver('audio', { direction: 'sendrecv' }),
      };
      preferCodecs();
      return p;
    }, async (p) => {
      const offer = await p.createOffer();
      await p.setLocalDescription({ type: 'offer', sdp: opusStereo(offer.sdp) });
    }, (p) => S.pc === p);
    const pc = res?.pc;
    if (!pc || S.pc !== pc) return;
    S.stunUsed = res.list;
    const sdp = pc.localDescription.sdp;
    $('offerOut').value = await packCode('I', sdp, S.nick);
    $('btnCopyOffer').disabled = false;
    $('btnApplyAnswer').disabled = false;
    ownCodes.add($('offerOut').value);
    if (S.friendCall) {
      sendFriendInvite($('offerOut').value);
    } else {
      autoCopy($('offerOut').value, $('btnCopyOffer'));
    }
    const c = countCandidates(sdp);
    L('invite', { role: 'host', codeLen: $('offerOut').value.length, candidates: c, stun: res.list, gatherMs: res.r.ms, config: { noStun: settings().noStun, turn: !!settings().turnUrl } });
    setInfo('hostInfo', (c.srflx || c.relay
      ? 'Приглашение уже скопировано — вставь его другу в мессенджер. Когда он пришлёт ответ, просто скопируй его и вернись сюда.'
      : 'Внешний адрес не определился (STUN недоступен) — сработает только через Tailscale или локальную сеть.') + stunNote(res.list));
  } catch (e) {
    console.error(e);
    lobbyError(e);
    showStep('stepHome');
    if (S.friendCall) endFriendCall('Не удалось начать звонок');
  } finally {
    S.busy = false;
    if (S.answerWhenFree) { const c = S.answerWhenFree; S.answerWhenFree = null; makeAnswer(c); }
  }
}

async function applyAnswer(text) {
  if (!S.pc || S.role !== 'host') return;
  $('lobbyError').textContent = '';
  let code;
  try {
    code = await unpackCode(text || $('answerIn').value);
  } catch (e) { $('lobbyError').textContent = e.message; return; }
  if (code.kind !== 'A') {
    $('lobbyError').textContent = 'Это приглашение, а нужен ответ друга (начинается с ALOA.)';
    return;
  }
  if (S.pc.signalingState !== 'have-local-offer') {
    $('lobbyError').textContent = 'Ответ уже применён. Если не соединилось — начни заново.';
    return;
  }
  try {
    S.friendNick = code.nick || 'Друг';
    await S.pc.setRemoteDescription({ type: 'answer', sdp: code.sdp });
    L('invite', { answerApplied: true, friendCandidates: countCandidates(code.sdp) });
    $('btnApplyAnswer').disabled = true;
    setInfo('hostInfo', 'Соединяемся…');
    armConnectTimer(HOST_CONNECT_TIMEOUT);
  } catch (e) {
    console.error(e);
    $('lobbyError').textContent = 'Не удалось применить ответ: ' + e.message;
  }
}

/* ---------- Тебя пригласили ---------- */
async function makeAnswer(text) {
  if (S.busy) return;
  $('lobbyError').textContent = '';
  let code;
  try {
    code = await unpackCode(text || $('offerIn').value);
  } catch (e) { $('lobbyError').textContent = e.message; return; }
  if (code.kind !== 'I') {
    $('lobbyError').textContent = 'Это ответ, а нужно приглашение (начинается с ALOI.)';
    return;
  }
  S.busy = true;
  $('btnMakeAnswer').disabled = true;
  setInfo('guestInfo', 'Готовлю ответ…');
  try {
    if (!(await prepare())) return;
    closePc();
    S.role = 'guest';
    S.friendNick = code.nick || 'Друг';
    const res = await gatherWithFallback('answer', (cfg) => newPeerConnection(cfg), async (p) => {
      await p.setRemoteDescription({ type: 'offer', sdp: code.sdp });
      const trs = p.getTransceivers()
        .filter((t) => t.mid != null)
        .sort((a, b) => Number(a.mid) - Number(b.mid));
      if (trs.length < 3) throw new Error('Приглашение от другой версии alloconnect');
      S.tx = { mic: trs[0], video: trs[1], saudio: trs[2] };
      trs.forEach((t) => { t.direction = 'sendrecv'; });
      await S.tx.mic.sender.replaceTrack(micSendTrack());
      preferCodecs();
      const answer = await p.createAnswer();
      await p.setLocalDescription({ type: 'answer', sdp: opusStereo(answer.sdp) });
    }, (p) => S.pc === p, { answer: true });
    const pc = res?.pc;
    if (!pc || S.pc !== pc) return;
    S.stunUsed = res.list;
    $('answerOut').value = await packCode('A', pc.localDescription.sdp, S.nick);
    L('invite', { role: 'guest', codeLen: $('answerOut').value.length, ownCandidates: countCandidates(pc.localDescription.sdp), friendCandidates: countCandidates(code.sdp), stun: res.list, gatherMs: res.r.ms });
    ownCodes.add($('answerOut').value);
    if (S.friendCall) {
      const fc = S.friendCall;
      const r = await window.duo.friendsSend(fc.id, { t: 'answer', code: $('answerOut').value });
      if (!r.ok) { endFriendCall(`Не удалось ответить ${fc.nick}: ${r.error}`); return; }
    } else {
      $('guestAnswerBlock').classList.remove('hidden');
      autoCopy($('answerOut').value, $('btnCopyAnswer'));
      setInfo('guestInfo', `Ответ уже скопирован — вставь его ${S.friendNick} в мессенджер. Ждём, когда он его применит…` + stunNote(res.list));
    }
    armConnectTimer(GUEST_CONNECT_TIMEOUT);
  } catch (e) {
    console.error(e);
    lobbyError(e);
    $('btnMakeAnswer').disabled = false;
    if (S.friendCall) endFriendCall('Не удалось принять звонок');
  } finally {
    S.busy = false;
  }
}

function armConnectTimer(ms) {
  clearTimeout(S.connectTimer);
  S.connectTimer = setTimeout(() => {
    if (S.connected) return;
    connectFailed('Не удалось соединиться напрямую.');
  }, ms);
}

function connectFailed(text) {
  L('pc', { connectFailed: text, role: S.role });
  if (S.friendCall) { hideCallModal(); S.friendCall = null; }
  clearTimeout(S.connectTimer);
  closePc();
  releaseMic();
  sound('error');
  $('lobbyError').textContent = text + ' Попробуйте заново (новое приглашение). Если повторяется — поставьте обоим Tailscale.';
  showStep('stepHome');
}

function onPcState(state) {
  if (state === 'connected') {
    if (S.connected && !S.reconnecting) setStatus('ok', 'Соединено');
  } else if (state === 'disconnected') {
    if (S.connected && !S.reconnecting) {
      setStatus('waiting', 'Связь прерывается…');
      const pc = S.pc;
      // часто связь возвращается сама за пару секунд; не вернулась — переподключаемся
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
  capsReady.then((c) => send({ t: 'caps', dec: c.dec, enc: c.enc }));
  enterCall();
  attachRemoteVoice(new MediaStream([S.tx.mic.receiver.track]));
  tuneSender(S.tx.mic.sender, { audio: 64_000 });
  setStatus('ok', 'Соединено');
  sound('join');
  sysMsg(`${S.friendNick} в звонке`);
  if (S.stunUsed === 'alt') sysMsg('STUN: основные серверы не ответили — включены альтернативные');
  L('call', { connected: true, role: S.role, friend: S.friendNick, viaFriends: !!S.friendCall });
  setTimeout(pushTrayState, 300);
  // звонок из списка друзей: SDP пришёл по зашифрованному каналу друзей — собеседник уже подтверждён ключом
  if (S.friendCall) { S.signaledBy = S.friendCall.id; hideCallModal(); S.friendCall = null; }
  S.friendPerm = null;
  sendIdent();
  sendPerm();
  startStatsLog();
  startDuck();
  updateToolbar();
  refreshAvatars();
}

function send(obj) {
  try { if (S.dc?.readyState === 'open') S.dc.send(JSON.stringify(obj)); } catch (e) { console.warn('send', e); }
}

function onData(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
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
      L('caps', { friendDecode: d.dec, friendEncode: d.enc });
      break;
    case 'chat': {
      const mid = cleanMid(d.mid) || newMid();
      const re = reIn(d.re);
      chatMsg(S.callConv, S.friendNick, String(d.text || '').slice(0, 2000), false, d.ts, null, { mid, re });
      record(S.callConv, { mid, ts: Number(d.ts) || Date.now(), who: 'peer', nick: S.friendNick, type: 'text', text: String(d.text || '').slice(0, 2000), re: re || undefined });
      sound('msg');
      window.duo?.notify({ title: S.friendNick, body: String(d.text || '').slice(0, 200), kind: 'msg' });
      if (!document.hasFocus()) window.duo?.attention();
      break;
    }
    case 'chat-op':
      if (S.callConv) applyOp(S.callConv, d, 'peer');
      break;
    case 'screen-start':
      L('watch', { friendStarted: d.quality });
      S.friendShareName = typeof d.name === 'string' ? d.name.slice(0, 60) : '';
      showRemoteScreen();
      break;
    case 'screen-stop':
      hideRemoteScreen();
      break;
    case 'sstats': {
      const why = REASON[d.reason];
      $('remoteReason').textContent = why ? `⚠ У ${S.friendNick}: ${why}${d.hw === 'программный' ? ' (кодирует процессором)' : ''}` : '';
      break;
    }
    case 'bye':
      friendGone(`${S.friendNick} завершил звонок`);
      break;
    case 'perm':
      S.friendPerm = { draw: d.draw !== false, react: !!d.react, ctl: d.ctl !== false, vid: d.vid === 1, ops: d.ops === 1 };
      if (!S.friendPerm.draw && tools.mode) tools.mode = null;
      updateToolbar();
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
    case 'svid-play':
      startVideoEcho();
      break;
    case 'svid-no':
      onVideoRefused(String(d.why || ''));
      break;
    case 'ctl-req':
      onCtlReq(d);
      break;
    case 'ctl-grant':
      if (CV.state !== 'off') ctlViewStart(d);
      break;
    case 'ctl-deny':
      if (CV.state === 'req') { CV.state = 'off'; updateToolbar(); toast(`${S.friendNick} ${String(d.why || 'отказал').slice(0, 60)}`); }
      break;
    case 'ctl-end':
      ctlViewStop(false, String(d.why || '').slice(0, 60) || `${S.friendNick} забрал управление`);
      break;
    case 'ctl-stop':
      ctlEnd(`${S.friendNick} отдал управление`, false);
      break;
    default:
      break;
  }
}

async function tuneSender(sender, { video, audio: audioBr, mode, codec }) {
  if (!sender || !sender.track) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  if (video) {
    p.encodings[0].maxBitrate = video.br;
    p.encodings[0].maxFramerate = video.fps;
    p.encodings[0].networkPriority = 'high';
    // Игра: при нехватке ресурсов снижаем разрешение, но держим FPS. Текст: наоборот.
    p.degradationPreference = mode === 'text' ? 'maintain-resolution' : 'maintain-framerate';
    if (codec) p.encodings[0].codec = codec;
  } else if (audioBr) {
    p.encodings[0].maxBitrate = audioBr;
    p.encodings[0].networkPriority = 'high';
  }
  try {
    await sender.setParameters(p);
  } catch (e1) {
    if (codec) L('codec', { setFailed: e1.message });
    delete p.encodings[0].codec;
    delete p.degradationPreference;
    p.encodings.forEach((e) => delete e.networkPriority);
    try { await sender.setParameters(p); } catch (e2) { console.warn('setParameters', e2); }
  }
}

function attachRemoteVoice(stream) {
  const el = $('remoteVoice');
  // Chromium отдаёт удалённый звук в WebAudio, только если поток привязан к элементу
  el.srcObject = stream;
  el.muted = true;
  el.play().catch(() => {});
  audio();
  try { remoteSrc?.disconnect(); } catch { /* ignore */ }
  remoteSrc = ctx.createMediaStreamSource(stream);
  remoteSrc.connect(friendGain);
  S.stopFriendMeter?.();
  S.stopFriendMeter = makeMeter(stream, (lvl) => {
    $('friendCard').classList.toggle('speaking', lvl > 0.02 && !S.deafened);
    duckFeed('friend', lvl);
  });
}

function closePc() {
  const pc = S.pc;
  const dc = S.dc;
  const fdc = S.fdc;
  const chan = S.fileChan;
  S.pc = null;
  S.dc = null;
  S.fdc = null;
  S.cdc = null;
  S.cdu = null;
  S.fileChan = null;
  S.tx = null;
  chan?.fail('звонок завершён');
  try { fdc?.close(); } catch { /* ignore */ }
  try { dc?.close(); } catch { /* ignore */ }
  try { pc?.close(); } catch { /* ignore */ }
}

function releaseMic() {
  S.stopMyMeter?.(); S.stopMyMeter = null;
  try { chain.src?.disconnect(); } catch { /* */ }
  chain.src = null;
  S.mic?.getTracks().forEach((t) => t.stop());
  S.mic = null;
}

/* ---------- Друг ушёл / связь потеряна ---------- */
function friendGone(reason) {
  if (!S.connected) return;
  L('call', { ended: reason });
  stopStatsLog();
  if (S.reconnecting) { clearTimeout(S.reconnecting.timer); S.reconnecting = null; $('call').classList.remove('reconnecting'); }
  ctlEnd('звонок закончился', false);
  ctlViewStop(false, 'звонок закончился');
  stopDuck();
  S.connected = false;
  stopShare(true);
  hideRemoteScreen();
  S.stopFriendMeter?.(); S.stopFriendMeter = null;
  try { remoteSrc?.disconnect(); } catch { /* ignore */ }
  remoteSrc = null;
  $('remoteVoice').srcObject = null;
  closePc();
  setFriendPresent(false);
  sound('leave');
  sysMsg(`${reason}. Чтобы созвониться снова — «Выйти» и новое приглашение.`);
  setStatus('bad', 'Звонок завершён');
  $('btnShare').disabled = true;
}

/* =========================================================
   Демонстрация экрана
   ========================================================= */
let pickerSources = [];
let pickerTab = 'window';
let pickedId = null;

async function openPicker() {
  if (S.localScreen) { stopShare(); return; }
  if (!S.connected) return;
  $('picker').classList.remove('hidden');
  const o = settings();
  $('quality').value = o.quality;
  $('shareMode').value = o.shareMode || 'game';
  $('sysAudio').checked = !!o.sysAudio;
  $('autoRestore').checked = !!o.autoRestore;
  document.querySelectorAll('#picker .tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === pickerTab));
  updateSysAudioLabel();
  $('sourceGrid').innerHTML = '<p class="muted">Загрузка…</p>';
  pickedId = null;
  $('btnStartShare').disabled = true;
  try {
    pickerSources = await window.duo.getSources();
  } catch {
    $('sourceGrid').innerHTML = '<p class="error">Не удалось получить список окон</p>';
    return;
  }
  renderSources();
}

function updateSysAudioLabel() {
  $('sysAudioLabel').innerHTML = pickerTab === 'window'
    ? 'Звук этого приложения <small class="muted">(только его, без остального)</small>'
    : 'Звук компьютера <small class="muted">(кроме голосов из alloconnect)</small>';
}

function renderSources() {
  const grid = $('sourceGrid');
  grid.innerHTML = '';
  const list = pickerSources.filter((s) => (pickerTab === 'screen' ? s.isScreen : !s.isScreen));
  if (!list.length) { grid.innerHTML = '<p class="muted">Ничего не найдено</p>'; return; }
  if (!pickedId && pickerTab === 'screen') pickedId = list[0].id;
  $('autoRestoreRow').classList.toggle('hidden', pickerTab !== 'window');
  for (const s of list) {
    const el = document.createElement('div');
    el.className = 'source' + (s.id === pickedId ? ' selected' : '');
    const th = document.createElement('div');
    th.className = 'thumb';
    if (s.thumb) th.style.backgroundImage = `url("${s.thumb}")`;
    else if (s.minimized) {
      th.classList.add('min');
      const wrap = document.createElement('div');
      if (s.icon) { const big = document.createElement('img'); big.src = s.icon; wrap.appendChild(big); }
      const lab = document.createElement('span');
      lab.textContent = 'свёрнуто';
      wrap.append(document.createElement('br'), lab);
      th.appendChild(wrap);
    }
    const nm = document.createElement('div');
    nm.className = 'sname';
    if (s.icon) { const ic = document.createElement('img'); ic.src = s.icon; nm.appendChild(ic); }
    nm.appendChild(document.createTextNode(s.name));
    el.append(th, nm);
    el.title = s.name;
    el.onclick = () => { pickedId = s.id; renderSources(); };
    el.ondblclick = () => { pickedId = s.id; beginShare(); };
    grid.appendChild(el);
  }
  $('btnStartShare').disabled = !pickedId;
}

async function beginShare() {
  if (!pickedId || !S.connected) return;
  const qKey = $('quality').value;
  const mode = $('shareMode').value;
  const wantAudio = $('sysAudio').checked && S.platform === 'win32';
  store.set('settings', { ...settings(), quality: qKey, shareMode: mode, sysAudio: $('sysAudio').checked, autoRestore: $('autoRestore').checked });
  $('picker').classList.add('hidden');
  const srcId = pickedId;
  const srcName = (pickerSources.find((x) => x.id === srcId)?.name || 'Окно').slice(0, 60);
  const isWin = srcId.startsWith('window:');
  let q = QUALITY[qKey];
  const pick = pickCodec();
  L('codec', { picked: pick?.name, hw: pick?.hw, myEncode: S.caps?.enc, friendDecode: S.friendCaps });
  if (pick && !pick.hw && q.h > 1080) {
    q = QUALITY['1080p60'];
    toast('Видеокарта не кодирует видео для стрима — снизил до 1080p, чтобы не грузить процессор');
  }
  let sysTrack = null;
  let useLoopback = false;
  try {
    if (wantAudio) {
      const r = await window.duo.sysAudioStart(pickedId);
      if (r.ok) {
        sysTrack = await startPcmTrack();
      } else {
        console.warn('sysaudio', r.error);
        useLoopback = true;
        toast('Отдельный захват звука недоступен (' + r.error + ') — пойдёт весь звук компьютера, друг может слышать себя');
      }
    }
    // Окно приложения: следим, свёрнуто ли оно
    let winState = 'unknown';
    if (isWin) {
      winState = await window.duo.winWatchStart(srcId);
      if (winState === 'gone') throw new Error('окно уже закрыто');
      if (winState === 'min' && $('autoRestore').checked) {
        if (await window.duo.winRestore(srcId)) { await new Promise((r) => setTimeout(r, 450)); winState = 'normal'; }
      }
    }
    S.shareCtx = { srcId, srcName, q, mode, useLoopback, real: null, ph: null };
    let stream;
    let vt;
    if (winState === 'min') {
      // свёрнутое окно рисовать нечего — шлём заглушку, звук приложения уже идёт
      S.shareCtx.ph = makePlaceholder(srcName);
      vt = S.shareCtx.ph.track;
      stream = new MediaStream([vt]);
    } else {
      stream = await captureSource(srcId, q, mode, useLoopback);
      vt = stream.getVideoTracks()[0];
      S.shareCtx.real = stream;
    }
    L('share', {
      start: true, quality: qKey, mode, source: srcId.split(':')[0], windowState: winState,
      sysAudio: wantAudio ? (sysTrack ? 'helper' : (useLoopback ? 'loopback-fallback' : 'none')) : 'off',
      trackSettings: vt.getSettings(),
    });
    if (!S.tx) throw new Error('нет соединения');
    const at = sysTrack || stream.getAudioTracks()[0] || null;
    await S.tx.video.sender.replaceTrack(vt);
    await S.tx.saudio.sender.replaceTrack(at);
    await tuneSender(S.tx.video.sender, { video: q, mode, codec: pick?.codec });
    await tuneSender(S.tx.saudio.sender, { audio: 128_000 });
    S.localScreen = stream;
    S.quality = qKey;
    S.localShareName = isWin ? srcName : '';
    send({ t: 'screen-start', quality: qKey, name: S.localShareName });
    $('localScreen').srcObject = stream;
    $('localScreenWrap').classList.remove('hidden');
    $('btnShare').classList.add('on');
    $('btnShare').querySelector('span').textContent = 'Остановить показ';
    $('btnShare').title = 'Остановить показ';
    layout();
    startSendStats();
    sound('stream');
    window.duo.ovlOpen(srcId).catch(() => {});
    refreshClip();
    flashToolbar();
  } catch (e) {
    console.warn('share', e);
    stopPcm();
    window.duo.winWatchStop();
    S.shareCtx = null;
    const msg = /could not start video source/i.test(e.message || '') && isWin
      ? 'не удалось захватить окно — если оно свёрнуто, разверни его и попробуй снова'
      : (e.message || e.name);
    toast('Не удалось начать демонстрацию: ' + msg);
  }
}

// Захват выбранного экрана/окна
async function captureSource(srcId, q, mode, useLoopback) {
  await window.duo.selectSource({ id: srcId, audio: useLoopback });
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
    audio: useLoopback,
  });
  const vt = stream.getVideoTracks()[0];
  if (!vt) throw new Error('нет видео');
  vt.contentHint = mode === 'text' ? 'detail' : 'motion';
  try { await vt.applyConstraints({ width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } }); } catch { /* не страшно */ }
  vt.addEventListener('ended', () => { L('share', 'track ended by system'); if (S.shareCtx?.real === stream) stopShare(); });
  return stream;
}

// Заглушка «окно свёрнуто»
function makePlaceholder(name) {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  const draw = () => {
    g.fillStyle = '#14151a'; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = (Math.floor(Date.now() / 700) % 2) ? '#7c5cff' : '#4b3a9e';
    g.beginPath(); g.arc(640, 260, 12, 0, Math.PI * 2); g.fill();
    g.textAlign = 'center';
    g.fillStyle = '#e8e9ee'; g.font = '600 44px "Segoe UI", sans-serif';
    g.fillText(`«${name}» свёрнуто`, 640, 350);
    g.fillStyle = '#8b8f9e'; g.font = '28px "Segoe UI", sans-serif';
    g.fillText('картинка появится, когда окно развернут', 640, 405);
  };
  draw();
  const track = c.captureStream(4).getVideoTracks()[0];
  track.contentHint = 'detail';
  const iv = setInterval(draw, 350);
  return { track, stop() { clearInterval(iv); track.stop(); } };
}

// Окно свернули/развернули/закрыли во время показа
async function onWinState(st) {
  const ctx = S.shareCtx;
  if (!ctx || !S.localScreen || !S.tx) return;
  try {
    if (st === 'gone') { toast('Окно закрыто — показ остановлен'); stopShare(); return; }
    if (st === 'min') {
      if (!ctx.ph) ctx.ph = makePlaceholder(ctx.srcName);
      await S.tx.video.sender.replaceTrack(ctx.ph.track);
      $('localScreen').srcObject = new MediaStream([ctx.ph.track]);
      L('share', { switched: 'placeholder' });
    } else if (st === 'normal') {
      if (!ctx.real) {
        await new Promise((r) => setTimeout(r, 300)); // дать окну отрисоваться
        if (S.shareCtx !== ctx) return;
        ctx.real = await captureSource(ctx.srcId, ctx.q, ctx.mode, false);
      }
      const vt = ctx.real.getVideoTracks()[0];
      await S.tx.video.sender.replaceTrack(vt);
      await tuneSender(S.tx.video.sender, { video: ctx.q, mode: ctx.mode, codec: pickCodec()?.codec });
      $('localScreen').srcObject = new MediaStream([vt]);
      L('share', { switched: 'window' });
    }
  } catch (e) {
    L('share', { winStateError: e.message });
  }
}

/* ---------- Звук из alloconnect-helper.exe → дорожка WebRTC ---------- */
let pcmNode = null, pcmDest = null, pcmCarry = null, pcmModule = false;

async function startPcmTrack() {
  const c = audio();
  if (!pcmModule) { await c.audioWorklet.addModule('pcm-worklet.js'); pcmModule = true; }
  pcmCarry = null;
  pcmNode = new AudioWorkletNode(c, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  pcmDest = c.createMediaStreamDestination();
  pcmDest.channelCount = 2;
  pcmNode.connect(pcmDest); // только в звонок, не в свои колонки
  return pcmDest.stream.getAudioTracks()[0];
}

function onPcmChunk(chunk) {
  if (!pcmNode) return;
  let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  if (pcmCarry) {
    const merged = new Uint8Array(pcmCarry.length + bytes.length);
    merged.set(pcmCarry, 0);
    merged.set(bytes, pcmCarry.length);
    bytes = merged;
    pcmCarry = null;
  }
  const usable = bytes.length - (bytes.length % 4); // целые стерео-кадры int16
  if (usable < bytes.length) pcmCarry = bytes.slice(usable);
  if (!usable) return;
  const ab = bytes.slice(0, usable).buffer; // копия с выравниванием
  pcmNode.port.postMessage(ab, [ab]);
}

function stopPcm() {
  if (!pcmNode) return;
  window.duo.sysAudioStop();
  try { pcmNode.disconnect(); } catch { /* ignore */ }
  pcmDest?.stream.getTracks().forEach((t) => t.stop());
  pcmNode = null;
  pcmDest = null;
  pcmCarry = null;
}

/* ---------- Статистика отправки (у того, кто стримит) ---------- */
let sendStatsTimer = null, sLastBytes = 0, sLastTs = 0;
const REASON = { cpu: 'не хватает процессора', bandwidth: 'не хватает скорости интернета', gpu: 'видеокарта загружена игрой — ограничь FPS в игре' };

function startSendStats() {
  clearInterval(sendStatsTimer);
  sLastBytes = 0; sLastTs = 0;
  sendStatsTimer = setInterval(async () => {
    if (!S.tx || !S.localScreen) return;
    try {
      const report = await S.tx.video.sender.getStats();
      const gpu = await window.duo.gpuLast().catch(() => null);
      let capFps = null;
      report.forEach((r) => { if (r.type === 'media-source' && r.kind === 'video') capFps = r.framesPerSecond; });
      report.forEach((r) => {
        if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
        let mbps = 0;
        if (sLastTs) {
          const sec = (r.timestamp - sLastTs) / 1000;
          if (sec > 0) mbps = ((r.bytesSent - sLastBytes) * 8) / sec / 1e6;
        }
        sLastBytes = r.bytesSent; sLastTs = r.timestamp;
        const hw = r.powerEfficientEncoder === true ? 'аппаратный' : (r.powerEfficientEncoder === false ? 'программный' : '');
        const info = {
          w: r.frameWidth || 0, h: r.frameHeight || 0, fps: Math.round(r.framesPerSecond || 0),
          mbps: Number(mbps.toFixed(1)), reason: r.qualityLimitationReason || 'none',
          enc: r.encoderImplementation || '', hw, gpu: gpu?.util ?? null,
        };
        // захват отстаёт, а видеокарта на пределе → почти наверняка её съела игра
        const target = S.shareCtx?.q?.fps || 60;
        const onPlaceholder = !!(S.shareCtx?.ph && S.tx.video.sender.track === S.shareCtx.ph.track);
        if (!onPlaceholder && gpu && gpu.util >= 95 && capFps != null && capFps < target * 0.7) info.reason = 'gpu';
        const reasonText = REASON[info.reason] ? ` · ⚠ ${REASON[info.reason]}` : '';
        $('localStats').textContent = `${info.w}×${info.h} · ${info.fps} fps · ${info.mbps} Мбит/с` +
          (hw ? ` · кодировщик ${hw}` : '') + (gpu ? ` · видеокарта ${gpu.util}%` : '') + reasonText;
        $('localStats').classList.toggle('bad', !!REASON[info.reason]);
        send({ t: 'sstats', ...info });
      });
    } catch { /* ignore */ }
  }, 2000);
}

function stopSendStats() {
  clearInterval(sendStatsTimer);
  sendStatsTimer = null;
  $('localStats').textContent = '';
}

function stopShare(silent) {
  if (!S.localScreen) return;
  L('share', { stop: true });
  ctlEnd('показ остановлен');
  window.duo?.ovlClose();
  S.localScreen.getTracks().forEach((t) => t.stop());
  S.localScreen = null;
  if (S.shareCtx) {
    S.shareCtx.ph?.stop();
    S.shareCtx.real?.getTracks().forEach((t) => t.stop());
    S.shareCtx = null;
  }
  window.duo?.winWatchStop();
  stopPcm();
  stopSendStats();
  if (S.tx) {
    S.tx.video.sender.replaceTrack(null).catch(() => {});
    S.tx.saudio.sender.replaceTrack(null).catch(() => {});
  }
  if (!silent) send({ t: 'screen-stop' });
  $('localScreen').srcObject = null;
  $('localScreenWrap').classList.add('hidden');
  $('btnShare').classList.remove('on');
  $('btnShare').querySelector('span').textContent = 'Показать экран';
  $('btnShare').title = 'Показать экран';
  layout();
  S.localShareName = '';
  refreshClip();
}

function showRemoteScreen() {
  if (!S.tx) return;
  const v = $('remoteScreen');
  // небольшой запас в буфере: короткие провалы сети не превращаются во фризы
  try { S.tx.video.receiver.jitterBufferTarget = 100; S.tx.saudio.receiver.jitterBufferTarget = 100; } catch { /* старые версии */ }
  v.srcObject = new MediaStream([S.tx.video.receiver.track, S.tx.saudio.receiver.track]);
  v.muted = S.deafened;
  v.volume = Number($('screenVol').value) / 100;
  v.play().catch(() => {});
  $('remoteScreenOwner').textContent = S.friendNick || 'друг';
  $('remoteScreenTitle').textContent = S.friendShareName ? '— ' + S.friendShareName : '';
  $('remoteScreenWrap').classList.remove('hidden');
  layout();
  startStats();
  sound('stream');
  sysMsg(S.friendShareName ? `${S.friendNick} показывает: ${S.friendShareName}` : `${S.friendNick} показывает экран`);
  refreshClip();
  flashToolbar();
}

let toolbarFlashT = null;
function flashToolbar() {
  const w = $('remoteScreenWrap');
  if (w.classList.contains('hidden')) return;
  w.classList.add('show-tools');
  clearTimeout(toolbarFlashT);
  toolbarFlashT = setTimeout(() => w.classList.remove('show-tools'), 4000);
}

function hideRemoteScreen() {
  S.friendShareName = '';
  refreshClip();
  cancelPlacement();
  ctlViewStop(false, 'показ закончился');
  tools.mode = null;
  tools.stroke = null;
  tools.local.clear();
  updateToolbar();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('remoteScreen').srcObject = null;
  $('remoteReason').textContent = '';
  $('remoteScreenWrap').classList.add('hidden');
  stopStats();
  layout();
}

function layout() {
  const remote = !$('remoteScreenWrap').classList.contains('hidden');
  const local = !!S.localScreen;
  $('people').classList.toggle('hidden', remote || local);
  $('localScreenWrap').classList.toggle('solo', local && !remote);
}

let lastBytes = 0, lastTs = 0;
function startStats() {
  stopStats();
  lastBytes = 0; lastTs = 0;
  S.statsTimer = setInterval(async () => {
    if (!S.tx || !S.pc) return;
    try {
      const report = await S.pc.getStats(S.tx.video.receiver.track);
      report.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        let mbps = '';
        if (lastTs) {
          const sec = (r.timestamp - lastTs) / 1000;
          if (sec > 0) mbps = ` · ${(((r.bytesReceived - lastBytes) * 8) / sec / 1e6).toFixed(1)} Мбит/с`;
        }
        lastBytes = r.bytesReceived; lastTs = r.timestamp;
        const res = r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : '';
        const fps = r.framesPerSecond ? ` · ${Math.round(r.framesPerSecond)} fps` : '';
        $('remoteStats').textContent = res + fps + mbps;
      });
    } catch { /* ignore */ }
  }, 1000);
}
function stopStats() { clearInterval(S.statsTimer); S.statsTimer = null; $('remoteStats').textContent = ''; }

/* =========================================================
   Микрофон / звук
   ========================================================= */
function setMuted(v) {
  S.muted = v;
  applyMicEnabled();
  updateMyControls();
  send({ t: 'state', muted: S.muted, deaf: S.deafened });
  sound(v ? 'mute' : 'unmute');
}

function setDeafened(v) {
  S.deafened = v;
  if (master) master.gain.value = v ? 0 : 1;
  $('remoteScreen').muted = v;
  applyMicEnabled();
  updateMyControls();
  send({ t: 'state', muted: S.muted, deaf: S.deafened });
  sound(v ? 'mute' : 'unmute');
}

function updateMyControls() {
  if (typeof pushTrayState === 'function') setTimeout(pushTrayState, 0);
  const micOff = S.muted || S.deafened;
  $('btnMute').classList.toggle('off', micOff);
  $('btnMute').querySelector('span').textContent = micOff ? 'Микрофон выкл' : 'Микрофон';
  $('btnDeafen').classList.toggle('off', S.deafened);
  $('btnDeafen').querySelector('span').textContent = S.deafened ? 'Звук выкл' : 'Звук';
  $('meBadges').textContent = (S.deafened ? '🔇' : '') + (micOff ? '🎙̸' : '');
  if (micOff) $('meCard').classList.remove('speaking');
}

function setFriendBadges(muted, deaf) {
  $('friendBadges').textContent = (deaf ? '🔇' : '') + (muted || deaf ? '🎙̸' : '');
}

/* =========================================================
   UI: лобби, экраны, статус, чат
   ========================================================= */
async function prepare() {
  S.nick = $('nick').value.trim() || 'Без имени';
  store.set('nick', S.nick);
  $('lobbyError').textContent = '';
  audio();
  if (!S.mic) {
    try { S.mic = await acquireMic(); } catch (e) { lobbyError(e); return false; }
    try { await attachMicChain(S.mic); } catch (e) { L('ns', { chainFailed: e.message }); }
    const t = S.mic.getAudioTracks()[0];
    L('mic', { label: t?.label, settings: t?.getSettings() });
  }
  return true;
}

function showStep(id) {
  document.querySelectorAll('.step').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'stepGuest') {
    $('guestAnswerBlock').classList.add('hidden');
    $('btnMakeAnswer').disabled = false;
    $('answerOut').value = '';
    setInfo('guestInfo', '');
  }
}

function backToHome() {
  clearTimeout(S.connectTimer);
  closePc();
  releaseMic();
  $('lobbyError').textContent = '';
  showStep('stepHome');
}

function setInfo(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}

function lobbyError(e) {
  $('lobbyError').textContent = e?.message || 'Что-то пошло не так';
  sound('error');
}

function enterCall() {
  S.inCall = true;
  $('lobby').classList.remove('active');
  $('call').classList.add('active');
  $('meName').textContent = S.nick;
  $('meInitial').textContent = initial(S.nick);
  $('friendTop').textContent = S.friendNick;
  S.callConv = tempConv(S.friendNick);
  mountConv(S.callConv, $('messages'));
  $('btnShare').disabled = false;
  setFriendPresent(true);
  updateMyControls();
  startMyMeter();
}

function leaveCall() {
  L('call', { leave: true });
  spStopAll();
  $('soundpad').classList.add('hidden');
  $('btnSoundpad').classList.remove('on-pad');
  $('btnAddFriend').classList.add('hidden');
  S.peerIdent = null;
  S.peerClaim = null;
  S.identCh = null;
  S.signaledBy = null;
  S.callPath = null;
  stopStatsLog();
  if (S.reconnecting) { clearTimeout(S.reconnecting.timer); S.reconnecting = null; $('call').classList.remove('reconnecting'); }
  ctlEnd('звонок закончился');
  ctlViewStop(true);
  stopDuck();
  send({ t: 'bye' });
  const wasConnected = S.connected;
  S.connected = false;
  stopShare(true);
  hideRemoteScreen();
  S.stopFriendMeter?.(); S.stopFriendMeter = null;
  try { remoteSrc?.disconnect(); } catch { /* ignore */ }
  remoteSrc = null;
  $('remoteVoice').srcObject = null;
  // даём «bye» уйти, потом закрываем
  setTimeout(closePc, wasConnected ? 300 : 0);
  releaseMic();
  S.inCall = false;
  S.muted = false;
  S.deafened = false;
  if (master) master.gain.value = 1;
  S.friendNick = '';
  S.callConv = null;
  S.friendShareName = '';
  stopClip();
  $('call').classList.remove('active');
  $('lobby').classList.add('active');
  showStep('stepHome');
  renderFriends();
}

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


function appendLinkified(parent, text) {
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[1];
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = m[1];
    parent.appendChild(a);
    last = m.index + m[1].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

/* =========================================================
   Разговоры: чат с другом (в звонке и без), история на диске
   Один разговор = один друг (по ID). Его ленту показываем в звонке или в окне «Чат».
   ========================================================= */
const convs = new Map();            // ID друга → разговор
const HIST_PAGE = 150;
const HIST_IMG_MAX = 25 * 1024 * 1024; // картинки и гифки до 25 МБ сохраняем в историю сами

function newConvBox() {
  const box = document.createElement('div');
  box.className = 'conv';
  return box;
}

function getConv(id, nick) {
  if (!id) return null;
  let c = convs.get(id);
  if (!c) {
    c = { id, nick: nick || 'Друг', box: newConvBox(), loaded: false, histStart: null, unread: 0, blobs: [], pending: [], msgs: new Map() };
    convs.set(id, c);
  }
  if (nick) c.nick = nick;
  return c;
}

// разговор звонка до того, как узнали ID собеседника
function tempConv(nick) {
  return { id: null, nick: nick || 'Друг', box: newConvBox(), loaded: true, histStart: 0, unread: 0, blobs: [], pending: [], msgs: new Map() };
}

function mountConv(conv, host) {
  host.replaceChildren(conv.box);
  host.scrollTop = host.scrollHeight;
}

const scroller = (conv) => conv.box.parentElement;
function scrollEnd(conv, force) {
  const s = scroller(conv);
  if (!s) return;
  if (force || s.scrollHeight - s.scrollTop - s.clientHeight < 120) s.scrollTop = s.scrollHeight;
}

const newMid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function record(conv, entry) {
  if (!conv) return;
  if (!conv.id) { conv.pending.push(entry); return; }
  window.duo.histAppend(conv.id, entry).catch(() => {});
}

function recordStatus(conv, mid, st) {
  if (conv?.id) window.duo.histAppend(conv.id, { type: 'status', ref: mid, st }).catch(() => {});
}

// временный разговор звонка → настоящий (пришёл ID собеседника)
function adoptConv(temp, id, nick) {
  const conv = getConv(id, nick);
  for (const el of [...temp.box.children]) conv.box.appendChild(el);
  conv.blobs.push(...temp.blobs);
  for (const [k, v] of temp.msgs || []) conv.msgs.set(k, v);
  for (const e of temp.pending) window.duo.histAppend(id, e).catch(() => {});
  temp.pending = [];
  return conv;
}

async function loadHistory(conv, more) {
  if (!conv?.id || (conv.loaded && !more)) return;
  conv.loaded = true;
  let r;
  try { r = await window.duo.histLoad(conv.id, HIST_PAGE, more ? conv.histStart : undefined); } catch { return; }
  const s = scroller(conv);
  const prevH = s ? s.scrollHeight : 0;
  const frag = document.createElement('div');
  if (r.start > 0) {
    const b = document.createElement('button');
    b.className = 'link hist-more';
    b.textContent = 'Показать раньше';
    b.onclick = () => { b.remove(); loadHistory(conv, true); };
    frag.appendChild(b);
  }
  for (const e of r.items) renderHistEntry(conv, e, frag);
  if (r.items.length && !more) {
    const sep = document.createElement('div');
    sep.className = 'msg sys hist-sep';
    sep.textContent = '— раньше —';
    frag.appendChild(sep);
  }
  conv.histStart = r.start;
  conv.box.prepend(...frag.childNodes);
  if (s) s.scrollTop = more ? s.scrollHeight - prevH : s.scrollHeight;
}

function renderHistEntry(conv, e, into) {
  const mine = e.who === 'me';
  const who = mine ? (S.nick || store.get('nick', '') || 'Я') : (e.nick || conv.nick);
  const opt = { mid: e.mid, re: e.re, react: e.react, edited: e.edited, deleted: e.deleted, type: e.type };
  if (e.deleted && (e.type === 'text' || e.type === 'file')) {
    chatMsg(conv, who, '', mine, e.ts, into, opt);
  } else if (e.type === 'text') {
    const m = chatMsg(conv, who, String(e.text || ''), mine, e.ts, into, opt);
    if (e.st === 'fail') markUndelivered(m);
  } else if (e.type === 'file' && e.file) {
    const meta = { ...e.file, kind: e.file.kind || fileKind(e.file.mime || '') };
    const ui = fileBubble(conv, who, meta, mine, { ts: e.ts, into, ...opt });
    if (e.file.stored) {
      ui.loading();
      window.duo.histMediaRead(conv.id, e.file.stored).then((b) => {
        const url = URL.createObjectURL(new Blob([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)], { type: meta.mime }));
        conv.blobs.push(url);
        ui.done(url, { fromHistory: true });
      }).catch(() => ui.gone());
    } else ui.gone();
  }
}

/* ---------- Пузыри ---------- */
function timeStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (new Date().toDateString() === d.toDateString()) return t;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + t;
}

function chatMsg(conv, who, text, mine, ts, into, opt = {}) {
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
  if (opt.mid) regMsg(conv, m, { mid: opt.mid, who: mine ? 'me' : 'peer', type: opt.type || 'text', text, re: opt.re, react: opt.react, edited: opt.edited, deleted: opt.deleted });
  (into || conv.box).appendChild(m);
  if (!into) scrollEnd(conv, mine);
  return m;
}

function markUndelivered(m) {
  if (!m || m.querySelector('.undel')) return;
  const s = document.createElement('span');
  s.className = 'undel';
  s.textContent = ' · не доставлено';
  m.querySelector('.meta').appendChild(s);
}

function sysMsg(text, conv = S.callConv) {
  if (!conv) return;
  const m = document.createElement('div');
  m.className = 'msg sys';
  m.textContent = text;
  conv.box.appendChild(m);
  scrollEnd(conv, true);
}

/* =========================================================
   Действия с сообщениями: реакции, ответ с цитатой, правка и удаление своих, поиск по истории.
   Сообщения и файлы адресуются по mid (у файлов — 'f' + номер передачи, он общий у обоих).
   Правки идут по тому же каналу, что и текст: в звонке — канал звонка, без звонка — канал друзей.
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

function regMsg(conv, el, e) {
  el.dataset.mid = e.mid;
  conv.msgs ??= new Map();
  conv.msgs.set(e.mid, { el, e });
  if (e.re) {
    const q = document.createElement('div');
    q.className = 'quote';
    const b = document.createElement('b');
    b.textContent = e.re.by === 'me' ? (S.nick || 'Я') : conv.nick;
    q.append(b, document.createTextNode(' ' + (e.re.text || '…')));
    q.title = 'Показать сообщение';
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
    c.textContent = v + (whos.length > 1 ? ' 2' : '');
    c.title = whos.map((w) => (w === 'me' ? 'ты' : conv.nick)).join(', ');
    c.onclick = (ev) => { ev.stopPropagation(); sendMsgOp(conv, { op: 'react', ref: e.mid, e: r.me === v ? '' : v }); };
    row.appendChild(c);
  }
  el.querySelector('.bubble').after(row);
}

function canOps(conv) {
  if (S.inCall && S.callConv === conv) return !!S.friendPerm?.ops;
  const f = friendsList.find((x) => x.id === conv.id);
  return !f?.ver || verCmpR(f.ver, '1.14.0') >= 0;
}

async function sendMsgOp(conv, raw) {
  const op = cleanOp({ ...raw, ts: Date.now() });
  if (!op || !conv) return false;
  if (!canOps(conv)) { toast(`У ${conv.nick} старая версия alloconnect — это заработает, когда он обновится`); return false; }
  let ok = false;
  if (S.inCall && S.callConv === conv && S.dc?.readyState === 'open') { send({ t: 'chat-op', ...op }); ok = true; }
  else if (conv.id) { const r = await window.duo.friendsSend(conv.id, { t: 'dm-op', ...op }).catch(() => ({ ok: false })); ok = !!r.ok; }
  if (!ok) { toast(`Не доставлено — ${conv.nick} не в сети`); return false; }
  applyOp(conv, op, 'me');
  return true;
}

function cleanOp(o) {
  if (!o || typeof o !== 'object' || !['react', 'edit', 'del'].includes(o.op) || !cleanMid(o.ref)) return null;
  const op = { op: o.op, ref: o.ref, ts: Number(o.ts) || Date.now() };
  if (o.op === 'react') { op.e = MSG_REACTS.includes(o.e) ? o.e : ''; }
  if (o.op === 'edit') { op.text = String(o.text || '').slice(0, 2000); if (!op.text.trim()) return null; }
  return op;
}

// применить действие (своё или друга): на экране, если сообщение загружено, и в историю
function applyOp(conv, raw, by) {
  const op = cleanOp(raw);
  if (!op) return;
  const it = conv.msgs?.get(op.ref);
  if (it) {
    if (op.op !== 'react' && it.e.who !== by) return; // править и удалять можно только свои
    if (it.e.deleted) return;
    if (op.op === 'react') {
      it.e.react = { ...(it.e.react || {}) };
      if (op.e) it.e.react[by] = op.e; else delete it.e.react[by];
      renderReacts(conv, it.el, it.e);
      if (by === 'peer' && op.e && it.e.who === 'me') {
        const visible = (dmOpen === conv && !$('dm').classList.contains('hidden')) || (S.inCall && S.callConv === conv);
        if (!visible) toast(`${conv.nick}: ${op.e} на «${snip(it.e.text, 40)}»`);
      }
    } else if (op.op === 'edit') {
      if (it.e.type !== 'text') return;
      it.e.text = op.text;
      it.e.edited = op.ts;
      const t = it.el.querySelector('.btext');
      if (t) { t.replaceChildren(); appendLinkified(t, op.text); }
      markEdited(it.el);
    } else if (op.op === 'del') {
      renderDeleted(it.el, it.e);
    }
  }
  record(conv, { type: 'op', op: op.op, ref: op.ref, who: by, e: op.e, text: op.text, ts: op.ts });
}

/* ---------- Ответ и правка: полоска над полем ввода ---------- */
const composers = {
  call: { input: 'chatInput', form: 'chatForm', conv: () => S.callConv, mode: null, item: null, bar: null },
  dm: { input: 'dmInput', form: 'dmForm', conv: () => dmOpen, mode: null, item: null, bar: null },
};
const composerFor = (el) => (el.closest('#dmMessages') ? composers.dm : composers.call);

function setCompose(cp, mode, item) {
  cp.mode = mode;
  cp.item = item || null;
  if (!cp.bar) {
    cp.bar = document.createElement('div');
    cp.bar.className = 'compose-bar hidden';
    cp.bar.innerHTML = '<span class="cb-ico"></span><div class="cb-text"><b></b><small></small></div><button type="button" class="icon-btn cb-x" title="Отмена (Esc)">✕</button>';
    cp.bar.querySelector('.cb-x').onclick = () => cancelCompose(cp);
    $(cp.form).before(cp.bar);
  }
  cp.bar.classList.toggle('hidden', !mode);
  if (!mode) return;
  const conv = cp.conv();
  cp.bar.querySelector('.cb-ico').textContent = mode === 'edit' ? '✏' : '↩';
  cp.bar.querySelector('b').textContent = mode === 'edit' ? 'Редактирование' : 'Ответ ' + (item.e.who === 'me' ? 'себе' : conv?.nick || '');
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

// режим правки: отправка = изменить сообщение
function composeSubmitEdit(cp, conv, text) {
  if (cp.mode !== 'edit' || !cp.item) return false;
  const it = cp.item;
  setCompose(cp, null);
  $(cp.input).value = '';
  if (text !== it.e.text) sendMsgOp(conv, { op: 'edit', ref: it.e.mid, text });
  return true;
}

/* ---------- Кнопки у сообщения (при наведении) ---------- */
let actFor = null;
function bindMsgUi() {
  const bar = document.createElement('div');
  bar.id = 'msgActs';
  bar.className = 'msg-acts hidden';
  bar.innerHTML = '<div class="ma-row">' + MSG_REACTS.map((r) => `<button type="button" class="ma-react" data-r="${r}">${r}</button>`).join('') +
    '<span class="ma-sep"></span><button type="button" class="ma-btn" data-a="reply" title="Ответить">↩</button><button type="button" class="ma-btn" data-a="edit" title="Изменить">✏</button><button type="button" class="ma-btn" data-a="del" title="Удалить у обоих">🗑</button></div>';
  document.body.appendChild(bar);
  const hide = () => { bar.classList.add('hidden'); actFor = null; };
  const show = (el) => {
    const host = el.closest('.messages');
    const cp = composerFor(el);
    const conv = cp.conv();
    const it = conv?.msgs?.get(el.dataset.mid);
    if (!it || it.e.deleted) { hide(); return; }
    actFor = { el, conv, it, cp };
    bar.querySelector('[data-a=edit]').classList.toggle('hidden', !(it.e.who === 'me' && it.e.type === 'text'));
    bar.querySelector('[data-a=del]').classList.toggle('hidden', it.e.who !== 'me');
    for (const b of bar.querySelectorAll('.ma-react')) b.classList.toggle('on', it.e.react?.me === b.dataset.r);
    bar.classList.remove('hidden');
    const r = el.querySelector('.bubble').getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let x = it.e.who === 'me' ? r.right - bw : r.left;
    x = Math.max(hr.left + 4, Math.min(hr.right - bw - 4, x));
    let y = r.top - bh - 2;
    if (y < hr.top) y = r.bottom + 2;
    Object.assign(bar.style, { left: x + 'px', top: y + 'px' });
  };
  for (const id of ['messages', 'dmMessages']) {
    const host = $(id);
    host.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.msg[data-mid]');
      if (el && el !== actFor?.el) show(el);
    });
    host.addEventListener('mouseleave', (e) => { if (!bar.contains(e.relatedTarget)) hide(); });
    host.addEventListener('scroll', hide, { passive: true });
  }
  bar.addEventListener('mouseleave', (e) => { if (!e.relatedTarget?.closest?.('.messages')) hide(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !actFor) return;
    const { conv, it, cp } = actFor;
    if (b.dataset.r) sendMsgOp(conv, { op: 'react', ref: it.e.mid, e: it.e.react?.me === b.dataset.r ? '' : b.dataset.r });
    else if (b.dataset.a === 'reply') setCompose(cp, 'reply', it);
    else if (b.dataset.a === 'edit') setCompose(cp, 'edit', it);
    else if (b.dataset.a === 'del') sendMsgOp(conv, { op: 'del', ref: it.e.mid });
    hide();
  });
  for (const cp of Object.values(composers)) {
    $(cp.input).addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cp.mode) { e.preventDefault(); e.stopPropagation(); cancelCompose(cp); }
      // стрелка вверх в пустом поле — изменить своё последнее сообщение
      if (e.key === 'ArrowUp' && !e.target.value && !cp.mode) {
        const conv = cp.conv();
        const mine = [...(conv?.msgs?.values() || [])].filter((x) => x.e.who === 'me' && x.e.type === 'text' && !x.e.deleted && x.el.isConnected);
        const last = mine[mine.length - 1];
        if (last) { e.preventDefault(); setCompose(cp, 'edit', last); }
      }
    });
  }
  $('chatSearchBtn').onclick = () => toggleSearch('call');
  $('dmSearchBtn').onclick = () => toggleSearch('dm');
}

function jumpToMsg(conv, mid) {
  const it = conv.msgs?.get(mid);
  if (!it || !it.el.isConnected) { toast('Это сообщение не загружено — пролистай историю выше или найди его через 🔍'); return false; }
  it.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  it.el.classList.remove('flash');
  void it.el.offsetWidth;
  it.el.classList.add('flash');
  return true;
}

/* ---------- Поиск по истории ---------- */
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
    sr.el.innerHTML = '<input type="search" placeholder="Поиск по переписке" maxlength="100" /><div class="ms-results"></div>';
    $(sr.host).before(sr.el);
    const inp = sr.el.querySelector('input');
    inp.addEventListener('input', () => { clearTimeout(sr.t); sr.t = setTimeout(() => runSearch(sr), 250); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sr.el.classList.add('hidden'); } });
  }
  sr.el.classList.remove('hidden');
  sr.el.querySelector('.ms-results').replaceChildren();
  const inp = sr.el.querySelector('input');
  inp.value = '';
  inp.focus();
}

async function runSearch(sr) {
  const conv = sr.conv();
  const q = sr.el.querySelector('input').value.trim();
  const box = sr.el.querySelector('.ms-results');
  if (!conv?.id || q.length < 2) { box.replaceChildren(); return; }
  const list = await window.duo.histSearch(conv.id, q).catch(() => []);
  box.replaceChildren();
  if (!list.length) { box.appendChild(Object.assign(document.createElement('div'), { className: 'ms-none', textContent: 'Ничего не нашлось' })); return; }
  for (const r of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ms-row';
    const head = document.createElement('small');
    head.textContent = `${r.who === 'me' ? (S.nick || 'Я') : (r.nick || conv.nick)} · ${timeStr(r.ts)}`;
    const body = document.createElement('div');
    const txt = (r.file ? '📎 ' : '') + r.text;
    const i = txt.toLowerCase().indexOf(q.toLowerCase());
    if (i >= 0) {
      const from = Math.max(0, i - 40);
      body.append(document.createTextNode((from ? '…' : '') + txt.slice(from, i)), Object.assign(document.createElement('mark'), { textContent: txt.slice(i, i + q.length) }), document.createTextNode(txt.slice(i + q.length, i + q.length + 80)));
    } else body.textContent = txt;
    row.append(head, body);
    row.onclick = () => jumpToHist(conv, r, sr);
    box.appendChild(row);
  }
}

async function jumpToHist(conv, r, sr) {
  await loadHistory(conv);
  for (let n = 0; n < 40 && conv.histStart > r.i; n++) {
    conv.box.querySelector('.hist-more')?.remove();
    await loadHistory(conv, true);
  }
  if (jumpToMsg(conv, r.mid)) sr.el.classList.add('hidden');
}

/* =========================================================
   Файлы и медиа: напрямую по зашифрованному каналу, без лимита
   Один и тот же механизм для звонка и для чата без звонка.
   Назначение файла (p): chat — в ленту, sound — звук для саундпада,
   avatar — аватарка, screenimg — картинка поверх экрана друга.
   ========================================================= */
const CHUNK = 64 * 1024;
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1073741824).toFixed(2) + ' ГБ');
const fileKind = (mime) => (/^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'file');
const FICON = { image: '🖼', video: '🎬', audio: '🎵', file: '📄' };
const NOUI = { progress() {}, done() {}, fail() {}, loading() {}, gone() {} };

function fileBubble(conv, who, meta, mine, opt = {}) {
  const m = document.createElement('div');
  m.className = 'msg' + (mine ? ' me' : '');
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `${who} · ${timeStr(opt.ts)}`;
  const b = document.createElement('div');
  b.className = 'bubble file';
  const view = document.createElement('div');
  const card = document.createElement('div');
  card.className = 'fcard';
  card.innerHTML = '<span class="ficon"></span><div><div class="fname2"></div><small></small></div>';
  card.querySelector('.ficon').textContent = FICON[meta.kind] || '📄';
  card.querySelector('.fname2').textContent = meta.name;
  card.querySelector('small').textContent = fmtSize(meta.size) + (meta.p === 'sound' ? ' · звук для саундпада' : '');
  view.appendChild(card);
  const prog = document.createElement('div');
  prog.className = 'fprog';
  prog.innerHTML = '<i></i>';
  const stat = document.createElement('div');
  stat.className = 'fstat';
  stat.innerHTML = '<span></span>';
  b.append(view, prog, stat);
  m.append(head, b);
  if (opt.mid) regMsg(conv, m, { mid: opt.mid, who: mine ? 'me' : 'peer', type: 'file', text: meta.name, react: opt.react, re: opt.re });
  (opt.into || conv.box).appendChild(m);
  if (!opt.into) scrollEnd(conv, mine);
  return {
    el: m,
    progress(done) {
      prog.querySelector('i').style.width = Math.min(100, (100 * done) / Math.max(1, meta.size)) + '%';
      stat.firstChild.textContent = `${fmtSize(done)} / ${fmtSize(meta.size)}`;
    },
    loading() { prog.remove(); stat.firstChild.textContent = 'загрузка…'; },
    done(url) {
      prog.remove();
      stat.firstChild.textContent = fmtSize(meta.size);
      if (meta.kind === 'image') {
        const img = document.createElement('img');
        img.src = url;
        img.alt = meta.name;
        img.onload = () => scrollEnd(conv);
        img.onclick = () => { $('lightboxImg').src = url; $('lightbox').classList.remove('hidden'); };
        view.replaceChildren(img);
      } else if (meta.kind === 'video' || meta.kind === 'audio') {
        const el = document.createElement(meta.kind);
        el.src = url;
        el.controls = true;
        el.preload = 'metadata';
        view.replaceChildren(el);
        stat.firstChild.textContent = `${meta.name} · ${fmtSize(meta.size)}`;
      }
      if (meta.p === 'sound' && !mine) {
        const add = document.createElement('button');
        add.className = 'btn';
        add.textContent = '➕ В саундпад';
        add.onclick = async () => {
          add.disabled = true;
          const blob = await fetch(url).then((r) => r.blob()).catch(() => null);
          const before = spList.length;
          if (blob) await spAddFiles([new File([blob], meta.name, { type: meta.mime })]);
          if (spList.length > before) add.textContent = 'Добавлено ✓';
          else { add.disabled = false; add.textContent = '➕ В саундпад'; }
        };
        stat.appendChild(add);
      }
      const save = document.createElement('button');
      save.className = 'btn';
      save.textContent = 'Сохранить';
      save.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = meta.name; a.click(); };
      stat.appendChild(save);
    },
    gone() {
      prog.remove();
      stat.firstChild.textContent = `${fmtSize(meta.size)} · не сохранено в истории`;
      m.classList.add('faded');
    },
    fail(why) {
      prog.remove();
      stat.firstChild.innerHTML = '';
      const sp = document.createElement('span');
      sp.className = 'bad';
      sp.textContent = 'Не доставлено: ' + why;
      stat.firstChild.appendChild(sp);
    },
  };
}

// запись о файле в историю (картинку — вместе с самой картинкой)
async function recordFile(conv, mine, meta, blob) {
  if (!conv || meta.p !== 'chat' && meta.p !== 'sound') return;
  const entry = { mid: meta.fid != null ? fmid(meta.fid) : newMid(), ts: Date.now(), who: mine ? 'me' : 'peer', nick: mine ? S.nick : conv.nick, type: 'file',
    file: { name: meta.name, size: meta.size, mime: meta.mime, kind: meta.kind, p: meta.p } };
  if (meta.kind === 'image' && meta.size <= HIST_IMG_MAX && conv.id) {
    try { entry.file.stored = await window.duo.histMediaSave(conv.id, new Uint8Array(await blob.arrayBuffer()), meta.name); } catch { /* без картинки */ }
  }
  record(conv, entry);
}

function waitLow(fdc) {
  return new Promise((res) => {
    const done = () => { fdc.removeEventListener('bufferedamountlow', done); clearInterval(t); res(); };
    const t = setInterval(() => { if (fdc.readyState !== 'open' || fdc.bufferedAmount < (4 << 20)) done(); }, 200);
    fdc.addEventListener('bufferedamountlow', done);
  });
}

class FileChan {
  // getConv() — разговор, в который показывать файлы; handlers — что делать с не-чатовыми файлами
  constructor(fdc, getConvFn, handlers = {}) {
    this.fdc = fdc;
    this.getConv = getConvFn;
    this.handlers = handlers;
    this.incoming = new Map();
    this.outgoing = [];
    this.sending = null;
    this.lastActive = Date.now();
    fdc.binaryType = 'arraybuffer';
    fdc.bufferedAmountLowThreshold = 1 << 20;
    fdc.addEventListener('message', (e) => this.onMsg(e.data));
    fdc.addEventListener('close', () => this.fail('связь прервалась'));
  }

  busy() { return !!this.sending || this.outgoing.length > 0 || this.incoming.size > 0; }

  queue(list, p = 'chat', extra = {}) {
    for (const f of list) {
      if (!f) continue;
      if (f.size > MAX_FILE) { toast(`${f.name}: больше 2 ГБ — не отправлю`); continue; }
      const name = f.name || `картинка-${Date.now()}.${((f.type || '').split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      const meta = { fid: crypto.getRandomValues(new Uint32Array(1))[0], name, size: f.size, mime: f.type || 'application/octet-stream', p };
      if (extra.pl) meta.pl = extra.pl;
      if (p === 'screenvid') { meta.vol = extra.vol; meta.snd = extra.snd ? 1 : 0; }
      meta.kind = fileKind(meta.mime);
      const conv = this.getConv();
      const ui = extra.ui || ((p === 'chat' || p === 'sound') && conv ? fileBubble(conv, S.nick || 'Я', meta, true, { mid: fmid(meta.fid) }) : NOUI);
      ui.progress(0);
      this.outgoing.push({ file: f, meta, ui });
      L('file', { queued: meta.kind, size: meta.size, p });
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
        if (fdc.readyState !== 'open') throw new Error('нет связи');
        fdc.send(JSON.stringify({ t: 'file-start', fid: job.meta.fid, name: job.meta.name, size: job.meta.size, mime: job.meta.mime, p: job.meta.p, pl: job.meta.pl, vol: job.meta.vol, snd: job.meta.snd }));
        let last = 0;
        for (let off = 0; off < job.meta.size; off += CHUNK) {
          if (fdc.bufferedAmount > (8 << 20)) await waitLow(fdc);
          if (fdc.readyState !== 'open') throw new Error('связь прервалась');
          const buf = await job.file.slice(off, off + CHUNK).arrayBuffer();
          const pkt = new Uint8Array(4 + buf.byteLength);
          new DataView(pkt.buffer).setUint32(0, job.meta.fid);
          pkt.set(new Uint8Array(buf), 4);
          fdc.send(pkt.buffer);
          this.lastActive = Date.now();
          if (Date.now() - last > 150) { job.ui.progress(off + buf.byteLength); last = Date.now(); }
        }
        fdc.send(JSON.stringify({ t: 'file-end', fid: job.meta.fid }));
        if (job.meta.p !== 'chat' && job.meta.p !== 'sound') job.ui.done?.();
        else if (job.ui !== NOUI) {
          const url = URL.createObjectURL(job.file);
          this.getConv()?.blobs.push(url);
          job.ui.done(url);
          recordFile(this.getConv(), true, job.meta, job.file);
        }
        L('file', { sent: job.meta.kind, size: job.meta.size, p: job.meta.p });
      } catch (e) {
        job.ui.fail(e.message);
        L('file', { sendFailed: e.message });
      }
      this.sending = null;
      this.lastActive = Date.now();
    }
  }

  onMsg(data) {
    this.lastActive = Date.now();
    if (typeof data === 'string') {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.t === 'file-start') {
        const p = ['chat', 'sound', 'avatar', 'screenimg', 'screenvid', 'update'].includes(m.p) ? m.p : 'chat';
        const meta = { fid: m.fid >>> 0, name: String(m.name || 'файл').slice(0, 200), size: Math.max(0, Number(m.size) || 0), mime: String(m.mime || 'application/octet-stream').slice(0, 100), p };
        if (p === 'screenimg' || p === 'screenvid') meta.pl = cleanPlacement(m.pl);
        if (p === 'screenvid') { meta.vol = Math.max(0, Math.min(1, Number(m.vol) || 0)); meta.snd = m.snd === 1; }
        if (meta.size > MAX_FILE) return;
        if ((p === 'avatar' && meta.size > 2 * 1024 * 1024) || (p === 'screenimg' && meta.size > 8 * 1024 * 1024)) return;
        if (p === 'screenvid' && meta.size > SVID_MAX) { this.handlers.screenvidBig?.(); return; }
        meta.kind = fileKind(meta.mime);
        const conv = this.getConv();
        const ui = (p === 'chat' || p === 'sound') && conv ? fileBubble(conv, conv.nick, meta, false, { mid: fmid(meta.fid) }) : NOUI;
        ui.progress(0);
        this.incoming.set(meta.fid, { meta, parts: [], got: 0, ui, last: 0 });
      } else if (m.t === 'file-end') {
        const e = this.incoming.get(m.fid >>> 0);
        if (!e) return;
        this.incoming.delete(m.fid >>> 0);
        // SVG/HTML не показываем как картинку (безопасность) — только «Сохранить»
        const safeMime = /svg|html|xml/i.test(e.meta.mime) ? 'application/octet-stream' : e.meta.mime;
        if (safeMime !== e.meta.mime) e.meta.kind = 'file';
        const blob = new Blob(e.parts, { type: safeMime });
        L('file', { received: e.meta.kind, size: e.got, p: e.meta.p });
        if (e.meta.p !== 'chat' && e.meta.p !== 'sound') { this.handlers[e.meta.p]?.(blob, e.meta); return; }
        const conv = this.getConv();
        const url = URL.createObjectURL(blob);
        conv?.blobs.push(url);
        e.ui.done(url);
        recordFile(conv, false, e.meta, blob);
        this.handlers.chatIn?.(conv, e.meta);
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return;
    const fid = new DataView(data).getUint32(0);
    const e = this.incoming.get(fid);
    if (!e) return;
    e.parts.push(data.slice(4));
    e.got += data.byteLength - 4;
    if (e.got > e.meta.size + CHUNK) { this.incoming.delete(fid); e.ui.fail('ошибка размера'); return; }
    if (Date.now() - e.last > 150) { e.ui.progress(e.got); e.last = Date.now(); }
  }

  fail(why) {
    for (const [, e] of this.incoming) e.ui.fail(why);
    this.incoming.clear();
    for (const j of this.outgoing.splice(0)) j.ui.fail(why);
  }
}

// файлы в звонке
function queueFiles(list, p = 'chat', extra) {
  if (!S.connected || !S.fileChan) { toast('Файлы можно отправить только в звонке'); return; }
  S.fileChan.queue(list, p, extra);
}

function filesFromEvent(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.items && dt.items.length) {
    for (const it of dt.items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
  } else if (dt.files) out.push(...dt.files);
  return out;
}

/* =========================================================
   Саундпад: звуки подмешиваются в голос после шумодава
   ========================================================= */
let spList = [];
let spStopKey = '';
let spNodes = null;           // { bus, mon }
const spBuffers = new Map();  // id -> AudioBuffer
const spPlaying = new Map();  // id -> AudioBufferSourceNode
let spEditId = null;
let spCapture = null;         // id, которому сейчас назначаем клавишу

function spBus() {
  const c = audio();
  if (!spNodes) {
    spNodes = { bus: c.createGain(), mon: c.createGain() };
    spNodes.mon.connect(fxOut);
    spUpdateGains();
  }
  return spNodes.bus;
}

function spUpdateGains() {
  if (!spNodes) return;
  const o = settings();
  const micOff = S.muted || S.deafened;
  spNodes.bus.gain.value = (micOff && !o.spWhenMuted) ? 0 : (Number(o.spVolOut) || 0) / 100;
  spNodes.mon.gain.value = o.spMonitor ? (Number(o.spVolMon) || 0) / 100 : 0;
}

async function spLoadList() {
  const d = await window.duo.soundsList().catch(() => ({ list: [], stopKey: '' }));
  spList = d.list;
  spStopKey = d.stopKey || '';
  spRender();
}

const prettyKey = (k) => (k || '').replace('CommandOrControl', 'Ctrl').replace(/num(\d)/i, 'Num$1').replace(/\+/g, '+');

function spRender() {
  const g = $('spGrid');
  g.innerHTML = '';
  $('spEmpty').classList.toggle('hidden', spList.length > 0);
  $('spStopKey').textContent = spStopKey ? prettyKey(spStopKey) : '';
  for (const s of spList) {
    const t = document.createElement('div');
    t.className = 'sp-tile' + (spPlaying.has(s.id) ? ' playing' : '');
    t.dataset.id = s.id;
    const n = document.createElement('div');
    n.className = 'sp-name';
    n.textContent = s.name;
    const k = document.createElement('div');
    k.className = 'sp-key';
    k.textContent = s.hotkey ? prettyKey(s.hotkey) : ' ';
    const more = document.createElement('button');
    more.className = 'sp-more';
    more.textContent = '⋯';
    more.title = 'Настроить';
    more.onclick = (e) => { e.stopPropagation(); spOpenEdit(s.id); };
    t.append(n, k, more);
    t.onclick = () => (spPlaying.has(s.id) ? spStop(s.id) : spPlay(s.id));
    t.oncontextmenu = (e) => { e.preventDefault(); spOpenEdit(s.id); };
    g.appendChild(t);
  }
}

async function spGetBuffer(id) {
  if (spBuffers.has(id)) return spBuffers.get(id);
  const bytes = await window.duo.soundsRead(id);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await audio().decodeAudioData(ab);
  spBuffers.set(id, buf);
  return buf;
}

async function spPlay(id) {
  const s = spList.find((x) => x.id === id);
  if (!s) return;
  try {
    const buf = await spGetBuffer(id);
    spStop(id);
    const c = audio();
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = (Number(s.vol) || 100) / 100;
    src.connect(g);
    g.connect(spBus());
    g.connect(spNodes.mon);
    src.onended = () => { if (spPlaying.get(id) === src) { spPlaying.delete(id); spRender(); spBitrate(); } };
    spPlaying.set(id, src);
    src.start();
    spRender();
    spBitrate();
    L('soundpad', { play: id, dur: Math.round(buf.duration * 10) / 10 });
  } catch (e) {
    toast(`Не удалось воспроизвести «${s.name}»: ${e.message || e}`);
    L('soundpad', { playFailed: e.message || String(e) });
  }
}

function spStop(id) {
  const src = spPlaying.get(id);
  if (!src) return;
  spPlaying.delete(id);
  try { src.stop(); } catch { /* */ }
  spRender();
  spBitrate();
}

function spStopAll() {
  for (const id of [...spPlaying.keys()]) spStop(id);
}

// пока играет звук — голосовой канал шире, чтобы музыка не превращалась в кашу
let spHighBr = false;
function spBitrate() {
  const want = spPlaying.size > 0;
  if (want === spHighBr || !S.tx) return;
  spHighBr = want;
  tuneSender(S.tx.mic.sender, { audio: want ? 128_000 : 64_000 });
}

async function spAddFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!f) continue;
    if (!/^audio\//.test(f.type) && !/\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm)$/i.test(f.name)) { toast(`${f.name}: это не звук`); continue; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      // проверяем, что файл вообще декодируется
      await audio().decodeAudioData(bytes.slice().buffer);
      await window.duo.soundsAdd(bytes, f.name);
      added++;
    } catch (e) { toast(`${f.name}: ${e.message || 'не получилось добавить'}`); }
  }
  if (added) { toast(added === 1 ? 'Звук добавлен' : `Добавлено звуков: ${added}`); await spLoadList(); }
}

function spOpenEdit(id) {
  const s = spList.find((x) => x.id === id);
  if (!s) return;
  spEditId = id;
  spCapture = null;
  $('spEdit').classList.remove('hidden');
  $('spEditName').value = s.name;
  $('spEditVol').value = String(s.vol ?? 100);
  $('spEditKey').classList.remove('capture');
  $('spEditKey').textContent = 'Клавиша: ' + (s.hotkey ? prettyKey(s.hotkey) : '—');
}

async function spSaveEdit() {
  const id = spEditId;
  if (!id) return;
  await window.duo.soundsUpdate(id, { name: $('spEditName').value.trim() || 'звук', vol: Number($('spEditVol').value) });
  spBuffers.delete(id);
  $('spEdit').classList.add('hidden');
  spEditId = null;
  spCapture = null;
  await spLoadList();
}

// нажатие клавиш → строка для Electron (Ctrl+Alt+1, num5, F9…)
function accelFromEvent(e) {
  const code = e.code;
  let key = null;
  if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = 'num' + code.slice(6);
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else key = { NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Pause: 'Pause' }[code] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  // одиночные буквы/цифры без модификаторов сломали бы набор текста везде — не разрешаем
  if (!mods.length && !/^(num|F\d)/.test(key) && !['Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Pause'].includes(key)) return 'NEED_MOD';
  return [...mods, key].join('+');
}

function spBind() {
  $('btnSoundpad').onclick = () => {
    const p = $('soundpad');
    p.classList.toggle('hidden');
    $('btnSoundpad').classList.toggle('on-pad', !p.classList.contains('hidden'));
    if (!p.classList.contains('hidden')) spLoadList();
  };
  $('spClose').onclick = () => { $('soundpad').classList.add('hidden'); $('btnSoundpad').classList.remove('on-pad'); };
  $('spAdd').onclick = () => $('spFile').click();
  $('spFile').onchange = (e) => { spAddFiles([...e.target.files]); e.target.value = ''; };
  $('spStop').onclick = (e) => { if (e.target.id === 'spStopKey') return; spStopAll(); };
  $('spStop').oncontextmenu = (e) => { e.preventDefault(); spCapture = '__stop'; toast('Нажми сочетание для «Стоп всё» (Esc — отмена, Backspace — убрать)'); };
  $('soundpad').addEventListener('dragenter', () => $('soundpad').classList.add('drag'));
  $('soundpad').addEventListener('dragleave', (e) => { if (!e.currentTarget.contains(e.relatedTarget)) $('soundpad').classList.remove('drag'); });
  const o = settings();
  $('spVolOut').value = String(o.spVolOut ?? 100);
  $('spVolMon').value = String(o.spVolMon ?? 60);
  $('spMonitor').checked = o.spMonitor !== false;
  $('spWhenMuted').checked = o.spWhenMuted !== false;
  const saveOpts = () => {
    store.set('settings', { ...settings(), spVolOut: Number($('spVolOut').value), spVolMon: Number($('spVolMon').value), spMonitor: $('spMonitor').checked, spWhenMuted: $('spWhenMuted').checked });
    spUpdateGains();
  };
  for (const id of ['spVolOut', 'spVolMon']) $(id).oninput = saveOpts;
  for (const id of ['spMonitor', 'spWhenMuted']) $(id).onchange = saveOpts;
  $('spEditDone').onclick = spSaveEdit;
  $('spEditDel').onclick = async () => {
    const id = spEditId;
    const s = spList.find((x) => x.id === id);
    if (!id || !confirm(`Удалить «${s?.name}»?`)) return;
    spStop(id);
    await window.duo.soundsRemove(id);
    spBuffers.delete(id);
    $('spEdit').classList.add('hidden');
    spEditId = null;
    spLoadList();
  };
  $('spEditKey').onclick = () => { spCapture = spEditId; $('spEditKey').classList.add('capture'); $('spEditKey').textContent = 'Нажми сочетание…'; };
  $('spEditKeyClear').onclick = async () => { if (!spEditId) return; await window.duo.soundsUpdate(spEditId, { hotkey: '' }); await spLoadList(); spOpenEdit(spEditId); };
  document.addEventListener('keydown', async (e) => {
    if (!spCapture) return;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = spCapture;
    if (e.key === 'Escape') { spCapture = null; if (target !== '__stop') spOpenEdit(target); return; }
    let acc = e.key === 'Backspace' ? '' : accelFromEvent(e);
    if (acc === 'NEED_MOD') { toast('Добавь Ctrl, Alt или Shift — иначе клавиша перестанет работать в других программах'); return; }
    if (acc === null) { toast('Эту клавишу назначить нельзя'); return; }
    spCapture = null;
    const r = await window.duo.soundsUpdate(target, { hotkey: acc });
    if (acc && r && r.ok === false) toast(`${prettyKey(acc)} уже занято другой программой — выбери другое сочетание`);
    else if (acc) toast(`Назначено: ${prettyKey(acc)}`);
    await spLoadList();
    if (target !== '__stop') spOpenEdit(target);
  }, true);
  spLoadList();
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function copyField(id, btn) {
  const text = $(id).value;
  if (!text) return;
  try {
    if (window.duo?.copy) await window.duo.copy(text);
    else await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Скопировано ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch {
    $(id).select();
    toast('Выдели и скопируй вручную (Ctrl+C)');
  }
}

async function pasteField(id) {
  try {
    const text = window.duo?.paste ? await window.duo.paste() : await navigator.clipboard.readText();
    $(id).value = (text || '').trim();
  } catch {
    $(id).focus();
    toast('Вставь вручную (Ctrl+V)');
  }
}

/* =========================================================
   Настройки
   ========================================================= */
let settingsMicStream = null;
let stopSettingsMeter = null;

async function openSettings() {
  buildThemeGrid();
  applyTheme(settings().theme || '');
  const o = settings();
  $('optNoise').checked = o.noise;
  $('optRnn').checked = o.rnn !== false;
  $('optEcho').checked = o.echo;
  $('optAgc').checked = o.agc;
  $('optSounds').checked = o.sounds;
  $('ringVol').value = String(o.ringVol ?? 80);
  $('optRingMute').checked = !!o.ringMute;
  refreshRingName();
  $('optNoStun').checked = o.noStun;
  $('optStunAlt').checked = !!o.stunAlt;
  $('stunCustom').value = o.stunCustom || '';
  window.duo?.appSettingsGet().then((a) => {
    $('appTray').checked = a.tray; $('appCloseToTray').checked = a.closeToTray; $('appMinToTray').checked = a.minToTray;
    $('appAutostart').checked = a.autostart; $('appStartHidden').checked = a.startHidden; $('appBossKey').checked = a.bossKey; $('appNotify').checked = a.notify;
    syncAppChecks();
  });
  $('minKbps').value = String(o.minKbps || 2500);
  $('optDuck').checked = !!o.duckOn;
  $('duckAmount').value = String(o.duckAmount ?? 50);
  $('duckAmountVal').textContent = (o.duckAmount ?? 50) + '%';
  $('optDuckOthers').checked = !!o.duckOthers;
  $('optDuckMe').checked = !!o.duckMe;
  $('optDuckStream').checked = !!o.duckStream;
  $('optOvlDraw').checked = o.ovlDraw !== false;
  $('optOvlReact').checked = !!o.ovlReact;
  $('optSvidSound').checked = o.svidInSound !== false;
  $('svidInVol').value = String(o.svidInVol ?? 80);
  $('svidInVolVal').textContent = (o.svidInVol ?? 80) + '%';
  $('optCtlAllow').checked = o.ctlAllow !== false;
  $('optClip').checked = o.clip !== false;
  $('clipSeconds').value = String(o.clipSeconds || 30);
  $('clipSecondsVal').textContent = (o.clipSeconds || 30) + ' с';
  $('optPtt').checked = !!o.ptt;
  $('pttKey').textContent = o.pttVk ? 'Клавиша рации: ' + (o.pttName || ('VK' + o.pttVk)) : 'Клавиша рации: не задана';
  $('optActivity').checked = !!o.activity;
  $('optAutoUpd').checked = o.autoUpdate !== false;
  refreshRollback();
  $('avatarInitial').textContent = initial($('nick').value);
  paintAvatar($('avatarPreview'), myAvatar?.url);
  window.duo?.getFlags().then((f) => { $('optAv1').checked = !!f?.av1hw; $('optAv1').dataset.was = f?.av1hw ? '1' : ''; });
  $('turnUrl').value = o.turnUrl;
  $('turnUser').value = o.turnUser;
  $('turnPass').value = o.turnPass;
  $('optRelay').checked = o.relay;
  $('settings').classList.remove('hidden');

  let meterStream = S.mic;
  if (!meterStream) {
    try {
      settingsMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      meterStream = settingsMicStream;
    } catch { /* без доступа покажем то, что есть */ }
  }
  await fillDevices(o);
  if (meterStream) {
    stopSettingsMeter = makeMeter(meterStream, (lvl) => {
      $('micMeter').style.width = Math.min(100, lvl * 400) + '%';
    });
  }
}

async function fillDevices(o) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current) => {
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Как в системе';
    sel.appendChild(def);
    devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${kind === 'audioinput' ? 'Микрофон' : 'Выход'} ${i + 1}`;
        sel.appendChild(opt);
      });
    sel.value = current;
    if (sel.value !== current) sel.value = '';
  };
  fill($('micSelect'), 'audioinput', o.mic);
  fill($('outSelect'), 'audiooutput', o.out);
}

// без трея «прятать в трей» не имеет смысла
function syncAppChecks() {
  const t = $('appTray').checked;
  for (const id of ['appCloseToTray', 'appMinToTray', 'appStartHidden']) $(id).disabled = !t;
  $('appStartHidden').disabled = !t || !$('appAutostart').checked;
}

function closeSettings() {
  $('settings').classList.add('hidden');
  if (!S.friendCall) stopRing();
  stopSettingsMeter?.(); stopSettingsMeter = null;
  settingsMicStream?.getTracks().forEach((t) => t.stop());
  settingsMicStream = null;
  $('micMeter').style.width = '0';
}

async function saveSettings() {
  const before = settings();
  const after = {
    ...before,
    mic: $('micSelect').value,
    out: $('outSelect').value,
    noise: $('optNoise').checked,
    rnn: $('optRnn').checked,
    echo: $('optEcho').checked,
    agc: $('optAgc').checked,
    sounds: $('optSounds').checked,
    ringVol: Number($('ringVol').value),
    ringMute: $('optRingMute').checked,
    noStun: $('optNoStun').checked,
    stunAlt: $('optStunAlt').checked,
    stunCustom: STUN_LISTS.parse($('stunCustom').value).map((u) => u.replace(/^stun:/, '')).join('\n'),
    minKbps: Number($('minKbps').value) || 2500,
    turnUrl: $('turnUrl').value.trim(),
    turnUser: $('turnUser').value.trim(),
    turnPass: $('turnPass').value,
    relay: $('optRelay').checked,
    duckOn: $('optDuck').checked,
    duckAmount: Number($('duckAmount').value) || 50,
    duckOthers: $('optDuckOthers').checked,
    duckMe: $('optDuckMe').checked,
    duckStream: $('optDuckStream').checked,
    ovlDraw: $('optOvlDraw').checked,
    ovlReact: $('optOvlReact').checked,
    svidInSound: $('optSvidSound').checked,
    svidInVol: Number($('svidInVol').value),
    ctlAllow: $('optCtlAllow').checked,
    clip: $('optClip').checked,
    clipSeconds: Number($('clipSeconds').value) || 30,
    ptt: $('optPtt').checked,
    autoUpdate: $('optAutoUpd').checked,
    activity: $('optActivity').checked,
  };
  store.set('settings', after);
  if (after.clip !== before.clip || after.clipSeconds !== before.clipSeconds) { S.clipKey = null; refreshClip(); }
  if (after.ptt !== before.ptt || after.pttVk !== before.pttVk) { applyPttHelper(); toast(after.ptt ? (after.pttVk ? 'Рация включена' : 'Задай клавишу рации') : 'Рация выключена'); }
  if (after.activity !== before.activity) applyActivity();
  if (after.autoUpdate !== before.autoUpdate) scheduleGh();
  if (['ovlDraw', 'ovlReact', 'ctlAllow'].some((k) => after[k] !== before[k])) {
    L('settings', { ovlDraw: after.ovlDraw, ovlReact: after.ovlReact, ctlAllow: after.ctlAllow });
    if (S.connected) sendPerm();
  }
  closeSettings();
  const av1 = $('optAv1').checked;
  if (av1 !== !!$('optAv1').dataset.was) {
    await window.duo?.setFlags({ av1hw: av1 });
    L('settings', { av1hw: av1 });
    toast('AV1 ' + (av1 ? 'включится' : 'выключится') + ' после перезапуска alloconnect');
  }
  if (after.out !== before.out) applyOutputDevice();
  if (after.rnn !== before.rnn) { if (after.rnn) await ensureRnnoise(); routeChain(); }
  if (['mic', 'noise', 'echo', 'agc'].some((k) => after[k] !== before[k]) && S.mic) await restartMic();
  if (['noStun', 'stunAlt', 'stunCustom'].some((k) => after[k] !== before[k])) {
    L('settings', { stun: stunPlan().map((p) => p.name).join('>'), customCount: STUN_LISTS.parse(after.stunCustom).length });
    if ($('stunCustom').value.trim() && !after.stunCustom) toast('Свои STUN-серверы не распознаны — пиши адрес вида stun.example.com:3478');
    window.duo.netConfig(netCfg());
    stunCheck();
  }
  if (['noStun', 'stunAlt', 'stunCustom', 'turnUrl', 'turnUser', 'turnPass', 'relay', 'minKbps'].some((k) => after[k] !== before[k]) && S.pc) {
    toast('Сетевые настройки применятся к следующему приглашению');
  }
}

/* =========================================================
   Привязка событий
   ========================================================= */
function bind() {
  $('nick').value = store.get('nick', '');

  // Лобби
  $('btnInvite').onclick = startInvite;
  $('btnHaveInvite').onclick = () => { $('offerIn').value = ''; showStep('stepGuest'); };
  $('btnCopyOffer').onclick = (e) => copyField('offerOut', e.currentTarget);
  $('btnCopyAnswer').onclick = (e) => copyField('answerOut', e.currentTarget);
  $('btnPasteAnswer').onclick = () => pasteField('answerIn');
  $('btnPasteOffer').onclick = () => pasteField('offerIn');
  $('btnApplyAnswer').onclick = applyAnswer;
  $('btnMakeAnswer').onclick = makeAnswer;
  document.querySelectorAll('.back').forEach((b) => { b.onclick = backToHome; });
  $('offerOut').onclick = (e) => e.target.select();
  $('answerOut').onclick = (e) => e.target.select();

  // Звонок
  $('btnMute').onclick = () => {
    if (S.deafened) { setDeafened(false); if (S.muted) setMuted(false); return; }
    setMuted(!S.muted);
  };
  $('btnDeafen').onclick = () => setDeafened(!S.deafened);
  $('btnNs').onclick = () => setNs(!(settings().rnn !== false));
  updateNsBtn();
  $('btnShare').onclick = openPicker;
  $('btnLeave').onclick = leaveCall;

  $('friendVol').oninput = (e) => {
    const v = Number(e.target.value);
    if (friendGain) friendGain.gain.value = v / 100;
    $('friendVolVal').textContent = v + '%';
    store.set('friendVol', v);
  };
  const fv = store.get('friendVol', 100);
  $('friendVol').value = fv;
  $('friendVolVal').textContent = fv + '%';

  $('screenVol').oninput = (e) => { $('remoteScreen').volume = Number(e.target.value) / 100; };
  $('btnFull').onclick = () => $('remoteScreenWrap').requestFullscreen().catch(() => {});
  // как в видеоплеере: в полноэкранном режиме прячем плашку и курсор через 2.5 с без движения
  let idleT = null;
  const wrap = $('remoteScreenWrap');
  const poke = () => {
    wrap.classList.remove('idle');
    clearTimeout(idleT);
    if (document.fullscreenElement === wrap) idleT = setTimeout(() => wrap.classList.add('idle'), 2500);
  };
  wrap.addEventListener('mousemove', poke);
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement === wrap) poke(); else { clearTimeout(idleT); wrap.classList.remove('idle'); } });
  $('remoteScreen').ondblclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('remoteScreenWrap').requestFullscreen().catch(() => {});
  };

  // Файлы: скрепка, Ctrl+V, перетаскивание
  $('btnAttach').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { queueFiles([...e.target.files]); e.target.value = ''; };
  document.addEventListener('paste', (e) => {
    const dmVisible = !$('dm').classList.contains('hidden');
    if (!S.inCall && !dmVisible) return;
    const files = filesFromEvent(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    if (dmVisible) dmSendFiles(files); else queueFiles(files);
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); if ((S.inCall || !$('dm').classList.contains('hidden')) && [...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('dropOverlay').classList.remove('hidden'); } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').classList.add('hidden'); });
  const overStreamForImage = (e) => S.inCall && S.friendPerm?.react && !$('remoteScreenWrap').classList.contains('hidden') &&
    !!e.target.closest?.('#remoteScreenWrap') && [...(e.dataTransfer?.items || [])].some((it) => it.kind === 'file' && (IMG_TYPES.test(it.type) || VID_TYPES.test(it.type)));
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    const onStream = overStreamForImage(e);
    $('dropOverlay').classList.toggle('to-screen', onStream);
    $('dropOverlay').firstElementChild.textContent = onStream ? 'Отпусти — картинка или видео полетит на экран друга (место, размер и звук выберешь)' : 'Отпусти, чтобы отправить другу';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
    if (overStreamForImage(e)) {
      const img = filesFromEvent(e.dataTransfer).find((f) => IMG_TYPES.test(f.type) || VID_TYPES.test(f.type));
      if (img) { startPlacement(img, normPt(e)); return; }
    }
    if (e.target.closest?.('#soundpad')) { $('soundpad').classList.remove('drag'); spAddFiles(filesFromEvent(e.dataTransfer)); return; }
    if (!$('dm').classList.contains('hidden')) { dmSendFiles(filesFromEvent(e.dataTransfer)); return; }
    if (S.inCall) queueFiles(filesFromEvent(e.dataTransfer));
  });
  $('lightbox').onclick = () => $('lightbox').classList.add('hidden');
  spBind();

  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    if (!S.connected) { toast('Друг не в звонке'); return; }
    if (composeSubmitEdit(composers.call, S.callConv, text)) return;
    const ts = Date.now();
    const mid = newMid();
    const re = composeTakeReply(composers.call);
    send({ t: 'chat', text, ts, mid, re: reOut(re) });
    chatMsg(S.callConv, S.nick, text, true, ts, null, { mid, re });
    record(S.callConv, { mid, ts, who: 'me', nick: S.nick, type: 'text', text, re: re || undefined });
    $('chatInput').value = '';
  };

  // Окно выбора источника
  document.querySelectorAll('#picker .tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('#picker .tab').forEach((x) => x.classList.toggle('active', x === t));
      pickerTab = t.dataset.tab;
      pickedId = null;
      updateSysAudioLabel();
      renderSources();
    };
  });
  $('btnStartShare').onclick = beginShare;

  // Настройки
  $('btnSettings').onclick = openSettings;
  $('btnSettingsLobby').onclick = openSettings;
  $('btnSaveSettings').onclick = saveSettings;
  $('btnOpenLogs').onclick = () => window.duo?.openLogs();
  // «Программа»: применяем сразу
  const appMap = { appTray: 'tray', appCloseToTray: 'closeToTray', appMinToTray: 'minToTray', appAutostart: 'autostart', appStartHidden: 'startHidden', appBossKey: 'bossKey', appNotify: 'notify' };
  for (const [el, key] of Object.entries(appMap)) {
    $(el).onchange = async () => { await window.duo.appSettingsSet({ [key]: $(el).checked }); syncAppChecks(); };
  }
  // звук звонка
  $('btnRingPick').onclick = () => $('ringFileInput').click();
  $('ringFileInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      await window.duo.ringtoneSave(bytes, f.type || 'audio/mpeg', f.name);
      dropRingAudio();
      refreshRingName();
      toast('Звук звонка сохранён');
    } catch (err) { toast('Не удалось: ' + (err.message || err)); }
  };
  $('btnRingReset').onclick = async () => { stopRing(); await window.duo.ringtoneClear(); dropRingAudio(); refreshRingName(); toast('Стандартный звук звонка'); };
  $('btnRingTest').onclick = async () => {
    if (ringTimer) { stopRing(); $('btnRingTest').textContent = '▶ Проверить'; return; }
    store.set('settings', { ...settings(), ringVol: Number($('ringVol').value), ringMute: false });
    await startRing('in');
    $('btnRingTest').textContent = '■ Стоп';
    setTimeout(() => { if (!S.friendCall) { stopRing(); $('btnRingTest').textContent = '▶ Проверить'; } }, 8000);
  };
  $('ringVol').oninput = (e) => { if (ringAudio) ringAudio.volume = Number(e.target.value) / 100; };
  $('btnCallAccept').onclick = acceptCall;
  $('btnCallDecline').onclick = declineCall;
  $('btnCallCancel').onclick = cancelCall;
  $('btnAddFriend').onclick = addPeerFriend;
  $('btnNetRecheck').onclick = async () => { $('netVerdict').textContent = 'Проверяю…'; renderNet(await window.duo.netRecheck()); stunCheck(); };
  $('btnOpenLogsLobby').onclick = () => window.duo?.openLogs();

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => {
      const modal = b.closest('.modal');
      if (modal.id === 'settings') closeSettings(); else modal.classList.add('hidden');
    };
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('settings').classList.contains('hidden')) closeSettings();
    $('picker').classList.add('hidden');
    if (!$('dm').classList.contains('hidden') && $('lightbox').classList.contains('hidden')) closeDm();
    $('lightbox').classList.add('hidden');
  });

  // Чат без звонка
  $('dmClose').onclick = closeDm;
  $('dmCall').onclick = () => { const id = dmOpen?.id; closeDm(); if (id) callFriend(id); };
  $('dmClear').onclick = async () => {
    const c = dmOpen;
    if (!c || !confirm(`Удалить всю переписку с ${c.nick}? Только у тебя.`)) return;
    await window.duo.histClear(c.id);
    c.box.replaceChildren();
    c.loaded = true;
    c.histStart = 0;
    toast('История очищена');
  };
  $('dmForm').onsubmit = (e) => { e.preventDefault(); dmSendText(); };
  bindMsgUi();
  $('dmAttach').onclick = () => $('dmFile').click();
  $('dmFile').onchange = (e) => { dmSendFiles([...e.target.files]); e.target.value = ''; };
  $('dm').addEventListener('mousedown', (e) => { if (e.target.id === 'dm') closeDm(); });

  // Аватарка, приглушение, история
  $('btnAvatarPick').onclick = () => $('avatarInput').click();
  $('avatarInput').onchange = (e) => { pickAvatar(e.target.files[0]); e.target.value = ''; };
  $('btnAvatarClear').onclick = clearAvatar;
  $('duckAmount').oninput = (e) => { $('duckAmountVal').textContent = e.target.value + '%'; };
  $('svidInVol').oninput = (e) => { $('svidInVolVal').textContent = e.target.value + '%'; };
  $('btnHistClearAll').onclick = async () => {
    if (!confirm('Удалить историю всех чатов на этом компьютере?')) return;
    await window.duo.histClear(null);
    for (const c of convs.values()) { c.box.replaceChildren(); c.loaded = true; c.histStart = 0; }
    toast('История чатов очищена');
  };

  // Управление
  $('btnCtlAllow').onclick = ctlGrant;
  $('btnCtlDeny').onclick = ctlDeny;
  $('btnCtlRevoke').onclick = () => ctlEnd(`ты забрал управление`);
  $('clipClose').onclick = () => { $('clipModal').classList.add('hidden'); $('clipVideo').pause(); };
  $('updApply').onclick = doUpdateApply;
  $('updClose').onclick = () => finishUpdPull('');
  $('pttKey').onclick = startPttCapture;
  $('btnRollback').onclick = doRollback;
  $('btnGhCheck').onclick = () => ghCheckNow(true);
  document.addEventListener('keydown', (e) => { if (pttCapture) { e.preventDefault(); const vk = codeToVk(e); if (vk) finishPttCapture(vk); } }, true);
  document.addEventListener('mousedown', (e) => { if (pttCapture && e.button >= 1) { e.preventDefault(); finishPttCapture(e.button === 1 ? 4 : e.button === 3 ? 5 : e.button === 4 ? 6 : 0); } }, true);
  $('clipModal').addEventListener('mousedown', (e) => { if (e.target.id === 'clipModal') { $('clipModal').classList.add('hidden'); $('clipVideo').pause(); } });
  bindLiveTools();
  window.duo?.onInputEvt(onInputEvt);
  $('spEditShare').onclick = () => { if (spEditId) spShare(spEditId); };

  window.duo?.onHotkey((what) => {
    if (what === 'mark') { toast('Метка в логе поставлена'); sound('msg'); return; }
    if (what === 'sound-stop') { spStopAll(); return; }
    if (what === 'leave') { if (S.inCall) leaveCall(); return; }
    if (what === 'ctl-stop') { ctlEnd('ты забрал управление (Ctrl+Shift+X)'); return; }
    if (what === 'clip') { saveClip(); return; }
    if (what.startsWith('sound:')) { if (S.inCall) spPlay(what.slice(6)); return; }
    if (!S.inCall) return;
    if (what === 'mute') $('btnMute').click();
    if (what === 'deafen') setDeafened(!S.deafened);
    if (what === 'ns') setNs(!(settings().rnn !== false));
  });

  window.duo?.onWinState(onWinState);
  window.duo?.onSysAudioData(onPcmChunk);
  window.duo?.onSysAudioEnd(() => {
    if (pcmNode && S.localScreen) toast('Захват звука остановился — демонстрация идёт без звука');
    stopPcm();
  });

  window.addEventListener('beforeunload', () => send({ t: 'bye' }));
  window.addEventListener('focus', () => { audio(); checkClipboard(); });
  setInterval(checkClipboard, 1200);

  loadMyAvatar().then(refreshAvatars);
  initUpdates();
  if (settings().ptt) applyPttHelper();
  if (settings().activity) applyActivity();
  window.duo?.platform().then((p) => {
    S.platform = p;
    if (p !== 'win32') $('sysAudioRow').classList.add('hidden');
  });
}

/* =========================================================
   Друзья: список, звонок в один клик, входящие
   ========================================================= */
let friendsList = [];
let myIdent = null;
let ringTimer = null;

const isFriend = (id) => friendsList.some((f) => f.id === id);

async function initFriends() {
  window.duo.netConfig(netCfg());
  for (let i = 0; i < 20 && !myIdent; i++) {
    myIdent = await window.duo.friendsInfo().catch(() => null);
    if (!myIdent) await new Promise((r) => setTimeout(r, 500));
  }
  if (myIdent) { friendsList = myIdent.list || []; renderFriends(); }
  window.duo.onFriends((l) => { friendsList = l; renderFriends(); });
  window.duo.onFriendMsg(onFriendMsg);
  window.duo.onNet(renderNet);
  renderNet(await window.duo.netGet());
  stunCheck();
}

function netCfg() {
  const o = settings();
  return { noStun: !!o.noStun, stunAlt: !!o.stunAlt, stunCustom: STUN_LISTS.parse(o.stunCustom) };
}

function pushTrayState() {
  window.duo?.trayState({ inCall: !!S.connected, friend: S.friendNick || '', online: friendsList.filter((f) => f.online).length, muted: !!(S.muted || S.deafened) });
}

function renderFriends() {
  pushTrayState();
  updateDmHead();
  const box = $('friendsBox');
  box.classList.toggle('hidden', friendsList.length === 0);
  const list = $('friendsList');
  list.innerHTML = '';
  const sorted = [...friendsList].sort((a, b) => (b.online - a.online) || a.nick.localeCompare(b.nick));
  for (const f of sorted) {
    const row = document.createElement('div');
    row.className = 'friend' + (f.online ? ' online' : '');
    const dot = document.createElement('i');
    dot.className = 'fdot';
    const av = document.createElement('div');
    av.className = 'favatar';
    av.dataset.id = f.id;
    const avi = document.createElement('span');
    avi.textContent = initial(f.nick);
    av.append(avi, dot);
    friendAvatar(f.id).then((a) => paintAvatar(av, a?.url));
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = f.nick;
    const st = document.createElement('small');
    const act = f.online && f.act && f.act.game ? ` · 🎮 ${f.act.game}` : '';
    st.textContent = (f.online ? 'в сети' : (f.lastSeen ? 'не в сети' : 'ещё не был в сети')) + act;
    name.appendChild(st);
    const call = document.createElement('button');
    call.className = 'btn primary fcall';
    call.textContent = 'Позвонить';
    call.onclick = () => callFriend(f.id);
    const chat = document.createElement('button');
    chat.className = 'btn fchat';
    chat.title = 'Чат и файлы без звонка';
    chat.textContent = '💬';
    const unread = convs.get(f.id)?.unread || 0;
    if (unread) { const b = document.createElement('b'); b.className = 'badge'; b.textContent = unread > 99 ? '99+' : String(unread); chat.appendChild(b); }
    chat.onclick = () => openDm(f.id);
    let upBtn = null;
    if (f.online && f.ver && myUpd && verCmpR(f.ver, myUpd.v) > 0) {
      upBtn = document.createElement('button');
      upBtn.className = 'btn fupd';
      upBtn.title = `Обновиться до ${f.ver} (от ${f.nick})`;
      upBtn.textContent = `⬆ ${f.ver}`;
      upBtn.onclick = () => startUpdatePull(f.id, f.nick, f.ver);
    }
    const del = document.createElement('button');
    del.className = 'icon-btn fdel';
    del.title = 'Удалить из друзей';
    del.textContent = '✕';
    del.onclick = () => { if (confirm(`Удалить ${f.nick} из друзей?`)) window.duo.friendsRemove(f.id); };
    row.append(av, name, chat, call, del);
    if (upBtn) name.appendChild(upBtn);
    list.appendChild(row);
  }
}

function showCallModal(dir, nick) {
  closeDm(); // окно чата лежит выше — иначе входящий звонок за ним не видно
  $('callModal').classList.remove('hidden');
  $('callAvatar').textContent = initial(nick);
  paintAvatar($('callAvatar'), null);
  if (S.friendCall?.id) friendAvatar(S.friendCall.id).then((a) => { if (a && !$('callModal').classList.contains('hidden')) paintAvatar($('callAvatar'), a.url); });
  $('callTitle').textContent = dir === 'in' ? `${nick} звонит` : `Звоним ${nick}`;
  $('callSub').textContent = dir === 'in' ? 'Входящий звонок' : 'Связываемся…';
  $('btnCallAccept').classList.toggle('hidden', dir !== 'in');
  $('btnCallDecline').classList.toggle('hidden', dir !== 'in');
  $('btnCallCancel').classList.toggle('hidden', dir === 'in');
}
function hideCallModal() {
  $('callModal').classList.add('hidden');
  stopRing();
  if (S.friendCall?.timer) clearTimeout(S.friendCall.timer);
}
/* ---------- Гудки у звонящего и мелодия у принимающего ---------- */
let ringAudio = null;   // <audio> со своим файлом
let ringUrl = null;
let ringOsc = [];

// классические гудки: 425 Гц, 1 с тон / 3 с пауза
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
  o.connect(g).connect(fxOut);
  o.start(t); o.stop(t + 1.02);
  ringOsc.push(o);
}

// стандартная мелодия входящего
function ringMelody(vol) {
  const c = audio();
  let t = c.currentTime + 0.02;
  const notes = [659, 784, 988, 784, 659, 784, 988, 1175];
  for (const f of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    o.connect(g).connect(fxOut);
    o.start(t); o.stop(t + 0.18);
    ringOsc.push(o);
    t += 0.13;
  }
}

async function loadRingAudio() {
  if (ringAudio) return ringAudio;
  const r = await window.duo.ringtoneLoad().catch(() => null);
  if (!r || !r.bytes) return null;
  const b = r.bytes;
  ringUrl = URL.createObjectURL(new Blob([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)], { type: r.mime || 'audio/mpeg' }));
  ringAudio = new Audio(ringUrl);
  ringAudio.loop = true;
  try { const out = settings().out; if (out && ringAudio.setSinkId) await ringAudio.setSinkId(out); } catch { /* */ }
  return ringAudio;
}

function dropRingAudio() {
  try { ringAudio?.pause(); } catch { /* */ }
  ringAudio = null;
  if (ringUrl) URL.revokeObjectURL(ringUrl);
  ringUrl = null;
}

// dir: 'in' — мелодия/свой файл, 'out' — гудки
async function startRing(dir = 'in') {
  stopRing();
  const o = settings();
  if (dir === 'out') {
    ringbackBeep();
    ringTimer = setInterval(ringbackBeep, 4000);
    return;
  }
  if (o.ringMute) return;
  const vol = Math.max(0, Math.min(1, (Number(o.ringVol) || 80) / 100));
  const a = await loadRingAudio();
  if (ringTimer === 'stopped') return;
  if (a) {
    a.volume = vol;
    a.currentTime = 0;
    a.play().catch((e) => { L('ring', { playFailed: e.message }); ringMelody(vol); ringTimer = setInterval(() => ringMelody(vol), 2200); });
    ringTimer = 'file';
    return;
  }
  ringMelody(vol);
  ringTimer = setInterval(() => ringMelody(vol), 2200);
}

function stopRing() {
  if (typeof ringTimer === 'number') clearInterval(ringTimer);
  ringTimer = null;
  try { ringAudio?.pause(); } catch { /* */ }
  for (const o of ringOsc.splice(0)) { try { o.stop(); } catch { /* */ } }
}

async function refreshRingName() {
  const r = await window.duo.ringtoneLoad().catch(() => null);
  $('ringName').textContent = r?.name ? `свой: ${r.name}` : 'стандартный';
}

function endFriendCall(text) {
  const fc = S.friendCall;
  hideCallModal();
  S.friendCall = null;
  if (!S.connected) {
    clearTimeout(S.connectTimer);
    closePc();
    releaseMic();
    showStep('stepHome');
  }
  if (text) { toast(text); L('friend-call', { ended: text, dir: fc?.dir }); }
}

async function callFriend(id) {
  if (S.busy || S.pc || S.friendCall || S.inCall) return;
  const f = friendsList.find((x) => x.id === id);
  if (!f) return;
  S.nick = $('nick').value.trim() || 'Без имени';
  S.friendCall = { id, nick: f.nick, dir: 'out' };
  L('friend-call', { out: true, friendOnline: f.online, addrKinds: f.addrKinds });
  showCallModal('out', f.nick);
  startInvite();
}

async function sendFriendInvite(code) {
  const fc = S.friendCall;
  if (!fc || fc.dir !== 'out') return; // встречный звонок уже принят — своё приглашение не шлём
  $('callSub').textContent = 'Отправляю вызов…';
  const r = await window.duo.friendsSend(fc.id, { t: 'call', code, nick: S.nick });
  if (S.friendCall !== fc) return;
  if (!r.ok) { endFriendCall(`${fc.nick} не отвечает — у него закрыт alloconnect или до него не достучаться`); return; }
  $('callSub').textContent = 'Вызов доставлен — ждём ответа';
  startRing('out');
  fc.timer = setTimeout(() => {
    if (S.friendCall !== fc) return;
    window.duo.friendsSend(fc.id, { t: 'cancel' });
    endFriendCall(`${fc.nick} не ответил`);
  }, 40000);
}

function onFriendMsg({ id, msg }) {
  const f = friendsList.find((x) => x.id === id);
  const nick = f?.nick || String(msg.nick || 'Друг').slice(0, 24);
  const fc = S.friendCall;
  L('friend-msg', { t: msg.t, from: id.slice(0, 8) });
  switch (msg.t) {
    case 'call':
      // встречный звонок: оба нажали «Позвонить» одновременно → звонит тот, у кого ID больше
      if (fc && fc.dir === 'out' && fc.id === id && !S.connected) {
        L('friend-call', { glare: true, iWin: myIdent?.id > id });
        if (myIdent?.id > id) return; // друг примет мой звонок сам
        if (!/^ALOI\./.test(String(msg.code || ''))) return;
        clearTimeout(fc.timer);
        stopRing();
        S.friendCall = { id, nick, dir: 'in', code: msg.code, accepted: true };
        showCallModal('in', nick);
        $('callSub').textContent = 'Соединяемся…';
        $('btnCallAccept').classList.add('hidden');
        $('btnCallDecline').classList.add('hidden');
        if (S.busy) S.answerWhenFree = msg.code; // ещё готовится моё приглашение — ответим сразу после
        else makeAnswer(msg.code);
        return;
      }
      if (fc?.dir === 'in' && fc.id === id && fc.accepted) return; // повтор того же вызова
      if (S.inCall || S.busy || S.pc || fc) { window.duo.friendsSend(id, { t: 'busy' }); return; }
      if (!/^ALOI\./.test(String(msg.code || ''))) return;
      S.friendCall = { id, nick, dir: 'in', code: msg.code };
      showCallModal('in', nick);
      startRing();
      window.duo.focusWindow();
      window.duo.notify({ title: `${nick} звонит`, body: 'Входящий звонок в alloconnect', kind: 'call' });
      S.friendCall.timer = setTimeout(() => {
        if (S.friendCall?.id === id && S.friendCall.dir === 'in' && !S.friendCall.accepted) {
          window.duo.friendsSend(id, { t: 'decline' });
          endFriendCall(`Пропущенный звонок от ${nick}`);
        }
      }, 40000);
      return;
    case 'answer':
      if (fc?.dir !== 'out' || fc.id !== id) return;
      clearTimeout(fc.timer);
      stopRing();
      $('callSub').textContent = 'Соединяемся…';
      applyAnswer(String(msg.code || ''));
      armConnectTimer(HOST_CONNECT_TIMEOUT);
      return;
    case 'decline':
      if (fc?.id === id && fc.dir === 'out') endFriendCall(`${nick} отклонил звонок`);
      return;
    case 'busy':
      if (fc?.id === id && fc.dir === 'out') endFriendCall(`${nick} сейчас занят`);
      return;
    case 'cancel':
      if (fc?.id === id && fc.dir === 'in') endFriendCall(fc.accepted ? `${nick} отменил звонок` : `Пропущенный звонок от ${nick}`);
      return;
    case 'dm':
      if (f) onDmText(id, nick, msg);
      return;
    case 'dm-op':
      if (f) { const conv = getConv(id, nick); loadHistory(conv).then(() => applyOp(conv, msg, 'peer')); }
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

function acceptCall() {
  const fc = S.friendCall;
  if (!fc || fc.dir !== 'in') return;
  fc.accepted = true;
  clearTimeout(fc.timer);
  stopRing();
  $('callSub').textContent = 'Соединяемся…';
  $('btnCallAccept').classList.add('hidden');
  $('btnCallDecline').classList.add('hidden');
  S.nick = $('nick').value.trim() || 'Без имени';
  makeAnswer(fc.code);
}
function declineCall() {
  const fc = S.friendCall;
  if (!fc) return;
  window.duo.friendsSend(fc.id, { t: 'decline' });
  endFriendCall();
}
function cancelCall() {
  const fc = S.friendCall;
  if (!fc) return;
  window.duo.friendsSend(fc.id, { t: 'cancel' });
  endFriendCall();
}

/* ---------- В звонке: обмен ID и «Добавить в друзья» ---------- */
// ID в 'ident' — только заявка. В звонке по коду собеседник доказывает, что ключ его:
// мы шлём вызов ch, он отвечает 'ident-proof' (HMAC ключом пары, привязан к DTLS-отпечаткам звонка).
// Без доказательства звонок не привязывается к другу: ни истории, ни смены его адресов.
async function sendIdent() {
  const info = await window.duo.friendsInfo().catch(() => null);
  if (!info) return;
  const ch = b64uBytes(crypto.getRandomValues(new Uint8Array(18)));
  S.identCh = ch;
  send({ t: 'ident', id: info.id, addrs: info.addrs, av: myAvatar?.hash || '', ch });
}
function b64uBytes(u8) { return btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
// DTLS-отпечатки обеих сторон этого соединения (одинаковая строка у обоих)
function callBinding() {
  const fps = (sdp) => [...String(sdp || '').matchAll(/^a=fingerprint:(.+)$/gm)].map((m) => m[1].trim().toLowerCase());
  const all = [...new Set([...fps(S.pc?.localDescription?.sdp), ...fps(S.pc?.remoteDescription?.sdp)])].sort();
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
    const me = await window.duo.friendsInfo().catch(() => null);
    const bind = callBinding();
    const mac = me && bind ? await window.duo.friendsProof(d.id, me.id, d.ch, bind).catch(() => null) : null;
    if (mac) send({ t: 'ident-proof', mac });
  } else {
    L('friends', { peerIdent: 'no-proof', alreadyFriend: isFriend(d.id) });
    if (isFriend(d.id)) sysMsg(`⚠ Собеседник назвался ${friendNickOf(d.id)}, но не подтвердил это ключом (у него старая alloconnect?). Звонок не привязан к другу.`);
  }
}
async function onPeerIdentProof(d) {
  const claim = S.peerClaim;
  if (!claim || !S.identCh || typeof d?.mac !== 'string') return;
  const bind = callBinding();
  const want = bind ? await window.duo.friendsProof(claim.id, claim.id, S.identCh, bind).catch(() => null) : null;
  if (S.peerClaim !== claim) return;
  if (want && want === d.mac) { S.peerClaim = null; acceptPeerIdent(claim); return; }
  S.peerClaim = null;
  if (S.peerIdent?.id === claim.id) return; // уже подтверждён раньше (опоздавший ответ после переподключения)
  L('friends', { peerIdent: 'bad-proof', alreadyFriend: isFriend(claim.id) });
  sysMsg(isFriend(claim.id)
    ? `⚠ Собеседник выдаёт себя за ${friendNickOf(claim.id)}, но ключ не его. Звонок не привязан к другу.`
    : '⚠ Собеседник не подтвердил свой ID — добавить его в друзья нельзя.');
}
function friendNickOf(id) { return friendsList.find((f) => f.id === id)?.nick || 'друга'; }

// реальный путь звонка → подсказка модулю друзей, куда стучаться
function sendCallPath() {
  if (!S.callPath || !S.peerIdent || !isFriend(S.peerIdent.id)) return;
  if (S.callPath.remoteType === 'relay') return;
  window.duo.friendsCallPath({ id: S.peerIdent.id, ...S.callPath });
}

function acceptPeerIdent(d) {
  S.peerIdent = { id: d.id, addrs: d.addrs };
  adoptCallConv(d.id);
  onPeerAvatarHash(d.id, d.av, () => send({ t: 'av-want' })).then(refreshAvatars);
  L('friends', { peerIdent: true, verified: true, peerAddrKinds: S.peerIdent.addrs.map((a) => a.kind), alreadyFriend: isFriend(d.id) });
  if (isFriend(d.id)) {
    window.duo.friendsAdd({ id: d.id, nick: friendsList.find((f) => f.id === d.id)?.nick || S.friendNick, addrs: S.peerIdent.addrs })
      .then(() => sendCallPath());
    $('btnAddFriend').classList.add('hidden');
  } else {
    $('btnAddFriend').textContent = '➕ В друзья';
    $('btnAddFriend').classList.remove('hidden');
  }
}
async function addPeerFriend() {
  if (!S.peerIdent) return;
  const ok = await window.duo.friendsAdd({ id: S.peerIdent.id, nick: S.friendNick, addrs: S.peerIdent.addrs });
  if (!ok) { toast('Не удалось добавить'); return; }
  send({ t: 'friend-added' });
  $('btnAddFriend').classList.add('hidden');
  setTimeout(sendCallPath, 300);
  toast(`${S.friendNick} в друзьях — в следующий раз звони прямо из списка`);
}

/* ---------- Диагностика сети ---------- */
const VERDICT = {
  checking: ['wait', 'Проверяю сеть…'],
  'ok-confirmed': ['ok', 'Друг уже достучался до тебя напрямую — звонки работают в обе стороны'],
  'tailscale-confirmed': ['ok', 'Звонки работают через Tailscale'],
  'likely-ok': ['ok', 'Скорее всего, друзья смогут звонить тебе напрямую. Точно станет ясно, когда друг будет в сети'],
  'tailscale-only': ['warn', 'Напрямую до тебя не достучаться (серый IP), но есть Tailscale — через него работает'],
  cgnat: ['bad', 'У тебя серый IP (CGNAT): первым тебе не позвонить. Звонить другу ты сможешь, если у него с сетью всё в порядке. Иначе — Tailscale или коды'],
  'punch-likely': ['ok', 'Роутер подходит для прямых звонков без настройки (alloconnect пробивает NAT сам). Точно станет ясно, когда друг будет в сети'],
  symmetric: ['bad', 'Роутер или провайдер выдают «строгий» NAT — прямой звонок к тебе первым вряд ли пройдёт. Звонить другу можно, если у него сеть попроще. Иначе — Tailscale или коды'],
  'no-upnp': ['warn', 'Роутер не открыл порт сам (UPnP выключен или не поддерживается). Включи UPnP в роутере или пробрось UDP-порт вручную'],
};
const UPNP_TXT = { ok: 'порт открыт', 'no-router': 'роутер не ответил', 'no-service': 'роутер без нужной функции', 'map-failed': 'роутер отказал', checking: 'проверяю…', error: 'ошибка' };
function renderNet(n) {
  if (!n) return;
  const [cls, text] = VERDICT[n.verdict] || VERDICT.checking;
  for (const id of ['netVerdict', 'netVerdictLobby']) {
    const el = $(id);
    if (!el) continue;
    el.className = 'net-verdict ' + cls;
    el.textContent = text;
  }
  const ul = $('netDetails');
  ul.innerHTML = '';
  const kindTxt = { public: 'белый', private: 'серый (двойной NAT)', cgnat: 'серый (CGNAT)' };
  const stunTxt = { match: 'совпадает с роутером', mismatch: 'не совпадает (за роутером ещё NAT)', unavailable: 'недоступен', got: 'получен' };
  const rows = [
    ['UPnP', (UPNP_TXT[n.upnp] || n.upnp) + (n.upnpError && n.upnp !== 'ok' ? ` (${n.upnpError})` : '')],
    ['Внешний IP', kindTxt[n.externalKind] || (n.ifacePublic ? 'белый (прямо на компьютере)' : 'неизвестно')],
    ['Проверка через STUN', stunTxt[n.stun] || '—'],
    ['STUN-серверы', stunRowText(n)],
    ['Внешний адрес порта alloconnect', n.stunMapped == null ? 'проверяю…' : (n.stunMapped ? 'определён' : 'не определён')],
    ['Тип NAT', { cone: 'обычный — пробивка работает', symmetric: 'строгий — пробивка вряд ли сработает', unknown: 'неизвестно' }[n.natType] || '—'],
    ['Tailscale', n.tailscale ? 'есть' : 'нет'],
    ['Порт alloconnect (UDP)', String(n.upnpPort || n.port || '—')],
    ['Друг достучался до тебя', n.inboundConfirmed.length ? 'да, через ' + n.inboundConfirmed.join(', ') : 'ещё не проверено'],
    ['Ты достучался до друга', n.outboundConfirmed.length ? 'да, через ' + n.outboundConfirmed.join(', ') : 'ещё не проверено'],
  ];
  for (const [k, v] of rows) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = k + ': ';
    li.append(b, document.createTextNode(v));
    ul.appendChild(li);
  }
}
function stunRowText(n) {
  const plan = stunPlan();
  const mode = plan[0].name === 'off' ? 'выключен' : plan[0].name === 'custom' ? 'свои' : plan[0].name === 'alt' ? 'альтернативные (выбрано в настройках)' : 'основные, при сбое — альтернативные';
  const used = lastStun ? `; последний раз — ${STUN_NAME[lastStun.list]}${lastStun.first ? ', первым ответил ' + lastStun.first : ', никто не ответил'}` : '';
  const fr = n.friendsStun ? `; порт друзей — ${STUN_NAME[n.friendsStun.list] || n.friendsStun.list}${n.friendsStun.first ? ' (' + n.friendsStun.first + ')' : ''}` : '';
  return mode + used + fr;
}

async function stunCheck() {
  if (settings().noStun) { window.duo.netStun(null); return; }
  try {
    const res = await gatherWithFallback('net-check', (cfg) => { const pc = new RTCPeerConnection(cfg); pc.createDataChannel('x'); return pc; },
      async (pc) => { await pc.setLocalDescription(await pc.createOffer()); }, () => true);
    const ip = res?.r.srflxIp && res.r.srflxIp.includes('.') ? res.r.srflxIp : null;
    try { res?.pc.close(); } catch { /* */ }
    window.duo.netStun(ip);
  } catch { window.duo.netStun(null); }
}

// пояснение под кодом, если STUN не основной
function stunNote(list) {
  if (list === 'alt') return ' Внешний адрес — через альтернативные STUN (основные не ответили).';
  if (list === 'custom') return ' STUN: свои серверы из настроек.';
  return '';
}

/* =========================================================
   Буфер обмена: сам замечаем код друга и сам копируем свой
   ========================================================= */
const ownCodes = new Set();
let lastClip = '';

async function autoCopy(text, btn) {
  try {
    await window.duo.copy(text);
    if (btn) { const old = btn.textContent; btn.textContent = 'Скопировано ✓'; setTimeout(() => { btn.textContent = old; }, 2000); }
  } catch { /* остаётся ручная кнопка */ }
}

async function checkClipboard() {
  if (S.inCall || S.busy || S.friendCall || !$('lobby').classList.contains('active') || !$('dm').classList.contains('hidden')) return;
  let text;
  try { text = (await window.duo.paste()) || ''; } catch { return; }
  if (text === lastClip) return;
  lastClip = text;
  const m = /ALO([IA])\.[A-Za-z0-9_-]{200,}/.exec(text.replace(/\s+/g, ''));
  if (!m || ownCodes.has(m[0])) return;
  const code = m[0];
  const step = document.querySelector('.step.active')?.id;
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
   Подробная статистика раз в секунду (для лога)
   ========================================================= */
let statsLogTimer = null;
let prevStats = new Map();
let pairLogged = false;

function d(cur, key) {
  const p = prevStats.get(cur.id);
  if (!p || cur[key] == null || p[key] == null) return null;
  return cur[key] - p[key];
}
const r1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);

function startStatsLog() {
  stopStatsLog();
  prevStats = new Map();
  pairLogged = false;
  statsLogTimer = setInterval(collectStats, 1000);
}
function stopStatsLog() {
  clearInterval(statsLogTimer);
  statsLogTimer = null;
}

async function collectStats() {
  const pc = S.pc;
  const tx = S.tx;
  if (!pc || !tx) return;
  let report;
  try { report = await pc.getStats(); } catch { return; }
  if (S.pc !== pc) return; // звонок завершился, пока собирали
  const codecs = {};
  report.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
  const out = {};
  const videoTrackId = tx.video.receiver.track?.id;
  const screenAudioId = tx.saudio.receiver.track?.id;
  const voiceId = tx.mic.receiver.track?.id;

  report.forEach((r) => {
    const dt = d(r, 'timestamp') / 1000 || 1;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
      out.net = {
        rttMs: r1((r.currentRoundTripTime || 0) * 1000),
        availOutMbps: r1((r.availableOutgoingBitrate || 0) / 1e6),
        sendMbps: r1(((d(r, 'bytesSent') || 0) * 8) / dt / 1e6),
        recvMbps: r1(((d(r, 'bytesReceived') || 0) * 8) / dt / 1e6),
      };
      if (!pairLogged) {
        const l = report.get(r.localCandidateId), rm = report.get(r.remoteCandidateId);
        L('pair', { local: `${l?.candidateType}/${l?.protocol}/${l?.networkType || ''}`, remote: `${rm?.candidateType}/${rm?.protocol}`, relay: l?.candidateType === 'relay' || rm?.candidateType === 'relay' });
        pairLogged = true;
        S.callPath = { localIp: l?.address, localType: l?.candidateType, remoteIp: rm?.address, remoteType: rm?.candidateType };
        sendCallPath();
      }
    }
    if (r.type === 'media-source' && r.kind === 'video' && S.localScreen) {
      out.capture = { fps: r1(r.framesPerSecond), w: r.width, h: r.height };
    }
    if (r.type === 'outbound-rtp' && r.kind === 'video' && S.localScreen) {
      const frames = d(r, 'framesEncoded');
      const encTime = d(r, 'totalEncodeTime');
      const qld = r.qualityLimitationDurations || {};
      out.send = {
        codec: codecs[r.codecId], enc: r.encoderImplementation, hw: r.powerEfficientEncoder,
        res: `${r.frameWidth || 0}x${r.frameHeight || 0}`, fps: r1(r.framesPerSecond),
        mbps: r1(((d(r, 'bytesSent') || 0) * 8) / dt / 1e6), targetMbps: r1((r.targetBitrate || 0) / 1e6),
        encMsPerFrame: frames ? r1((encTime * 1000) / frames) : null,
        limit: r.qualityLimitationReason, limitChanges: r.qualityLimitationResolutionChanges,
        limitCpuSec: r1(qld.cpu), limitBwSec: r1(qld.bandwidth),
        nack: d(r, 'nackCount'), pli: d(r, 'pliCount'), fir: d(r, 'firCount'),
        retransKB: r1((d(r, 'retransmittedBytesSent') || 0) / 1024), hugeFrames: d(r, 'hugeFramesSent'),
        pacerDelayMs: d(r, 'packetsSent') ? r1(((d(r, 'totalPacketSendDelay') || 0) * 1000) / d(r, 'packetsSent')) : null,
      };
    }
    if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && S.localScreen) {
      out.sendRemote = { lossPct: r1((r.fractionLost || 0) * 100), jitterMs: r1((r.jitter || 0) * 1000), rttMs: r1((r.roundTripTime || 0) * 1000) };
    }
    if (r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === videoTrackId && !$('remoteScreenWrap').classList.contains('hidden')) {
      const dec = d(r, 'framesDecoded');
      const jbd = d(r, 'jitterBufferDelay'), jbe = d(r, 'jitterBufferEmittedCount');
      out.recv = {
        codec: codecs[r.codecId], dec: r.decoderImplementation, hw: r.powerEfficientDecoder,
        res: `${r.frameWidth || 0}x${r.frameHeight || 0}`, fps: r1(r.framesPerSecond),
        mbps: r1(((d(r, 'bytesReceived') || 0) * 8) / dt / 1e6),
        decoded: dec, dropped: d(r, 'framesDropped'), lost: d(r, 'packetsLost'),
        freezes: d(r, 'freezeCount'), freezeSec: r1(d(r, 'totalFreezesDuration')), pauses: d(r, 'pauseCount'),
        jitterMs: r1((r.jitter || 0) * 1000), bufferMs: jbe ? r1((jbd / jbe) * 1000) : null,
        decMsPerFrame: dec ? r1(((d(r, 'totalDecodeTime') || 0) * 1000) / dec) : null,
        nackSent: d(r, 'nackCount'), pliSent: d(r, 'pliCount'),
      };
    }
    if (r.type === 'inbound-rtp' && r.kind === 'audio' && (r.trackIdentifier === voiceId || r.trackIdentifier === screenAudioId)) {
      const key = r.trackIdentifier === voiceId ? 'voiceIn' : 'screenAudioIn';
      const samples = d(r, 'totalSamplesReceived');
      if (key === 'screenAudioIn' && $('remoteScreenWrap').classList.contains('hidden')) return;
      out[key] = {
        level: r1(r.audioLevel), lost: d(r, 'packetsLost'), jitterMs: r1((r.jitter || 0) * 1000),
        concealedPct: samples ? r1((100 * (d(r, 'concealedSamples') || 0)) / samples) : null,
      };
    }
  });
  report.forEach((r) => prevStats.set(r.id, r));
  L('stats', out);
}

async function logCapabilities() {
  try {
    const res = {};
    const codecs = [
      ['H264', 'video/H264;profile-level-id=42e01f;packetization-mode=1'],
      ['VP8', 'video/VP8'], ['VP9', 'video/VP9'], ['AV1', 'video/AV1'],
    ];
    for (const [name, ct] of codecs) {
      for (const [w, h, f] of [[1920, 1080, 60], [2560, 1440, 60]]) {
        try {
          const i = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: ct, width: w, height: h, bitrate: 8_000_000, framerate: f } });
          res[`${name}@${h}p${f}`] = i.supported ? (i.powerEfficient ? 'hw' : 'sw') : 'no';
        } catch (e) { res[`${name}@${h}p${f}`] = 'err'; }
      }
    }
    L('caps', { encode: res, sendCodecs: RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType + (c.sdpFmtpLine ? ' ' + c.sdpFmtpLine : '')).filter((x) => !/rtx|red|ulpfec|flexfec/.test(x)) });
  } catch (e) { L('error', 'caps: ' + e.message); }
}

/* =========================================================
   Разговор звонка: узнали ID собеседника → подтягиваем историю
   ========================================================= */
async function adoptCallConv(id) {
  const temp = S.callConv;
  if (!temp || temp.id) return;
  const conv = getConv(id, S.friendNick);
  await loadHistory(conv); // сначала история, потом новые сообщения звонка — без повторов
  if (S.callConv !== temp) return;
  adoptConv(temp, id, S.friendNick);
  S.callConv = conv;
  conv.unread = 0;
  mountConv(conv, $('messages'));
  renderFriends();
}

/* =========================================================
   Аватарки
   ========================================================= */
let myAvatar = null;        // { hash, url, mime, bytes }
const avCache = new Map();  // ID друга → { hash, url } | null

const bytesBlob = (b, mime) => new Blob([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)], { type: mime });

async function loadMyAvatar() {
  const a = await window.duo.avatarMine().catch(() => null);
  if (myAvatar?.url) URL.revokeObjectURL(myAvatar.url);
  myAvatar = a ? { hash: a.hash, mime: a.mime, bytes: a.bytes, url: URL.createObjectURL(bytesBlob(a.bytes, a.mime)) } : null;
}

async function friendAvatar(id) {
  if (!id) return null;
  if (avCache.has(id)) return avCache.get(id);
  const a = await window.duo.avatarGet(id).catch(() => null);
  const v = a ? { hash: a.hash, url: URL.createObjectURL(bytesBlob(a.bytes, a.mime)) } : null;
  avCache.set(id, v);
  return v;
}

function paintAvatar(el, url) {
  if (!el) return;
  el.style.backgroundImage = url ? `url("${url}")` : '';
  el.classList.toggle('has-img', !!url);
}

async function refreshAvatars() {
  paintAvatar(document.querySelector('#meCard .avatar'), myAvatar?.url);
  paintAvatar($('avatarPreview'), myAvatar?.url);
  const pid = S.peerIdent?.id;
  paintAvatar(document.querySelector('#friendCard .avatar'), pid && S.connected ? (await friendAvatar(pid))?.url : null);
  if (S.friendCall) paintAvatar($('callAvatar'), (await friendAvatar(S.friendCall.id))?.url);
  if (dmOpen) paintAvatar($('dmAvatar'), (await friendAvatar(dmOpen.id))?.url);
  for (const el of document.querySelectorAll('#friendsList .favatar')) paintAvatar(el, (await friendAvatar(el.dataset.id))?.url);
}

// собеседник сообщил хэш своей аватарки → скачиваем, если у нас другая
async function onPeerAvatarHash(id, av, want) {
  if (!id) return;
  const cur = await friendAvatar(id);
  if (!av) {
    if (cur) { await window.duo.avatarDrop(id).catch(() => {}); avCache.set(id, null); refreshAvatars(); }
    return;
  }
  if (!cur || cur.hash !== av) want();
}

async function onAvatarFile(id, blob, meta) {
  if (!id || !/^image\/(png|jpeg|webp|gif)$/.test(meta.mime)) return;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await window.duo.avatarSave(id, bytes, meta.mime);
    const old = avCache.get(id);
    if (old?.url) URL.revokeObjectURL(old.url);
    avCache.set(id, { hash, url: URL.createObjectURL(blob) });
    refreshAvatars();
  } catch (e) { L('avatar', { saveFailed: e.message }); }
}

function myAvatarFile() {
  return myAvatar ? new File([bytesBlob(myAvatar.bytes, myAvatar.mime)], 'avatar', { type: myAvatar.mime }) : null;
}

async function pickAvatar(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) { toast('Нужна картинка: png, jpg, webp или gif'); return; }
  let bytes, mime;
  try {
    if (file.type === 'image/gif') {
      if (file.size > 2 * 1024 * 1024) { toast('Гифка больше 2 МБ — выбери поменьше'); return; }
      bytes = new Uint8Array(await file.arrayBuffer());
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
      mime = 'image/webp';
    }
    const hash = await window.duo.avatarSetMine(bytes, mime);
    await loadMyAvatar();
    refreshAvatars();
    announceAvatar(hash);
    toast('Аватарка сохранена — друзья увидят её при следующей связи');
  } catch (e) { toast('Не получилось: ' + (e.message || e)); }
}

async function clearAvatar() {
  await window.duo.avatarClearMine();
  await loadMyAvatar();
  refreshAvatars();
  announceAvatar('');
}

function announceAvatar(hash) {
  if (S.connected) send({ t: 'av-hash', av: hash });
  for (const l of links.values()) { try { if (l.dc.readyState === 'open') l.dc.send(JSON.stringify({ t: 'ident', av: hash })); } catch { /* */ } }
}

/* =========================================================
   Чат с другом без звонка: текст — через канал друзей, файлы — прямым соединением
   ========================================================= */
let dmOpen = null;

async function openDm(id) {
  const f = friendsList.find((x) => x.id === id);
  if (!f) return;
  const conv = getConv(id, f.nick);
  dmOpen = conv;
  conv.unread = 0;
  $('dm').classList.remove('hidden');
  $('dmTitle').textContent = f.nick;
  updateDmHead();
  mountConv(conv, $('dmMessages'));
  paintAvatar($('dmAvatar'), (await friendAvatar(id))?.url);
  $('dmAvatar').querySelector('span').textContent = initial(f.nick);
  await loadHistory(conv);
  scrollEnd(conv, true);
  renderFriends();
  setTimeout(() => $('dmInput').focus(), 50);
}

function updateDmHead() {
  if (!dmOpen) return;
  const f = friendsList.find((x) => x.id === dmOpen.id);
  $('dmSub').textContent = f?.online ? 'в сети' : 'не в сети — сообщения дойдут, только когда он в сети';
  $('dmSub').classList.toggle('online', !!f?.online);
}

function closeDm() {
  dmOpen = null;
  $('dm').classList.add('hidden');
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
  const r = await window.duo.friendsSend(conv.id, { t: 'dm', mid, text, ts, nick: S.nick, re: reOut(re) });
  m.classList.remove('sending');
  if (!r.ok) { markUndelivered(m); recordStatus(conv, mid, 'fail'); }
}

async function onDmText(id, nick, msg) {
  const conv = getConv(id, nick);
  await loadHistory(conv);
  const text = String(msg.text || '').slice(0, 2000);
  const ts = Number(msg.ts) || Date.now();
  const mid = cleanMid(msg.mid) || newMid();
  const re = reIn(msg.re);
  chatMsg(conv, nick, text, false, ts, null, { mid, re });
  record(conv, { mid, ts, who: 'peer', nick, type: 'text', text, re: re || undefined });
  dmNotice(conv, text);
}

// новое сообщение не на виду → счётчик, звук, уведомление
function dmNotice(conv, text) {
  const visible = (dmOpen === conv && !$('dm').classList.contains('hidden')) || (S.inCall && S.callConv === conv);
  if (!visible) { conv.unread++; renderFriends(); toast(`💬 ${conv.nick}: ${String(text).slice(0, 60)}`); }
  if (!visible || !document.hasFocus()) {
    sound('msg');
    window.duo?.notify({ title: conv.nick, body: String(text).slice(0, 200), kind: 'msg' });
    if (!document.hasFocus()) window.duo?.attention();
  }
}

/* ---------- Прямое соединение только для файлов (поднимается по требованию) ---------- */
const links = new Map(); // ID друга → { lid, role, pc, dc, chan, open }

function makeLink(id, lid, role, cfg = rtcConfig()) {
  const l = { lid, role };
  const pc = new RTCPeerConnection(cfg);
  const dc = pc.createDataChannel('duo', { negotiated: true, id: 0, ordered: true });
  const fdc = pc.createDataChannel('files', { negotiated: true, id: 1, ordered: true });
  l.pc = pc;
  l.dc = dc;
  l.chan = new FileChan(fdc, () => getConv(id), {
    avatar: (b, m) => onAvatarFile(id, b, m),
    chatIn: (conv, meta) => dmNotice(conv, `${FICON[meta.kind] || '📄'} ${meta.name}`),
    update: (b, m) => onUpdateFile(id, b, m),
  });
  l.open = new Promise((res, rej) => { l.res = res; l.rej = rej; });
  l.open.catch(() => {});
  fdc.addEventListener('open', () => l.res());
  dc.onopen = () => { try { dc.send(JSON.stringify({ t: 'ident', av: myAvatar?.hash || '' })); } catch { /* */ } };
  dc.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.t === 'ident') onPeerAvatarHash(id, d.av, () => { try { dc.send(JSON.stringify({ t: 'av-want' })); } catch { /* */ } });
    else if (d.t === 'av-want') { const f = myAvatarFile(); if (f) l.chan.queue([f], 'avatar'); }
    else if (d.t === 'upd-req') onUpdReq(id, l, d);
    else if (d.t === 'upd-go') onUpdGo(id, l);
    else if (d.t === 'upd-manifest') onUpdManifest(id, d);
    else if (d.t === 'upd-none') { if (upd.pull && upd.pull.id === id) finishUpdPull('друг не может отдать обновление'); }
  };
  pc.addEventListener('connectionstatechange', () => {
    L('link', { state: pc.connectionState, role });
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropLink(id, l, 'связь прервалась');
  });
  // без передач 3 минуты — закрываем
  l.idle = setInterval(() => { if (!l.chan.busy() && Date.now() - l.chan.lastActive > 180000) dropLink(id, l, 'закрыто'); }, 15000);
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

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

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
  const r = await window.duo.friendsSend(id, { t: 'link-offer', lid: l.lid, sdp: minifySdp(l.pc.localDescription.sdp) });
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
    const r = await window.duo.friendsSend(id, { t: 'link-answer', lid: l.lid, sdp: minifySdp(l.pc.localDescription.sdp) });
    if (!r.ok) dropLink(id, l, 'друг не ответил');
  } catch (e) { L('link', { answerFailed: e.message }); if (l) dropLink(id, l, 'ошибка'); }
}

async function onLinkAnswer(id, msg) {
  const l = links.get(id);
  if (!l || l.lid !== msg.lid || l.pc.signalingState !== 'have-local-offer') return;
  try { await l.pc.setRemoteDescription({ type: 'answer', sdp: String(msg.sdp || '') }); } catch (e) { L('link', { applyFailed: e.message }); dropLink(id, l, 'ошибка'); }
}

async function dmSendFiles(list) {
  const conv = dmOpen;
  if (!conv || !list.length) return;
  if (S.connected && S.callConv?.id === conv.id) { queueFiles(list); return; }
  const f = friendsList.find((x) => x.id === conv.id);
  if (!f?.online) { toast(`${conv.nick} не в сети — файл можно отправить, когда он в сети`); return; }
  toast('Соединяюсь с ' + conv.nick + '…');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const l = await getLink(conv.id);
      await withTimeout(l.open, 25000, 'не удалось соединиться напрямую');
      l.chan.queue(list);
      return;
    } catch (e) {
      if (attempt === 1 || !links.get(conv.id)) { toast('Файл не отправлен: ' + e.message); return; }
    }
  }
}

/* =========================================================
   Саундпад: поделиться звуком с другом
   ========================================================= */
const SOUND_MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
async function spShare(id) {
  const s = spList.find((x) => x.id === id);
  if (!s) return;
  if (!S.connected || !S.fileChan) { toast('Поделиться звуком можно в звонке'); return; }
  const bytes = await window.duo.soundsRead(id);
  const ext = (/\.(\w+)$/.exec(s.file || '') || [, 'mp3'])[1].toLowerCase();
  queueFiles([new File([bytesBlob(bytes, SOUND_MIME[ext] || 'audio/mpeg')], `${s.name}.${ext}`, { type: SOUND_MIME[ext] || 'audio/mpeg' })], 'sound');
  toast(`«${s.name}» отправлен ${S.friendNick} — он сможет добавить его в свой саундпад`);
}

/* =========================================================
   Автопереподключение: связь пропала → перезапуск ICE через канал друзей
   ========================================================= */
const RECONNECT_FOR = 75000;

function canSignal() { return !!(S.peerIdent && isFriend(S.peerIdent.id)); }

function startReconnect(why, peerLed) {
  if (!S.connected || S.reconnecting || !S.pc) return;
  const pc = S.pc;
  // перезапуск начинает тот, кто приглашал (сразу); второй ждёт 20 с и подстраховывает; повтор — раз в 10 с
  // если перезапуск уже начал друг — отвечаем на его запрос, свой шлём только если он пропадёт на 20 с
  S.reconnecting = { t0: Date.now(), pc, applied: false, attempts: 0, nextAt: S.role === 'host' && !peerLed ? 0 : 20000 };
  L('reconnect', { start: why, canSignal: canSignal(), role: S.role });
  setStatus('waiting', 'Переподключение…');
  $('call').classList.add('reconnecting');
  sysMsg(canSignal() ? 'Связь прервалась — переподключаюсь…' : 'Связь прервалась — жду, вдруг вернётся…');
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
    sysMsg('Связь восстановлена');
    sound('join');
    pairLogged = false; // новый путь — запишем в лог
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
    const r = await window.duo.friendsSend(id, { t: 'rtc-restart', sdp });
    L('reconnect', { offerSent: r.ok, error: r.ok ? undefined : r.error });
  } catch (e) { L('reconnect', { offerFailed: e.message }); }
}

async function onRtcRestart(id, msg) {
  const pc = S.pc;
  if (!pc || !S.connected || S.peerIdent?.id !== id || !/^v=0/.test(String(msg.sdp || ''))) return;
  try {
    if (!S.reconnecting) startReconnect('peer', true);
    if (pc.signalingState === 'have-local-offer') {
      // оба начали одновременно: уступает тот, кто отвечал на приглашение
      if (S.role === 'host') return;
      await pc.setLocalDescription({ type: 'rollback' });
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    const ans = await pc.createAnswer();
    const g = gatherCandidates(pc, { stunCount: stunCountOf(pc) });
    await pc.setLocalDescription({ type: 'answer', sdp: opusStereo(ans.sdp) });
    await g;
    if (S.pc !== pc) return;
    if (S.reconnecting) S.reconnecting.applied = true;
    const r = await window.duo.friendsSend(id, { t: 'rtc-restart-ans', sdp: bitrateHints(opusStereo(minifySdp(pc.localDescription.sdp))) });
    L('reconnect', { answerSent: r.ok });
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
   Приглушение: пока говорит друг (или ты) — другие программы и стрим друга тише
   ========================================================= */
const duck = { friendUntil: 0, meUntil: 0, level: 1, timer: null };
const DUCK_ON = 0.015;   // порог «говорит»
const DUCK_HOLD = 450;   // сколько держать после последнего звука, мс

function duckFeed(kind, lvl) { if (lvl > DUCK_ON) duck[kind + 'Until'] = Date.now() + DUCK_HOLD; }
function startDuck() { clearInterval(duck.timer); duck.timer = setInterval(duckTick, 80); }
function stopDuck() {
  clearInterval(duck.timer);
  duck.timer = null;
  duck.level = 1;
  duck.friendUntil = duck.meUntil = 0;
  window.duo?.duckStop();
  const v = $('remoteScreen');
  v.volume = Number($('screenVol').value) / 100;
}
function duckTick() {
  const o = settings();
  const now = Date.now();
  const friendTalk = now < duck.friendUntil && !S.deafened;
  const meTalk = now < duck.meUntil && !S.muted && !S.deafened;
  const active = S.connected && o.duckOn && ((o.duckOthers && friendTalk) || (o.duckMe && meTalk));
  const level = active ? Math.max(0, 1 - (Number(o.duckAmount) || 0) / 100) : 1;
  if (level !== duck.level) { duck.level = level; window.duo.duckSet(level); }
  // звук стрима друга внутри alloconnect — плавно
  const v = $('remoteScreen');
  const want = (Number($('screenVol').value) / 100) * (o.duckStream && active ? level : 1);
  if (Math.abs(v.volume - want) > 0.01) v.volume = Math.max(0, Math.min(1, v.volume + (want - v.volume) * (want < v.volume ? 0.6 : 0.25)));
  else v.volume = want;
}

/* =========================================================
   Поверх стрима: указка, рисование, реакции, картинки на экран друга
   ========================================================= */
const REACTIONS = ['😂', '🔥', '👍', '❤️', '😮', '👏', '💀', '🤡'];
const COLORS = ['#ff3c50', '#ffd23c', '#3ddc84', '#3cc8ff', '#ffffff'];
const tools = { mode: null, color: COLORS[0], stroke: null, flushT: null, ptrLast: 0, local: new Map(), raf: 0, myPtr: null };

function myPerm() {
  const o = settings();
  return { draw: o.ovlDraw !== false, react: !!o.ovlReact, ctl: o.ctlAllow !== false };
}
function sendPerm() { send({ t: 'perm', ...myPerm(), vid: 1, ops: 1 }); }

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
const n4 = (x) => Math.round(x * 10000) / 10000;

function setTool(mode) {
  if (CV.state === 'on') return;
  tools.mode = tools.mode === mode ? null : mode;
  if (tools.mode !== 'ptr') { send({ t: 'ptr-off' }); tools.myPtr = null; }
  updateToolbar();
}

function updateToolbar() {
  const fp = S.friendPerm || { draw: true, react: false, ctl: true };
  const controlling = CV.state === 'on';
  const set = (id, on, disabled, title) => { const b = $(id); if (!b) return; b.classList.toggle('on', !!on); b.disabled = !!disabled; if (title != null) b.title = title; };
  set('toolPtr', tools.mode === 'ptr', !fp.draw || controlling, fp.draw ? 'Указка — друг видит точку поверх своего экрана' : 'Друг не разрешил указку и рисование');
  set('toolDraw', tools.mode === 'draw', !fp.draw || controlling, fp.draw ? 'Рисовать поверх экрана друга' : 'Друг не разрешил указку и рисование');
  set('toolClear', false, !fp.draw);
  $('toolColor').style.background = tools.color;
  for (const b of document.querySelectorAll('#reactBar button')) { b.disabled = !fp.react; b.title = fp.react ? '' : 'Друг не включил реакции в настройках'; }
  set('toolImg', false, !fp.react, fp.react ? 'Показать картинку или гифку поверх экрана друга' : 'Друг не включил картинки в настройках');
  const cb = $('toolCtl');
  cb.classList.toggle('on', controlling);
  cb.textContent = controlling ? '⛔ Отдать управление' : CV.state === 'req' ? '⏳ Ждём ответа…' : '🎮 Управление';
  cb.disabled = fp.ctl === false && !controlling;
  cb.title = fp.ctl === false ? 'Друг выключил запросы на управление' : 'Попросить управление мышью, клавиатурой и геймпадом';
  $('toolLock').classList.toggle('hidden', !(controlling && CV.perm.mouse));
  $('inputLayer').classList.toggle('active', !!tools.mode || controlling);
  $('remoteScreenWrap').classList.toggle('ctl-active', controlling);
  $('inputLayer').dataset.mode = controlling ? 'ctl' : (tools.mode || '');
}

/* ---------- Локальный слой у зрителя (оверлей друга исключён из захвата, рисуем у себя) ---------- */
function drawLocal() {
  tools.raf = 0;
  const c = $('drawLayer');
  const wrap = $('remoteScreenWrap');
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(wrap.clientWidth * dpr) || c.height !== Math.round(wrap.clientHeight * dpr)) {
    c.width = Math.round(wrap.clientWidth * dpr); c.height = Math.round(wrap.clientHeight * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  const wr = wrap.getBoundingClientRect();
  const r = videoRect();
  const X = (x) => r.x - wr.left + x * r.w, Y = (y) => r.y - wr.top + y * r.h;
  const now = Date.now();
  let alive = false;
  for (const [id, s] of tools.local) {
    const age = s.done ? now - s.ts : 0;
    const a = age < 2500 ? 1 : 1 - (age - 2500) / 1500;
    if (a <= 0) { tools.local.delete(id); continue; }
    alive = true;
    g.globalAlpha = a; g.strokeStyle = s.c; g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
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
  const pts = st.pending.splice(0);
  if (pts.length || done) send({ t: 'draw', id: st.id, c: st.c, pts, done: !!done });
  if (done) tools.stroke = null;
}

function floatReaction(e, host) {
  const el = document.createElement('div');
  el.className = 'react-float';
  el.textContent = e;
  el.style.left = (10 + Math.random() * 80) + '%';
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

let reactLast = [];
function sendReaction(e) {
  if (!(S.friendPerm?.react)) return;
  const now = Date.now();
  reactLast = reactLast.filter((t) => now - t < 2000);
  if (reactLast.length >= 6) return; // не больше 6 за 2 секунды
  reactLast.push(now);
  send({ t: 'react', e });
  floatReaction(e, $('remoteScreenWrap'));
}

/* ---------- Картинка или видео на экран друга: место и размер прямо поверх стрима ---------- */
const IMG_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const VID_TYPES = /^video\/(mp4|webm|quicktime|x-matroska|ogg)$/;
const SVID_MAX = 100 * 1024 * 1024;   // видео: до 100 МБ
const SVID_SEC = 60;                  // и до 1 минуты
let placer = null; // { file, url, x, y, w, aspect, el, vid: { dur, snd, vol } | null }
let svidOut = null; // видео, которое сейчас уходит другу: { url, aspect, pl, vol, snd, status, ... }

// место (центр, доли экрана) и ширина (доля ширины экрана)
function cleanPlacement(pl) {
  if (!pl || typeof pl !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = n(pl.x), y = n(pl.y), w = n(pl.w);
  if (x == null || y == null || w == null) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), w: Math.max(0.03, Math.min(0.95, w)) };
}

function screenImageOk(file) {
  if (!file) return false;
  if (!S.friendPerm?.react) { toast(`${S.friendNick} не включил картинки на экран в настройках`); return false; }
  if (!IMG_TYPES.test(file.type)) { toast('Нужна картинка, гифка или видео (png, jpg, gif, webp, mp4, webm)'); return false; }
  if (file.size > 8 * 1024 * 1024) { toast('Картинка больше 8 МБ — выбери поменьше'); return false; }
  return true;
}

// видео: проверяем разрешение, размер, длительность и что оно вообще играется
function probeVideo(file) {
  return new Promise((resolve) => {
    if (!S.friendPerm?.react) { toast(`${S.friendNick} не включил картинки и видео на экран в настройках`); resolve(null); return; }
    if (!S.friendPerm?.vid) { toast(`У ${S.friendNick} старая версия alloconnect — видео на экран появится, когда он обновится`); resolve(null); return; }
    if (svidOut && !svidOut.echo) { toast('Подожди — предыдущее видео ещё отправляется'); resolve(null); return; }
    if (file.size > SVID_MAX) { toast(`Видео ${(file.size / 1048576).toFixed(0)} МБ — можно до 100 МБ`); resolve(null); return; }
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = (res, msg) => { clearTimeout(t); v.removeAttribute('src'); v.load(); if (msg) toast(msg); if (!res) URL.revokeObjectURL(url); resolve(res); };
    const t = setTimeout(() => done(null, 'Не получилось открыть видео'), 8000);
    v.onloadedmetadata = () => {
      const dur = v.duration;
      if (!v.videoWidth || !v.videoHeight) { done(null, 'В файле нет видео, которое можно показать'); return; }
      if (!Number.isFinite(dur) || dur > SVID_SEC + 0.5) { done(null, Number.isFinite(dur) ? `Видео ${Math.round(dur)} с — можно до 1 минуты` : 'Не понял длину видео — нужно до 1 минуты'); return; }
      done({ url, dur, aspect: v.videoHeight / v.videoWidth });
    };
    v.onerror = () => done(null, 'Этот формат видео не поддерживается — лучше mp4 (H.264) или webm');
    v.src = url;
  });
}

// at — точка на стриме (доли), куда бросили файл; без неё — сверху по центру
function startPlacement(file, at) {
  if (!file || $('remoteScreenWrap').classList.contains('hidden')) return;
  if (VID_TYPES.test(file.type || '') || (!file.type && /\.(mp4|webm|mov|mkv)$/i.test(file.name || ''))) {
    probeVideo(file).then((info) => { if (info && !$('remoteScreenWrap').classList.contains('hidden')) openPlacer(file, at, info); else if (info) URL.revokeObjectURL(info.url); });
    return;
  }
  if (!screenImageOk(file)) return;
  openPlacer(file, at, null);
}

function openPlacer(file, at, vinfo) {
  cancelPlacement();
  const url = vinfo ? vinfo.url : URL.createObjectURL(file);
  const o = settings();
  const el = document.createElement('div');
  el.className = vinfo ? 'placer has-vid' : 'placer';
  const media = vinfo ? '<video loop playsinline></video>' : '<img draggable="false" alt="">';
  const vidCtl = vinfo
    ? `<span class="placer-sep"></span><label class="placer-snd" title="Будет ли у друга звук"><input type="checkbox" class="placer-sound"> 🔊</label><input type="range" class="placer-vol" min="0" max="100" step="5" title="Громкость у друга"><b class="placer-volval small"></b><span class="placer-dur small muted">${Math.round(vinfo.dur)} с</span>`
    : '';
  el.innerHTML = `<div class="placer-box">${media}<i class="placer-handle" title="Тяни — размер"></i></div>` +
    `<div class="placer-bar"><span class="placer-hint">Двигай мышью · размер — уголок или колёсико</span><span>Размер</span><input type="range" class="placer-size" min="5" max="90" step="1">${vidCtl}<button class="btn small primary placer-send" title="Enter">Отправить</button><button class="btn small placer-cancel" title="Отмена (Esc)">✕</button></div>`;
  placer = { file, url, x: at ? at[0] : 0.5, y: at ? at[1] : 0.35, w: vinfo ? 0.35 : 0.3, aspect: vinfo ? vinfo.aspect : 1, el,
    vid: vinfo ? { dur: vinfo.dur, snd: o.svidSound !== false, vol: Math.max(0, Math.min(100, Number(o.svidVol ?? 70))) } : null };
  if (vinfo) {
    const v = el.querySelector('video');
    v.src = url;
    setSink(v);
    applyPreviewVol();
    v.play().catch(() => {});
  } else {
    const img = el.querySelector('img');
    img.src = url;
    img.onload = () => { if (placer?.el === el) { placer.aspect = img.naturalHeight / Math.max(1, img.naturalWidth); layoutPlacer(); } };
  }
  $('remoteScreenWrap').appendChild(el);
  bindPlacer(el);
  layoutPlacer();
}

// предпросмотр у себя звучит так, как будет у друга (если звук включён)
function applyPreviewVol() {
  if (!placer?.vid) return;
  const v = placer.el.querySelector('video');
  const { snd, vol } = placer.vid;
  v.muted = !snd || vol === 0 || S.deafened;
  v.volume = vol / 100;
  placer.el.querySelector('.placer-sound').checked = snd;
  const r = placer.el.querySelector('.placer-vol');
  r.value = String(vol);
  r.disabled = !snd;
  placer.el.querySelector('.placer-volval').textContent = snd ? vol + '%' : 'без звука';
}

async function setSink(el) {
  try { const out = settings().out; if (out && el.setSinkId) await el.setSinkId(out); } catch { /* */ }
}

function layoutPlacer() {
  if (!placer) return;
  const r = videoRect();
  const wr = $('remoteScreenWrap').getBoundingClientRect();
  let wpx = placer.w * r.w;
  let hpx = wpx * placer.aspect;
  if (hpx > 0.9 * r.h) { hpx = 0.9 * r.h; wpx = hpx / placer.aspect; placer.w = wpx / r.w; }
  // картинка целиком на экране друга
  const hx = wpx / 2 / r.w, hy = hpx / 2 / r.h;
  placer.x = Math.max(hx, Math.min(1 - hx, placer.x));
  placer.y = Math.max(hy, Math.min(1 - hy, placer.y));
  const box = placer.el.querySelector('.placer-box');
  box.style.left = (r.x - wr.left + placer.x * r.w - wpx / 2) + 'px';
  box.style.top = (r.y - wr.top + placer.y * r.h - hpx / 2) + 'px';
  box.style.width = wpx + 'px';
  box.style.height = hpx + 'px';
  placer.el.querySelector('.placer-size').value = String(Math.round(placer.w * 100));
}

function bindPlacer(el) {
  const box = el.querySelector('.placer-box');
  const handle = el.querySelector('.placer-handle');
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    box.setPointerCapture(e.pointerId);
    drag = { mode: e.target === handle ? 'size' : 'move', sx: e.clientX, sy: e.clientY, x: placer.x, y: placer.y };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || !placer) return;
    const r = videoRect();
    if (drag.mode === 'move') {
      placer.x = drag.x + (e.clientX - drag.sx) / r.w;
      placer.y = drag.y + (e.clientY - drag.sy) / r.h;
    } else {
      // уголок: центр на месте, ширина — по расстоянию до курсора
      const cx = r.x + placer.x * r.w;
      placer.w = Math.max(0.05, Math.min(0.9, (2 * Math.abs(e.clientX - cx)) / r.w));
    }
    layoutPlacer();
  });
  box.addEventListener('pointerup', () => { drag = null; });
  box.addEventListener('dblclick', (e) => { e.stopPropagation(); commitPlacement(); });
  el.addEventListener('wheel', (e) => {
    if (e.target.closest('.placer-bar')) return;
    e.preventDefault();
    e.stopPropagation();
    placer.w = Math.max(0.05, Math.min(0.9, placer.w * (e.deltaY < 0 ? 1.1 : 0.9)));
    layoutPlacer();
  }, { passive: false });
  el.querySelector('.placer-size').addEventListener('input', (e) => { placer.w = Number(e.target.value) / 100; layoutPlacer(); });
  if (placer.vid) {
    el.querySelector('.placer-sound').addEventListener('change', (e) => { placer.vid.snd = e.target.checked; applyPreviewVol(); });
    el.querySelector('.placer-vol').addEventListener('input', (e) => { placer.vid.vol = Number(e.target.value); applyPreviewVol(); });
  }
  el.querySelector('.placer-send').onclick = commitPlacement;
  el.querySelector('.placer-cancel').onclick = cancelPlacement;
  el.addEventListener('mousedown', (e) => e.stopPropagation());
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
  const wr = $('remoteScreenWrap').getBoundingClientRect();
  let wpx = pl.w * r.w;
  let hpx = wpx * aspect;
  if (hpx > 0.9 * r.h) { hpx = 0.9 * r.h; wpx = hpx / aspect; }
  Object.assign(box.style, { left: (r.x - wr.left + pl.x * r.w - wpx / 2) + 'px', top: (r.y - wr.top + pl.y * r.h - hpx / 2) + 'px', width: wpx + 'px', height: hpx + 'px' });
}

function commitPlacement() {
  if (!placer) return;
  const p = placer;
  const pl = { x: n4(p.x), y: n4(p.y), w: n4(p.w) };
  const pv = p.el.querySelector('video');
  if (pv) { pv.pause(); pv.removeAttribute('src'); pv.load(); }
  placer.el.remove();
  placer = null;
  if (!S.friendPerm?.react) { URL.revokeObjectURL(p.url); toast(`${S.friendNick} выключил картинки на экран`); return; }
  if (p.vid) { sendScreenVideo(p, pl); return; }
  queueFiles([p.file], 'screenimg', { pl });
  L('screenimg', { sent: true, w: pl.w });
  const box = document.createElement('div');
  box.className = 'screenimg-echo placed';
  const im = document.createElement('img');
  im.src = p.url;
  box.appendChild(im);
  $('remoteScreenWrap').appendChild(box);
  placeEcho(box, pl, p.aspect);
  setTimeout(() => { box.remove(); URL.revokeObjectURL(p.url); }, 6500);
}

/* ---------- Видео: отправка, полоска прогресса, показ у себя, когда у друга началось ---------- */
function sendScreenVideo(p, pl) {
  const vol = p.vid.vol / 100;
  const snd = p.vid.snd && p.vid.vol > 0;
  store.set('settings', { ...settings(), svidVol: p.vid.vol, svidSound: p.vid.snd });
  const status = document.createElement('div');
  status.className = 'svid-status';
  status.textContent = '🎬 Видео → ' + S.friendNick + ': 0%';
  $('remoteScreenWrap').appendChild(status);
  const size = p.file.size;
  svidOut = { url: p.url, aspect: p.aspect, pl, vol, snd, dur: p.vid.dur, status, echo: null, sentAt: 0 };
  const my = svidOut;
  const ui = {
    progress: (n) => { if (svidOut === my) status.textContent = `🎬 Видео → ${S.friendNick}: ${Math.floor((100 * n) / Math.max(1, size))}%`; },
    done: () => {
      if (svidOut !== my) return;
      my.sentAt = Date.now();
      status.textContent = `🎬 Видео у ${S.friendNick}, запускается…`;
      // друг не ответил (старое окно, выключил оверлей) — не висим вечно
      setTimeout(() => { if (svidOut === my && !my.echo) { status.remove(); URL.revokeObjectURL(my.url); svidOut = null; } }, 15000);
    },
    fail: (msg) => { if (svidOut !== my) return; status.remove(); URL.revokeObjectURL(my.url); svidOut = null; toast('Видео не отправилось: ' + msg); },
  };
  queueFiles([p.file], 'screenvid', { pl, vol: Math.round(vol * 100) / 100, snd, ui });
  if (!S.fileChan) ui.fail('нет связи');
  L('screenvid', { sent: true, w: pl.w, mb: Math.round(size / 1048576), sec: Math.round(p.vid.dur), snd });
}

function startVideoEcho() {
  const my = svidOut;
  if (!my || my.echo) return;
  my.status.remove();
  const box = document.createElement('div');
  box.className = 'screenimg-echo placed svid-echo';
  const v = document.createElement('video');
  v.src = my.url;
  v.playsInline = true;
  v.volume = my.vol;
  v.muted = !my.snd || S.deafened;
  setSink(v);
  box.appendChild(v);
  $('remoteScreenWrap').appendChild(box);
  placeEcho(box, my.pl, my.aspect);
  my.echo = box;
  const end = () => { if (!box.isConnected) return; v.pause(); box.remove(); URL.revokeObjectURL(my.url); if (svidOut === my) svidOut = null; };
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

function sendScreenImage(file) { startPlacement(file); }

/* ---------- У того, кто стримит: события от друга → оверлей ---------- */
let reactIn = [];
let imgInLast = 0;
function ovlAllowed(kind) { return !!S.localScreen && myPerm()[kind]; }

function onOverlayData(d) {
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  switch (d.t) {
    case 'draw':
      if (!ovlAllowed('draw') || !Array.isArray(d.pts)) return;
      window.duo.ovlMsg({ t: 'stroke', id: String(d.id).slice(0, 20), c: /^#[0-9a-f]{6}$/i.test(d.c) ? d.c : '#ff3c50', w: 5, pts: d.pts.slice(0, 300).map((p) => [clamp(p[0]), clamp(p[1])]), done: !!d.done });
      return;
    case 'ptr':
      if (ovlAllowed('draw')) window.duo.ovlMsg({ t: 'ptr', x: clamp(d.x), y: clamp(d.y), nick: S.friendNick });
      return;
    case 'ptr-off':
      if (S.localScreen) window.duo.ovlMsg({ t: 'ptr-off' });
      return;
    case 'draw-clear':
      if (S.localScreen) window.duo.ovlMsg({ t: 'clear' });
      return;
    case 'react': {
      if (!ovlAllowed('react') || !REACTIONS.includes(d.e)) return;
      const now = Date.now();
      reactIn = reactIn.filter((t) => now - t < 2000);
      if (reactIn.length >= 8) return;
      reactIn.push(now);
      window.duo.ovlMsg({ t: 'react', e: d.e });
      floatReaction(d.e, $('localScreenWrap'));
      return;
    }
    default:
  }
}

// видео от друга → поверх моего экрана; громкость: его выбор × моя настройка
let vidInLast = 0;
async function onScreenVideo(blob, meta) {
  if (!S.localScreen) { send({ t: 'svid-no', why: 'busy' }); return; }
  if (!myPerm().react) { send({ t: 'svid-no', why: 'off' }); return; }
  if (!/^video\//.test(meta.mime) || blob.size > SVID_MAX) { send({ t: 'svid-no', why: 'fmt' }); return; }
  if (Date.now() - vidInLast < 3000) return;
  vidInLast = Date.now();
  const o = settings();
  const mine = o.svidInSound !== false ? Math.max(0, Math.min(100, Number(o.svidInVol ?? 80))) / 100 : 0;
  const vol = meta.snd && !S.deafened ? Math.round(meta.vol * mine * 100) / 100 : 0;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  window.duo.ovlMsg({ t: 'vid', bytes, mime: meta.mime, nick: S.friendNick, pl: meta.pl || null, vol, sink: o.out || '' });
  send({ t: 'svid-play' });
  L('screenvid', { received: true, mb: Math.round(blob.size / 1048576), vol });
}

async function onScreenImage(blob, meta) {
  if (!ovlAllowed('react') || !/^image\/(png|jpeg|gif|webp)$/.test(meta.mime)) return;
  if (Date.now() - imgInLast < 3000) return;
  imgInLast = Date.now();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  window.duo.ovlMsg({ t: 'img', bytes, mime: meta.mime, nick: S.friendNick, pl: meta.pl || null });
}

/* =========================================================
   Удалённое управление
   Зритель (CV) шлёт мышь/клавиши/геймпад; стримящий (CS) разрешает и передаёт в Windows.
   ========================================================= */
const CV = { state: 'off', perm: {}, keys: new Set(), padTimer: null, hbTimer: null, reqTimer: null, lastPad: '', lastPadSent: 0, hadPad: false, padObj: null, moveQ: null, rel: [0, 0], raf: 0, rumble: { l: 0, s: 0, iv: null } };
const CS = { on: false, perm: null, lastMsg: 0, released: true, wd: null, reqTimer: null, req: null };

function ctlSend(a, fast) {
  const ch = fast ? S.cdu : S.cdc;
  try { if (ch?.readyState === 'open') ch.send(JSON.stringify(a)); } catch { /* */ }
}

/* ---------- Зритель ---------- */
function ctlRequest() {
  if (!S.connected || $('remoteScreenWrap').classList.contains('hidden')) return;
  if (CV.state === 'on') { ctlViewStop(true); toast('Управление отдано'); return; }
  if (CV.state === 'req') return;
  CV.state = 'req';
  tools.mode = null;
  send({ t: 'ctl-req', mouse: true, kb: true, pad: true });
  updateToolbar();
  toast(`Запрос отправлен — ${S.friendNick} должен нажать «Разрешить»`);
  clearTimeout(CV.reqTimer);
  CV.reqTimer = setTimeout(() => { if (CV.state === 'req') { CV.state = 'off'; updateToolbar(); toast(`${S.friendNick} не ответил на запрос`); } }, 35000);
}

function ctlViewStart(perm) {
  clearTimeout(CV.reqTimer);
  CV.state = 'on';
  CV.perm = { mouse: !!perm.mouse, kb: !!perm.kb, pad: !!perm.pad };
  tools.mode = null;
  send({ t: 'ptr-off' });
  const what = [CV.perm.mouse && 'мышь', CV.perm.kb && 'клавиатура', CV.perm.pad && 'геймпад'].filter(Boolean).join(', ');
  toast(`Управление разрешено: ${what}. Кликни по экрану друга`);
  sysMsg(`Ты управляешь компьютером ${S.friendNick} (${what})`);
  L('control', { view: 'start', perm: CV.perm });
  CV.hbTimer = setInterval(() => ctlSend(['hb']), 1000);
  if (CV.perm.pad) { CV.hadPad = false; CV.padTimer = setInterval(padPoll, 8); }
  if (document.fullscreenElement && navigator.keyboard?.lock) navigator.keyboard.lock().catch(() => {});
  updateToolbar();
}

function ctlViewStop(notify, why) {
  if (CV.state === 'off') return;
  const was = CV.state;
  for (const code of CV.keys) ctlSend(['k', code, 0]);
  CV.keys.clear();
  if (CV.hadPad) ctlSend(['p', 0, 0, 0, 0, 0, 0, 0]);
  if (notify && was === 'on') send({ t: 'ctl-stop' });
  CV.state = 'off';
  clearInterval(CV.hbTimer); clearInterval(CV.padTimer); clearTimeout(CV.reqTimer);
  CV.hbTimer = CV.padTimer = null;
  if (document.pointerLockElement) document.exitPointerLock();
  try { navigator.keyboard?.unlock(); } catch { /* */ }
  setRumble(0, 0);
  if (was === 'on') { sysMsg(why ? `Управление закончено: ${why}` : 'Управление закончено'); L('control', { view: 'stop', why }); }
  updateToolbar();
}

const MOUSE_BTN = { 0: 0, 2: 1, 1: 2, 3: 3, 4: 4 };
function flushMove() {
  CV.raf = 0;
  if (CV.state !== 'on') return;
  if (CV.rel[0] || CV.rel[1]) { ctlSend(['r', Math.round(CV.rel[0]), Math.round(CV.rel[1])], true); CV.rel = [0, 0]; }
  if (CV.moveQ) { ctlSend(['m', n4(CV.moveQ[0]), n4(CV.moveQ[1])], true); CV.moveQ = null; }
}
function queueMoveFlush() { if (!CV.raf) CV.raf = requestAnimationFrame(flushMove); }

function padPoll() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  const p = pads.find((x) => x.mapping === 'standard' && x.connected) || pads.find((x) => x.connected);
  CV.padObj = p || null;
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

function setRumble(l, s) {
  CV.rumble.l = l; CV.rumble.s = s;
  clearInterval(CV.rumble.iv);
  CV.rumble.iv = null;
  const act = CV.padObj?.vibrationActuator;
  if (!act) return;
  if (!l && !s) { act.reset?.().catch?.(() => {}); return; }
  const play = () => act.playEffect?.('dual-rumble', { startDelay: 0, duration: 300, strongMagnitude: CV.rumble.l / 255, weakMagnitude: CV.rumble.s / 255 })?.catch?.(() => {});
  play();
  CV.rumble.iv = setInterval(play, 250);
}

function isTyping() {
  const a = document.activeElement;
  return !!a && a !== document.body && a.id !== 'inputLayer' && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

function bindLiveTools() {
  const layer = $('inputLayer');
  layer.tabIndex = -1;
  layer.addEventListener('mousemove', (e) => {
    if (CV.state === 'on') {
      if (!CV.perm.mouse) return;
      if (document.pointerLockElement === layer) { CV.rel[0] += e.movementX; CV.rel[1] += e.movementY; }
      else CV.moveQ = normPt(e);
      queueMoveFlush();
      return;
    }
    if (tools.mode === 'draw' && tools.stroke) {
      const p = normPt(e).map(n4);
      tools.stroke.pending.push(p);
      tools.local.get(tools.stroke.id)?.pts.push(p);
      kickLocal();
    } else if (tools.mode === 'ptr') {
      const [x, y] = normPt(e);
      tools.myPtr = { x, y, ts: Date.now() };
      kickLocal();
      if (Date.now() - tools.ptrLast > 33) { tools.ptrLast = Date.now(); send({ t: 'ptr', x: n4(x), y: n4(y) }); }
    }
  });
  layer.addEventListener('mousedown', (e) => {
    layer.focus();
    if (CV.state === 'on') {
      e.preventDefault();
      if (!CV.perm.mouse || MOUSE_BTN[e.button] == null) return;
      if (document.pointerLockElement !== layer) ctlSend(['m', ...normPt(e).map(n4)]);
      ctlSend(['b', MOUSE_BTN[e.button], 1]);
      return;
    }
    if (tools.mode === 'draw' && e.button === 0) {
      const id = newMid();
      const p = normPt(e).map(n4);
      tools.stroke = { id, c: tools.color, pending: [p] };
      tools.local.set(id, { c: tools.color, pts: [p], done: false, ts: Date.now() });
      clearInterval(tools.flushT);
      tools.flushT = setInterval(() => flushStroke(false), 50);
      kickLocal();
    }
  });
  const up = (e) => {
    if (CV.state === 'on') { if (CV.perm.mouse && MOUSE_BTN[e.button] != null) ctlSend(['b', MOUSE_BTN[e.button], 0]); return; }
    if (tools.stroke) {
      clearInterval(tools.flushT);
      const l = tools.local.get(tools.stroke.id);
      if (l) { l.done = true; l.ts = Date.now(); }
      flushStroke(true);
      kickLocal();
    }
  };
  layer.addEventListener('mouseup', up);
  document.addEventListener('mouseup', (e) => { if (document.pointerLockElement === layer || (tools.stroke && e.target !== layer)) up(e); });
  layer.addEventListener('mouseleave', () => { if (tools.mode === 'ptr') { send({ t: 'ptr-off' }); tools.myPtr = null; kickLocal(); } });
  layer.addEventListener('wheel', (e) => {
    if (CV.state !== 'on' || !CV.perm.mouse) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-1200, Math.min(1200, Math.round((-e.deltaY * k / 100) * 120)));
    const dx = Math.max(-1200, Math.min(1200, Math.round((e.deltaX * k / 100) * 120)));
    if (dy || dx) ctlSend(['w', dy, dx]);
  }, { passive: false });
  layer.addEventListener('contextmenu', (e) => { if (CV.state === 'on' || tools.mode) e.preventDefault(); });
  layer.addEventListener('dblclick', (e) => { if (CV.state === 'on' || tools.mode) e.stopPropagation(); });

  document.addEventListener('keydown', (e) => {
    if (placer && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') commitPlacement(); else cancelPlacement();
      return;
    }
    if (placer) return;
    if (CV.state !== 'on' || !CV.perm.kb || !e.code || isTyping()) return;
    if (!S.inCall || $('remoteScreenWrap').classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    CV.keys.add(e.code);
    ctlSend(['k', e.code, 1]);
  }, true);
  document.addEventListener('keyup', (e) => {
    if (CV.state !== 'on' || !e.code || !CV.keys.has(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    CV.keys.delete(e.code);
    ctlSend(['k', e.code, 0]);
  }, true);
  window.addEventListener('blur', () => { for (const code of CV.keys) ctlSend(['k', code, 0]); CV.keys.clear(); });
  document.addEventListener('fullscreenchange', () => {
    if (CV.state === 'on' && document.fullscreenElement && navigator.keyboard?.lock) navigator.keyboard.lock().catch(() => {});
  });

  // панель над стримом
  $('toolPtr').onclick = () => setTool('ptr');
  $('toolDraw').onclick = () => setTool('draw');
  $('toolColor').onclick = () => { tools.color = COLORS[(COLORS.indexOf(tools.color) + 1) % COLORS.length]; updateToolbar(); };
  $('toolClear').onclick = () => { tools.local.clear(); kickLocal(); send({ t: 'draw-clear' }); };
  const rb = $('reactBar');
  for (const e of REACTIONS) {
    const b = document.createElement('button');
    b.className = 'tbtn emoji';
    b.textContent = e;
    b.onclick = () => sendReaction(e);
    rb.appendChild(b);
  }
  $('toolImg').onclick = () => $('screenImgInput').click();
  $('screenImgInput').onchange = (e) => { sendScreenImage(e.target.files[0]); e.target.value = ''; };
  $('toolCtl').onclick = ctlRequest;
  $('toolFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('remoteScreenWrap').requestFullscreen()).catch(() => {});
  $('toolLock').onclick = () => {
    try { const p = layer.requestPointerLock({ unadjustedMovement: true }); p?.catch?.(() => layer.requestPointerLock()); } catch { layer.requestPointerLock(); }
    toast('Мышь захвачена для игры — Esc, чтобы отпустить');
  };
  window.addEventListener('resize', () => { if (placer) layoutPlacer(); });
  document.addEventListener('fullscreenchange', () => setTimeout(() => { if (placer) layoutPlacer(); }, 100));
  updateToolbar();
}

/* ---------- Стримящий ---------- */
function onCtlReq(d) {
  if (!S.localScreen || !S.shareCtx) { send({ t: 'ctl-deny', why: 'сейчас ничего не показывает' }); return; }
  if (settings().ctlAllow === false) { send({ t: 'ctl-deny', why: 'выключил запросы на управление' }); return; }
  if (CS.on) { send({ t: 'ctl-grant', ...CS.perm }); return; }
  CS.req = d;
  $('ctlTitle').textContent = `${S.friendNick} просит управление`;
  $('ctlMouse').checked = d.mouse !== false;
  $('ctlKb').checked = d.kb !== false;
  $('ctlPad').checked = d.pad !== false;
  $('ctlModal').classList.remove('hidden');
  sound('stream');
  window.duo.focusWindow();
  window.duo.notify({ title: `${S.friendNick} просит управление`, body: 'Открой alloconnect, чтобы разрешить или отказать', kind: 'call' });
  clearTimeout(CS.reqTimer);
  CS.reqTimer = setTimeout(() => { if (!$('ctlModal').classList.contains('hidden')) ctlDeny(); }, 30000);
  L('control', { request: true });
}

function ctlDeny() {
  clearTimeout(CS.reqTimer);
  $('ctlModal').classList.add('hidden');
  send({ t: 'ctl-deny', why: 'отказал' });
  CS.req = null;
}

async function ctlGrant() {
  clearTimeout(CS.reqTimer);
  $('ctlModal').classList.add('hidden');
  const perm = { mouse: $('ctlMouse').checked, kb: $('ctlKb').checked, pad: $('ctlPad').checked };
  if (!perm.mouse && !perm.kb && !perm.pad) { ctlDeny(); return; }
  if (!S.localScreen || !S.shareCtx) { send({ t: 'ctl-deny', why: 'показ уже закончился' }); return; }
  const r = await window.duo.inputStart(S.shareCtx.srcId, perm);
  if (!r.ok) { toast('Управление не запустилось: ' + r.error); send({ t: 'ctl-deny', why: 'не запустилось у него' }); return; }
  CS.on = true;
  CS.perm = perm;
  CS.lastMsg = Date.now();
  CS.released = true;
  send({ t: 'ctl-grant', ...perm });
  window.duo.ovlMsg({ t: 'pin', on: true, text: `🎮 ${S.friendNick} управляет` });
  $('ctlBadge').classList.remove('hidden');
  $('ctlBadgeText').textContent = `🎮 ${S.friendNick} управляет`;
  sysMsg(`${S.friendNick} управляет твоим компьютером. Забрать — Ctrl+Shift+X или кнопка на превью`);
  // друг пропал (нет сигналов 4 с) — отпускаем все зажатые клавиши
  CS.wd = setInterval(() => { if (CS.on && !CS.released && Date.now() - CS.lastMsg > 4000) { window.duo.inputCmd('rel'); CS.released = true; } }, 1000);
  L('control', { granted: perm, admin: r.admin });
}

function ctlEnd(why, notify = true) {
  if (!CS.on) return;
  CS.on = false;
  clearInterval(CS.wd);
  window.duo.inputStop();
  if (notify) send({ t: 'ctl-end', why });
  window.duo.ovlMsg({ t: 'pin', on: false });
  $('ctlBadge').classList.add('hidden');
  sysMsg(`Управление закончено${why ? ': ' + why : ''}`);
  L('control', { ended: why });
}

const KEYMAP = (() => {
  const m = {
    Escape: 0x01, Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F, BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C,
    ControlLeft: 0x1D, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2A, Backslash: 0x2B, Comma: 0x33, Period: 0x34,
    Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3A, ScrollLock: 0x46,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A, Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E,
    Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  };
  const out = {};
  for (const [k, v] of Object.entries(m)) out[k] = [v, 0];
  '1234567890'.split('').forEach((d, i) => { out['Digit' + d] = [0x02 + i, 0]; });
  'QWERTYUIOP'.split('').forEach((c, i) => { out['Key' + c] = [0x10 + i, 0]; });
  'ASDFGHJKL'.split('').forEach((c, i) => { out['Key' + c] = [0x1E + i, 0]; });
  'ZXCVBNM'.split('').forEach((c, i) => { out['Key' + c] = [0x2C + i, 0]; });
  for (let i = 1; i <= 10; i++) out['F' + i] = [0x3A + i, 0];
  Object.assign(out, {
    NumLock: [0x45, 1], NumpadEnter: [0x1C, 1], ControlRight: [0x1D, 1], NumpadDivide: [0x35, 1], PrintScreen: [0x37, 1], AltRight: [0x38, 1],
    Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4B, 1], ArrowRight: [0x4D, 1], End: [0x4F, 1], ArrowDown: [0x50, 1],
    PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1], ContextMenu: [0x5D, 1],
  });
  return out; // MetaLeft/MetaRight (Win) намеренно нет
})();

function onCtlMsg(a) {
  // от стримящего к зрителю — объекты
  if (!Array.isArray(a)) {
    if (!a || typeof a !== 'object') return;
    if (a.t === 'rumble' && CV.state === 'on') setRumble(Math.max(0, Math.min(255, a.l | 0)), Math.max(0, Math.min(255, a.s | 0)));
    else if (a.t === 'ctl-info' && CV.state === 'on') {
      const INFO = {
        local: `${S.friendNick} сам двигает мышью — твоя мышь на паузе`,
        nobus: `У ${S.friendNick} не установлен драйвер ViGEmBus — геймпад не передаётся`,
        padok: 'Геймпад подключён у друга',
        elev: `Окно у ${S.friendNick} запущено от администратора — Windows не пропускает туда управление`,
      };
      if (INFO[a.what]) { const now = Date.now(); if (now - (CV.infoTs?.[a.what] || 0) > 8000) { CV.infoTs = { ...CV.infoTs, [a.what]: now }; toast(INFO[a.what]); } }
    }
    return;
  }
  // от зрителя к стримящему — массивы
  if (!CS.on) return;
  CS.lastMsg = Date.now();
  CS.released = false;
  const p = CS.perm;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const int = (v, lim) => { const x = num(v); return x == null ? null : Math.max(-lim, Math.min(lim, Math.round(x))); };
  switch (a[0]) {
    case 'm': {
      const x = num(a[1]), y = num(a[2]);
      if (p.mouse && x != null && y != null) window.duo.inputCmd(`m ${Math.max(0, Math.min(1, x)).toFixed(4)} ${Math.max(0, Math.min(1, y)).toFixed(4)}`);
      break;
    }
    case 'r': { const dx = int(a[1], 2000), dy = int(a[2], 2000); if (p.mouse && dx != null && dy != null) window.duo.inputCmd(`r ${dx} ${dy}`); break; }
    case 'b': { const b = int(a[1], 9); if (p.mouse && b != null && b >= 0 && b <= 4) window.duo.inputCmd(`b ${b} ${a[2] ? 1 : 0}`); break; }
    case 'w': { const dy = int(a[1], 1200), dx = int(a[2], 1200); if (p.mouse && dy != null && dx != null) window.duo.inputCmd(`w ${dy} ${dx}`); break; }
    case 'k': { const k = KEYMAP[a[1]]; if (p.kb && k) window.duo.inputCmd(`k ${k[0]} ${k[1]} ${a[2] ? 1 : 0}`); break; }
    case 'p': {
      if (!p.pad) break;
      const v = a.slice(1, 8).map((x, i) => int(x, i === 0 ? 65535 : i < 3 ? 255 : 32767));
      if (v.length === 7 && v.every((x) => x != null) && v[0] >= 0 && v[1] >= 0 && v[2] >= 0) window.duo.inputCmd(`pad ${v.join(' ')}`);
      break;
    }
    default:
  }
}

function onInputEvt(line) {
  if (line === 'local') { ctlSend({ t: 'ctl-info', what: 'local' }, true); return; }
  if (line.startsWith('rumble ')) { const [, l, s] = line.split(' ').map(Number); ctlSend({ t: 'rumble', l, s }, true); return; }
  if (line === 'pad ok') { ctlSend({ t: 'ctl-info', what: 'padok' }); return; }
  if (line === 'pad err nobus') {
    toast('Геймпад друга не подключить: установи драйвер ViGEmBus (ссылка в README) и перезапусти alloconnect');
    ctlSend({ t: 'ctl-info', what: 'nobus' });
    return;
  }
  if (line.startsWith('pad err')) { toast('Виртуальный геймпад не создался'); return; }
  if (line === 'elev') {
    toast('Окно запущено от администратора — управление туда не проходит. Запусти alloconnect от администратора');
    ctlSend({ t: 'ctl-info', what: 'elev' });
    return;
  }
  if (line === 'exit' && CS.on) ctlEnd('помощник остановился');
}

/* =========================================================
   Повтор последних секунд стрима (клип)
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
  const remote = !$('remoteScreenWrap').classList.contains('hidden');
  if (remote && S.tx?.video?.receiver?.track) {
    return { key: 'remote', video: S.tx.video.receiver.track,
      audio: [S.tx.saudio?.receiver?.track, S.tx.mic?.receiver?.track, micSendTrack()] };
  }
  if (S.localScreen) {
    return { key: 'local', video: S.localScreen.getVideoTracks()[0],
      audio: [S.localScreen.getAudioTracks()[0], micSendTrack(), S.tx?.mic?.receiver?.track] };
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
  const mix = clipAudioMix(t.audio);
  S.clipMix = mix;
  const rec = new window.ClipRecorder(Math.max(5, Math.min(120, Number(settings().clipSeconds) || 30)));
  S.clip = rec;
  const ok = await rec.start(t.video, mix.track);
  if (!ok) { L('clip', { startFailed: rec.err }); stopClip(); }
  else L('clip', { started: t.key, seconds: rec.seconds });
}

function stopClip() {
  try { S.clip?.stop(); } catch { /* */ }
  try { S.clipMix?.stop(); } catch { /* */ }
  S.clip = null;
  S.clipMix = null;
  S.clipKey = null;
}

async function saveClip() {
  if (!settings().clip) { toast('Повтор выключен в настройках'); return; }
  const rec = S.clip;
  if (!rec || !rec.running) { toast('Повтор работает, пока идёт показ экрана'); return; }
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
  showClipPreview(file, secs);
}

function showClipPreview(file, secs) {
  if (S.clipUrl) URL.revokeObjectURL(S.clipUrl);
  const url = URL.createObjectURL(file);
  S.clipUrl = url;
  $('clipVideo').src = url;
  $('clipInfo').textContent = `Последние ${secs} с · ${fmtSize(file.size)}`;
  $('clipModal').classList.remove('hidden');
  $('clipSend').disabled = !S.connected;
  $('clipSend').onclick = () => {
    if (!S.connected) { toast('Друг не в звонке'); return; }
    queueFiles([file]);
    $('clipModal').classList.add('hidden');
    toast('Повтор отправляется другу');
  };
  $('clipSave').onclick = () => { const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); };
}

/* =========================================================
   Рация (push-to-talk) через помощник: клавиша/кнопка мыши ловится глобально
   ========================================================= */
window.duo?.onPtt?.((ev) => {
  const o = settings();
  if (!o.ptt || !o.pttVk) return;
  if (ev.vk === o.pttVk) setPttDown(ev.down);
});

function applyPttHelper() {
  const o = settings();
  const vks = o.ptt && o.pttVk ? [o.pttVk] : [];
  window.duo?.pttSet?.(vks);
  S.pttDown = false;
  applyMicEnabled();
}

// красивое имя клавиши и захват
const VK_NAMES = { 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 20: 'CapsLock', 32: 'Пробел', 9: 'Tab', 192: '`',
  4: 'Сред. кнопка мыши', 5: 'Мышь X1 (назад)', 6: 'Мышь X2 (вперёд)' };
for (let i = 0; i < 26; i++) VK_NAMES[65 + i] = String.fromCharCode(65 + i);
for (let i = 0; i <= 9; i++) VK_NAMES[48 + i] = String(i);
for (let i = 1; i <= 12; i++) VK_NAMES[111 + i] = 'F' + i;
function vkName(vk) { return VK_NAMES[vk] || ('VK' + vk); }

function codeToVk(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3);
  if (/^Digit[0-9]$/.test(c)) return 48 + Number(c.slice(5));
  if (/^F([1-9]|1[0-2])$/.test(c)) return 111 + Number(c.slice(1));
  return { Space: 32, Tab: 9, CapsLock: 20, Backquote: 192, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18 }[c] || 0;
}

let pttCapture = false;
function startPttCapture() {
  pttCapture = true;
  $('pttKey').textContent = 'Нажми клавишу или кнопку мыши…';
  $('pttKey').classList.add('capture');
}
function finishPttCapture(vk) {
  if (!vk) return;
  pttCapture = false;
  $('pttKey').classList.remove('capture');
  store.set('settings', { ...settings(), pttVk: vk, pttName: vkName(vk) });
  $('pttKey').textContent = 'Клавиша рации: ' + vkName(vk);
  if (settings().ptt) applyPttHelper();
}

/* =========================================================
   «Во что играю»
   ========================================================= */
window.duo?.onActivity?.((a) => { S.myActivity = a; });
function applyActivity() { window.duo?.fgSet?.(!!settings().activity); }

/* =========================================================
   Обновления от друга (подпись Ed25519 проверяется в main)
   ========================================================= */
const UPDATE_FILES = ['app.asar', 'alloconnect-helper.exe'];
let myUpd = null; // { v, electron, can, packaged }
const verCmpR = (a, b) => {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};
const upd = { pull: null, declined: new Set() };

// GitHub: тихая проверка через минуту после запуска и раз в 6 часов; «Проверить сейчас» — в настройках
let ghTimer = null;
let ghShown = '';
async function ghCheckNow(manual) {
  const st = $('ghStatus');
  if (manual) st.textContent = 'Проверяю…';
  const r = await window.duo.ghCheck().catch((e) => ({ ok: false, error: e.message }));
  L('update', { gh: r.ok ? (r.ready ? 'ready' : r.manual ? 'manual' : 'none') : 'error', v: r.v });
  if (!r.ok) {
    st.textContent = r.error === 'no-repo' ? 'Адрес GitHub в этой сборке не задан' : 'Не получилось: ' + r.error;
    return;
  }
  if (r.none) { st.textContent = `У тебя последняя версия (${myUpd?.v || r.v})`; return; }
  if (r.manual) {
    st.textContent = `Есть ${r.v} — её нужно скачать вручную`;
    if (manual || ghShown !== r.v) {
      ghShown = r.v;
      toast(`Вышла alloconnect ${r.v}. Эту версию нужно скачать вручную (сменилась основа программы) — открой «Настройки → Обновление»`);
      if (manual && /^https:\/\/github\.com\//.test(r.page || '')) window.open(r.page);
    }
    return;
  }
  st.textContent = `Скачана ${r.v}, готова к установке`;
  if (manual || ghShown !== r.v) {
    ghShown = r.v;
    updModal(`Обновление до ${r.v}`, `Новая версия скачана с GitHub и проверена подписью.${r.notes ? '\n\n' + r.notes : ''}\n\nУстановка займёт несколько секунд, alloconnect перезапустится.`, true);
  }
}
function scheduleGh() {
  clearInterval(ghTimer);
  ghTimer = null;
  if (settings().autoUpdate === false || !myUpd?.packaged) return;
  ghTimer = setInterval(() => { if (!S.inCall) ghCheckNow(false); }, 6 * 3600 * 1000);
  setTimeout(() => { if (settings().autoUpdate !== false && !S.inCall) ghCheckNow(false); }, 60 * 1000);
}

async function initUpdates() {
  myUpd = await window.duo.updOwn().catch(() => null);
  scheduleGh();
  // результат прошлой установки/отката
  const r = await window.duo.updResult().catch(() => null);
  if (r) {
    if (r.to === 'rollback') toast(r.ok ? `Откат на ${r.now} выполнен` : `Откат не удался: ${r.err || ''}`);
    else if (r.ok) toast(`Обновлено: ${r.from} → ${r.now}`);
    else toast(`Обновление не установилось (${r.err || 'ошибка'}) — осталась ${r.now}`);
    L('update', { result: r });
  }
}

// я (старая версия) тяну обновление у друга (новая версия)
async function startUpdatePull(id, nick, ver) {
  if (upd.pull) { toast('Обновление уже идёт'); return; }
  if (!myUpd?.packaged) { toast('Обновляться можно только в собранной программе'); return; }
  upd.pull = { id, nick, ver, files: 0 };
  updModal(`Обновление до ${ver}`, `Соединяюсь с ${nick}…`, false);
  try {
    const l = await getLink(id);
    await withTimeout(l.open, 25000, 'не удалось соединиться');
    if (!upd.pull || upd.pull.id !== id) return;
    l.dc.send(JSON.stringify({ t: 'upd-req', v: myUpd.v }));
    updModal(`Обновление до ${ver}`, 'Запрос отправлен, жду описание…', false);
    upd.pull.timer = setTimeout(() => { if (upd.pull && upd.pull.id === id && !upd.pull.staging) finishUpdPull('друг не ответил'); }, 20000);
  } catch (e) { finishUpdPull(e.message); }
}

// друг (новая версия) просит у меня обновление → отдаю, если моё новее
function onUpdReq(id, l) {
  (async () => {
    const off = await window.duo.updOffer().catch(() => null);
    const mine = await window.duo.updOwn().catch(() => null);
    if (!off || !mine) { try { l.dc.send(JSON.stringify({ t: 'upd-none' })); } catch { /* */ } return; }
    try { l.dc.send(JSON.stringify({ t: 'upd-manifest', m: off.m, sig: off.sig })); } catch { return; }
    L('update', { serving: mine.v, to: id.slice(0, 8) });
  })();
}

// друг подтвердил готовность принимать — шлём файлы
async function onUpdGo(id, l) {
  for (const n of UPDATE_FILES) {
    const bytes = await window.duo.updRead(n).catch((e) => { L('update', { readErr: n, err: e.message }); return null; });
    if (!bytes) { try { l.dc.send(JSON.stringify({ t: 'upd-none' })); } catch { /* */ } return; }
    l.chan.queue([new File([bytes], n, { type: 'application/octet-stream' })], 'update');
  }
}

async function onUpdManifest(id, d) {
  if (!upd.pull || upd.pull.id !== id) return;
  const r = await window.duo.updStageBegin(d.m, d.sig).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) {
    if (r.error === 'manual') finishUpdPull(`нужно обновить вручную (сменился движок). Жди новый установщик от меня`);
    else finishUpdPull('описание не принято: ' + (r.error || ''));
    return;
  }
  upd.pull.staging = true;
  clearTimeout(upd.pull.timer);
  updModal(`Обновление до ${upd.pull.ver}`, 'Загружаю файлы…', false);
  const l = links.get(id);
  try { l?.dc.send(JSON.stringify({ t: 'upd-go' })); } catch { /* */ }
}

async function onUpdateFile(id, blob, meta) {
  if (!upd.pull || upd.pull.id !== id || !upd.pull.staging) return;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const r = await window.duo.updStageFile(meta.name, bytes);
    if (!r.ok) { finishUpdPull('файл не принят: ' + (r.error || '')); return; }
    upd.pull.files++;
    updModal(`Обновление до ${upd.pull.ver}`, `Загружено файлов: ${upd.pull.files} из ${UPDATE_FILES.length}…`, false);
    if (r.ready) {
      const st = await window.duo.updStaged();
      clearTimeout(upd.pull.timer);
      updModal(`Обновление до ${upd.pull.ver} готово`, (st?.notes ? st.notes + '\n\n' : '') + 'Установить и перезапустить alloconnect?', true);
    }
  } catch (e) { finishUpdPull(e.message); }
}

function finishUpdPull(msg) {
  if (upd.pull?.timer) clearTimeout(upd.pull.timer);
  upd.pull = null;
  $('updModal').classList.add('hidden');
  if (msg) toast('Обновление: ' + msg);
}

function updModal(title, text, ready) {
  $('updTitle').textContent = title;
  $('updText').textContent = text;
  $('updApply').classList.toggle('hidden', !ready);
  $('updModal').classList.remove('hidden');
}

async function doUpdateApply() {
  const r = await window.duo.updApply().catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { toast('Не удалось установить: ' + (r.error || '')); return; }
  updModal('Обновление', 'Устанавливаю и перезапускаю…', false);
}

async function refreshRollback() {
  const can = await window.duo.updBackup().catch(() => false);
  $('rollbackRow').classList.toggle('hidden', !can);
}
async function doRollback() {
  if (!confirm('Откатиться на прошлую версию?')) return;
  const r = await window.duo.updRollback().catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) toast('Откат не вышел: ' + (r.error || ''));
}

bind();
logCapabilities();
initFriends();
