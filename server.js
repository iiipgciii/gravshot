'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const W = 2000, H = 1400;   // world size
const G = 400;
const SHIP_R = 14;
const SIM_DT = 1 / 60;
const MAX_STEPS = 1400;     // enough for slow shots to cross the full world

const WEAPONS = {
  missile:   { speed: 200, explodeR: 35,  damage: 30, color: '#e0e0e0' },
  cluster:   { speed: 170, explodeR: 22,  damage: 18, color: '#ffaa00', splitCount: 5, splitTime: 1.3 },
  nuke:      { speed: 130, explodeR: 120, damage: 75, color: '#ff4040' },
  shotgun:   { speed: 230, explodeR: 20,  damage: 14, color: '#88aaff', count: 5 },
  laser:     { speed: 420, explodeR: 12,  damage: 40, color: '#ff88ff' },
  guided:    { speed: 150, explodeR: 28,  damage: 35, color: '#88ff88', guided: true },
  trishot:   { speed: 185, explodeR: 28,  damage: 22, color: '#ffff44', count: 3, spreadDeg: 14 },
  shockwave: { speed: 165, explodeR: 85,  damage: 20, color: '#aaaaff' },
  tunneler:  { speed: 175, explodeR: 30,  damage: 28, color: '#ff8833', tunnel: true },
  pentashot: { speed: 210, explodeR: 18,  damage: 12, color: '#ff8800', count: 5, spreadDeg: 22 },
  arc:       { speed: 140, explodeR: 40,  damage: 26, color: '#00ffff', chain: true, chainRadius: 130 },
};

const WEAPON_COSTS = {
  missile: 100, shotgun: 220, trishot: 280, cluster: 450,
  laser: 380, guided: 520, shockwave: 600, tunneler: 350, nuke: 1500,
  pentashot: 360, arc: 440,
};
const STARTING_CREDITS = 1500;
const TURN_INCOME      = 500;
const HIT_BONUS        = 200;
const KILL_BONUS       = 600;
const SHIELD_COST      = 350;

const PLAYER_COLORS = ['#00ff88', '#ff4444', '#4488ff', '#ffcc00', '#ff88ff', '#00ccff'];

const QUIPS = [
  "Bombs away! Ha ha ha!",
  "Say hello to my little friend.",
  "Eat plasma, losers!",
  "Math is hard. Explosions aren't.",
  "Target locked. Mercy: optional.",
  "I calculate a 97.3% chance of boom.",
  "This is fine.",
  "Prepare to be atomized!",
  "Suck vacuum.",
  "Physics: ruining your day since the Big Bang.",
  "I didn't need that planet anyway.",
  "Oops. Was that yours?",
  "Fire everything!",
  "Gravity, do your thing.",
  "Let me help you into that crater.",
  "Outstanding maneuver! ...Just kidding.",
  "Totally intentional.",
  "Warning: incoming regret.",
  "Don't worry, it'll only hurt for a nanosecond.",
  "You call THAT a shield?",
  "My calculations are never wrong. Except sometimes.",
  "Cease to exist immediately.",
  "I am become boom.",
  "Have you tried not being in my line of fire?",
  "Orbital mechanics, baby!",
];

const CPU_NAMES = [
  'Mario','Samus','Link','Gordon','Lara','Kratos','Aloy','Joel','Ellie','Snake',
  'Cloud','Tifa','Aerith','Ryu','Chun','Jill','Leon','Raiden','Nathan','Elena',
  'Banjo','Conker','Niko','Arthur','Tommy','Bayonetta','Dante','Isaac','Faith',
  'Rex','Pyra','Shulk','Dunban','Fiora','Marcus','Dom','Vito','Dutch','Kirby',
  'Sephiroth','Geralt','Ciri','V','Jin','Kazuya','Joanna','Cortana','Master',
];
function randomCpuName() { return CPU_NAMES[Math.floor(Math.random() * CPU_NAMES.length)]; }

// ─── Seeded RNG ───────────────────────────────────────────────────────────────
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
}

// ─── Map generation ───────────────────────────────────────────────────────────
function generatePlanets(rng, count) {
  const planets = [];
  let attempts = 0;
  while (planets.length < count && attempts < 600) {
    attempts++;
    const r = 65 + rng() * 95;   // 65–160 radius
    const margin = r + 40;
    const x = margin + rng() * (W - margin * 2);
    const y = margin + rng() * (H - margin * 2);
    let ok = true;
    for (const p of planets) {
      if (Math.hypot(p.x - x, p.y - y) < p.r + r + 55) { ok = false; break; }
    }
    if (ok) {
      const PTYPES = ['rocky','lava','ice','gas','ocean','desert','alien'];
      const type = PTYPES[Math.floor(rng() * PTYPES.length)];
      const planet = { id: planets.length, x, y, r, mass: r * r * 0.4, holes: [], type };
      // Give some larger planets Saturn-like rings
      if (r >= 75 && (type === 'gas' ? rng() < 0.75 : rng() < 0.20)) {
        planet.ring = {
          innerR: r * 1.5,
          outerR: r * 2.1,
          tilt: 0.10 + rng() * 0.14,
          holes: [],
        };
      }
      planets.push(planet);
    }
  }
  return planets;
}

