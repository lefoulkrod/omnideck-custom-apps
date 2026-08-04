/**
 * sprites.js — Dungeons & Dragoons
 * ---------------------------------------------------------------------------
 * Procedural pixel-art sprite factory. Every sprite is generated at runtime by
 * drawing to offscreen <canvas> elements with Canvas2D. There are no image
 * files, no network access and no external dependencies.
 *
 * Public API:
 *   Sprites.ready              Promise<void> resolved when init() finished
 *   Sprites.init()             async, idempotent, generates everything
 *   Sprites.get(name, frame)   HTMLCanvasElement (frame wraps modulo count)
 *   Sprites.frameCount(name)   integer
 *   Sprites.names()            string[]
 *
 * Importing this module does nothing but define functions — it is safe under
 * Node.js with no DOM. Only init() touches `document`.
 */

/* =========================================================================
 * 1. Palette
 * ========================================================================= */

const PAL = {
  outline: '#0a0710',
  shadow: 'rgba(0,0,0,0.35)',

  // --- player: hooded ranger / spellblade -------------------------------
  cloak: '#1f5a5c',
  cloakLit: '#2f7f82',
  cloakHi: '#48a5a6',
  cloakDark: '#12383a',
  cloakDeep: '#0b2426',
  scarf: '#c0392b',
  scarfLit: '#e6604a',
  scarfDark: '#7d1f16',
  skin: '#e0b088',
  skinDark: '#b0805a',
  leather: '#5a3a24',
  leatherLit: '#7d5233',
  leatherDark: '#33200f',
  steel: '#9aa7b4',
  steelLit: '#d6dee6',
  steelDark: '#5a6672',

  // --- magic ------------------------------------------------------------
  magic: '#7fe8ff',
  magicCore: '#ffffff',
  magicDim: '#2b8fc4',
  magicGlow: 'rgba(127,232,255,0.30)',

  // --- goblin -----------------------------------------------------------
  gob: '#5aa02c',
  gobLit: '#83cc45',
  gobDark: '#33631a',
  gobBelly: '#a8c86a',
  cloth: '#8a6a3a',
  clothDark: '#5b4322',

  // --- bone / skeleton --------------------------------------------------
  bone: '#e6e1cd',
  boneLit: '#fffdf0',
  boneDark: '#a49f88',
  boneDeep: '#6d6a58',
  rag: '#4a4256',
  ragDark: '#2b2635',
  wood: '#8a5a2c',
  woodDark: '#573517',

  // --- bat --------------------------------------------------------------
  bat: '#3d2456',
  batLit: '#633d8a',
  batWing: '#22143a',
  eyeRed: '#ff3b30',
  eyeRedLit: '#ffd2ce',

  // --- slime ------------------------------------------------------------
  slime: 'rgba(126,224,58,0.85)',
  slimeLit: 'rgba(198,255,122,0.95)',
  slimeDark: 'rgba(60,120,24,0.9)',
  slimeSolid: '#7ee03a',

  // --- imp --------------------------------------------------------------
  imp: '#d33a2a',
  impLit: '#ff7050',
  impDark: '#7d1a10',
  horn: '#f0dfc0',

  // --- dragons ----------------------------------------------------------
  dgn: '#3f8c3a',
  dgnLit: '#68c257',
  dgnHi: '#9ae87f',
  dgnDark: '#235020',
  dgnBelly: '#cbdc7a',
  drd: '#b52a1e',
  drdLit: '#e6553a',
  drdHi: '#ff8a63',
  drdDark: '#631410',
  molten: '#ffb03a',
  moltenHot: '#fff2a8',
  moltenDeep: '#e05a10',

  // --- lich -------------------------------------------------------------
  lich: '#6b3fa0',
  lichLit: '#9d68dc',
  lichDark: '#3a1f60',
  lichDeep: '#22103a',
  lichGlow: '#d9a6ff',
  gold: '#f4c542',
  goldLit: '#ffeaa0',
  goldDark: '#96721a',

  // --- tiles ------------------------------------------------------------
  stone: '#4a4b58',
  stoneLit: '#63647a',
  stoneHi: '#7e809b',
  stoneDark: '#33343e',
  mortar: '#22232b',
  moss: '#3f6b34',
  mossLit: '#5c9445',
  dirt: '#6b4f33',
  dirtLit: '#8a6a45',
  dirtDark: '#432f1c',
  basalt: '#2e2a30',
  basaltLit: '#454049',
  iron: '#565d68',
  ironLit: '#7b8492',
  ironDark: '#343a43',

  // --- backgrounds ------------------------------------------------------
  cryptSky: '#1a1030',
  cryptSky2: '#2a1a48',
  cryptWall: '#241a3d',
  cryptWall2: '#2f2350',
  cryptDark: '#150c26',
  torch: '#ff9a2a',
  torchHot: '#ffe9a0',
  forgeSky: '#2a0f0c',
  forgeGlow: '#ff5a1a',
  forgeRock: '#241a18',
  nightSky: '#0b1030',
  nightSky2: '#1b2450',
  moon: '#f4f2d8',
  mountain: '#141a34',
  mountain2: '#0c1024',
};

/* =========================================================================
 * 2. Low level helpers
 * ========================================================================= */

function hasDOM() {
  return typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';
}

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function ctx2d(cv) {
  const ctx = cv.getContext('2d');
  if (ctx && 'imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Single pixel-rect. All drawing funnels through here so output stays crisp. */
function px(ctx, x, y, w, h, color) {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(x | 0, y | 0, Math.max(1, w | 0), Math.max(1, h | 0));
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFor(name) {
  return mulberry32(strHash(name));
}

/** Stable 2D hash in [0,1) — periodic in integer inputs, so tiles wrap. */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ ((seed | 0) * 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Chunky line between two points (used for limbs, chains, bones). */
function limb(ctx, x1, y1, x2, y2, th, color) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const n = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
  const o = (th - 1) >> 1;
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x1 + (dx * i) / n);
    const y = Math.round(y1 + (dy * i) / n);
    px(ctx, x - o, y - o, th, th, color);
  }
}

/** Pixel-filled ellipse. */
function ell(ctx, cx, cy, rx, ry, color) {
  if (rx <= 0 || ry <= 0) return;
  for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) {
    const k = 1 - (y * y) / (ry * ry);
    if (k < 0) continue;
    const w = Math.floor(rx * Math.sqrt(k));
    px(ctx, Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1, color);
  }
}

/** Scanline-filled polygon, rendered as 1px-tall rects → stays pixel crisp. */
function poly(ctx, pts, color) {
  if (!pts || pts.length < 3) return;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  y0 = Math.floor(y0);
  y1 = Math.ceil(y1);
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.round(xs[i]);
      const xb = Math.round(xs[i + 1]);
      px(ctx, xa, y, Math.max(1, xb - xa), 1, color);
    }
  }
}

/** Soft radial glow built from concentric translucent ellipses. */
function glow(ctx, cx, cy, r, rgb, steps = 4, maxAlpha = 0.5) {
  for (let i = steps; i >= 1; i--) {
    const f = i / steps;
    const a = (maxAlpha * (1 - f) + maxAlpha * 0.25) / steps * 2;
    ell(ctx, cx, cy, r * f, r * f, `rgba(${rgb},${a.toFixed(3)})`);
  }
}

/** Star / sparkle cross. */
function spark(ctx, cx, cy, r, color, core) {
  px(ctx, cx - r, cy, r * 2 + 1, 1, color);
  px(ctx, cx, cy - r, 1, r * 2 + 1, color);
  if (r > 1) {
    px(ctx, cx - 1, cy - 1, 3, 3, core || color);
  } else {
    px(ctx, cx, cy, 1, 1, core || color);
  }
}

/**
 * Adds a 1px dark outline around the opaque silhouette. Implemented by
 * reading pixels and stamping single-pixel rects — no putImageData needed, so
 * it degrades to a harmless no-op under a stub 2D context.
 */
function outline(cv, color) {
  let img = null;
  const ctx = cv.getContext('2d');
  try {
    if (typeof ctx.getImageData !== 'function') return;
    img = ctx.getImageData(0, 0, cv.width, cv.height);
  } catch (e) {
    return;
  }
  if (!img || !img.data || typeof img.data.length !== 'number' || img.data.length < 4) return;
  const w = cv.width | 0;
  const h = cv.height | 0;
  if (img.data.length < w * h * 4) return;
  const d = img.data;
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3]);
  const hits = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (A(x, y) >= 40) continue;
      if (A(x - 1, y) >= 128 || A(x + 1, y) >= 128 || A(x, y - 1) >= 128 || A(x, y + 1) >= 128) {
        hits.push(x, y);
      }
    }
  }
  ctx.fillStyle = color || PAL.outline;
  for (let i = 0; i < hits.length; i += 2) ctx.fillRect(hits[i], hits[i + 1], 1, 1);
}

/* =========================================================================
 * 3. Registry
 * ========================================================================= */

const REG = new Map();
const warned = new Set();
let placeholder = null;
let initialised = false;
let initPromise = null;
let resolveReady;
let rejectReady;

const ready = new Promise((res, rej) => {
  resolveReady = res;
  rejectReady = rej;
});
// Never let an unobserved rejection kill the page.
ready.catch(() => {});

/**
 * define(name, w, h, count, draw, opts)
 *   draw(ctx, frame, t, w, h, rng)   t = frame / count  (normalised phase)
 *   opts.outline  → stamp a dark 1px silhouette outline afterwards
 *   opts.after    → callback run after the outline pass (glows etc.)
 */
function define(name, w, h, count, draw, opts) {
  const o = opts || {};
  const frames = [];
  for (let f = 0; f < count; f++) {
    const cv = makeCanvas(w, h);
    const ctx = ctx2d(cv);
    const t = count > 1 ? f / count : 0;
    const rng = rngFor(name);
    if (ctx) {
      ctx.save();
      draw(ctx, f, t, w, h, rng);
      ctx.restore();
      if (o.outline) outline(cv, o.outlineColor || PAL.outline);
      if (o.after) {
        ctx.save();
        o.after(ctx, f, t, w, h, rng);
        ctx.restore();
      }
    }
    frames.push(cv);
  }
  REG.set(name, { w, h, frames });
}

/* =========================================================================
 * 4. Player — hooded ranger / spellblade, 32x40, facing RIGHT
 * ========================================================================= */

const PW = 32;
const PH = 40;

/**
 * Flowing cloak behind the body. `sway` shifts the trailing edge.
 */
function drawCloak(ctx, ox, oy, sway, flare) {
  const s = sway;
  const f = flare || 0;
  // main cape mass, hangs down-back (screen left since we face right)
  poly(
    ctx,
    [
      [ox + 15, oy + 14],
      [ox + 18, oy + 16],
      [ox + 17, oy + 29],
      [ox + 13 - f, oy + 33 + s],
      [ox + 7 - f, oy + 31 + s * 2],
      [ox + 5 - f * 1.5, oy + 25 + s],
      [ox + 7, oy + 18],
      [ox + 10, oy + 13],
    ],
    PAL.cloakDark
  );
  // lit inner fold
  poly(
    ctx,
    [
      [ox + 14, oy + 16],
      [ox + 16, oy + 18],
      [ox + 15, oy + 28],
      [ox + 11 - f, oy + 30 + s],
      [ox + 10, oy + 22],
    ],
    PAL.cloak
  );
  // deep shadow along trailing hem
  poly(
    ctx,
    [
      [ox + 8 - f, oy + 28 + s],
      [ox + 13 - f, oy + 32 + s],
      [ox + 8 - f, oy + 31 + s * 2],
      [ox + 5 - f * 1.5, oy + 26 + s],
    ],
    PAL.cloakDeep
  );
}

