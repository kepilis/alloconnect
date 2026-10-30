'use strict';
// Оверлей у того, кто стримит: рисунки и указка друга, реакции, картинки, плашка управления.
const cv = document.getElementById('cv');
const g = cv.getContext('2d');
const strokes = new Map(); // id -> { c, w, pts: [[x,y]], done, ts }
const ptrs = new Map();    // чья указка (pid; в звонке на двоих — одна) -> { x, y, nick, c, ts }
let raf = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(innerWidth * dpr);
  cv.height = Math.round(innerHeight * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  kick();
}
addEventListener('resize', resize);
resize();

function kick() { if (!raf) raf = requestAnimationFrame(draw); }

function draw() {
  raf = 0;
  const W = innerWidth, H = innerHeight, now = Date.now();
  g.clearRect(0, 0, W, H);
  let alive = false;
  for (const [id, s] of strokes) {
    const age = s.done ? now - s.ts : 0;
    const a = age < 2500 ? 1 : 1 - (age - 2500) / 1500;
    if (a <= 0) { strokes.delete(id); continue; }
    alive = true;
    g.globalAlpha = a;
    g.strokeStyle = s.c;
    g.lineWidth = s.w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(0,0,0,.45)';
    g.shadowBlur = 4;
    g.beginPath();
    s.pts.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
    if (s.pts.length === 1) g.lineTo(s.pts[0][0] * W + 0.1, s.pts[0][1] * H);
    g.stroke();
  }
  g.globalAlpha = 1;
  g.shadowBlur = 0;
  for (const [pid, ptr] of ptrs) {
    if (now - ptr.ts >= 1500) { ptrs.delete(pid); continue; }
    alive = true;
    const x = ptr.x * W, y = ptr.y * H;
    const pulse = 1 + 0.25 * Math.sin(now / 120);
    g.globalAlpha = 0.25;
    g.fillStyle = ptr.c;
    g.beginPath(); g.arc(x, y, 18 * pulse, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
    if (ptr.nick) {
      g.font = '600 13px "Segoe UI", sans-serif';
      const tw = g.measureText(ptr.nick).width;
      g.fillStyle = 'rgba(15,16,20,.85)';
      g.fillRect(x + 14, y + 10, tw + 12, 20);
      g.fillStyle = '#fff';
      g.fillText(ptr.nick, x + 20, y + 25);
    }
  }
  if (alive) raf = requestAnimationFrame(draw);
}

function react(e) {
  const el = document.createElement('div');
  el.className = 'react';
  el.textContent = e;
  el.style.left = (8 + Math.random() * 84) + '%';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

const imgs = [];
function showImage(bytes, mime, nick, pl) {
  while (imgs.length >= 3) imgs.shift().remove();
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const box = document.createElement('div');
  box.className = pl ? 'img placed' : 'img';
  const im = document.createElement('img');
  im.src = url;
  box.appendChild(im);
  if (nick) { const s = document.createElement('span'); s.textContent = nick; box.append(document.createElement('br'), s); }
  if (pl) {
    // место и размер выбрал друг: центр (x, y) и ширина w — доли экрана
    box.style.visibility = 'hidden';
    im.onload = () => {
      const W = innerWidth, H = innerHeight;
      const aspect = im.naturalHeight / Math.max(1, im.naturalWidth);
      let w = pl.w * W, h = w * aspect;
      if (h > 0.9 * H) { h = 0.9 * H; w = h / aspect; }
      const x = Math.max(w / 2, Math.min(W - w / 2, pl.x * W));
      const y = Math.max(h / 2, Math.min(H - h / 2, pl.y * H));
      Object.assign(im.style, { width: w + 'px', height: h + 'px', maxWidth: 'none', maxHeight: 'none' });
      Object.assign(box.style, { left: (x - w / 2) + 'px', top: (y - h / 2) + 'px', visibility: 'visible', rotate: pl.r ? pl.r + 'deg' : '' });
    };
  }
  document.body.appendChild(box);
  imgs.push(box);
  setTimeout(() => { box.remove(); URL.revokeObjectURL(url); const i = imgs.indexOf(box); if (i >= 0) imgs.splice(i, 1); }, 6600);
}

// видео от друга: одно за раз, до минуты, громкость уже посчитана (его выбор × моя настройка)
let vidBox = null;
function showVideo(bytes, mime, nick, pl, vol, sink) {
  if (vidBox) vidBox.kill();
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const box = document.createElement('div');
  box.className = 'vid';
  box.style.visibility = 'hidden';
  const v = document.createElement('video');
  v.playsInline = true;
  v.volume = Math.max(0, Math.min(1, vol));
  v.muted = !(vol > 0);
  box.appendChild(v);
  if (nick) { const s = document.createElement('span'); s.textContent = nick; box.appendChild(s); }
  let dead = false;
  const kill = () => {
    if (dead) return;
    dead = true;
    clearTimeout(hard);
    v.pause();
    box.classList.add('out');
    setTimeout(() => { box.remove(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }, 450);
    if (vidBox === box) vidBox = null;
  };
  box.kill = kill;
  const hard = setTimeout(kill, 61000);
  v.onloadedmetadata = () => {
    const W = innerWidth, H = innerHeight;
    const p = pl || { x: 0.5, y: 0.3, w: 0.35 };
    const aspect = v.videoHeight / Math.max(1, v.videoWidth);
    let w = p.w * W, h = w * aspect;
    if (h > 0.9 * H) { h = 0.9 * H; w = h / aspect; }
    const x = Math.max(w / 2, Math.min(W - w / 2, p.x * W));
    const y = Math.max(h / 2, Math.min(H - h / 2, p.y * H));
    Object.assign(box.style, { left: (x - w / 2) + 'px', top: (y - h / 2) + 'px', width: w + 'px', height: h + 'px', visibility: 'visible', rotate: p.r ? p.r + 'deg' : '' });
  };
  v.ontimeupdate = () => { if (v.currentTime > 60.5) kill(); };
  v.onended = kill;
  v.onerror = kill;
  (async () => {
    try { if (sink && v.setSinkId) await v.setSinkId(sink); } catch { /* */ }
    v.src = url;
    try { await v.play(); } catch { v.muted = true; v.play().catch(kill); }
  })();
  document.body.appendChild(box);
  vidBox = box;
}

function cleanPl(pl) {
  if (!pl || typeof pl !== 'object') return null;
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(pl.x) || !ok(pl.y) || !ok(pl.w)) return null;
  const r = ok(pl.r) ? Math.max(-180, Math.min(180, Math.round(pl.r))) : 0;
  return { x: clamp(pl.x), y: clamp(pl.y), w: Math.max(0.03, Math.min(0.95, pl.w)), r };
}

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));

