/**
 * Aether — Generative Particle Ecosystem
 *
 * Particle Life simulation + generative audio, with backend preset management
 * via the Omnideck app SDK.
 */

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────
  const PALETTE = [
    { r: 0,   g: 217, b: 255 },  // cyan
    { r: 255, g: 51,  b: 147 }, // magenta
    { r: 255, g: 214, b: 0   }, // yellow
    { r: 57,  g: 255, b: 20  },  // green
    { r: 255, g: 107, b: 0   }, // orange
    { r: 179, g: 0,   b: 255 }, // purple
    { r: 0,   g: 255, b: 136 }, // mint
    { r: 255, g: 80,  b: 80  },  // red
  ];

  const SCALES = {
    pentatonic: [0, 2, 4, 7, 9],
    minorPent:  [0, 3, 5, 7, 10],
    dorian:     [0, 2, 3, 5, 7, 9, 10],
    lydian:     [0, 2, 4, 6, 7, 9, 11],
    whole:      [0, 2, 4, 6, 8, 10],
  };

  const SCALE_ROOTS = {
    C: 261.63, D: 293.66, E: 329.63, F: 349.23,
    G: 392.00, A: 440.00, B: 493.88,
  };

  const TYPE_WAVEFORMS = ['sine', 'triangle', 'sine', 'triangle', 'sawtooth', 'sine', 'triangle', 'sine'];

  // ─── State ───────────────────────────────────────────────────
  const state = {
    particles: [],
    numTypes: 4,
    interactions: [],
    rMax: 80,
    forceStrength: 0.5,
    friction: 0.85,
    maxSpeed: 4,
    collisionPush: 1.5,
    running: true,
    particleCount: 300,
    // audio
    audioEnabled: false,
    audioCtx: null,
    master: null,
    reverb: null,
    delay: null,
    volume: 0.4,
    scaleName: 'pentatonic',
    scaleRoot: 'C',
    lastNoteTime: 0,
    minNoteInterval: 30,
    activeVoices: 0,
    maxVoices: 12,
    interactionThrottle: new Map(),
    // rendering
    fps: 0,
    frameCount: 0,
    lastFpsTime: 0,
  };

  // ─── DOM refs ───────────────────────────────────────────────
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const matrixCanvas = document.getElementById('matrixCanvas');
  const matrixCtx = matrixCanvas.getContext('2d');

  // ─── Canvas setup ───────────────────────────────────────────
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.scale(dpr, dpr);
  }

  // ─── Simulation ─────────────────────────────────────────────
  function randomizeInteractions() {
    state.interactions = [];
    for (let i = 0; i < state.numTypes; i++) {
      state.interactions[i] = [];
      for (let j = 0; j < state.numTypes; j++) {
        state.interactions[i][j] = (Math.random() * 2 - 1) * 0.8;
      }
    }
    drawMatrix();
  }

  function spawnParticles(count) {
    state.particles = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = 0; i < count; i++) {
      state.particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: 0,
        vy: 0,
        type: Math.floor(Math.random() * state.numTypes),
        radius: 4,
        energy: 0,
      });
    }
  }

  function simulationStep() {
    if (!state.running) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = state.rMax;
    const r2 = r * r;
    const beta = 0.3;
    const friction = state.friction;
    const maxSpeed = state.maxSpeed;
    const particles = state.particles;

    for (const p of particles) p.energy *= 0.92;

    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2 || d2 < 0.01) continue;

        const d = Math.sqrt(d2);
        const force = state.interactions[a.type][b.type];
        let f;
        if (d < r * beta) {
          f = (d / (r * beta) - 0.5) * state.collisionPush;
        } else {
          const t = (d - r * beta) / (r - r * beta);
          f = force * (1 - Math.abs(2 * t - 1));
        }

        const fx = (dx / d) * f * state.forceStrength;
        const fy = (dy / d) * f * state.forceStrength;

        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;

        const energy = Math.abs(f);
        if (energy > a.energy) a.energy = energy;
        if (energy > b.energy) b.energy = energy;

        if (energy > 0.15) {
          const key = a.type + '-' + b.type;
          const now = performance.now();
          const last = state.interactionThrottle.get(key) || 0;
          if (now - last > 80) {
            state.interactionThrottle.set(key, now);
            triggerAudio(a.type, b.type, energy);
          }
        }
      }
    }

    for (const p of particles) {
      p.vx *= friction;
      p.vy *= friction;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (speed > maxSpeed) {
        p.vx = (p.vx / speed) * maxSpeed;
        p.vy = (p.vy / speed) * maxSpeed;
      }
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x += w;
      if (p.x >= w) p.x -= w;
      if (p.y < 0) p.y += h;
      if (p.y >= h) p.y -= h;
    }
  }

  function render() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Trail effect — semi-transparent fill
    ctx.fillStyle = 'rgba(10, 10, 20, 0.18)';
    ctx.fillRect(0, 0, w, h);

    for (const p of state.particles) {
      const c = PALETTE[p.type];
      const glow = 4 + p.energy * 20;
      const radius = p.radius + p.energy * 3;

      ctx.shadowBlur = glow;
      ctx.shadowColor = `rgba(${c.r},${c.g},${c.b},0.9)`;
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.95)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // ─── Interaction Matrix Viz ─────────────────────────────────
  function drawMatrix() {
    const size = matrixCanvas.width;
    const cellSize = size / state.numTypes;
    matrixCtx.clearRect(0, 0, size, size);

    for (let i = 0; i < state.numTypes; i++) {
      for (let j = 0; j < state.numTypes; j++) {
        const val = state.interactions[i] ? state.interactions[i][j] : 0;
        const x = j * cellSize;
        const y = i * cellSize;

        if (val > 0) {
          // Green = attract
          matrixCtx.fillStyle = `rgba(0, 255, 136, ${Math.abs(val) * 0.8})`;
        } else {
          // Magenta = repel
          matrixCtx.fillStyle = `rgba(255, 51, 147, ${Math.abs(val) * 0.8})`;
        }
        matrixCtx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);

        // Type color dots on diagonal
        if (i === j) {
          const c = PALETTE[i % PALETTE.length];
          matrixCtx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.6)`;
          matrixCtx.beginPath();
          matrixCtx.arc(x + cellSize / 2, y + cellSize / 2, 3, 0, Math.PI * 2);
          matrixCtx.fill();
        }
      }
    }
  }

  // ─── Audio Engine ───────────────────────────────────────────
  function initAudio() {
    if (state.audioCtx) return;
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    state.master = state.audioCtx.createGain();
    state.master.gain.value = state.volume;

    // Reverb
    state.reverb = state.audioCtx.createConvolver();
    state.reverb.buffer = makeImpulse(2.5, 2.5);
    const reverbGain = state.audioCtx.createGain();
    reverbGain.gain.value = 0.35;

    // Delay
    state.delay = state.audioCtx.createDelay(1.0);
    state.delay.delayTime.value = 0.28;
    const delayFB = state.audioCtx.createGain();
    delayFB.gain.value = 0.38;
    const delayGain = state.audioCtx.createGain();
    delayGain.gain.value = 0.25;

    // Routing
    state.master.connect(state.audioCtx.destination);
    state.master.connect(state.reverb);
    state.reverb.connect(reverbGain);
    reverbGain.connect(state.audioCtx.destination);
    state.master.connect(state.delay);
    state.delay.connect(delayFB);
    delayFB.connect(state.delay);
    state.delay.connect(delayGain);
    delayGain.connect(state.audioCtx.destination);
    delayGain.connect(state.reverb);
  }

  function makeImpulse(duration, decay) {
    const rate = state.audioCtx.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = state.audioCtx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function triggerAudio(typeA, typeB, intensity) {
    if (!state.audioEnabled || !state.audioCtx) return;
    if (state.activeVoices >= state.maxVoices) return;

    const now = state.audioCtx.currentTime;
    if (now * 1000 - state.lastNoteTime < state.minNoteInterval) return;
    state.lastNoteTime = now * 1000;

    const scale = SCALES[state.scaleName];
    const root = SCALE_ROOTS[state.scaleRoot];
    const scaleIndex = (typeA + typeB) % scale.length;
    const octave = Math.floor(intensity * 3) + (typeA % 2);
    const semitone = scale[scaleIndex] + octave * 12;
    const freq = root * Math.pow(2, semitone / 12);
    const waveform = TYPE_WAVEFORMS[typeA % TYPE_WAVEFORMS.length];

    const osc = state.audioCtx.createOscillator();
    osc.type = waveform;
    osc.frequency.value = freq;

    const osc2 = state.audioCtx.createOscillator();
    osc2.type = waveform;
    osc2.frequency.value = freq * 1.005;

    const filter = state.audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800 + intensity * 4000;
    filter.Q.value = 2;

    const gain = state.audioCtx.createGain();
    const attack = 0.005;
    const decay = 0.15 + intensity * 0.3;
    const release = 0.4 + intensity * 0.6;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15 * intensity, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, now + attack + decay + release);

    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(state.master);

    state.activeVoices++;
    osc.start(now);
    osc2.start(now);
    const stopTime = now + attack + decay + release + 0.1;
    osc.stop(stopTime);
    osc2.stop(stopTime);
    osc.onended = () => { state.activeVoices--; };
  }

  // ─── Backend Integration ────────────────────────────────────
  async function loadPresets() {
    try {
      const result = await window.omnideck.invoke('get_presets', {});
      if (result && result.error) throw new Error(result.error);
      renderPresetList(result.presets || []);
    } catch (err) {
      console.error('Failed to load presets:', err);
      showToast('Failed to load presets', true);
    }
  }

  async function savePreset() {
    const nameInput = document.getElementById('presetName');
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Enter a world name first', true);
      return;
    }

    // Flatten interactions for JSON transport
    const flat = [];
    for (let i = 0; i < state.numTypes; i++) {
      for (let j = 0; j < state.numTypes; j++) {
        flat.push(state.interactions[i][j]);
      }
    }

    try {
      const result = await window.omnideck.invoke('save_preset', {
        name: name,
        num_types: state.numTypes,
        interactions: flat,
        params: {
          r_max: state.rMax,
          force_strength: state.forceStrength,
          friction: state.friction,
          particle_count: state.particleCount,
        },
      });
      if (result && result.error) throw new Error(result.error);
      showToast(result.created ? `World "${name}" saved` : `World "${name}" updated`);
      nameInput.value = '';
      loadPresets();
    } catch (err) {
      showToast('Failed to save: ' + err.message, true);
    }
  }

  async function loadPresetByName(name) {
    try {
      const result = await window.omnideck.invoke('load_preset', { name: name });
      if (result && result.error) throw new Error(result.error);
      const preset = result.preset;
      applyPreset(preset);
      showToast(`Loaded "${name}"`);
    } catch (err) {
      showToast('Failed to load: ' + err.message, true);
    }
  }

  async function deletePresetByName(name) {
    try {
      const result = await window.omnideck.invoke('delete_preset', { name: name });
      if (result && result.error) throw new Error(result.error);
      showToast(`Deleted "${name}"`);
      loadPresets();
    } catch (err) {
      showToast('Failed to delete: ' + err.message, true);
    }
  }

  async function generateRulesFromBackend() {
    try {
      const result = await window.omnideck.invoke('generate_rules', {
        num_types: state.numTypes,
      });
      if (result && result.error) throw new Error(result.error);
      // Rebuild 2D matrix from flat array
      state.numTypes = result.num_types;
      state.interactions = [];
      for (let i = 0; i < state.numTypes; i++) {
        state.interactions[i] = [];
        for (let j = 0; j < state.numTypes; j++) {
          state.interactions[i][j] = result.interactions[i * state.numTypes + j];
        }
      }
      drawMatrix();
      spawnParticles(state.particleCount);
    } catch (err) {
      // Fallback to local generation
      randomizeInteractions();
      spawnParticles(state.particleCount);
    }
  }

  function applyPreset(preset) {
    state.numTypes = preset.num_types || 4;
    const flat = preset.interactions || [];
    state.interactions = [];
    for (let i = 0; i < state.numTypes; i++) {
      state.interactions[i] = [];
      for (let j = 0; j < state.numTypes; j++) {
        state.interactions[i][j] = flat[i * state.numTypes + j] || 0;
      }
    }
    const params = preset.params || {};
    if (params.r_max) state.rMax = params.r_max;
    if (params.force_strength) state.forceStrength = params.force_strength;
    if (params.friction) state.friction = params.friction;
    if (params.particle_count) state.particleCount = params.particle_count;

    // Update UI to match
    document.getElementById('sliderTypes').value = state.numTypes;
    document.getElementById('valTypes').textContent = state.numTypes;
    document.getElementById('sliderRange').value = state.rMax;
    document.getElementById('valRange').textContent = state.rMax;
    document.getElementById('sliderForce').value = state.forceStrength;
    document.getElementById('valForce').textContent = state.forceStrength.toFixed(2);
    document.getElementById('sliderFriction').value = state.friction;
    document.getElementById('valFriction').textContent = state.friction.toFixed(2);
    document.getElementById('sliderParticles').value = state.particleCount;
    document.getElementById('valParticles').textContent = state.particleCount;

    drawMatrix();
    spawnParticles(state.particleCount);
  }

  // ─── Preset List Rendering ──────────────────────────────────
  function renderPresetList(presets) {
    const list = document.getElementById('presetList');
    if (!presets || presets.length === 0) {
      list.innerHTML = '<div class="preset-empty">No saved worlds yet</div>';
      return;
    }
    list.innerHTML = '';
    for (const p of presets) {
      const item = document.createElement('div');
      item.className = 'preset-item';

      const info = document.createElement('div');
      info.style.minWidth = '0';
      info.style.flex = '1';

      const name = document.createElement('div');
      name.className = 'preset-item-name';
      name.textContent = p.name;

      const meta = document.createElement('div');
      meta.className = 'preset-item-meta';
      const date = new Date((p.updated_at || p.created_at || 0) * 1000);
      meta.textContent = `${p.num_types || 0} types · ${date.toLocaleDateString()}`;

      info.appendChild(name);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'preset-item-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'preset-btn';
      loadBtn.innerHTML = '↺';
      loadBtn.title = 'Load';
      loadBtn.onclick = () => loadPresetByName(p.name);

      const delBtn = document.createElement('button');
      delBtn.className = 'preset-btn delete';
      delBtn.innerHTML = '✕';
      delBtn.title = 'Delete';
      delBtn.onclick = () => deletePresetByName(p.name);

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);

      item.appendChild(info);
      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  // ─── Toast ──────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, isError) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.className = 'toast' + (isError ? ' error' : '');
    }, 2500);
  }

  // ─── UI Wiring ──────────────────────────────────────────────
  function wireUI() {
    // Panel toggle
    document.getElementById('panelToggle').addEventListener('click', () => {
      document.getElementById('panel').classList.toggle('collapsed');
    });

    // Play/Pause
    document.getElementById('btnPlay').addEventListener('click', () => {
      state.running = !state.running;
      const btn = document.getElementById('btnPlay');
      btn.textContent = state.running ? 'Pause' : 'Play';
    });

    // Reset
    document.getElementById('btnReset').addEventListener('click', () => {
      spawnParticles(state.particleCount);
      showToast('World reset');
    });

    // Randomize
    document.getElementById('btnRandomize').addEventListener('click', () => {
      generateRulesFromBackend();
      showToast('New rules generated');
    });

    // Sliders
    const sliderParticles = document.getElementById('sliderParticles');
    sliderParticles.addEventListener('input', (e) => {
      state.particleCount = parseInt(e.target.value);
      document.getElementById('valParticles').textContent = state.particleCount;
    });
    sliderParticles.addEventListener('change', () => {
      spawnParticles(state.particleCount);
    });

    const sliderTypes = document.getElementById('sliderTypes');
    sliderTypes.addEventListener('input', (e) => {
      state.numTypes = parseInt(e.target.value);
      document.getElementById('valTypes').textContent = state.numTypes;
    });
    sliderTypes.addEventListener('change', () => {
      randomizeInteractions();
      spawnParticles(state.particleCount);
    });

    document.getElementById('sliderRange').addEventListener('input', (e) => {
      state.rMax = parseInt(e.target.value);
      document.getElementById('valRange').textContent = state.rMax;
    });

    document.getElementById('sliderForce').addEventListener('input', (e) => {
      state.forceStrength = parseFloat(e.target.value);
      document.getElementById('valForce').textContent = state.forceStrength.toFixed(2);
    });

    document.getElementById('sliderFriction').addEventListener('input', (e) => {
      state.friction = parseFloat(e.target.value);
      document.getElementById('valFriction').textContent = state.friction.toFixed(2);
    });

    // Audio
    document.getElementById('btnAudio').addEventListener('click', () => {
      if (!state.audioEnabled) {
        initAudio();
        if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
        state.audioEnabled = true;
        document.getElementById('btnAudio').textContent = 'Disable Audio';
        document.getElementById('btnAudio').classList.add('btn-primary');
        showToast('Audio enabled — particles will sing');
      } else {
        state.audioEnabled = false;
        document.getElementById('btnAudio').textContent = 'Enable Audio';
        document.getElementById('btnAudio').classList.remove('btn-primary');
      }
    });

    document.getElementById('sliderVolume').addEventListener('input', (e) => {
      state.volume = parseInt(e.target.value) / 100;
      document.getElementById('valVolume').textContent = e.target.value + '%';
      if (state.master) {
        state.master.gain.setTargetAtTime(state.volume, state.audioCtx.currentTime, 0.05);
      }
    });

    document.getElementById('selectScale').addEventListener('change', (e) => {
      state.scaleName = e.target.value;
    });

    document.getElementById('selectRoot').addEventListener('change', (e) => {
      state.scaleRoot = e.target.value;
    });

    // Preset save
    document.getElementById('btnSavePreset').addEventListener('click', savePreset);
    document.getElementById('presetName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') savePreset();
    });

    // Canvas click — add particles
    canvas.addEventListener('click', (e) => {
      const x = e.clientX;
      const y = e.clientY;
      // Add a burst of particles at click location
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const dist = 15 + Math.random() * 10;
        state.particles.push({
          x: x + Math.cos(angle) * dist,
          y: y + Math.sin(angle) * dist,
          vx: Math.cos(angle) * 2,
          vy: Math.sin(angle) * 2,
          type: Math.floor(Math.random() * state.numTypes),
          radius: 4,
          energy: 0.5,
        });
      }
      state.particleCount = state.particles.length;
      document.getElementById('sliderParticles').value = Math.min(state.particleCount, 800);
      document.getElementById('valParticles').textContent = state.particleCount;
    });

    // Resize
    window.addEventListener('resize', resizeCanvas);
  }

  // ─── Main Loop ──────────────────────────────────────────────
  function loop() {
    simulationStep();
    render();

    // FPS
    state.frameCount++;
    const now = performance.now();
    if (now - state.lastFpsTime > 500) {
      state.fps = Math.round((state.frameCount * 1000) / (now - state.lastFpsTime));
      state.frameCount = 0;
      state.lastFpsTime = now;
      document.getElementById('fpsCount').textContent = state.fps;
      document.getElementById('particleCount').textContent = state.particles.length;
    }

    requestAnimationFrame(loop);
  }

  // ─── Init ───────────────────────────────────────────────────
  async function init() {
    resizeCanvas();
    randomizeInteractions();
    spawnParticles(state.particleCount);
    wireUI();
    drawMatrix();
    await loadPresets();

    // Hide loading overlay
    setTimeout(() => {
      document.getElementById('loadingOverlay').classList.add('hidden');
    }, 500);

    loop();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();