/** Hooded head. `tilt` nudges the hood point. */
function drawHood(ctx, ox, oy, tilt) {
  const t = tilt || 0;
  // hood outer shell
  poly(
    ctx,
    [
      [ox + 12, oy + 16],
      [ox + 11, oy + 9],
      [ox + 14 + t, oy + 4],
      [ox + 19, oy + 5],
      [ox + 22, oy + 10],
      [ox + 22, oy + 14],
      [ox + 19, oy + 17],
      [ox + 13, oy + 17],
    ],
    PAL.cloak
  );
  // lit upper-left (light source upper-left)
  poly(
    ctx,
    [
      [ox + 12, oy + 14],
      [ox + 11, oy + 9],
      [ox + 14 + t, oy + 4],
      [ox + 18, oy + 5],
      [ox + 15, oy + 9],
      [ox + 14, oy + 14],
    ],
    PAL.cloakLit
  );
  px(ctx, ox + 12, oy + 6, 2, 3, PAL.cloakHi);
  // hood cavity + glint of an eye
  px(ctx, ox + 15, oy + 10, 7, 5, PAL.cloakDeep);
  px(ctx, ox + 16, oy + 11, 5, 3, '#141b22');
  px(ctx, ox + 19, oy + 12, 2, 2, PAL.magic);
  px(ctx, ox + 19, oy + 12, 1, 1, PAL.magicCore);
  // hood brim shadow
  px(ctx, ox + 15, oy + 9, 8, 1, PAL.cloakDeep);
}

/** Red scarf across the chest with two trailing tails. */
function drawScarf(ctx, ox, oy, sway) {
  const s = sway || 0;
  px(ctx, ox + 12, oy + 16, 9, 3, PAL.scarf);
  px(ctx, ox + 13, oy + 16, 7, 1, PAL.scarfLit);
  px(ctx, ox + 12, oy + 18, 9, 1, PAL.scarfDark);
  // tails streaming back
  poly(
    ctx,
    [
      [ox + 13, oy + 18],
      [ox + 10, oy + 19],
      [ox + 5 - s, oy + 20 + s],
      [ox + 4 - s, oy + 23 + s],
      [ox + 9, oy + 22],
      [ox + 13, oy + 21],
    ],
    PAL.scarf
  );
  poly(
    ctx,
    [
      [ox + 12, oy + 19],
      [ox + 7, oy + 21],
      [ox + 5 - s, oy + 24 + s],
      [ox + 9, oy + 24],
    ],
    PAL.scarfDark
  );
  px(ctx, ox + 6 - s, oy + 20 + s, 3, 1, PAL.scarfLit);
}

/** Torso: leather jerkin over teal tunic. */
function drawTorso(ctx, ox, oy, h) {
  const hh = h == null ? 11 : h;
  px(ctx, ox + 12, oy + 18, 9, hh, PAL.cloak);
  px(ctx, ox + 12, oy + 18, 3, hh, PAL.cloakLit);
  px(ctx, ox + 19, oy + 19, 2, hh - 1, PAL.cloakDark);
  // jerkin straps
  px(ctx, ox + 13, oy + 21, 7, 2, PAL.leather);
  px(ctx, ox + 13, oy + 21, 7, 1, PAL.leatherLit);
  // belt
  px(ctx, ox + 12, oy + 18 + hh - 2, 9, 2, PAL.leatherDark);
  px(ctx, ox + 15, oy + 18 + hh - 2, 3, 2, PAL.gold);
}

/**
 * Forward gauntleted arm channelling magic.
 * angle in degrees: 0 = straight forward, -90 = straight up, +45 = down-forward
 */
function drawMagicArm(ctx, ox, oy, angle, charge) {
  const sx = ox + 19;
  const sy = oy + 21;
  const a = (angle * Math.PI) / 180;
  const len = 9;
  const ex = Math.round(sx + Math.cos(a) * len);
  const ey = Math.round(sy + Math.sin(a) * len);
  const mx = Math.round(sx + Math.cos(a) * (len * 0.5));
  const my = Math.round(sy + Math.sin(a) * (len * 0.5));
  // shoulder pauldron
  px(ctx, ox + 18, oy + 19, 4, 4, PAL.steelDark);
  px(ctx, ox + 18, oy + 19, 4, 2, PAL.steel);
  px(ctx, ox + 18, oy + 19, 2, 1, PAL.steelLit);
  // upper + fore arm
  limb(ctx, sx, sy, mx, my, 3, PAL.cloakDark);
  limb(ctx, mx, my, ex, ey, 3, PAL.leather);
  limb(ctx, mx, my, ex, ey, 1, PAL.leatherLit);
  // gauntlet fist
  px(ctx, ex - 1, ey - 1, 4, 4, PAL.steelDark);
  px(ctx, ex - 1, ey - 1, 4, 2, PAL.steel);
  px(ctx, ex, ey - 1, 1, 1, PAL.steelLit);
  // channelled magic
  const c = charge == null ? 1 : charge;
  if (c > 0) {
    const gx = Math.round(ex + Math.cos(a) * 3.5);
    const gy = Math.round(ey + Math.sin(a) * 3.5);
    glow(ctx, gx, gy, 2 + c * 2.2, '127,232,255', 3, 0.55);
    ell(ctx, gx, gy, 1 + c, 1 + c, PAL.magic);
    px(ctx, gx, gy, 1, 1, PAL.magicCore);
  }
}

/** Rear arm (mostly hidden by cloak). */
function drawBackArm(ctx, ox, oy, swing) {
  const sx = ox + 13;
  const sy = oy + 21;
  const ex = Math.round(sx - 1 + swing * 3);
  const ey = Math.round(sy + 7 - Math.abs(swing) * 1.5);
  limb(ctx, sx, sy, ex, ey, 3, PAL.cloakDeep);
  px(ctx, ex - 1, ey, 3, 3, PAL.leatherDark);
}

/** One leg, hip → knee → boot. */
function drawLeg(ctx, hx, hy, kx, ky, fx, fy, dark) {
  limb(ctx, hx, hy, kx, ky, 4, dark ? PAL.cloakDeep : PAL.cloakDark);
  limb(ctx, kx, ky, fx, fy, 3, dark ? PAL.leatherDark : PAL.leather);
  // boot
  px(ctx, fx - 1, fy - 1, 5, 3, dark ? PAL.leatherDark : PAL.leather);
  px(ctx, fx - 1, fy - 1, 5, 1, dark ? PAL.leather : PAL.leatherLit);
}

/** Standing legs, `spread` splays the stance. */
function drawStandLegs(ctx, ox, oy, spread) {
  const s = spread || 0;
  drawLeg(ctx, ox + 14, oy + 29, ox + 13 - s, oy + 33, ox + 12 - s, oy + 37, true);
  drawLeg(ctx, ox + 18, oy + 29, ox + 19 + s, oy + 33, ox + 19 + s, oy + 37, false);
}

/** Run cycle legs driven by phase p in [0,1). */
function drawRunLegs(ctx, ox, oy, p) {
  const a = p * Math.PI * 2;
  const b = a + Math.PI;
  const hipx = ox + 16;
  const hipy = oy + 28;
  const legOf = (ph, dark) => {
    const swing = Math.sin(ph);
    const lift = Math.max(0, Math.cos(ph));
    const kx = Math.round(hipx + swing * 4);
    const ky = Math.round(hipy + 4 - lift * 2);
    const fx = Math.round(hipx + swing * 6 + (swing > 0 ? 1 : -1));
    const fy = Math.round(hipy + 9 - lift * 4);
    drawLeg(ctx, hipx, hipy, kx, ky, fx, fy, dark);
  };
  legOf(b, true);
  legOf(a, false);
}

function playerBase(ctx, o) {
  const ox = 0;
  const oy = o.bob | 0;
  // ground shadow keeps the figure planted
  if (!o.airborne) ell(ctx, 16, 38, 8, 2, PAL.shadow);
  drawCloak(ctx, ox, oy, o.sway || 0, o.flare || 0);
  if (o.legs) o.legs(ctx, ox, oy);
  drawBackArm(ctx, ox, oy, o.backSwing || 0);
  drawTorso(ctx, ox, oy, o.torsoH);
  drawScarf(ctx, ox, oy, o.scarf || 0);
  drawHood(ctx, ox, oy, o.tilt || 0);
  drawMagicArm(ctx, ox, oy, o.arm == null ? -4 : o.arm, o.charge);
}

function registerPlayer() {
  const OL = { outline: true };

  define('player_idle', PW, PH, 4, (ctx, f, t) => {
    const breathe = [0, 1, 1, 0][f];
    playerBase(ctx, {
      bob: breathe,
      sway: [0, 1, 2, 1][f],
      scarf: [0, 1, 2, 1][f],
      tilt: [0, 0, 1, 0][f],
      charge: 0.6 + 0.4 * Math.sin(t * Math.PI * 2),
      legs: (c, ox, oy) => drawStandLegs(c, ox, oy, 1),
    });
  }, OL);

  define('player_run', PW, PH, 6, (ctx, f) => {
    const p = f / 6;
    const bob = [0, -1, 0, 0, -1, 0][f];
    playerBase(ctx, {
      bob,
      sway: 2 + Math.round(Math.sin(p * Math.PI * 2) * 1.5),
      flare: 2,
      scarf: 2,
      backSwing: -Math.sin(p * Math.PI * 2),
      tilt: 1,
      arm: -6,
      charge: 0.7,
      legs: (c, ox, oy) => drawRunLegs(c, ox, oy, p),
    });
  }, OL);

  define('player_jump', PW, PH, 2, (ctx, f) => {
    const rising = f === 0;
    playerBase(ctx, {
      bob: rising ? -1 : 0,
      airborne: true,
      sway: rising ? 4 : 1,
      flare: 3,
      scarf: 3,
      tilt: rising ? 2 : -1,
      arm: rising ? -18 : 10,
      charge: 0.9,
      legs: (c, ox, oy) => {
        if (rising) {
          drawLeg(c, ox + 14, oy + 28, ox + 12, oy + 31, ox + 11, oy + 34, true);
          drawLeg(c, ox + 18, oy + 28, ox + 21, oy + 30, ox + 22, oy + 33, false);
        } else {
          drawLeg(c, ox + 14, oy + 28, ox + 12, oy + 33, ox + 11, oy + 37, true);
          drawLeg(c, ox + 18, oy + 28, ox + 21, oy + 33, ox + 22, oy + 36, false);
        }
      },
    });
  }, OL);

  define('player_duck', PW, PH, 1, (ctx) => {
    const oy = 11;
    ell(ctx, 16, 38, 9, 2, PAL.shadow);
    drawCloak(ctx, 0, oy - 2, 3, 3);
    // crouched legs tucked under
    drawLeg(ctx, 14, oy + 26, 11, oy + 27, 11, oy + 26, true);
    drawLeg(ctx, 18, oy + 26, 22, oy + 27, 21, oy + 26, false);
    px(ctx, 9, 36, 14, 3, PAL.cloakDark);
    px(ctx, 9, 36, 14, 1, PAL.cloak);
    drawTorso(ctx, 0, oy, 9);
    drawScarf(ctx, 0, oy, 2);
    drawHood(ctx, 0, oy, 1);
    drawMagicArm(ctx, 0, oy, -2, 0.8);
  }, OL);

  define('player_hurt', PW, PH, 2, (ctx, f) => {
    // flashing silhouette: white on f0, red on f1
    const flash = f === 0 ? '#ffffff' : '#ff4a3a';
    const dark = f === 0 ? '#ffd6d6' : '#a01a10';
    const saved = { c: PAL.cloak, cl: PAL.cloakLit, cd: PAL.cloakDark, cp: PAL.cloakDeep, ch: PAL.cloakHi };
    PAL.cloak = flash; PAL.cloakLit = flash; PAL.cloakHi = flash;
    PAL.cloakDark = dark; PAL.cloakDeep = dark;
    const s2 = { s: PAL.scarf, sl: PAL.scarfLit, sd: PAL.scarfDark, l: PAL.leather, ll: PAL.leatherLit, ld: PAL.leatherDark, st: PAL.steel, stl: PAL.steelLit, std: PAL.steelDark, g: PAL.gold };
    PAL.scarf = flash; PAL.scarfLit = flash; PAL.scarfDark = dark;
    PAL.leather = dark; PAL.leatherLit = flash; PAL.leatherDark = dark;
    PAL.steel = flash; PAL.steelLit = flash; PAL.steelDark = dark; PAL.gold = flash;
    playerBase(ctx, {
      bob: 0,
      sway: 3,
      flare: 2,
      tilt: -2,
      arm: -30,
      charge: 0,
      legs: (c, ox, oy) => {
        drawLeg(c, ox + 14, oy + 29, ox + 11, oy + 33, ox + 10, oy + 37, true);
        drawLeg(c, ox + 18, oy + 29, ox + 21, oy + 33, ox + 22, oy + 37, false);
      },
    });
    PAL.cloak = saved.c; PAL.cloakLit = saved.cl; PAL.cloakDark = saved.cd;
    PAL.cloakDeep = saved.cp; PAL.cloakHi = saved.ch;
    PAL.scarf = s2.s; PAL.scarfLit = s2.sl; PAL.scarfDark = s2.sd;
    PAL.leather = s2.l; PAL.leatherLit = s2.ll; PAL.leatherDark = s2.ld;
    PAL.steel = s2.st; PAL.steelLit = s2.stl; PAL.steelDark = s2.std; PAL.gold = s2.g;
  }, OL);

  const aim = (name, angle) =>
    define(name, PW, PH, 1, (ctx) => {
      playerBase(ctx, {
        bob: 0,
        sway: 1,
        scarf: 1,
        arm: angle,
        charge: 1,
        tilt: angle < -60 ? -1 : 0,
        legs: (c, ox, oy) => drawStandLegs(c, ox, oy, 1),
      });
    }, OL);

  aim('player_aim_up', -90);
  aim('player_aim_diag_up', -45);
  aim('player_aim_diag_down', 45);

  define('player_die', PW, PH, 4, (ctx, f, t, w, h, rng) => {
    if (f === 0) {
      // knocked back, arms flung
      playerBase(ctx, {
        bob: -2,
        airborne: true,
        sway: 5,
        flare: 4,
        scarf: 4,
        tilt: -3,
        arm: -70,
        charge: 0,
        legs: (c, ox, oy) => {
          drawLeg(c, ox + 14, oy + 28, ox + 10, oy + 31, ox + 8, oy + 34, true);
          drawLeg(c, ox + 18, oy + 28, ox + 22, oy + 31, ox + 24, oy + 34, false);
        },
      });
    } else if (f === 1) {
      // buckling
      const oy = 8;
      drawCloak(ctx, 0, oy, 5, 5);
      px(ctx, 9, oy + 26, 15, 5, PAL.cloakDark);
      px(ctx, 9, oy + 26, 15, 2, PAL.cloak);
      drawTorso(ctx, 0, oy + 4, 8);
      drawScarf(ctx, 0, oy + 4, 4);
      drawHood(ctx, -2, oy + 8, -3);
      limb(ctx, 20, oy + 26, 26, oy + 30, 3, PAL.leather);
    } else if (f === 2) {
      // collapsed heap, dissolving
      px(ctx, 6, 30, 20, 8, PAL.cloakDark);
      px(ctx, 7, 30, 18, 3, PAL.cloak);
      px(ctx, 8, 34, 14, 4, PAL.cloakDeep);
      px(ctx, 10, 29, 7, 3, PAL.scarf);
      ell(ctx, 20, 33, 4, 3, PAL.cloakLit);
      for (let i = 0; i < 14; i++) {
        const x = 4 + Math.floor(rng() * 24);
        const y = 16 + Math.floor(rng() * 16);
        spark(ctx, x, y, 1, PAL.magic, PAL.magicCore);
      }
    } else {
      // just motes
      for (let i = 0; i < 22; i++) {
        const x = 3 + Math.floor(rng() * 26);
        const y = 6 + Math.floor(rng() * 30);
        const r = rng() > 0.6 ? 2 : 1;
        spark(ctx, x, y, r, rng() > 0.5 ? PAL.magic : PAL.magicDim, PAL.magicCore);
      }
      px(ctx, 10, 36, 12, 2, 'rgba(31,90,92,0.5)');
    }
  }, { outline: false });
}

