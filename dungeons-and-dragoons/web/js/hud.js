/**
 * hud.js — Dungeons & Dragoons
 * HUD, menus, overlays.
 */

import { Sprites } from './sprites.js';
import { WEAPONS, WEAPON_ORDER } from './entities.js';

export class HUD {
  draw(ctx, player, stageName, stageIndex, boss) {
    // Top bar background
    ctx.fillStyle = 'rgba(10,8,20,0.7)';
    ctx.fillRect(0, 0, 960, 40);

    // Hearts
    for (let i = 0; i < player.maxHp; i++) {
      const x = 12 + i * 24;
      const y = 10;
      if (i < player.hp) {
        // filled heart
        ctx.fillStyle = '#ff4060';
        ctx.fillRect(x + 2, y, 4, 2);
        ctx.fillRect(x + 10, y, 4, 2);
        ctx.fillRect(x, y + 2, 16, 4);
        ctx.fillRect(x + 2, y + 6, 12, 3);
        ctx.fillRect(x + 5, y + 9, 6, 2);
        ctx.fillRect(x + 7, y + 11, 2, 1);
        ctx.fillStyle = '#ff80a0';
        ctx.fillRect(x + 2, y + 1, 2, 1);
      } else {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, 16, 14);
      }
    }

    // Lives
    ctx.fillStyle = '#f4c542';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(`x${player.lives}`, 100, 26);

    // Score
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`SCORE ${player.score.toString().padStart(6, '0')}`, 950, 26);
    ctx.textAlign = 'left';

    // Coins
    ctx.fillStyle = '#f4c542';
    ctx.fillText(`$ ${player.coins}`, 780, 26);

    // Weapon
    const w = WEAPONS[player.weapon];
    ctx.fillStyle = '#7fe8ff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(w.name, 140, 26);

    // Stage name
    ctx.fillStyle = '#aaa';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`Stage ${stageIndex + 1}: ${stageName}`, 480, 26);
    ctx.textAlign = 'left';

    // Boss health bar
    if (boss && !boss.dead) {
      boss.drawHealthBar(ctx, null);
    }
  }
}

export function drawMenu(ctx, title, subtitle, options, selected, frame) {
  // Dark overlay
  ctx.fillStyle = 'rgba(10,8,20,0.85)';
  ctx.fillRect(0, 0, 960, 540);

  // Title
  ctx.fillStyle = '#f4c542';
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(title, 480, 150);

  // Subtitle
  ctx.fillStyle = '#7fe8ff';
  ctx.font = '20px monospace';
  ctx.fillText(subtitle, 480, 190);

  // Options
  ctx.font = 'bold 24px monospace';
  for (let i = 0; i < options.length; i++) {
    const y = 280 + i * 50;
    if (i === selected) {
      ctx.fillStyle = '#f4c542';
      const blink = Math.floor(frame / 30) % 2;
      if (blink) ctx.fillText('> ', 380, y);
      ctx.fillText(options[i], 480, y);
    } else {
      ctx.fillStyle = '#888';
      ctx.fillText(options[i], 480, y);
    }
  }
  ctx.textAlign = 'left';
}

export function drawPause(ctx) {
  ctx.fillStyle = 'rgba(10,8,20,0.7)';
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('PAUSED', 480, 270);
  ctx.font = '18px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText('Press ESC to resume', 480, 310);
  ctx.textAlign = 'left';
}

export function drawGameOver(ctx, score) {
  ctx.fillStyle = 'rgba(10,8,20,0.85)';
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#ff4060';
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('GAME OVER', 480, 200);
  ctx.fillStyle = '#fff';
  ctx.font = '24px monospace';
  ctx.fillText(`Final Score: ${score}`, 480, 260);
  ctx.fillStyle = '#aaa';
  ctx.font = '18px monospace';
  ctx.fillText('Press ENTER to return to menu', 480, 320);
  ctx.textAlign = 'left';
}

export function drawStageClear(ctx, stageName, score, frame) {
  ctx.fillStyle = 'rgba(10,8,20,0.8)';
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#f4c542';
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('STAGE CLEAR!', 480, 200);
  ctx.fillStyle = '#7fe8ff';
  ctx.font = '24px monospace';
  ctx.fillText(stageName, 480, 240);
  ctx.fillStyle = '#fff';
  ctx.fillText(`Score: ${score}`, 480, 290);
  if (frame > 120) {
    ctx.fillStyle = '#aaa';
    ctx.font = '18px monospace';
    ctx.fillText('Press ENTER to continue', 480, 350);
  }
  ctx.textAlign = 'left';
}

export function drawVictory(ctx, score) {
  ctx.fillStyle = 'rgba(10,8,20,0.85)';
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#f4c542';
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('VICTORY!', 480, 180);
  ctx.fillStyle = '#7fe8ff';
  ctx.font = '28px monospace';
  ctx.fillText('The dungeon is conquered!', 480, 230);
  ctx.fillStyle = '#fff';
  ctx.font = '24px monospace';
  ctx.fillText(`Final Score: ${score}`, 480, 290);
  ctx.fillStyle = '#aaa';
  ctx.font = '18px monospace';
  ctx.fillText('Press ENTER to return to menu', 480, 360);
  ctx.textAlign = 'left';
}
