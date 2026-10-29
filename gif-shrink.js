'use strict';
/* =========================================================
   Уменьшение гифки для аватарки: квадрат по центру, меньший размер, общая палитра.
   Кадры читаем встроенным ImageDecoder (Chromium), собираем GIF своим кодером (LZW как в omggif).
   shrinkGif(file, maxBytes) → Uint8Array (GIF) или null, если не вышло.
   ========================================================= */
(function (root) {
  const SIDES = [200, 160, 128, 96, 72];

  async function readFrames(file) {
    if (!root.ImageDecoder) return null;
    const dec = new root.ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
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

  function encode(list, side) {
    const pal = palette(list);
    const near = indexer(pal);
    const o = new Out();
    o.str('GIF89a');
    o.u16(side); o.u16(side);
    o.byte(0xF7); o.byte(255); o.byte(0); // общая палитра на 256 цветов, фон — прозрачный индекс
    for (const p of pal) { o.byte(p[0]); o.byte(p[1]); o.byte(p[2]); }
    o.byte(0); o.byte(0); o.byte(0); // 255 — прозрачный
    o.byte(0x21); o.byte(0xFF); o.byte(11); o.str('NETSCAPE2.0'); o.byte(3); o.byte(1); o.u16(0); o.byte(0); // повтор без конца
    const idx = new Uint8Array(side * side);
    for (const { px, ms } of list) {
      for (let i = 0, j = 0; j < idx.length; i += 4, j++) idx[j] = px[i + 3] < 128 ? 255 : near(px[i], px[i + 1], px[i + 2]);
      // кадр целиком; перед следующим — очистка до фона (иначе прозрачные места накапливают старое)
      o.byte(0x21); o.byte(0xF9); o.byte(4); o.byte((2 << 2) | 1); o.u16(Math.max(2, Math.round(ms / 10))); o.byte(255); o.byte(0);
      o.byte(0x2C); o.u16(0); o.u16(0); o.u16(side); o.u16(side); o.byte(0);
      lzw(o, idx);
    }
    o.byte(0x3B);
    return o.done();
  }

  async function shrinkGif(file, maxBytes) {
    let frames;
    try { frames = await readFrames(file); } catch { return null; }
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

  root.shrinkGif = shrinkGif;
})(typeof window !== 'undefined' ? window : globalThis);
