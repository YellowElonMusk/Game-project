/**
 * Cat.js — Liquid Cat spine with Verlet Integration,
 * Lennard-Jones segment repulsion, and Steering Behaviors.
 *
 * The cat is composed of:
 *   - A HEAD that steers toward the laser pointer (Seek behavior)
 *   - A BODY chain of Verlet-integrated segments (limited to 3× original count)
 *   - A TAIL chain that can grow indefinitely (slither-style)
 */

// ---------------------------------------------------------------------------
// Vector helpers (lightweight, no dependency)
// ---------------------------------------------------------------------------
function v2(x = 0, y = 0) { return { x, y }; }

function v2Add(a, b)  { return { x: a.x + b.x, y: a.y + b.y }; }
function v2Sub(a, b)  { return { x: a.x - b.x, y: a.y - b.y }; }
function v2Scale(a, s){ return { x: a.x * s, y: a.y * s }; }
function v2Len(a)     { return Math.sqrt(a.x * a.x + a.y * a.y); }
function v2Norm(a) {
  const l = v2Len(a);
  return l > 0.0001 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}
function v2Limit(a, max) {
  const l = v2Len(a);
  if (l > max && l > 0) return v2Scale(a, max / l);
  return { x: a.x, y: a.y };
}
function v2Dist(a, b) { return v2Len(v2Sub(a, b)); }
function v2Lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

// ---------------------------------------------------------------------------
// Verlet point
// ---------------------------------------------------------------------------
class VerletPoint {
  constructor(x, y) {
    this.pos  = v2(x, y);
    this.prev = v2(x, y);
    this.acc  = v2();
  }

  integrate(damping = 0.98) {
    const vel = v2Scale(v2Sub(this.pos, this.prev), damping);
    this.prev = { ...this.pos };
    this.pos  = v2Add(this.pos, v2Add(vel, this.acc));
    this.acc  = v2();
  }

  applyForce(f) {
    this.acc = v2Add(this.acc, f);
  }
}

// ---------------------------------------------------------------------------
// Lennard-Jones potential force between two points
// ---------------------------------------------------------------------------
function lennardJonesForce(a, b, sigma, epsilon = 1.0) {
  const diff = v2Sub(a.pos, b.pos);
  let r = v2Len(diff);
  if (r < 1) r = 1; // prevent division by zero

  const ratio = sigma / r;
  const r6  = ratio ** 6;
  const r12 = r6 * r6;

  // LJ magnitude: 24ε [ 2(σ/r)^12 − (σ/r)^6 ] / r
  const magnitude = 24 * epsilon * (2 * r12 - r6) / r;
  const dir = v2Norm(diff);
  return v2Scale(dir, magnitude);
}

// ---------------------------------------------------------------------------
// Distance constraint (keeps two points at a fixed rest length)
// ---------------------------------------------------------------------------
function constrainDistance(a, b, restLength, stiffness = 0.5) {
  const diff = v2Sub(b.pos, a.pos);
  const dist = v2Len(diff);
  if (dist < 0.0001) return;

  const error  = (dist - restLength) / dist;
  const offset = v2Scale(diff, error * stiffness * 0.5);

  a.pos = v2Add(a.pos, offset);
  b.pos = v2Sub(b.pos, offset);
}

// ---------------------------------------------------------------------------
// Cat class
// ---------------------------------------------------------------------------
const BASE_BODY_SEGMENTS  = 8;
const BASE_TAIL_SEGMENTS  = 6;
const SEGMENT_SPACING     = 14;
const TAIL_SPACING        = 12;
const HEAD_RADIUS         = 18;

// Steering defaults
const DEFAULT_MAX_SPEED  = 5;
const DEFAULT_MAX_FORCE  = 0.25;

// Zoomies multiplier
const ZOOMIES_SPEED_MULT = 2.0;
const ZOOMIES_FORCE_MULT = 2.0;
const STAMINA_MAX        = 100;
const STAMINA_DRAIN      = 0.6;   // per frame while boosting
const STAMINA_REGEN      = 0.25;  // per frame while not boosting

// LJ parameters
const LJ_SIGMA   = SEGMENT_SPACING * 0.9;
const LJ_EPSILON = 0.15;

