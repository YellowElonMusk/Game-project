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

    // Persistent camera target — survives respawn
    this.camTarget = { x: this.playerCat.x, y: this.playerCat.y };
    this.cameras.main.startFollow(this.camTarget, false, 0.15, 0.15);

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
    }

    // Always keep camera target on player (even while dead — holds last position)
    if (this.playerCat.alive) {
      this.camTarget.x = this.playerCat.x;
      this.camTarget.y = this.playerCat.y;
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

    // Snap camera to new spawn point (no slow drift)
    this.camTarget.x = x;
    this.camTarget.y = y;
    this.cameras.main.centerOn(x, y);
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
    const lightColor = Phaser.Display.Color.IntegerToColor(color).brighten(20).color;

    const hx = cat.x;
    const hy = cat.y;
    const hr = cat.headRadius;
    const angle = cat.headAngle;

    // === TAIL (drawn first, behind everything) ===
    // Fluffy layered tail — multiple passes for fur volume
    const tailLen = cat.tailChain.length;
    if (tailLen > 0) {
      // Fluffy outer layer (big soft circles)
      for (let i = tailLen - 1; i >= 0; i--) {
        const seg = cat.tailChain[i];
        const t = 1 - (i / Math.max(tailLen, 1));   // 1 at base, 0 at tip
        const baseR = cat.tailRadius * (0.4 + 0.6 * t);
        const fluffR = baseR + 6 + 3 * Math.sin(this.time.now * 0.004 + i * 0.7);

        g.fillStyle(color, 0.25);
        g.fillCircle(seg.pos.x, seg.pos.y, fluffR + 4);
        g.fillStyle(lightColor, 0.2);
        g.fillCircle(seg.pos.x, seg.pos.y, fluffR + 2);
      }
      // Main tail layer
      for (let i = tailLen - 1; i >= 0; i--) {
        const seg = cat.tailChain[i];
        const t = 1 - (i / Math.max(tailLen, 1));
        const baseR = cat.tailRadius * (0.4 + 0.6 * t);

        g.fillStyle(darkColor, 0.9);
        g.fillCircle(seg.pos.x, seg.pos.y, baseR + 2);
        g.fillStyle(color, 0.95);
        g.fillCircle(seg.pos.x, seg.pos.y, baseR);
      }
      // Fluffy tip tuft
      const tip = cat.tailChain[tailLen - 1];
      const tipR = cat.tailRadius * 0.5;
      for (let j = 0; j < 5; j++) {
        const a = (j / 5) * Math.PI * 2 + this.time.now * 0.003;
        const ox = Math.cos(a) * tipR * 0.6;
        const oy = Math.sin(a) * tipR * 0.6;
        g.fillStyle(color, 0.4);
        g.fillCircle(tip.pos.x + ox, tip.pos.y + oy, tipR + 2);
      }
    }

    // === BODY SEGMENTS (torso) ===
    // Draw back-to-front for proper overlap
    for (let i = cat.bodyChain.length - 1; i >= 0; i--) {
      const seg = cat.bodyChain[i];
      const t = 1 - (i / cat.bodyChain.length); // 1 near head, 0 near tail
      // Belly shape: thicker in the middle, tapers at ends
      const bellyCurve = Math.sin(t * Math.PI);     // peaks at t=0.5
      const radius = cat.bodyRadius * (0.55 + 0.45 * bellyCurve);

      // Outline
      g.fillStyle(darkColor, 1);
      g.fillCircle(seg.pos.x, seg.pos.y, radius + 2);
      // Fill
      g.fillStyle(color, 1);
      g.fillCircle(seg.pos.x, seg.pos.y, radius);

      // Belly highlight on the middle segments
      if (t > 0.25 && t < 0.75) {
        g.fillStyle(lightColor, 0.25);
        // Offset belly highlight slightly perpendicular to body direction
        const bx = seg.pos.x;
        const by = seg.pos.y;
        g.fillCircle(bx, by, radius * 0.6);
      }
    }

    // === LEGS (little stubs on mid-body) ===
    const bodyLen = cat.bodyChain.length;
    if (bodyLen >= 4) {
      // Front legs (segment ~25% from head) and back legs (~75%)
      const frontIdx = Math.floor(bodyLen * 0.2);
      const backIdx  = Math.floor(bodyLen * 0.7);
      const legPairs = [
        { seg: cat.bodyChain[frontIdx], phase: 0 },
        { seg: cat.bodyChain[backIdx],  phase: Math.PI },
      ];
      for (const lp of legPairs) {
        const sx = lp.seg.pos.x;
        const sy = lp.seg.pos.y;
        // Compute body direction at this segment for perpendicular legs
        const legLen = cat.bodyRadius * 0.7;
        const wiggle = Math.sin(this.time.now * 0.012 + lp.phase) * 0.2;
        for (const side of [-1, 1]) {
          const perpAngle = angle + Math.PI / 2 * side + wiggle * side;
          const lx = sx + Math.cos(perpAngle) * legLen;
          const ly = sy + Math.sin(perpAngle) * legLen;
          // Leg
          g.lineStyle(Math.max(3, cat.bodyRadius * 0.3), darkColor, 0.9);
          g.lineBetween(sx, sy, lx, ly);
          // Paw (round tip)
          g.fillStyle(darkColor, 1);
          g.fillCircle(lx, ly, Math.max(2.5, cat.bodyRadius * 0.18));
        }
      }
    }

    // === HEAD ===
    // Head outline
    g.fillStyle(darkColor, 1);
    g.fillCircle(hx, hy, hr + 2);
    // Head fill — slightly oval (wider than tall)
    g.fillStyle(color, 1);
    g.fillCircle(hx, hy, hr);

    // Cheek fluff (wider face)
    for (const side of [-1, 1]) {
      const cx = hx + Math.cos(angle + Math.PI / 2 * side) * hr * 0.55;
      const cy = hy + Math.sin(angle + Math.PI / 2 * side) * hr * 0.55;
      g.fillStyle(color, 1);
      g.fillCircle(cx, cy, hr * 0.5);
      // Lighter cheek puff
      g.fillStyle(lightColor, 0.2);
      g.fillCircle(cx, cy, hr * 0.35);
    }

    // === EARS (big, pointy, prominent) ===
    const earDist = hr * 0.82;
    const earH = hr * 0.85; // tall ears
    const earW = hr * 0.38;
    for (const side of [-1, 1]) {
      // Ear base center — angled back slightly
      const earAngle = angle + Math.PI * 0.5 * side * 0.45 - Math.PI * 0.15;
      const ebx = hx + Math.cos(angle + Math.PI * 0.5 * side * 0.5) * earDist;
      const eby = hy + Math.sin(angle + Math.PI * 0.5 * side * 0.5) * earDist;
      // Ear tip
      const upAngle = angle - Math.PI / 2; // "up" from head
      const tipAngle = upAngle + side * 0.4;
      const tx = ebx + Math.cos(tipAngle) * earH;
      const ty = eby + Math.sin(tipAngle) * earH;
      // Ear base corners
      const perpA = earAngle + Math.PI / 2;
      const b1x = ebx + Math.cos(perpA) * earW;
      const b1y = eby + Math.sin(perpA) * earW;
      const b2x = ebx - Math.cos(perpA) * earW;
      const b2y = eby - Math.sin(perpA) * earW;

      // Outer ear
      g.fillStyle(darkColor, 1);
      g.fillTriangle(b1x, b1y, b2x, b2y, tx, ty);
      // Inner ear (pink)
      const shrink = 0.6;
      const ib1x = ebx + Math.cos(perpA) * earW * shrink;
      const ib1y = eby + Math.sin(perpA) * earW * shrink;
      const ib2x = ebx - Math.cos(perpA) * earW * shrink;
      const ib2y = eby - Math.sin(perpA) * earW * shrink;
      const itx = ebx + (tx - ebx) * 0.8;
      const ity = eby + (ty - eby) * 0.8;
      g.fillStyle(0xffaaaa, 0.7);
      g.fillTriangle(ib1x, ib1y, ib2x, ib2y, itx, ity);
    }

    // === EYES (big, expressive) ===
    const eyeOffset = hr * 0.38;
    const eyeR = hr * 0.26;
    for (const side of [-1, 1]) {
      const ex = hx + Math.cos(angle) * hr * 0.28 + Math.cos(angle + Math.PI / 2) * eyeOffset * side;
      const ey = hy + Math.sin(angle) * hr * 0.28 + Math.sin(angle + Math.PI / 2) * eyeOffset * side;

      // Eye white
      g.fillStyle(0xffffff, 1);
      g.fillCircle(ex, ey, eyeR);
      // Iris (colored ring)
      g.fillStyle(0x66bb66, 0.9);
      g.fillCircle(
        ex + Math.cos(angle) * eyeR * 0.15,
        ey + Math.sin(angle) * eyeR * 0.15,
        eyeR * 0.7
      );
      // Pupil (vertical slit)
      const px = ex + Math.cos(angle) * eyeR * 0.2;
      const py = ey + Math.sin(angle) * eyeR * 0.2;
      const slitH = eyeR * 0.65;
      const slitW = eyeR * 0.22;
      const perpAngle = angle + Math.PI / 2;
      g.fillStyle(0x111111, 1);
      g.fillTriangle(
        px + Math.cos(perpAngle) * slitW, py + Math.sin(perpAngle) * slitW,
        px - Math.cos(perpAngle) * slitW, py - Math.sin(perpAngle) * slitW,
        px + Math.cos(angle - Math.PI / 2) * slitH, py + Math.sin(angle - Math.PI / 2) * slitH,
      );
      g.fillTriangle(
        px + Math.cos(perpAngle) * slitW, py + Math.sin(perpAngle) * slitW,
        px - Math.cos(perpAngle) * slitW, py - Math.sin(perpAngle) * slitW,
        px + Math.cos(angle + Math.PI / 2) * slitH, py + Math.sin(angle + Math.PI / 2) * slitH,
      );
      // Eye shine
      g.fillStyle(0xffffff, 0.8);
      g.fillCircle(ex - Math.cos(angle) * eyeR * 0.15 + Math.cos(angle + Math.PI / 2) * eyeR * 0.1,
                    ey - Math.sin(angle) * eyeR * 0.15 + Math.sin(angle + Math.PI / 2) * eyeR * 0.1,
                    eyeR * 0.2);
    }

    // === NOSE ===
    const nx = hx + Math.cos(angle) * hr * 0.55;
    const ny = hy + Math.sin(angle) * hr * 0.55;
    const nosePerp = angle + Math.PI / 2;
    g.fillStyle(0xff7788, 1);
    g.fillTriangle(
      nx + Math.cos(angle) * 3, ny + Math.sin(angle) * 3,
      nx + Math.cos(nosePerp) * 3, ny + Math.sin(nosePerp) * 3,
      nx - Math.cos(nosePerp) * 3, ny - Math.sin(nosePerp) * 3,
    );

    // === MOUTH (little smile lines) ===
    const mx = nx + Math.cos(angle) * 2;
    const my = ny + Math.sin(angle) * 2;
    g.lineStyle(1.5, darkColor, 0.5);
    for (const side of [-1, 1]) {
      const sa = angle + Math.PI / 2 * side * 0.3 + Math.PI * 0.15 * side;
      g.lineBetween(mx, my, mx + Math.cos(sa) * hr * 0.25, my + Math.sin(sa) * hr * 0.25);
    }

    // === WHISKERS (longer, more visible) ===
    g.lineStyle(1.5, 0xdddddd, 0.6);
    for (const side of [-1, 1]) {
      const wBase = angle + Math.PI / 2 * side;
      const wx = nx + Math.cos(wBase) * 5;
      const wy = ny + Math.sin(wBase) * 5;
      for (let w = -1; w <= 1; w++) {
        const wa = wBase + w * 0.25;
        g.lineBetween(wx, wy, wx + Math.cos(wa) * hr * 1.1, wy + Math.sin(wa) * hr * 1.1);
      }
    }

    // === SURRENDER EFFECT ===
    const surrenderEntry = this.surrenders.find(s => s.cat === cat);
    if (surrenderEntry) {
      const progress = surrenderEntry.frame / SURRENDER_SHRINK_FRAMES;
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
