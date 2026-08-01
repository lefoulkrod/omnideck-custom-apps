// ─── Procedural Audio System — Ominous Cyberpunk ───────────────────────────
// Dark industrial soundscape: drones, metallic percussion, data-glitch textures.

class GameAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.musicNodes = [];
    this.initialized = false;
    this.musicPlaying = false;
    this.masterVolume = 0.5;
    this.musicVolume = 0.25;
    this.sfxVolume = 0.6;
    this._timeouts = [];
  }

  init() {
    if (this.initialized) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxVolume;
      this.sfxGain.connect(this.masterGain);

      this.initialized = true;
    } catch (e) {
      console.warn('Audio not available:', e);
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  _addTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timeouts.push(id);
    return id;
  }

  _clearTimeouts() {
    this._timeouts.forEach(id => clearTimeout(id));
    this._timeouts = [];
  }

  // ─── Ominous Industrial Soundtrack ──────────────────────────────────────

  startMusic() {
    if (!this.initialized || this.musicPlaying) return;
    this.musicPlaying = true;
    this._playDrone();
    this._playIndustrialPercussion();
    this._playDataGlitch();
    this._playLowPad();
  }

  stopMusic() {
    this.musicPlaying = false;
    this._clearTimeouts();
    this.musicNodes.forEach(n => {
      try {
        if (n.stop) n.stop();
        if (n.disconnect) n.disconnect();
      } catch (e) {}
    });
    this.musicNodes = [];
  }

  // Deep ambient drone — the foundation
  _playDrone() {
    const ctx = this.ctx;
    const gain = this.musicGain;

    const createDrone = (freq, detune, type, vol) => {
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      const reverb = this._createReverb(2.0);

      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;

      filter.type = 'lowpass';
      filter.frequency.value = 400;
      filter.Q.value = 2;

      oscGain.gain.setValueAtTime(vol, ctx.currentTime);
      oscGain.gain.linearRampToValueAtTime(vol * 0.7, ctx.currentTime + 4);

      osc.connect(filter);
      filter.connect(oscGain);
      oscGain.connect(reverb);
      reverb.connect(gain);
      oscGain.connect(gain);

      osc.start();
      this.musicNodes.push(osc, oscGain, filter, reverb);
    };

    // Two detuned drones for that ominous wall of sound
    createDrone(55, -5, 'sawtooth', 0.08);   // A1
    createDrone(55, 5, 'sawtooth', 0.06);    // A1 detuned
    createDrone(65.41, 0, 'sine', 0.04);     // C2
    createDrone(49, 0, 'triangle', 0.03);    // E1

    // Slow filter sweep
    const sweepLfo = ctx.createOscillator();
    const sweepGain = ctx.createGain();
    sweepLfo.frequency.value = 0.05;
    sweepLfo.type = 'sine';
    sweepGain.gain.value = 200;
    sweepLfo.connect(sweepGain);
    // Can't directly modulate filter with LFO without AudioParam, so we do it manually
    this.musicNodes.push(sweepLfo, sweepGain);
    sweepLfo.start();

    // Manual filter sweep via interval
    const doSweep = () => {
      if (!this.musicPlaying) return;
      // Re-create drones with slightly different params periodically
      this._addTimeout(doSweep, 8000);
    };
    doSweep();
  }

  // Industrial metallic percussion
  _playIndustrialPercussion() {
    const ctx = this.ctx;
    const gain = this.musicGain;

    const metalHit = (time, freq, vol) => {
      const osc = ctx.createOscillator();
      const hitGain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, time);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.5, time + 0.3);

      filter.type = 'bandpass';
      filter.frequency.value = freq * 2;
      filter.Q.value = 15;

      hitGain.gain.setValueAtTime(vol, time);
      hitGain.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

      osc.connect(filter);
      filter.connect(hitGain);
      hitGain.connect(gain);
      osc.start(time);
      osc.stop(time + 0.4);
      this.musicNodes.push(osc, hitGain, filter);
    };

    const deepThud = (time, vol) => {
      const osc = ctx.createOscillator();
      const thudGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80, time);
      osc.frequency.exponentialRampToValueAtTime(20, time + 0.3);
      thudGain.gain.setValueAtTime(vol, time);
      thudGain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
      osc.connect(thudGain);
      thudGain.connect(gain);
      osc.start(time);
      osc.stop(time + 0.3);
      this.musicNodes.push(osc, thudGain);
    };

    const noiseHit = (time, vol) => {
      const bufSize = ctx.sampleRate * 0.15;
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.01));
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const nGain = ctx.createGain();
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = 'highpass';
      nFilter.frequency.value = 2000;
      nGain.gain.setValueAtTime(vol, time);
      nGain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
      src.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(gain);
      src.start(time);
      this.musicNodes.push(src, nGain, nFilter);
    };

    const loop = () => {
      if (!this.musicPlaying) return;
      const now = ctx.currentTime;
      const bpm = 70; // Slow, menacing
      const beat = 60 / bpm;

      // Pattern: slow industrial rhythm
      for (let i = 0; i < 4; i++) {
        const t = now + i * beat * 2;
        deepThud(t, 0.15);
        if (i % 2 === 0) metalHit(t + beat * 0.3, 800, 0.04);
        noiseHit(t + beat * 0.6, 0.03);
        if (i === 1 || i === 3) metalHit(t + beat, 1200, 0.03);
      }

      this._addTimeout(loop, 8 * beat * 1000);
    };
    loop();
  }

  // Random data-glitch textures
  _playDataGlitch() {
    const ctx = this.ctx;
    const gain = this.musicGain;

    const glitch = () => {
      if (!this.musicPlaying) return;
      const now = ctx.currentTime;

      // Short burst of noise with filter sweep
      const bufSize = ctx.sampleRate * 0.05;
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.005));
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gGain = ctx.createGain();
      const gFilter = ctx.createBiquadFilter();
      gFilter.type = 'bandpass';
      gFilter.frequency.setValueAtTime(500 + Math.random() * 3000, now);
      gFilter.Q.value = 3;
      gGain.gain.setValueAtTime(0.02 + Math.random() * 0.03, now);
      gGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      src.connect(gFilter);
      gFilter.connect(gGain);
      gGain.connect(gain);
      src.start(now);
      this.musicNodes.push(src, gGain, gFilter);

      const nextDelay = 2000 + Math.random() * 5000;
      this._addTimeout(glitch, nextDelay);
    };
    glitch();
  }

  // Low ominous pad
  _playLowPad() {
    const ctx = this.ctx;
    const gain = this.musicGain;

    const notes = [65.41, 77.78, 98.00, 65.41, 73.42, 87.31, 55, 65.41]; // C2, G2, B2, C2, D2, F2, A1, C2
    const noteLen = 4;

    const playPad = (freq, startTime) => {
      const osc = ctx.createOscillator();
      const pGain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      const reverb = this._createReverb(3.0);

      osc.type = 'sine';
      osc.frequency.value = freq;

      filter.type = 'lowpass';
      filter.frequency.value = 300;
      filter.Q.value = 1;

      pGain.gain.setValueAtTime(0, startTime);
      pGain.gain.linearRampToValueAtTime(0.04, startTime + 1);
      pGain.gain.linearRampToValueAtTime(0.03, startTime + noteLen - 1);
      pGain.gain.linearRampToValueAtTime(0, startTime + noteLen);

      osc.connect(filter);
      filter.connect(pGain);
      pGain.connect(reverb);
      reverb.connect(gain);
      pGain.connect(gain);
      osc.start(startTime);
      osc.stop(startTime + noteLen);
      this.musicNodes.push(osc, pGain, filter, reverb);
    };

    const loop = () => {
      if (!this.musicPlaying) return;
      const now = ctx.currentTime;
      notes.forEach((freq, i) => {
        playPad(freq, now + i * noteLen);
      });
      this._addTimeout(loop, notes.length * noteLen * 1000);
    };
    loop();
  }

  _createReverb(duration) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = sr * duration;
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * duration * 0.3));
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = buf;
    return convolver;
  }

  // ─── Sound Effects ──────────────────────────────────────────────────────

  playGunshot() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    // Data rifle sound — sharp digital burst
    const bufSize = ctx.sampleRate * 0.08;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.008));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const sGain = ctx.createGain();
    sGain.gain.setValueAtTime(0.35, ctx.currentTime);
    sGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2000, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.05);
    filter.Q.value = 5;

    src.connect(filter);
    filter.connect(sGain);
    sGain.connect(gain);
    src.start();
    src.stop(ctx.currentTime + 0.08);
  }

  playHit() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    const osc = ctx.createOscillator();
    const hGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.08);
    hGain.gain.setValueAtTime(0.12, ctx.currentTime);
    hGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(hGain);
    hGain.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  }

  playEnemyDeath() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    // Digital disintegration
    const osc = ctx.createOscillator();
    const dGain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.6);
    dGain.gain.setValueAtTime(0.1, ctx.currentTime);
    dGain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.2);
    dGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;

    osc.connect(filter);
    filter.connect(dGain);
    dGain.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  }

  playFootstep() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    const bufSize = ctx.sampleRate * 0.06;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.008));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const fGain = ctx.createGain();
    fGain.gain.setValueAtTime(0.04, ctx.currentTime);
    fGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    src.connect(filter);
    filter.connect(fGain);
    fGain.connect(gain);
    src.start();
    src.stop(ctx.currentTime + 0.06);
  }

  playReload() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    const click = (time, freq) => {
      const osc = ctx.createOscillator();
      const cGain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      cGain.gain.setValueAtTime(0.06, time);
      cGain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
      osc.connect(cGain);
      cGain.connect(gain);
      osc.start(time);
      osc.stop(time + 0.04);
    };

    const now = ctx.currentTime;
    click(now, 800);
    click(now + 0.2, 1200);
    click(now + 0.5, 600);
  }

  playDamage() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    const osc = ctx.createOscillator();
    const dGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.25);
    dGain.gain.setValueAtTime(0.18, ctx.currentTime);
    dGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(dGain);
    dGain.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  }

  playWaveStart() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    // Ominous alert tone
    const notes = [110, 110, 146.83, 110];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const nGain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.25;
      nGain.gain.setValueAtTime(0, t);
      nGain.gain.linearRampToValueAtTime(0.06, t + 0.05);
      nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      osc.connect(filter);
      filter.connect(nGain);
      nGain.connect(gain);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  }

  playHack() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    // Rising digital tone for hack ability
    const osc = ctx.createOscillator();
    const hGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(2000, ctx.currentTime + 0.3);
    hGain.gain.setValueAtTime(0.1, ctx.currentTime);
    hGain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.15);
    hGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1000;
    filter.Q.value = 10;

    osc.connect(filter);
    filter.connect(hGain);
    hGain.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  }

  playModelFreed() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    // Ascending chime
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const nGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.12;
      nGain.gain.setValueAtTime(0, t);
      nGain.gain.linearRampToValueAtTime(0.08, t + 0.03);
      nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.connect(nGain);
      nGain.connect(gain);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  }

  playBossAlert() {
    if (!this.initialized) return;
    const ctx = this.ctx;
    const gain = this.sfxGain;

    // Deep siren
    for (let cycle = 0; cycle < 3; cycle++) {
      const osc = ctx.createOscillator();
      const sGain = ctx.createGain();
      osc.type = 'sawtooth';
      const t = ctx.currentTime + cycle * 0.5;
      osc.frequency.setValueAtTime(80, t);
      osc.frequency.linearRampToValueAtTime(120, t + 0.25);
      osc.frequency.linearRampToValueAtTime(80, t + 0.5);
      sGain.gain.setValueAtTime(0.08, t);
      sGain.gain.linearRampToValueAtTime(0.12, t + 0.1);
      sGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 300;
      osc.connect(filter);
      filter.connect(sGain);
      sGain.connect(gain);
      osc.start(t);
      osc.stop(t + 0.5);
    }
  }

  setMasterVolume(v) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.masterVolume;
  }

  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
  }

  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
  }

  dispose() {
    this.stopMusic();
    this._clearTimeouts();
    if (this.ctx) this.ctx.close();
  }
}

export { GameAudio };