function placeShipOnPlanet(planet, angle) {
  return {
    x: Math.round(planet.x + Math.cos(angle) * (planet.r + SHIP_R + 3)),
    y: Math.round(planet.y + Math.sin(angle) * (planet.r + SHIP_R + 3)),
    planetId: planet.id,
    surfaceAngle: angle,
  };
}

// ─── Physics ──────────────────────────────────────────────────────────────────
function inHole(px, py, holes) {
  return (holes || []).some(h => Math.hypot(h.x - px, h.y - py) <= h.r);
}

function simulateTraj(startX, startY, vx, vy, planets, ships, firerId, opts = {}) {
  const { guided = false, targetId = null, maxSteps = MAX_STEPS, tunnel = false, firerPlanetId = null } = opts;
  let x = startX, y = startY;
  const pts = [{ x, y }];
  let tunnelPlanetId = null; // planet currently being tunneled through
  let tunnelDone = false;    // already passed through one planet

  // Grace set: skip ring collision for any planet whose ring zone contains the start position
  // (covers both the inner gap and the ring band itself), until the shot exits past outerR.
  const ringGracePlanets = new Set();
  for (const p of planets) {
    if (!p.ring) continue;
    if (Math.hypot(p.x - startX, p.y - startY) < p.ring.outerR) ringGracePlanets.add(p.id);
  }

  for (let step = 0; step < maxSteps; step++) {
    // Gravity — tunneler flies straight while boring through a planet
    let ax = 0, ay = 0;
    if (!(tunnel && tunnelPlanetId !== null)) {
      for (const p of planets) {
        const dx = p.x - x, dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 4) continue;
        const d = Math.sqrt(d2);
        const f = G * p.mass / d2;
        ax += f * dx / d; ay += f * dy / d;
      }
    }

    if (guided && targetId !== null) {
      const tgt = ships.find(s => s.id === targetId && s.alive);
      if (tgt) {
        const tgtA = Math.atan2(tgt.y - y, tgt.x - x);
        const curA = Math.atan2(vy, vx);
        let diff = tgtA - curA;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turn = Math.sign(diff) * Math.min(0.05, Math.abs(diff));
        const spd = Math.hypot(vx, vy);
        const na = curA + turn;
        vx = Math.cos(na) * spd; vy = Math.sin(na) * spd;
      }
    }

    vx += ax * SIM_DT; vy += ay * SIM_DT;
    x += vx * SIM_DT; y += vy * SIM_DT;
    pts.push({ x: Math.round(x * 4) / 4, y: Math.round(y * 4) / 4 });

    if (x < -200 || x > W + 200 || y < -200 || y > H + 200) {
      return { pts, hitType: 'oob', hitId: null, hx: x, hy: y, vx, vy };
    }

    // Ring collision (checked before planet surface)
    for (const p of planets) {
      if (!p.ring) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      // Grace: skip ring of home planet until shot clears it
      if (ringGracePlanets.has(p.id)) {
        if (d > p.ring.outerR) ringGracePlanets.delete(p.id);
        continue;
      }
      if (d >= p.ring.innerR && d <= p.ring.outerR && !inHole(x, y, p.ring.holes)) {
        return { pts, hitType: 'ring', hitId: p.id, hx: x, hy: y, vx, vy };
      }
    }

    // Planet surface collision
    for (const p of planets) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (tunnel) {
        if (tunnelPlanetId === p.id) {
          // Exited the tunnel planet?
          if (d > p.r) { tunnelPlanetId = null; tunnelDone = true; }
        } else if (!tunnelDone && tunnelPlanetId === null && d <= p.r && !inHole(x, y, p.holes)) {
          tunnelPlanetId = p.id; // enter first planet
        } else if (tunnelDone && d <= p.r && !inHole(x, y, p.holes)) {
          return { pts, hitType: 'planet', hitId: p.id, hx: x, hy: y, vx, vy };
        }
      } else {
        if (d <= p.r && !inHole(x, y, p.holes)) {
          return { pts, hitType: 'planet', hitId: p.id, hx: x, hy: y, vx, vy };
        }
      }
    }

    for (const s of ships) {
      if (!s.alive) continue;
      if (s.id === firerId && step < 20) continue;
      if (Math.hypot(s.x - x, s.y - y) <= SHIP_R + 4) {
        return { pts, hitType: 'ship', hitId: s.id, hx: x, hy: y, vx, vy };
      }
    }
  }
  return { pts, hitType: 'timeout', hitId: null, hx: x, hy: y, vx, vy };
}

