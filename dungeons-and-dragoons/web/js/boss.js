/**
 * boss.js — Dungeons & Dragoons
 * Boss state machines for Wyrmling, Lich, and Dragon.
 */

import { aabb, tileCollision, TILE } from './engine.js';
import { Sprites } from './sprites.js';
import { Audio } from './audio.js';
import { Projectile } from './entities.js';

class BossBase {
  constructor(x, y, w, h, hp, name) {
    this.x = x; this.y = y;
    this.w = w; this.h = h;
    this.vx = 0; this.vy = 0;
    this.hp = hp; this.maxHp = hp;
    this.name = name;
    this.facing = -1;
    this.dead = false;
    this.dying = false;
    this.dieTime = 0;
    this.invuln = 0;
    this.hitFlash = 0;
    this.animTime = 0;
    this.animFrame = 0;
    this.phase = 0;
    this.attackTimer = 2;
    this.onGround = false;
  }

  get hitbox() { return { x: this.x + 8, y: this.y + 8, w: this.w - 16, h: this.h - 16 }; }

  takeDamage(dmg) {
    if (this.dying || this.invuln > 0) return;
    this.hp -= dmg;
    this.hitFlash = 0.2;
    Audio.play('boss_hit');
    if (this.hp <= 0) this.startDeath();
  }

  startDeath() {
    this.dying = true;
    this.dieTime = 0;
    Audio.play('boss_die');
  }

  updateDeath(dt, particles) {
    this.dieTime += dt;
    if (this.dieTime > 0.5 && Math.random() < 0.5) {
      particles.burst(
        this.x + Math.random() * this.w,
        this.y + Math.random() * this.h,
        5, 200, '#ff8040', 4, 0.5, 0.2
      );
    }
    if (this.dieTime > 2.0) this.dead = true;
  }

  drawBar(ctx, cam, x, y, w, h) {
    ctx.fillStyle = '#400';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#f00';
    ctx.fillRect(x, y, w * (this.hp / this.maxHp), h);
    ctx.fillStyle = '#fa0';
    ctx.fillRect(x, y, w * (this.hp / this.maxHp), 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  }

  drawSprite(ctx, cam, spriteName, frame) {
    const sprite = Sprites.get(spriteName, frame);
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
      ctx.fillStyle = `rgba(255,255,255,${this.hitFlash * 3})`;
      ctx.fillRect(sx, sy, sprite.width, sprite.height);
    }
    ctx.restore();
  }
}

export class Wyrmling extends BossBase {
  constructor(x, y) {
    super(x, y, 80, 64, 20, 'wyrmling');
    this.flyY = y;
    this.phase = 0;
  }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt, particles); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;
    this.phase += dt;

    // Float toward player horizontally
    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;
    this.vx = Math.sign(dx) * 60;
    this.x += this.vx * dt;
    this.y = this.flyY + Math.sin(this.phase * 1.5) * 20;

    // Attack: fire breath
    this.attackTimer -= dt;
    if (this.attackTimer <= 0) {
      this.animFrame = 0;
      this.attacking = true;
      // Spawn fireballs
      for (let i = 0; i < 3; i++) {
        const a = (this.facing > 0 ? 0 : Math.PI) + (i - 1) * 0.2;
        level.projectiles.push(new Projectile(
          this.x + this.w / 2, this.y + this.h / 2,
          Math.cos(a) * 250, Math.sin(a) * 250,
          1, 'proj_enemy_fire', false, false
        ));
      }
      Audio.play('dragon_roar');
      this.attackTimer = 2.5;
      setTimeout(() => { this.attacking = false; }, 500);
    }

    this.animFrame = Math.floor(this.animTime * 6) % 4;
  }
  draw(ctx, cam) {
    const mode = this.dying ? 'idle' : this.attacking ? 'attack' : this.hitFlash > 0 ? 'hurt' : 'idle';
    const name = `boss_wyrmling_${mode}`;
    const f = this.dying ? Math.min(3, Math.floor(this.dieTime * 4)) : this.animFrame;
    this.drawSprite(ctx, cam, name, f);
  }
  drawHealthBar(ctx, cam) {
    this.drawBar(ctx, cam, 280, 20, 400, 16);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('WYRMLING', 290, 16);
  }
  getScore() { return 2000; }
}