/* =========================================================================
 * 5. Enemies
 * ========================================================================= */

/** Shared: a pair of running legs for small humanoids. */
function critterLegs(ctx, hipx, hipy, p, len, thigh, shin) {
  const legOf = (ph, dark) => {
    const swing = Math.sin(ph);
    const lift = Math.max(0, Math.cos(ph));
    const kx = Math.round(hipx + swing * (len * 0.45));
    const ky = Math.round(hipy + len * 0.5 - lift * 1.5);
    const fx = Math.round(hipx + swing * (len * 0.75));
    const fy = Math.round(hipy + len - lift * (len * 0.4));
    limb(ctx, hipx, hipy, kx, ky, 3, dark ? shin : thigh);
    limb(ctx, kx, ky, fx, fy, 2, dark ? shin : thigh);
    px(ctx, fx - 1, fy, 4, 2, dark ? shin : thigh);
  };
  legOf(p * Math.PI * 2 + Math.PI, true);
  legOf(p * Math.PI * 2, false);
}

/* ---- Goblin: 28x32 ---- */
function goblinBody(ctx, oy, p, opts) {
  const o = opts || {};
  const hunch = o.hunch == null ? 1 : o.hunch;
  ell(ctx, 14, 30, 7, 2, PAL.shadow);
  critterLegs(ctx, 13, 22 + oy, p, 9, PAL.gob, PAL.gobDark);
  // loincloth
  px(ctx, 9, 20 + oy, 9, 5, PAL.cloth);
  px(ctx, 9, 20 + oy, 9, 1, PAL.clothDark);
  px(ctx, 12, 24 + oy, 4, 3, PAL.clothDark);
  // hunched torso, leaning forward-right
  poly(ctx, [[8, 21 + oy], [10, 12 + oy - hunch], [17, 11 + oy - hunch], [19, 16 + oy], [18, 21 + oy]], PAL.gob);
  poly(ctx, [[9, 20 + oy], [11, 13 + oy - hunch], [14, 12 + oy - hunch], [13, 20 + oy]], PAL.gobLit);
  px(ctx, 16, 15 + oy, 3, 6, PAL.gobDark);
  px(ctx, 13, 17 + oy, 4, 4, PAL.gobBelly);
  // head thrust forward, big nose + ears
  ell(ctx, 18, 10 + oy - hunch, 5, 4, PAL.gob);
  ell(ctx, 17, 9 + oy - hunch, 4, 3, PAL.gobLit);
  px(ctx, 21, 10 + oy - hunch, 3, 2, PAL.gobDark); // snout
  px(ctx, 22, 10 + oy - hunch, 2, 1, PAL.gob);
  // ears
  poly(ctx, [[14, 8 + oy - hunch], [10, 5 + oy - hunch], [13, 10 + oy - hunch]], PAL.gobDark);
  poly(ctx, [[20, 7 + oy - hunch], [24, 4 + oy - hunch], [22, 9 + oy - hunch]], PAL.gob);
  // eye + teeth
  px(ctx, 19, 9 + oy - hunch, 2, 2, '#ffe14a');
  px(ctx, 20, 9 + oy - hunch, 1, 1, '#3a1a00');
  px(ctx, 20, 12 + oy - hunch, 1, 1, PAL.boneLit);
  px(ctx, 22, 12 + oy - hunch, 1, 1, PAL.boneLit);
  // rear arm
  const sw = Math.sin(p * Math.PI * 2 + Math.PI);
  limb(ctx, 11, 15 + oy, Math.round(8 - sw * 2), Math.round(20 + oy + sw), 3, PAL.gobDark);
  // front arm holding a crude dagger
  const sw2 = Math.sin(p * Math.PI * 2);
  const hx = Math.round(18 + sw2 * 2);
  const hy = Math.round(19 + oy - sw2);
  limb(ctx, 17, 15 + oy, hx, hy, 3, PAL.gob);
  px(ctx, hx - 1, hy - 1, 3, 3, PAL.clothDark);
  // dagger: iron blade angled forward
  limb(ctx, hx + 1, hy, hx + 6, hy - 4, 2, PAL.steel);
  limb(ctx, hx + 2, hy - 1, hx + 5, hy - 4, 1, PAL.steelLit);
  px(ctx, hx + 6, hy - 5, 2, 2, PAL.steelLit);
}

/* ---- Skeleton: 28x36 ---- */
function skeletonBody(ctx, oy, opts) {
  const o = opts || {};
  ell(ctx, 14, 34, 7, 2, PAL.shadow);
  // legs — two bone struts
  limb(ctx, 11, 24 + oy, 10, 29 + oy, 2, PAL.bone);
  limb(ctx, 10, 29 + oy, 9, 33 + oy, 2, PAL.boneDark);
  px(ctx, 7, 33 + oy, 5, 2, PAL.bone);
  limb(ctx, 16, 24 + oy, 18, 29 + oy, 2, PAL.bone);
  limb(ctx, 18, 29 + oy, 19, 33 + oy, 2, PAL.boneDark);
  px(ctx, 17, 33 + oy, 5, 2, PAL.bone);
  // pelvis
  px(ctx, 10, 22 + oy, 8, 3, PAL.boneDark);
  px(ctx, 10, 22 + oy, 8, 1, PAL.bone);
  // ribcage / spine
  px(ctx, 13, 13 + oy, 2, 10, PAL.boneDark);
  for (let i = 0; i < 4; i++) {
    const y = 14 + oy + i * 2;
    const wdt = 9 - i;
    px(ctx, 14 - (wdt >> 1) + 1, y, wdt, 1, PAL.bone);
  }
  px(ctx, 10, 13 + oy, 9, 2, PAL.boneLit); // collar
  // tattered hood + cape over the shoulders
  poly(ctx, [[8, 14 + oy], [9, 7 + oy], [13, 3 + oy], [19, 4 + oy], [21, 9 + oy], [21, 15 + oy], [17, 16 + oy], [11, 16 + oy]], PAL.rag);
  poly(ctx, [[9, 13 + oy], [10, 7 + oy], [13, 3 + oy], [16, 4 + oy], [13, 9 + oy], [12, 14 + oy]], '#5d5470');
  // ragged hem teeth
  const hem = o.hem || 0;
  for (let i = 0; i < 5; i++) {
    px(ctx, 8 + i * 3, 15 + oy + ((i + hem) % 2), 2, 3, PAL.ragDark);
  }
  // skull inside the hood
  ell(ctx, 17, 10 + oy, 5, 4, PAL.bone);
  ell(ctx, 16, 9 + oy, 4, 3, PAL.boneLit);
  px(ctx, 19, 11 + oy, 3, 3, PAL.boneDark); // jaw/muzzle
  px(ctx, 18, 9 + oy, 2, 2, PAL.outline); // eye socket
  px(ctx, 18, 10 + oy, 2, 1, o.eye || '#ff7a2a');
  px(ctx, 15, 9 + oy, 2, 2, PAL.outline);
  for (let i = 0; i < 3; i++) px(ctx, 19 + i, 13 + oy, 1, 1, PAL.boneLit); // teeth
  px(ctx, 13, 8 + oy, 8, 1, PAL.ragDark); // hood brim
}

/** Bow drawn by the skeleton archer. `pull` 0..1 = string draw amount. */
function skeletonBow(ctx, oy, pull, released) {
  const bx = 22;
  const by = 18 + oy;
  // bow limb arc
  const pts = [];
  for (let i = -7; i <= 7; i++) {
    const yy = by + i;
    const xx = Math.round(bx + Math.cos((i / 7) * (Math.PI / 2)) * 3);
    px(ctx, xx, yy, 2, 1, PAL.wood);
    px(ctx, xx, yy, 1, 1, i < 0 ? '#a97038' : PAL.woodDark);
    pts.push([xx, yy]);
  }
  // string
  const sx = Math.round(bx + 1 - pull * 7);
  limb(ctx, bx + 1, by - 7, sx, by, 1, '#ded4b4');
  limb(ctx, sx, by, bx + 1, by + 7, 1, '#ded4b4');
  // arms: front hand grips bow, back hand pulls string
  limb(ctx, 17, 16 + oy, bx, by, 2, PAL.bone);
  limb(ctx, 12, 16 + oy, sx, by, 2, PAL.bone);
  px(ctx, sx - 1, by - 1, 3, 3, PAL.boneDark);
  if (!released) {
    // nocked arrow
    px(ctx, sx, by, 10, 1, PAL.wood);
    poly(ctx, [[sx + 10, by - 2], [sx + 14, by], [sx + 10, by + 2]], PAL.steelLit);
    px(ctx, sx, by - 1, 2, 3, '#e8e0c0'); // fletching
  } else {
    px(ctx, bx + 4, by, 8, 1, 'rgba(230,225,205,0.6)');
    px(ctx, bx + 6, by - 1, 6, 1, 'rgba(255,255,255,0.35)');
  }
}