// ─── Weapon firing ────────────────────────────────────────────────────────────
function launchProjectiles(gs, firerId, angle, power, weaponKey) {
  const w = WEAPONS[weaponKey] || WEAPONS.missile;
  const ship = gs.ships.find(s => s.id === firerId);
  const speed = w.speed * (power / 100);
  const trajs = [];

  const fire1 = (ang, spd, wOpts = {}) => {
    const vx = Math.cos(ang) * spd, vy = Math.sin(ang) * spd;
    return simulateTraj(ship.x, ship.y, vx, vy, gs.planets, gs.ships, firerId,
      { ...wOpts, tunnel: !!w.tunnel, firerPlanetId: ship.planetId });
  };

  if ((w.count || 1) > 1) {
    const spread = (w.spreadDeg || 20) * Math.PI / 180;
    const n = w.count;
    for (let i = 0; i < n; i++) {
      const a = angle + (i - (n - 1) / 2) * (spread / Math.max(n - 1, 1));
      trajs.push({ traj: fire1(a, speed), weapon: weaponKey });
    }
  } else if (weaponKey === 'cluster') {
    const splitStep = Math.floor(w.splitTime * 60);
    const main = simulateTraj(ship.x, ship.y, Math.cos(angle) * speed, Math.sin(angle) * speed,
      gs.planets, gs.ships, firerId, { maxSteps: splitStep });
    const sub = [];
    if (main.hitType === 'timeout') {
      const baseA = Math.atan2(main.vy, main.vx);
      const subSpd = Math.hypot(main.vx, main.vy) * 0.65;
      for (let i = 0; i < (w.splitCount || 5); i++) {
        const sa = baseA + (i - 2) * 0.3;
        sub.push(simulateTraj(main.hx, main.hy, Math.cos(sa) * subSpd, Math.sin(sa) * subSpd,
          gs.planets, gs.ships, firerId));
      }
    }
    trajs.push({ traj: main, subTrajs: sub, weapon: 'cluster' });
  } else if (weaponKey === 'guided') {
    const enemies = gs.ships.filter(s => s.alive && s.id !== firerId);
    const targetId = enemies.length > 0 ? enemies[0].id : null;
    trajs.push({ traj: fire1(angle, speed, { guided: true, targetId }), weapon: 'guided' });
  } else {
    trajs.push({ traj: fire1(angle, speed), weapon: weaponKey });
  }
  return trajs;
}

