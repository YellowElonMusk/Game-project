/**
 * GameScene.js — Main Phaser 3 scene for Catter.io.
 *
 * Handles: rendering, player input, bot AI, collision,
 *          food, encirclement, laser pointer, stamina HUD.
 */

import Phaser from 'phaser';
import Cat, {
  v2Dist, STAMINA_MAX, SEGMENT_SPACING, HEAD_RADIUS,
} from './Cat.js';
import BotAI from './BotAI.js';
import FoodManager from './FoodManager.js';

// World
const WORLD_W = 3000;
const WORLD_H = 3000;

// Cat palette (for bots)
const CAT_COLORS = [
  0xffaa44, // orange tabby
  0x888888, // grey
  0x222222, // black
  0xffffff, // white
  0xddaa77, // siamese
  0xbb6633, // brown
  0xffcc88, // cream
  0x99aacc, // blue-grey
];

const BOT_COUNT = 7;
const RESPAWN_DELAY = 180; // frames

// Encirclement
const ENCIRCLE_CHECK_INTERVAL = 30; // check every N frames
const SURRENDER_SHRINK_FRAMES = 60;

export default class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  // -----------------------------------------------------------------------
  // Phaser lifecycle
  // -----------------------------------------------------------------------
  create() {
    // World bounds
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);

    // Graphics layers
    this.floorGfx  = this.add.graphics();
    this.foodGfx   = this.add.graphics();
    this.catGfx    = this.add.graphics();
    this.laserGfx  = this.add.graphics();
    this.uiGfx     = this.add.graphics();

    // Dark floor
    this._drawFloor();

    // Food manager
    this.foodManager = new FoodManager(WORLD_W, WORLD_H);

    // Cats array (player + bots)
    this.cats = [];
    this.botAIs = [];
    this.deadQueue = []; // { cat, timer } for respawn

    // Player cat
    this.playerCat = new Cat(WORLD_W / 2, WORLD_H / 2, 0, {
      color: 0xffaa44,
      isPlayer: true,
    });
    this.cats.push(this.playerCat);

    // Bots
    for (let i = 0; i < BOT_COUNT; i++) {
      this._spawnBot(i + 1);
    }

    // Camera follow player
    this.cameras.main.startFollow(
      { x: this.playerCat.x, y: this.playerCat.y },
      false, 0.1, 0.1
    );

    // Input
    this.mouseWorld = { x: this.playerCat.x, y: this.playerCat.y };
    this.input.on('pointermove', (ptr) => {
      this.mouseWorld = {
        x: ptr.worldX,
        y: ptr.worldY,
      };
    });

    // Boost on left click
    this.input.on('pointerdown', () => { this.playerCat.setBoost(true); });
    this.input.on('pointerup',   () => { this.playerCat.setBoost(false); });

    // Encircle check timer
    this.encircleTimer = 0;

    // Surrender animations
    this.surrenders = []; // { cat, frame }

    // Score text (Phaser text on HUD)
    this.scoreText = this.add.text(16, 16, 'Score: 0', {
      fontFamily: 'monospace',
      fontSize: '20px',
      color: '#ffffff',
    }).setScrollFactor(0).setDepth(100);

    this.leaderText = this.add.text(16, 44, '', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#cccccc',
    }).setScrollFactor(0).setDepth(100);

    // Death message
    this.deathText = this.add.text(
      this.cameras.main.width / 2,
      this.cameras.main.height / 2,
      '',
      { fontFamily: 'monospace', fontSize: '32px', color: '#ff4444', align: 'center' }
    ).setScrollFactor(0).setOrigin(0.5).setDepth(101).setAlpha(0);
  }

  update() {
    // --- Update player ---
    if (this.playerCat.alive) {
      this.playerCat.update(this.mouseWorld.x, this.mouseWorld.y);

      // Update camera follow target
      this.cameras.main._follow.x = this.playerCat.x;
      this.cameras.main._follow.y = this.playerCat.y;
    }

    // --- Update bots ---
    for (const ai of this.botAIs) {
      if (!ai.cat.alive) continue;
      const target = ai.update(this.cats, this.foodManager.items);
      ai.cat.update(target.x, target.y);
    }

    // --- Food ---
    this.foodManager.update(this.cats);

    // --- Head-on collisions ---
    this._checkHeadCollisions();

    // --- Encirclement ---
    this.encircleTimer++;
    if (this.encircleTimer >= ENCIRCLE_CHECK_INTERVAL) {
      this.encircleTimer = 0;
      this._checkEncirclements();
    }

    // --- Process surrenders ---
    this._processSurrenders();

    // --- Respawn dead bots ---
    this._processDeadQueue();

    // --- Drawing ---
    this._drawAll();

    // --- HUD ---
    this._drawHUD();
  }

  // -----------------------------------------------------------------------
  // Collision: head-to-body
  // -----------------------------------------------------------------------
  _checkHeadCollisions() {
    for (let i = 0; i < this.cats.length; i++) {
      const a = this.cats[i];
      if (!a.alive) continue;

      for (let j = 0; j < this.cats.length; j++) {
        if (i === j) continue;
        const b = this.cats[j];
        if (!b.alive) continue;

        // Check if cat A's head runs into cat B's body segments
        for (let k = 2; k < b.bodyChain.length; k++) {
          const seg = b.bodyChain[k];
          const d = v2Dist(a.headPos, seg.pos);
          if (d < a.headRadius + b.bodyRadius) {
            // Cat A dies — ran head-first into B's body
            this._killCat(a);
            break;
          }
        }
        if (!a.alive) break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Encirclement
  // -----------------------------------------------------------------------
  _checkEncirclements() {
    for (const encircler of this.cats) {
      if (!encircler.alive) continue;
      if (encircler.allSegments.length < 16) continue;

      for (const victim of this.cats) {
        if (victim === encircler || !victim.alive) continue;

        if (encircler.isEncircling(victim)) {
          // Victim is trapped — trigger surrender
          if (!this.surrenders.find(s => s.cat === victim)) {
            this.surrenders.push({ cat: victim, frame: 0, killer: encircler });
          }
        }
      }
    }
  }

  _processSurrenders() {
    for (let i = this.surrenders.length - 1; i >= 0; i--) {
      const s = this.surrenders[i];
      s.frame++;

      if (s.frame >= SURRENDER_SHRINK_FRAMES) {
        // Victim has surrendered — kill and award score to encircler
        if (s.cat.alive) {
          s.killer.score += s.cat.score + 50;
          this._killCat(s.cat);
        }
        this.surrenders.splice(i, 1);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Death
  // -----------------------------------------------------------------------
  _killCat(cat) {
    const trail = cat.kill();
    this.foodManager.spawnTrail(trail);

    if (cat.isPlayer) {
      this._showDeathMessage();
      // Respawn player after delay
      this.time.delayedCall(3000, () => this._respawnPlayer());
    } else {
      this.deadQueue.push({ cat, timer: RESPAWN_DELAY });
    }
  }

  _showDeathMessage() {
    this.deathText.setText('You got caught!\nRespawning...');
    this.deathText.setAlpha(1);
    this.tweens.add({
      targets: this.deathText,
      alpha: 0,
      delay: 2000,
      duration: 1000,
    });
  }

  _respawnPlayer() {
    const x = 200 + Math.random() * (WORLD_W - 400);
    const y = 200 + Math.random() * (WORLD_H - 400);
    this.playerCat = new Cat(x, y, 0, { color: 0xffaa44, isPlayer: true });
    this.cats[0] = this.playerCat;
  }

  _processDeadQueue() {
    for (let i = this.deadQueue.length - 1; i >= 0; i--) {
      this.deadQueue[i].timer--;
      if (this.deadQueue[i].timer <= 0) {
        const old = this.deadQueue[i].cat;
        // Respawn bot
        const idx = this.cats.indexOf(old);
        if (idx !== -1) {
          const newCat = this._createBotCat(old.id);
          this.cats[idx] = newCat;
          // Replace AI
          const aiIdx = this.botAIs.findIndex(ai => ai.cat === old);
          if (aiIdx !== -1) {
            this.botAIs[aiIdx] = new BotAI(newCat, WORLD_W, WORLD_H);
          }
        }
        this.deadQueue.splice(i, 1);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Spawning
  // -----------------------------------------------------------------------
  _spawnBot(id) {
    const cat = this._createBotCat(id);
    this.cats.push(cat);
    this.botAIs.push(new BotAI(cat, WORLD_W, WORLD_H));
  }

  _createBotCat(id) {
    const x = 200 + Math.random() * (WORLD_W - 400);
    const y = 200 + Math.random() * (WORLD_H - 400);
    const color = CAT_COLORS[id % CAT_COLORS.length];
    return new Cat(x, y, id, { color });
  }

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------
  _drawFloor() {
    this.floorGfx.clear();
    // Dark background
    this.floorGfx.fillStyle(0x111117, 1);
    this.floorGfx.fillRect(0, 0, WORLD_W, WORLD_H);

    // Subtle grid
    this.floorGfx.lineStyle(1, 0x1a1a24, 0.5);
    const step = 60;
    for (let x = 0; x <= WORLD_W; x += step) {
      this.floorGfx.lineBetween(x, 0, x, WORLD_H);
    }
    for (let y = 0; y <= WORLD_H; y += step) {
      this.floorGfx.lineBetween(0, y, WORLD_W, y);
    }

    // Border
    this.floorGfx.lineStyle(3, 0x333344, 1);
    this.floorGfx.strokeRect(0, 0, WORLD_W, WORLD_H);
  }

  _drawAll() {
    this.catGfx.clear();
    this.foodGfx.clear();
    this.laserGfx.clear();

    const cam = this.cameras.main;

    // Food
    this.foodManager.draw(this.foodGfx, cam);

    // Cats
    for (const cat of this.cats) {
      if (!cat.alive) continue;
      this._drawCat(cat);
    }

    // Surrender animations
    for (const s of this.surrenders) {
      this._drawSurrenderEffect(s);
    }

    // Laser pointer (player only)
    if (this.playerCat.alive) {
      this._drawLaser();
    }
  }

  _drawCat(cat) {
    const g = this.catGfx;
    const color = cat.color;
    const darkColor = Phaser.Display.Color.IntegerToColor(color).darken(30).color;

    // --- Tail (draw first, behind body) ---
    for (let i = cat.tailChain.length - 1; i >= 0; i--) {
      const seg = cat.tailChain[i];
      const t = 1 - (i / Math.max(cat.tailChain.length, 1));
      const radius = cat.tailRadius * (0.3 + 0.7 * t);

      // Fluffy tail — slightly transparent, pulsing
      const fluffAlpha = 0.5 + 0.3 * Math.sin(this.time.now * 0.005 + i * 0.5);
      g.fillStyle(color, fluffAlpha);
      g.fillCircle(seg.pos.x, seg.pos.y, radius + 2);
      g.fillStyle(darkColor, 0.8);
      g.fillCircle(seg.pos.x, seg.pos.y, radius);
    }

    // --- Body segments ---
    for (let i = cat.bodyChain.length - 1; i >= 0; i--) {
      const seg = cat.bodyChain[i];
      const t = 1 - (i / cat.bodyChain.length);
      const radius = cat.bodyRadius * (0.6 + 0.4 * t);

      // Outline
      g.fillStyle(darkColor, 1);
      g.fillCircle(seg.pos.x, seg.pos.y, radius + 1);
      // Fill
      g.fillStyle(color, 0.95);
      g.fillCircle(seg.pos.x, seg.pos.y, radius);
    }

    // --- Head ---
    const hx = cat.x;
    const hy = cat.y;
    const hr = cat.headRadius;
    const angle = cat.headAngle;

    // Head circle
    g.fillStyle(color, 1);
    g.fillCircle(hx, hy, hr);

    // Ears
    const earSpread = 0.6;
    const earDist = hr * 0.85;
    const earSize = hr * 0.45;
    for (const side of [-1, 1]) {
      const ea = angle + side * earSpread + Math.PI * 0.5 * side * 0.3;
      const ex = hx + Math.cos(angle - Math.PI / 2 * side * 0.2 + side * 0.3) * earDist;
      const ey = hy + Math.sin(angle - Math.PI / 2 * side * 0.2 + side * 0.3) * earDist;

      // Outer ear
      g.fillStyle(darkColor, 1);
      g.fillTriangle(
        ex + Math.cos(ea - 0.3) * earSize,
        ey + Math.sin(ea - 0.3) * earSize,
        ex + Math.cos(ea + 0.3) * earSize,
        ey + Math.sin(ea + 0.3) * earSize,
        ex + Math.cos(ea) * earSize * 1.6,
        ey + Math.sin(ea) * earSize * 1.6,
      );
      // Inner ear
      g.fillStyle(0xffaaaa, 0.6);
      g.fillTriangle(
        ex + Math.cos(ea - 0.2) * earSize * 0.6,
        ey + Math.sin(ea - 0.2) * earSize * 0.6,
        ex + Math.cos(ea + 0.2) * earSize * 0.6,
        ey + Math.sin(ea + 0.2) * earSize * 0.6,
        ex + Math.cos(ea) * earSize * 1.2,
        ey + Math.sin(ea) * earSize * 1.2,
      );
    }

    // Eyes
    const eyeOffset = hr * 0.35;
    const eyeR = hr * 0.2;
    for (const side of [-1, 1]) {
      const ex = hx + Math.cos(angle) * hr * 0.3 + Math.cos(angle + Math.PI / 2) * eyeOffset * side;
      const ey = hy + Math.sin(angle) * hr * 0.3 + Math.sin(angle + Math.PI / 2) * eyeOffset * side;

      // White
      g.fillStyle(0xffffff, 1);
      g.fillCircle(ex, ey, eyeR);
      // Pupil (slit)
      g.fillStyle(0x111111, 1);
      g.fillCircle(ex + Math.cos(angle) * eyeR * 0.2, ey + Math.sin(angle) * eyeR * 0.2, eyeR * 0.5);
    }

    // Nose
    const nx = hx + Math.cos(angle) * hr * 0.6;
    const ny = hy + Math.sin(angle) * hr * 0.6;
    g.fillStyle(0xff8899, 1);
    g.fillTriangle(
      nx, ny - 2,
      nx - 2.5, ny + 2,
      nx + 2.5, ny + 2,
    );

    // Whiskers
    g.lineStyle(1, 0xcccccc, 0.5);
    for (const side of [-1, 1]) {
      for (let w = -1; w <= 1; w++) {
        const wa = angle + Math.PI / 2 * side + w * 0.15;
        const wx = nx + Math.cos(angle + Math.PI / 2 * side) * 4;
        const wy = ny + Math.sin(angle + Math.PI / 2 * side) * 4;
        g.lineBetween(wx, wy, wx + Math.cos(wa) * hr * 0.8, wy + Math.sin(wa) * hr * 0.8);
      }
    }

    // Surrender shrink effect
    const surrenderEntry = this.surrenders.find(s => s.cat === cat);
    if (surrenderEntry) {
      const progress = surrenderEntry.frame / SURRENDER_SHRINK_FRAMES;
      // Pulsing red ring
      g.lineStyle(3, 0xff0000, 0.5 + 0.5 * Math.sin(progress * Math.PI * 6));
      g.strokeCircle(hx, hy, hr * (2 - progress));
    }
  }

  _drawSurrenderEffect(s) {
    const g = this.catGfx;
    const progress = s.frame / SURRENDER_SHRINK_FRAMES;

    // Spiral effect around trapped cat
    const cat = s.cat;
    if (!cat.alive) return;

    const rings = 3;
    for (let r = 0; r < rings; r++) {
      const a = this.time.now * 0.01 + r * (Math.PI * 2 / rings);
      const radius = cat.headRadius * 3 * (1 - progress * 0.5);
      const rx = cat.x + Math.cos(a) * radius;
      const ry = cat.y + Math.sin(a) * radius;
      g.fillStyle(0xff4444, 0.3 + 0.3 * progress);
      g.fillCircle(rx, ry, 4);
    }
  }

  // -----------------------------------------------------------------------
  // Laser pointer
  // -----------------------------------------------------------------------
  _drawLaser() {
    const g = this.laserGfx;
    const mx = this.mouseWorld.x;
    const my = this.mouseWorld.y;

    // Outer glow (simulated GlowPostFX)
    for (let i = 4; i >= 0; i--) {
      const radius = 4 + i * 3;
      const alpha = 0.05 + (4 - i) * 0.04;
      g.fillStyle(0xff0000, alpha);
      g.fillCircle(mx, my, radius);
    }

    // Core dot
    g.fillStyle(0xff2222, 0.95);
    g.fillCircle(mx, my, 4);

    // Bright center
    g.fillStyle(0xff8888, 1);
    g.fillCircle(mx, my, 2);

    // Pulsing ring
    const pulse = Math.sin(this.time.now * 0.008) * 0.3 + 0.5;
    g.lineStyle(1, 0xff0000, pulse);
    g.strokeCircle(mx, my, 8 + Math.sin(this.time.now * 0.006) * 3);
  }

  // -----------------------------------------------------------------------
  // HUD
  // -----------------------------------------------------------------------
  _drawHUD() {
    this.uiGfx.clear();
    const g = this.uiGfx;
    g.setScrollFactor(0);
    g.setDepth(100);

    const cam = this.cameras.main;

    // Stamina bar
    const barW = 200;
    const barH = 12;
    const barX = cam.width / 2 - barW / 2;
    const barY = cam.height - 40;
    const staminaRatio = this.playerCat.stamina / STAMINA_MAX;

    // Background
    g.fillStyle(0x222222, 0.8);
    g.fillRoundedRect(barX - 2, barY - 2, barW + 4, barH + 4, 4);

    // Fill
    const staminaColor = staminaRatio > 0.3 ? 0x44cc44 : 0xcc4444;
    g.fillStyle(staminaColor, 0.9);
    g.fillRoundedRect(barX, barY, barW * staminaRatio, barH, 3);

    // Label
    if (this.playerCat.boosting) {
      g.fillStyle(0xffff44, 0.9);
      g.fillRoundedRect(barX + barW / 2 - 30, barY - 18, 60, 14, 3);
    }

    // Minimap
    const mmSize = 140;
    const mmX = cam.width - mmSize - 16;
    const mmY = cam.height - mmSize - 16;

    g.fillStyle(0x111117, 0.7);
    g.fillRect(mmX, mmY, mmSize, mmSize);
    g.lineStyle(1, 0x333344, 0.8);
    g.strokeRect(mmX, mmY, mmSize, mmSize);

    const scaleX = mmSize / WORLD_W;
    const scaleY = mmSize / WORLD_H;

    for (const cat of this.cats) {
      if (!cat.alive) continue;
      const cx = mmX + cat.x * scaleX;
      const cy = mmY + cat.y * scaleY;
      const dotColor = cat.isPlayer ? 0x44ff44 : Phaser.Display.Color.IntegerToColor(cat.color).color;
      g.fillStyle(dotColor, 1);
      g.fillCircle(cx, cy, cat.isPlayer ? 3 : 2);
    }

    // Score
    this.scoreText.setText(`Score: ${this.playerCat.score}`);

    // Leaderboard
    const sorted = [...this.cats]
      .filter(c => c.alive)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const lines = sorted.map((c, i) =>
      `${i + 1}. ${c.isPlayer ? 'YOU' : `Cat ${c.id}`}  ${c.score}`
    );
    this.leaderText.setText(lines.join('\n'));
  }
}