function registerEnemies() {
  const OL = { outline: true };

  define('goblin_run', 28, 32, 6, (ctx, f) => {
    const p = f / 6;
    const bob = [0, -1, 0, 0, -1, 0][f];
    goblinBody(ctx, bob, p, { hunch: 1 + (f % 2) });
  }, OL);

  define('goblin_die', 28, 32, 3, (ctx, f, t, w, h, rng) => {
    if (f === 0) {
      // flung backwards
      ell(ctx, 14, 30, 7, 2, PAL.shadow);
      poly(ctx, [[6, 22], [9, 12], [17, 11], [20, 17], [18, 23]], PAL.gob);
      ell(ctx, 19, 9, 5, 4, PAL.gob);
      px(ctx, 20, 8, 3, 1, PAL.outline);
      px(ctx, 15, 8, 3, 1, PAL.outline); // X eyes
      px(ctx, 20, 10, 3, 1, PAL.outline);
      px(ctx, 15, 10, 3, 1, PAL.outline);
      limb(ctx, 10, 14, 3, 9, 3, PAL.gobDark);
      limb(ctx, 17, 15, 24, 10, 3, PAL.gob);
      limb(ctx, 12, 22, 6, 28, 3, PAL.gobDark);
      limb(ctx, 16, 22, 22, 27, 3, PAL.gob);
      px(ctx, 10, 19, 9, 4, PAL.cloth);
    } else if (f === 1) {
      // splat on the floor
      ell(ctx, 14, 27, 10, 4, PAL.gobDark);
      ell(ctx, 13, 26, 8, 3, PAL.gob);
      ell(ctx, 21, 26, 4, 3, PAL.gobLit);
      px(ctx, 22, 25, 2, 1, PAL.outline);
      px(ctx, 8, 25, 8, 3, PAL.cloth);
      for (let i = 0; i < 8; i++) {
        px(ctx, 2 + Math.floor(rng() * 24), 18 + Math.floor(rng() * 8), 2, 2, PAL.gobDark);
      }
    } else {
      // dust puff
      for (let i = 0; i < 12; i++) {
        const x = 2 + Math.floor(rng() * 24);
        const y = 18 + Math.floor(rng() * 11);
        const r = 1 + Math.floor(rng() * 2);
        ell(ctx, x, y, r, r, 'rgba(120,150,90,0.45)');
      }
      px(ctx, 6, 29, 16, 2, 'rgba(90,160,44,0.35)');
    }
  }, { outline: false });

  define('skeleton_idle', 28, 36, 2, (ctx, f) => {
    skeletonBody(ctx, f, { hem: f, eye: f ? '#ffa347' : '#ff7a2a' });
    // idle arms hanging with a bow held loosely
    limb(ctx, 12, 16 + f, 9, 22 + f, 2, PAL.bone);
    limb(ctx, 17, 16 + f, 21, 22 + f, 2, PAL.bone);
    px(ctx, 21, 14 + f, 2, 12, PAL.wood);
    px(ctx, 21, 14 + f, 1, 12, PAL.woodDark);
  }, OL);

  define('skeleton_shoot', 28, 36, 3, (ctx, f) => {
    skeletonBody(ctx, 0, { hem: f, eye: f === 2 ? '#fff0a0' : '#ff7a2a' });
    skeletonBow(ctx, 0, f === 0 ? 0.25 : f === 1 ? 0.85 : 0.0, f === 2);
    if (f === 2) glow(ctx, 24, 18, 4, '255,200,120', 3, 0.35);
  }, OL);

  define('skeleton_die', 28, 36, 4, (ctx, f, t, w, h, rng) => {
    const s = f / 3; // 0 → intact-ish, 1 → scattered
    if (f === 0) {
      skeletonBody(ctx, 1, { hem: 1, eye: '#fff0a0' });
      limb(ctx, 12, 16, 6, 12, 2, PAL.bone);
      limb(ctx, 17, 16, 24, 12, 2, PAL.bone);
      return;
    }
    // scatter bones outward, deterministic per index
    const bones = 11;
    for (let i = 0; i < bones; i++) {
      const a = (i / bones) * Math.PI * 2 + 0.4;
      const d = 2 + s * 9 + rng() * 3;
      const cx = Math.round(14 + Math.cos(a) * d);
      const cy = Math.round(20 + Math.sin(a) * d * 0.7 + s * 6);
      const ln = 3 + Math.floor(rng() * 3);
      const horiz = rng() > 0.5;
      const col = i % 3 === 0 ? PAL.boneDark : PAL.bone;
      if (horiz) {
        px(ctx, cx, cy, ln, 2, col);
        px(ctx, cx, cy, 1, 2, PAL.boneLit);
      } else {
        px(ctx, cx, cy, 2, ln, col);
        px(ctx, cx, cy, 2, 1, PAL.boneLit);
      }
    }
    // skull rolling away, plus rag scraps
    const skx = Math.round(16 + s * 5);
    const sky = Math.round(24 + s * 7);
    if (f < 3) {
      ell(ctx, skx, sky, 4, 3, PAL.bone);
      px(ctx, skx - 2, sky - 1, 2, 2, PAL.outline);
      px(ctx, skx + 1, sky - 1, 2, 2, PAL.outline);
      px(ctx, skx - 1, sky + 2, 4, 1, PAL.boneDark);
    } else {
      ell(ctx, skx, 31, 4, 2, PAL.boneDark);
    }
    for (let i = 0; i < 4; i++) {
      px(ctx, 3 + Math.floor(rng() * 22), 12 + Math.floor(rng() * 18), 3 + Math.floor(rng() * 3), 2, PAL.rag);
    }
  }, { outline: false });

  /* ---- Bat: 24x20 ---- */
  define('bat_fly', 24, 20, 4, (ctx, f) => {
    // wing phase: 0 up, 1 mid, 2 down, 3 mid
    const wing = [-5, 0, 4, 0][f];
    const body = [0, 1, 2, 1][f];
    const wingPair = (dir) => {
      const bx = 12 + dir * 3;
      poly(
        ctx,
        [
          [bx, 9 + body],
          [bx + dir * 5, 6 + body + wing],
          [bx + dir * 10, 4 + body + wing * 1.4],
          [bx + dir * 11, 9 + body + wing],
          [bx + dir * 7, 10 + body + wing * 0.5],
          [bx + dir * 4, 12 + body],
        ],
        PAL.batWing
      );
      poly(
        ctx,
        [
          [bx, 9 + body],
          [bx + dir * 5, 7 + body + wing * 0.8],
          [bx + dir * 8, 7 + body + wing],
          [bx + dir * 4, 11 + body],
        ],
        PAL.bat
      );
      // wing bones
      limb(ctx, bx, 9 + body, bx + dir * 10, 4 + body + Math.round(wing * 1.4), 1, PAL.batLit);
      limb(ctx, bx + dir * 5, 6 + body + wing, bx + dir * 7, 10 + body + Math.round(wing * 0.5), 1, PAL.batLit);
    };
    wingPair(-1);
    wingPair(1);
    // body
    ell(ctx, 12, 10 + body, 3, 4, PAL.bat);
    ell(ctx, 11, 9 + body, 2, 3, PAL.batLit);
    px(ctx, 11, 13 + body, 3, 2, PAL.batWing);
    // ears
    poly(ctx, [[10, 7 + body], [9, 3 + body], [12, 6 + body]], PAL.bat);
    poly(ctx, [[14, 7 + body], [16, 3 + body], [16, 7 + body]], PAL.bat);
    // face
    px(ctx, 13, 9 + body, 2, 2, PAL.eyeRed);
    px(ctx, 13, 9 + body, 1, 1, PAL.eyeRedLit);
    px(ctx, 10, 9 + body, 2, 2, PAL.eyeRed);
    px(ctx, 15, 11 + body, 1, 1, PAL.boneLit); // fang
    px(ctx, 13, 12 + body, 1, 1, PAL.boneLit);
  }, { outline: true });

  define('bat_die', 24, 20, 3, (ctx, f, t, w, h, rng) => {
    if (f === 0) {
      // wings crumple upward
      poly(ctx, [[12, 10], [6, 4], [3, 8], [9, 12]], PAL.batWing);
      poly(ctx, [[12, 10], [18, 4], [21, 8], [15, 12]], PAL.batWing);
      ell(ctx, 12, 11, 3, 4, PAL.bat);
      px(ctx, 10, 9, 2, 1, PAL.outline);
      px(ctx, 13, 9, 2, 1, PAL.outline);
      px(ctx, 11, 13, 3, 1, PAL.batWing);
    } else if (f === 1) {
      // tumbling wad
      ell(ctx, 12, 13, 5, 3, PAL.batWing);
      ell(ctx, 11, 12, 3, 2, PAL.bat);
      px(ctx, 5, 12, 4, 2, PAL.batWing);
      px(ctx, 16, 13, 4, 2, PAL.batWing);
      for (let i = 0; i < 5; i++) px(ctx, 3 + Math.floor(rng() * 18), 4 + Math.floor(rng() * 10), 2, 2, PAL.batLit);
    } else {
      for (let i = 0; i < 10; i++) {
        const x = 2 + Math.floor(rng() * 20);
        const y = 3 + Math.floor(rng() * 14);
        ell(ctx, x, y, 1 + Math.floor(rng() * 2), 1, 'rgba(99,61,138,0.5)');
      }
      px(ctx, 9, 16, 2, 2, PAL.eyeRed);
    }
  }, { outline: false });

  /* ---- Slime: 26x22 ---- */
  define('slime_hop', 26, 22, 4, (ctx, f) => {
    // 0 squash (compressed), 1 launch (stretched), 2 airborne (round), 3 land
    const shape = [
      { rx: 11, ry: 5, cy: 17 },
      { rx: 7, ry: 9, cy: 12 },
      { rx: 9, ry: 8, cy: 10 },
      { rx: 10, ry: 6, cy: 15 },
    ][f];
    const cx = 13;
    ell(ctx, cx, 20, shape.rx * 0.8, 2, PAL.shadow);
    // body: dark rim, mid, bright highlight
    ell(ctx, cx, shape.cy, shape.rx, shape.ry, PAL.slimeDark);
    ell(ctx, cx, shape.cy, shape.rx - 1, shape.ry - 1, PAL.slime);
    ell(ctx, cx - 3, shape.cy - Math.max(1, shape.ry - 3), Math.max(2, shape.rx - 6), Math.max(1, shape.ry - 3), PAL.slimeLit);
    // flat bottom when grounded
    if (f === 0 || f === 3) px(ctx, cx - shape.rx + 1, shape.cy + shape.ry - 1, shape.rx * 2 - 2, 2, PAL.slimeDark);
    // specular blob + inner bubbles
    px(ctx, cx - 5, shape.cy - shape.ry + 2, 3, 2, 'rgba(255,255,255,0.85)');
    px(ctx, cx + 2, shape.cy - 1, 2, 2, 'rgba(240,255,200,0.5)');
    px(ctx, cx - 1, shape.cy + 2, 2, 1, 'rgba(240,255,200,0.4)');
    // eyes
    const ey = shape.cy - 1;
    px(ctx, cx + 1, ey, 2, 2, PAL.outline);
    px(ctx, cx + 5, ey, 2, 2, PAL.outline);
    px(ctx, cx + 1, ey, 1, 1, '#ffffff');
    px(ctx, cx + 5, ey, 1, 1, '#ffffff');
    // drips
    if (f === 1 || f === 2) {
      px(ctx, cx - 2, shape.cy + shape.ry, 2, 3, PAL.slime);
      px(ctx, cx + 4, shape.cy + shape.ry, 1, 2, PAL.slime);
    }
  }, { outline: false });

  define('slime_die', 26, 22, 3, (ctx, f, t, w, h, rng) => {
    if (f === 0) {
      ell(ctx, 13, 16, 12, 5, PAL.slimeDark);
      ell(ctx, 13, 16, 11, 4, PAL.slime);
      px(ctx, 11, 14, 2, 2, PAL.outline);
      px(ctx, 16, 14, 2, 2, PAL.outline);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI;
        px(ctx, Math.round(13 + Math.cos(a) * 12), Math.round(13 - Math.sin(a) * 8), 2, 2, PAL.slime);
      }
    } else if (f === 1) {
      ell(ctx, 13, 19, 12, 3, PAL.slimeDark);
      ell(ctx, 13, 19, 10, 2, PAL.slime);
      for (let i = 0; i < 12; i++) {
        const x = 1 + Math.floor(rng() * 24);
        const y = 6 + Math.floor(rng() * 12);
        px(ctx, x, y, 1 + Math.floor(rng() * 2), 2, i % 3 ? PAL.slime : PAL.slimeLit);
      }
    } else {
      px(ctx, 3, 20, 20, 2, PAL.slimeDark);
      px(ctx, 5, 19, 15, 1, PAL.slime);
      for (let i = 0; i < 8; i++) px(ctx, 1 + Math.floor(rng() * 24), 15 + Math.floor(rng() * 6), 2, 1, 'rgba(126,224,58,0.45)');
    }
  }, { outline: false });

  /* ---- Imp: 26x26 ---- */
  define('imp_fly', 26, 26, 4, (ctx, f) => {
    const wing = [-4, 0, 3, 0][f];
    const body = [0, 1, 2, 1][f];
    const cy = 13 + body;
    // wings behind
    const wingPair = (dir) => {
      const bx = 13 + dir * 2;
      poly(
        ctx,
        [
          [bx, cy - 2],
          [bx + dir * 6, cy - 6 + wing],
          [bx + dir * 10, cy - 8 + wing * 1.3],
          [bx + dir * 10, cy - 1 + wing],
          [bx + dir * 5, cy + 2],
        ],
        PAL.impDark
      );
      limb(ctx, bx, cy - 2, bx + dir * 10, cy - 8 + Math.round(wing * 1.3), 1, PAL.impLit);
      limb(ctx, bx + dir * 6, cy - 6 + wing, bx + dir * 7, cy + 1, 1, PAL.impLit);
    };
    wingPair(-1);
    wingPair(1);
    // pot-bellied body
    ell(ctx, 13, cy + 2, 4, 5, PAL.imp);
    ell(ctx, 12, cy + 1, 3, 3, PAL.impLit);
    px(ctx, 11, cy + 5, 5, 2, PAL.impDark);
    // dangling legs
    limb(ctx, 11, cy + 6, 10, cy + 10, 2, PAL.imp);
    limb(ctx, 15, cy + 6, 17, cy + 10, 2, PAL.impDark);
    px(ctx, 9, cy + 10, 3, 2, PAL.impDark);
    px(ctx, 16, cy + 10, 3, 2, PAL.impDark);
    // barbed tail
    limb(ctx, 10, cy + 4, 5, cy + 7, 2, PAL.imp);
    poly(ctx, [[3, cy + 6], [6, cy + 7], [3, cy + 9]], PAL.impDark);
    // arms with tiny claws
    limb(ctx, 16, cy, 20, cy + 2, 2, PAL.imp);
    px(ctx, 20, cy + 1, 2, 2, PAL.impDark);
    limb(ctx, 10, cy, 7, cy + 2, 2, PAL.impDark);
    // head
    ell(ctx, 14, cy - 4, 5, 4, PAL.imp);
    ell(ctx, 13, cy - 5, 4, 3, PAL.impLit);
    // horns
    poly(ctx, [[11, cy - 7], [10, cy - 11], [13, cy - 7]], PAL.horn);
    poly(ctx, [[16, cy - 7], [18, cy - 11], [18, cy - 7]], PAL.horn);
    // pointy ears
    poly(ctx, [[9, cy - 4], [5, cy - 6], [10, cy - 2]], PAL.impDark);
    poly(ctx, [[18, cy - 4], [22, cy - 6], [18, cy - 2]], PAL.imp);
    // eyes + wide grin
    px(ctx, 12, cy - 5, 2, 2, '#ffe14a');
    px(ctx, 12, cy - 5, 1, 1, '#3a0a00');
    px(ctx, 16, cy - 5, 2, 2, '#ffe14a');
    px(ctx, 16, cy - 5, 1, 1, '#3a0a00');
    px(ctx, 11, cy - 2, 7, 1, PAL.outline);
    px(ctx, 12, cy - 1, 1, 1, PAL.boneLit);
    px(ctx, 14, cy - 1, 1, 1, PAL.boneLit);
    px(ctx, 16, cy - 1, 1, 1, PAL.boneLit);
  }, { outline: true });

  define('imp_die', 26, 26, 3, (ctx, f, t, w, h, rng) => {
    if (f === 0) {
      poly(ctx, [[13, 11], [5, 5], [3, 11], [11, 14]], PAL.impDark);
      poly(ctx, [[13, 11], [21, 5], [23, 11], [15, 14]], PAL.impDark);
      ell(ctx, 13, 14, 4, 5, PAL.imp);
      ell(ctx, 13, 8, 5, 4, PAL.imp);
      px(ctx, 10, 7, 2, 1, PAL.outline);
      px(ctx, 14, 7, 2, 1, PAL.outline);
      px(ctx, 10, 9, 2, 1, PAL.outline);
      px(ctx, 14, 9, 2, 1, PAL.outline);
      poly(ctx, [[10, 5], [9, 1], [12, 5]], PAL.horn);
      poly(ctx, [[16, 5], [18, 1], [18, 5]], PAL.horn);
      glow(ctx, 13, 13, 8, '255,90,40', 3, 0.3);
    } else if (f === 1) {
      glow(ctx, 13, 13, 11, '255,140,40', 4, 0.5);
      ell(ctx, 13, 13, 6, 5, '#ff9a3a');
      ell(ctx, 13, 13, 3, 3, PAL.moltenHot);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        px(ctx, Math.round(13 + Math.cos(a) * 9), Math.round(13 + Math.sin(a) * 8), 2, 2, PAL.imp);
      }
    } else {
      for (let i = 0; i < 12; i++) {
        const x = 2 + Math.floor(rng() * 22);
        const y = 2 + Math.floor(rng() * 20);
        ell(ctx, x, y, 1 + Math.floor(rng() * 2), 1, 'rgba(90,40,40,0.45)');
      }
      px(ctx, 11, 12, 2, 2, '#ff7050');
      px(ctx, 16, 16, 2, 2, PAL.horn);
    }
  }, { outline: false });
}