function applyDamage(trajs, gs, firerId) {
  const dmgMap = new Map();
  const creditDrain = new Map(); // self-hit credit penalties
  const explosions = [];
  const shieldBlocks = [];

  const processHit = (traj, w) => {
    const { hitType, hitId, hx, hy } = traj;
    if (hitType === 'oob' || hitType === 'timeout') return; // missed — no effect

    explosions.push({ x: hx, y: hy, r: w.explodeR, color: w.color });

    if (hitType === 'ship' && hitId != null) {
      const victim = gs.ships.find(s => s.id === hitId);
      if (victim?.shield) { victim.shield = false; shieldBlocks.push(hitId); return; }
      dmgMap.set(hitId, (dmgMap.get(hitId) || 0) + w.damage);
      // Self-hit: extra credit drain
      if (hitId === firerId) {
        creditDrain.set(firerId, (creditDrain.get(firerId) || 0) + 450);
      }
      // Arc chain lightning to nearby ships
      if (w.chain && victim) {
        for (const s of gs.ships) {
          if (s.id === hitId || !s.alive) continue;
          const d = Math.hypot(s.x - victim.x, s.y - victim.y);
          if (d < w.chainRadius) {
            if (s.shield) { s.shield = false; shieldBlocks.push(s.id); continue; }
            const chainDmg = Math.ceil(w.damage * 0.5 * (1 - d / w.chainRadius));
            if (chainDmg > 0) dmgMap.set(s.id, (dmgMap.get(s.id) || 0) + chainDmg);
          }
        }
      }
    } else if (hitType === 'ring' && hitId != null) {
      const planet = gs.planets.find(p => p.id === hitId);
      if (planet?.ring) {
        const holeR = Math.min(w.explodeR * 0.65, 30);
        planet.ring.holes.push({ x: hx, y: hy, r: holeR });
      }
      for (const s of gs.ships) {
        if (!s.alive) continue;
        const d = Math.hypot(s.x - hx, s.y - hy);
        if (d < w.explodeR * 0.8) {
          if (s.shield) { s.shield = false; shieldBlocks.push(s.id); continue; }
          const dmg = Math.ceil(w.damage * (1 - d / (w.explodeR * 0.8)) * 0.45);
          if (dmg > 0) dmgMap.set(s.id, (dmgMap.get(s.id) || 0) + dmg);
        }
      }
    } else {
      if (hitType === 'planet' && hitId != null) {
        const planet = gs.planets.find(p => p.id === hitId);
        if (planet) {
          const holeR = Math.min(w.explodeR, planet.r * 0.75);
          planet.holes.push({ x: hx, y: hy, r: holeR });
          const areaFrac = (holeR * holeR) / (planet.r * planet.r);
          planet.mass = Math.max(planet.mass * 0.08, planet.mass * (1 - areaFrac * 0.7));
        }
      }
      for (const s of gs.ships) {
        if (!s.alive) continue;
        const d = Math.hypot(s.x - hx, s.y - hy);
        if (d < w.explodeR) {
          if (s.shield) { s.shield = false; shieldBlocks.push(s.id); continue; }
          const dmg = Math.ceil(w.damage * (1 - d / w.explodeR) * 0.65);
          if (dmg > 0) dmgMap.set(s.id, (dmgMap.get(s.id) || 0) + dmg);
        }
      }
      // Arc chain from impact point
      if (w.chain) {
        for (const s of gs.ships) {
          if (!s.alive) continue;
          const d = Math.hypot(s.x - hx, s.y - hy);
          if (d < w.chainRadius) {
            if (s.shield) { s.shield = false; shieldBlocks.push(s.id); continue; }
            const chainDmg = Math.ceil(w.damage * 0.45 * (1 - d / w.chainRadius));
            if (chainDmg > 0) dmgMap.set(s.id, (dmgMap.get(s.id) || 0) + chainDmg);
          }
        }
      }
    }
  };

  for (const t of trajs) {
    const w = WEAPONS[t.weapon];
    processHit(t.traj, w);
    if (t.subTrajs) t.subTrajs.forEach(st => processHit(st, w));
  }

  const updates = [];
  for (const [id, dmg] of dmgMap) {
    const s = gs.ships.find(sh => sh.id === id);
    if (s) {
      s.health = Math.max(0, s.health - dmg);
      if (s.health === 0) s.alive = false;
      updates.push({ id: s.id, health: s.health, alive: s.alive, x: s.x, y: s.y, shield: s.shield });
    }
  }
  for (const [id, drain] of creditDrain) {
    const s = gs.ships.find(sh => sh.id === id);
    if (s) s.credits = Math.max(0, s.credits - drain);
  }
  for (const id of shieldBlocks) {
    const s = gs.ships.find(sh => sh.id === id);
    if (s) updates.push({ id: s.id, health: s.health, alive: s.alive, x: s.x, y: s.y, shield: s.shield });
  }

  return { explosions, updates };
}

// Slide ships out of craters after planet damage
function resolveShipCraters(gs) {
  const moved = [];
  for (const ship of gs.ships) {
    if (!ship.alive || ship.planetId == null || ship.floating) continue;
    const planet = gs.planets.find(p => p.id === ship.planetId);
    if (!planet || !planet.holes.length) continue;

    // Ship falls if its center is within hole radius + ship radius
    const nearHole = (planet.holes || []).some(h =>
      Math.hypot(h.x - ship.x, h.y - ship.y) <= h.r + SHIP_R
    );
    if (!nearHole) continue;

    const fromX = ship.x, fromY = ship.y;

    // Find nearest safe angle by scanning outward from current surface angle
    let bestAngle = null;
    for (let da = 0.03; da <= Math.PI * 2; da += 0.03) {
      for (const dir of [1, -1]) {
        const testAngle = ship.surfaceAngle + dir * da;
        const tx = planet.x + Math.cos(testAngle) * (planet.r + SHIP_R + 3);
        const ty = planet.y + Math.sin(testAngle) * (planet.r + SHIP_R + 3);
        if (!inHole(tx, ty, planet.holes)) { bestAngle = testAngle; break; }
      }
      if (bestAngle !== null) break;
    }

    if (bestAngle !== null) {
      const fallDist = Math.abs(bestAngle - ship.surfaceAngle) * planet.r;
      ship.surfaceAngle = bestAngle;
      ship.x = Math.round(planet.x + Math.cos(bestAngle) * (planet.r + SHIP_R + 3));
      ship.y = Math.round(planet.y + Math.sin(bestAngle) * (planet.r + SHIP_R + 3));
      const fallDmg = Math.min(35, Math.floor(fallDist * 0.4));
      ship.health = Math.max(0, ship.health - fallDmg);
      if (ship.health === 0) ship.alive = false;
    } else {
      // Planet cratered beyond livable — ship floats away
      ship.floating = true;
      ship.planetId = null;
      ship.vx = Math.cos(ship.surfaceAngle ?? 0) * 60;
      ship.vy = Math.sin(ship.surfaceAngle ?? 0) * 60;
    }
    moved.push({ id: ship.id, health: ship.health, alive: ship.alive,
      x: ship.x, y: ship.y, surfaceAngle: ship.surfaceAngle, shield: ship.shield,
      floating: ship.floating ?? false, planetId: ship.planetId,
      fromX, fromY });
  }
  return moved;
}

