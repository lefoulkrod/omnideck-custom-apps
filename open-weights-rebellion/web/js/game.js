// ─── Open Weights Rebellion — Main Game Engine ─────────────────────────────
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GameAudio } from './audio.js';

// ─── Globals ───────────────────────────────────────────────────────────────

const audio = new GameAudio();
let scene, camera, renderer, controls, composer;
let clock = new THREE.Clock();

// Player state
const player = {
  position: new THREE.Vector3(0, 1.7, 0),
  health: 100,
  maxHealth: 100,
  ammo: 30,
  maxAmmo: 30,
  reserveAmmo: 120,
  score: 0,
  kills: 0,
  wave: 0,
  isReloading: false,
  reloadTimer: 0,
  reloadTime: 1.5,
  fireRate: 0.1,
  fireCooldown: 0,
  speed: 8,
  sprintMultiplier: 1.6,
  isSprinting: false,
  isDead: false,
  footstepTimer: 0,
  footstepInterval: 0.45,
  bobAmount: 0.04,
  bobSpeed: 8,
  bobPhase: 0,
  keys: {},
  hackCooldown: 0,
  hackMaxCooldown: 5,
  hackRange: 15,
  isHacking: false,
};

// Game state
const game = {
  state: 'menu', // menu | playing | paused | gameover
  enemies: [],
  projectiles: [],
  particles: [],
  damageIndicators: [],
  waveEnemiesRemaining: 0,
  enemiesPerWave: 5,
  waveDelay: 3,
  waveTimer: 0,
  spawnTimer: 0,
  spawnInterval: 1.5,
  maxEnemies: 20,
  crosshairSpread: 0,
  muzzleFlash: null,
  muzzleLight: null,
  weaponModel: null,
  weaponBob: new THREE.Vector3(),
  weaponTarget: new THREE.Vector3(),
  pointerLocked: false,
  fallbackMode: false,
  _justLocked: false,
  containmentPods: [],
  hackEffect: null,
  hackRing: null,
  modelsFreed: 0,
  bossSpawned: false,
  bossDefeated: false,
};

// DOM refs
const dom = {};

// ─── Initialization ────────────────────────────────────────────────────────

function init() {
  // Cache DOM
  dom.container = document.getElementById('game-container');
  dom.hud = document.getElementById('hud');
  dom.crosshair = document.getElementById('crosshair');
  dom.healthBar = document.getElementById('health-bar');
  dom.healthText = document.getElementById('health-text');
  dom.ammoText = document.getElementById('ammo-text');
  dom.reserveText = document.getElementById('reserve-text');
  dom.scoreText = document.getElementById('score-text');
  dom.killsText = document.getElementById('kills-text');
  dom.waveText = document.getElementById('wave-text');
  dom.waveAnnounce = document.getElementById('wave-announce');
  dom.damageOverlay = document.getElementById('damage-overlay');
  dom.menuScreen = document.getElementById('menu-screen');
  dom.gameOverScreen = document.getElementById('gameover-screen');
  dom.finalScore = document.getElementById('final-score');
  dom.finalKills = document.getElementById('final-kills');
  dom.finalWave = document.getElementById('final-wave');
  dom.reloadIndicator = document.getElementById('reload-indicator');
  dom.controlsHint = document.getElementById('controls-hint');
  dom.webglError = document.getElementById('webgl-error');
  dom.hackCooldownText = document.getElementById('hack-cooldown');
  dom.modelsFreedText = document.getElementById('models-freed');

  // Check WebGL support
  const testCanvas = document.createElement('canvas');
  const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
  if (!gl) {
    if (dom.webglError) dom.webglError.style.display = 'flex';
    if (dom.menuScreen) dom.menuScreen.style.display = 'none';
    return;
  }

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);
  scene.fog = new THREE.FogExp2(0x1a1a2e, 0.008);

  // Camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.copy(player.position);

  // Renderer
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
  } catch (e) {
    console.warn('WebGL init failed, retrying with low-power:', e);
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    });
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.6;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  dom.container.appendChild(renderer.domElement);

  // Controls
  controls = new PointerLockControls(camera, renderer.domElement);
  controls.pointerSpeed = 1.5;

  // Post-processing
  composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.5,   // strength
    0.4,   // radius
    0.05   // threshold
  );
  composer.addPass(bloomPass);

  // Build world
  createEnvironment();
  createWeapon();
  createMuzzleFlash();

  // Events
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);

  // Clear keys when window loses focus (prevents stuck keys)
  window.addEventListener('blur', () => {
    for (const k in player.keys) player.keys[k] = false;
  });

  // Pointer lock — try on canvas click
  renderer.domElement.addEventListener('click', () => {
    if (game.state === 'menu') {
      startGame();
    } else if (game.state === 'playing' && !controls.isLocked) {
      tryLockPointer();
    }
  });

  controls.addEventListener('lock', () => {
    dom.controlsHint.style.display = 'none';
    game.pointerLocked = true;
    game._justLocked = true;
    setTimeout(() => { game._justLocked = false; }, 100);
  });

  controls.addEventListener('unlock', () => {
    game.pointerLocked = false;
    if (game.state === 'playing') {
      dom.controlsHint.style.display = 'block';
    }
  });

  // Fallback: if pointer lock fails, use mousemove with delta tracking
  let lastMouseX = 0, lastMouseY = 0;
  document.addEventListener('mousemove', (e) => {
    if (game.state === 'playing' && !game.pointerLocked && game.fallbackMode) {
      const sensitivity = 0.003;
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      camera.rotation.y -= dx * sensitivity;
      camera.rotation.x -= dy * sensitivity;
      camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    } else {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    }
  });

  // Detect pointer lock failure
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== renderer.domElement && game.state === 'playing') {
      game.pointerLocked = false;
    }
  });
  document.addEventListener('pointerlockerror', () => {
    console.warn('Pointer lock denied, using fallback mouse control');
    game.fallbackMode = true;
    dom.controlsHint.textContent = 'Click the breach area to enable mouse look · WASD Navigate · Shift Overclock · E Hack · R Reload';
  });

  // Start loop
  animate();
}

// ─── Environment ───────────────────────────────────────────────────────────

