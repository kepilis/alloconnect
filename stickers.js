'use strict';
/* =========================================================
   Стикеры (1.21): свои наборы картинок и гифок. Хранит main (stickers-*), здесь — панель выбора у полей ввода
   (звонок, группа, чат без звонка) и раздел в настройках. Стикер уходит обычной картинкой с пометкой st: 1 —
   новые версии показывают его без плашки файла, старые — как картинку.
   Картинки грузятся по мере прокрутки (IntersectionObserver) — наборы на тысячи гифок не тормозят.
   ========================================================= */
const STK = { data: null, urls: new Map(), pack: null, ctx: null, io: null, editing:false, selected:new Set(), copied:null };
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
function stkClose() { $('stickerPicker').classList.add('hidden'); $('stkContext').classList.add('hidden'); STK.editing=false;STK.selected.clear();$('stickerPicker').classList.remove('editing');$('stkEditBar').classList.add('hidden');$('stkEditToggle').textContent='Редактировать'; }

function stkEditMode(on){STK.editing=!!on;STK.selected.clear();$('stickerPicker').classList.toggle('editing',STK.editing);$('stkEditBar').classList.toggle('hidden',!STK.editing);$('stkEditToggle').textContent=STK.editing?'Готово':'Редактировать';$('stkContext').classList.add('hidden');stkRender()}
function stkSelection(){const n=STK.selected.size;$('stkCopy').disabled=!n;$('stkDeleteSelected').disabled=!n;$('stkDeleteSelected').textContent=`Удалить (${n})`;for(const b of $('stkGrid').querySelectorAll('.stk-item')){const on=STK.selected.has(b.dataset.id);b.classList.toggle('selected',on);b.setAttribute('aria-selected',String(on))}}
function stkSelect(id,add=false){if(!add)STK.selected.clear();if(add&&STK.selected.has(id))STK.selected.delete(id);else STK.selected.add(id);stkSelection()}
async function stkEditItems(action,ids=[...STK.selected],target='',name=''){
  if(!ids.length)return;
  if(action==='delete'&&!confirm(`Удалить стикеры: ${ids.length}?`))return;
  try{const r=await window.duo.stickersItemsEdit(STK.pack,ids,action,target,name);STK.selected.clear();stkInvalidate();toast(`${action==='delete'?'Удалено':action==='copy'?'Скопировано':action==='move'?'Перемещено':'Изменено'}: ${r.count}`)}catch(e){toast(e.message||String(e))}
}
function stkContext(x,y,id){
  const menu=$('stkContext');menu.replaceChildren();const pack=STK.data?.packs.find(p=>p.id===STK.pack),it=pack?.items.find(i=>i.id===id);if(!it)return;
  if(STK.editing&&!STK.selected.has(id)){STK.selected.clear();STK.selected.add(id);stkSelection()}
  const ids=STK.editing?[...STK.selected]:[id];
  const add=(label,fn)=>{const b=document.createElement('button');b.type='button';b.className='sp-context-item';b.textContent=label;b.onclick=()=>{menu.classList.add('hidden');Promise.resolve(fn()).catch(e=>toast(e.message||String(e)))};menu.appendChild(b)};
  const h=document.createElement('b');h.className='sp-context-heading';h.textContent=STK.editing?`${ids.length} выбрано`:it.name;menu.appendChild(h);
  if(STK.editing){add('Копировать',()=>{STK.copied={pack:STK.pack,ids:[...ids]};toast('Стикеры скопированы')});add('Вставить',stkPaste);if(ids.length===1)add('Переименовать',()=>{const name=prompt('Название стикера',it.name)?.trim();if(name)stkEditItems('rename',ids,'',name)});for(const p of STK.data.packs)if(p.id!==STK.pack)add('Переместить в «'+p.name+'»',()=>stkEditItems('move',ids,p.id));add('Удалить',()=>stkEditItems('delete',ids))}
  else{add('Отправить',()=>stkSend(STK.pack,it));add('Удалить',()=>stkEditItems('delete',[id]))}
  menu.classList.remove('hidden');menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
}
async function stkPaste(){if(!STK.copied){toast('Сначала скопируй стикеры');return}try{const r=await window.duo.stickersItemsEdit(STK.copied.pack,STK.copied.ids,'copy',STK.pack);stkInvalidate();toast(`Вставлено стикеров: ${r.count}`)}catch(e){toast(e.message||String(e))}}

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
    b.onclick = () => { STK.pack = p.id;STK.selected.clear();stkRender(); };
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
    b.onclick = () => {if(!STK.editing)stkSend(pack.id,it)};
    b.onkeydown=e=>{if(STK.editing&&(e.key==='Enter'||e.key===' ')){e.preventDefault();stkSelect(it.id,e.ctrlKey||e.metaKey)}};
    b.oncontextmenu = (e) => { e.preventDefault();stkContext(e.clientX,e.clientY,it.id) };
    grid.appendChild(b);
    STK.io.observe(b);
  }
  stkSelection();
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
  $('stkEditToggle').onclick=()=>stkEditMode(!STK.editing);
  $('stkCreatePack').onclick=async()=>{const name=prompt('Название нового набора')?.trim();if(!name)return;try{const p=await window.duo.stickersPackCreate(name);STK.pack=p.id;stkInvalidate()}catch(e){toast(e.message||String(e))}};
  $('stkCopy').onclick=()=>{STK.copied={pack:STK.pack,ids:[...STK.selected]};toast('Стикеры скопированы')};
  $('stkPaste').onclick=stkPaste;$('stkDeleteSelected').onclick=()=>stkEditItems('delete');
  let drag=null;const grid=$('stkGrid'),box=document.createElement('div');box.className='sp-selection-box hidden';document.body.appendChild(box);
  grid.addEventListener('pointerdown',e=>{if(!STK.editing||e.button!==0)return;drag={x:e.clientX,y:e.clientY,id:e.target.closest('.stk-item')?.dataset.id||null,add:e.ctrlKey||e.metaKey,base:new Set(e.ctrlKey||e.metaKey?STK.selected:[]),moved:false};e.preventDefault()});
  window.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<5)return;drag.moved=true;const left=Math.min(drag.x,e.clientX),top=Math.min(drag.y,e.clientY),right=Math.max(drag.x,e.clientX),bottom=Math.max(drag.y,e.clientY);Object.assign(box.style,{left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px'});box.classList.remove('hidden');STK.selected.clear();for(const id of drag.base)STK.selected.add(id);for(const tile of grid.querySelectorAll('.stk-item')){const r=tile.getBoundingClientRect();if(r.left<right&&r.right>left&&r.top<bottom&&r.bottom>top)STK.selected.add(tile.dataset.id);tile.classList.toggle('selected',STK.selected.has(tile.dataset.id))}e.preventDefault()});
  window.addEventListener('pointerup',e=>{if(!drag)return;const d=drag;drag=null;box.classList.add('hidden');if(d.moved){stkSelection();return}if(d.id)stkSelect(d.id,d.add);else if(!d.add){STK.selected.clear();stkSelection()}e.preventDefault()});
  document.addEventListener('keydown',e=>{if(!STK.editing||$('stickerPicker').classList.contains('hidden')||e.target.closest?.('input,textarea,[contenteditable]'))return;if(e.key==='Delete'&&STK.selected.size){e.preventDefault();stkEditItems('delete')}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'&&STK.selected.size){e.preventDefault();STK.copied={pack:STK.pack,ids:[...STK.selected]};toast('Стикеры скопированы')}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v'){e.preventDefault();stkPaste()}},true);
  $('stkSetAddFiles').onclick = () => stkImport('files');
  $('stkSetAddFolder').onclick = () => stkImport('folder');
  document.addEventListener('mousedown', (e) => { const p = $('stickerPicker'); if (!p.classList.contains('hidden') && !p.contains(e.target) && !$('stkContext').contains(e.target) && !e.target.closest?.('.stk-btn')) stkClose();if(!$('stkContext').contains(e.target))$('stkContext').classList.add('hidden') });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('stickerPicker').classList.contains('hidden')) stkClose(); });
  renderStkSettings();
}
stkBind();
