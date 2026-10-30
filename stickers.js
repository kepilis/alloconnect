'use strict';
/* =========================================================
   Стикеры (1.21): свои наборы картинок и гифок. Хранит main (stickers-*), здесь — панель выбора у полей ввода
   (звонок, группа, чат без звонка) и раздел в настройках. Стикер уходит обычной картинкой с пометкой st: 1 —
   новые версии показывают его без плашки файла, старые — как картинку.
   Картинки грузятся по мере прокрутки (IntersectionObserver) — наборы на тысячи гифок не тормозят.
   ========================================================= */
const STK = { data: null, urls: new Map(), pack: null, ctx: null, io: null };
function stkInvalidate() { STK.data = null; for (const u of STK.urls.values()) URL.revokeObjectURL(u); STK.urls.clear(); if (!$('stickerPicker').classList.contains('hidden')) stkRender(); renderStkSettings(); }
async function stkLoad() { if (!STK.data) STK.data = await window.duo.stickersList().catch(() => ({ packs: [] })); return STK.data; }
async function stkUrl(pack, id) {
  const k = pack + '|' + id;
  if (STK.urls.has(k)) return STK.urls.get(k);
  const r = await window.duo.stickersGet(pack, id);
  if (!r) return null;
  const u = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }));
  STK.urls.set(k, u);
  return u;
}

// куда шлём: звонок на двоих, группа или чат без звонка (по открытому полю)
async function stkSend(pack, item) {
  const r = await window.duo.stickersGet(pack, item.id);
  if (!r) { toast('Стикер не найден'); return; }
  const f = new File([r.bytes], (item.name || 'стикер') + '.' + item.ext, { type: r.mime });
  const extra = { st: 1 };
  if (STK.ctx === 'dm') dmSendFiles([f], extra);
  else queueFiles([f], 'chat', extra);
  stkClose();
}

function stkOpen(ctx, anchor) {
  STK.ctx = ctx;
  const p = $('stickerPicker');
  const r = anchor.getBoundingClientRect();
  p.classList.remove('hidden');
  const w = Math.min(380, window.innerWidth - 16);
  p.style.width = w + 'px';
  p.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  p.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  stkRender();
}
function stkClose() { $('stickerPicker').classList.add('hidden'); }

async function stkRender() {
  const d = await stkLoad();
  const tabs = $('stkTabs'), grid = $('stkGrid');
  tabs.replaceChildren();
  grid.replaceChildren();
  STK.io?.disconnect();
  if (!d.packs.length) {
    const p = document.createElement('div');
    p.className = 'stk-empty muted small';
    p.textContent = 'Стикеров пока нет. Добавь картинки или гифки — по одной или целой папкой (каждая подпапка станет набором).';
    grid.appendChild(p);
    return;
  }
  if (!d.packs.some((p) => p.id === STK.pack)) STK.pack = d.packs[0].id;
  for (const p of d.packs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stk-tab' + (p.id === STK.pack ? ' on' : '');
    b.textContent = p.name;
    b.title = `${p.name} — ${p.items.length}`;
    b.onclick = () => { STK.pack = p.id; stkRender(); };
    tabs.appendChild(b);
  }
  const pack = d.packs.find((p) => p.id === STK.pack);
  STK.io = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting) continue;
      STK.io.unobserve(e.target);
      stkUrl(pack.id, e.target.dataset.id).then((u) => { if (u) e.target.querySelector('img').src = u; });
    }
  }, { root: grid, rootMargin: '120px' });
  for (const it of pack.items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stk-item';
    b.dataset.id = it.id;
    b.title = it.name || '';
    const img = document.createElement('img');
    img.alt = it.name || '';
    img.draggable = false;
    b.appendChild(img);
    b.onclick = () => stkSend(pack.id, it);
    b.oncontextmenu = async (e) => { e.preventDefault(); if (confirm('Убрать этот стикер из набора?')) { await window.duo.stickersDel(pack.id, it.id); stkInvalidate(); } };
    grid.appendChild(b);
    STK.io.observe(b);
  }
}

async function stkImport(mode) {
  const r = await window.duo.stickersPick(mode);
  if (!r) return;
  stkInvalidate();
  toast(r.added ? `Добавлено стикеров: ${r.added}${r.packs > 1 ? ` (наборов: ${r.packs})` : ''}${r.skipped ? `, пропущено: ${r.skipped}` : ''}` : 'Картинок и гифок не нашлось');
}

// раздел «Стикеры» в настройках: наборы, сколько в каждом, удалить
async function renderStkSettings() {
  const box = $('stkSettingsList');
  if (!box) return;
  const d = await stkLoad();
  box.replaceChildren();
  if (!d.packs.length) { const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'Наборов пока нет.'; box.appendChild(p); return; }
  for (const p of d.packs) {
    const row = document.createElement('div');
    row.className = 'stk-pack-row';
    const nm = document.createElement('span');
    nm.textContent = `${p.name} · ${p.items.length}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small danger-btn';
    del.textContent = 'Удалить';
    del.onclick = async () => { if (confirm(`Удалить набор «${p.name}» (${p.items.length} шт.)?`)) { await window.duo.stickersDelPack(p.id); stkInvalidate(); } };
    row.append(nm, del);
    box.appendChild(row);
  }
}

function stkBind() {
  // кнопка у каждого поля ввода — рядом со скрепкой
  for (const [ctx, attachId] of [['call', 'btnAttach'], ['group', 'gAttach'], ['dm', 'dmAttach']]) {
    const a = $(attachId);
    if (!a) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn attach stk-btn';
    b.title = 'Стикеры';
    b.textContent = '🙂';
    b.onclick = (e) => { e.stopPropagation(); if (!$('stickerPicker').classList.contains('hidden') && STK.ctx === ctx) stkClose(); else stkOpen(ctx, b); };
    a.after(b);
  }
  $('stkAddFiles').onclick = () => stkImport('files');
  $('stkAddFolder').onclick = () => stkImport('folder');
  $('stkSetAddFiles').onclick = () => stkImport('files');
  $('stkSetAddFolder').onclick = () => stkImport('folder');
  document.addEventListener('mousedown', (e) => { const p = $('stickerPicker'); if (!p.classList.contains('hidden') && !p.contains(e.target) && !e.target.closest?.('.stk-btn')) stkClose(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('stickerPicker').classList.contains('hidden')) stkClose(); });
  renderStkSettings();
}
stkBind();