/* =========================================================================
 * 6. Bosses
 * ========================================================================= */

/* ---- Wyrmling: 96x80, small green dragon ---- */
function registerBosses() {
  const OL = { outline: true };

  function wyrmlingBody(ctx, f, mode) {
    const breathe = [0, 1, 2, 1][f];
    const by = breathe;
    // wings folded behind
    poly(ctx, [[20, 30 + by], [10, 18 + by], [6, 35 + by], [18, 42 + by]], PAL.dgnDark);
    poly(ctx, [[76, 30 + by], [86, 18 + by], [90, 35 + by], [78, 42 + by]], PAL.dgnDark);
    // wing membrane highlights
    poly(ctx, [[18, 32 + by], [12, 22 + by], [10, 33 + by]], PAL.dgn);
    poly(ctx, [[78, 32 + by], [84, 22 + by], [86, 33 + by]], PAL.dgn);
    // body
    ell(ctx, 48, 45 + by, 22, 16, PAL.dgnDark);
    ell(ctx, 48, 44 + by, 20, 14, PAL.dgn);
    ell(ctx, 44, 40 + by, 14, 10, PAL.dgnLit);
    // belly scales
    ell(ctx, 48, 50 + by, 16, 8, PAL.dgnBelly);
    for (let i = -3; i <= 3; i++) px(ctx, 48 + i * 4, 48 + by, 3, 1, PAL.dgnHi);
    // tail
    poly(ctx, [[30, 48 + by], [14, 56 + by], [8, 52 + by], [12, 48 + by], [28, 44 + by]], PAL.dgn);
    poly(ctx, [[8, 52 + by], [4, 50 + by], [6, 54 + by]], PAL.dgnDark);
    // legs
    limb(ctx, 38, 56 + by, 34, 66 + by, 5, PAL.dgnDark);
    limb(ctx, 34, 66 + by, 30, 68 + by, 4, PAL.dgn);
    px(ctx, 28, 66 + by, 6, 3, PAL.dgnDark);
    limb(ctx, 58, 56 + by, 62, 66 + by, 5, PAL.dgnDark);
    limb(ctx, 62, 66 + by, 66, 68 + by, 4, PAL.dgn);
    px(ctx, 64, 66 + by, 6, 3, PAL.dgnDark);
    // neck + head
    limb(ctx, 60, 36 + by, 72, 24 + by, 8, PAL.dgn);
    limb(ctx, 60, 34 + by, 72, 22 + by, 6, PAL.dgnLit);
    ell(ctx, 78, 20 + by, 12, 9, PAL.dgn);
    ell(ctx, 76, 18 + by, 10, 7, PAL.dgnLit);
    // snout
    poly(ctx, [[84, 18 + by], [94, 20 + by], [94, 24 + by], [84, 26 + by]], PAL.dgn);
    poly(ctx, [[84, 18 + by], [92, 19 + by], [92, 21 + by], [84, 22 + by]], PAL.dgnLit);
    // horns
    poly(ctx, [[72, 12 + by], [68, 2 + by], [76, 10 + by]], PAL.dgnDark);
    poly(ctx, [[82, 12 + by], [86, 2 + by], [84, 10 + by]], PAL.dgnDark);
    // eye
    px(ctx, 78, 18 + by, 4, 3, PAL.gold);
    px(ctx, 79, 18 + by, 2, 2, '#3a1a00');
    px(ctx, 79, 18 + by, 1, 1, PAL.goldLit);
    // teeth
    px(ctx, 88, 25 + by, 2, 2, PAL.boneLit);
    px(ctx, 91, 25 + by, 2, 2, PAL.boneLit);
    // back spikes
    for (let i = 0; i < 5; i++) {
      const sx = 30 + i * 7;
      poly(ctx, [[sx, 36 + by], [sx + 3, 28 + by], [sx + 6, 36 + by]], PAL.dgnDark);
    }
    if (mode === 'attack') {
      // fire breath
      glow(ctx, 94, 22 + by, 12, '255,140,40', 4, 0.5);
      ell(ctx, 94, 22 + by, 8, 5, PAL.molten);
      ell(ctx, 94, 22 + by, 5, 3, PAL.moltenHot);
    }
    if (mode === 'hurt') {
      // flash white
      ell(ctx, 48, 44 + by, 22, 16, 'rgba(255,255,255,0.4)');
    }
  }

  define('boss_wyrmling_idle', 96, 80, 4, (ctx, f) => wyrmlingBody(ctx, f, 'idle'), OL);
  define('boss_wyrmling_attack', 96, 80, 4, (ctx, f) => {
    const pullback = f < 2;
    const by = pullback ? -2 - f : [0, 0, 1, 0][f];
    wyrmlingBody(ctx, f, f >= 2 ? 'attack' : 'idle');
  }, OL);
  define('boss_wyrmling_hurt', 96, 80, 2, (ctx, f) => wyrmlingBody(ctx, f, 'hurt'), OL);

  /* ---- Lich: 80x96, floating skeletal mage ---- */
  function lichBody(ctx, f, mode) {
    const float = [0, -2, -1, -1][f];
    const fy = float;
    // robe / cloak
    poly(ctx, [[40, 40 + fy], [20, 70 + fy], [24, 90 + fy], [56, 90 + fy], [60, 70 + fy]], PAL.lichDark);
    poly(ctx, [[40, 42 + fy], [26, 68 + fy], [30, 88 + fy], [50, 88 + fy], [54, 68 + fy]], PAL.lich);
    poly(ctx, [[40, 44 + fy], [34, 60 + fy], [36, 86 + fy], [44, 86 + fy], [46, 60 + fy]], PAL.lichLit);
    // robe hem glow
    px(ctx, 24, 88 + fy, 32, 2, PAL.lichGlow);
    // skeletal torso
    ell(ctx, 40, 38 + fy, 8, 10, PAL.boneDark);
    px(ctx, 38, 34 + fy, 2, 8, PAL.bone);
    for (let i = 0; i < 3; i++) px(ctx, 36, 36 + fy + i * 3, 8, 1, PAL.bone);
    // arms
    limb(ctx, 34, 38 + fy, 22, 50 + fy, 3, PAL.bone);
    limb(ctx, 22, 50 + fy, 18, 62 + fy, 3, PAL.boneDark);
    limb(ctx, 46, 38 + fy, 58, 50 + fy, 3, PAL.bone);
    // staff in right hand
    limb(ctx, 58, 50 + fy, 62, 80 + fy, 3, PAL.woodDark);
    limb(ctx, 58, 50 + fy, 62, 80 + fy, 1, PAL.wood);
    // orb on staff
    glow(ctx, 62, 46 + fy, 8, '217,166,255', 4, 0.6);
    ell(ctx, 62, 46 + fy, 5, 5, PAL.lichGlow);
    ell(ctx, 62, 46 + fy, 3, 3, '#ffffff');
    // skull head
    ell(ctx, 40, 24 + fy, 9, 8, PAL.bone);
    ell(ctx, 38, 22 + fy, 7, 6, PAL.boneLit);
    // eye sockets — glowing
    px(ctx, 35, 22 + fy, 4, 4, PAL.outline);
    px(ctx, 36, 23 + fy, 2, 2, PAL.lichGlow);
    px(ctx, 42, 22 + fy, 4, 4, PAL.outline);
    px(ctx, 43, 23 + fy, 2, 2, PAL.lichGlow);
    // jaw
    px(ctx, 36, 28 + fy, 8, 3, PAL.boneDark);
    for (let i = 0; i < 4; i++) px(ctx, 37 + i * 2, 28 + fy, 1, 2, PAL.boneLit);
    // crown / horns
    poly(ctx, [[32, 18 + fy], [28, 8 + fy], [36, 16 + fy]], PAL.gold);
    poly(ctx, [[48, 18 + fy], [52, 8 + fy], [44, 16 + fy]], PAL.gold);
    poly(ctx, [[40, 14 + fy], [38, 4 + fy], [42, 4 + fy], [42, 14 + fy]], PAL.goldLit);
    if (mode === 'cast') {
      glow(ctx, 62, 46 + fy, 14, '217,166,255', 5, 0.7);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + f * 0.5;
        spark(ctx, Math.round(62 + Math.cos(a) * 12), Math.round(46 + Math.sin(a) * 12 + fy), 1, PAL.lichGlow, '#fff');
      }
    }
    if (mode === 'hurt') {
      ell(ctx, 40, 40 + fy, 20, 25, 'rgba(255,255,255,0.3)');
    }
  }

  define('boss_lich_idle', 80, 96, 4, (ctx, f) => lichBody(ctx, f, 'idle'), OL);
  define('boss_lich_cast', 80, 96, 4, (ctx, f) => lichBody(ctx, f, 'cast'), OL);
  define('boss_lich_hurt', 80, 96, 2, (ctx, f) => lichBody(ctx, f, 'hurt'), OL);

  /* ---- Dragon: 160x120, large red dragon ---- */
  function dragonBody(ctx, f, mode) {
    const breathe = [0, 1, 2, 1][f];
    const by = breathe;
    // wings spread
    poly(ctx, [[80, 35 + by], [30, 10 + by], [10, 30 + by], [40, 50 + by], [70, 50 + by]], PAL.drdDark);
    poly(ctx, [[80, 35 + by], [130, 10 + by], [150, 30 + by], [120, 50 + by], [90, 50 + by]], PAL.drdDark);
    // wing membranes
    poly(ctx, [[80, 37 + by], [40, 15 + by], [20, 28 + by], [45, 45 + by], [72, 47 + by]], PAL.drd);
    poly(ctx, [[80, 37 + by], [120, 15 + by], [140, 28 + by], [115, 45 + by], [88, 47 + by]], PAL.drd);
    // wing bone highlights
    limb(ctx, 80, 37 + by, 30, 12 + by, 2, PAL.drdLit);
    limb(ctx, 80, 37 + by, 130, 12 + by, 2, PAL.drdLit);
    // body
    ell(ctx, 80, 60 + by, 36, 22, PAL.drdDark);
    ell(ctx, 80, 58 + by, 32, 19, PAL.drd);
    ell(ctx, 74, 54 + by, 24, 14, PAL.drdLit);
    // molten underbelly
    ell(ctx, 80, 68 + by, 28, 10, PAL.molten);
    ell(ctx, 80, 66 + by, 24, 7, PAL.moltenHot);
    for (let i = -4; i <= 4; i++) px(ctx, 80 + i * 6, 64 + by, 4, 1, PAL.moltenHot);
    // tail
    poly(ctx, [[46, 62 + by], [20, 72 + by], [10, 66 + by], [16, 62 + by], [44, 56 + by]], PAL.drd);
    poly(ctx, [[10, 66 + by], [4, 62 + by], [8, 70 + by]], PAL.drdDark);
    // legs
    limb(ctx, 64, 74 + by, 58, 90 + by, 7, PAL.drdDark);
    limb(ctx, 58, 90 + by, 52, 94 + by, 6, PAL.drd);
    px(ctx, 48, 92 + by, 10, 4, PAL.drdDark);
    limb(ctx, 96, 74 + by, 102, 90 + by, 7, PAL.drdDark);
    limb(ctx, 102, 90 + by, 108, 94 + by, 6, PAL.drd);
    px(ctx, 104, 92 + by, 10, 4, PAL.drdDark);
    // neck + head
    limb(ctx, 100, 48 + by, 120, 30 + by, 12, PAL.drd);
    limb(ctx, 100, 46 + by, 120, 28 + by, 9, PAL.drdLit);
    ell(ctx, 132, 24 + by, 18, 13, PAL.drd);
    ell(ctx, 130, 22 + by, 15, 10, PAL.drdLit);
    // snout
    poly(ctx, [[142, 20 + by], [156, 24 + by], [156, 30 + by], [142, 32 + by]], PAL.drd);
    poly(ctx, [[142, 20 + by], [154, 22 + by], [154, 25 + by], [142, 27 + by]], PAL.drdLit);
    // horns — big sweeping
    poly(ctx, [[122, 12 + by], [112, -4 + by], [128, 8 + by]], PAL.drdDark);
    poly(ctx, [[112, -4 + by], [108, -8 + by], [116, 0 + by]], PAL.gold);
    poly(ctx, [[138, 12 + by], [148, -4 + by], [132, 8 + by]], PAL.drdDark);
    poly(ctx, [[148, -4 + by], [152, -8 + by], [144, 0 + by]], PAL.gold);
    // eyes — molten
    px(ctx, 130, 22 + by, 6, 4, PAL.molten);
    px(ctx, 131, 22 + by, 4, 2, PAL.moltenHot);
    px(ctx, 132, 22 + by, 2, 1, '#fff');
    // teeth
    for (let i = 0; i < 4; i++) px(ctx, 144 + i * 3, 30 + by, 2, 3, PAL.boneLit);
    // back spikes
    for (let i = 0; i < 7; i++) {
      const sx = 44 + i * 10;
      poly(ctx, [[sx, 42 + by], [sx + 4, 30 + by], [sx + 8, 42 + by]], PAL.drdDark);
      px(ctx, sx + 4, 30 + by, 2, 4, PAL.gold);
    }
    if (mode === 'attack') {
      glow(ctx, 156, 26 + by, 20, '255,140,40', 5, 0.6);
      ell(ctx, 156, 26 + by, 14, 8, PAL.molten);
      ell(ctx, 156, 26 + by, 10, 5, PAL.moltenHot);
      ell(ctx, 156, 26 + by, 6, 3, '#fff');
    }
    if (mode === 'hurt') {
      ell(ctx, 80, 58 + by, 36, 22, 'rgba(255,255,255,0.25)');
    }
  }

  define('boss_dragon_idle', 160, 120, 4, (ctx, f) => dragonBody(ctx, f, 'idle'), OL);
  define('boss_dragon_attack', 160, 120, 4, (ctx, f) => dragonBody(ctx, f, 'attack'), OL);
  define('boss_dragon_hurt', 160, 120, 2, (ctx, f) => dragonBody(ctx, f, 'hurt'), OL);
}