export default class Cat {
  /**
   * @param {number} x  — spawn X
   * @param {number} y  — spawn Y
   * @param {number} id — unique id (for multiplayer)
   * @param {object} opts — { color, isPlayer }
   */
  constructor(x, y, id = 0, opts = {}) {
    this.id       = id;
    this.alive    = true;
    this.color    = opts.color || 0xffaa44;
    this.isPlayer = opts.isPlayer || false;

    // Growth tracking
    this.growthLevel    = 0;          // how much food eaten
    this.maxBodySegments = BASE_BODY_SEGMENTS * 3;

    // Steering state
    this.velocity  = v2();
    this.maxSpeed  = DEFAULT_MAX_SPEED;
    this.maxForce  = DEFAULT_MAX_FORCE;

    // Zoomies / stamina
    this.stamina   = STAMINA_MAX;
    this.boosting  = false;

    // ----- Build spine -----
    this.headPoint = new VerletPoint(x, y);
    this.bodyChain = [];
    this.tailChain = [];

    for (let i = 0; i < BASE_BODY_SEGMENTS; i++) {
      this.bodyChain.push(
        new VerletPoint(x - (i + 1) * SEGMENT_SPACING, y)
      );
    }
    for (let i = 0; i < BASE_TAIL_SEGMENTS; i++) {
      const lastBody = this.bodyChain[this.bodyChain.length - 1];
      this.tailChain.push(
        new VerletPoint(lastBody.pos.x - (i + 1) * TAIL_SPACING, lastBody.pos.y)
      );
    }

    // Angle used for head drawing
    this.headAngle = 0;

    // Score
    this.score = 0;
  }

  // -----------------------------------------------------------------------
  // Public getters
  // -----------------------------------------------------------------------
  get x() { return this.headPoint.pos.x; }
  get y() { return this.headPoint.pos.y; }
  get headPos() { return this.headPoint.pos; }
  get allSegments() {
    return [this.headPoint, ...this.bodyChain, ...this.tailChain];
  }
  get bodyRadius() {
    // Body thickness scales with growth (capped at 3×)
    const scale = 1 + Math.min(this.growthLevel, this.maxBodySegments - BASE_BODY_SEGMENTS) / (this.maxBodySegments);
    return HEAD_RADIUS * 0.7 * scale;
  }
  get tailRadius() {
    return HEAD_RADIUS * 0.35;
  }
  get headRadius() {
    const scale = 1 + Math.min(this.growthLevel, this.maxBodySegments - BASE_BODY_SEGMENTS) / (this.maxBodySegments);
    return HEAD_RADIUS * scale;
  }

  // -----------------------------------------------------------------------
  // Steering — Seek toward target
  // -----------------------------------------------------------------------
  seek(targetX, targetY) {
    const desired = v2Sub(v2(targetX, targetY), this.headPoint.pos);
    const desNorm = v2Norm(desired);
    const desVel  = v2Scale(desNorm, this.maxSpeed);
    const steer   = v2Sub(desVel, this.velocity);
    return v2Limit(steer, this.maxForce);
  }

  // -----------------------------------------------------------------------
  // Zoomies (boost)
  // -----------------------------------------------------------------------
  setBoost(active) {
    this.boosting = active && this.stamina > 0;
  }

  // -----------------------------------------------------------------------
  // Growth — eat food
  // -----------------------------------------------------------------------
  eat(amount = 1) {
    this.growthLevel += amount;
    this.score += amount * 10;

    // Body can grow up to 3× original
    if (this.bodyChain.length < this.maxBodySegments) {
      const last = this.bodyChain[this.bodyChain.length - 1];
      this.bodyChain.push(new VerletPoint(last.pos.x, last.pos.y));
    }

    // Tail always grows
    const anchor = this.tailChain.length > 0
      ? this.tailChain[this.tailChain.length - 1]
      : this.bodyChain[this.bodyChain.length - 1];
    this.tailChain.push(new VerletPoint(anchor.pos.x, anchor.pos.y));
  }