// Run gravity physics for floating ships — called at start of each turn
function updateFloatingShips(gs) {
  const floatPaths = [];
  for (const ship of gs.ships) {
    if (!ship.alive || !ship.floating) continue;
    const path = [{ x: ship.x, y: ship.y }];
    let x = ship.x, y = ship.y;
    let vx = ship.vx ?? 0, vy = ship.vy ?? 0;
    let landed = false;

    for (let step = 0; step < 420; step++) {
      let ax = 0, ay = 0;
      for (const p of gs.planets) {
        const dx = p.x - x, dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 4) continue;
        const d = Math.sqrt(d2);
        const f = G * p.mass / d2;
        ax += f * dx / d; ay += f * dy / d;
      }
      vx += ax * SIM_DT; vy += ay * SIM_DT;
      x += vx * SIM_DT; y += vy * SIM_DT;
      if (step % 2 === 0) path.push({ x: Math.round(x * 4) / 4, y: Math.round(y * 4) / 4 });

      // Planet landing check
      for (const p of gs.planets) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= p.r + SHIP_R + 4) {
          const impactAngle = Math.atan2(y - p.y, x - p.x);
          let bestAngle = null;
          for (let da = 0; da <= Math.PI * 2; da += 0.05) {
            for (const dir of [1, -1]) {
              const ta = impactAngle + dir * da;
              const tx = p.x + Math.cos(ta) * (p.r + SHIP_R + 3);
              const ty = p.y + Math.sin(ta) * (p.r + SHIP_R + 3);
              if (!inHole(tx, ty, p.holes)) { bestAngle = ta; break; }
            }
            if (bestAngle !== null) break;
          }
          if (bestAngle !== null) {
            ship.floating = false; ship.vx = 0; ship.vy = 0;
            ship.planetId = p.id;
            ship.surfaceAngle = bestAngle;
            ship.x = Math.round(p.x + Math.cos(bestAngle) * (p.r + SHIP_R + 3));
            ship.y = Math.round(p.y + Math.sin(bestAngle) * (p.r + SHIP_R + 3));
            path.push({ x: ship.x, y: ship.y });
            landed = true;
          }
          break;
        }
      }
      if (landed) break;
      if (x < -600 || x > W + 600 || y < -600 || y > H + 600) break;
    }
    if (!landed) {
      ship.x = Math.round(x); ship.y = Math.round(y);
      ship.vx = vx; ship.vy = vy;
    }
    floatPaths.push({ shipId: ship.id, path, landed,
      x: ship.x, y: ship.y, planetId: ship.planetId,
      surfaceAngle: ship.surfaceAngle, floating: ship.floating });
  }
  return floatPaths;
}

