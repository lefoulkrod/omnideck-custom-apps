/**
 * audio.js — Dungeons & Dragoons
 * WebAudio synthesized SFX + chiptune music. No audio files.
 */

const _state = {
  ctx: null,
  master: null,
  musicGain: null,
  sfxGain: null,
  analyser: null,
  ready: false,
  muted: false,
  masterVol: 0.8,
  sfxVol: 0.7,
  musicVol: 0.5,
  currentTrack: null,
  musicTimer: null,
  musicVoices: [],
  nextNoteTime: 0,
  step: 0,
  voiceCount: 0,
  activeVoices: new Set(),
};

const SFX_NAMES = [
  'shoot_arcane', 'shoot_fire', 'shoot_lightning', 'shoot_frost',
  'hit_enemy', 'hit_wall', 'enemy_die', 'explosion', 'boss_hit', 'boss_die',
  'jump', 'land', 'player_hurt', 'player_die', 'dash',
  'pickup_weapon', 'pickup_heart', 'pickup_life', 'pickup_coin',
  'menu_move', 'menu_select', 'menu_back', 'pause', 'unpause',
  'checkpoint', 'stage_clear', 'countdown_beep',
  'door_open', 'spike_trap', 'lava_bubble', 'dragon_roar', 'wing_flap', 'bone_rattle',
];

const MUSIC_TRACKS = ['menu', 'stage1', 'stage2', 'stage3', 'boss', 'victory', 'gameover'];

// Note name → frequency
const NOTE_FREQ = {};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
for (let oct = 0; oct <= 7; oct++) {
  for (let i = 0; i < 12; i++) {
    const name = NAMES[i] + oct;
    NOTE_FREQ[name] = 440 * Math.pow(2, (oct * 12 + i - 57) / 12);
  }
}

function noteFreq(name) {
  if (!name || name === 'rest' || name === '-') return 0;
  return NOTE_FREQ[name] || 0;
}

function hasAudio() {
  return typeof window !== 'undefined' && typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
}

function init() {
  if (_state.ready) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('No AudioContext');
    _state.ctx = new AC();
    _state.master = _state.ctx.createGain();
    _state.musicGain = _state.ctx.createGain();
    _state.sfxGain = _state.ctx.createGain();
    _state.analyser = _state.ctx.createAnalyser();
    _state.analyser.fftSize = 256;
    _state.musicGain.connect(_state.master);
    _state.sfxGain.connect(_state.master);
    _state.master.connect(_state.analyser);
    _state.analyser.connect(_state.ctx.destination);
    _state.master.gain.value = _state.masterVol;
    _state.musicGain.gain.value = _state.musicVol;
    _state.sfxGain.gain.value = _state.sfxVol;
    _state.ready = true;
    // restore prefs
    try {
      const m = localStorage.getItem('dnd_audio_muted');
      if (m === 'true') { _state.muted = true; _state.master.gain.value = 0; }
      const mv = localStorage.getItem('dnd_audio_master'); if (mv) _state.masterVol = parseFloat(mv);
      const sv = localStorage.getItem('dnd_audio_sfx'); if (sv) _state.sfxVol = parseFloat(sv);
      const xv = localStorage.getItem('dnd_audio_music'); if (xv) _state.musicVol = parseFloat(xv);
    } catch (e) {}
    if (_state.ctx.state === 'suspended') _state.ctx.resume();
  } catch (e) {
    console.warn('[audio] init failed:', e.message);
  }
}

function isReady() { return _state.ready; }
function isMuted() { return _state.muted; }
function setMuted(b) {
  _state.muted = b;
  if (_state.master) _state.master.gain.value = b ? 0 : _state.masterVol;
  try { localStorage.setItem('dnd_audio_muted', String(b)); } catch (e) {}
}
function setMasterVolume(v) {
  _state.masterVol = v;
  if (_state.master && !_state.muted) _state.master.gain.value = v;
  try { localStorage.setItem('dnd_audio_master', String(v)); } catch (e) {}
}
function setSfxVolume(v) {
  _state.sfxVol = v;
  if (_state.sfxGain) _state.sfxGain.gain.value = v;
  try { localStorage.setItem('dnd_audio_sfx', String(v)); } catch (e) {}
}
function setMusicVolume(v) {
  _state.musicVol = v;
  if (_state.musicGain) _state.musicGain.gain.value = v;
  try { localStorage.setItem('dnd_audio_music', String(v)); } catch (e) {}
}

