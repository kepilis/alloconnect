'use strict';
/* =========================================================
   Уменьшение гифки для аватарки: квадрат по центру, меньший размер, общая палитра.
   Кадры читаем встроенным ImageDecoder (Chromium), собираем GIF своим кодером (LZW как в omggif).
   shrinkGif(file, maxBytes) → Uint8Array (GIF) или null, если не вышло.
   ========================================================= */
(function (root) {
  const SIDES = [200, 160, 128, 96, 72];

  async function readFrames(file, type) {
    if (!root.ImageDecoder) return null;
    const dec = new root.ImageDecoder({ data: await file.arrayBuffer(), type });
    await dec.tracks.ready;
    const n = Math.min(dec.tracks.selectedTrack?.frameCount || 1, 300);
    const frames = [];
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const bmp = await createImageBitmap(image);
      frames.push({ bmp, ms: Math.max(20, Math.round((image.duration || 100000) / 1000)) });
      image.close();
    }
    dec.close();
    return frames;
  }

  // не больше ~120 кадров: лишние склеиваем с соседями (длительность суммируется)
  function thin(frames, max) {
    if (frames.length <= max) return frames;
    const step = frames.length / max;
    const out = [];
    for (let i = 0; i < max; i++) {
      const a = Math.floor(i * step), b = Math.floor((i + 1) * step);
      let ms = 0;
      for (let j = a; j < b; j++) ms += frames[j].ms;
      out.push({ bmp: frames[a].bmp, ms });
    }
    return out;
  }

  function pixels(frames, side) {
    const c = new OffscreenCanvas(side, side);
    const g = c.getContext('2d', { willReadFrequently: true });
    return frames.map((f) => {
      const s = Math.min(f.bmp.width, f.bmp.height);
      g.clearRect(0, 0, side, side);
      g.drawImage(f.bmp, (f.bmp.width - s) / 2, (f.bmp.height - s) / 2, s, s, 0, 0, side, side);
      return { px: g.getImageData(0, 0, side, side).data, ms: f.ms };
    });
  }

  // общая палитра: 255 самых частых цветов (по 5 бит на канал), индекс 255 — прозрачный
  function palette(list) {
    const hist = new Uint32Array(32768);
    for (const { px } of list) {
      for (let i = 0; i < px.length; i += 8) { // каждый второй пиксель — хватает
        if (px[i + 3] < 128) continue;
        hist[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
      }
    }
    const keys = [];
    for (let k = 0; k < 32768; k++) if (hist[k]) keys.push(k);
    keys.sort((a, b) => hist[b] - hist[a]);
    const pal = keys.slice(0, 255).map((k) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4]);
    while (pal.length < 255) pal.push([0, 0, 0]);
    return pal;
  }

  function indexer(pal) {
    const cache = new Int16Array(32768).fill(-1);
    return (r, g, b) => {
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let v = cache[k];
      if (v >= 0) return v;
      let best = 0, bd = Infinity;
      for (let i = 0; i < 255; i++) {
        const p = pal[i];
        const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cache[k] = best;
      return best;
    };
  }

  class Out {
    constructor() { this.buf = new Uint8Array(1 << 20); this.n = 0; }
    byte(b) { if (this.n >= this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; } this.buf[this.n++] = b; }
    u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
    str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
    done() { return this.buf.slice(0, this.n); }
  }

  // LZW-сжатие кадра (минимальный размер кода 8), данные — блоками по 255 байт
  function lzw(out, idx) {
    const MIN = 8, CLEAR = 256, EOI = 257;
    out.byte(MIN);
    let blk = [];
    let acc = 0, bits = 0;
    const flush = () => { if (blk.length) { out.byte(blk.length); for (const b of blk) out.byte(b); blk = []; } };
    const emit = (code, size) => {
      acc |= code << bits;
      bits += size;
      while (bits >= 8) { blk.push(acc & 255); if (blk.length === 255) flush(); acc >>>= 8; bits -= 8; }
    };
    let size = MIN + 1, next = EOI + 1;
    let table = new Map();
    emit(CLEAR, size);
    let cur = idx[0];
    for (let i = 1; i < idx.length; i++) {
      const k = idx[i];
      const key = (cur << 8) | k;
      const hit = table.get(key);
      if (hit !== undefined) { cur = hit; continue; }
      emit(cur, size);
      if (next === 4096) {
        emit(CLEAR, size);
        next = EOI + 1; size = MIN + 1; table = new Map();
      } else {
        if (next >= (1 << size)) size++;
        table.set(key, next++);
      }
      cur = k;
    }
    emit(cur, size);
    emit(EOI, size);
    if (bits > 0) blk.push(acc & 255);
    flush();
    out.byte(0);
  }

  function encode(list, side, H = side) {
    const W = side;
    const pal = palette(list);
    const near = indexer(pal);
    const o = new Out();
    o.str('GIF89a');
    o.u16(W); o.u16(H);
    o.byte(0xF7); o.byte(255); o.byte(0); // общая палитра на 256 цветов, фон — прозрачный индекс
    for (const p of pal) { o.byte(p[0]); o.byte(p[1]); o.byte(p[2]); }
    o.byte(0); o.byte(0); o.byte(0); // 255 — прозрачный
    o.byte(0x21); o.byte(0xFF); o.byte(11); o.str('NETSCAPE2.0'); o.byte(3); o.byte(1); o.u16(0); o.byte(0); // повтор без конца
    const idx = new Uint8Array(W * H);
    for (const { px, ms } of list) {
      for (let i = 0, j = 0; j < idx.length; i += 4, j++) idx[j] = px[i + 3] < 128 ? 255 : near(px[i], px[i + 1], px[i + 2]);
      // кадр целиком; перед следующим — очистка до фона (иначе прозрачные места накапливают старое)
      o.byte(0x21); o.byte(0xF9); o.byte(4); o.byte((2 << 2) | 1); o.u16(Math.max(2, Math.round(ms / 10))); o.byte(255); o.byte(0);
      o.byte(0x2C); o.u16(0); o.u16(0); o.u16(W); o.u16(H); o.byte(0);
      lzw(o, idx);
    }
    o.byte(0x3B);
    return o.done();
  }

  // type — формат исходника: гифка, а также анимированные WebP/PNG (их «гифки без фона» из браузера) — на выходе всегда GIF
  async function shrinkGif(file, maxBytes, type = 'image/gif') {
    let frames;
    try { frames = await readFrames(file, type); } catch { return null; }
    if (!frames?.length) return null;
    try {
      for (const max of [120, 60]) {
        const fr = thin(frames, max);
        for (const side of SIDES) {
          const gif = encode(pixels(fr, side), side);
          if (gif.length <= maxBytes) return gif;
        }
      }
      return null;
    } finally { for (const f of frames) f.bmp.close(); }
  }

  // формат по содержимому, а не по типу файла (из браузера тип бывает пустой или неверный):
  // { mime, animated } или null — не картинка
  function sniffImage(b) {
    const s = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
    if (b.length < 12) return null;
    if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return { mime: 'image/gif', animated: true };
    if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') {
      // анимация — чанк ANIM (или флаг анимации в VP8X)
      const vp8x = s(12, 4) === 'VP8X' && (b[20] & 0x02);
      let anim = !!vp8x;
      for (let i = 12; !anim && i + 8 < b.length;) { const id = s(i, 4); const len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24); if (id === 'ANIM' || id === 'ANMF') anim = true; i += 8 + len + (len & 1); }
      return { mime: 'image/webp', animated: anim };
    }
    if (b[0] === 0x89 && s(1, 3) === 'PNG') {
      let anim = false;
      for (let i = 8; i + 8 < b.length;) { const len = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0; const id = s(i + 4, 4); if (id === 'acTL') { anim = true; break; } if (id === 'IDAT') break; i += 12 + len; }
      return { mime: 'image/png', animated: anim };
    }
    if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', animated: false };
    if (s(0, 2) === 'BM') return { mime: 'image/bmp', animated: false };
    return null;
  }

  /* ---------- «Убрать фон» (1.21): однотонный фон по краям становится прозрачным ----------
     Цвет фона — самый частый цвет рамки картинки; заливка от краёв по похожим цветам (допуск tol).
     Работает без интернета и для гифок (каждый кадр). Сложный фон (фото, градиент) так не убрать. */
  function bgColor(px, w, h) {
    const cnt = new Map();
    const add = (i) => { if (px[i + 3] < 128) return; const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4); cnt.set(k, (cnt.get(k) || 0) + 1); };
    for (let x = 0; x < w; x++) { add(x * 4); add(((h - 1) * w + x) * 4); }
    for (let y = 0; y < h; y++) { add(y * w * 4); add((y * w + w - 1) * 4); }
    let best = -1, n = 0;
    for (const [k, v] of cnt) if (v > n) { n = v; best = k; }
    if (best < 0) return null;
    return [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8];
  }
  function clearBg(px, w, h, tol, ref) {
    const c = ref || bgColor(px, w, h);
    if (!c) return 0;
    const t2 = tol * tol;
    const near = (i) => px[i + 3] < 128 || ((px[i] - c[0]) ** 2 + (px[i + 1] - c[1]) ** 2 + (px[i + 2] - c[2]) ** 2) <= t2;
    const seen = new Uint8Array(w * h);
    const stack = [];
    const push = (p) => { if (!seen[p] && near(p * 4)) { seen[p] = 1; stack.push(p); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    let n = 0;
    while (stack.length) {
      const p = stack.pop();
      px[p * 4 + 3] = 0; n++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    // край: полупрозрачные соседи вырезанного — мягче
    for (let p = 0; p < w * h; p++) {
      if (seen[p]) continue;
      const x = p % w, y = (p / w) | 0;
      if ((x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || (y > 0 && seen[p - w]) || (y < h - 1 && seen[p + w])) px[p * 4 + 3] = Math.min(px[p * 4 + 3], 200);
    }
    return n / (w * h);
  }
  // file → { blob, share } (share — какая доля картинки стала прозрачной) или null
  async function removeBg(file, type, tol = 40, maxSide = 640) {
    const animated = (type === 'image/gif' || type === 'image/webp' || type === 'image/png') && root.ImageDecoder;
    let frames = null;
    if (animated) { try { frames = await readFrames(file, type); } catch { frames = null; } }
    if (!frames || frames.length <= 1) {
      const bmp = frames?.[0]?.bmp || await createImageBitmap(file);
      const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      const d = g.getImageData(0, 0, w, h);
      const share = clearBg(d.data, w, h, tol);
      g.putImageData(d, 0, 0);
      return { blob: await c.convertToBlob({ type: 'image/png' }), share };
    }
    try {
      const fr = thin(frames, 120);
      const b0 = fr[0].bmp;
      const k = Math.min(1, maxSide / Math.max(b0.width, b0.height));
      const w = Math.round(b0.width * k), h = Math.round(b0.height * k);
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      let ref = null, share = 0;
      const list = fr.map((f) => {
        g.clearRect(0, 0, w, h);
        g.drawImage(f.bmp, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h);
        ref ??= bgColor(d.data, w, h); // один цвет фона на всю гифку — кадры не мигают
        share = Math.max(share, clearBg(d.data, w, h, tol, ref));
        return { px: d.data, ms: f.ms };
      });
      return { blob: new Blob([encode(list, w, h)], { type: 'image/gif' }), share };
    } finally { for (const f of frames) f.bmp.close(); }
  }

  /* «Убрать фон» нейросетью (1.22): kind — 'person' (человек) или 'object' (любой предмет). Маску кадра считает main (ai-mask),
     здесь — только кадры и сборка. onStep(i, n) — сколько кадров готово. */
  async function removeBgAi(file, type, kind, onStep, maxSide = 512) {
    const animated = (type === 'image/gif' || type === 'image/webp' || type === 'image/png') && root.ImageDecoder;
    let frames = null;
    if (animated) { try { frames = await readFrames(file, type); } catch { frames = null; } }
    const still = !frames || frames.length <= 1;
    const src = still ? [{ bmp: frames?.[0]?.bmp || await createImageBitmap(file), ms: 100 }] : thin(frames, 90);
    try {
      const b0 = src[0].bmp;
      const k = Math.min(1, (still ? 1600 : maxSide) / Math.max(b0.width, b0.height));
      const w = Math.max(1, Math.round(b0.width * k)), h = Math.max(1, Math.round(b0.height * k));
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      const list = [];
      let kept = 0;
      for (let i = 0; i < src.length; i++) {
        g.clearRect(0, 0, w, h);
        g.drawImage(src[i].bmp, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h);
        const mask = await root.duo.aiMask(kind, new Uint8Array(d.data.buffer), w, h);
        let on = 0;
        for (let p = 0, j = 3; p < mask.length; p++, j += 4) { const a = Math.min(d.data[j], mask[p]); d.data[j] = a; if (a > 127) on++; }
        kept = Math.max(kept, on / mask.length);
        if (still) { g.putImageData(d, 0, 0); return { blob: await c.convertToBlob({ type: 'image/png' }), share: 1 - kept }; }
        list.push({ px: d.data, ms: src[i].ms });
        onStep?.(i + 1, src.length);
      }
      return { blob: new Blob([encode(list, w, h)], { type: 'image/gif' }), share: 1 - kept };
    } finally { for (const f of frames || src) f.bmp.close?.(); }
  }

  root.shrinkGif = shrinkGif;
  root.removeBg = removeBg;
  root.removeBgAi = removeBgAi;
  root.sniffImage = sniffImage;
})(typeof window !== 'undefined' ? window : globalThis);
