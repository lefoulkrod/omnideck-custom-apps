/**
 * entities.js — Dungeons & Dragoons
 * Player, enemies, projectiles, pickups.
 */

import { Input, aabb, aabbOverlap, tileCollision, TILE } from './engine.js';
import { Sprites } from './sprites.js';
import { Audio } from './audio.js';

// ---- Weapons ----
export const WEAPONS = {
  arcane:    { name: 'Arcane Bolt',   sprite: 'proj_arcane',    dmg: 1, speed: 420, cooldown: 0.18, spread: 0,   pierce: false, sfx: 'shoot_arcane' },
  fire:      { name: 'Fire Spread',   sprite: 'proj_fire',      dmg: 1, speed: 320, cooldown: 0.35, spread: 3,   pierce: false, sfx: 'shoot_fire' },
  lightning: { name: 'Lightning Beam',sprite: 'proj_lightning', dmg: 1, speed: 600, cooldown: 0.10, spread: 0,   pierce: true,  sfx: 'shoot_lightning' },
  frost:     { name: 'Frost Shard',   sprite: 'proj_frost',     dmg: 2, speed: 280, cooldown: 0.40, spread: 0,   pierce: false, sfx: 'shoot_frost' },
};
export const WEAPON_ORDER = ['arcane', 'fire', 'lightning', 'frost'];