const VOICE_CAP = 24;

function play(name, opts = {}) {
  if (!_state.ready || _state.muted) return;
  const vol = opts.vol != null ? opts.vol : 1;
  const rate = opts.rate != null ? opts.rate : 1;
  const pan = opts.pan != null ? opts.pan : 0;
  try {
    if (_state.voiceCount >= VOICE_CAP) return;
    const fn = SFX_MAP[name];
    if (!fn) return;
    _state.voiceCount++;
    fn(vol, rate, pan);
  } catch (e) { /* swallow */ }
}

function _debugVoiceCount() { return _state.voiceCount; }

function env(gain, t0, attack, decay, sustain, release, dur) {
  const g = gain.gain;
  g.cancelScheduledValues(t0);
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(1, t0 + attack);
  g.linearRampToValueAtTime(sustain, t0 + attack + decay);
  g.linearRampToValueAtTime(0, t0 + dur);
}

function tone(freq, dur, type, vol, pan, opts = {}) {
  const ctx = _state.ctx;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  osc.type = type;
  osc.frequency.value = freq;
  if (opts.slide) osc.frequency.linearRampToValueAtTime(opts.slide, t0 + dur);
  if (opts.detune) osc.detune.value = opts.detune;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + (opts.attack || 0.005));
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g);
  if (p) { p.pan.value = pan; g.connect(p); p.connect(_state.sfxGain); }
  else g.connect(_state.sfxGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  _state.activeVoices.add(osc);
  osc.onended = () => { _state.voiceCount--; _state.activeVoices.delete(osc); };
  return osc;
}

function noise(dur, vol, pan, filterFreq, filterType = 'lowpass') {
  const ctx = _state.ctx;
  const t0 = ctx.currentTime;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.value = filterFreq;
  const g = ctx.createGain();
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filt); filt.connect(g);
  if (p) { p.pan.value = pan; g.connect(p); p.connect(_state.sfxGain); }
  else g.connect(_state.sfxGain);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
  _state.activeVoices.add(src);
  src.onended = () => { _state.voiceCount--; _state.activeVoices.delete(src); };
  return src;
}

