'use strict';

// One ordered channel carries the invitation, accepted replay and playback commands.
// The inviter orders playback changes from both participants.
window.watchTogether = (() => {
  const $ = id => document.getElementById(id);
  const limit = 224 * 1024 * 1024;
  const chunk = 16384;
  let channel, capable = false, session;
  const dialog = $('watchDialog'), video = $('watchVideo'), ink = $('watchInk');
  const clock = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  const status = value => { $('watchStatus').textContent = value; };

  function end(message, notify = true) {
    const s = session;
    if (!s) return;
    if (notify && channel?.readyState === 'open') {
      try { channel.send(JSON.stringify({ op: 'end', id: s.id })); } catch {}
    }
    session = null;
    clearTimeout(s.timer);
    clearInterval(s.pulse);
    video.onloadedmetadata = video.onerror = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (s.url) URL.revokeObjectURL(s.url);
    dialog.close();
    if (message) toast(message);
  }
  function reset() {
    end('', false);
    if (channel) {
      channel.onmessage = channel.onclose = channel.onerror = channel.onopen = null;
      channel.close();
    }
    channel = null;
    capable = false;
    $('clipWatch').disabled = true;
  }
  function attach(pc) {
    reset();
    const dc = pc.createDataChannel('watch-together-v1', { negotiated: true, id: 12, ordered: true });
    channel = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => dc.send(JSON.stringify({ op: 'hello' }));
    dc.onclose = dc.onerror = () => { if (channel === dc) { end('Связь для просмотра закрыта', false); reset(); } };
    dc.onmessage = e => {
      if (channel !== dc) return;
      try {
        if (typeof e.data === 'string') receive(JSON.parse(e.data));
        else receiveBytes(e.data);
      } catch { end('Не удалось прочитать данные повтора'); }
    };
  }
  function send(op, fields = {}) {
    channel.send(JSON.stringify({ id: session.id, op, ...fields }));
  }
  function deadline(s, ms = 60000) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { if (session === s) end('Время ожидания совместного просмотра истекло'); }, ms);
  }
  function open(id, host, size, time) {
    session = { id, host, size, time, phase: 'invite', frames: [], parts: [], bytes: 0, marks: [], playing: false };
    $('watchPlayer').hidden = true;
    $('watchAccept').hidden = host;
    $('watchExit').textContent = host ? 'Отменить' : 'Отклонить';
    dialog.showModal();
    deadline(session);
    return session;
  }
  function frameAt(frames, t) {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid] <= t + 0.00001) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }
  function frameTime(frames, i) {
    const k = Math.max(0, Math.min(frames.length - 1, i));
    return frames[k] + Math.min(.001, ((frames[k + 1] ?? frames[k] + .002) - frames[k]) / 2);
  }
  function preview(file, frames) {
    const v = $('clipVideo');
    for (const [id, step] of [['clipPrev', -1], ['clipNext', 1]]) {
      $(id).onclick = () => { v.pause(); v.currentTime = frameTime(frames, frameAt(frames, v.currentTime) + step); };
    }
    $('clipWatch').disabled = !capable;
    $('clipWatch').onclick = () => {
      if (!capable || session) return;
      if (file.size > limit) { toast('Повтор слишком велик для совместного просмотра'); return; }
      const time = v.currentTime;
      v.pause();
      const s = open(crypto.randomUUID(), true, file.size, time);
      Object.assign(s, { file, frames });
      status('Ждём подтверждения друга · ' + clock(time));
      send('invite', { size: file.size, time });
    };
  }
  function transferring(s) {
    s.phase = 'transfer';
    $('watchAccept').hidden = true;
    $('watchExit').textContent = 'Отменить';
    status('Передача повтора · 0%');
    deadline(s);
  }
  function progress(s, bytes) {
    const percent = Math.floor(100 * bytes / s.size);
    if (s.percent !== percent) {
      s.percent = percent;
      status('Передача повтора · ' + percent + '%');
    }
    deadline(s);
  }
  async function upload(s) {
    transferring(s);
    const dc = channel;
    try {
      for (let i = 0; i < s.frames.length; i += 512) send('frames', { values: s.frames.slice(i, i + 512) });
      for (let offset = 0; offset < s.size; offset += 256 * 1024) {
        const block = await s.file.slice(offset, offset + 256 * 1024).arrayBuffer();
        for (let i = 0; i < block.byteLength; i += chunk) {
          while (session === s && dc.bufferedAmount > 256 * 1024) await new Promise(r => setTimeout(r, 15));
          if (session !== s) return;
          dc.send(block.slice(i, i + chunk));
        }
        progress(s, offset + block.byteLength);
      }
      send('complete');
      loadVideo(s, s.file);
    } catch { if (session === s) end('Не удалось передать повтор'); }
  }
  function receiveBytes(bytes) {
    const s = session;
    if (!s || s.host || s.phase !== 'transfer') return;
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > chunk || s.bytes + bytes.byteLength > s.size) {
      end('Некорректный размер повтора'); return;
    }
    s.parts.push(bytes);
    s.bytes += bytes.byteLength;
    progress(s, s.bytes);
  }
  function loadVideo(s, blob) {
    s.phase = 'loading';
    s.parts = [];
    status('Открываем видео…');
    s.url = URL.createObjectURL(blob);
    video.onloadedmetadata = () => {
      if (session !== s) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0) { end('Не удалось определить длину повтора'); return; }
      s.loaded = true;
      if (s.host) startWhenReady(s);
      else send('ready');
    };
    video.onerror = () => { if (session === s) end('Не удалось открыть видео'); };
    video.src = s.url;
  }
  function startWhenReady(s) {
    if (!s.loaded || !s.remoteReady || s.phase !== 'loading') return;
    send('start', { time: s.time });
    activate(s, s.time);
  }
  function activate(s, time) {
    clearTimeout(s.timer);
    if (s.host) closeClipPreview();
    s.phase = 'watch';
    $('watchPlayer').hidden = false;
    $('watchExit').textContent = 'Выйти из просмотра';
    $('watchSeek').max = video.duration;
    status('');
    apply(time, false);
    if (s.host) s.pulse = setInterval(() => {
      if (s.playing && !video.seeking) send('pulse', { time: video.currentTime });
    }, 1500);
  }
  function apply(time, playing) {
    const s = session;
    if (!Number.isFinite(time) || typeof playing !== 'boolean') return;
    s.playing = playing;
    if (!playing) video.pause();
    video.currentTime = Math.min(video.duration, Math.max(0, time));
    if (playing) video.play().catch(err => {
      if (session === s && s.playing && err.name !== 'AbortError') { command(video.currentTime, false); status('Нажмите ▶ для воспроизведения'); }
    });
    render();
  }
  function command(time, playing) {
    if (session?.phase !== 'watch' || !Number.isFinite(time) || typeof playing !== 'boolean') return;
    send(session.host ? 'state' : 'request', { time, playing });
    if (session.host) apply(time, playing);
  }
  function receive(m) {
    if (m.op === 'hello') { capable = true; $('clipWatch').disabled = false; return; }
    if (m.op === 'invite') {
      if (typeof m.id !== 'string' || m.id.length > 64 || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > limit || !Number.isFinite(m.time) || m.time < 0) return;
      if (session) { channel.send(JSON.stringify({ id: m.id, op: 'busy' })); return; }
      open(m.id, false, m.size, m.time);
      status('Друг приглашает посмотреть повтор с ' + clock(m.time));
      return;
    }
    const s = session;
    if (!s || s.id !== m.id) return;
    if (m.op === 'end' || m.op === 'busy') {
      end(m.op === 'busy' ? 'У друга уже открыт просмотр' : s.phase === 'invite' ? 'Приглашение закрыто' : 'Друг вышел из просмотра', false); return;
    }
    if (s.host && s.phase === 'invite' && m.op === 'accept') { upload(s); return; }
    if (!s.host && s.phase === 'transfer') {
      if (m.op === 'frames') {
        if (!Array.isArray(m.values) || m.values.length > 512 || s.frames.length + m.values.length > 32000) throw Error();
        for (const t of m.values) {
          if (!Number.isFinite(t) || t < 0 || t <= (s.frames.at(-1) ?? -1)) throw Error();
          s.frames.push(t);
        }
      }
      if (m.op === 'complete') {
        if (s.bytes !== s.size || !s.frames.length) throw Error();
        loadVideo(s, new Blob(s.parts, { type: 'video/mp4' }));
      }
      return;
    }
    if (s.phase === 'loading') {
      if (s.host && m.op === 'ready') { s.remoteReady = true; startWhenReady(s); }
      if (!s.host && s.loaded && m.op === 'start') activate(s, m.time);
      return;
    }
    if (s.phase !== 'watch') return;
    if (s.host && m.op === 'request') command(m.time, m.playing);
    if (!s.host && m.op === 'state') apply(m.time, m.playing);
    if (!s.host && m.op === 'pulse' && s.playing && Number.isFinite(m.time) && Math.abs(video.currentTime - m.time) > .45) video.currentTime = m.time;
    if (m.op === 'mark' && validMark(s, m)) { s.marks.push(m); render(); }
  }
  function validMark(s, m) {
    return s.marks.length < 512 && Number.isInteger(m.frame) && m.frame >= 0 && m.frame < s.frames.length &&
      Array.isArray(m.points) && m.points.length >= 2 && m.points.length <= 1024 && !(m.points.length % 2) &&
      m.points.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
  }
  function render() {
    const s = session;
    if (s?.phase !== 'watch') return;
    $('watchPlay').textContent = s.playing ? 'Пауза' : '▶ Играть';
    $('watchSeek').value = video.currentTime;
    $('watchClock').textContent = clock(video.currentTime) + ' / ' + clock(video.duration);
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    ink.width = Math.round(rect.width * devicePixelRatio);
    ink.height = Math.round(rect.height * devicePixelRatio);
    const ctx = ink.getContext('2d');
    ctx.strokeStyle = '#ffb52b'; ctx.lineWidth = 3 * devicePixelRatio; ctx.lineCap = ctx.lineJoin = 'round';
    if (s.playing) return;
    const frame = frameAt(s.frames, video.currentTime);
    for (const mark of [...s.marks, s.stroke]) {
      if (!mark || mark.frame !== frame) continue;
      const p = mark.points;
      ctx.beginPath();
      ctx.moveTo(p[0] * ink.width, p[1] * ink.height);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * ink.width, p[i+1] * ink.height);
      if (p.length === 2) ctx.lineTo(p[0] * ink.width + 1, p[1] * ink.height);
      ctx.stroke();
    }
  }
  function point(e) {
    const r = ink.getBoundingClientRect();
    return [[e.clientX - r.left, r.width], [e.clientY - r.top, r.height]].map(([n, d]) => Math.round(Math.min(1, Math.max(0, n/d)) * 10000) / 10000);
  }
  ink.onpointerdown = e => {
    const s = session;
    if (s?.phase !== 'watch' || s.playing || s.stroke || s.marks.length >= 512) return;
    ink.setPointerCapture(e.pointerId);
    s.stroke = { frame: frameAt(s.frames, video.currentTime), points: point(e), pointer: e.pointerId };
    render();
  };
  ink.onpointermove = e => {
    const p = session?.stroke;
    if (p?.pointer === e.pointerId && p.points.length < 1024) { p.points.push(...point(e)); render(); }
  };
  ink.onpointerup = e => {
    const s = session, p = s?.stroke;
    if (p?.pointer !== e.pointerId) return;
    s.stroke = null;
    s.marks.push(p);
    send('mark', { frame: p.frame, points: p.points });
    render();
  };
  ink.onpointercancel = () => { if (session) session.stroke = null; render(); };
  $('watchAccept').onclick = () => {
    const s = session;
    if (s?.phase !== 'invite' || s.host) return;
    if (!$('clipModal').classList.contains('hidden')) closeClipPreview();
    transferring(s); send('accept');
  };
  $('watchExit').onclick = () => end();
  dialog.oncancel = e => { e.preventDefault(); end(); };
  $('watchPlay').onclick = () => command(video.ended ? 0 : video.currentTime, !session.playing);
  $('watchSeek').onchange = e => command(Number(e.target.value), false);
  for (const [id, delta] of [['watchPrev', -1], ['watchNext', 1]]) {
    $(id).onclick = () => command(frameTime(session.frames, frameAt(session.frames, video.currentTime) + delta), false);
  }
  video.ontimeupdate = video.onseeked = render;
  video.onended = () => { if (session?.host) command(video.duration, false); };
  new ResizeObserver(render).observe(video);
  return { attach, reset, preview };
})();