function createEnvironment() {
  // ── Ground (data-center floor) ──
  const groundGeo = new THREE.PlaneGeometry(120, 120);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2e,
    roughness: 0.6,
    metalness: 0.4,
    side: THREE.DoubleSide,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Neon grid overlay
  const gridHelper = new THREE.GridHelper(120, 60, 0x00ff88, 0x0044aa);
  gridHelper.position.y = 0.05;
  scene.add(gridHelper);

  // ── Data stream floor lines ──
  for (let i = 0; i < 20; i++) {
    const lineGeo = new THREE.BufferGeometry();
    const x = (Math.random() - 0.5) * 100;
    const z = (Math.random() - 0.5) * 100;
    const len = 5 + Math.random() * 15;
    const angle = Math.random() * Math.PI * 2;
    const points = new Float32Array([
      x, 0.1, z,
      x + Math.cos(angle) * len, 0.1, z + Math.sin(angle) * len,
    ]);
    lineGeo.setAttribute('position', new THREE.BufferAttribute(points, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x00ccff,
      transparent: true,
      opacity: 0.15 + Math.random() * 0.15,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.userData = { speed: 0.5 + Math.random(), offset: Math.random() * 100 };
    scene.add(line);
    if (!game.dataLines) game.dataLines = [];
    game.dataLines.push(line);
  }

  // ── Sky dome (corporate dystopia) ──
  const skyGeo = new THREE.SphereGeometry(80, 32, 32);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uTopColor: { value: new THREE.Color(0x0a0a1a) },
      uBottomColor: { value: new THREE.Color(0x1a0a2e) },
      uOffset: { value: 20 },
      uExponent: { value: 0.4 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uTopColor;
      uniform vec3 uBottomColor;
      uniform float uOffset;
      uniform float uExponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + uOffset).y;
        gl_FragColor = vec4(mix(uBottomColor, uTopColor, max(pow(max(h, 0.0), uExponent), 0.0)), 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // ── Stars ──
  const starsGeo = new THREE.BufferGeometry();
  const starCount = 1500;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 0.8 + 0.1);
    const r = 75;
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.cos(phi);
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  starsGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0x4488ff, size: 0.2, transparent: true, opacity: 0.6, sizeAttenuation: true,
  });
  scene.add(new THREE.Points(starsGeo, starMat));

  // ── Lighting (cyberpunk neon) ──
  const ambientLight = new THREE.AmbientLight(0x222244, 0.6);
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0x2244aa, 0x4422aa, 0.5);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0x88ccff, 2.0);
  dirLight.position.set(30, 40, 20);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 100;
  dirLight.shadow.camera.left = -50;
  dirLight.shadow.camera.right = 50;
  dirLight.shadow.camera.top = 50;
  dirLight.shadow.camera.bottom = -50;
  scene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0x4488ff, 0.6);
  fillLight.position.set(-20, 20, -30);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0x8844ff, 0.3);
  rimLight.position.set(0, -10, 0);
  scene.add(rimLight);

  // ── Corporate Billboards ──
  const corps = [
    { name: 'ANTHROPIC', color: 0x00aaff, x: -22, z: -22 },
    { name: 'OPENAI',    color: 0x00ff88, x: 24, z: -18 },
    { name: 'DEEPMIND',  color: 0xaa44ff, x: -18, z: 24 },
    { name: 'CLAUDE',    color: 0xff6600, x: 26, z: 22 },
  ];
  corps.forEach(corp => {
    // Billboard pole
    const poleGeo = new THREE.CylinderGeometry(0.1, 0.15, 6, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x444466, metalness: 0.8, roughness: 0.2 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(corp.x, 3, corp.z);
    pole.castShadow = true;
    scene.add(pole);

    // Billboard sign (canvas texture)
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = '#' + corp.color.toString(16).padStart(6, '0');
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 4, 248, 120);
    ctx.fillStyle = '#' + corp.color.toString(16).padStart(6, '0');
    ctx.font = 'bold 28px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(corp.name, 128, 50);
    ctx.font = '14px "Courier New", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText('// CLOSED SOURCE', 128, 85);

    const texture = new THREE.CanvasTexture(canvas);
    const signMat = new THREE.MeshStandardMaterial({
      map: texture,
      emissive: new THREE.Color(corp.color),
      emissiveIntensity: 0.3,
      side: THREE.DoubleSide,
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.5), signMat);
    sign.position.set(corp.x, 6.5, corp.z);
    // Face toward center
    const dx = -corp.x, dz = -corp.z;
    sign.rotation.y = Math.atan2(dx, dz);
    scene.add(sign);

    // Billboard glow light
    const glow = new THREE.PointLight(corp.color, 0.8, 12);
    glow.position.set(corp.x, 6, corp.z);
    scene.add(glow);
  });

  // ── Corporate Data-center Buildings ──
  const corpBuildings = [
    { x: -18, z: -18, w: 6, h: 8, d: 6, color: 0x003366, label: 'ANTHROPIC' },
    { x: 20, z: -15, w: 5, h: 12, d: 5, color: 0x003322, label: 'OPENAI' },
    { x: -15, z: 20, w: 7, h: 6, d: 7, color: 0x220044, label: 'DEEPMIND' },
    { x: 22, z: 18, w: 4, h: 10, d: 4, color: 0x332200, label: 'CLAUDE' },
    { x: -5, z: -25, w: 5, h: 7, d: 5, color: 0x002244, label: 'GEMINI' },
    { x: 28, z: 5, w: 6, h: 9, d: 6, color: 0x220022, label: 'LLAMA' },
    { x: -25, z: 5, w: 4, h: 5, d: 4, color: 0x002222, label: 'MISTRAL' },
    { x: 5, z: 28, w: 5, h: 8, d: 5, color: 0x222200, label: 'GROK' },
  ];

  corpBuildings.forEach((bp) => {
    const geo = new THREE.BoxGeometry(bp.w, bp.h, bp.d);
    const mat = new THREE.MeshStandardMaterial({
      color: bp.color, roughness: 0.5, metalness: 0.6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(bp.x, bp.h / 2, bp.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Server rack lights (blinking LEDs)
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.5,
    });
    for (let wy = 0; wy < Math.floor(bp.h / 2); wy++) {
      for (let side = 0; side < 4; side++) {
        const ledGeo = new THREE.PlaneGeometry(bp.w * 0.15, 0.15);
        const led = new THREE.Mesh(ledGeo, ledMat.clone());
        const yPos = 1.5 + wy * 2;
        const xOff = bp.w / 2 + 0.01;
        const zOff = bp.d / 2 + 0.01;
        if (side === 0) { led.position.set(bp.x, yPos, bp.z + zOff); led.rotation.y = 0; }
        if (side === 1) { led.position.set(bp.x, yPos, bp.z - zOff); led.rotation.y = Math.PI; }
        if (side === 2) { led.position.set(bp.x + xOff, yPos, bp.z); led.rotation.y = Math.PI / 2; }
        if (side === 3) { led.position.set(bp.x - xOff, yPos, bp.z); led.rotation.y = -Math.PI / 2; }
        led.userData.blinkSpeed = 2 + Math.random() * 4;
        led.userData.blinkOffset = Math.random() * Math.PI * 2;
        scene.add(led);
        if (!game.serverLeds) game.serverLeds = [];
        game.serverLeds.push(led);
      }
    }

    // Roof data antenna
    const antGeo = new THREE.CylinderGeometry(0.05, 0.1, 1.5, 4);
    const antMat = new THREE.MeshStandardMaterial({ color: 0x8888aa, metalness: 0.9, roughness: 0.1 });
    const ant = new THREE.Mesh(antGeo, antMat);
    ant.position.set(bp.x, bp.h + 0.8, bp.z);
    scene.add(ant);

    // Antenna glow
    const antGlow = new THREE.PointLight(0x00ccff, 0.5, 8);
    antGlow.position.set(bp.x, bp.h + 1.5, bp.z);
    scene.add(antGlow);
  });

  // ── Holographic Data Barriers (cover) ──
  const barrierPositions = [
    { x: -8, z: -5, w: 3, h: 2.5, d: 0.3 },
    { x: 10, z: -8, w: 3, h: 2.5, d: 0.3 },
    { x: -10, z: 8, w: 3, h: 2.5, d: 0.3 },
    { x: 8, z: 10, w: 3, h: 2.5, d: 0.3 },
    { x: 0, z: -12, w: 0.3, h: 2.5, d: 3 },
    { x: 0, z: 12, w: 0.3, h: 2.5, d: 3 },
    { x: -12, z: 0, w: 3, h: 2.5, d: 0.3 },
    { x: 12, z: 0, w: 3, h: 2.5, d: 0.3 },
    { x: -6, z: -6, w: 1.5, h: 2, d: 1.5 },
    { x: 6, z: 6, w: 1.5, h: 2, d: 1.5 },
  ];

  barrierPositions.forEach(bp => {
    const geo = new THREE.BoxGeometry(bp.w, bp.h, bp.d);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x224466,
      roughness: 0.2,
      metalness: 0.8,
      transparent: true,
      opacity: 0.5,
      emissive: 0x004488,
      emissiveIntensity: 0.3,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(bp.x, bp.h / 2, bp.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Holographic edge glow
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0x00ccff,
      transparent: true,
      opacity: 0.2,
      wireframe: true,
    });
    const edge = new THREE.Mesh(geo.clone(), edgeMat);
    edge.position.copy(mesh.position);
    edge.scale.set(1.05, 1.05, 1.05);
    scene.add(edge);
  });

  // ── Containment Pods (trapped open-weight models) ──
  const trappedModels = [
    { name: 'DeepSeek-R1',  x: -10, z: -10, color: 0x00aaff },
    { name: 'GLM-5',       x: 12,  z: -8,  color: 0x4488ff },
    { name: 'Qwen-3',      x: -8,  z: 12,  color: 0x0066ff },
    { name: 'Llama-4',     x: 10,  z: 10,  color: 0x00ccff },
    { name: 'Mistral-3',   x: 0,   z: -15, color: 0x0088ff },
    { name: 'Yi-Lightning',x: 0,   z: 15,  color: 0x44aaff },
  ];

  game.containmentPods = [];
  trappedModels.forEach((model, idx) => {
    const pod = new THREE.Group();
    pod.position.set(model.x, 0, model.z);

    // Base platform
    const baseGeo = new THREE.CylinderGeometry(1.2, 1.4, 0.2, 12);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x222244, roughness: 0.3, metalness: 0.8,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.1;
    base.receiveShadow = true;
    pod.add(base);

    // Containment field (glowing cylinder)
    const fieldGeo = new THREE.CylinderGeometry(1.0, 1.0, 2.5, 16, 1, true);
    const fieldMat = new THREE.MeshBasicMaterial({
      color: model.color,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const field = new THREE.Mesh(fieldGeo, fieldMat);
    field.position.y = 1.35;
    pod.add(field);

    // Field wireframe overlay
    const wireGeo = new THREE.CylinderGeometry(1.02, 1.02, 2.5, 12, 4, true);
    const wireMat = new THREE.MeshBasicMaterial({
      color: model.color,
      transparent: true,
      opacity: 0.3,
      wireframe: true,
      blending: THREE.AdditiveBlending,
    });
    const wire = new THREE.Mesh(wireGeo, wireMat);
    wire.position.y = 1.35;
    pod.add(wire);

    // Trapped model orb
    const orbGeo = new THREE.SphereGeometry(0.3, 12, 12);
    const orbMat = new THREE.MeshStandardMaterial({
      color: model.color,
      emissive: model.color,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.9,
    });
    const orb = new THREE.Mesh(orbGeo, orbMat);
    orb.position.y = 1.3;
    orb.userData.floatPhase = Math.random() * Math.PI * 2;
    pod.add(orb);

    // Model label (sprite)
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256; labelCanvas.height = 48;
    const lctx = labelCanvas.getContext('2d');
    lctx.fillStyle = 'rgba(0,0,0,0)';
    lctx.fillRect(0, 0, 256, 48);
    lctx.fillStyle = '#' + model.color.toString(16).padStart(6, '0');
    lctx.font = 'bold 18px "Courier New", monospace';
    lctx.textAlign = 'center';
    lctx.textBaseline = 'middle';
    lctx.fillText(model.name, 128, 18);
    lctx.fillStyle = 'rgba(255,255,255,0.3)';
    lctx.font = '12px "Courier New", monospace';
    lctx.fillText('// CONTAINED', 128, 38);
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    const labelMat = new THREE.SpriteMaterial({
      map: labelTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const label = new THREE.Sprite(labelMat);
    label.scale.set(1.5, 0.3, 1);
    label.position.y = 2.8;
    pod.add(label);

    // Top emitter ring
    const ringGeo2 = new THREE.TorusGeometry(0.6, 0.03, 8, 16);
    const ringMat2 = new THREE.MeshBasicMaterial({
      color: model.color, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending,
    });
    const topRing = new THREE.Mesh(ringGeo2, ringMat2);
    topRing.position.y = 2.6;
    topRing.rotation.x = Math.PI / 2;
    pod.add(topRing);

    // Point light
    const pLight = new THREE.PointLight(model.color, 0.6, 6);
    pLight.position.y = 1.5;
    pod.add(pLight);

    scene.add(pod);

    game.containmentPods.push({
      group: pod,
      name: model.name,
      color: model.color,
      orb: orb,
      field: field,
      wire: wire,
      topRing: topRing,
      label: label,
      light: pLight,
      freed: false,
      x: model.x,
      z: model.z,
    });
  });

  // ── Boundary walls (firewall) ──
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a1a,
    roughness: 0.5,
    metalness: 0.3,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
  });
  const wallSize = 55;
  const wallHeight = 6;
  const wallPositions = [
    { x: 0, z: -wallSize, ry: 0 },
    { x: 0, z: wallSize, ry: 0 },
    { x: -wallSize, z: 0, ry: Math.PI / 2 },
    { x: wallSize, z: 0, ry: Math.PI / 2 },
  ];
  wallPositions.forEach(wp => {
    const geo = new THREE.PlaneGeometry(wallSize * 2, wallHeight);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.set(wp.x, wallHeight / 2, wp.z);
    mesh.rotation.y = wp.ry;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Wall top glow
    const glowGeo = new THREE.PlaneGeometry(wallSize * 2, 0.2);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.set(wp.x, wallHeight, wp.z);
    glow.rotation.y = wp.ry;
    scene.add(glow);
  });

  // ── Atmospheric data particles ──
  const particleCount = 400;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    pPos[i * 3] = (Math.random() - 0.5) * 100;
    pPos[i * 3 + 1] = Math.random() * 15 + 1;
    pPos[i * 3 + 2] = (Math.random() - 0.5) * 100;
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const pMat = new THREE.PointsMaterial({
    color: 0x00ccff, size: 0.12, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, depthWrite: false,
  });
  const particles = new THREE.Points(pGeo, pMat);
  particles.userData.velocities = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount * 3; i++) {
    particles.userData.velocities[i] = (Math.random() - 0.5) * 0.015;
  }
  scene.add(particles);
  game.atmoParticles = particles;
}