// ---- Player ----
export class Player {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.w = 20; this.h = 36;
    this.vx = 0; this.vy = 0;
    this.facing = 1; // 1=right, -1=left
    this.hp = 3; this.maxHp = 3;
    this.lives = 3;
    this.invuln = 0;
    this.onGround = false;
    this.ducking = false;
    this.weapon = 'arcane';
    this.weapons = new Set(['arcane']);
    this.fireTimer = 0;
    this.animFrame = 0;
    this.animTime = 0;
    this.dead = false;
    this.dieTime = 0;
    this.checkpoint = { x, y };
    this.score = 0;
    this.coins = 0;
    this.aimAngle = 0; // for sprite selection
  }

  get hitbox() { return { x: this.x + 6, y: this.y + 2, w: this.w, h: this.h }; }

  update(dt, level, particles) {
    if (this.dead) {
      this.dieTime += dt;
      this.vy += 800 * dt;
      this.y += this.vy * dt;
      return;
    }

    if (this.invuln > 0) this.invuln -= dt;
    if (this.fireTimer > 0) this.fireTimer -= dt;

    // Movement
    const speed = 200;
    this.ducking = Input.down && this.onGround;
    
    if (!this.ducking) {
      if (Input.left) { this.vx = -speed; this.facing = -1; }
      else if (Input.right) { this.vx = speed; this.facing = 1; }
      else this.vx *= 0.7;
    } else {
      this.vx *= 0.5;
    }

    // Jump
    if (Input.jumpPressed && this.onGround) {
      this.vy = -480;
      Audio.play('jump');
    }

    // Variable jump height
    if (!Input.jump && this.vy < -200) this.vy = -200;

    // Gravity
    this.vy += 1200 * dt;
    if (this.vy > 600) this.vy = 600;

    // Tile collision
    const col = tileCollision(this, level.tiles, TILE, TILE);
    if (col.onGround && !this.onGround) Audio.play('land');
    this.onGround = col.onGround;
    if (col.hitHazard) this.takeDamage(1);

    // Shooting
    if (Input.shoot && this.fireTimer <= 0) {
      this.shoot(level);
    }

    // Weapon switch
    if (Input.switchWeapon) {
      const idx = WEAPON_ORDER.indexOf(this.weapon);
      this.weapon = WEAPON_ORDER[(idx + 1) % WEAPON_ORDER.length];
      Audio.play('menu_select');
    }

    // Animation
    this.animTime += dt;
    if (this.onGround && Math.abs(this.vx) > 10) {
      this.animFrame = Math.floor(this.animTime * 12) % 6;
    } else if (this.onGround) {
      this.animFrame = Math.floor(this.animTime * 3) % 4;
    } else {
      this.animFrame = this.vy < 0 ? 0 : 1;
    }

    // Aim angle for sprite
    if (Input.up) this.aimAngle = -90;
    else if (Input.down && !this.onGround) this.aimAngle = 90;
    else if (Input.up && Input.left) this.aimAngle = -135;
    else if (Input.up && Input.right) this.aimAngle = -45;
    else if (Input.down && Input.left) this.aimAngle = 135;
    else if (Input.down && Input.right) this.aimAngle = 45;
    else this.aimAngle = 0;

    // Fall off world
    if (this.y > level.height + 100) this.takeDamage(99);
  }

  shoot(level) {
    const w = WEAPONS[this.weapon];
    this.fireTimer = w.cooldown;
    Audio.play(w.sfx);

    let dx = this.facing, dy = 0;
    if (Input.up) { dy = -1; if (!Input.left && !Input.right) dx = 0; }
    else if (Input.down && !this.onGround) { dy = 1; if (!Input.left && !Input.right) dx = 0; }
    if (Input.left && Input.up) { dx = -1; dy = -1; }
    if (Input.right && Input.up) { dx = 1; dy = -1; }
    if (Input.left && Input.down) { dx = -1; dy = 1; }
    if (Input.right && Input.down) { dx = -1; dy = 1; }
    if (Input.left) dx = -1;
    if (Input.right) dx = 1;

    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;

    const mx = this.x + this.w / 2 + dx * 16;
    const my = this.y + this.h / 2 + dy * 16 - 4;

    const count = w.spread > 0 ? w.spread : 1;
    for (let i = 0; i < count; i++) {
      const spreadAngle = count > 1 ? (i - (count - 1) / 2) * 0.15 : 0;
      const a = Math.atan2(dy, dx) + spreadAngle;
      level.projectiles.push(new Projectile(
        mx, my, Math.cos(a) * w.speed, Math.sin(a) * w.speed,
        w.dmg, w.sprite, true, w.pierce
      ));
    }

    // Muzzle flash particles
    for (let i = 0; i < 3; i++) {
      particles.spawn(mx, my, dx * 60 + (Math.random() - 0.5) * 40, dy * 60 + (Math.random() - 0.5) * 40, 0.15, '#ffe080', 3, 0);
    }
  }

  takeDamage(dmg) {
    if (this.invuln > 0 || this.dead) return;
    this.hp -= dmg;
    Audio.play('player_hurt');
    this.invuln = 1.5;
    if (this.hp <= 0) {
      this.die();
    }
  }

  die() {
    this.dead = true;
    this.dieTime = 0;
    this.vy = -300;
    Audio.play('player_die');
  }

  respawn() {
    this.x = this.checkpoint.x;
    this.y = this.checkpoint.y;
    this.hp = this.maxHp;
    this.dead = false;
    this.invuln = 2;
    this.vx = 0; this.vy = 0;
    this.lives--;
  }

  getSpriteName() {
    if (this.dead) return 'player_die';
    if (this.invuln > 1.2) return 'player_hurt';
    if (this.ducking) return 'player_duck';
    if (!this.onGround) return 'player_jump';
    if (this.aimAngle === -90) return 'player_aim_up';
    if (this.aimAngle === -45) return 'player_aim_diag_up';
    if (this.aimAngle === 45) return 'player_aim_diag_down';
    if (Math.abs(this.vx) > 10) return 'player_run';
    return 'player_idle';
  }

  draw(ctx, cam) {
    const name = this.getSpriteName();
    const frame = this.dead ? Math.min(3, Math.floor(this.dieTime * 6)) : this.animFrame;
    const sprite = Sprites.get(name, frame);
    if (!sprite) return;
    // Flicker when invulnerable
    if (this.invuln > 0 && !this.dead) {
      if (Math.floor(this.invuln * 12) % 2 === 0) return;
    }
    const sx = Math.round(this.x - cam.ox - 6);
    const sy = Math.round(this.y - cam.oy - 4);
    ctx.save();
    if (this.facing < 0) {
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, -sx - sprite.width, sy);
    } else {
      ctx.drawImage(sprite, sx, sy);
    }
    ctx.restore();
  }
}

