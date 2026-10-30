'use strict';
/* Окно своих уведомлений (1.21): карточки в стиле темы — аватарка (гифки играют), ник, текст, картинка/гифка.
   Данные приходят из main (notifyWin), клик — открыть программу (и переписку), × — закрыть. */
const MAX = 4;
const live = new Map(); // id → { el, timer, left, started }

function blobUrl(x) { return x?.bytes ? URL.createObjectURL(new Blob([x.bytes], { type: x.mime || 'image/png' })) : null; }

function fit() { requestAnimationFrame(() => window.ntf.size(document.body.scrollHeight, live.size)); }

function close(id, clicked) {
  const n = live.get(id);
  if (!n) return;
  live.delete(id);
  clearTimeout(n.timer);
  n.el.classList.add('out');
  setTimeout(() => { for (const u of n.urls) URL.revokeObjectURL(u); n.el.remove(); fit(); }, 200);
  if (clicked) window.ntf.click(n.data);
}

function arm(n) {
  clearTimeout(n.timer);
  n.started = Date.now();
  const bar = n.el.querySelector('.nt-bar');
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  requestAnimationFrame(() => { bar.style.transition = `transform ${n.left}ms linear`; bar.style.transform = 'scaleX(0)'; });
  n.timer = setTimeout(() => close(n.id), n.left);
}

window.ntf.onShow((d) => {
  if (d.theme) document.documentElement.dataset.theme = d.theme; else delete document.documentElement.dataset.theme;
  document.documentElement.classList.toggle('no-stream-frame', false);
  // тот же разговор — заменяем карточку, а не копим
  for (const [id, n] of live) if (d.key && n.data.key === d.key) close(id);
  while (live.size >= MAX) close(live.keys().next().value);
  const el = document.createElement('div');
  el.className = 'nt' + (d.kind === 'call' ? ' call' : '');
  const urls = [];
  const av = document.createElement('div');
  av.className = 'nt-av';
  const au = blobUrl(d.avatar);
  if (au) { urls.push(au); const im = document.createElement('img'); im.src = au; im.alt = ''; av.appendChild(im); } else av.textContent = (d.title || '?').trim().charAt(0).toUpperCase() || '?';
  const main = document.createElement('div');
  main.className = 'nt-main';
  const t = document.createElement('div');
  t.className = 'nt-title';
  t.textContent = d.title || 'alloconnect';
  const b = document.createElement('div');
  b.className = 'nt-body';
  b.textContent = d.body || '';
  main.append(t, b);
  const mu = blobUrl(d.media);
  if (mu) { urls.push(mu); const im = document.createElement('img'); im.className = 'nt-media'; im.src = mu; im.alt = ''; im.onload = fit; main.appendChild(im); }
  const x = document.createElement('button');
  x.className = 'nt-x';
  x.textContent = '✕';
  x.title = 'Закрыть';
  const bar = document.createElement('i');
  bar.className = 'nt-bar';
  el.append(av, main, x, bar);
  document.body.appendChild(el);
  const n = { id: d.id, el, data: d, urls, left: d.kind === 'call' ? 25000 : 7000, timer: null };
  live.set(d.id, n);
  x.onclick = (e) => { e.stopPropagation(); close(d.id); };
  el.onclick = () => close(d.id, true);
  // пока мышь на карточке — не исчезает
  el.onmouseenter = () => { clearTimeout(n.timer); const bar2 = el.querySelector('.nt-bar'); bar2.style.transition = 'none'; bar2.style.transform = 'scaleX(1)'; };
  el.onmouseleave = () => { n.left = 4000; arm(n); };
  arm(n);
  fit();
});
window.ntf.onClose((key) => { for (const [id, n] of live) if (n.data.key === key) close(id); });