/* =========================================================================
 * 7. Projectiles
 * ========================================================================= */

function registerProjectiles() {
  define('proj_arcane', 12, 12, 2, (ctx, f) => {
    glow(ctx, 6, 6, 5, '127,232,255', 3, 0.5);
    ell(ctx, 6, 6, 4, 3, PAL.magic);
    ell(ctx, 6, 6, 2, 1.5, PAL.magicCore);
    if (f === 1) { px(ctx, 2, 6, 3, 1, PAL.magicDim); px(ctx, 8, 6, 3, 1, PAL.magicDim); }
  });

  define('proj_fire', 14, 14, 3, (ctx, f) => {
    const flick = [0, 1, 0][f];
    glow(ctx, 7, 7, 6, '255,140,40', 3, 0.5);
    ell(ctx, 7, 7, 5, 4, PAL.molten);
    ell(ctx, 7, 6 - flick, 3, 3, PAL.moltenHot);
    px(ctx, 7, 5 - flick, 1, 1, '#fff');
    px(ctx, 3, 7, 2, 1, PAL.moltenDeep);
  });

  define('proj_lightning', 20, 8, 3, (ctx, f) => {
    glow(ctx, 10, 4, 6, '255,230,80', 3, 0.4);
    const zig = [0, 1, -1][f];
    px(ctx, 1, 4, 4, 1, '#ffe650');
    px(ctx, 5, 4 + zig, 4, 1, '#ffe650');
    px(ctx, 9, 4 - zig, 4, 1, '#ffe650');
    px(ctx, 13, 4 + zig, 4, 1, '#ffe650');
    px(ctx, 1, 3, 18, 1, 'rgba(255,255,200,0.4)');
    px(ctx, 1, 5, 18, 1, 'rgba(255,255,200,0.3)');
    px(ctx, 17, 4, 3, 1, '#fff');
  });

  define('proj_frost', 14, 14, 2, (ctx, f) => {
    glow(ctx, 7, 7, 5, '180,220,255', 3, 0.4);
    const rot = f === 0 ? 0 : 1;
    poly(ctx, [[7, 2], [10, 7], [7, 12], [4, 7]], '#a0d0ff');
    poly(ctx, [[7, 3], [9, 7], [7, 11], [5, 7]], '#d0e8ff');
    px(ctx, 7, 5, 1, 4, '#fff');
    px(ctx, 5 + rot, 7, 4, 1, '#b0d8ff');
  });

  define('proj_arrow', 20, 6, 1, (ctx) => {
    px(ctx, 2, 3, 12, 1, PAL.wood);
    px(ctx, 2, 2, 12, 1, PAL.woodDark);
    poly(ctx, [[14, 1], [19, 3], [14, 5]], PAL.steelLit);
    px(ctx, 15, 2, 3, 2, PAL.steel);
    px(ctx, 0, 2, 3, 3, '#e8e0c0');
    px(ctx, 0, 1, 2, 1, '#d0c8a0');
  });

  define('proj_enemy_fire', 14, 14, 3, (ctx, f) => {
    const flick = [0, 1, 0][f];
    glow(ctx, 7, 7, 6, '255,60,120', 3, 0.5);
    ell(ctx, 7, 7, 5, 4, '#ff3060');
    ell(ctx, 7, 6 - flick, 3, 3, '#ff80a0');
    px(ctx, 7, 5 - flick, 1, 1, '#fff');
  });

  define('proj_boss_orb', 24, 24, 4, (ctx, f) => {
    const t = f / 4;
    glow(ctx, 12, 12, 10, '180,100,255', 4, 0.6);
    ell(ctx, 12, 12, 8, 8, '#a040ff');
    ell(ctx, 12, 12, 5, 5, '#d080ff');
    ell(ctx, 12, 12, 2, 2, '#fff');
    // swirling particles
    for (let i = 0; i < 4; i++) {
      const a = t * Math.PI * 2 + i * Math.PI / 2;
      const r = 9;
      px(ctx, Math.round(12 + Math.cos(a) * r), Math.round(12 + Math.sin(a) * r), 2, 2, '#e0a0ff');
    }
  });
}