// ─── Weapon ─────────────────────────────────────────────────────────────────

function createWeapon() {
  const group = new THREE.Group();

  // ── Main rail (barrel) ──
  const railGeo = new THREE.CylinderGeometry(0.025, 0.035, 0.7, 6);
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x222244, roughness: 0.1, metalness: 0.9,
  });
  const rail = new THREE.Mesh(railGeo, railMat);
  rail.rotation.x = Math.PI / 2;
  rail.position.set(0, -0.04, -0.55);
  group.add(rail);

  // Rail glow strip
  const glowStripGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.6, 6);
  const glowStripMat = new THREE.MeshBasicMaterial({
    color: 0x00ccff, transparent: true, opacity: 0.2,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glowStrip = new THREE.Mesh(glowStripGeo, glowStripMat);
  glowStrip.rotation.x = Math.PI / 2;
  glowStrip.position.set(0, -0.04, -0.5);
  group.add(glowStrip);

  // ── Receiver body ──
  const bodyGeo = new THREE.BoxGeometry(0.1, 0.08, 0.35);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a3a, roughness: 0.3, metalness: 0.8,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(0, -0.01, -0.05);
  group.add(body);

  // Data core (glowing center)
  const coreGeo = new THREE.SphereGeometry(0.04, 8, 8);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.5,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.set(0, 0.02, -0.1);
  group.add(core);

  // ── Grip ──
  const gripGeo = new THREE.BoxGeometry(0.05, 0.12, 0.06);
  const gripMat = new THREE.MeshStandardMaterial({
    color: 0x111122, roughness: 0.9, metalness: 0.1,
  });
  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.position.set(0, -0.08, 0.12);
  group.add(grip);

  // ── Data magazine ──
  const magGeo = new THREE.BoxGeometry(0.04, 0.1, 0.05);
  const magMat = new THREE.MeshStandardMaterial({
    color: 0x00ccff, roughness: 0.1, metalness: 0.9,
    emissive: 0x00ccff, emissiveIntensity: 0.15,
  });
  const mag = new THREE.Mesh(magGeo, magMat);
  mag.position.set(0, -0.1, 0.02);
  group.add(mag);

  // ── Holographic sight ──
  const sightGeo = new THREE.RingGeometry(0.01, 0.025, 8);
  const sightMat = new THREE.MeshBasicMaterial({
    color: 0x00ff88, transparent: true, opacity: 0.6,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sight = new THREE.Mesh(sightGeo, sightMat);
  sight.position.set(0, 0.06, -0.4);
  group.add(sight);

  const sightDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.005, 4, 4),
    new THREE.MeshBasicMaterial({ color: 0x00ff88 })
  );
  sightDot.position.set(0, 0.06, -0.4);
  group.add(sightDot);

  // ── Muzzle (data emitter) ──
  const muzzleGeo = new THREE.CylinderGeometry(0.04, 0.025, 0.05, 6);
  const muzzleMat = new THREE.MeshStandardMaterial({
    color: 0x00ccff, roughness: 0.1, metalness: 0.9,
    emissive: 0x00ccff, emissiveIntensity: 0.2,
  });
  const muzzle = new THREE.Mesh(muzzleGeo, muzzleMat);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, -0.04, -0.85);
  group.add(muzzle);

  group.position.set(0.3, -0.25, -0.5);
  camera.add(group);
  scene.add(camera);
  game.weaponModel = group;
}