const SFX_MAP = {
  shoot_arcane: (v, r, p) => { tone(880 * r, 0.08, 'square', 0.15 * v, p, { slide: 1200 * r }); tone(440 * r, 0.04, 'sine', 0.1 * v, p); },
  shoot_fire: (v, r, p) => { noise(0.12, 0.12 * v, p, 800, 'bandpass'); tone(200 * r, 0.1, 'sawtooth', 0.08 * v, p, { slide: 80 }); },
  shoot_lightning: (v, r, p) => { tone(1200 * r, 0.05, 'sawtooth', 0.12 * v, p, { slide: 2400 }); noise(0.04, 0.08 * v, p, 3000, 'highpass'); },
  shoot_frost: (v, r, p) => { tone(1600 * r, 0.1, 'sine', 0.12 * v, p, { slide: 800 }); tone(2400 * r, 0.06, 'triangle', 0.06 * v, p); },
  hit_enemy: (v, r, p) => { tone(400 * r, 0.05, 'square', 0.12 * v, p, { slide: 100 }); noise(0.04, 0.1 * v, p, 2000); },
  hit_wall: (v, r, p) => { tone(120 * r, 0.06, 'square', 0.1 * v, p); noise(0.03, 0.06 * v, p, 400); },
  enemy_die: (v, r, p) => { tone(300 * r, 0.2, 'sawtooth', 0.12 * v, p, { slide: 60 }); noise(0.15, 0.08 * v, p, 600); },
  explosion: (v, r, p) => { noise(0.4, 0.2 * v, p, 300); tone(80 * r, 0.3, 'sawtooth', 0.15 * v, p, { slide: 30 }); },
  boss_hit: (v, r, p) => { tone(200 * r, 0.08, 'square', 0.15 * v, p, { slide: 80 }); noise(0.06, 0.1 * v, p, 1000); },
  boss_die: (v, r, p) => { noise(0.8, 0.25 * v, p, 200); tone(60 * r, 0.6, 'sawtooth', 0.2 * v, p, { slide: 20 }); tone(120 * r, 0.4, 'square', 0.1 * v, p, { slide: 40 }); },
  jump: (v, r, p) => { tone(300 * r, 0.1, 'square', 0.1 * v, p, { slide: 600 }); },
  land: (v, r, p) => { tone(100 * r, 0.06, 'sine', 0.08 * v, p); noise(0.03, 0.05 * v, p, 200); },
  player_hurt: (v, r, p) => { tone(200 * r, 0.15, 'sawtooth', 0.15 * v, p, { slide: 80 }); noise(0.1, 0.08 * v, p, 500); },
  player_die: (v, r, p) => { [440, 330, 220, 110].forEach((f, i) => tone(f * r, 0.2, 'triangle', 0.12 * v, p, { attack: i * 0.15 })); },
  dash: (v, r, p) => { noise(0.1, 0.08 * v, p, 1500, 'bandpass'); },
  pickup_weapon: (v, r, p) => { [523, 659, 784].forEach((f, i) => tone(f * r, 0.1, 'square', 0.1 * v, p, { attack: i * 0.06 })); },
  pickup_heart: (v, r, p) => { tone(523 * r, 0.1, 'triangle', 0.1 * v, p); tone(659 * r, 0.15, 'triangle', 0.1 * v, p, { attack: 0.08 }); },
  pickup_life: (v, r, p) => { [523, 659, 784, 1047].forEach((f, i) => tone(f * r, 0.12, 'square', 0.12 * v, p, { attack: i * 0.08 })); },
  pickup_coin: (v, r, p) => { tone(988 * r, 0.05, 'square', 0.1 * v, p); tone(1319 * r, 0.1, 'square', 0.1 * v, p, { attack: 0.04 }); },
  menu_move: (v, r, p) => { tone(440 * r, 0.03, 'square', 0.06 * v, p); },
  menu_select: (v, r, p) => { tone(660 * r, 0.06, 'square', 0.1 * v, p); tone(880 * r, 0.08, 'square', 0.08 * v, p, { attack: 0.03 }); },
  menu_back: (v, r, p) => { tone(330 * r, 0.06, 'square', 0.08 * v, p); },
  pause: (v, r, p) => { tone(440 * r, 0.1, 'sine', 0.08 * v, p); },
  unpause: (v, r, p) => { tone(660 * r, 0.1, 'sine', 0.08 * v, p); },
  checkpoint: (v, r, p) => { [523, 659, 784, 1047].forEach((f, i) => tone(f * r, 0.15, 'sine', 0.08 * v, p, { attack: i * 0.05 })); },
  stage_clear: (v, r, p) => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f * r, 0.15, 'square', 0.12 * v, p, { attack: i * 0.1 })); },
  countdown_beep: (v, r, p) => { tone(880 * r, 0.08, 'square', 0.1 * v, p); },
  door_open: (v, r, p) => { tone(150 * r, 0.3, 'sawtooth', 0.08 * v, p, { slide: 80 }); noise(0.2, 0.05 * v, p, 300); },
  spike_trap: (v, r, p) => { tone(200 * r, 0.1, 'sawtooth', 0.1 * v, p); noise(0.05, 0.08 * v, p, 1500); },
  lava_bubble: (v, r, p) => { tone(80 * r, 0.15, 'sine', 0.06 * v, p, { slide: 120 }); },
  dragon_roar: (v, r, p) => { tone(60 * r, 0.5, 'sawtooth', 0.2 * v, p, { slide: 40 }); noise(0.4, 0.15 * v, p, 400); tone(90 * r, 0.3, 'square', 0.1 * v, p, { slide: 50 }); },
  wing_flap: (v, r, p) => { noise(0.08, 0.06 * v, p, 600, 'bandpass'); },
  bone_rattle: (v, r, p) => { noise(0.15, 0.08 * v, p, 3000, 'highpass'); tone(200 * r, 0.1, 'square', 0.04 * v, p); },
};

// ---- Music: step sequencer ----
// Each track: { bpm, channels: [{ wave, vol, pattern: [noteName, ...], len }] }
// Pattern length = bars * stepsPerBar

