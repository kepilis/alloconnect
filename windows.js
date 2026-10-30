'use strict';
/* =========================================================
   Окна в звонке (1.18–1.19).
   Звонок на двоих: «Демонстрация» (#remoteScreenWrap), «Вебкамера» (#camWrap), «Чат» (#callChat).
   Групповой звонок: «Участники» (сетка плиток с экранами и камерами, .gview) и «Чат» (#gChat).
   По умолчанию — базовые места, у окон только «свернуть». Настройка «Свободное расположение окон» (winFree)
   включает перемещение, размер, «закрепить», «прицепить» (едет вместе с окном, к которому прицеплено,
   и всегда над ним) и «отдельное окно» (окно Windows). Окно никогда не уходит за пределы приложения.
   Свёрнутое окно — кнопка внизу; у свёрнутой демонстрации (в группе — участников) нет звука экрана.
   ========================================================= */
const WIN_ICONS = {
  pin: '<path d="M12 17v5"></path><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"></path>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path>',
  pop: '<path d="M14 4h6v6"></path><path d="M20 4l-8 8"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>',
  min: '<path d="M5 12h14"></path>',
};
const WIN_TITLES = { pin: 'Закрепить на месте', link: 'Прицепить к окну под ним — будет двигаться вместе с ним', pop: 'Вынести в отдельное окно (можно на второй монитор)', min: 'Свернуть — звук этого окна выключится' };
const winFree = () => settings().winFree === true;

// у каждого экрана звонка — свой набор окон и своё состояние
const WCTX = {
  call: {
    key: 'call', stageSel: '#call .stage', store: 'winLayout',
    ids: ['screen', 'cam', 'chat'],
    names: { screen: 'Демонстрация', cam: 'Вебкамера', chat: 'Чат' },
    elId: { screen: 'remoteScreenWrap', cam: 'camWrap', chat: 'callChat' },
    heads: { chat: '.chat-head' },       // у кого заголовком служит своя шапка
    sound: 'screen',                     // свёрнуто — нет звука экрана
    // окно «есть»: демонстрация — пока друг показывает, камера — пока она включена
    exists: (id) => id === 'chat' || !$(WCTX.call.elId[id])?.classList.contains('hidden'),
    min: {}, lay: null, order: ['screen', 'chat', 'cam'], drag: null, pops: {},
  },
  group: {
    key: 'group', stageSel: '#group .stage', store: 'winLayoutG',
    ids: ['gview', 'gchat'],
    names: { gview: 'Участники', gchat: 'Чат' },
    elId: { gview: 'gView', gchat: 'gChat' },
    heads: { gchat: '.chat-head' },
    sound: 'gview',
    exists: () => true,
    min: {}, lay: null, order: ['gview', 'gchat'], drag: null, pops: {},
  },
};
const WIN = WCTX.call; // звонок на двоих (renderer.js читает WIN.min / WIN.pops)
const WING = WCTX.group;
const winEl = (c, id) => $(c.elId[id]);
const winStage = (c) => document.querySelector(c.stageSel);

function winIcons(c, id) {
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
    b.onclick = (e) => { e.stopPropagation(); winAction(c, id, a); };
    box.appendChild(b);
  }
  return box;
}

function winBindCtx(c) {
  const stage = winStage(c);
  for (const id of c.ids) {
    const el = winEl(c, id);
    let h;
    if (c.heads[id]) {
      h = el.querySelector(c.heads[id]);
      h.classList.add('whead');
      const lk = document.createElement('span');
      lk.className = 'wlink hidden';
      h.appendChild(lk);
    } else {
      h = el.querySelector(':scope > .whead');
      if (!h) {
        h = document.createElement('div');
        h.className = 'whead';
        h.innerHTML = '<span class="wtitle"></span><span class="wlink hidden"></span>';
        h.querySelector('.wtitle').textContent = c.names[id];
        el.prepend(h);
      }
    }
    h.appendChild(winIcons(c, id));
    h.addEventListener('pointerdown', (e) => winStart(c, id, e, 'move'));
    const r = document.createElement('div');
    r.className = 'wresize';
    r.title = 'Потяни — размер окна';
    r.addEventListener('pointerdown', (e) => winStart(c, id, e, 'resize'));
    el.appendChild(r);
    el.addEventListener('pointerdown', () => { if (winFree() && !c.pops[id]) winFront(c, id); }, true);
  }
  const dock = document.createElement('div');
  dock.className = 'wdock';
  dock.id = c === WCTX.call ? 'winDock' : 'gWinDock';
  c.dock = dock;
  stage.appendChild(dock);
  new ResizeObserver(() => { if (winFree()) winApply(c); }).observe(stage);
  if (c === WIN) {
    // демонстрация и камера появляются/пропадают — перерисовать
    const mo = new MutationObserver(() => winLayoutChanged());
    for (const id of ['screen', 'cam']) mo.observe(winEl(c, id), { attributes: true, attributeFilter: ['class'] });
    mo.observe($('localScreenWrap'), { attributes: true, attributeFilter: ['class'] });
  }
}

