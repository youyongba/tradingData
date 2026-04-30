// 用 WebAudio 合成 4 种音效，无需音频文件
(function () {
  const Sound = {
    muted: localStorage.getItem('muted') === '1',
    ctx: null,

    _ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },

    setMuted(m) {
      this.muted = !!m;
      localStorage.setItem('muted', this.muted ? '1' : '0');
    },

    toggleMuted() { this.setMuted(!this.muted); return this.muted; },

    // 单个 tone
    _tone({ freq = 880, dur = 0.18, type = 'sine', vol = 0.25, decay = 0.0, when = 0 }) {
      const ctx = this._ensureCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + when;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },

    // 序列
    _seq(notes) {
      if (this.muted) return;
      let t = 0;
      for (const n of notes) {
        this._tone({ ...n, when: t });
        t += n.gap ?? n.dur ?? 0.18;
      }
    },

    entry() {
      // 入场：双音上行
      this._seq([
        { freq: 660, dur: 0.12, type: 'triangle', vol: 0.25, gap: 0.10 },
        { freq: 990, dur: 0.16, type: 'triangle', vol: 0.30, gap: 0.18 },
      ]);
    },
    tp() {
      // 止盈：清脆三连上行
      this._seq([
        { freq: 880,  dur: 0.10, type: 'sine', vol: 0.25, gap: 0.09 },
        { freq: 1175, dur: 0.10, type: 'sine', vol: 0.28, gap: 0.09 },
        { freq: 1568, dur: 0.18, type: 'sine', vol: 0.32, gap: 0.20 },
      ]);
    },
    sl() {
      // 止损：低沉双音
      this._seq([
        { freq: 220, dur: 0.20, type: 'sawtooth', vol: 0.30, gap: 0.18 },
        { freq: 165, dur: 0.30, type: 'sawtooth', vol: 0.30, gap: 0.30 },
      ]);
    },
    be() {
      // 保本：温和提示
      this._seq([
        { freq: 523, dur: 0.10, type: 'square', vol: 0.18, gap: 0.10 },
        { freq: 523, dur: 0.10, type: 'square', vol: 0.18, gap: 0.10 },
      ]);
    },
    test() { this.entry(); setTimeout(() => this.tp(), 700); setTimeout(() => this.sl(), 1500); },
  };

  // 浏览器策略：首次用户交互后再启用 AudioContext
  window.addEventListener('click', () => Sound._ensureCtx(), { once: true });

  window.Sound = Sound;
})();