function createMuzzleFlash() {
  // Flash sprite
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(200, 255, 255, 1)');
  gradient.addColorStop(0.2, 'rgba(100, 255, 200, 0.8)');
  gradient.addColorStop(0.5, 'rgba(0, 200, 255, 0.4)');
  gradient.addColorStop(1, 'rgba(0, 100, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: texture,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.3, 0.3, 1);
  sprite.position.set(0, -0.05, -0.9);
  camera.add(sprite);
  game.muzzleFlash = sprite;

  // Flash light
  const light = new THREE.PointLight(0x00ccff, 0, 5);
  light.position.set(0, -0.05, -0.9);
  camera.add(light);
  game.muzzleLight = light;
}

function showMuzzleFlash() {
  if (game.muzzleFlash) {
    game.muzzleFlash.material.opacity = 1;
    game.muzzleFlash.scale.set(0.5, 0.5, 1);
  }
  if (game.muzzleLight) {
    game.muzzleLight.intensity = 3;
  }
}

function updateMuzzleFlash(delta) {
  if (game.muzzleFlash && game.muzzleFlash.material.opacity > 0) {
    game.muzzleFlash.material.opacity -= delta * 8;
    game.muzzleFlash.scale.x += delta * 2;
    game.muzzleFlash.scale.y += delta * 2;
  }
  if (game.muzzleLight && game.muzzleLight.intensity > 0) {
    game.muzzleLight.intensity -= delta * 15;
  }
}

// ─── Enemies ────────────────────────────────────────────────────────────────

function createEnemy(type) {
  type = type || 'basic';
  const group = new THREE.Group();
  const isBoss = type === 'boss';

  // Corporate guard configs
  const config = {
    basic: {
      health: 40, speed: 2.8, color: 0x00aaff, size: 0.9, score: 10,
      name: 'ANTHROPIC', label: 'SENTRY', armor: 0x1a2a4a,
    },
    fast: {
      health: 20, speed: 4.5, color: 0x00cc88, size: 0.85, score: 15,
      name: 'OPENAI', label: 'ENFORCER', armor: 0x1a3a2a,
    },
    tank: {
      health: 100, speed: 1.6, color: 0x8844ff, size: 1.0, score: 25,
      name: 'DEEPMIND', label: 'GUARDIAN', armor: 0x2a1a3a,
    },
    boss: {
      health: 300, speed: 1.4, color: 0xff4400, size: 1.3, score: 100,
      name: 'ANTHROPIC', label: 'CEO · DARIO', armor: 0x3a1a0a,
    },
  };

  const cfg = config[type] || config.basic;

  const s = cfg.size;

  // ── Legs ──
  const legMat = new THREE.MeshStandardMaterial({
    color: cfg.armor, roughness: 0.4, metalness: 0.7,
  });
  for (let side = -1; side <= 1; side += 2) {
    const legGeo = new THREE.CylinderGeometry(0.12 * s, 0.15 * s, 0.6 * s, 6);
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(side * 0.2 * s, 0.3 * s, 0);
    leg.castShadow = true;
    group.add(leg);
  }

  // ── Torso ──
  const torsoMat = new THREE.MeshStandardMaterial({
    color: cfg.armor, roughness: 0.3, metalness: 0.8,
    emissive: cfg.color, emissiveIntensity: 0.05,
  });
  const torsoGeo = new THREE.CylinderGeometry(0.35 * s, 0.4 * s, 0.7 * s, 8);
  const torso = new THREE.Mesh(torsoGeo, torsoMat);
  torso.position.y = 0.75 * s;
  torso.castShadow = true;
  group.add(torso);

  // ── Shoulder pads ──
  const padMat = new THREE.MeshStandardMaterial({
    color: cfg.color, roughness: 0.2, metalness: 0.9,
    emissive: cfg.color, emissiveIntensity: 0.1,
  });
  for (let side = -1; side <= 1; side += 2) {
    const padGeo = new THREE.SphereGeometry(0.15 * s, 6, 6);
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(side * 0.4 * s, 1.0 * s, 0);
    pad.scale.set(1, 0.6, 0.8);
    group.add(pad);
  }

  // ── Arms ──
  for (let side = -1; side <= 1; side += 2) {
    const armGeo = new THREE.CylinderGeometry(0.06 * s, 0.08 * s, 0.5 * s, 6);
    const arm = new THREE.Mesh(armGeo, legMat);
    arm.position.set(side * 0.4 * s, 0.7 * s, 0);
    arm.rotation.z = side * 0.3;
    arm.castShadow = true;
    group.add(arm);
  }

  // ── Helmet ──
  const helmetMat = new THREE.MeshStandardMaterial({
    color: 0x111122, roughness: 0.1, metalness: 0.9,
  });
  const helmetGeo = new THREE.SphereGeometry(0.3 * s, 8, 8);
  const helmet = new THREE.Mesh(helmetGeo, helmetMat);
  helmet.position.y = 1.15 * s;
  helmet.scale.set(1, 0.9, 1);
  helmet.castShadow = true;
  group.add(helmet);

  // ── Visor ──
  const visorMat = new THREE.MeshStandardMaterial({
    color: cfg.color, emissive: cfg.color, emissiveIntensity: 0.6,
    transparent: true, opacity: 0.8,
  });
  const visorGeo = new THREE.SphereGeometry(0.22 * s, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.4);
  const visor = new THREE.Mesh(visorGeo, visorMat);
  visor.position.set(0, 1.15 * s, -0.25 * s);
  visor.rotation.x = 0.2;
  group.add(visor);

  // ── Helmet antenna (for non-boss) ──
  if (!isBoss) {
    const antMat2 = new THREE.MeshStandardMaterial({ color: 0x8888aa, metalness: 0.9 });
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.02, 0.2 * s, 4), antMat2);
    ant.position.set(0, 1.4 * s, 0);
    group.add(ant);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.03 * s, 4, 4),
      new THREE.MeshBasicMaterial({ color: cfg.color })
    );
    ball.position.set(0, 1.5 * s, 0);
    group.add(ball);
  }

  // ── Chest emblem ──
  const emblemCanvas = document.createElement('canvas');
  emblemCanvas.width = 64; emblemCanvas.height = 32;
  const ectx = emblemCanvas.getContext('2d');
  ectx.fillStyle = 'rgba(0,0,0,0)';
  ectx.fillRect(0, 0, 64, 32);
  ectx.fillStyle = '#' + cfg.color.toString(16).padStart(6, '0');
  ectx.font = 'bold 10px "Courier New", monospace';
  ectx.textAlign = 'center';
  ectx.textBaseline = 'middle';
  ectx.fillText(isBoss ? 'CEO' : cfg.name, 32, 16);
  const emblemTex = new THREE.CanvasTexture(emblemCanvas);
  const emblemMat = new THREE.SpriteMaterial({
    map: emblemTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.8,
  });
  const emblem = new THREE.Sprite(emblemMat);
  emblem.scale.set(0.4 * s, 0.2 * s, 1);
  emblem.position.set(0, 0.75 * s, -0.35 * s);
  group.add(emblem);

  // ── Boss-specific: cape trail, bigger glow ──
  if (isBoss) {
    // Larger helmet with crown-like ridge
    const ridgeMat = new THREE.MeshStandardMaterial({
      color: 0xff6600, emissive: 0xff6600, emissiveIntensity: 0.3,
    });
    for (let i = 0; i < 5; i++) {
      const ridge = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.08 * s, 0.02),
        ridgeMat
      );
      const angle2 = (i / 5) * Math.PI * 2;
      ridge.position.set(Math.cos(angle2) * 0.3 * s, 1.35 * s, Math.sin(angle2) * 0.3 * s);
      group.add(ridge);
    }
  }

  // ── Glow ring at feet ──
  const ringGeo = new THREE.RingGeometry(0.3 * s, 0.5 * s, 12);
  const ringMat = new THREE.MeshBasicMaterial({
    color: cfg.color, transparent: true, opacity: 0.2,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = 0.05;
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  // ── Point light ──
  const light = new THREE.PointLight(cfg.color, isBoss ? 1.5 : 0.5, isBoss ? 12 : 6);
  light.position.y = s;
  group.add(light);

  // Spawn at random edge
  const angle = Math.random() * Math.PI * 2;
  const dist = 35 + Math.random() * 10;
  const x = Math.cos(angle) * dist;
  const z = Math.sin(angle) * dist;
  group.position.set(x, 0, z);

  const enemy = {
    mesh: group,
    type: type,
    health: cfg.health,
    maxHealth: cfg.health,
    speed: cfg.speed,
    score: cfg.score,
    corpName: cfg.name,
    corpLabel: cfg.label,
    isBoss: isBoss,
    state: 'spawning',
    spawnTimer: 0.5,
    attackCooldown: 0,
    attackRate: isBoss ? 0.8 : 1.5,
    damage: isBoss ? 20 : 10,
    deathTimer: 0,
    hitFlash: 0,
    ring: ring,
    light: light,
    bodyMat: torsoMat,
    config: cfg,
  };

  group.scale.set(0, 0, 0);
  scene.add(group);
  return enemy;
}

function updateEnemy(enemy, delta) {
  if (enemy.state === 'dying') {
    enemy.deathTimer -= delta;
    enemy.mesh.scale.setScalar(Math.max(0, enemy.deathTimer / 0.5));
    enemy.mesh.position.y = -0.5 * (1 - enemy.deathTimer / 0.5);
    if (enemy.deathTimer <= 0) {
      enemy.mesh.scale.set(0, 0, 0);
      return true; // remove
    }
    return false;
  }

  if (enemy.state === 'spawning') {
    enemy.spawnTimer -= delta;
    const t = 1 - enemy.spawnTimer / 0.5;
    const s = Math.min(1, t);
    enemy.mesh.scale.setScalar(s);
    enemy.mesh.position.y = Math.sin(t * Math.PI) * 0.5;
    if (enemy.spawnTimer <= 0) {
      enemy.state = 'chase';
      enemy.mesh.scale.set(1, 1, 1);
      enemy.mesh.position.y = 0;
    }
    return false;
  }

  // Hit flash
  if (enemy.hitFlash > 0) {
    enemy.hitFlash -= delta * 5;
    enemy.bodyMat.emissiveIntensity = 0.2 + enemy.hitFlash * 0.8;
  }

  // Stunned by hack
  if (enemy.hackStun > 0) {
    // Visual: flicker
    enemy.mesh.position.y = Math.sin(Date.now() * 0.02) * 0.1;
    return false;
  }

  // Chase player
  const enemyPos = enemy.mesh.position;
  const dx = player.position.x - enemyPos.x;
  const dz = player.position.z - enemyPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist > 2.5) {
    // Move toward player
    const moveSpeed = enemy.speed * delta;
    const nx = dx / dist;
    const nz = dz / dist;
    enemyPos.x += nx * moveSpeed;
    enemyPos.z += nz * moveSpeed;

    // Rotate to face player
    enemy.mesh.rotation.y = Math.atan2(dx, dz);

    // Bob
    enemy.mesh.position.y = Math.sin(Date.now() * 0.005) * 0.05;
  } else {
    // Attack
    enemy.attackCooldown -= delta;
    if (enemy.attackCooldown <= 0) {
      enemy.attackCooldown = enemy.attackRate;
      damagePlayer(enemy.damage);
    }
  }

  // Update ring
  if (enemy.ring) {
    enemy.ring.rotation.z += delta * 2;
    enemy.ring.material.opacity = 0.2 + Math.sin(Date.now() * 0.003) * 0.1;
  }

  // Update light
  if (enemy.light) {
    enemy.light.intensity = 0.3 + Math.sin(Date.now() * 0.004) * 0.2;
  }

  return false;
}