function winBind() {
  winBindCtx(WIN);
  winBindCtx(WING);
  window.addEventListener('pointermove', winMove);
  window.addEventListener('pointerup', winUp);
  window.addEventListener('pointercancel', winUp);
  winSetMode();
}

/* ---------- режимы ---------- */
function winSetMode() {
  const free = winFree();
  for (const c of [WIN, WING]) {
    winStage(c).classList.toggle('free', free);
    if (free) {
      c.lay = winLoad(c) || null;
      // раскладку считаем, когда экран звонка на виду (иначе размеры нулевые)
      if (c.lay || winStage(c).getBoundingClientRect().width > 0) { c.lay ??= winDefault(c); winApply(c); }
    } else {
      for (const id of c.ids) { const el = winEl(c, id); if (el) for (const k of ['left', 'top', 'width', 'height', 'zIndex']) el.style[k] = ''; }
      if (c === WIN) for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) $('localScreenWrap').style[k] = '';
      for (const id of Object.keys(c.pops)) winUnpop(c, id);
    }
    winRefresh(c);
  }
}

// стартовые места свободного режима — как в базовом
function winDefault(c) {
  const s = winStage(c).getBoundingClientRect();
  const G0 = 16, CW = Math.max(220, Math.min(s.width - 340, store.get('chatW', null) || 300));
  const sw = Math.max(320, s.width - CW - G0 * 3), sh = Math.max(200, s.height - G0 * 2);
  const main = { x: G0, y: G0, w: sw, h: sh, pin: false, link: null };
  const chat = { x: s.width - CW - G0, y: G0, w: CW, h: sh, pin: false, link: null };
  if (c === WING) return { gview: main, gchat: chat };
  return { screen: main, cam: { x: G0 + sw - 240 - 12, y: G0 + sh - 180 - 64, w: 240, h: 180, pin: false, link: 'screen' }, chat };
}
function winLoad(c) {
  const l = store.get(c.store, null);
  if (!l || !c.ids.every((k) => l[k] && Number.isFinite(l[k].x))) return null;
  return l;
}
function winSave(c) { store.set(c.store, c.lay); }
function winReset() {
  for (const c of [WIN, WING]) {
    store.set(c.store, null);
    c.lay = null;
    if (winFree() && winStage(c).getBoundingClientRect().width > 0) { c.lay = winDefault(c); winSave(c); winApply(c); }
  }
}

function winFollowers(c, id) {
  const out = [];
  if (!c.lay) return out;
  const walk = (p) => { for (const k of Object.keys(c.lay)) if (c.lay[k].link === p && k !== id && !out.includes(k)) { out.push(k); walk(k); } };
  walk(id);
  return out;
}
// наверх — окно и всё, что к нему прицеплено (прицепленное всегда над ним)
function winFront(c, id) {
  const top = [id, ...winFollowers(c, id)];
  c.order = [...c.order.filter((k) => !top.includes(k)), ...top];
  winApplyZ(c);
}
function winApplyZ(c) { c.order.forEach((id, i) => { const el = winEl(c, id); if (el && !c.pops[id]) el.style.zIndex = String(5 + i); }); }