function buildTracks() {
  const s = (n) => n; // identity
  const r = 'rest';
  const tracks = {};

  tracks.menu = {
    bpm: 80,
    channels: [
      { wave: 'triangle', vol: 0.12, pattern: ['A3', r, 'C4', r, 'E4', r, 'A4', r, 'G4', r, 'E4', r, 'C4', r, 'D4', r] },
      { wave: 'sine', vol: 0.08, pattern: ['A2', r, r, r, 'A2', r, r, r, 'F2', r, r, r, 'G2', r, r, r] },
      { wave: 'square', vol: 0.04, pattern: ['E5', r, r, r, 'A4', r, r, r, 'C5', r, r, r, 'B4', r, r, r] },
    ],
  };

  tracks.stage1 = {
    bpm: 140,
    channels: [
      { wave: 'square', vol: 0.1, pattern: ['A4', 'A4', 'C5', 'D5', 'E5', 'D5', 'C5', 'A4', 'G4', 'A4', 'C5', 'D5', 'E5', 'F5', 'E5', 'D5', 'C5', 'C5', 'D5', 'E5', 'D5', 'C5', 'A4', 'G4', 'A4', 'C5', 'D5', 'E5', 'F5', 'E5', 'D5', 'C5'] },
      { wave: 'triangle', vol: 0.12, pattern: ['A2', r, 'A2', r, 'A2', r, 'A2', r, 'F2', r, 'F2', r, 'G2', r, 'G2', r, 'A2', r, 'A2', r, 'A2', r, 'A2', r, 'F2', r, 'F2', r, 'G2', r, 'G2', r] },
      { wave: 'square', vol: 0.05, pattern: [r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r, r] },
    ],
  };

  tracks.stage2 = {
    bpm: 155,
    channels: [
      { wave: 'square', vol: 0.1, pattern: ['D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'G#4', 'G4', 'F#4', 'F4', 'E4', 'D#4', 'D4', 'C#4', 'D4', 'E4', 'F4', 'G4', 'A4', 'G4', 'F4', 'E4', 'D4', 'C#4', 'D4', 'E4', 'F4', 'E4', 'D4', 'C#4'] },
      { wave: 'triangle', vol: 0.12, pattern: ['D2', r, 'D2', r, 'D2', r, 'D2', r, 'A2', r, 'A2', r, 'A2', r, 'A2', r, 'D2', r, 'D2', r, 'D2', r, 'D2', r, 'A2', r, 'A2', r, 'A2', r, 'A2', r] },
      { wave: 'sawtooth', vol: 0.04, pattern: ['D5', r, 'D5', r, 'D5', r, 'A4', r, 'D5', r, 'D5', r, 'A4', r, 'D5', r, 'D5', r, 'D5', r, 'D5', r, 'A4', r, 'D5', r, 'D5', r, 'A4', r, 'D5', r, 'A4', r] },
    ],
  };

  tracks.stage3 = {
    bpm: 150,
    channels: [
      { wave: 'square', vol: 0.1, pattern: ['C4', 'E4', 'G4', 'C5', 'B4', 'G4', 'E4', 'C4', 'D4', 'F4', 'A4', 'D5', 'C5', 'A4', 'F4', 'D4', 'E4', 'G4', 'B4', 'E5', 'D5', 'B4', 'G4', 'E4', 'F4', 'A4', 'C5', 'F5', 'E5', 'C5', 'A4', 'F4'] },
      { wave: 'triangle', vol: 0.12, pattern: ['C2', r, 'C2', r, 'G2', r, 'G2', r, 'D2', r, 'D2', r, 'A2', r, 'A2', r, 'E2', r, 'E2', r, 'B2', r, 'B2', r, 'F2', r, 'F2', r, 'C3', r, 'C3', r] },
      { wave: 'square', vol: 0.05, pattern: ['G5', r, 'E5', r, 'C5', r, 'G4', r, 'A5', r, 'F5', r, 'D5', r, 'A4', r, 'B5', r, 'G5', r, 'E5', r, 'B4', r, 'C6', r, 'A5', r, 'F5', r, 'C5', r] },
    ],
  };

  tracks.boss = {
    bpm: 170,
    channels: [
      { wave: 'square', vol: 0.1, pattern: ['E4', 'F4', 'E4', 'D#4', 'E4', 'F4', 'G4', 'F4', 'E4', 'D#4', 'E4', 'F4', 'E4', 'D#4', 'D4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'G4', 'G#4', 'G4', 'F4', 'E4', 'D#4', 'E4', 'F4', 'E4', 'D4', 'C#4', 'D4'] },
      { wave: 'triangle', vol: 0.14, pattern: ['D2', r, 'D2', r, 'D2', r, 'D2', r, 'C2', r, 'C2', r, 'C2', r, 'C2', r, 'D2', r, 'D2', r, 'D2', r, 'D2', r, 'C2', r, 'C2', r, 'C2', r, 'C2', r] },
      { wave: 'sawtooth', vol: 0.06, pattern: ['D5', 'D5', 'D5', 'D5', 'D5', 'D5', 'D5', 'D5', 'C5', 'C5', 'C5', 'C5', 'C5', 'C5', 'C5', 'C5', 'D5', 'D5', 'D5', 'D5', 'D5', 'D5', 'D5', 'D5', 'C5', 'C5', 'C5', 'C5', 'C5', 'C5', 'C5', 'C5'] },
    ],
  };

  tracks.victory = {
    bpm: 120,
    channels: [
      { wave: 'square', vol: 0.12, pattern: ['C5', 'E5', 'G5', 'C6', 'G5', 'E5', 'C5', 'G4', 'C5', 'E5', 'G5', 'C6', 'G5', 'E5', 'C5', 'G4', 'F4', 'A4', 'C5', 'F5', 'C5', 'A4', 'F4', 'A4', 'C5', 'E5', 'G5', 'C6', 'G5', 'E5', 'C5', 'G4'] },
      { wave: 'triangle', vol: 0.1, pattern: ['C3', r, 'C3', r, 'G2', r, 'G2', r, 'C3', r, 'C3', r, 'G2', r, 'G2', r, 'F2', r, 'F2', r, 'C3', r, 'C3', r, 'C3', r, 'C3', r, 'G2', r, 'G2', r] },
    ],
  };

  tracks.gameover = {
    bpm: 60,
    channels: [
      { wave: 'triangle', vol: 0.12, pattern: ['C5', r, 'B4', r, 'A4', r, 'G4', r, 'F4', r, 'E4', r, 'D4', r, 'C4', r, 'B3', r, 'A3', r, 'G3', r, 'F3', r, 'E3', r, 'D3', r, 'C3', r, r, r, r, r] },
      { wave: 'sine', vol: 0.08, pattern: ['C3', r, r, r, 'G2', r, r, r, 'F2', r, r, r, 'C2', r, r, r, 'C2', r, r, r, 'G2', r, r, r, 'F2', r, r, r, 'C2', r, r, r] },
    ],
  };

  return tracks;
}

const TRACKS = buildTracks();

function stopMusicVoices() {
  for (const v of _state.musicVoices) {
    try { v.stop(); v.disconnect(); } catch (e) {}
  }
  _state.musicVoices = [];
}

function music(track) {
  if (!_state.ready) return;
  if (track === _state.currentTrack) return;
  if (_state.musicTimer) { clearInterval(_state.musicTimer); _state.musicTimer = null; }
  stopMusicVoices();
  _state.currentTrack = track;
  if (!track) return;

  const def = TRACKS[track];
  if (!def) return;
  const stepDur = 60 / def.bpm / 2; // 8th notes
  _state.step = 0;
  _state.nextNoteTime = _state.ctx.currentTime + 0.1;

  _state.musicTimer = setInterval(() => {
    if (!_state.ctx) return;
    const lookahead = _state.ctx.currentTime + 0.15;
    while (_state.nextNoteTime < lookahead) {
      scheduleStep(def, _state.step, _state.nextNoteTime, stepDur);
      _state.step = (_state.step + 1) % def.channels[0].pattern.length;
      _state.nextNoteTime += stepDur;
    }
  }, 50);
}

function scheduleStep(def, step, time, dur) {
  for (const ch of def.channels) {
    const note = ch.pattern[step % ch.pattern.length];
    if (!note || note === 'rest') continue;
    const freq = noteFreq(note);
    if (!freq) continue;
    try {
      const osc = _state.ctx.createOscillator();
      const g = _state.ctx.createGain();
      osc.type = ch.wave;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(ch.vol, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur * 0.9);
      osc.connect(g);
      g.connect(_state.musicGain);
      osc.start(time);
      osc.stop(time + dur);
      _state.musicVoices.push(osc);
      osc.onended = () => {
        const idx = _state.musicVoices.indexOf(osc);
        if (idx >= 0) _state.musicVoices.splice(idx, 1);
        try { osc.disconnect(); g.disconnect(); } catch (e) {}
      };
    } catch (e) {}
  }
}

function stopAll() {
  music(null);
  for (const v of _state.activeVoices) { try { v.stop(); } catch (e) {} }
  _state.activeVoices.clear();
  _state.voiceCount = 0;
}

export const Audio = {
  init, play, music, stopAll,
  setMuted, isMuted,
  setMasterVolume, setSfxVolume, setMusicVolume,
  get currentTrack() { return _state.currentTrack; },
  isReady,
  noteFreq,
  _debugVoiceCount,
  SFX_NAMES, MUSIC_TRACKS,
};
export default Audio;