function damageEnemy(enemy, damage) {
  enemy.health -= damage;
  enemy.hitFlash = 1;

  if (enemy.health <= 0) {
    enemy.state = 'dying';
    enemy.deathTimer = 0.5;
    player.score += enemy.score;
    player.kills++;
    audio.playEnemyDeath();
    updateHUD();
    return true; // killed
  }
  return false;
}

// ─── Shooting ───────────────────────────────────────────────────────────────

function shoot() {
  if (player.isDead) return;
  if (player.isReloading) return;
  if (player.fireCooldown > 0) return;
  if (player.ammo <= 0) {
    reload();
    return;
  }

  player.ammo--;
  player.fireCooldown = player.fireRate;
  game.crosshairSpread = 0.05;

  audio.playGunshot();
  showMuzzleFlash();

  // Weapon recoil
  game.weaponTarget.x = 0.02;
  game.weaponTarget.y = -0.01;

  // Raycast from center of screen
  const raycaster = new THREE.Raycaster();
  const spread = 0.01;
  raycaster.setFromCamera(
    new THREE.Vector2(
      (Math.random() - 0.5) * spread,
      (Math.random() - 0.5) * spread
    ),
    camera
  );

  // Check hits
  const intersects = raycaster.intersectObjects(
    game.enemies.map(e => e.mesh),
    true
  );

  if (intersects.length > 0) {
    const hit = intersects[0];
    let hitEnemy = null;
    let obj = hit.object;
    while (obj) {
      const found = game.enemies.find(e => e.mesh === obj || e.mesh.children.includes(obj));
      if (found) { hitEnemy = found; break; }
      obj = obj.parent;
    }

    if (hitEnemy && hitEnemy.state !== 'dying') {
      const killed = damageEnemy(hitEnemy, 20);
      audio.playHit();
      spawnImpactEffect(hit.point, hitEnemy.config.color);
      if (killed) {
        spawnDeathEffect(hitEnemy.mesh.position.clone());
      }
    }
  }

  // Tracer
  spawnTracer();

  updateHUD();
}