// всё держим внутри приложения
function winClampAll(c) {
  const s = winStage(c).getBoundingClientRect();
  if (!s.width) return;
  for (const id of Object.keys(c.lay)) {
    const o = c.lay[id];
    o.w = Math.max(180, Math.min(s.width, o.w));
    o.h = Math.max(120, Math.min(s.height, o.h));
    o.x = Math.max(0, Math.min(s.width - o.w, o.x));
    o.y = Math.max(0, Math.min(s.height - o.h, o.y));
  }
}
function winApply(c) {
  if (!winFree()) return;
  if (!c.lay) { if (winStage(c).getBoundingClientRect().width > 0) c.lay = winDefault(c); else return; }
  winClampAll(c);
  for (const id of c.ids) {
    if (c.pops[id]) continue;
    const el = winEl(c, id), o = c.lay[id];
    if (!el) continue;
    Object.assign(el.style, { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px' });
    el.classList.toggle('wpinned', !!o.pin);
    el.classList.toggle('wlinked', !!o.link);
    const pin = el.querySelector('.wbtn[data-a="pin"]');
    pin?.classList.toggle('on', !!o.pin);
    pin?.setAttribute('title', o.pin ? 'Открепить' : WIN_TITLES.pin);
    const link = el.querySelector('.wbtn[data-a="link"]');
    link?.classList.toggle('on', !!o.link);
    link?.setAttribute('title', o.link ? 'Отцепить' : WIN_TITLES.link);
    const lk = el.querySelector('.wlink');
    if (lk) { lk.classList.toggle('hidden', !o.link); lk.textContent = o.link ? (o.w >= 300 ? 'прицеплено к: ' + c.names[o.link] : '🔗') : ''; lk.title = o.link ? 'Прицеплено к: ' + c.names[o.link] : ''; }
  }
  // своё превью стрима «крупно» — на месте окна демонстрации, а не под чатом
  if (c === WIN) {
    const lp = $('localScreenWrap');
    const o = c.lay.screen;
    if (lp.classList.contains('solo')) Object.assign(lp.style, { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', right: 'auto', bottom: 'auto' });
    else for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) lp.style[k] = '';
  }
  winApplyZ(c);
}

/* ---------- перетаскивание ---------- */
function winStart(c, id, e, mode) {
  if (!winFree() || e.button !== 0 || c.pops[id] || !c.lay) return;
  if (e.target.closest('button, input, select, textarea, a, label')) return;
  const o = c.lay[id];
  winFront(c, id);
  if (o.pin) return;
  e.preventDefault();
  const group = mode === 'move' ? [id, ...winFollowers(c, id).filter((f) => !c.lay[f].pin && !c.pops[f])] : [id];
  const origs = {};
  for (const g of group) origs[g] = { ...c.lay[g] };
  c.drag = { id, mode, sx: e.clientX, sy: e.clientY, o: { ...o }, group, origs };
  document.body.classList.add('wdragging');
}
function winMove(e) {
  for (const c of [WIN, WING]) {
    const d = c.drag;
    if (!d) continue;
    const s = winStage(c).getBoundingClientRect();
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.mode === 'resize') {
      const o = c.lay[d.id];
      o.w = Math.round(Math.max(180, Math.min(s.width - d.o.x, d.o.w + dx)));
      o.h = Math.round(Math.max(120, Math.min(s.height - d.o.y, d.o.h + dy)));
      winApply(c);
      continue;
    }
    let x = d.o.x + dx, y = d.o.y + dy;
    const w = d.o.w, h = d.o.h, M = 10;
    // магнит к краям и к соседним окнам
    const xs = [0, s.width], ys = [0, s.height];
    for (const k of Object.keys(c.lay)) {
      if (d.group.includes(k) || !c.exists(k) || c.min[k] || c.pops[k]) continue;
      const o = c.lay[k];
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
    for (const g of d.group) { c.lay[g].x = d.origs[g].x + (x - d.o.x); c.lay[g].y = d.origs[g].y + (y - d.o.y); }
    winApply(c);
  }
}
function winUp() {
  for (const c of [WIN, WING]) {
    if (!c.drag) continue;
    c.drag = null;
    winSave(c);
  }
  document.body.classList.remove('wdragging');
}

/* ---------- кнопки окна ---------- */
function winAction(c, id, a) {
  if (a === 'min') { winSetMinIn(c, id, true); return; }
  if (a === 'pop') { if (c.pops[id]) winUnpop(c, id); else if (winFree()) winPop(c, id); return; }
  if (!winFree() || !c.lay) return;
  const o = c.lay[id];
  if (a === 'pin') o.pin = !o.pin;
  else if (a === 'link') {
    if (o.link) o.link = null;
    else {
      // к окну, на котором лежит (или к ближайшему)
      let best = null, bestScore = -Infinity;
      for (const k of Object.keys(c.lay)) {
        if (k === id || !c.exists(k) || c.min[k] || c.pops[k] || winFollowers(c, id).includes(k)) continue;
        const p = c.lay[k];
        const ix = Math.max(0, Math.min(o.x + o.w, p.x + p.w) - Math.max(o.x, p.x));
        const iy = Math.max(0, Math.min(o.y + o.h, p.y + p.h) - Math.max(o.y, p.y));
        const score = ix * iy * 10 - Math.hypot(o.x + o.w / 2 - p.x - p.w / 2, o.y + o.h / 2 - p.y - p.h / 2);
        if (score > bestScore) { bestScore = score; best = k; }
      }
      if (!best) { toast('Не к чему прицепить — нет других открытых окон'); return; }
      o.link = best;
      winFront(c, best);
    }
  }
  winSave(c);
  winApply(c);
}

// свернуть: окно (и прицепленные к нему) — в кнопку внизу; у демонстрации/участников пропадает звук экрана
function winSetMinIn(c, id, v) {
  if (v && document.fullscreenElement && winEl(c, id)?.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
  const extra = winFree() && c.lay ? winFollowers(c, id) : (c === WIN && id === 'screen' ? ['cam'] : []);
  for (const k of [id, ...extra]) c.min[k] = v;
  if (!v && winFree()) winFront(c, id);
  winRefresh(c);
}
function winSetMin(id, v) { winSetMinIn(WIN, id, v); }

function winRefresh(c) {
  const stage = winStage(c);
  if (!stage) return;
  for (const id of c.ids) winEl(c, id)?.classList.toggle('wmin', !!c.min[id] && !c.pops[id]);
  const chatId = c === WIN ? 'chat' : 'gchat';
  stage.classList.toggle('chat-min', !!c.min[chatId] && !c.pops[chatId]);
  stage.classList.toggle('chat-out', !!c.pops[chatId]);
  if (c === WIN) {
    const v = $('remoteScreen');
    if (v) v.muted = S.deafened || !!c.min.screen;
  } else if (typeof grpApplyScreenVols === 'function') grpApplyScreenVols();
  if (c.dock) {
    c.dock.replaceChildren();
    for (const id of c.ids) {
      if (!c.min[id] || !c.exists(id)) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wchip';
      b.title = 'Развернуть';
      b.innerHTML = '<span></span><small>звук выкл</small>';
      b.firstChild.textContent = c.names[id];
      if (id !== c.sound) b.querySelector('small').remove();
      else if (c === WING) b.querySelector('small').textContent = 'звук экранов выкл';
      b.onclick = () => winSetMinIn(c, id, false);
      c.dock.appendChild(b);
    }
  }
  if (winFree()) winApply(c);
}
function winLayoutChanged() { winRefresh(WIN); }
window.winLayoutChanged = winLayoutChanged;

// новый звонок — всё развёрнуто
function winResetCall(c = WIN) {
  c.min = {};
  for (const id of Object.keys(c.pops)) winUnpop(c, id);
  winRefresh(c);
}
// экран группы показан — разложить окна (до этого размеры были нулевые)
function winGroupShown() { winResetCall(WING); if (winFree()) winApply(WING); }

/* ---------- отдельное окно Windows ---------- */
function winPop(c, id) {
  const el = winEl(c, id);
  const r = el.getBoundingClientRect();
  const w = window.open('', 'alc-pop-' + id, `width=${Math.round(r.width)},height=${Math.round(r.height)}`);
  if (!w) { toast('Отдельное окно не открылось'); return; }
  const d = w.document;
  d.open();
  d.write('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body class="popbody"></body></html>');
  d.close();
  d.title = 'alloconnect — ' + c.names[id];
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) { const n = d.createElement('link'); n.rel = 'stylesheet'; n.href = l.href; d.head.appendChild(n); }
  if (document.documentElement.dataset.theme) d.documentElement.dataset.theme = document.documentElement.dataset.theme;
  d.documentElement.className = document.documentElement.className;
  const mark = document.createComment('pop-' + id);
  el.parentNode.insertBefore(mark, el);
  c.pops[id] = { w, mark };
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
  w.addEventListener('pagehide', () => { if (c.pops[id]?.w === w) winUnpop(c, id, true); });
  winRefresh(c);
}
function winUnpop(c, id, closed) {
  const p = c.pops[id];
  if (!p) return;
  delete c.pops[id];
  const el = p.w.document?.getElementById(c.elId[id]) || null;
  if (el) { p.mark.parentNode.insertBefore(document.adoptNode(el), p.mark); el.classList.remove('popped'); for (const v of el.querySelectorAll('video')) v.play?.().catch(() => {}); }
  p.mark.remove();
  if (!closed) try { p.w.close(); } catch { /* */ }
  winRefresh(c);
}
// элементы вынесенного окна должны находиться обычным $()
function winLookup(id) {
  for (const c of [WCTX.call, WCTX.group]) for (const p of Object.values(c.pops)) { const el = p.w.document?.getElementById(id); if (el) return el; }
  return null;
}

winBind();