/* =========================================================================
 * 8. Pickups
 * ========================================================================= */

function registerPickups() {
  function runeTablet(ctx, f, color, glowRgb, glyph) {
    const bob = [0, -1, 0, 1][f];
    glow(ctx, 10, 10 + bob, 7, glowRgb, 3, 0.4);
    // tablet shape
    poly(ctx, [[10, 2 + bob], [17, 5 + bob], [17, 15 + bob], [10, 18 + bob], [3, 15 + bob], [3, 5 + bob]], color);
    poly(ctx, [[10, 3 + bob], [16, 6 + bob], [16, 14 + bob], [10, 17 + bob], [4, 14 + bob], [4, 6 + bob]], '#fff');
    // glyph
    glyph(ctx, 10, 10 + bob);
    // sparkle
    if (f === 1) spark(ctx, 16, 4 + bob, 1, '#fff', '#fff');
  }

  define('pickup_arcane', 20, 20, 4, (ctx, f) =>
    runeTablet(ctx, f, PAL.magicDim, '127,232,255', (c, x, y) => {
      px(c, x, y - 3, 1, 6, PAL.magic);
      px(c, x - 2, y, 5, 1, PAL.magic);
      px(c, x, y - 2, 3, 1, PAL.magicCore);
    }));

  define('pickup_fire', 20, 20, 4, (ctx, f) =>
    runeTablet(ctx, f, PAL.moltenDeep, '255,140,40', (c, x, y) => {
      poly(c, [[x, y - 3], [x + 2, y], [x, y + 3], [x - 2, y]], PAL.molten);
      px(c, x, y - 1, 1, 2, PAL.moltenHot);
    }));

  define('pickup_lightning', 20, 20, 4, (ctx, f) =>
    runeTablet(ctx, f, '#9a8000', '255,230,80', (c, x, y) => {
      px(c, x - 1, y - 3, 2, 2, '#ffe650');
      px(c, x, y - 1, 2, 2, '#ffe650');
      px(c, x + 1, y + 1, 2, 2, '#ffe650');
      px(c, x, y + 3, 2, 1, '#ffe650');
    }));

  define('pickup_frost', 20, 20, 4, (ctx, f) =>
    runeTablet(ctx, f, '#5090c0', '180,220,255', (c, x, y) => {
      px(c, x, y - 3, 1, 7, '#a0d0ff');
      px(c, x - 3, y, 7, 1, '#a0d0ff');
      px(c, x - 2, y - 2, 5, 1, '#a0d0ff');
      px(c, x - 2, y + 2, 5, 1, '#a0d0ff');
    }));

  define('pickup_heart', 20, 20, 4, (ctx, f) => {
    const bob = [0, -1, 0, 1][f];
    glow(ctx, 10, 10 + bob, 6, '255,60,80', 3, 0.4);
    // pixel heart
    px(ctx, 5, 6 + bob, 3, 2, '#ff4060');
    px(ctx, 12, 6 + bob, 3, 2, '#ff4060');
    px(ctx, 3, 8 + bob, 14, 3, '#ff4060');
    px(ctx, 5, 11 + bob, 10, 2, '#ff4060');
    px(ctx, 7, 13 + bob, 6, 2, '#ff4060');
    px(ctx, 9, 15 + bob, 2, 1, '#ff4060');
    // highlight
    px(ctx, 5, 7 + bob, 2, 1, '#ff80a0');
    px(ctx, 6, 8 + bob, 2, 1, '#ffa0c0');
  });

  define('pickup_life', 20, 20, 4, (ctx, f) => {
    const bob = [0, -1, 0, 1][f];
    glow(ctx, 10, 10 + bob, 7, '244,197,66', 3, 0.5);
    // winged helm
    ell(ctx, 10, 9 + bob, 6, 5, PAL.gold);
    ell(ctx, 9, 8 + bob, 4, 3, PAL.goldLit);
    // helm crest
    poly(ctx, [[8, 4 + bob], [10, 1 + bob], [12, 4 + bob]], PAL.gold);
    px(ctx, 10, 1 + bob, 1, 3, PAL.goldLit);
    // wings
    poly(ctx, [[4, 8 + bob], [1, 6 + bob], [1, 10 + bob], [4, 11 + bob]], '#fff');
    poly(ctx, [[16, 8 + bob], [19, 6 + bob], [19, 10 + bob], [16, 11 + bob]], '#fff');
    // visor
    px(ctx, 7, 9 + bob, 6, 2, PAL.goldDark);
    px(ctx, 8, 9 + bob, 4, 1, PAL.outline);
  });

  define('pickup_coin', 20, 20, 6, (ctx, f) => {
    const bob = [0, -1, 0, -1, 0, 1][f];
    const spin = Math.abs(Math.cos(f / 6 * Math.PI));
    const w = Math.max(2, Math.round(7 * spin));
    glow(ctx, 10, 10 + bob, 5, '244,197,66', 3, 0.4);
    ell(ctx, 10, 10 + bob, w, 7, PAL.goldDark);
    ell(ctx, 10, 10 + bob, Math.max(1, w - 1), 6, PAL.gold);
    if (w > 3) {
      ell(ctx, 10, 10 + bob, w - 2, 4, PAL.goldLit);
      px(ctx, 10, 8 + bob, 1, 4, PAL.goldDark);
    }
    if (f === 0 || f === 3) spark(ctx, 14, 6 + bob, 1, PAL.goldLit, '#fff');
  });
}

/* =========================================================================
 * 9. Tiles — 32x32, must tile seamlessly
 * ========================================================================= */

function registerTiles() {
  define('tile_stone', 32, 32, 1, (ctx, _f, _t, _w, _h, rng) => {
    ctx.fillStyle = PAL.stone;
    ctx.fillRect(0, 0, 32, 32);
    // brick pattern
    ctx.fillStyle = PAL.stoneDark;
    ctx.fillRect(0, 15, 32, 2);
    ctx.fillRect(0, 30, 32, 2);
    ctx.fillRect(15, 0, 2, 15);
    ctx.fillRect(7, 17, 2, 13);
    ctx.fillRect(23, 17, 2, 13);
    // texture noise
    for (let y = 0; y < 32; y += 2) {
      for (let x = 0; x < 32; x += 2) {
        const n = hash2(x, y, 42);
        if (n > 0.7) px(ctx, x, y, 2, 2, PAL.stoneLit);
        else if (n < 0.2) px(ctx, x, y, 2, 2, PAL.stoneDark);
      }
    }
  });

  define('tile_stone_top', 32, 32, 1, (ctx, _f, _t, _w, _h, rng) => {
    // same as stone but with lit top edge + moss
    ctx.fillStyle = PAL.stone;
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = PAL.stoneDark;
    ctx.fillRect(0, 15, 32, 2);
    ctx.fillRect(15, 0, 2, 15);
    ctx.fillRect(7, 17, 2, 13);
    ctx.fillRect(23, 17, 2, 13);
    // lit top
    px(ctx, 0, 0, 32, 2, PAL.stoneHi);
    px(ctx, 0, 2, 32, 1, PAL.stoneLit);
    // moss patches
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(rng() * 28);
      px(ctx, x, 0, 3 + Math.floor(rng() * 3), 2, PAL.moss);
      if (rng() > 0.5) px(ctx, x + 1, 2, 2, 1, PAL.mossLit);
    }
    for (let y = 4; y < 32; y += 2) {
      for (let x = 0; x < 32; x += 2) {
        const n = hash2(x, y, 43);
        if (n > 0.7) px(ctx, x, y, 2, 2, PAL.stoneLit);
        else if (n < 0.2) px(ctx, x, y, 2, 2, PAL.stoneDark);
      }
    }
  });

  define('tile_dirt', 32, 32, 1, (ctx) => {
    ctx.fillStyle = PAL.dirt;
    ctx.fillRect(0, 0, 32, 32);
    for (let y = 0; y < 32; y += 2) {
      for (let x = 0; x < 32; x += 2) {
        const n = hash2(x, y, 77);
        if (n > 0.6) px(ctx, x, y, 2, 2, PAL.dirtLit);
        else if (n < 0.25) px(ctx, x, y, 2, 2, PAL.dirtDark);
        if (n > 0.92) px(ctx, x, y, 2, 2, '#5a4030'); // pebble
      }
    }
  });

  define('tile_lava_rock', 32, 32, 1, (ctx) => {
    ctx.fillStyle = PAL.basalt;
    ctx.fillRect(0, 0, 32, 32);
    for (let y = 0; y < 32; y += 2) {
      for (let x = 0; x < 32; x += 2) {
        const n = hash2(x, y, 13);
        if (n > 0.65) px(ctx, x, y, 2, 2, PAL.basaltLit);
        // glowing cracks
        if (n > 0.93) { px(ctx, x, y, 2, 2, PAL.molten); px(ctx, x, y, 1, 1, PAL.moltenHot); }
      }
    }
    // crack lines
    px(ctx, 0, 10, 12, 1, PAL.molten);
    px(ctx, 12, 10, 1, 6, PAL.moltenDeep);
    px(ctx, 20, 22, 12, 1, PAL.molten);
    px(ctx, 20, 22, 1, 8, PAL.moltenDeep);
  });

  define('tile_metal', 32, 32, 1, (ctx) => {
    ctx.fillStyle = PAL.iron;
    ctx.fillRect(0, 0, 32, 32);
    // plates
    px(ctx, 0, 15, 32, 2, PAL.ironDark);
    px(ctx, 15, 0, 2, 15, PAL.ironDark);
    px(ctx, 15, 17, 2, 15, PAL.ironDark);
    // rivets
    const rivets = [[3, 3], [28, 3], [3, 28], [28, 28], [18, 3], [18, 28], [3, 20], [28, 20]];
    for (const [rx, ry] of rivets) {
      px(ctx, rx, ry, 3, 3, PAL.ironDark);
      px(ctx, rx, ry, 2, 2, PAL.ironLit);
      px(ctx, rx, ry, 1, 1, '#b0b8c4');
    }
    // highlight
    px(ctx, 0, 0, 32, 1, PAL.ironLit);
    px(ctx, 17, 0, 13, 1, PAL.ironLit);
  });

  define('tile_bone', 32, 32, 1, (ctx, _f, _t, _w, _h, rng) => {
    ctx.fillStyle = PAL.boneDark;
    ctx.fillRect(0, 0, 32, 32);
    // scattered bones
    for (let i = 0; i < 8; i++) {
      const x = Math.floor(rng() * 26);
      const y = Math.floor(rng() * 26);
      const horiz = rng() > 0.5;
      if (horiz) { px(ctx, x, y, 5 + Math.floor(rng() * 3), 2, PAL.bone); px(ctx, x, y, 2, 1, PAL.boneLit); }
      else { px(ctx, x, y, 2, 5 + Math.floor(rng() * 3), PAL.bone); px(ctx, x, y, 1, 2, PAL.boneLit); }
    }
    // a skull
    const sx = 6 + Math.floor(rng() * 18);
    const sy = 6 + Math.floor(rng() * 18);
    ell(ctx, sx + 3, sy + 3, 4, 3, PAL.bone);
    px(ctx, sx + 2, sy + 2, 2, 2, PAL.outline);
    px(ctx, sx + 5, sy + 2, 2, 2, PAL.outline);
    px(ctx, sx + 3, sy + 5, 3, 1, PAL.boneDark);
  });

  define('tile_spike', 32, 32, 1, (ctx) => {
    // dark base
    ctx.fillStyle = PAL.ironDark;
    ctx.fillRect(0, 24, 32, 8);
    px(ctx, 0, 24, 32, 1, PAL.iron);
    // spikes
    const spikeW = [[4, 0], [12, 1], [20, 0], [28, 1]];
    for (const [sx, offset] of spikeW) {
      poly(ctx, [[sx, 24], [sx + 3, 4 + offset], [sx + 6, 24]], PAL.steel);
      poly(ctx, [[sx, 24], [sx + 3, 4 + offset], [sx + 3, 24]], PAL.steelLit);
      px(ctx, sx + 3, 4 + offset, 1, 3, PAL.steelLit);
    }
  });

  define('tile_platform', 32, 32, 1, (ctx) => {
    // narrow stone ledge, bottom transparent
    ctx.fillStyle = PAL.stoneDark;
    ctx.fillRect(0, 0, 32, 14);
    ctx.fillStyle = PAL.stone;
    ctx.fillRect(0, 2, 32, 10);
    px(ctx, 0, 0, 32, 2, PAL.stoneHi);
    px(ctx, 0, 2, 32, 1, PAL.stoneLit);
    // mortar lines
    px(ctx, 15, 2, 1, 10, PAL.mortar);
    // bottom edge
    px(ctx, 0, 12, 32, 2, PAL.stoneDark);
    // texture
    for (let y = 4; y < 12; y += 2) {
      for (let x = 0; x < 32; x += 2) {
        if (hash2(x, y, 55) > 0.7) px(ctx, x, y, 2, 2, PAL.stoneLit);
      }
    }
  });
}