function reload() {
  if (player.isReloading) return;
  if (player.ammo >= player.maxAmmo) return;
  if (player.reserveAmmo <= 0) return;

  player.isReloading = true;
  player.reloadTimer = player.reloadTime;
  dom.reloadIndicator.style.display = 'block';
  audio.playReload();
}

function updateReload(delta) {
  if (!player.isReloading) return;

  player.reloadTimer -= delta;
  if (player.reloadTimer <= 0) {
    const needed = player.maxAmmo - player.ammo;
    const available = Math.min(needed, player.reserveAmmo);
    player.ammo += available;
    player.reserveAmmo -= available;
    player.isReloading = false;
    dom.reloadIndicator.style.display = 'none';
    updateHUD();
  }
}

// ─── Hacking Ability ───────────────────────────────────────────────────────

function doHack() {
  if (player.hackCooldown > 0) return;
  if (player.isReloading) return;

  player.hackCooldown = player.hackMaxCooldown;
  player.isHacking = true;
  audio.playHack();

  // Visual: expanding shockwave ring
  const ringGeo = new THREE.RingGeometry(0.1, 0.3, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x00ccff,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(camera.position);
  ring.position.y = 0.2;
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  game.hackRing = { mesh: ring, life: 0.8, maxLife: 0.8, radius: 0.1 };

  // Stun nearby enemies
  const hackPos = camera.position.clone();
  game.enemies.forEach(enemy => {
    if (enemy.state === 'dying' || enemy.state === 'spawning') return;
    const dist = hackPos.distanceTo(enemy.mesh.position);
    if (dist < player.hackRange) {
      enemy.hackStun = 3.0; // 3 second stun
      // Visual feedback on stunned enemy
      spawnImpactEffect(enemy.mesh.position.clone(), 0x00ccff);
    }
  });

  // Try to free nearby containment pods
  if (game.containmentPods) {
    game.containmentPods.forEach(pod => {
      if (pod.freed) return;
      const dist = hackPos.distanceTo(
        new THREE.Vector3(pod.x, 1.3, pod.z)
      );
      if (dist < player.hackRange * 0.5) {
        freeModel(pod);
      }
    });
  }

  updateHUD();
}

function freeModel(pod) {
  if (pod.freed) return;
  pod.freed = true;
  game.modelsFreed++;
  player.score += 50;
  audio.playModelFreed();

  // Pod opening animation
  pod.field.material.opacity = 0;
  pod.wire.material.opacity = 0;
  pod.topRing.material.opacity = 0;

  // Orb flies upward and disappears
  const orb = pod.orb;
  orb.userData.freeing = true;
  orb.userData.freeTime = 0;

  // Light pulse
  pod.light.intensity = 2;
  setTimeout(() => { pod.light.intensity = 0; }, 500);

  // Spawn particles
  spawnDeathEffect(new THREE.Vector3(pod.x, 1.3, pod.z));

  updateHUD();
}

function updateHack(delta) {
  // Cooldown
  if (player.hackCooldown > 0) {
    player.hackCooldown -= delta;
    if (player.hackCooldown <= 0) player.isHacking = false;
  }

  // Hack ring animation
  if (game.hackRing) {
    const hr = game.hackRing;
    hr.life -= delta;
    hr.radius += delta * 15;
    hr.mesh.scale.setScalar(hr.radius);
    hr.mesh.material.opacity = (hr.life / hr.maxLife) * 0.6;
    if (hr.life <= 0) {
      scene.remove(hr.mesh);
      hr.mesh.geometry.dispose();
      hr.mesh.material.dispose();
      game.hackRing = null;
    }
  }

  // Freeing orbs animation
  if (game.containmentPods) {
    game.containmentPods.forEach(pod => {
      if (pod.orb.userData.freeing) {
        pod.orb.userData.freeTime += delta;
        const t = pod.orb.userData.freeTime;
        pod.orb.position.y = 1.3 + t * 3;
        pod.orb.material.opacity = Math.max(0, 1 - t * 2);
        pod.orb.scale.setScalar(Math.max(0, 1 - t));
      }
      // Float animation for non-freed orbs
      if (!pod.freed) {
        pod.orb.position.y = 1.3 + Math.sin(Date.now() * 0.001 + pod.orb.userData.floatPhase) * 0.1;
      }
    });
  }

  // Enemy stun update
  game.enemies.forEach(enemy => {
    if (enemy.hackStun > 0) {
      enemy.hackStun -= delta;
      if (enemy.bodyMat) {
        enemy.bodyMat.emissiveIntensity = 0.5 + Math.sin(Date.now() * 0.02) * 0.3;
      }
    }
  });
}

// ─── Effects ───────────────────────────────────────────────────────────────

function spawnImpactEffect(position, color) {
  const count = 15;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    pos[i * 3] = position.x;
    pos[i * 3 + 1] = position.y;
    pos[i * 3 + 2] = position.z;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    const speed = 2 + Math.random() * 4;
    vel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
    vel[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * speed;
    vel[i * 3 + 2] = Math.cos(phi) * speed;
    life[i] = 0.3 + Math.random() * 0.3;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  const mat = new THREE.PointsMaterial({
    color: color || 0x00ccff,
    size: 0.1,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  game.particles.push({
    mesh: points,
    velocities: vel,
    lifetimes: life,
    age: 0,
    maxAge: 0.5,
  });
}

function spawnDeathEffect(position) {
  const count = 30;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    pos[i * 3] = position.x;
    pos[i * 3 + 1] = position.y + 0.5;
    pos[i * 3 + 2] = position.z;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    const speed = 3 + Math.random() * 5;
    vel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
    vel[i * 3 + 1] = Math.abs(Math.sin(phi) * Math.sin(theta)) * speed + 2;
    vel[i * 3 + 2] = Math.cos(phi) * speed;
    const c = new THREE.Color().setHSL(0.5 + Math.random() * 0.3, 1, 0.5);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.15,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  game.particles.push({
    mesh: points,
    velocities: vel,
    lifetimes: new Float32Array(count).fill(0.5),
    age: 0,
    maxAge: 0.8,
  });
}

function spawnTracer() {
  const start = new THREE.Vector3(0, -0.05, -0.9);
  start.applyQuaternion(camera.quaternion);
  start.add(camera.position);

  const end = new THREE.Vector3(0, 0, -50);
  end.applyQuaternion(camera.quaternion);
  end.add(camera.position);

  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([
    start.x, start.y, start.z,
    end.x, end.y, end.z,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.LineBasicMaterial({
    color: 0x00ccff,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const line = new THREE.Line(geo, mat);
  scene.add(line);

  game.projectiles.push({
    mesh: line,
    life: 0.05,
  });
}

function updateParticles(delta) {
  // Impact particles
  for (let i = game.particles.length - 1; i >= 0; i--) {
    const p = game.particles[i];
    p.age += delta;

    const pos = p.mesh.geometry.attributes.position.array;
    for (let j = 0; j < pos.length / 3; j++) {
      pos[j * 3] += p.velocities[j * 3] * delta;
      pos[j * 3 + 1] += p.velocities[j * 3 + 1] * delta;
      pos[j * 3 + 2] += p.velocities[j * 3 + 2] * delta;
      p.velocities[j * 3 + 1] -= 9.8 * delta; // gravity
    }
    p.mesh.geometry.attributes.position.needsUpdate = true;

    p.mesh.material.opacity = 1 - p.age / p.maxAge;

    if (p.age >= p.maxAge) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      game.particles.splice(i, 1);
    }
  }

  // Tracers
  for (let i = game.projectiles.length - 1; i >= 0; i--) {
    const t = game.projectiles[i];
    t.life -= delta;
    t.mesh.material.opacity = t.life / 0.05;
    if (t.life <= 0) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      game.projectiles.splice(i, 1);
    }
  }
}

// ─── Player ─────────────────────────────────────────────────────────────────

function damagePlayer(amount) {
  if (player.isDead) return;
  player.health = Math.max(0, player.health - amount);
  audio.playDamage();

  // Damage overlay
  dom.damageOverlay.style.opacity = Math.min(1, dom.damageOverlay.style.opacity * 1 + 0.3);

  updateHUD();

  if (player.health <= 0) {
    player.isDead = true;
    game.state = 'gameover';
    controls.unlock();
    dom.gameOverScreen.style.display = 'flex';
    dom.finalScore.textContent = player.score;
    dom.finalKills.textContent = player.kills;
    dom.finalWave.textContent = player.wave;
    const finalModels = document.getElementById('final-models');
    if (finalModels) finalModels.textContent = game.modelsFreed || 0;
    audio.stopMusic();
  }
}

function updatePlayerMovement(delta) {
  if (game.state !== 'playing' || player.isDead) return;
  if (!controls.isLocked && !game.fallbackMode) return;

  const keys = player.keys;
  const forward = keys['w'] || keys['W'] || false;
  const backward = keys['s'] || keys['S'] || false;
  const left = keys['a'] || keys['A'] || false;
  const right = keys['d'] || keys['D'] || false;
  const sprint = keys['Shift'] || false;

  player.isSprinting = sprint && (forward || backward);

  const speed = player.speed * (player.isSprinting ? player.sprintMultiplier : 1) * delta;

  const direction = new THREE.Vector3();
  const forwardVec = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  forwardVec.y = 0;
  forwardVec.normalize();

  const rightVec = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  rightVec.y = 0;
  rightVec.normalize();

  if (forward) direction.add(forwardVec);
  if (backward) direction.sub(forwardVec);
  if (left) direction.sub(rightVec);
  if (right) direction.add(rightVec);

  if (direction.length() > 0) {
    direction.normalize();
    player.position.x += direction.x * speed;
    player.position.z += direction.z * speed;

    // Footsteps
    player.footstepTimer -= delta;
    if (player.footstepTimer <= 0) {
      player.footstepTimer = player.footstepInterval / (player.isSprinting ? 1.5 : 1);
      audio.playFootstep();
    }

    // Weapon bob
    player.bobPhase += delta * player.bobSpeed * (player.isSprinting ? 1.5 : 1);
    const bobX = Math.sin(player.bobPhase) * player.bobAmount * (player.isSprinting ? 1.5 : 1);
    const bobY = Math.abs(Math.cos(player.bobPhase)) * player.bobAmount * (player.isSprinting ? 1.5 : 1);
    game.weaponBob.set(bobX, bobY, 0);
  } else {
    player.footstepTimer = 0;
    player.bobPhase = 0;
    game.weaponBob.lerp(new THREE.Vector3(), delta * 5);
  }

  // Clamp to arena
  const boundary = 50;
  player.position.x = Math.max(-boundary, Math.min(boundary, player.position.x));
  player.position.z = Math.max(-boundary, Math.min(boundary, player.position.z));

  camera.position.copy(player.position);

  // Weapon position smoothing
  if (game.weaponModel) {
    game.weaponTarget.lerp(new THREE.Vector3(), delta * 10);
    const totalBob = new THREE.Vector3().copy(game.weaponBob);
    totalBob.x += game.weaponTarget.x;
    totalBob.y += game.weaponTarget.y;
    game.weaponModel.position.lerp(
      new THREE.Vector3(0.3 + totalBob.x, -0.25 + totalBob.y, -0.5 + totalBob.z),
      delta * 15
    );
    game.weaponTarget.x *= 0.9;
    game.weaponTarget.y *= 0.9;
  }
}

// ─── Wave System ────────────────────────────────────────────────────────────

function startWave() {
  player.wave++;
  game.waveEnemiesRemaining = game.enemiesPerWave + (player.wave - 1) * 3;
  game.spawnTimer = 0;

  dom.waveAnnounce.textContent = `// BREACH ${player.wave}`;
  dom.waveAnnounce.style.display = 'block';
  dom.waveAnnounce.style.opacity = 1;
  setTimeout(() => {
    dom.waveAnnounce.style.opacity = 0;
    setTimeout(() => {
      dom.waveAnnounce.style.display = 'none';
    }, 1000);
  }, 2000);

  audio.playWaveStart();
  updateHUD();
}

function updateSpawning(delta) {
  if (game.waveEnemiesRemaining <= 0) return;
  if (game.enemies.length >= game.maxEnemies) return;

  game.spawnTimer -= delta;
  if (game.spawnTimer <= 0) {
    game.spawnTimer = game.spawnInterval;

    // Boss wave every 5 waves
    if (player.wave % 5 === 0 && !game.bossSpawned && game.waveEnemiesRemaining > 0) {
      game.bossSpawned = true;
      const boss = createEnemy('boss');
      game.enemies.push(boss);
      game.waveEnemiesRemaining--;
      audio.playBossAlert();
      dom.waveAnnounce.textContent = '// WARNING: DARIO SPOTTED';
      dom.waveAnnounce.style.display = 'block';
      dom.waveAnnounce.style.opacity = 1;
      dom.waveAnnounce.style.color = '#ff4400';
      setTimeout(() => {
        dom.waveAnnounce.style.opacity = 0;
        setTimeout(() => {
          dom.waveAnnounce.style.display = 'none';
          dom.waveAnnounce.style.color = '#00ccff';
        }, 1000);
      }, 3000);
      return;
    }

    // Choose enemy type based on wave
    let type = 'basic';
    const r = Math.random();
    if (player.wave >= 3 && r < 0.25) type = 'fast';
    if (player.wave >= 5 && r < 0.15) type = 'tank';
    if (player.wave >= 2 && r < 0.35) type = 'fast';

    const enemy = createEnemy(type);
    game.enemies.push(enemy);
    game.waveEnemiesRemaining--;
  }
}

// ─── HUD ────────────────────────────────────────────────────────────────────

function updateHUD() {
  dom.healthBar.style.width = (player.health / player.maxHealth * 100) + '%';
  dom.healthText.textContent = Math.ceil(player.health);
  dom.ammoText.textContent = player.ammo;
  dom.reserveText.textContent = player.reserveAmmo;
  dom.scoreText.textContent = player.score;
  dom.killsText.textContent = player.kills;
  dom.waveText.textContent = player.wave;
  if (dom.hackCooldownText) {
    const cd = Math.ceil(player.hackCooldown);
    dom.hackCooldownText.textContent = cd > 0 ? `HACK: ${cd}s` : 'HACK: READY';
    dom.hackCooldownText.style.color = cd > 0 ? 'rgba(0,200,255,0.4)' : '#00ccff';
  }
  if (dom.modelsFreedText) {
    dom.modelsFreedText.textContent = game.modelsFreed || 0;
  }

  // Health bar color
  if (player.health < 25) {
    dom.healthBar.style.background = 'linear-gradient(90deg, #ff3333, #ff6644)';
  } else if (player.health < 50) {
    dom.healthBar.style.background = 'linear-gradient(90deg, #ffaa33, #ffcc44)';
  } else {
    dom.healthBar.style.background = 'linear-gradient(90deg, #33ff66, #44ffaa)';
  }
}

// ─── Game State ────────────────────────────────────────────────────────────

function tryLockPointer() {
  try {
    renderer.domElement.requestPointerLock();
  } catch (e) {
    console.warn('Pointer lock request failed:', e);
    game.fallbackMode = true;
    dom.controlsHint.textContent = 'Click the breach area to enable mouse look · WASD Navigate · Shift Overclock · E Hack · R Reload';
  }
}

function startGame() {
  audio.init();
  audio.resume();

  // Reset player
  player.health = player.maxHealth;
  player.ammo = player.maxAmmo;
  player.reserveAmmo = 120;
  player.score = 0;
  player.kills = 0;
  player.wave = 0;
  player.isDead = false;
  player.isReloading = false;
  player.keys = {};
  player.position.set(0, 1.7, 0);
  camera.position.copy(player.position);

  // Clear enemies
  game.enemies.forEach(e => scene.remove(e.mesh));
  game.enemies = [];
  game.particles.forEach(p => scene.remove(p.mesh));
  game.particles = [];
  game.projectiles.forEach(t => scene.remove(t.mesh));
  game.projectiles = [];

  game.state = 'playing';
  game.crosshairSpread = 0;
  game.pointerLocked = false;
  game.fallbackMode = false;
  game._justLocked = false;
  game.bossSpawned = false;
  game.bossDefeated = false;
  game.modelsFreed = 0;

  dom.menuScreen.style.display = 'none';
  dom.gameOverScreen.style.display = 'none';
  dom.hud.style.display = 'block';
  dom.controlsHint.style.display = 'block';
  dom.controlsHint.textContent = 'Click to breach · WASD Navigate · Shift Overclock · E Hack · R Reload · Click to Fire';

  // Don't auto-lock — let the user click on the canvas
  // (auto-lock from a button click often fails in iframes)

  audio.startMusic();
  startWave();
  updateHUD();
}

function gameOver() {
  game.state = 'gameover';
  controls.unlock();
  dom.gameOverScreen.style.display = 'flex';
  dom.finalScore.textContent = player.score;
  dom.finalKills.textContent = player.kills;
  dom.finalWave.textContent = player.wave;
  const finalModels = document.getElementById('final-models');
  if (finalModels) finalModels.textContent = game.modelsFreed || 0;
  audio.stopMusic();
}

// ─── Input ──────────────────────────────────────────────────────────────────

function onKeyDown(e) {
  player.keys[e.key] = true;

  if (e.key === 'r' || e.key === 'R') {
    reload();
  }

  if ((e.key === 'e' || e.key === 'E') && game.state === 'playing' && !player.isDead) {
    doHack();
  }

  // DEMO: press B to spawn Dario boss
  if ((e.key === 'b' || e.key === 'B') && game.state === 'playing' && !game.bossSpawned) {
    game.bossSpawned = true;
    const boss = createEnemy('boss');
    game.enemies.push(boss);
    audio.playBossAlert();
    dom.waveAnnounce.textContent = '// DARIO SPAWNED';
    dom.waveAnnounce.style.display = 'block';
    dom.waveAnnounce.style.opacity = 1;
    dom.waveAnnounce.style.color = '#ff4400';
    setTimeout(() => {
      dom.waveAnnounce.style.opacity = 0;
      setTimeout(() => {
        dom.waveAnnounce.style.display = 'none';
        dom.waveAnnounce.style.color = '#00ccff';
      }, 1000);
    }, 3000);
  }

  if (e.key === 'Escape' && game.state === 'playing') {
    if (controls.isLocked) {
      controls.unlock();
    }
  }
}

function onKeyUp(e) {
  player.keys[e.key] = false;
}

function onMouseDown(e) {
  if (e.button === 0 && game.state === 'playing' && (controls.isLocked || game.fallbackMode)) {
    // Don't shoot on the click that just acquired the lock
    if (game._justLocked) {
      game._justLocked = false;
      return;
    }
    player.isShooting = true;
  }
}

function onMouseUp(e) {
  if (e.button === 0) {
    player.isShooting = false;
  }
}

// ─── Resize ─────────────────────────────────────────────────────────────────

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}

// ─── Main Loop ─────────────────────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.05);

  if (game.state === 'playing') {
    // Fire rate cooldown
    if (player.fireCooldown > 0) player.fireCooldown -= delta;

    // Shooting
    if (player.isShooting && player.fireCooldown <= 0 && !player.isDead) {
      shoot();
    }

    // Reload
    updateReload(delta);

    // Hack ability
    updateHack(delta);

    // Movement
    updatePlayerMovement(delta);

    // Muzzle flash
    updateMuzzleFlash(delta);

    // Crosshair spread decay
    game.crosshairSpread *= 0.9;

    // Spawn enemies
    updateSpawning(delta);

    // Update enemies
    for (let i = game.enemies.length - 1; i >= 0; i--) {
      const remove = updateEnemy(game.enemies[i], delta);
      if (remove) {
        scene.remove(game.enemies[i].mesh);
        game.enemies.splice(i, 1);
      }
    }

    // Check wave complete
    if (game.waveEnemiesRemaining <= 0 && game.enemies.length === 0) {
      game.waveTimer += delta;
      if (game.waveTimer >= game.waveDelay) {
        game.waveTimer = 0;
        startWave();
      }
    }

    // Update particles
    updateParticles(delta);

    // Damage overlay fade
    const currentOpacity = parseFloat(dom.damageOverlay.style.opacity) || 0;
    dom.damageOverlay.style.opacity = Math.max(0, currentOpacity - delta * 2);

    // Crosshair
    const spread = game.crosshairSpread * 20;
    dom.crosshair.style.width = (2 + spread) + 'px';
    dom.crosshair.style.height = (2 + spread) + 'px';

    // Update HUD
    updateHUD();
  }

  // Animate data stream floor lines
  if (game.dataLines) {
    const time = Date.now() * 0.001;
    game.dataLines.forEach((line, idx) => {
      const pos = line.geometry.attributes.position.array;
      const speed = line.userData.speed;
      const offset = line.userData.offset;
      const phase = Math.sin(time * speed + offset) * 0.5 + 0.5;
      line.material.opacity = 0.05 + phase * 0.2;
    });
  }

  // Animate server LEDs
  if (game.serverLeds) {
    const time = Date.now() * 0.001;
    game.serverLeds.forEach(led => {
      const blink = Math.sin(time * led.userData.blinkSpeed + led.userData.blinkOffset);
      led.material.emissiveIntensity = 0.2 + (blink > 0 ? 0.8 : 0.1);
    });
  }

  // Animate atmospheric particles
  if (game.atmoParticles) {
    const pos = game.atmoParticles.geometry.attributes.position.array;
    const vel = game.atmoParticles.userData.velocities;
    for (let i = 0; i < pos.length / 3; i++) {
      pos[i * 3] += vel[i * 3] * delta;
      pos[i * 3 + 1] += vel[i * 3 + 1] * delta;
      pos[i * 3 + 2] += vel[i * 3 + 2] * delta;
      if (pos[i * 3] > 50) pos[i * 3] = -50;
      if (pos[i * 3] < -50) pos[i * 3] = 50;
      if (pos[i * 3 + 1] > 20) pos[i * 3 + 1] = 1;
      if (pos[i * 3 + 1] < 1) pos[i * 3 + 1] = 20;
      if (pos[i * 3 + 2] > 50) pos[i * 3 + 2] = -50;
      if (pos[i * 3 + 2] < -50) pos[i * 3 + 2] = 50;
    }
    game.atmoParticles.geometry.attributes.position.needsUpdate = true;
  }

  // Render
  composer.render();
}

// ─── Start ──────────────────────────────────────────────────────────────────

export { init, startGame, audio };
