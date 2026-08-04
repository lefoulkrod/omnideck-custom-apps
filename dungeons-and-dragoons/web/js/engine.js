/**
 * engine.js — Dungeons & Dragoons
 * Game loop, input, camera, collision, particles.
 */

// ---- Input ----
export const Input = {
  keys: new Set(),
  pressed: new Set(),
  released: new Set(),
  _gamepad: null,

  init() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => { this.keys.clear(); });
  },

  clearFrame() { this.pressed.clear(); this.released.clear(); },

  down(code) { return this.keys.has(code); },
  justPressed(code) { return this.pressed.has(code); },
  justReleased(code) { return this.released.has(code); },

  // Convenience
  get left() { return this.down('ArrowLeft') || this.down('KeyA'); },
  get right() { return this.down('ArrowRight') || this.down('KeyD'); },
  get up() { return this.down('ArrowUp') || this.down('KeyW'); },
  get down() { return this.down('ArrowDown') || this.down('KeyS'); },
  get jump() { return this.down('Space') || this.down('KeyZ'); },
  get jumpPressed() { return this.justPressed('Space') || this.justPressed('KeyZ'); },
  get shoot() { return this.down('KeyX') || this.down('KeyJ'); },
  get shootPressed() { return this.justPressed('KeyX') || this.justPressed('KeyJ'); },
  get switchWeapon() { return this.justPressed('KeyQ') || this.justPressed('KeyE'); },
  get pause() { return this.justPressed('Escape') || this.justPressed('KeyP'); },
  get enter() { return this.justPressed('Enter'); },
};

// ---- AABB collision ----
export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function aabbOverlap(a, b) {
  const cx = b.x + b.w / 2 - (a.x + a.w / 2);
  const cy = b.y + b.h / 2 - (a.y + a.h / 2);
  const ox = (a.w + b.w) / 2 - Math.abs(cx);
  const oy = (a.h + b.h) / 2 - Math.abs(cy);
  if (ox <= 0 || oy <= 0) return null;
  return { x: cx < 0 ? -ox : ox, y: cy < 0 ? -oy : oy, ox, oy };
}

// ---- Tile collision ----
export function tileCollision(entity, tiles, tileW, tileH) {
  // entity has x, y, w, h, vx, vy, onGround, onCeiling, hitWall
  const result = { onGround: false, onCeiling: false, hitWallLeft: false, hitWallRight: false };

  // Horizontal
  entity.x += entity.vx;
  const left = Math.floor(entity.x / tileW);
  const right = Math.floor((entity.x + entity.w - 1) / tileW);
  const top = Math.floor(entity.y / tileH);
  const bottom = Math.floor((entity.y + entity.h - 1) / tileH);

  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      if (isSolid(tiles, tx, ty)) {
        const tileX = tx * tileW;
        if (entity.vx > 0) { entity.x = tileX - entity.w; result.hitWallRight = true; }
        else if (entity.vx < 0) { entity.x = tileX + tileW; result.hitWallLeft = true; }
        entity.vx = 0;
      }
    }
  }

  // Vertical
  entity.y += entity.vy;
  const left2 = Math.floor(entity.x / tileW);
  const right2 = Math.floor((entity.x + entity.w - 1) / tileW);
  const top2 = Math.floor(entity.y / tileH);
  const bottom2 = Math.floor((entity.y + entity.h - 1) / tileH);

  for (let ty = top2; ty <= bottom2; ty++) {
    for (let tx = left2; tx <= right2; tx++) {
      if (isSolid(tiles, tx, ty)) {
        const tileY = ty * tileH;
        if (entity.vy > 0) { entity.y = tileY - entity.h; result.onGround = true; }
        else if (entity.vy < 0) { entity.y = tileY + tileH; result.onCeiling = true; }
        entity.vy = 0;
      }
    }
  }

  // Spikes
  for (let ty = top2; ty <= bottom2; ty++) {
    for (let tx = left2; tx <= right2; tx++) {
      if (isHazard(tiles, tx, ty)) {
        result.hitHazard = true;
      }
    }
  }

  return result;
}

function isSolid(tiles, tx, ty) {
  const row = tiles[ty];
  if (!row) return false;
  const t = row[tx];
  if (t === undefined || t === 0 || t === '.') return false;
  // platform = one-way (solid only from above)
  return t !== 'P';
}

function isHazard(tiles, tx, ty) {
  const row = tiles[ty];
  if (!row) return false;
  return row[tx] === 'S';
}

export function isPlatform(tiles, tx, ty) {
  const row = tiles[ty];
  if (!row) return false;
  return row[tx] === 'P';
}

// ---- Camera ----
export class Camera {
  constructor(w, h) {
    this.x = 0; this.y = 0;
    this.w = w; this.h = h;
    this.targetX = 0; this.targetY = 0;
    this.shake = 0;
    this.shakeX = 0; this.shakeY = 0;
  }
  follow(tx, ty, levelW, levelH) {
    this.targetX = tx - this.w / 2;
    this.targetY = ty - this.h / 2;
    this.targetX = Math.max(0, Math.min(this.targetX, levelW - this.w));
    this.targetY = Math.max(0, Math.min(this.targetY, levelH - this.h));
    this.x += (this.targetX - this.x) * 0.12;
    this.y += (this.targetY - this.y) * 0.12;
  }
  doShake(amount) { this.shake = Math.max(this.shake, amount); }
  update() {
    if (this.shake > 0) {
      this.shakeX = (Math.random() - 0.5) * this.shake;
      this.shakeY = (Math.random() - 0.5) * this.shake;
      this.shake *= 0.85;
      if (this.shake < 0.1) this.shake = 0;
    } else { this.shakeX = 0; this.shakeY = 0; }
  }
  get ox() { return Math.round(this.x + this.shakeX); }
  get oy() { return Math.round(this.y + this.shakeY); }
}

// ---- Particles ----
export class ParticleSystem {
  constructor() { this.particles = []; }
  spawn(x, y, vx, vy, life, color, size, gravity = 0) {
    this.particles.push({ x, y, vx, vy, life, maxLife: life, color, size, gravity });
  }
  burst(x, y, count, speed, color, size, life, gravity = 0.1) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.5 + Math.random() * 0.5);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.7 + Math.random() * 0.3), color, size, gravity);
    }
  }
  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.gravity * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }
  draw(ctx, cam) {
    for (const p of this.particles) {
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x - cam.ox - p.size / 2), Math.round(p.y - cam.oy - p.size / 2), p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }
  clear() { this.particles.length = 0; }
}

// ---- Game loop ----
export class GameLoop {
  constructor(update, render, fps = 60) {
    this.update = update;
    this.render = render;
    this.fixedDt = 1 / fps;
    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this._raf = null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      let frameTime = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (frameTime > 0.25) frameTime = 0.25;
      this.accumulator += frameTime;
      while (this.accumulator >= this.fixedDt) {
        this.update(this.fixedDt);
        this.accumulator -= this.fixedDt;
      }
      this.render();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
  stop() { this.running = false; if (this._raf) cancelAnimationFrame(this._raf); }
}