window.ovl.on((m) => {
  switch (m.t) {
    case 'stroke': {
      let s = strokes.get(m.id);
      if (!s) { s = { c: String(m.c || '#ff3c50').slice(0, 9), w: Math.max(2, Math.min(14, Number(m.w) || 4)), pts: [], done: false, ts: Date.now() }; strokes.set(m.id, s); }
      for (const p of (m.pts || []).slice(0, 500)) s.pts.push([clamp(p[0]), clamp(p[1])]);
      if (s.pts.length > 4000) s.pts.splice(0, s.pts.length - 4000);
      if (m.done) { s.done = true; s.ts = Date.now(); }
      kick();
      break;
    }
    case 'clear': strokes.clear(); kick(); break;
    // «убрать всё с экрана» (горячая клавиша у того, кто показывает): видео, картинки, гифки, рисунки, указки, реакции
    case 'clear-all':
      strokes.clear(); ptrs.clear(); kick();
      vidBox?.kill?.();
      while (imgs.length) imgs.shift().remove();
      for (const el of document.querySelectorAll('.react')) el.remove();
      break;
    case 'ptr': ptrs.set(String(m.pid || 'one').slice(0, 64), { x: clamp(m.x), y: clamp(m.y), nick: String(m.nick || '').slice(0, 24), c: /^#[0-9a-f]{6}$/i.test(m.c) ? m.c : '#ff3c50', ts: Date.now() }); kick(); break;
    case 'ptr-off': if (m.pid) ptrs.delete(String(m.pid)); else ptrs.clear(); kick(); break;
    case 'react': react(String(m.e || '').slice(0, 8)); break;
    case 'vid': if (m.bytes) showVideo(m.bytes, /^video\//.test(String(m.mime)) ? String(m.mime) : 'video/mp4', String(m.nick || '').slice(0, 24), cleanPl(m.pl), Number(m.vol) || 0, String(m.sink || '').slice(0, 200)); break;
    case 'img': if (m.bytes) showImage(m.bytes, String(m.mime || 'image/png'), String(m.nick || '').slice(0, 24), cleanPl(m.pl)); break;
    case 'pin': {
      const b = document.getElementById('banner');
      b.style.display = m.on ? 'block' : 'none';
      b.innerHTML = '';
      if (m.on) { b.append(document.createTextNode(String(m.text || '').slice(0, 80))); const sm = document.createElement('small'); sm.textContent = 'Ctrl+Shift+X — забрать'; b.appendChild(sm); }
      break;
    }
    default:
  }
});
