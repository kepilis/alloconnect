// Проигрывает поток PCM (int16, стерео, 48 кГц), приходящий из duo-audio.exe.
// Кольцевой буфер с подстройкой задержки: держим ~60 мс, лишнее сбрасываем.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000 * 2;              // 2 секунды на канал
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.n = 0;
    this.target = 2880;                // 60 мс
    this.max = 9600;                   // 200 мс — дальше сбрасываем до target
    this.started = false;
    this.port.onmessage = (e) => this.push(e.data);
  }
  push(buf) {
    const s = new Int16Array(buf);
    const frames = s.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.L[this.w] = s[2 * i] / 32768;
      this.R[this.w] = s[2 * i + 1] / 32768;
      this.w = (this.w + 1) % this.cap;
    }
    this.n = Math.min(this.cap, this.n + frames);
    if (this.n > this.max) {           // накопилась задержка — догоняем
      const drop = this.n - this.target;
      this.r = (this.r + drop) % this.cap;
      this.n -= drop;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const len = oL.length;
    if (!this.started && this.n >= this.target) this.started = true;
    for (let i = 0; i < len; i++) {
      if (this.started && this.n > 0) {
        oL[i] = this.L[this.r];
        oR[i] = this.R[this.r];
        this.r = (this.r + 1) % this.cap;
        this.n--;
      } else {
        oL[i] = 0; oR[i] = 0;
      }
    }
    if (this.n === 0) this.started = false; // опустел — снова наберём запас
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
