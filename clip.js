'use strict';
/* =========================================================
   Повтор последних секунд: постоянно держим в памяти кольцевой буфер
   закодированного видео и звука (WebCodecs). По команде — собираем из него
   MP4 с последними ~30 секундами и отдаём как файл. Старое само вытесняется.
   ========================================================= */
(function (root) {
  const { Muxer, ArrayBufferTarget } = root.Mp4Muxer || {};
  const supported = () => !!(root.MediaStreamTrackProcessor && root.VideoEncoder && root.AudioEncoder && Muxer);

  // кандидаты кодеков H.264 (muxer кладёт их как 'avc'); первый поддержанный — берём
  const AVC = ['avc1.640028', 'avc1.4d0028', 'avc1.42e01f', 'avc1.42001f'];

  async function pickVideoConfig(width, height, fps) {
    for (const codec of AVC) {
      const cfg = { codec, width, height, framerate: fps, bitrate: Math.min(12_000_000, Math.round(width * height * fps * 0.12)), latencyMode: 'realtime' };
      for (const acc of ['prefer-hardware', 'no-preference']) {
        try { const s = await root.VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: acc }); if (s.supported) return s.config; } catch { /* */ }
      }
    }
    return null;
  }

  class ClipRecorder {
    constructor(seconds = 30) {
      this.seconds = seconds;
      this.video = [];       // { key, ts, chunk, desc }
      this.audio = [];       // { ts, chunk }
      this.running = false;
      this.err = null;
      this.vconf = null;
      this.aconf = null;
      this.abort = new AbortController();
      this.lastDesc = null;
      this.keyEvery = 2_000_000; // ключевой кадр каждые 2 с (мкс)
      this.lastKeyTs = -1e12;
      this.started = 0;
    }

    async start(videoTrack, audioTrack) {
      if (!supported()) { this.err = 'нет WebCodecs'; return false; }
      if (this.running) return true;
      this.running = true;
      this.started = performance.now();
      try {
        await this._startVideo(videoTrack);
        if (audioTrack) await this._startAudio(audioTrack).catch((e) => { log('clip-audio', e.message); });
      } catch (e) { this.err = e.message; this.running = false; return false; }
      return true;
    }

    async _startVideo(track) {
      const settings = track.getSettings();
      let w = settings.width || 1280, h = settings.height || 720;
      // ограничиваем кадр 1080p, чтобы не грузить процессор повтором
      let scale = 1;
      if (h > 1080) { scale = 1080 / h; w = Math.round(w * scale / 2) * 2; h = 1080; }
      const fps = 30;
      const conf = await pickVideoConfig(w, h, fps);
      if (!conf) throw new Error('видеокодер недоступен');
      this.vconf = { width: w, height: h };
      const enc = new root.VideoEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig?.description) this.lastDesc = meta.decoderConfig.description;
          const key = chunk.type === 'key';
          this.video.push({ key, ts: chunk.timestamp, chunk, desc: this.lastDesc });
          this._prune();
        },
        error: (e) => { this.err = e.message; },
      });
      enc.configure(conf);
      this.venc = enc;
      const proc = new root.MediaStreamTrackProcessor({ track });
      const reader = proc.readable.getReader();
      this.vreader = reader;
      const minGap = 1e6 / (fps + 2); // прореживаем до ~30 к/с
      let lastFrameTs = -1e12;
      let cnv = null, ctx = null;
      const pump = async () => {
        while (this.running) {
          let res;
          try { res = await reader.read(); } catch { break; }
          if (res.done) break;
          let frame = res.value;
          this.vWall = { ts: frame.timestamp, at: performance.now() }; // для сведения часов звука и видео
          try {
            if (frame.timestamp - lastFrameTs < minGap) { frame.close(); continue; }
            lastFrameTs = frame.timestamp;
            if (scale !== 1) {
              if (!cnv) { cnv = new OffscreenCanvas(w, h); ctx = cnv.getContext('2d'); }
              ctx.drawImage(frame, 0, 0, w, h);
              const ts = frame.timestamp;
              frame.close();
              frame = new root.VideoFrame(cnv, { timestamp: ts });
            }
            if (this.venc.state !== 'configured') { frame.close(); break; }
            const forceKey = frame.timestamp - this.lastKeyTs >= this.keyEvery;
            if (forceKey) this.lastKeyTs = frame.timestamp;
            this.venc.encode(frame, { keyFrame: forceKey });
          } catch { /* */ } finally { frame.close(); }
        }
      };
      pump();
    }

    // кодер звука настраиваем по первому куску (частота/каналы берём из него, а не из getSettings —
    // там бывает пусто, и при несовпадении кодер молча отбрасывал всё). Часы звука сводим с часами
    // видео по моменту прихода: иначе метки звука могли оказаться вне окна клипа
    async _startAudio(track) {
      const proc = new root.MediaStreamTrackProcessor({ track });
      const reader = proc.readable.getReader();
      this.areader = reader;
      let off = null;
      const setup = async (d) => {
        const ch = Math.min(2, d.numberOfChannels || 2);
        const cfg = { codec: 'opus', sampleRate: d.sampleRate, numberOfChannels: ch, bitrate: 128000 };
        const sup = await root.AudioEncoder.isConfigSupported(cfg).catch(() => null);
        if (!sup?.supported) { log('clip-audio', 'unsupported ' + d.sampleRate + '/' + ch); return false; }
        const enc = new root.AudioEncoder({
          output: (chunk) => { this.audio.push({ ts: chunk.timestamp + off, chunk }); this._prune(); },
          error: (e) => log('clip-audio', e.message),
        });
        enc.configure(cfg);
        this.aenc = enc;
        this.aconf = { sampleRate: d.sampleRate, numberOfChannels: ch };
        return true;
      };
      const pump = async () => {
        let dead = false;
        while (this.running) {
          let res;
          try { res = await reader.read(); } catch { break; }
          if (res.done) break;
          const data = res.value;
          try {
            if (dead || !this.vWall) continue; // пока нет видео — звук не нужен
            if (off == null) off = Math.round(this.vWall.ts + (performance.now() - this.vWall.at) * 1000 - data.timestamp);
            if (!this.aenc && !(await setup(data))) { dead = true; continue; }
            if (this.aenc.state === 'configured') this.aenc.encode(data);
          } catch (e) { log('clip-audio', e.message); } finally { data.close(); }
        }
      };
      pump();
    }

    // держим чуть больше окна; ключевой кадр перед границей не выкидываем
    _prune() {
      const keepFrom = this._newestTs() - (this.seconds + 3) * 1e6;
      const trim = (arr, needKey) => {
        let cut = 0;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].ts >= keepFrom) break;
          cut = i;
        }
        // сдвигаем начало к ближайшему более раннему ключевому кадру
        if (needKey) { while (cut > 0 && !arr[cut].key) cut--; }
        if (cut > 1) arr.splice(0, cut);
      };
      if (this.video.length > 2) trim(this.video, true);
      if (this.audio.length > 2) trim(this.audio, false);
    }

    _newestTs() {
      const v = this.video.length ? this.video[this.video.length - 1].ts : 0;
      const a = this.audio.length ? this.audio[this.audio.length - 1].ts : 0;
      return Math.max(v, a);
    }

    secondsBuffered() {
      if (this.video.length < 2) return 0;
      return (this.video[this.video.length - 1].ts - this.video[0].ts) / 1e6;
    }

    // собрать MP4 из последних this.seconds; null — если нечего
    async save() {
      if (!this.running || this.video.length < 2 || !this.lastDesc) return null;
      const newest = this._newestTs();
      const from = newest - this.seconds * 1e6;
      // первый включаемый кадр — ключевой на/до границы окна
      let start = 0;
      for (let i = 0; i < this.video.length; i++) {
        if (this.video[i].key && this.video[i].ts <= from) start = i;
        if (this.video[i].ts > from) break;
      }
      while (start > 0 && !this.video[start].key) start--;
      const vids = this.video.slice(start);
      if (!vids.length || !vids[0].key) return null;
      const base = vids[0].ts;
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: this.vconf.width, height: this.vconf.height },
        audio: this.aconf ? { codec: 'opus', numberOfChannels: this.aconf.numberOfChannels, sampleRate: this.aconf.sampleRate } : undefined,
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
      });
      let desc = vids[0].desc || this.lastDesc;
      for (const v of vids) muxer.addVideoChunk(v.chunk, { decoderConfig: { description: desc } }, v.ts - base);
      if (this.aconf) {
        for (const a of this.audio) {
          if (a.ts < base - 100000) continue;
          muxer.addAudioChunk(a.chunk, undefined, Math.max(0, a.ts - base));
        }
      }
      muxer.finalize();
      log('clip-audio', { saved: this.audio.length, rate: this.aconf?.sampleRate || 0 });
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    }

    stop() {
      this.running = false;
      try { this.vreader?.cancel(); } catch { /* */ }
      try { this.areader?.cancel(); } catch { /* */ }
      try { if (this.venc?.state === 'configured') this.venc.close(); } catch { /* */ }
      try { if (this.aenc?.state === 'configured') this.aenc.close(); } catch { /* */ }
      this.video = [];
      this.audio = [];
      this.lastDesc = null;
    }
  }

  ClipRecorder.supported = supported;
  function log(t, d) { try { root.duo?.log(t, typeof d === 'string' ? d : JSON.stringify(d)); } catch { /* */ } }
  root.ClipRecorder = ClipRecorder;
})(typeof window !== 'undefined' ? window : globalThis);
