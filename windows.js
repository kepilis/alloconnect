'use strict';
/* =========================================================
   Окна в звонке на двоих (1.18): демонстрация, вебкамера, чат.
   По умолчанию — базовые места (демонстрация слева, чат справа, камера в углу демонстрации), у окон только «свернуть».
   Настройка «Свободное расположение окон» (winFree) включает перемещение, размер, «закрепить», «прицепить»
   (едет вместе с окном, к которому прицеплено, и всегда над ним) и «отдельное окно» (окно Windows).
   Окно никогда не уходит за пределы приложения. Свёрнутое окно — кнопка внизу; у свёрнутой демонстрации нет звука.
   ========================================================= */
const WIN_NAMES = { screen: 'Демонстрация', cam: 'Вебкамера', chat: 'Чат' };
const WIN = { min: {}, lay: null, order: ['screen', 'chat', 'cam'], drag: null, pops: {} };
const winEl = (id) => (id === 'screen' ? $('remoteScreenWrap') : id === 'cam' ? $('camWrap') : $('callChat'));
const winStage = () => document.querySelector('#call .stage');
const winFree = () => settings().winFree === true;
// окно «есть» (не считая свёрнутости): демонстрация — пока друг показывает, камера — пока она включена
const winExists = (id) => (id === 'chat' ? true : !winEl(id)?.classList.contains('hidden'));

const WIN_ICONS = {
  pin: '<path d="M12 17v5"></path><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"></path>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path>',
  pop: '<path d="M14 4h6v6"></path><path d="M20 4l-8 8"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>',
  min: '<path d="M5 12h14"></path>',
};
const WIN_TITLES = { pin: 'Закрепить на месте', link: 'Прицепить к окну под ним — будет двигаться вместе с ним', pop: 'Вынести в отдельное окно (можно на второй монитор)', min: 'Свернуть — звук этого окна выключится' };