// ---- Projectile ----
export class Projectile {
  constructor(x, y, vx, vy, dmg, sprite, fromPlayer, pierce) {
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.w = 12; this.h = 12;
    this.dmg = dmg;
    this.sprite = sprite;
    this.fromPlayer = fromPlayer;
    this.pierce = pierce;
    this.dead = false;
    this.life = 2.0;
    this.animTime = 0;
  }

  get hitbox() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }

  update(dt, level) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    this.animTime += dt;
    if (this.life <= 0) this.dead = true;

    // Tile collision
    const tx = Math.floor(this.x / TILE);
    const ty = Math.floor(this.y / TILE);
    const row = level.tiles[ty];
    if (row && row[tx] && row[tx] !== '.' && row[tx] !== 'P' && row[tx] !== 'S') {
      this.dead = true;
    }
  }

  draw(ctx, cam) {
    const frame = Math.floor(this.animTime * 15);
    const sprite = Sprites.get(this.sprite, frame);
    if (!sprite) return;
    const angle = Math.atan2(this.vy, this.vx);
    ctx.save();
    ctx.translate(Math.round(this.x - cam.ox), Math.round(this.y - cam.oy));
    ctx.rotate(angle);
    ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
    ctx.restore();
  }
}

// ---- Enemy base ----
class Enemy {
  constructor(x, y, w, h, hp) {
    this.x = x; this.y = y;
    this.w = w; this.h = h;
    this.vx = 0; this.vy = 0;
    this.hp = hp;
    this.maxHp = hp;
    this.facing = -1;
    this.dead = false;
    this.dying = false;
    this.dieTime = 0;
    this.onGround = false;
    this.invuln = 0;
    this.animTime = 0;
    this.animFrame = 0;
    this.hitFlash = 0;
  }