/* =========================================================================
 * 10. Backgrounds — wide parallax strips, tile horizontally
 * ========================================================================= */

function registerBackgrounds() {
  define('bg_crypt_far', 480, 270, 1, (ctx) => {
    // deep gradient
    for (let y = 0; y < 270; y++) {
      const t = y / 270;
      const r = Math.round(26 + t * 10);
      const g = Math.round(16 + t * 8);
      const b = Math.round(48 + t * 20);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, 480, 1);
    }
    // distant arches
    for (let i = 0; i < 4; i++) {
      const ax = i * 120 + 20;
      ctx.fillStyle = PAL.cryptWall;
      ctx.fillRect(ax, 80, 80, 190);
      ctx.fillStyle = PAL.cryptWall2;
      ctx.fillRect(ax + 8, 90, 64, 180);
      ctx.fillStyle = PAL.cryptDark;
      ctx.fillRect(ax + 16, 100, 48, 170);
      // arch top
      ctx.fillStyle = PAL.cryptWall;
      for (let a = 0; a <= 40; a++) {
        const dy = Math.round(Math.sin(a / 40 * Math.PI) * 20);
        ctx.fillRect(ax + a + 20, 80 - dy, 1, dy + 10);
      }
    }
    // torch glows
    for (let i = 0; i < 6; i++) {
      const tx = 40 + i * 80;
      glow(ctx, tx, 120, 18, '255,140,40', 4, 0.25);
    }
  });

  define('bg_crypt_near', 480, 270, 1, (ctx) => {
    // near pillars — mostly transparent
    for (let i = 0; i < 3; i++) {
      const px_ = 60 + i * 160;
      ctx.fillStyle = 'rgba(36,26,61,0.7)';
      ctx.fillRect(px_, 60, 28, 210);
      ctx.fillStyle = 'rgba(47,35,80,0.5)';
      ctx.fillRect(px_ + 4, 64, 20, 206);
      // chains
      ctx.fillStyle = 'rgba(60,60,70,0.6)';
      for (let c = 0; c < 8; c++) ctx.fillRect(px_ + 12, 40 + c * 8, 4, 4);
    }
  });

  define('bg_forge_far', 480, 270, 1, (ctx) => {
    // dark red gradient
    for (let y = 0; y < 270; y++) {
      const t = y / 270;
      const r = Math.round(42 + t * 60);
      const g = Math.round(15 + t * 10);
      const b = Math.round(12 + t * 5);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, 480, 1);
    }
    // lava lake at bottom
    ctx.fillStyle = PAL.forgeGlow;
    ctx.fillRect(0, 220, 480, 50);
    for (let x = 0; x < 480; x += 4) {
      const n = hash2(x, 0, 99);
      px(ctx, x, 220, 4, Math.round(n * 8), PAL.molten);
    }
    glow(ctx, 240, 230, 100, '255,90,26', 5, 0.3);
    // dark rock formations
    ctx.fillStyle = PAL.forgeRock;
    for (let i = 0; i < 5; i++) {
      const rx = i * 100 + 20;
      ctx.fillRect(rx, 180, 60, 40);
      ctx.fillRect(rx + 10, 160, 40, 20);
    }
  });

  define('bg_forge_near', 480, 270, 1, (ctx) => {
    // chains and cauldrons — mostly transparent
    for (let i = 0; i < 4; i++) {
      const cx = 50 + i * 120;
      // chain
      ctx.fillStyle = 'rgba(60,50,45,0.6)';
      for (let c = 0; c < 6; c++) ctx.fillRect(cx, 20 + c * 10, 4, 4);
      // cauldron
      ctx.fillStyle = 'rgba(40,30,25,0.7)';
      ctx.fillRect(cx - 12, 80, 28, 20);
      ctx.fillRect(cx - 10, 78, 24, 2);
      // glow inside
      glow(ctx, cx + 2, 85, 8, '255,140,40', 3, 0.3);
    }
  });

  define('bg_roost_far', 480, 270, 1, (ctx) => {
    // night sky gradient
    for (let y = 0; y < 270; y++) {
      const t = y / 270;
      const r = Math.round(11 + t * 16);
      const g = Math.round(16 + t * 20);
      const b = Math.round(48 + t * 40);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, 480, 1);
    }
    // stars
    for (let i = 0; i < 60; i++) {
      const sx = Math.floor(hash2(i, 0, 7) * 480);
      const sy = Math.floor(hash2(i, 1, 7) * 180);
      const sz = hash2(i, 2, 7) > 0.8 ? 2 : 1;
      px(ctx, sx, sy, sz, sz, '#fff');
    }
    // moon
    ell(ctx, 360, 60, 28, 28, PAL.moon);
    ell(ctx, 355, 55, 22, 22, '#e8e4c8');
    ell(ctx, 350, 52, 8, 8, '#d8d4b8');
    // mountains
    ctx.fillStyle = PAL.mountain;
    for (let i = 0; i < 6; i++) {
      const mx = i * 90 - 20;
      ctx.beginPath();
      ctx.moveTo(mx, 270);
      ctx.lineTo(mx + 45, 160 + Math.floor(hash2(i, 3, 7) * 40));
      ctx.lineTo(mx + 90, 270);
      ctx.fill();
    }
    ctx.fillStyle = PAL.mountain2;
    for (let i = 0; i < 5; i++) {
      const mx = i * 100 + 30;
      ctx.beginPath();
      ctx.moveTo(mx, 270);
      ctx.lineTo(mx + 50, 190 + Math.floor(hash2(i, 4, 7) * 30));
      ctx.lineTo(mx + 100, 270);
      ctx.fill();
    }
  });

  define('bg_roost_near', 480, 270, 1, (ctx) => {
    // ruined battlements — mostly transparent
    ctx.fillStyle = 'rgba(20,26,52,0.8)';
    for (let i = 0; i < 8; i++) {
      const bx = i * 60;
      const bh = 30 + Math.floor(hash2(i, 5, 7) * 20);
      ctx.fillRect(bx, 270 - bh, 40, bh);
      // crenellation
      ctx.fillRect(bx + 4, 270 - bh - 8, 8, 8);
      ctx.fillRect(bx + 24, 270 - bh - 8, 8, 8);
    }
  });
}

/* =========================================================================
 * 11. Decor
 * ========================================================================= */

function registerDecor() {
  define('decor_torch', 16, 32, 4, (ctx, f) => {
    // bracket
    px(ctx, 6, 20, 4, 10, PAL.ironDark);
    px(ctx, 6, 20, 4, 1, PAL.iron);
    px(ctx, 7, 20, 2, 10, PAL.ironLit);
    // flame
    const fl = [0, 1, 2, 1][f];
    glow(ctx, 8, 14, 8, '255,140,40', 4, 0.5);
    poly(ctx, [[5, 20], [8, 6 - fl], [11, 20]], PAL.torch);
    poly(ctx, [[6, 20], [8, 10 - fl], [10, 20]], PAL.torchHot);
    px(ctx, 8, 8 - fl, 1, 4, '#fff');
    // sparks
    if (f === 2) { px(ctx, 4, 8, 1, 1, PAL.torch); px(ctx, 12, 10, 1, 1, PAL.torchHot); }
  });

  define('decor_chain', 8, 32, 1, (ctx) => {
    for (let c = 0; c < 4; c++) {
      const cy = c * 8;
      px(ctx, 2, cy, 4, 3, PAL.ironDark);
      px(ctx, 2, cy, 4, 1, PAL.iron);
      px(ctx, 3, cy, 2, 1, PAL.ironLit);
      px(ctx, 3, cy + 3, 2, 1, PAL.ironDark);
    }
  });

  define('decor_skull_pile', 40, 20, 1, (ctx, _f, _t, _w, _h, rng) => {
    // pile of skulls
    const skulls = [[4, 12], [14, 14], [24, 12], [32, 14], [9, 6], [20, 6], [29, 7], [16, 0]];
    for (const [sx, sy] of skulls) {
      ell(ctx, sx + 4, sy + 4, 4, 3, PAL.bone);
      ell(ctx, sx + 3, sy + 3, 3, 2, PAL.boneLit);
      px(ctx, sx + 2, sy + 3, 2, 2, PAL.outline);
      px(ctx, sx + 5, sy + 3, 2, 2, PAL.outline);
      px(ctx, sx + 3, sy + 6, 3, 1, PAL.boneDark);
    }
  });

  define('decor_banner', 24, 40, 2, (ctx, f) => {
    const sway = [0, 1][f];
    // pole
    px(ctx, 11, 0, 2, 40, PAL.woodDark);
    px(ctx, 11, 0, 1, 40, PAL.wood);
    // banner fabric
    poly(ctx, [[6 - sway, 4], [18 + sway, 4], [18 + sway, 28], [15, 32], [12, 28], [9, 32], [6 - sway, 28]], PAL.lichDark);
    poly(ctx, [[7 - sway, 6], [17 + sway, 6], [17 + sway, 26], [12, 30], [7 - sway, 26]], PAL.lich);
    // emblem
    ell(ctx, 12, 16, 4, 4, PAL.gold);
    px(ctx, 11, 15, 2, 2, PAL.goldLit);
  });
}

/* =========================================================================
 * 12. Init + public API
 * ========================================================================= */

async function init() {
  if (initialised) return ready;
  if (initPromise) return initPromise;
  if (!hasDOM()) {
    rejectReady(new Error('sprites.init() requires a DOM (document.createElement)'));
    return ready;
  }
  initPromise = (async () => {
    placeholder = makeCanvas(16, 16);
    const pctx = ctx2d(placeholder);
    if (pctx) { pctx.fillStyle = '#ff00ff'; pctx.fillRect(0, 0, 16, 16); }

    registerPlayer();
    registerEnemies();
    registerBosses();
    registerProjectiles();
    registerPickups();
    registerTiles();
    registerBackgrounds();
    registerDecor();

    initialised = true;
    resolveReady();
  })();
  return initPromise;
}

function frameCount(name) {
  const e = REG.get(name);
  return e ? e.frames.length : 1;
}

function get(name, frame = 0) {
  const e = REG.get(name);
  if (!e) {
    if (!warned.has(name)) { console.warn('[sprites] unknown sprite:', name); warned.add(name); }
    return placeholder || makeCanvas(16, 16);
  }
  const n = e.frames.length;
  return e.frames[((frame % n) + n) % n];
}

function names() {
  return Array.from(REG.keys());
}

export const Sprites = { ready, init, get, frameCount, names };
export default Sprites;
