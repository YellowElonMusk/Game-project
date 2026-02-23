/**
 * BotAI.js — Simple AI controller for bot cats.
 * Bots wander, seek nearby food, and flee from larger cats.
 */

import { v2, v2Dist, v2Sub, v2Norm, v2Add, v2Scale } from './Cat.js';

const WANDER_RADIUS     = 300;
const FOOD_SEEK_RADIUS  = 250;
const FLEE_RADIUS       = 200;
const RETARGET_INTERVAL = 120; // frames

export default class BotAI {
  constructor(cat, worldW, worldH) {
    this.cat    = cat;
    this.worldW = worldW;
    this.worldH = worldH;
    this.target = v2(cat.x, cat.y);
    this.timer  = 0;
    this._pickWanderTarget();
  }

  update(allCats, foodItems) {
    this.timer++;

    // Flee from larger cats nearby
    const threatTarget = this._findThreat(allCats);
    if (threatTarget) {
      // Move away from threat
      const away = v2Norm(v2Sub(this.cat.headPos, threatTarget));
      this.target = v2Add(this.cat.headPos, v2Scale(away, 200));
      this.cat.setBoost(true);
    } else {
      this.cat.setBoost(false);

      // Seek nearby food
      const foodTarget = this._findNearestFood(foodItems);
      if (foodTarget) {
        this.target = v2(foodTarget.x, foodTarget.y);
      } else if (this.timer % RETARGET_INTERVAL === 0) {
        this._pickWanderTarget();
      }
    }

    // Clamp target inside world bounds
    this.target.x = Math.max(50, Math.min(this.worldW - 50, this.target.x));
    this.target.y = Math.max(50, Math.min(this.worldH - 50, this.target.y));

    return this.target;
  }

  _pickWanderTarget() {
    const angle = Math.random() * Math.PI * 2;
    this.target = v2(
      this.cat.x + Math.cos(angle) * WANDER_RADIUS,
      this.cat.y + Math.sin(angle) * WANDER_RADIUS,
    );
  }

  _findNearestFood(foodItems) {
    let closest = null;
    let closestDist = FOOD_SEEK_RADIUS;
    for (const food of foodItems) {
      if (!food.active) continue;
      const d = v2Dist(this.cat.headPos, v2(food.x, food.y));
      if (d < closestDist) {
        closestDist = d;
        closest = food;
      }
    }
    return closest;
  }

  _findThreat(allCats) {
    for (const other of allCats) {
      if (other === this.cat || !other.alive) continue;
      const d = v2Dist(this.cat.headPos, other.headPos);
      if (d < FLEE_RADIUS && other.growthLevel > this.cat.growthLevel + 3) {
        return other.headPos;
      }
    }
    return null;
  }
}