export class Lich extends BossBase {
  constructor(x, y) {
    super(x, y, 64, 80, 30, 'lich');
    this.flyY = y;
    this.phase = 0;
    this.teleportTimer = 4;
  }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt, particles); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;
    this.phase += dt;

    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;
    this.x += Math.sign(dx) * 40 * dt;
    this.y = this.flyY + Math.sin(this.phase * 1.2) * 30;

    // Attack: homing orbs
    this.attackTimer -= dt;
    if (this.attackTimer <= 0) {
      this.casting = true;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + this.phase;
        level.projectiles.push(new Projectile(
          this.x + this.w / 2, this.y + this.h / 2,
          Math.cos(a) * 200, Math.sin(a) * 200,
          1, 'proj_boss_orb', false, false
        ));
      }
      Audio.play('dragon_roar');
      this.attackTimer = 2;
      setTimeout(() => { this.casting = false; }, 600);
    }

    // Teleport
    this.teleportTimer -= dt;
    if (this.teleportTimer <= 0) {
      particles.burst(this.x + this.w / 2, this.y + this.h / 2, 20, 150, '#d0a0ff', 4, 0.4);
      this.x = player.x + (Math.random() > 0.5 ? 200 : -200);
      this.flyY = player.y - 60;
      particles.burst(this.x + this.w / 2, this.y + this.h / 2, 20, 150, '#d0a0ff', 4, 0.4);
      this.teleportTimer = 5;
    }

    this.animFrame = Math.floor(this.animTime * 5) % 4;
  }
  draw(ctx, cam) {
    const mode = this.dying ? 'idle' : this.casting ? 'cast' : this.hitFlash > 0 ? 'hurt' : 'idle';
    const name = `boss_lich_${mode}`;
    const f = this.dying ? Math.min(3, Math.floor(this.dieTime * 4)) : this.animFrame;
    this.drawSprite(ctx, cam, name, f);
  }
  drawHealthBar(ctx, cam) {
    this.drawBar(ctx, cam, 280, 20, 400, 16);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('LICH KING', 290, 16);
  }
  getScore() { return 3000; }
}

export class Dragon extends BossBase {
  constructor(x, y) {
    super(x, y, 140, 100, 50, 'dragon');
    this.flyY = y;
    this.phase = 0;
    this.swoopTimer = 3;
  }
  update(dt, level, player, particles) {
    if (this.dying) { this.updateDeath(dt, particles); return; }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    this.animTime += dt;
    this.phase += dt;

    const dx = player.x - this.x;
    this.facing = dx > 0 ? 1 : -1;
    this.x += Math.sign(dx) * 50 * dt;
    this.y = this.flyY + Math.sin(this.phase) * 40;

    // Attack: fire breath spread
    this.attackTimer -= dt;
    if (this.attackTimer <= 0) {
      this.attacking = true;
      for (let i = 0; i < 5; i++) {
        const a = (this.facing > 0 ? 0 : Math.PI) + (i - 2) * 0.15;
        level.projectiles.push(new Projectile(
          this.x + this.w / 2, this.y + this.h / 2,
          Math.cos(a) * 300, Math.sin(a) * 300,
          1, 'proj_enemy_fire', false, false
        ));
      }
      Audio.play('dragon_roar');
      this.attackTimer = 1.8;
      setTimeout(() => { this.attacking = false; }, 500);
    }

    // Swoop attack
    this.swoopTimer -= dt;
    if (this.swoopTimer <= 0) {
      this.flyY = player.y - 80;
      this.swoopTimer = 4;
    }

    this.animFrame = Math.floor(this.animTime * 4) % 4;
  }
  draw(ctx, cam) {
    const mode = this.dying ? 'idle' : this.attacking ? 'attack' : this.hitFlash > 0 ? 'hurt' : 'idle';
    const name = `boss_dragon_${mode}`;
    const f = this.dying ? Math.min(3, Math.floor(this.dieTime * 3)) : this.animFrame;
    this.drawSprite(ctx, cam, name, f);
  }
  drawHealthBar(ctx, cam) {
    this.drawBar(ctx, cam, 200, 20, 560, 18);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px monospace';
    ctx.fillText('ANCIENT DRAGON', 210, 16);
  }
  getScore() { return 5000; }
}

export function createBoss(type, x, y) {
  switch (type) {
    case 'wyrmling': return new Wyrmling(x, y);
    case 'lich': return new Lich(x, y);
    case 'dragon': return new Dragon(x, y);
    default: return null;
  }
}
