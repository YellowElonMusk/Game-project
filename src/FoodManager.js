/**
 * FoodManager.js — Handles spawning, rendering, and collecting food items.
 * Food types: 'kibble' (small, common) and 'catnip' (rarer, worth more).
 */

import { v2Dist } from './Cat.js';

const KIBBLE_COLOR   = 0xc8a26e; // tan / dry food
const CATNIP_COLOR   = 0x66cc66; // green
const KIBBLE_RADIUS  = 4;
const CATNIP_RADIUS  = 6;
const INITIAL_FOOD   = 200;
const MAX_FOOD       = 400;
const SPAWN_INTERVAL = 60; // frames between ambient spawns

export default class FoodManager {
  constructor(worldW, worldH) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.items  = [];         // { x, y, type, active, radius, value }
    this.timer  = 0;

    // Seed initial food
    for (let i = 0; i < INITIAL_FOOD; i++) {
      this._spawnRandom();
    }
  }

  /** Spawn food from a dead cat's trail */
  spawnTrail(positions) {
    for (const pos of positions) {
      // Alternate kibble and catnip along the trail
      const type = Math.random() < 0.3 ? 'catnip' : 'kibble';
      this.items.push({
        x: pos.x + (Math.random() - 0.5) * 10,
        y: pos.y + (Math.random() - 0.5) * 10,
        type,
        active: true,
        radius: type === 'catnip' ? CATNIP_RADIUS : KIBBLE_RADIUS,
        value:  type === 'catnip' ? 3 : 1,
      });
    }
  }

  /** Ambient spawning + collection check */
  update(cats) {
    this.timer++;

    // Ambient spawns
    if (this.timer % SPAWN_INTERVAL === 0 && this.activeCount < MAX_FOOD) {
      this._spawnRandom();
    }

    // Check collection: cat head must run into food head-on
    for (const cat of cats) {
      if (!cat.alive) continue;
      for (const food of this.items) {
        if (!food.active) continue;
        const d = v2Dist(cat.headPos, { x: food.x, y: food.y });
        if (d < cat.headRadius + food.radius) {
          food.active = false;
          cat.eat(food.value);
        }
      }
    }

    // Garbage-collect eaten food periodically
    if (this.timer % 300 === 0) {
      this.items = this.items.filter(f => f.active);
    }
  }

  get activeCount() {
    return this.items.filter(f => f.active).length;
  }

  /** Draw all active food items */
  draw(graphics, camera) {
    for (const food of this.items) {
      if (!food.active) continue;

      // Culling: skip if off-screen
      const sx = food.x - camera.scrollX;
      const sy = food.y - camera.scrollY;
      if (sx < -50 || sx > camera.width + 50 || sy < -50 || sy > camera.height + 50) continue;

      const color = food.type === 'catnip' ? CATNIP_COLOR : KIBBLE_COLOR;
      graphics.fillStyle(color, 0.9);
      graphics.fillCircle(food.x, food.y, food.radius);
    }
  }

  _spawnRandom() {
    const margin = 80;
    const type = Math.random() < 0.15 ? 'catnip' : 'kibble';
    this.items.push({
      x: margin + Math.random() * (this.worldW - margin * 2),
      y: margin + Math.random() * (this.worldH - margin * 2),
      type,
      active: true,
      radius: type === 'catnip' ? CATNIP_RADIUS : KIBBLE_RADIUS,
      value:  type === 'catnip' ? 3 : 1,
    });
  }
}

export { KIBBLE_COLOR, CATNIP_COLOR };