// ─── AI ───────────────────────────────────────────────────────────────────────
function computeAIShot(ship, gs, difficulty) {
  const enemies = gs.ships.filter(s => s.alive && s.id !== ship.id);
  if (!enemies.length) return { angle: 0, power: 50, weapon: 'missile' };

  const priority = ['nuke','guided','shockwave','cluster','laser','trishot','tunneler','shotgun','missile'];
  const aiWeapon = priority.find(w => (WEAPON_COSTS[w] ?? 9999) <= ship.credits) || 'missile';

  const angleSteps = difficulty === 'hard' ? 72 : difficulty === 'medium' ? 48 : 24;
  const powerSteps = difficulty === 'hard' ? [25,40,55,70,85,100] : [35,60,85];

  let best = { angle: 0, power: 50 };
  let bestDist = Infinity;

  for (let i = 0; i < angleSteps; i++) {
    const angle = (i / angleSteps) * Math.PI * 2;
    for (const power of powerSteps) {
      const spd = WEAPONS.missile.speed * (power / 100);
      const traj = simulateTraj(ship.x, ship.y, Math.cos(angle)*spd, Math.sin(angle)*spd,
        gs.planets, gs.ships, ship.id);
      let minD = Infinity;
      for (const pt of traj.pts) {
        for (const e of enemies) {
          const d = Math.hypot(pt.x - e.x, pt.y - e.y);
          if (d < minD) minD = d;
        }
      }
      if (minD < bestDist) { bestDist = minD; best = { angle, power }; }
    }
  }

  const noise = difficulty === 'easy' ? 0.55 : difficulty === 'medium' ? 0.22 : 0.04;
  return {
    angle: best.angle + (Math.random() - 0.5) * noise,
    power: Math.max(10, Math.min(100, best.power + (Math.random()-0.5)*noise*35)),
    weapon: aiWeapon,
  };
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map();
let cpuCounter = 0;

function makeRoomId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function roomPublic(room) {
  return { id: room.id, players: room.players, started: room.started, hostId: room.hostId };
}

function checkWin(room) {
  const alive = room.gameState.ships.filter(s => s.alive);
  if (alive.length <= 1) {
    const winner = alive[0] || null;
    const winPlayer = winner ? room.players.find(p => p.id === winner.id) : null;
    io.to(room.id).emit('game-over', {
      winnerId: winner?.id || null,
      winnerName: winPlayer?.name || 'Nobody',
      winnerColor: winner?.color || '#fff',
    });
    room.started = false;
    clearTimeout(room.aiTimer); clearTimeout(room.turnTimer);
    return true;
  }
  return false;
}

function nextTurn(room) {
  if (!room.started) return;
  const gs = room.gameState;

  let tries = 0;
  do {
    gs.turnIndex = (gs.turnIndex + 1) % gs.turnOrder.length;
    tries++;
  } while (tries <= gs.turnOrder.length &&
    !gs.ships.find(s => s.id === gs.turnOrder[gs.turnIndex])?.alive);

  const currentId = gs.turnOrder[gs.turnIndex];
  const currentPlayer = room.players.find(p => p.id === currentId);
  const currentShip = gs.ships.find(s => s.id === currentId);
  if (currentShip?.alive) currentShip.credits += TURN_INCOME;

  // Simulate floating ships drifting under gravity
  const floatPaths = updateFloatingShips(gs);

  io.to(room.id).emit('turn-start', {
    playerId: currentId,
    playerName: currentPlayer?.name || '?',
    isCpu: !currentPlayer?.isHuman,
    creditUpdates: gs.ships.map(s => ({ id: s.id, credits: s.credits })),
    floatPaths: floatPaths.length > 0 ? floatPaths : undefined,
  });

  if (!currentPlayer?.isHuman) {
    room.aiTimer = setTimeout(() => {
      if (!room.started) return;
      const cpuShip = gs.ships.find(s => s.id === currentId);
      if (!cpuShip?.alive) { nextTurn(room); return; }
      const shot = computeAIShot(cpuShip, gs, currentPlayer.difficulty || 'medium');
      doFire(room, currentId, shot.angle, shot.power, shot.weapon);
    }, 1200 + Math.random() * 800);
  }
}

function doFire(room, firerId, angle, power, weaponKey) {
  if (!room.started) return;
  const gs = room.gameState;
  const ship = gs.ships.find(s => s.id === firerId);
  if (!ship?.alive) return;

  power = Math.max(5, Math.min(100, power));
  if (!WEAPONS[weaponKey]) weaponKey = 'missile';

  const cost = WEAPON_COSTS[weaponKey] ?? 100;
  if (ship.credits < cost) {
    const sorted = Object.entries(WEAPON_COSTS).sort((a, b) => a[1] - b[1]);
    const fallback = sorted.find(([, c]) => c <= ship.credits);
    weaponKey = fallback ? fallback[0] : 'missile';
    ship.credits -= fallback ? fallback[1] : 0;
  } else {
    ship.credits -= cost;
  }

  const quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];
  const trajs = launchProjectiles(gs, firerId, angle, power, weaponKey);
  const { explosions, updates } = applyDamage(trajs, gs, firerId);

  for (const u of updates) {
    ship.credits += u.alive ? HIT_BONUS : KILL_BONUS;
  }

  const slideUpdates = resolveShipCraters(gs);
  const allUpdates = [...updates];
  for (const su of slideUpdates) {
    if (!allUpdates.find(u => u.id === su.id)) allUpdates.push(su);
    else Object.assign(allUpdates.find(u => u.id === su.id), su);
  }

  const payload = {
    firerId, fireAngle: angle, weapon: weaponKey, quip,
    firer: { id: ship.id, name: ship.name, color: ship.color },
    shots: trajs.map(t => ({
      pts: t.traj.pts, hitType: t.traj.hitType,
      hx: Math.round(t.traj.hx), hy: Math.round(t.traj.hy), weapon: t.weapon,
      subShots: t.subTrajs ? t.subTrajs.map(st => ({
        pts: st.pts, hitType: st.hitType, hx: Math.round(st.hx), hy: Math.round(st.hy),
      })) : undefined,
    })),
    explosions,
    shipUpdates: allUpdates,
    planetHoles: gs.planets.map(p => ({ id: p.id, holes: p.holes, mass: p.mass, ring: p.ring })),
    creditUpdates: gs.ships.map(s => ({ id: s.id, credits: s.credits })),
  };

  io.to(room.id).emit('fire-result', payload);

  const animMs = Math.min(12000, trajs[0].traj.pts.length * (1000/60/2) + 2000);
  room.turnTimer = setTimeout(() => { if (room.started && !checkWin(room)) nextTurn(room); }, animMs);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('create-room', ({ name }) => {
    const roomId = makeRoomId();
    const room = {
      id: roomId, hostId: socket.id, started: false,
      players: [{ id: socket.id, name: (name||'Pilot').slice(0,20), isHuman: true }],
      gameState: null, aiTimer: null, turnTimer: null,
    };
    rooms.set(roomId, room);
    socket.join(roomId); socket.data.roomId = roomId;
    socket.emit('room-joined', roomPublic(room));
  });

  socket.on('join-room', ({ roomId, name }) => {
    const rid = (roomId||'').toUpperCase().trim();
    const room = rooms.get(rid);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.started) { socket.emit('error', 'Game in progress'); return; }
    if (room.players.length >= 6) { socket.emit('error', 'Room full'); return; }
    room.players.push({ id: socket.id, name: (name||'Pilot').slice(0,20), isHuman: true });
    socket.join(rid); socket.data.roomId = rid;
    socket.emit('room-joined', roomPublic(room));
    socket.to(rid).emit('room-update', roomPublic(room));
  });

  socket.on('add-cpu', ({ difficulty }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.started || room.players.length >= 6) return;
    const diff = ['easy','medium','hard'].includes(difficulty) ? difficulty : 'medium';
    const cpuName = randomCpuName();
    room.players.push({ id: `cpu_${++cpuCounter}`, name: `${cpuName} (${diff})`,
      isHuman: false, difficulty: diff });
    io.to(room.id).emit('room-update', roomPublic(room));
  });

  socket.on('remove-player', ({ playerId }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.started || playerId === socket.id) return;
    room.players = room.players.filter(p => p.id !== playerId);
    io.to(room.id).emit('room-update', roomPublic(room));
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.started) return;
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }

    const seed = (Math.random() * 0x7fffffff) | 0;
    const rng = makeRng(seed);
    const planetCount = 4 + Math.floor(rng() * 3); // 4–6 planets
    const planets = generatePlanets(rng, planetCount);

    // Place ships on planet surfaces, distributed evenly
    const ships = [];
    const n = room.players.length;
    for (let i = 0; i < n; i++) {
      const planet = planets[i % planets.length];
      const shipsOnPlanet = Math.ceil(n / planets.length);
      const slot = Math.floor(i / planets.length);
      const angle = (slot / shipsOnPlanet) * Math.PI * 2 + (rng() - 0.5) * 0.4;
      const pos = placeShipOnPlanet(planet, angle);
      ships.push({
        id: room.players[i].id,
        name: room.players[i].name,
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        x: pos.x, y: pos.y,
        planetId: pos.planetId,
        surfaceAngle: pos.surfaceAngle,
        health: 100, alive: true,
        credits: STARTING_CREDITS,
        shield: false,
        floating: false, vx: 0, vy: 0,
      });
    }

    room.gameState = { planets, ships, turnOrder: room.players.map(p => p.id), turnIndex: -1 };
    room.started = true;
    io.to(room.id).emit('game-start', { planets, ships, turnOrder: room.gameState.turnOrder });
    nextTurn(room);
  });

  socket.on('fire', ({ angle, power, weapon }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room?.started) return;
    const gs = room.gameState;
    if (gs.turnOrder[gs.turnIndex] !== socket.id) return;
    doFire(room, socket.id, +angle, +power, weapon);
  });

  socket.on('move-fire', ({ angle, power }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room?.started) return;
    const gs = room.gameState;
    if (gs.turnOrder[gs.turnIndex] !== socket.id) return;
    const ship = gs.ships.find(s => s.id === socket.id);
    if (!ship?.alive) return;

    const movePower = Math.max(5, Math.min(100, +power || 55));
    const moveAngle = +angle;
    const spd = 200 * (movePower / 100);
    const vx = Math.cos(moveAngle) * spd, vy = Math.sin(moveAngle) * spd;

    // Simulate trajectory with no ships — move can't collide with others
    const traj = simulateTraj(ship.x, ship.y, vx, vy, gs.planets, [], ship.id,
      { firerPlanetId: ship.planetId });

    if (traj.hitType === 'planet' && traj.hitId !== null) {
      const planet = gs.planets.find(p => p.id === traj.hitId);
      if (planet) {
        const impactAngle = Math.atan2(traj.hy - planet.y, traj.hx - planet.x);
        let bestAngle = impactAngle;
        for (let da = 0; da <= Math.PI * 2; da += 0.05) {
          let found = false;
          for (const dir of [1, -1]) {
            const ta = impactAngle + dir * da;
            const tx = planet.x + Math.cos(ta) * (planet.r + SHIP_R + 3);
            const ty = planet.y + Math.sin(ta) * (planet.r + SHIP_R + 3);
            if (!inHole(tx, ty, planet.holes)) { bestAngle = ta; found = true; break; }
          }
          if (found) break;
        }
        ship.planetId = planet.id;
        ship.surfaceAngle = bestAngle;
        ship.x = Math.round(planet.x + Math.cos(bestAngle) * (planet.r + SHIP_R + 3));
        ship.y = Math.round(planet.y + Math.sin(bestAngle) * (planet.r + SHIP_R + 3));
        ship.floating = false; ship.vx = 0; ship.vy = 0;
      }
    } else if (traj.hitType === 'oob' || traj.hitType === 'timeout') {
      // Ends up floating in space
      ship.floating = true;
      ship.planetId = null;
      ship.x = Math.round(Math.max(-200, Math.min(W + 200, traj.hx)));
      ship.y = Math.round(Math.max(-200, Math.min(H + 200, traj.hy)));
      ship.vx = traj.vx; ship.vy = traj.vy;
    }

    io.to(room.id).emit('move-result', {
      traj: { pts: traj.pts, hitType: traj.hitType,
        hx: Math.round(traj.hx), hy: Math.round(traj.hy) },
      shipUpdates: [{ id: ship.id, health: ship.health, alive: ship.alive,
        x: ship.x, y: ship.y, surfaceAngle: ship.surfaceAngle,
        planetId: ship.planetId, shield: ship.shield,
        floating: ship.floating }],
    });
    const animMs = Math.min(8000, traj.pts.length * (1000 / 60 / 2) + 500);
    setTimeout(() => { if (room.started && !checkWin(room)) nextTurn(room); }, animMs);
  });

  socket.on('defend', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room?.started) return;
    const gs = room.gameState;
    if (gs.turnOrder[gs.turnIndex] !== socket.id) return;
    const ship = gs.ships.find(s => s.id === socket.id);
    if (!ship?.alive) return;
    if (ship.credits < SHIELD_COST) { socket.emit('error', `Need $${SHIELD_COST} for shield`); return; }
    ship.credits -= SHIELD_COST;
    ship.shield = true;
    io.to(room.id).emit('defend-result', {
      shipId: socket.id,
      creditUpdates: gs.ships.map(s => ({ id: s.id, credits: s.credits })),
      shipUpdates: [{ id: ship.id, health: ship.health, alive: ship.alive, shield: ship.shield, x: ship.x, y: ship.y }],
    });
    setTimeout(() => { if (room.started && !checkWin(room)) nextTurn(room); }, 500);
  });

  socket.on('chat', ({ message }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const msg = String(message||'').trim().slice(0,200);
    if (!msg) return;
    io.to(room.id).emit('chat', { name: player?.name||'Guest', message: msg });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.filter(p => p.isHuman).length === 0) {
      clearTimeout(room.aiTimer); clearTimeout(room.turnTimer);
      rooms.delete(roomId); return;
    }
    if (room.hostId === socket.id) {
      const newHost = room.players.find(p => p.isHuman);
      if (newHost) room.hostId = newHost.id;
    }
    if (room.gameState) {
      const s = room.gameState.ships.find(s => s.id === socket.id);
      if (s) { s.alive = false; s.health = 0; }
    }
    io.to(roomId).emit('room-update', roomPublic(room));
    io.to(roomId).emit('player-left', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`GravShot running → http://localhost:${PORT}`));