function winIcons(id) {
  const box = document.createElement('span');
  box.className = 'wicons';
  for (const a of ['pin', 'link', 'pop', 'min']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wbtn';
    b.dataset.a = a;
    b.title = WIN_TITLES[a];
    b.setAttribute('aria-label', WIN_TITLES[a]);
    b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${a === 'min' ? 2.4 : 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WIN_ICONS[a]}</svg>`;
    b.onclick = (e) => { e.stopPropagation(); winAction(id, a); };
    box.appendChild(b);
  }
  return box;
}

function winBind() {
  const stage = winStage();
  // заголовки: у демонстрации и камеры — свои, у чата — его шапка
  for (const id of ['screen', 'cam']) {
    const el = winEl(id);
    let h = el.querySelector(':scope > .whead');
    if (!h) {
      h = document.createElement('div');
      h.className = 'whead';
      h.innerHTML = `<span class="wtitle"></span><span class="wlink hidden"></span>`;
      h.querySelector('.wtitle').textContent = WIN_NAMES[id];
      el.prepend(h);
    }
    h.appendChild(winIcons(id));
    h.addEventListener('pointerdown', (e) => winStart(id, e, 'move'));
  }
  const chatHead = $('callChat').querySelector('.chat-head');
  chatHead.classList.add('whead');
  const lk = document.createElement('span');
  lk.className = 'wlink hidden';
  chatHead.appendChild(lk);
  chatHead.appendChild(winIcons('chat'));
  chatHead.addEventListener('pointerdown', (e) => winStart('chat', e, 'move'));
  for (const id of ['screen', 'cam', 'chat']) {
    const r = document.createElement('div');
    r.className = 'wresize';
    r.title = 'Потяни — размер окна';
    r.addEventListener('pointerdown', (e) => winStart(id, e, 'resize'));
    winEl(id).appendChild(r);
    winEl(id).addEventListener('pointerdown', () => { if (winFree()) winFront(id); }, true);
  }
  // свёрнутые окна — кнопки внизу
  const dock = document.createElement('div');
  dock.id = 'winDock';
  dock.className = 'wdock';
  stage.appendChild(dock);
  window.addEventListener('pointermove', winMove);
  window.addEventListener('pointerup', winUp);
  window.addEventListener('pointercancel', winUp);
  new ResizeObserver(() => { if (winFree()) winApply(); }).observe(stage);
  // демонстрация и камера появляются/пропадают — перерисовать
  const mo = new MutationObserver(() => winLayoutChanged());
  for (const id of ['screen', 'cam']) mo.observe(winEl(id), { attributes: true, attributeFilter: ['class'] });
  winSetMode();
}

/* ---------- режимы ---------- */
function winSetMode() {
  const stage = winStage();
  const free = winFree();
  stage.classList.toggle('free', free);
  if (free) {
    WIN.lay = winLoad() || winDefault();
    winApply();
  } else {
    for (const id of ['screen', 'cam', 'chat']) { const el = winEl(id); for (const k of ['left', 'top', 'width', 'height', 'zIndex']) el.style[k] = ''; }
    for (const id of Object.keys(WIN.pops)) winUnpop(id);
  }
  winLayoutChanged();
}

// стартовые места свободного режима — как в базовом
function winDefault() {
  const s = winStage().getBoundingClientRect();
  const G = 16, CW = Math.max(220, Math.min(s.width - 340, store.get('chatW', null) || 300));
  const sw = Math.max(320, s.width - CW - G * 3), sh = Math.max(200, s.height - G * 2);
  return {
    screen: { x: G, y: G, w: sw, h: sh, pin: false, link: null },
    cam: { x: G + sw - 240 - 12, y: G + sh - 180 - 64, w: 240, h: 180, pin: false, link: 'screen' },
    chat: { x: s.width - CW - G, y: G, w: CW, h: sh, pin: false, link: null },
  };
}
function winLoad() {
  const l = store.get('winLayout', null);
  if (!l || !['screen', 'cam', 'chat'].every((k) => l[k] && Number.isFinite(l[k].x))) return null;
  return l;
}
function winSave() { store.set('winLayout', WIN.lay); }
function winReset() {
  store.set('winLayout', null);
  if (winFree()) { WIN.lay = winDefault(); winSave(); winApply(); }
}

function winFollowers(id) {
  const out = [];
  const walk = (p) => { for (const k of Object.keys(WIN.lay)) if (WIN.lay[k].link === p && k !== id && !out.includes(k)) { out.push(k); walk(k); } };
  walk(id);
  return out;
}
// наверх — окно и всё, что к нему прицеплено (прицепленное всегда над ним)
function winFront(id) {
  const top = [id, ...winFollowers(id)];
  WIN.order = [...WIN.order.filter((k) => !top.includes(k)), ...top];
  winApplyZ();
}
function winApplyZ() { WIN.order.forEach((id, i) => { winEl(id).style.zIndex = String(5 + i); }); }

// всё держим внутри приложения
function winClampAll() {
  const s = winStage().getBoundingClientRect();
  for (const id of Object.keys(WIN.lay)) {
    const o = WIN.lay[id];
    o.w = Math.max(180, Math.min(s.width, o.w));
    o.h = Math.max(120, Math.min(s.height, o.h));
    o.x = Math.max(0, Math.min(s.width - o.w, o.x));
    o.y = Math.max(0, Math.min(s.height - o.h, o.y));
  }
}
function winApply() {
  if (!WIN.lay) return;
  winClampAll();
  for (const id of ['screen', 'cam', 'chat']) {
    if (WIN.pops[id]) continue;
    const el = winEl(id), o = WIN.lay[id];
    Object.assign(el.style, { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px' });
    el.classList.toggle('wpinned', !!o.pin);
    el.classList.toggle('wlinked', !!o.link);
    el.querySelector('.wbtn[data-a="pin"]')?.classList.toggle('on', !!o.pin);
    el.querySelector('.wbtn[data-a="pin"]')?.setAttribute('title', o.pin ? 'Открепить' : WIN_TITLES.pin);
    el.querySelector('.wbtn[data-a="link"]')?.classList.toggle('on', !!o.link);
    el.querySelector('.wbtn[data-a="link"]')?.setAttribute('title', o.link ? 'Отцепить' : WIN_TITLES.link);
    const lk = el.querySelector('.wlink');
    if (lk) { lk.classList.toggle('hidden', !o.link); lk.textContent = o.link ? (o.w >= 300 ? 'прицеплено к: ' + WIN_NAMES[o.link] : '🔗') : ''; lk.title = o.link ? 'Прицеплено к: ' + WIN_NAMES[o.link] : ''; }
  }
  winApplyZ();
}

/* ---------- перетаскивание ---------- */
function winStart(id, e, mode) {
  if (!winFree() || e.button !== 0 || WIN.pops[id]) return;
  if (e.target.closest('button, input, select, textarea, a')) return;
  const o = WIN.lay[id];
  winFront(id);
  if (o.pin) return;
  e.preventDefault();
  const group = mode === 'move' ? [id, ...winFollowers(id).filter((f) => !WIN.lay[f].pin && !WIN.pops[f])] : [id];
  const origs = {};
  for (const g of group) origs[g] = { ...WIN.lay[g] };
  WIN.drag = { id, mode, sx: e.clientX, sy: e.clientY, o: { ...o }, group, origs };
  document.body.classList.add('wdragging');
}
function winMove(e) {
  const d = WIN.drag;
  if (!d) return;
  const s = winStage().getBoundingClientRect();
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
  if (d.mode === 'resize') {
    const o = WIN.lay[d.id];
    o.w = Math.round(Math.max(180, Math.min(s.width - d.o.x, d.o.w + dx)));
    o.h = Math.round(Math.max(120, Math.min(s.height - d.o.y, d.o.h + dy)));
    winApply();
    return;
  }
  let x = d.o.x + dx, y = d.o.y + dy;
  const w = d.o.w, h = d.o.h, M = 10;
  // магнит к краям и к соседним окнам
  const xs = [0, s.width], ys = [0, s.height];
  for (const k of Object.keys(WIN.lay)) {
    if (d.group.includes(k) || !winExists(k) || WIN.min[k] || WIN.pops[k]) continue;
    const o = WIN.lay[k];
    xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h);
  }
  for (const v of xs) { if (Math.abs(x - v) < M) x = v; else if (Math.abs(x + w - v) < M) x = v - w; }
  for (const v of ys) { if (Math.abs(y - v) < M) y = v; else if (Math.abs(y + h - v) < M) y = v - h; }
  // вся сцепка внутри приложения
  let L0 = 0, R0 = 0, T0 = 0, B0 = 0;
  for (const g of d.group) {
    const o = d.origs[g];
    L0 = Math.min(L0, o.x - d.o.x); T0 = Math.min(T0, o.y - d.o.y);
    R0 = Math.max(R0, o.x + o.w - d.o.x - w); B0 = Math.max(B0, o.y + o.h - d.o.y - h);
  }
  x = Math.max(-L0, Math.min(s.width - w - R0, x));
  y = Math.max(-T0, Math.min(s.height - h - B0, y));
  for (const g of d.group) { WIN.lay[g].x = d.origs[g].x + (x - d.o.x); WIN.lay[g].y = d.origs[g].y + (y - d.o.y); }
  winApply();
}
function winUp() {
  if (!WIN.drag) return;
  WIN.drag = null;
  document.body.classList.remove('wdragging');
  winSave();
}

/* ---------- кнопки окна ---------- */
function winAction(id, a) {
  if (a === 'min') { winSetMin(id, true); return; }
  if (!winFree()) return;
  const o = WIN.lay[id];
  if (a === 'pin') o.pin = !o.pin;
  else if (a === 'link') {
    if (o.link) o.link = null;
    else {
      // к окну, на котором лежит (или к ближайшему)
      let best = null, bestScore = -Infinity;
      for (const k of Object.keys(WIN.lay)) {
        if (k === id || !winExists(k) || WIN.min[k] || WIN.pops[k] || winFollowers(id).includes(k)) continue;
        const p = WIN.lay[k];
        const ix = Math.max(0, Math.min(o.x + o.w, p.x + p.w) - Math.max(o.x, p.x));
        const iy = Math.max(0, Math.min(o.y + o.h, p.y + p.h) - Math.max(o.y, p.y));
        const score = ix * iy * 10 - Math.hypot(o.x + o.w / 2 - p.x - p.w / 2, o.y + o.h / 2 - p.y - p.h / 2);
        if (score > bestScore) { bestScore = score; best = k; }
      }
      if (!best) { toast('Не к чему прицепить — нет других открытых окон'); return; }
      o.link = best;
      winFront(best);
    }
  } else if (a === 'pop') { if (WIN.pops[id]) winUnpop(id); else winPop(id); return; }
  winSave();
  winApply();
}

// свернуть: окно (и прицепленные к нему) — в кнопку внизу; у демонстрации пропадает звук
function winSetMin(id, v) {
  const ids = [id, ...(winFree() && WIN.lay ? winFollowers(id) : (id === 'screen' ? ['cam'] : []))];
  for (const k of ids) WIN.min[k] = v;
  if (!v && winFree()) winFront(id);
  winLayoutChanged();
}

function winLayoutChanged() {
  const stage = winStage();
  if (!stage) return;
  for (const id of ['screen', 'cam', 'chat']) winEl(id).classList.toggle('wmin', !!WIN.min[id] && !WIN.pops[id]);
  stage.classList.toggle('chat-min', !!WIN.min.chat && !WIN.pops.chat);
  stage.classList.toggle('chat-out', !!WIN.pops.chat);
  // звук стрима — только пока демонстрация не свёрнута
  const v = $('remoteScreen');
  if (v) v.muted = S.deafened || !!WIN.min.screen;
  const dock = $('winDock');
  if (dock) {
    dock.replaceChildren();
    for (const id of ['screen', 'cam', 'chat']) {
      if (!WIN.min[id] || !winExists(id)) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wchip';
      b.title = 'Развернуть';
      b.innerHTML = '<span></span><small>звук выкл</small>';
      b.firstChild.textContent = WIN_NAMES[id];
      if (id !== 'screen') b.querySelector('small').remove();
      b.onclick = () => winSetMin(id, false);
      dock.appendChild(b);
    }
  }
  if (winFree()) winApply();
}
window.winLayoutChanged = winLayoutChanged;

// новый звонок — всё развёрнуто
function winResetCall() {
  WIN.min = {};
  for (const id of Object.keys(WIN.pops)) winUnpop(id);
  winLayoutChanged();
}

/* ---------- отдельное окно Windows ---------- */
function winPop(id) {
  const el = winEl(id);
  const r = el.getBoundingClientRect();
  const w = window.open('', 'alc-pop-' + id, `width=${Math.round(r.width)},height=${Math.round(r.height)}`);
  if (!w) { toast('Отдельное окно не открылось'); return; }
  const d = w.document;
  d.open();
  d.write('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body class="popbody"></body></html>');
  d.close();
  d.title = 'alloconnect — ' + WIN_NAMES[id];
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) { const n = d.createElement('link'); n.rel = 'stylesheet'; n.href = l.href; d.head.appendChild(n); }
  if (document.documentElement.dataset.theme) d.documentElement.dataset.theme = document.documentElement.dataset.theme;
  d.documentElement.className = document.documentElement.className;
  const mark = document.createComment('pop-' + id);
  el.parentNode.insertBefore(mark, el);
  WIN.pops[id] = { w, mark };
  el.classList.add('popped');
  d.body.appendChild(d.adoptNode(el));
  for (const v of el.querySelectorAll('video')) v.play?.().catch(() => {});
  // клавиши (управление, отправка) — как в главном окне
  for (const t of ['keydown', 'keyup']) {
    d.addEventListener(t, (e) => {
      const ev = new KeyboardEvent(t, { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true });
      if (!document.dispatchEvent(ev)) e.preventDefault();
    }, true);
  }
  w.addEventListener('pagehide', () => { if (WIN.pops[id]?.w === w) winUnpop(id, true); });
  winLayoutChanged();
}
function winUnpop(id, closed) {
  const p = WIN.pops[id];
  if (!p) return;
  delete WIN.pops[id];
  const el = p.w.document?.body?.contains(winElIn(p.w.document, id)) ? winElIn(p.w.document, id) : null;
  if (el) { p.mark.parentNode.insertBefore(document.adoptNode(el), p.mark); el.classList.remove('popped'); for (const v of el.querySelectorAll('video')) v.play?.().catch(() => {}); }
  p.mark.remove();
  if (!closed) try { p.w.close(); } catch { /* */ }
  winLayoutChanged();
}
function winElIn(doc, id) { return doc.getElementById(id === 'screen' ? 'remoteScreenWrap' : id === 'cam' ? 'camWrap' : 'callChat'); }
// элементы вынесенного окна должны находиться обычным $()
function winLookup(id) {
  for (const p of Object.values(WIN.pops)) { const el = p.w.document?.getElementById(id); if (el) return el; }
  return null;
}

winBind();