  get hitbox() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }

  takeDamage(dmg) {
    if (this.dying) return;
    this.hp -= dmg;
    this.hitFlash = 0.15;
    if (this.hp <= 0) this.startDeath();
  }

  startDeath() {
    this.dying = true;
    this.dieTime = 0;
    Audio.play('enemy_die');
  }

  updateDeath(dt) {
    this.dieTime += dt;
    this.vy += 800 * dt;
    this.y += this.vy * dt;
    if (this.dieTime > 0.5) this.dead = true;
  }

  drawSprite(ctx, cam, name, frame) {
    const sprite = Sprites.get(name, frame);
    if (!sprite) return;
    const sx = Math.round(this.x - cam.ox);
    const sy = Math.round(this.y - cam.oy);
    ctx.save();
    if (this.facing < 0) {
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, -sx - sprite.width, sy);
    } else {
      ctx.drawImage(sprite, sx, sy);
    }
    if (this.hitFlash > 0) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(255,255,255,${this.hitFlash * 4})`;
      ctx.fillRect(sx, sy, sprite.width, sprite.height);
    }
    ctx.restore();
  }
}

// ---- Goblin ----
export class Goblin extends Enemy {
  constructor(x, y) { super(x, y, 24, 28, 2); this.speed = 80; }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;

    // Chase player
    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;
    this.vx = this.facing * this.speed;

    this.vy += 1200 * dt;
    const col = tileCollision(this, level.tiles, TILE, TILE);
    this.onGround = col.onGround;

    // Turn at edges
    if (this.onGround) {
      const ahead = Math.floor((this.x + this.facing * (this.w + 4)) / TILE);
      const below = Math.floor((this.y + this.h + 4) / TILE);
      const row = level.tiles[below];
      if (row && (!row[ahead] || row[ahead] === '.')) {
        this.vx = 0; // stop at ledge
      }
    }

    this.animFrame = Math.floor(this.animTime * 10) % 6;
  }
  draw(ctx, cam) {
    if (this.dying) {
      const f = Math.min(2, Math.floor(this.dieTime * 8));
      this.drawSprite(ctx, cam, 'goblin_die', f);
    } else {
      this.drawSprite(ctx, cam, 'goblin_run', this.animFrame);
    }
  }
  getScore() { return 100; }
}

// ---- Skeleton Archer ----
export class Skeleton extends Enemy {
  constructor(x, y) {
    super(x, y, 24, 32, 3);
    this.speed = 0;
    this.shootTimer = 1 + Math.random();
    this.aiming = false;
  }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;

    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;

    this.vy += 1200 * dt;
    const col = tileCollision(this, level.tiles, TILE, TILE);
    this.onGround = col.onGround;
    this.vx = 0;

    // Shoot at player
    this.shootTimer -= dt;
    if (this.shootTimer <= 0) {
      this.aiming = true;
      this.animFrame = 0;
      setTimeout(() => {
        if (this.dying) return;
        const dy = player.y - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const speed = 300;
        level.projectiles.push(new Projectile(
          this.x + this.w / 2, this.y + this.h / 2,
          (dx / dist) * speed, (dy / dist) * speed,
          1, 'proj_arrow', false, false
        ));
        Audio.play('hit_wall');
        this.aiming = false;
      }, 300);
      this.shootTimer = 2 + Math.random();
    }

    if (this.aiming) this.animFrame = Math.min(2, Math.floor(this.animTime * 8) % 3);
    else this.animFrame = Math.floor(this.animTime * 2) % 2;
  }
  draw(ctx, cam) {
    if (this.dying) {
      const f = Math.min(3, Math.floor(this.dieTime * 8));
      this.drawSprite(ctx, cam, 'skeleton_die', f);
    } else {
      this.drawSprite(ctx, cam, this.aiming ? 'skeleton_shoot' : 'skeleton_idle', this.animFrame);
    }
  }
  getScore() { return 150; }
}

// ---- Bat ----
export class Bat extends Enemy {
  constructor(x, y) {
    super(x, y, 20, 16, 1);
    this.baseY = y;
    this.phase = Math.random() * Math.PI * 2;
    this.speed = 60;
  }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;

    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;
    this.vx = this.facing * this.speed;
    this.phase += dt * 4;
    this.vy = Math.sin(this.phase) * 60;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.animFrame = Math.floor(this.animTime * 12) % 4;
  }
  draw(ctx, cam) {
    if (this.dying) {
      const f = Math.min(2, Math.floor(this.dieTime * 8));
      this.drawSprite(ctx, cam, 'bat_die', f);
    } else {
      this.drawSprite(ctx, cam, 'bat_fly', this.animFrame);
    }
  }
  getScore() { return 75; }
}

// ---- Slime ----
export class Slime extends Enemy {
  constructor(x, y) {
    super(x, y, 22, 18, 2);
    this.hopTimer = 1 + Math.random();
    this.speed = 100;
  }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;

    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;

    this.vy += 1200 * dt;
    const col = tileCollision(this, level.tiles, TILE, TILE);
    this.onGround = col.onGround;

    this.hopTimer -= dt;
    if (this.onGround && this.hopTimer <= 0) {
      this.vy = -350;
      this.vx = this.facing * this.speed;
      this.hopTimer = 1.5 + Math.random();
    }
    if (this.onGround) this.vx *= 0.8;

    this.animFrame = Math.floor(this.animTime * 6) % 4;
  }
  draw(ctx, cam) {
    if (this.dying) {
      const f = Math.min(2, Math.floor(this.dieTime * 8));
      this.drawSprite(ctx, cam, 'slime_die', f);
    } else {
      this.drawSprite(ctx, cam, 'slime_hop', this.animFrame);
    }
  }
  getScore() { return 100; }
}

// ---- Imp ----
export class Imp extends Enemy {
  constructor(x, y) {
    super(x, y, 22, 22, 2);
    this.baseY = y;
    this.phase = Math.random() * Math.PI * 2;
    this.speed = 80;
    this.diveTimer = 2 + Math.random() * 2;
    this.diving = false;
  }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;

    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;
    this.phase += dt * 5;

    if (!this.diving) {
      this.vx = this.facing * this.speed;
      this.vy = Math.sin(this.phase) * 50;
      this.diveTimer -= dt;
      if (this.diveTimer <= 0) {
        this.diving = true;
        const dy = player.y - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        this.vx = (dx / dist) * 200;
        this.vy = (dy / dist) * 200;
      }
    } else {
      // diving
      if (Math.abs(dx) < 10 && Math.abs(player.y - this.y) < 30) this.diving = false;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.animFrame = Math.floor(this.animTime * 12) % 4;
  }
  draw(ctx, cam) {
    if (this.dying) {
      const f = Math.min(2, Math.floor(this.dieTime * 8));
      this.drawSprite(ctx, cam, 'imp_die', f);
    } else {
      this.drawSprite(ctx, cam, 'imp_fly', this.animFrame);
    }
  }
  getScore() { return 125; }
}

// ---- Pickup ----
export class Pickup {
  constructor(x, y, type) {
    this.x = x; this.y = y;
    this.w = 20; this.h = 20;
    this.type = type;
    this.dead = false;
    this.animTime = 0;
    this.bob = 0;
  }
  get hitbox() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
  get spriteName() {
    switch (this.type) {
      case 'arcane': return 'pickup_arcane';
      case 'fire': return 'pickup_fire';
      case 'lightning': return 'pickup_lightning';
      case 'frost': return 'pickup_frost';
      case 'heart': return 'pickup_heart';
      case 'life': return 'pickup_life';
      case 'coin': return 'pickup_coin';
      default: return 'pickup_coin';
    }
  }
  update(dt) {
    this.animTime += dt;
    this.bob = Math.sin(this.animTime * 3) * 3;
  }
  apply(player) {
    switch (this.type) {
      case 'arcane': case 'fire': case 'lightning': case 'frost':
        player.weapons.add(this.type);
        player.weapon = this.type;
        Audio.play('pickup_weapon');
        player.score += 50;
        break;
      case 'heart':
        if (player.hp < player.maxHp) player.hp++;
        Audio.play('pickup_heart');
        player.score += 25;
        break;
      case 'life':
        player.lives++;
        Audio.play('pickup_life');
        player.score += 100;
        break;
      case 'coin':
        player.coins++;
        player.score += 10;
        Audio.play('pickup_coin');
        break;
    }
    this.dead = true;
  }
  draw(ctx, cam) {
    const frame = Math.floor(this.animTime * 6) % (Sprites.frameCount(this.spriteName) || 4);
    const sprite = Sprites.get(this.spriteName, frame);
    if (!sprite) return;
    ctx.drawImage(sprite, Math.round(this.x - cam.ox), Math.round(this.y - cam.oy + this.bob));
  }
}

export function createEnemy(spawn) {
  switch (spawn.type) {
    case 'goblin': return new Goblin(spawn.x, spawn.y);
    case 'skeleton': return new Skeleton(spawn.x, spawn.y);
    case 'bat': return new Bat(spawn.x, spawn.y);
    case 'slime': return new Slime(spawn.x, spawn.y);
    case 'imp': return new Imp(spawn.x, spawn.y);
    default: return null;
  }
}

export function createPickup(spawn) {
  if (spawn.type === 'pickup_weapon') {
    // Random weapon pickup
    const weapons = ['fire', 'lightning', 'frost'];
    const type = weapons[Math.floor(Math.random() * weapons.length)];
    return new Pickup(spawn.x, spawn.y, type);
  }
  if (spawn.type === 'pickup_heart') return new Pickup(spawn.x, spawn.y, 'heart');
  if (spawn.type === 'pickup_coin') return new Pickup(spawn.x, spawn.y, 'coin');
  return null;
}