  // -----------------------------------------------------------------------
  // Main update  (call once per frame)
  // -----------------------------------------------------------------------
  update(targetX, targetY) {
    if (!this.alive) return;

    // --- Boost handling ---
    const speedMult = this.boosting ? ZOOMIES_SPEED_MULT : 1;
    const forceMult = this.boosting ? ZOOMIES_FORCE_MULT : 1;
    this.maxSpeed   = DEFAULT_MAX_SPEED * speedMult;
    this.maxForce   = DEFAULT_MAX_FORCE * forceMult;

    if (this.boosting) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN);
      if (this.stamina <= 0) this.boosting = false;
    } else {
      this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN);
    }

    // --- Optimization: skip heavy work if target is very close ---
    const distToTarget = v2Dist(this.headPoint.pos, v2(targetX, targetY));
    const isMoving = distToTarget > 2;

    // --- Head steering ---
    if (isMoving) {
      const steer = this.seek(targetX, targetY);
      this.velocity = v2Add(this.velocity, steer);
      this.velocity = v2Limit(this.velocity, this.maxSpeed);
      this.headPoint.pos = v2Add(this.headPoint.pos, this.velocity);
    }

    // Compute head angle
    if (v2Len(this.velocity) > 0.1) {
      this.headAngle = Math.atan2(this.velocity.y, this.velocity.x);
    }

    // --- Verlet integration for body ---
    if (isMoving) {
      for (const seg of this.bodyChain) seg.integrate(0.96);
      for (const seg of this.tailChain) seg.integrate(0.94);
    }

    // --- Distance constraints (several iterations for stability) ---
    const iterations = 3;
    for (let iter = 0; iter < iterations; iter++) {
      // Head → first body
      if (this.bodyChain.length > 0) {
        constrainDistance(this.headPoint, this.bodyChain[0], SEGMENT_SPACING, 0.8);
      }
      // Body chain
      for (let i = 0; i < this.bodyChain.length - 1; i++) {
        constrainDistance(this.bodyChain[i], this.bodyChain[i + 1], SEGMENT_SPACING, 0.6);
      }
      // Body → tail
      if (this.tailChain.length > 0 && this.bodyChain.length > 0) {
        constrainDistance(
          this.bodyChain[this.bodyChain.length - 1],
          this.tailChain[0],
          TAIL_SPACING, 0.6
        );
      }
      // Tail chain
      for (let i = 0; i < this.tailChain.length - 1; i++) {
        constrainDistance(this.tailChain[i], this.tailChain[i + 1], TAIL_SPACING, 0.5);
      }
    }

    // --- Lennard-Jones repulsion (body only, skip if not moving) ---
    if (isMoving) {
      this._applyLennardJones();
    }
  }

  // -----------------------------------------------------------------------
  // Lennard-Jones inter-segment repulsion
  // -----------------------------------------------------------------------
  _applyLennardJones() {
    const all = this.bodyChain;
    const len = all.length;

    // Only apply between non-adjacent segments to prevent bunching during turns
    for (let i = 0; i < len; i++) {
      for (let j = i + 2; j < len; j++) {
        const d = v2Dist(all[i].pos, all[j].pos);
        if (d < LJ_SIGMA * 2.5) {
          const f = lennardJonesForce(all[i], all[j], LJ_SIGMA, LJ_EPSILON);
          all[i].applyForce(f);
          all[j].applyForce(v2Scale(f, -1));
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Collision helpers
  // -----------------------------------------------------------------------

  /** Check if a world point hits this cat's head */
  headHitTest(px, py) {
    return v2Dist(this.headPoint.pos, v2(px, py)) < this.headRadius;
  }

  /** Get all body + tail positions (for food trail on death) */
  getTrailPositions() {
    return [
      ...this.bodyChain.map(s => ({ x: s.pos.x, y: s.pos.y })),
      ...this.tailChain.map(s => ({ x: s.pos.x, y: s.pos.y })),
    ];
  }

  /** Kill this cat and return trail positions for food spawning */
  kill() {
    this.alive = false;
    return this.getTrailPositions();
  }

  // -----------------------------------------------------------------------
  // Encirclement detection
  // -----------------------------------------------------------------------

  /**
   * Check if another cat's head is enclosed by this cat's body loop.
   * Uses ray-casting (point-in-polygon) on the spine polyline.
   */
  isEncircling(otherCat) {
    const segments = this.allSegments;
    if (segments.length < 10) return false; // too short to encircle

    // Build polygon from spine
    const poly = segments.map(s => s.pos);

    // Check if head-to-tail gap is small enough to form a loop
    const gapDist = v2Dist(poly[0], poly[poly.length - 1]);
    if (gapDist > SEGMENT_SPACING * 6) return false; // not a closed loop

    return this._pointInPoly(otherCat.headPos, poly);
  }

  _pointInPoly(point, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;

      const intersect = ((yi > point.y) !== (yj > point.y))
        && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
}

export {
  v2, v2Add, v2Sub, v2Scale, v2Len, v2Norm, v2Limit, v2Dist, v2Lerp,
  VerletPoint, constrainDistance, lennardJonesForce,
  BASE_BODY_SEGMENTS, BASE_TAIL_SEGMENTS, SEGMENT_SPACING, TAIL_SPACING,
  HEAD_RADIUS, STAMINA_MAX,
};
