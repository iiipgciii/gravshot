'use strict';

// ─── Constants (must match server) ───────────────────────────────────────────
const VPORT_W = 1000, VPORT_H = 700;   // canvas / viewport size
const W = 2000, H = 1400;              // world size
const G = 400;
const SHIP_R = 14;
const SIM_DT = 1 / 60;
const SHIELD_COST = 350;

const WEAPONS = {
  missile:   { name: 'Missile',   speed: 200, explodeR: 35,  damage: 30, color: '#e0e0e0', icon: '🚀' },
  cluster:   { name: 'Cluster',   speed: 170, explodeR: 22,  damage: 18, color: '#ffaa00', icon: '💥', splitCount: 5, splitTime: 1.3 },
  nuke:      { name: 'Nuke',      speed: 130, explodeR: 120, damage: 75, color: '#ff4040', icon: '☢️' },
  shotgun:   { name: 'Shotgun',   speed: 230, explodeR: 20,  damage: 14, color: '#88aaff', icon: '🔫', count: 5 },
  laser:     { name: 'Laser',     speed: 420, explodeR: 12,  damage: 40, color: '#ff88ff', icon: '⚡' },
  guided:    { name: 'Guided',    speed: 150, explodeR: 28,  damage: 35, color: '#88ff88', icon: '🎯', guided: true },
  trishot:   { name: 'Tri-Shot',  speed: 185, explodeR: 28,  damage: 22, color: '#ffff44', icon: '〽️', count: 3, spreadDeg: 14 },
  shockwave: { name: 'Shockwave', speed: 165, explodeR: 85,  damage: 20, color: '#aaaaff', icon: '🌀' },
  tunneler:  { name: 'Tunneler',  speed: 175, explodeR: 30,  damage: 28, color: '#ff8833', icon: '🔩', tunnel: true },
  pentashot: { name: 'Penta',     speed: 210, explodeR: 18,  damage: 12, color: '#ff8800', icon: '🖐', count: 5, spreadDeg: 22 },
  arc:       { name: 'Arc',       speed: 140, explodeR: 40,  damage: 26, color: '#00ffff', icon: '⚡', chain: true },
};

const PLAYER_COLORS = ['#00ff88', '#ff4444', '#4488ff', '#ffcc00', '#ff88ff', '#00ccff'];

const WEAPON_COSTS = {
  missile: 100, shotgun: 220, trishot: 280, cluster: 450,
  laser: 380, guided: 520, shockwave: 600, tunneler: 350, nuke: 1500,
  pentashot: 360, arc: 440,
};
const STARTING_CREDITS = 1500;
const TURN_INCOME = 500;

// ─── State ────────────────────────────────────────────────────────────────────
const socket = io();
let myId = null;
let myRoomId = null;
let isHost = false;
let gameState = null;
let currentTurnId = null;
let myTurn = false;
let animating = false;
let selectedWeapon = 'missile';
let aimAngle = 0;
let power = 55;
let mouseWorldPos = null;  // world-space mouse position
let pendingUpdates = null;
let pendingPlanetHoles = null;
let touchMode = false;

// Camera (world-space position of viewport center)
let cam = { x: W / 2, y: H / 2 };
let camTarget = { x: W / 2, y: H / 2 };
let zoom = 1.0; // 0.3 (zoomed out) – 2.5 (zoomed in)

// Move mode (aim + fire to launch ship along physics trajectory)
let moveMode = false;

// Active move animation: { shipId, pts, idx }
let activeMoveAnim = null;

// Slide animations: [{ shipId, fromX, fromY, toX, toY, age, maxAge }]
let activeSlideAnims = [];

// Speech bubble
let activeQuip = null; // { text, x, y, age, maxAge, color }

// ─── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
canvas.width = VPORT_W;
canvas.height = VPORT_H;
let stars = [];

function genStars() {
  stars = [];
  for (let i = 0; i < 600; i++) {
    const bright = Math.random() < 0.05;
    stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: bright ? Math.random() * 1.8 + 0.8 : Math.random() * 1.0 + 0.2,
      a: bright ? 0.9 : Math.random() * 0.5 + 0.15,
      twinkle: bright,
    });
  }
}
genStars();

function screenToWorld(sx, sy) {
  return {
    x: (sx - VPORT_W / 2) / zoom + cam.x,
    y: (sy - VPORT_H / 2) / zoom + cam.y,
  };
}

function clampCam(cx, cy) {
  const hw = (VPORT_W / 2) / zoom, hh = (VPORT_H / 2) / zoom;
  return {
    x: Math.max(hw, Math.min(W - hw, cx)),
    y: Math.max(hh, Math.min(H - hh, cy)),
  };
}

// ─── Seeded RNG ───────────────────────────────────────────────────────────────
function seededRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

// ─── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function noiseBuffer(duration) {
  const c = ac();
  const n = Math.ceil(c.sampleRate * duration);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function playExplosion(size = 1) {
  try {
    const c = ac(), t = c.currentTime;
    const dur = Math.min(0.8, 0.25 + size * 0.18);
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(dur + 0.1);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(1200 * size, t);
    filt.frequency.exponentialRampToValueAtTime(55, t + dur);
    const gain = c.createGain();
    gain.gain.setValueAtTime(Math.min(1, 0.5 * size), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt); filt.connect(gain); gain.connect(c.destination);
    src.start(t); src.stop(t + dur + 0.05);
  } catch(_) {}
}

function playFire() {
  try {
    const c = ac(), t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(500, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.18);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t); osc.stop(t + 0.2);
  } catch(_) {}
}

function playNukeFire() {
  try {
    const c = ac(), t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.4);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t); osc.stop(t + 0.4);
  } catch(_) {}
}

function playPing() {
  try {
    const c = ac(), t = c.currentTime;
    [440, 660].forEach((freq, i) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0, t + i * 0.08);
      gain.gain.linearRampToValueAtTime(0.18, t + i * 0.08 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.3);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.35);
    });
  } catch(_) {}
}

function playDeath() {
  playExplosion(3);
  setTimeout(() => playExplosion(1.5), 120);
  setTimeout(() => playExplosion(1.0), 280);
}

function playPlanetHit() {
  try {
    const c = ac(), t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.35);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(250, t);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.55, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(filt); filt.connect(gain); gain.connect(c.destination);
    src.start(t); src.stop(t + 0.4);
  } catch(_) {}
}

function playWeaponFire(weapon) {
  try {
    const c = ac(), t = c.currentTime;
    switch (weapon) {
      case 'nuke': {
        const o = c.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(35, t+0.5);
        const g = c.createGain(); g.gain.setValueAtTime(0.45, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.5);
        o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+0.5); break;
      }
      case 'laser': {
        const o = c.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(200, t+0.08);
        const g = c.createGain(); g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.08);
        o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+0.1); break;
      }
      case 'shockwave': {
        const src = c.createBufferSource(); src.buffer = noiseBuffer(0.25);
        const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 200;
        const g = c.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.25);
        src.connect(filt); filt.connect(g); g.connect(c.destination); src.start(t); src.stop(t+0.28); break;
      }
      case 'tunneler': {
        const src = c.createBufferSource(); src.buffer = noiseBuffer(0.18);
        const filt = c.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = 400; filt.Q.value = 3;
        const g = c.createGain(); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.18);
        src.connect(filt); filt.connect(g); g.connect(c.destination); src.start(t); src.stop(t+0.2); break;
      }
      case 'arc': {
        // Electric crackle
        for (let i = 0; i < 4; i++) {
          const src = c.createBufferSource(); src.buffer = noiseBuffer(0.04);
          const filt = c.createBiquadFilter(); filt.type = 'highpass'; filt.frequency.value = 2000;
          const g = c.createGain(); g.gain.setValueAtTime(0.28, t+i*0.05); g.gain.exponentialRampToValueAtTime(0.001, t+i*0.05+0.04);
          src.connect(filt); filt.connect(g); g.connect(c.destination); src.start(t+i*0.05); src.stop(t+i*0.05+0.06);
        }
        break;
      }
      case 'guided': {
        const o = c.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(660, t); o.frequency.linearRampToValueAtTime(880, t+0.15);
        const g = c.createGain(); g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.15);
        o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+0.17); break;
      }
      case 'cluster': case 'trishot': case 'pentashot': {
        const o = c.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(400, t); o.frequency.exponentialRampToValueAtTime(80, t+0.14);
        const g = c.createGain(); g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.14);
        o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+0.16); break;
      }
      default: // missile, shotgun
        playFire();
    }
  } catch(_) {}
}

function playArcExplosion() {
  try {
    const c = ac(), t = c.currentTime;
    for (let i = 0; i < 5; i++) {
      const src = c.createBufferSource(); src.buffer = noiseBuffer(0.08);
      const filt = c.createBiquadFilter(); filt.type = 'bandpass';
      filt.frequency.value = 1500 + Math.random() * 1500; filt.Q.value = 2;
      const g = c.createGain(); const dt = i * 0.04;
      g.gain.setValueAtTime(0.3, t+dt); g.gain.exponentialRampToValueAtTime(0.001, t+dt+0.08);
      src.connect(filt); filt.connect(g); g.connect(c.destination); src.start(t+dt); src.stop(t+dt+0.1);
    }
  } catch(_) {}
}

function playNukeExplosion() {
  try {
    const c = ac(), t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(1.6);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(140, t);
    filt.frequency.exponentialRampToValueAtTime(28, t + 1.6);
    const gain = c.createGain();
    gain.gain.setValueAtTime(1.0, t);
    gain.gain.linearRampToValueAtTime(0.85, t + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    src.connect(filt); filt.connect(gain); gain.connect(c.destination);
    src.start(t); src.stop(t + 1.7);
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(55, t);
    osc.frequency.exponentialRampToValueAtTime(18, t + 0.6);
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0.7, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(g2); g2.connect(c.destination);
    osc.start(t); osc.stop(t + 0.65);
  } catch(_) {}
}
function playLaserExplosion() {
  try {
    const c = ac(), t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2800, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.14);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.38, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t); osc.stop(t + 0.16);
  } catch(_) {}
}
function playShockwaveExplosion() {
  try {
    const c = ac(), t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.7);
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(320, t);
    filt.frequency.exponentialRampToValueAtTime(55, t + 0.7);
    filt.Q.value = 0.7;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.65, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    src.connect(filt); filt.connect(gain); gain.connect(c.destination);
    src.start(t); src.stop(t + 0.75);
  } catch(_) {}
}
function playTunnelerExit() {
  try {
    const c = ac(), t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.25);
    const filt = c.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.setValueAtTime(900, t);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(filt); filt.connect(gain); gain.connect(c.destination);
    src.start(t); src.stop(t + 0.3);
  } catch(_) {}
}
function playShotgunExplosion() {
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      try {
        const c = ac(), t = c.currentTime;
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(0.09);
        const filt = c.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = 700 + Math.random() * 500;
        const gain = c.createGain();
        gain.gain.setValueAtTime(0.28, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        src.connect(filt); filt.connect(gain); gain.connect(c.destination);
        src.start(t); src.stop(t + 0.1);
      } catch(_) {}
    }, i * 65);
  }
}

// ─── Planet rendering ─────────────────────────────────────────────────────────
const planetCache = new Map(); // id → { canvas, holeCount }

const PLANET_PALETTES = {
  rocky:  { base: ['#5a5050','#3a2a28','#1a1510'], atm: null },
  lava:   { base: ['#ff6620','#bb2200','#340800'], atm: 'rgba(255,80,0,0.28)' },
  ice:    { base: ['#d8eeff','#5599cc','#112255'], atm: 'rgba(160,220,255,0.22)' },
  gas:    { base: ['#e8c060','#b07830','#5a3010'], atm: 'rgba(210,180,100,0.2)' },
  ocean:  { base: ['#00aaff','#0033bb','#001133'], atm: 'rgba(0,160,255,0.22)' },
  desert: { base: ['#cc8833','#7a4422','#221100'], atm: 'rgba(200,150,80,0.15)' },
  alien:  { base: ['#33cc66','#115533','#0e0022'], atm: 'rgba(0,220,100,0.22)' },
};

function buildPlanetCanvas(p) {
  const pad = 18;
  const size = Math.ceil((p.r + pad) * 2);
  const oc = document.createElement('canvas');
  oc.width = size; oc.height = size;
  const oc2 = oc.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const r = p.r;
  const type = p.type || 'rocky';
  const pal = PLANET_PALETTES[type] || PLANET_PALETTES.rocky;
  const rng = seededRng(p.id * 97 + 31);

  oc2.beginPath();
  oc2.arc(cx, cy, r, 0, Math.PI * 2);

  if (type === 'gas') {
    const grad = oc2.createRadialGradient(cx - r*0.25, cy - r*0.25, r*0.05, cx, cy, r);
    grad.addColorStop(0, pal.base[0]);
    grad.addColorStop(0.6, pal.base[1]);
    grad.addColorStop(1, pal.base[2]);
    oc2.fillStyle = grad;
    oc2.fill();
    oc2.save();
    oc2.clip();
    const bandCols = [
      `rgba(240,200,80,0.55)`, `rgba(180,110,50,0.5)`, `rgba(220,160,70,0.45)`,
      `rgba(150,90,40,0.5)`, `rgba(200,140,60,0.4)`, `rgba(120,70,30,0.45)`,
    ];
    let by = cy - r;
    while (by < cy + r) {
      const bh = 7 + rng() * 14;
      oc2.fillStyle = bandCols[Math.floor(rng() * bandCols.length)];
      oc2.fillRect(cx - r, by, r * 2, bh);
      by += bh + rng() * 5;
    }
    const sx = cx + (rng() - 0.5) * r * 0.6;
    const sy = cy + (rng() - 0.5) * r * 0.4;
    const sg = oc2.createRadialGradient(sx, sy, 0, sx, sy, r * 0.15);
    sg.addColorStop(0, 'rgba(255,220,120,0.6)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    oc2.fillStyle = sg;
    oc2.beginPath();
    oc2.ellipse(sx, sy, r * 0.18, r * 0.1, 0, 0, Math.PI * 2);
    oc2.fill();
    oc2.restore();
  } else {
    const grad = oc2.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.04, cx, cy, r);
    grad.addColorStop(0, pal.base[0]);
    grad.addColorStop(0.55, pal.base[1]);
    grad.addColorStop(1, pal.base[2]);
    oc2.fillStyle = grad;
    oc2.fill();
    oc2.save();
    oc2.beginPath();
    oc2.arc(cx, cy, r, 0, Math.PI * 2);
    oc2.clip();

    if (type === 'rocky') {
      for (let i = 0; i < 7; i++) {
        const dx = (rng()-0.5)*r*1.5, dy = (rng()-0.5)*r*1.5;
        const cr = r*(0.05+rng()*0.16);
        oc2.fillStyle = 'rgba(0,0,0,0.28)';
        oc2.beginPath(); oc2.arc(cx+dx, cy+dy, cr, 0, Math.PI*2); oc2.fill();
        oc2.strokeStyle = 'rgba(200,200,200,0.1)'; oc2.lineWidth = 1;
        oc2.stroke();
      }
    } else if (type === 'lava') {
      for (let i = 0; i < 5; i++) {
        const a = rng()*Math.PI*2, len = r*(0.3+rng()*0.5);
        oc2.strokeStyle = `rgba(255,${120+Math.floor(rng()*80)},0,0.8)`;
        oc2.lineWidth = 1.5 + rng()*2;
        oc2.shadowColor = '#ff4400'; oc2.shadowBlur = 6;
        oc2.beginPath();
        oc2.moveTo(cx + Math.cos(a)*r*0.15, cy + Math.sin(a)*r*0.15);
        const mid = a + (rng()-0.5)*0.5;
        oc2.quadraticCurveTo(
          cx + Math.cos(mid)*len*0.5, cy + Math.sin(mid)*len*0.5,
          cx + Math.cos(a)*len, cy + Math.sin(a)*len
        );
        oc2.stroke();
      }
      oc2.shadowBlur = 0;
      for (let i = 0; i < 3; i++) {
        const dx = (rng()-0.5)*r, dy = (rng()-0.5)*r;
        const pg = oc2.createRadialGradient(cx+dx,cy+dy,0,cx+dx,cy+dy,r*0.12);
        pg.addColorStop(0,'rgba(255,180,0,0.7)'); pg.addColorStop(1,'rgba(0,0,0,0)');
        oc2.fillStyle = pg;
        oc2.beginPath(); oc2.arc(cx+dx,cy+dy,r*0.12,0,Math.PI*2); oc2.fill();
      }
    } else if (type === 'ice') {
      for (let i = 0; i < 8; i++) {
        const x1=cx+(rng()-0.5)*r*1.6, y1=cy+(rng()-0.5)*r*1.6;
        const x2=x1+(rng()-0.5)*r*0.7, y2=y1+(rng()-0.5)*r*0.7;
        oc2.strokeStyle = `rgba(180,230,255,${0.3+rng()*0.25})`;
        oc2.lineWidth = 0.8 + rng();
        oc2.beginPath(); oc2.moveTo(x1,y1); oc2.lineTo(x2,y2); oc2.stroke();
      }
      const sh = oc2.createRadialGradient(cx-r*0.35,cy-r*0.35,0,cx-r*0.35,cy-r*0.35,r*0.4);
      sh.addColorStop(0,'rgba(255,255,255,0.5)'); sh.addColorStop(1,'rgba(0,0,0,0)');
      oc2.fillStyle = sh;
      oc2.beginPath(); oc2.arc(cx,cy,r,0,Math.PI*2); oc2.fill();
    } else if (type === 'ocean') {
      for (let i = 0; i < 4; i++) {
        const dx=(rng()-0.5)*r*0.8, dy=(rng()-0.5)*r*0.8, cr=r*(0.08+rng()*0.22);
        oc2.fillStyle = `rgba(0,${120+Math.floor(rng()*60)},60,0.45)`;
        oc2.beginPath(); oc2.arc(cx+dx,cy+dy,cr,0,Math.PI*2); oc2.fill();
      }
      const sh = oc2.createRadialGradient(cx-r*0.3,cy-r*0.3,0,cx-r*0.3,cy-r*0.3,r*0.5);
      sh.addColorStop(0,'rgba(255,255,255,0.35)'); sh.addColorStop(1,'rgba(0,0,0,0)');
      oc2.fillStyle = sh;
      oc2.beginPath(); oc2.arc(cx,cy,r,0,Math.PI*2); oc2.fill();
    } else if (type === 'desert') {
      for (let i = 0; i < 6; i++) {
        const y0 = cy - r*0.8 + i*r*0.28;
        oc2.strokeStyle = `rgba(180,120,60,${0.15+rng()*0.2})`;
        oc2.lineWidth = 2+rng()*3;
        oc2.beginPath();
        oc2.moveTo(cx-r, y0);
        oc2.quadraticCurveTo(cx+(rng()-0.5)*r*0.5, y0+(rng()-0.5)*8, cx+r, y0+(rng()-0.5)*5);
        oc2.stroke();
      }
    } else if (type === 'alien') {
      for (let i = 0; i < 6; i++) {
        const dx=(rng()-0.5)*r, dy=(rng()-0.5)*r, cr=r*(0.04+rng()*0.11);
        oc2.strokeStyle = `rgba(0,${200+Math.floor(rng()*55)},100,0.5)`;
        oc2.lineWidth = 1;
        oc2.beginPath();
        for (let j=0;j<6;j++){
          const a=j*Math.PI/3;
          const px=cx+dx+Math.cos(a)*cr, py=cy+dy+Math.sin(a)*cr;
          j===0 ? oc2.moveTo(px,py) : oc2.lineTo(px,py);
        }
        oc2.closePath(); oc2.stroke();
      }
      for (let i=0;i<3;i++){
        const dx=(rng()-0.5)*r*0.8, dy=(rng()-0.5)*r*0.8;
        const pg = oc2.createRadialGradient(cx+dx,cy+dy,0,cx+dx,cy+dy,r*0.15);
        pg.addColorStop(0,'rgba(0,255,120,0.35)'); pg.addColorStop(1,'rgba(0,0,0,0)');
        oc2.fillStyle = pg;
        oc2.beginPath(); oc2.arc(cx+dx,cy+dy,r*0.15,0,Math.PI*2); oc2.fill();
      }
    }
    oc2.restore();
  }

  // Shadow terminator
  oc2.save();
  oc2.beginPath(); oc2.arc(cx, cy, r, 0, Math.PI*2); oc2.clip();
  const shadow = oc2.createRadialGradient(cx+r*0.4,cy+r*0.45,r*0.15, cx+r*0.65,cy+r*0.65,r*1.1);
  shadow.addColorStop(0,'rgba(0,0,0,0)');
  shadow.addColorStop(0.5,'rgba(0,0,0,0.22)');
  shadow.addColorStop(1,'rgba(0,0,0,0.72)');
  oc2.fillStyle = shadow;
  oc2.fillRect(cx-r-2, cy-r-2, (r+2)*2, (r+2)*2);
  oc2.restore();

  // Atmosphere ring
  if (pal.atm) {
    const ag = oc2.createRadialGradient(cx, cy, r-2, cx, cy, r+8);
    ag.addColorStop(0, pal.atm); ag.addColorStop(1, 'rgba(0,0,0,0)');
    oc2.fillStyle = ag;
    oc2.beginPath(); oc2.arc(cx, cy, r+8, 0, Math.PI*2); oc2.fill();
  }

  // Rings (gas planets sometimes)
  if (type === 'gas' && seededRng(p.id * 7 + 2)() > 0.55) {
    const rng2 = seededRng(p.id * 13 + 99);
    oc2.save();
    oc2.globalAlpha = 0.45;
    for (let ri = 0; ri < 3; ri++) {
      const rr = r * (1.4 + ri * 0.18 + rng2() * 0.1);
      const rh = 4 + rng2() * 5;
      oc2.strokeStyle = `rgba(${180+Math.floor(rng2()*60)},${140+Math.floor(rng2()*50)},80,0.7)`;
      oc2.lineWidth = rh;
      oc2.beginPath();
      oc2.ellipse(cx, cy, rr, rr * 0.28, 0.3, 0, Math.PI * 2);
      oc2.stroke();
    }
    oc2.restore();
  }

  // Punch holes (destination-out)
  const holes = p.holes || [];
  if (holes.length > 0) {
    for (const h of holes) {
      const hx = cx + (h.x - p.x), hy = cy + (h.y - p.y);
      const sg = oc2.createRadialGradient(hx, hy, h.r * 0.4, hx, hy, h.r * 1.8);
      sg.addColorStop(0, 'rgba(0,0,0,0.85)');
      sg.addColorStop(0.35, 'rgba(12,6,2,0.55)');
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      oc2.fillStyle = sg;
      oc2.beginPath(); oc2.arc(hx, hy, h.r * 1.8, 0, Math.PI * 2); oc2.fill();
    }
    oc2.globalCompositeOperation = 'destination-out';
    for (const h of holes) {
      const hx = cx + (h.x - p.x), hy = cy + (h.y - p.y);
      const hg = oc2.createRadialGradient(hx, hy, 0, hx, hy, h.r);
      hg.addColorStop(0, 'rgba(0,0,0,1)');
      hg.addColorStop(0.88, 'rgba(0,0,0,1)');
      hg.addColorStop(1,    'rgba(0,0,0,0)');
      oc2.fillStyle = hg;
      oc2.beginPath(); oc2.arc(hx, hy, h.r, 0, Math.PI * 2); oc2.fill();
    }
    oc2.globalCompositeOperation = 'source-over';
    for (const h of holes) {
      const hx = cx + (h.x - p.x), hy = cy + (h.y - p.y);
      const rimRng = seededRng((Math.round(h.x) * 97) ^ (Math.round(h.y) * 43));
      const frags = 10 + Math.floor(h.r * 0.55);
      for (let i = 0; i < frags; i++) {
        const a = rimRng() * Math.PI * 2;
        const dist = h.r * (0.86 + rimRng() * 0.38);
        const rx = hx + Math.cos(a) * dist, ry = hy + Math.sin(a) * dist;
        const rr = 0.7 + rimRng() * Math.min(3.5, h.r * 0.1);
        const lum = 30 + Math.floor(rimRng() * 55);
        oc2.fillStyle = `rgba(${lum+8},${lum},${lum-12},${0.55 + rimRng() * 0.35})`;
        oc2.beginPath(); oc2.arc(rx, ry, rr, 0, Math.PI * 2); oc2.fill();
      }
      oc2.strokeStyle = 'rgba(8,4,2,0.55)';
      oc2.lineWidth = 1;
      oc2.beginPath(); oc2.arc(hx, hy, h.r * 0.94, 0, Math.PI * 2); oc2.stroke();
    }
  }

  // Saturn-style rings (drawn as tilted ellipses with blow-through holes)
  if (p.ring) {
    const ring = p.ring;
    const tilt = ring.tilt || 0.3;
    // Determine ring color from planet type
    const ringPalette = {
      rocky: '#887766', lava: '#cc6633', ice: '#aaccee',
      gas: '#c0a060', ocean: '#4488bb', desert: '#cc9944', alien: '#44cc66',
    };
    const rc = ringPalette[p.type] || '#887766';
    oc2.save();
    // Draw back half (behind planet)
    for (let pass = 0; pass < 2; pass++) {
      // pass 0 = behind, pass 1 = front (only front half visible over planet)
      const startA = pass === 0 ? Math.PI : 0;
      const endA   = pass === 0 ? Math.PI * 2 : Math.PI;
      const numBands = 3;
      for (let bi = 0; bi < numBands; bi++) {
        const frac = bi / numBands;
        const iR = cx + (ring.innerR + (ring.outerR - ring.innerR) * frac);
        const oR = cx + (ring.innerR + (ring.outerR - ring.innerR) * (frac + 1/numBands));
        // Use clipping to draw only the half-ellipse pass
        oc2.save();
        oc2.beginPath();
        if (pass === 0) oc2.rect(0, cy, size, size); // lower half (behind)
        else oc2.rect(0, 0, size, cy); // upper half (front)
        oc2.clip();
        oc2.globalAlpha = 0.55 - bi * 0.08;
        oc2.strokeStyle = rc;
        oc2.lineWidth = (ring.outerR - ring.innerR) / numBands;
        oc2.beginPath();
        oc2.ellipse(cx, cy, (iR + oR) / 2 - cx, ((iR + oR) / 2 - cx) * tilt, 0, 0, Math.PI * 2);
        oc2.stroke();
        oc2.restore();
      }
    }
    // Punch ring holes (where shots have passed through)
    if (ring.holes.length > 0) {
      oc2.globalCompositeOperation = 'destination-out';
      for (const h of ring.holes) {
        const hx2 = cx + (h.x - p.x), hy2 = cy + (h.y - p.y);
        oc2.fillStyle = 'rgba(0,0,0,1)';
        oc2.beginPath(); oc2.arc(hx2, hy2, h.r, 0, Math.PI * 2); oc2.fill();
      }
      oc2.globalCompositeOperation = 'source-over';
    }
    oc2.restore();
  }

  return { canvas: oc, cx, cy, holeCount: holes.length, ringHoleCount: p.ring?.holes?.length ?? 0 };
}

function getPlanetCanvas(p) {
  const hc = (p.holes || []).length;
  const rhc = (p.ring?.holes || []).length;
  const cached = planetCache.get(p.id);
  if (cached && cached.holeCount === hc && cached.ringHoleCount === rhc) return cached;
  const entry = buildPlanetCanvas(p);
  planetCache.set(p.id, entry);
  return entry;
}

// ─── Ship rendering ───────────────────────────────────────────────────────────
function shadeColor(hex, frac) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 0xff) + 255 * frac));
  const g = Math.max(0, Math.min(255, ((n >> 8)  & 0xff) + 255 * frac));
  const b = Math.max(0, Math.min(255, ((n)       & 0xff) + 255 * frac));
  return `rgb(${r|0},${g|0},${b|0})`;
}

function drawOneShip(sx, sy, facing, color, isCurrentTurn, isAlive, hasShield) {
  const alpha = isAlive ? 1 : 0.22;
  ctx.globalAlpha = alpha;

  if (isCurrentTurn && isAlive) {
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 42);
    glow.addColorStop(0, color + '44');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(sx, sy, 42, 0, Math.PI * 2); ctx.fill();
  }

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(facing);

  // Wings
  const wingColor = shadeColor(color, -0.38);
  ctx.fillStyle = wingColor;
  ctx.beginPath();
  ctx.moveTo(3, -3.5); ctx.lineTo(-1, -12); ctx.lineTo(-7, -13);
  ctx.lineTo(-8, -8); ctx.lineTo(-5, -4.5);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(3, 3.5); ctx.lineTo(-1, 12); ctx.lineTo(-7, 13);
  ctx.lineTo(-8, 8); ctx.lineTo(-5, 4.5);
  ctx.closePath(); ctx.fill();

  // Fuselage
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(14, 0); ctx.lineTo(7, -3.5); ctx.lineTo(-5, -4.5);
  ctx.lineTo(-10, -2.5); ctx.lineTo(-13, 0);
  ctx.lineTo(-10, 2.5); ctx.lineTo(-5, 4.5); ctx.lineTo(7, 3.5);
  ctx.closePath(); ctx.fill();

  // Hull highlight
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(13, 0); ctx.lineTo(7, -3); ctx.lineTo(0, -2); ctx.lineTo(0, 0);
  ctx.closePath(); ctx.fill();

  // Cockpit
  ctx.fillStyle = '#001a44';
  ctx.beginPath(); ctx.ellipse(6, 0, 4.5, 2.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#4499ffaa'; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.fillStyle = 'rgba(150,220,255,0.45)';
  ctx.beginPath(); ctx.ellipse(5, -0.8, 1.8, 1.0, -0.3, 0, Math.PI * 2); ctx.fill();

  // Engine
  ctx.fillStyle = '#333';
  ctx.beginPath(); ctx.arc(-12, 0, 2.5, 0, Math.PI * 2); ctx.fill();
  const egRad = isCurrentTurn && isAlive ? 5 : 3;
  const eg = ctx.createRadialGradient(-12, 0, 0, -12, 0, egRad);
  eg.addColorStop(0, '#ff9900ee'); eg.addColorStop(0.5, '#ff440088'); eg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = eg;
  ctx.beginPath(); ctx.arc(-12, 0, egRad, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
  ctx.globalAlpha = 1;

  // Shield ring (drawn at ship position, outside rotation context)
  if (hasShield && isAlive) {
    const pulse = 0.4 + 0.3 * Math.sin(ticks * 0.18);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#4488ff';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#4488ff';
    ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(sx, sy, SHIP_R + 8, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }
}

// ─── Animation state ──────────────────────────────────────────────────────────
let activeShots = [];
let activeExplosions = [];
let activeParticles = [];
let deathFlash = null;
const ANIM_SPEED = 2;

function emitDebris(x, y, count, baseColor) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const spd = 80 + Math.random() * 220;
    activeParticles.push({
      x, y,
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 40,
      r: 1 + Math.random() * 3.5,
      color: Math.random() < 0.5 ? '#998866' : (baseColor || '#ffbb55'),
      age: 0, maxAge: 28 + Math.floor(Math.random() * 28),
    });
  }
}

function emitWeaponParticles(weapon, x, y) {
  switch (weapon) {
    case 'nuke':
      emitDebris(x, y, 35, '#ff8800');
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, spd = 180 + Math.random() * 380;
        activeParticles.push({ x, y, vx: Math.cos(a)*spd, vy: Math.sin(a)*spd - 120,
          r: 4 + Math.random() * 7, color: Math.random() < 0.5 ? '#ff4400' : '#ffcc00',
          age: 0, maxAge: 55 + Math.floor(Math.random() * 25) });
      }
      break;
    case 'shockwave':
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        activeParticles.push({ x, y, vx: Math.cos(a)*280, vy: Math.sin(a)*280,
          r: 2 + Math.random() * 2, color: '#8888ff', age: 0, maxAge: 18 });
      }
      break;
    case 'laser':
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, spd = 280 + Math.random() * 220;
        activeParticles.push({ x, y, vx: Math.cos(a)*spd, vy: Math.sin(a)*spd,
          r: 1 + Math.random() * 2, color: Math.random() < 0.5 ? '#ff88ff' : '#ffffff',
          age: 0, maxAge: 10 + Math.floor(Math.random() * 8) });
      }
      break;
    case 'tunneler':
      emitDebris(x, y, 16, '#664422');
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2, spd = 90 + Math.random() * 130;
        activeParticles.push({ x, y, vx: Math.cos(a)*spd, vy: Math.sin(a)*spd,
          r: 2 + Math.random() * 3, color: Math.random() < 0.5 ? '#886633' : '#554422',
          age: 0, maxAge: 28 + Math.floor(Math.random() * 18) });
      }
      break;
    default:
      emitDebris(x, y, 20, WEAPONS[weapon]?.color || '#ffbb55');
  }
}

function animStep() {
  if (!animating) return;
  let anyMoving = false;

  for (const shot of activeShots) {
    if (shot.done) continue;
    anyMoving = true;
    const wasInPlanet = shot.inPlanet;
    // Tunneler slows inside solid planet
    const advSpeed = (shot.weapon === 'tunneler' && shot.inPlanet) ? 1 : ANIM_SPEED;
    const newIdx = Math.min(shot.idx + advSpeed, shot.pts.length - 1);
    for (let i = shot.idx; i <= newIdx; i++) shot.trail.push(shot.pts[i]);
    if (shot.trail.length > 50) shot.trail.splice(0, shot.trail.length - 50);
    shot.idx = newIdx;
    shot.curX = shot.pts[newIdx].x;
    shot.curY = shot.pts[newIdx].y;
    shot.inPlanet = shot.planetMask ? (shot.planetMask[newIdx] ?? false) : false;

    // Tunneler dirt effects
    if (shot.weapon === 'tunneler') {
      if (shot.inPlanet && Math.random() < 0.4) {
        activeParticles.push({ x: shot.curX + (Math.random()-0.5)*8, y: shot.curY + (Math.random()-0.5)*8,
          vx: (Math.random()-0.5)*55, vy: (Math.random()-0.5)*55,
          r: 1 + Math.random()*2, color: Math.random()<0.5 ? '#664422':'#886644', age: 0, maxAge: 14 });
      }
      if (wasInPlanet && !shot.inPlanet) { // just exited planet — burst
        for (let i = 0; i < 10; i++) {
          const a = Math.random()*Math.PI*2;
          activeParticles.push({ x: shot.curX, y: shot.curY,
            vx: Math.cos(a)*(110+Math.random()*160), vy: Math.sin(a)*(110+Math.random()*160),
            r: 1.5+Math.random()*2.5, color: '#886633', age: 0, maxAge: 22 });
        }
        playTunnelerExit();
      }
    }

    // Camera follows leading shot
    camTarget = { x: shot.curX, y: shot.curY };

    if (newIdx >= shot.pts.length - 1) {
      shot.done = true;
      // Skip effects for missed shots (out-of-bounds / timeout)
      if (shot.hitType === 'oob' || shot.hitType === 'timeout') {
        // no explosion, no sound — shot quietly disappears
      } else {
      const wdef = WEAPONS[shot.weapon] || WEAPONS.missile;
      activeExplosions.push({ x: shot.hx, y: shot.hy, maxR: wdef.explodeR, age: 0, color: wdef.color, weapon: shot.weapon });
      if (shot.hitType === 'ship') {
        deathFlash = { age: 0, color: wdef.color };
        emitWeaponParticles(shot.weapon, shot.hx, shot.hy);
        if (shot.weapon === 'nuke') playNukeExplosion();
        else if (shot.weapon === 'arc') { playArcExplosion(); setTimeout(() => playArcExplosion(), 80); }
        else playDeath();
      } else if (shot.hitType === 'ring') {
        emitDebris(shot.hx, shot.hy, 14, '#886644');
        playPlanetHit();
        if (pendingPlanetHoles && gameState) {
          for (const ph of pendingPlanetHoles) {
            const planet = gameState.planets.find(p => p.id === ph.id);
            if (planet) {
              planet.holes = ph.holes;
              if (ph.mass !== undefined) planet.mass = ph.mass;
              if (ph.ring !== undefined) planet.ring = ph.ring;
              planetCache.delete(planet.id);
            }
          }
          pendingPlanetHoles = null;
        }
      } else if (shot.hitType === 'planet') {
        emitWeaponParticles(shot.weapon, shot.hx, shot.hy);
        if (shot.weapon === 'nuke') playNukeExplosion(); else playPlanetHit();
        if (pendingPlanetHoles && gameState) {
          for (const ph of pendingPlanetHoles) {
            const planet = gameState.planets.find(p => p.id === ph.id);
            if (planet) {
              planet.holes = ph.holes;
              if (ph.mass !== undefined) planet.mass = ph.mass;
              if (ph.ring !== undefined) planet.ring = ph.ring;
              planetCache.delete(planet.id);
            }
          }
          pendingPlanetHoles = null;
        }
      } else {
        emitWeaponParticles(shot.weapon, shot.hx, shot.hy);
        if (shot.weapon === 'nuke') playNukeExplosion();
        else if (shot.weapon === 'laser') playLaserExplosion();
        else if (shot.weapon === 'shockwave') playShockwaveExplosion();
        else if (shot.weapon === 'arc') playArcExplosion();
        else playExplosion(0.5);
      }
      } // end hitType check
      if (shot.subShots) {
        for (const ss of shot.subShots) {
          activeShots.push({ pts: ss.pts, idx: 0, trail: [], curX: ss.pts[0]?.x, curY: ss.pts[0]?.y,
            hx: ss.hx, hy: ss.hy, hitType: ss.hitType, weapon: 'cluster', done: false, subShots: null,
            planetMask: null, inPlanet: false });
        }
      }
    }
  }

  for (const ex of activeExplosions) ex.age++;
  activeExplosions = activeExplosions.filter(ex => ex.age < 38);

  for (const p of activeParticles) {
    p.x += p.vx * SIM_DT; p.y += p.vy * SIM_DT;
    p.vy += 120 * SIM_DT;
    p.age++;
  }
  activeParticles = activeParticles.filter(p => p.age < p.maxAge);

  if (!anyMoving && activeExplosions.length === 0 && !activeShots.some(s => !s.done)) {
    animating = false;
    if (pendingPlanetHoles && gameState) {
      for (const ph of pendingPlanetHoles) {
        const planet = gameState.planets.find(p => p.id === ph.id);
        if (planet) {
          planet.holes = ph.holes;
          if (ph.mass !== undefined) planet.mass = ph.mass;
          if (ph.ring !== undefined) planet.ring = ph.ring;
          planetCache.delete(planet.id);
        }
      }
      pendingPlanetHoles = null;
    }
    if (pendingUpdates) { applyShipUpdates(pendingUpdates); pendingUpdates = null; }
  }

  setTimeout(animStep, 1000 / 60);
}

function applyShipUpdates(updates) {
  if (!gameState) return;
  for (const u of updates) {
    const s = gameState.ships.find(sh => sh.id === u.id);
    if (s) {
      s.health = u.health;
      s.alive = u.alive;
      if (u.floating !== undefined) s.floating = u.floating;
      if (u.planetId !== undefined) s.planetId = u.planetId;
      // Slide animation when ship is displaced by crater fall
      if (u.fromX !== undefined && u.fromY !== undefined && u.x !== undefined &&
          (Math.abs(u.fromX - u.x) > 2 || Math.abs(u.fromY - u.y) > 2)) {
        activeSlideAnims.push({ shipId: u.id, fromX: u.fromX, fromY: u.fromY,
          toX: u.x, toY: u.y, age: 0, maxAge: 22 });
      }
      if (u.x !== undefined) s.x = u.x;
      if (u.y !== undefined) s.y = u.y;
      if (u.surfaceAngle !== undefined) s.surfaceAngle = u.surfaceAngle;
      if (u.shield !== undefined) s.shield = u.shield;
    }
  }
  updateHealthBars();
}

// ─── Preview trajectory ───────────────────────────────────────────────────────
function previewTraj(shipX, shipY, angle) {
  if (!gameState) return [];
  const w = WEAPONS[selectedWeapon] || WEAPONS.missile;
  const spd = w.speed * (power / 100);
  let x = shipX, y = shipY;
  let vx = Math.cos(angle) * spd, vy = Math.sin(angle) * spd;
  const pts = [];

  for (let i = 0; i < 600; i++) {
    for (const p of gameState.planets) {
      const dx = p.x - x, dy = p.y - y;
      const d2 = dx*dx + dy*dy;
      if (d2 < 4) continue;
      const d = Math.sqrt(d2), f = G * p.mass / d2;
      vx += f*(dx/d)*SIM_DT; vy += f*(dy/d)*SIM_DT;
    }
    x += vx*SIM_DT; y += vy*SIM_DT;
    if (x<-200||x>W+200||y<-200||y>H+200) break;
    // Tunneler passes through planets
    if (!w.tunnel) {
      let hit = false;
      for (const p of gameState.planets) {
        if (Math.hypot(p.x-x, p.y-y) < p.r) {
          const inHole = (p.holes||[]).some(h => Math.hypot(h.x-x,h.y-y)<=h.r);
          if (!inHole) { hit = true; break; }
        }
      }
      if (hit) { pts.push({x,y}); break; }
    }
    if (i % 3 === 0) pts.push({x,y});
  }
  return pts;
}

// ─── Rendering ────────────────────────────────────────────────────────────────
let ticks = 0;

function drawStars() {
  ticks++;
  for (const s of stars) {
    let a = s.a;
    if (s.twinkle) a *= 0.7 + 0.3 * Math.sin(ticks * 0.04 + s.x);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPlanets() {
  if (!gameState) return;
  for (const p of gameState.planets) {
    const { canvas: pc, cx, cy } = getPlanetCanvas(p);
    ctx.drawImage(pc, p.x - cx, p.y - cy);
  }
}

function drawShips() {
  if (!gameState) return;

  // Advance slide animations
  for (const sl of activeSlideAnims) sl.age++;
  activeSlideAnims = activeSlideAnims.filter(sl => sl.age < sl.maxAge);

  for (const s of gameState.ships) {
    // Determine draw position (slide anim overrides, then move anim)
    let drawX = s.x, drawY = s.y;
    const slideAnim = activeSlideAnims.find(sl => sl.shipId === s.id && sl.age < sl.maxAge);
    if (slideAnim) {
      const t = slideAnim.age / slideAnim.maxAge;
      drawX = slideAnim.fromX + (slideAnim.toX - slideAnim.fromX) * t;
      drawY = slideAnim.fromY + (slideAnim.toY - slideAnim.fromY) * t;
    }
    if (activeMoveAnim && activeMoveAnim.shipId === s.id) {
      const pt = activeMoveAnim.pts[activeMoveAnim.idx];
      if (pt) { drawX = pt.x; drawY = pt.y; }
    }

    // Ships face outward from their planet surface; aim angle overrides for active player
    const baseFacing = s.surfaceAngle ?? 0;
    const isCurrentTurn = s.id === currentTurnId;
    // Floating ships slowly spin
    const floatFacing = s.floating ? (ticks * 0.025) : baseFacing;
    const displayFacing = (isCurrentTurn && myTurn && !moveMode) ? aimAngle : floatFacing;
    drawOneShip(drawX, drawY, displayFacing, s.color, isCurrentTurn, s.alive, s.shield);

    // Floating ships get a drift-glow indicator
    if (s.floating && s.alive) {
      ctx.save();
      ctx.globalAlpha = 0.3 + 0.2 * Math.sin(ticks * 0.07);
      ctx.strokeStyle = '#ffcc44';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(drawX, drawY, SHIP_R + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.globalAlpha = s.alive ? 1 : 0.3;
    ctx.fillStyle = s.color;
    ctx.font = 'bold 10px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(s.name, drawX, drawY - SHIP_R - 14);
    if (s.alive) {
      const bw = 38, bh = 5;
      const bx = drawX - bw/2, by = drawY - SHIP_R - 10;
      ctx.fillStyle = '#111';
      ctx.fillRect(bx, by, bw, bh);
      const pct = s.health / 100;
      ctx.fillStyle = pct > 0.5 ? '#00ff88' : pct > 0.25 ? '#ffcc00' : '#ff4444';
      ctx.fillRect(bx, by, bw * pct, bh);
    } else {
      ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(drawX-7,drawY-7); ctx.lineTo(drawX+7,drawY+7);
      ctx.moveTo(drawX+7,drawY-7); ctx.lineTo(drawX-7,drawY+7);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawAim() {
  if (!myTurn || !gameState || animating || moveMode) return;
  const myShip = gameState.ships.find(s => s.id === myId);
  if (!myShip?.alive) return;

  if (mouseWorldPos) aimAngle = Math.atan2(mouseWorldPos.y - myShip.y, mouseWorldPos.x - myShip.x);

  const prev = previewTraj(myShip.x, myShip.y, aimAngle);
  if (prev.length > 0) {
    ctx.save();
    for (let i = 0; i < prev.length; i++) {
      const t = i / prev.length;
      ctx.globalAlpha = (1 - t) * 0.6;
      ctx.fillStyle = WEAPONS[selectedWeapon]?.color || '#fff';
      ctx.beginPath();
      ctx.arc(prev[i].x, prev[i].y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawProjectiles() {
  for (const shot of activeShots) {
    if (shot.done) continue;

    // Tunneler inside a planet: dim dirt rendering, no trail
    if (shot.weapon === 'tunneler' && shot.inPlanet) {
      if (shot.curX !== undefined) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#553311';
        ctx.shadowColor = '#331100'; ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.arc(shot.curX, shot.curY, 2, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
      continue;
    }

    const col = WEAPONS[shot.weapon]?.color || '#fff';

    // Arc weapon: jagged lightning trail
    if (shot.weapon === 'arc') {
      ctx.save();
      const trailLen = Math.min(shot.trail.length, 25);
      const start = shot.trail.length - trailLen;
      if (trailLen >= 2) {
        ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 1.5;
        ctx.shadowColor = '#00ffff'; ctx.shadowBlur = 10; ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(shot.trail[start].x, shot.trail[start].y);
        for (let i = start + 1; i < shot.trail.length; i++) {
          ctx.lineTo(shot.trail[i].x + (Math.random()-0.5)*5, shot.trail[i].y + (Math.random()-0.5)*5);
        }
        ctx.stroke();
      }
      if (shot.curX !== undefined) {
        ctx.shadowBlur = 18; ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(shot.curX, shot.curY, 3, 0, Math.PI*2); ctx.fill();
        // Spark arms
        for (let i = 0; i < 4; i++) {
          const a = Math.random()*Math.PI*2, len = 4 + Math.random()*8;
          ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(shot.curX, shot.curY);
          ctx.lineTo(shot.curX + Math.cos(a)*len, shot.curY + Math.sin(a)*len);
          ctx.stroke();
        }
      }
      ctx.restore();
      continue;
    }

    const trailLen = Math.min(shot.trail.length, 40);
    ctx.save();
    for (let i = shot.trail.length - trailLen; i < shot.trail.length; i++) {
      const t = (i - (shot.trail.length - trailLen)) / trailLen;
      ctx.globalAlpha = t * 0.75;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(shot.trail[i].x, shot.trail[i].y, 1.3 + t * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (shot.curX !== undefined) {
      ctx.shadowColor = col; ctx.shadowBlur = 10;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(shot.curX, shot.curY, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

function drawExplosions() {
  for (const ex of activeExplosions) {
    const t = ex.age / 38;
    const alpha = Math.max(0, 1 - t);
    const r = ex.maxR * Math.min(1, ex.age / 7);
    ctx.save();

    if (ex.weapon === 'nuke') {
      // White flash in first 12 frames
      if (ex.age < 12) {
        ctx.globalAlpha = (1 - ex.age / 12) * 0.82;
        const fg = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, ex.maxR * 1.9);
        fg.addColorStop(0, 'rgba(255,255,220,1)');
        fg.addColorStop(0.18, 'rgba(255,210,80,0.85)');
        fg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = fg;
        ctx.beginPath(); ctx.arc(ex.x, ex.y, ex.maxR * 1.9, 0, Math.PI * 2); ctx.fill();
      }
      // Fireball
      const fb = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);
      fb.addColorStop(0, `rgba(255,210,60,${alpha * 0.95})`);
      fb.addColorStop(0.45, `rgba(255,80,0,${alpha * 0.75})`);
      fb.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fb; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.fill();
      // Radiation ring
      ctx.globalAlpha = alpha * 0.65;
      ctx.strokeStyle = '#ff4400'; ctx.lineWidth = 3;
      ctx.shadowColor = '#ff4400'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r * 1.12, 0, Math.PI * 2); ctx.stroke();
      // Outer shock ring
      const outerR = ex.maxR * 1.6 * Math.min(1, ex.age / 14);
      ctx.globalAlpha = alpha * 0.28; ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffaa44'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, outerR, 0, Math.PI * 2); ctx.stroke();

    } else if (ex.weapon === 'shockwave') {
      for (let i = 0; i < 5; i++) {
        const ri = r * (1 - i * 0.16);
        if (ri <= 0) continue;
        ctx.globalAlpha = alpha * (0.6 - i * 0.1);
        ctx.strokeStyle = i === 0 ? '#ccccff' : '#6666cc';
        ctx.lineWidth = 2.5 - i * 0.4;
        ctx.beginPath(); ctx.arc(ex.x, ex.y, ri, 0, Math.PI * 2); ctx.stroke();
      }
      const sg = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);
      sg.addColorStop(0, `rgba(100,100,255,${alpha * 0.35})`);
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.fill();

    } else if (ex.weapon === 'arc') {
      // Electric discharge burst
      ctx.globalAlpha = alpha;
      ctx.shadowColor = '#00ffff'; ctx.shadowBlur = 22;
      ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 2 - t * 1.5;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r * 0.5, 0, Math.PI * 2); ctx.stroke();
      // Jagged arms radiating outward (re-seeded per explosion for consistency)
      const numArms = 6;
      for (let i = 0; i < numArms; i++) {
        const a = (i / numArms) * Math.PI * 2 + ex.age * 0.4;
        const armLen = r * (0.6 + Math.sin(ex.age * 0.7 + i) * 0.3);
        ctx.globalAlpha = alpha * 0.7;
        ctx.strokeStyle = i % 2 === 0 ? '#00ffff' : '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ex.x, ex.y);
        const mx = ex.x + Math.cos(a + 0.3) * armLen * 0.5;
        const my = ex.y + Math.sin(a + 0.3) * armLen * 0.5;
        ctx.lineTo(mx, my);
        ctx.lineTo(ex.x + Math.cos(a) * armLen, ex.y + Math.sin(a) * armLen);
        ctx.stroke();
      }
      const ag = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);
      ag.addColorStop(0, `rgba(100,255,255,${alpha * 0.5})`);
      ag.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ag; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.fill();

    } else if (ex.weapon === 'laser') {
      ctx.globalAlpha = alpha;
      ctx.shadowColor = '#ff88ff'; ctx.shadowBlur = 28;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(0.5, 3.5 - t * 3.5);
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r * 0.45, 0, Math.PI * 2); ctx.stroke();
      const lg = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);
      lg.addColorStop(0, `rgba(255,255,255,${alpha * 0.9})`);
      lg.addColorStop(0.28, `rgba(255,100,255,${alpha * 0.65})`);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lg; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.fill();

    } else if (ex.weapon === 'tunneler') {
      ctx.globalAlpha = alpha * 0.72;
      ctx.strokeStyle = '#996633'; ctx.lineWidth = 2.5 - t * 2;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.stroke();
      const tg = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);
      tg.addColorStop(0, `rgba(160,100,40,${alpha * 0.6})`);
      tg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = tg; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.fill();

    } else {
      // Standard: missile, cluster, guided, trishot, shotgun
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = ex.color; ctx.lineWidth = 3 - t * 2.5;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.stroke();
      const grd = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);
      grd.addColorStop(0, ex.color + 'aa'); grd.addColorStop(0.4, ex.color + '44'); grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd; ctx.globalAlpha = alpha * 0.65;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();
  }
}

function drawParticles() {
  for (const p of activeParticles) {
    const t = p.age / p.maxAge;
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 - t * 0.5), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawQuip() {
  if (!activeQuip) return;
  activeQuip.age++;
  if (activeQuip.age > activeQuip.maxAge) { activeQuip = null; return; }
  const t = activeQuip.age / activeQuip.maxAge;
  const alpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
  const floatY = activeQuip.y - SHIP_R - 30 - activeQuip.age * 0.25;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = 'bold 11px Courier New';
  const tw = ctx.measureText(activeQuip.text).width;
  const pad = 7;
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(activeQuip.x - tw/2 - pad, floatY - 14, tw + pad*2, 20);
  ctx.strokeStyle = activeQuip.color;
  ctx.lineWidth = 1;
  ctx.strokeRect(activeQuip.x - tw/2 - pad, floatY - 14, tw + pad*2, 20);
  ctx.fillStyle = activeQuip.color;
  ctx.textAlign = 'center';
  ctx.fillText(activeQuip.text, activeQuip.x, floatY);
  ctx.restore();
}

// ─── Screen-space overlays ────────────────────────────────────────────────────
function drawDeathFlash() {
  if (!deathFlash) return;
  const alpha = Math.max(0, 0.35 - deathFlash.age * 0.018);
  ctx.fillStyle = deathFlash.color;
  ctx.globalAlpha = alpha;
  ctx.fillRect(0, 0, VPORT_W, VPORT_H);
  ctx.globalAlpha = 1;
  deathFlash.age++;
  if (deathFlash.age > 20) deathFlash = null;
}

function drawMinimap() {
  if (!gameState) return;
  const mw = 180, mh = 126;
  const mx = VPORT_W - mw - 8, my = 8;
  const scaleX = mw / W, scaleY = mh / H;

  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = '#050510';
  ctx.fillRect(mx, my, mw, mh);
  ctx.strokeStyle = '#2a2a55';
  ctx.lineWidth = 1;
  ctx.strokeRect(mx, my, mw, mh);

  for (const p of gameState.planets) {
    const px = mx + p.x * scaleX, py = my + p.y * scaleY;
    const pr = Math.max(2.5, p.r * scaleX);
    ctx.fillStyle = '#446688';
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
  }

  for (const s of gameState.ships) {
    if (!s.alive) continue;
    const sx = mx + s.x * scaleX, sy = my + s.y * scaleY;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill();
    if (s.id === currentTurnId) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  for (const shot of activeShots) {
    if (shot.done || shot.curX === undefined) continue;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(mx + shot.curX * scaleX, my + shot.curY * scaleY, 2, 0, Math.PI * 2); ctx.fill();
  }

  // Viewport rect (accounts for zoom)
  const visW = VPORT_W / zoom, visH = VPORT_H / zoom;
  const vx = mx + (cam.x - visW / 2) * scaleX;
  const vy = my + (cam.y - visH / 2) * scaleY;
  const vw = visW * scaleX, vh = visH * scaleY;
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(vx, vy, vw, vh);

  ctx.restore();
}

function render() {
  // Camera lerp + clamp
  const clamped = clampCam(
    cam.x + (camTarget.x - cam.x) * 0.1,
    cam.y + (camTarget.y - cam.y) * 0.1,
  );
  cam.x = clamped.x; cam.y = clamped.y;

  ctx.fillStyle = '#050510';
  ctx.fillRect(0, 0, VPORT_W, VPORT_H);

  // World-space rendering (camera + zoom)
  ctx.save();
  ctx.translate(VPORT_W / 2, VPORT_H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-cam.x, -cam.y);
  drawStars();
  drawPlanets();
  if (moveMode) drawMovePlanetHighlights();
  drawShips();
  drawAim();
  drawProjectiles();
  drawExplosions();
  drawParticles();
  drawQuip();
  ctx.restore();

  // Screen-space overlays
  drawDeathFlash();
  drawMinimap();
  // Watermark
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#8899ff';
  ctx.font = 'bold 20px Courier New';
  ctx.textAlign = 'left';
  ctx.fillText('GRAVSHOT', 10, VPORT_H - 22);
  ctx.globalAlpha = 0.18;
  ctx.font = '10px Courier New';
  ctx.fillText('v1.4', 10, VPORT_H - 8);
  ctx.restore();

  requestAnimationFrame(render);
}

function drawMovePlanetHighlights() {
  // Move mode now uses aim+fire trajectory — no planet highlights needed
  // Draw a ship-silhouette preview along the aim trajectory
  if (!gameState || !myTurn) return;
  const myShip = gameState.ships.find(s => s.id === myId);
  if (!myShip?.alive) return;
  const prev = previewTraj(myShip.x, myShip.y, aimAngle);
  if (prev.length > 0) {
    ctx.save();
    for (let i = 0; i < prev.length; i++) {
      const t = i / prev.length;
      ctx.globalAlpha = (1 - t) * 0.45;
      ctx.fillStyle = '#ffcc44';
      ctx.beginPath();
      ctx.arc(prev[i].x, prev[i].y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────
function screenCoordsFromEvent(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (VPORT_W / rect.width),
    y: (clientY - rect.top)  * (VPORT_H / rect.height),
  };
}

// Minimap constants (must match drawMinimap)
const MM_W = 180, MM_H = 126, MM_X = VPORT_W - 180 - 8, MM_Y = 8;

function tryMinimapClick(sx, sy) {
  if (sx < MM_X || sx > MM_X + MM_W || sy < MM_Y || sy > MM_Y + MM_H) return false;
  const wx = ((sx - MM_X) / MM_W) * W, wy = ((sy - MM_Y) / MM_H) * H;
  const c = clampCam(wx, wy);
  cam.x = c.x; cam.y = c.y; camTarget = { x: c.x, y: c.y };
  return true;
}

// ── Mouse ──────────────────────────────────────────────────────────────────────
// mousemove/mouseup are on DOCUMENT so drag works even when mouse leaves canvas.
let dragStart = null;
let didDrag = false;
const DRAG_THRESH = 4;

canvas.oncontextmenu = e => { e.preventDefault(); return false; };

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return; // left-click only; right-click stays for context menu noop
  dragStart = { clientX: e.clientX, clientY: e.clientY, camX: cam.x, camY: cam.y };
  didDrag = false;
  e.preventDefault();
});

// Hover aim — canvas only, no drag in progress
canvas.addEventListener('mousemove', e => {
  if (dragStart) return; // handled by document listener below
  if (!touchMode && myTurn && !animating) {
    const sc = screenCoordsFromEvent(e.clientX, e.clientY);
    mouseWorldPos = screenToWorld(sc.x, sc.y);
    const me = gameState?.ships.find(s => s.id === myId);
    if (me) { aimAngle = Math.atan2(mouseWorldPos.y - me.y, mouseWorldPos.x - me.x); updateAimHint(); }
  }
});
canvas.addEventListener('mouseleave', () => { if (!touchMode) mouseWorldPos = null; });

// Drag tracked at document level — fires even when mouse leaves canvas
document.addEventListener('mousemove', e => {
  if (!dragStart) return;
  const dx = e.clientX - dragStart.clientX;
  const dy = e.clientY - dragStart.clientY;
  if (!didDrag && Math.hypot(dx, dy) > DRAG_THRESH) didDrag = true;
  if (didDrag) {
    // Convert CSS px delta → world units  (canvas logical px / zoom = world units)
    const rect = canvas.getBoundingClientRect();
    const cssScale = VPORT_W / rect.width; // logical-px per CSS-px
    const c = clampCam(
      dragStart.camX - (dx * cssScale) / zoom,
      dragStart.camY - (dy * cssScale) / zoom,
    );
    cam.x = c.x; cam.y = c.y; camTarget = { x: c.x, y: c.y };
    document.body.style.cursor = 'grabbing';
  }
});

document.addEventListener('mouseup', e => {
  if (!dragStart) return;
  const wasDrag = didDrag;
  const savedDragStart = dragStart;
  dragStart = null; didDrag = false;
  document.body.style.cursor = '';

  if (wasDrag) return;

  // Tap/click — only act if the click was inside the canvas
  const rect = canvas.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top  || e.clientY > rect.bottom) return;

  const sc = screenCoordsFromEvent(e.clientX, e.clientY);
  if (tryMinimapClick(sc.x, sc.y)) return;

  if (!myTurn || animating) return;
  const wpos = screenToWorld(sc.x, sc.y);

  const me = gameState?.ships.find(s => s.id === myId);
  if (!me) return;

  if (moveMode) {
    aimAngle = Math.atan2(wpos.y - me.y, wpos.x - me.x);
    doMove();
    return;
  }

  aimAngle = Math.atan2(wpos.y - me.y, wpos.x - me.x); fire();
});

// Scroll to zoom
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.9;
  zoom = Math.max(0.25, Math.min(2.5, zoom * factor));
  const c = clampCam(cam.x, cam.y);
  cam.x = c.x; cam.y = c.y; camTarget = { x: c.x, y: c.y };
}, { passive: false });

// ── Touch ──────────────────────────────────────────────────────────────────────
// Single finger: always pans (aim via buttons). Pinch: zoom.
let touchPanStart = null;
let touchPinchStart = null; // { dist, zoom }

function touchScreenCoords(touch) {
  return screenCoordsFromEvent(touch.clientX, touch.clientY);
}
function touchDist(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  touchMode = true;
  if (e.touches.length === 1) {
    const sc = touchScreenCoords(e.touches[0]);
    touchPanStart = { sx: sc.x, sy: sc.y, camX: cam.x, camY: cam.y };
    touchPinchStart = null;
  } else if (e.touches.length === 2) {
    touchPanStart = null;
    touchPinchStart = { dist: touchDist(e.touches), zoom };
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches.length === 1 && touchPanStart) {
    const sc = touchScreenCoords(e.touches[0]);
    const dx = sc.x - touchPanStart.sx, dy = sc.y - touchPanStart.sy;
    const c = clampCam(touchPanStart.camX - dx / zoom, touchPanStart.camY - dy / zoom);
    cam.x = c.x; cam.y = c.y; camTarget = { x: c.x, y: c.y };
  } else if (e.touches.length === 2 && touchPinchStart) {
    const newDist = touchDist(e.touches);
    zoom = Math.max(0.25, Math.min(2.5, touchPinchStart.zoom * (newDist / touchPinchStart.dist)));
    const c = clampCam(cam.x, cam.y);
    cam.x = c.x; cam.y = c.y; camTarget = { x: c.x, y: c.y };
  }
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  if (e.touches.length < 2) touchPinchStart = null;
  if (e.touches.length === 0) touchPanStart = null;
}, { passive: false });

// ── Move mode ──────────────────────────────────────────────────────────────────
function setMoveMode(on) {
  moveMode = on;
  const btn = document.getElementById('move-btn');
  if (btn) btn.classList.toggle('active-mode', on);
  if (on) {
    document.getElementById('aim-hint').textContent = '📡 Aim & fire to launch your ship — gravity applies!';
  } else if (myTurn) {
    updateAimHint();
  }
}

function doMove() {
  socket.emit('move-fire', { angle: aimAngle, power });
  myTurn = false;
  setMoveMode(false);
  setFireEnabled(false);
  document.getElementById('aim-hint').textContent = '🚀 Ship in flight…';
}

document.getElementById('move-btn').addEventListener('click', () => {
  if (!myTurn || animating) return;
  setMoveMode(!moveMode);
});

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { setMoveMode(false); return; }
  // Always prevent arrow keys from scrolling the page
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
  }
  if (!myTurn || animating) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (moveMode) doMove(); else fire(); }
  if (e.key === 'ArrowLeft')  { mouseWorldPos = null; aimAngle -= 5 * Math.PI / 180; updateAimHint(); }
  if (e.key === 'ArrowRight') { mouseWorldPos = null; aimAngle += 5 * Math.PI / 180; updateAimHint(); }
  if (e.key === 'ArrowUp')   { power = Math.min(100, power + 2); updatePower(); }
  if (e.key === 'ArrowDown') { power = Math.max(5, power - 2); updatePower(); }
});

// ── Old touch aim — retained for angle buttons on mobile ───────────────────
function onTouchAim(e) {
  // no-op placeholder kept so makeHoldBtn touchstart still works via its own listeners
}
// (makeHoldBtn handles its own touch events)

document.getElementById('power-slider').addEventListener('input', e => {
  power = parseInt(e.target.value);
  document.getElementById('power-val').textContent = power + '%';
  document.getElementById('power-touch-val').textContent = power + '%';
  updateAimHint();
});
document.getElementById('fire-btn').addEventListener('click', () => fire());
document.getElementById('defend-btn').addEventListener('click', () => defend());

function makeHoldBtn(id, action) {
  const btn = document.getElementById(id);
  if (!btn) return;
  let iv = null;
  const start = () => { action(); iv = setInterval(action, 80); };
  const stop  = () => { clearInterval(iv); iv = null; };
  btn.addEventListener('mousedown',  start);
  btn.addEventListener('touchstart', e => { e.preventDefault(); touchMode = true; start(); }, { passive: false });
  btn.addEventListener('mouseup',   stop); btn.addEventListener('mouseleave', stop);
  btn.addEventListener('touchend',  stop); btn.addEventListener('touchcancel', stop);
}
makeHoldBtn('angle-l', () => { if (!myTurn||animating) return; aimAngle -= 5*Math.PI/180; updateAimHint(); });
makeHoldBtn('angle-r', () => { if (!myTurn||animating) return; aimAngle += 5*Math.PI/180; updateAimHint(); });
makeHoldBtn('power-dn', () => { if (!myTurn||animating) return; power = Math.max(5, power-2); updatePower(); });
makeHoldBtn('power-up', () => { if (!myTurn||animating) return; power = Math.min(100, power+2); updatePower(); });

function fire() {
  if (!myTurn || animating) return;
  socket.emit('fire', { angle: aimAngle, power, weapon: selectedWeapon });
  myTurn = false;
  setFireEnabled(false);
  document.getElementById('aim-hint').textContent = '⏳ In flight…';
  playWeaponFire(selectedWeapon);
}

function defend() {
  if (!myTurn || animating) return;
  if (myCredits() < SHIELD_COST) { addChatMsg('System', `Need $${SHIELD_COST} for shield`); return; }
  socket.emit('defend');
  myTurn = false;
  setFireEnabled(false);
  document.getElementById('aim-hint').textContent = '🛡️ Shield raised!';
}

function updateAimHint() {
  const deg = Math.round((aimAngle * 180 / Math.PI + 360) % 360);
  document.getElementById('angle-disp').textContent = deg + '°';
  if (moveMode) return; // keep move-mode hint
  const hint = touchMode
    ? `${WEAPONS[selectedWeapon]?.name} · use ◀▶ to aim · FIRE button`
    : `Aim ${deg}° · Power ${power}% · ${WEAPONS[selectedWeapon]?.name} · click or Space`;
  document.getElementById('aim-hint').textContent = hint;
}
function updatePower() {
  document.getElementById('power-slider').value = power;
  document.getElementById('power-val').textContent = power + '%';
  document.getElementById('power-touch-val').textContent = power + '%';
  updateAimHint();
}

// ─── Weapon selection ─────────────────────────────────────────────────────────
function myCredits() {
  if (!gameState) return STARTING_CREDITS;
  return gameState.ships.find(s => s.id === myId)?.credits ?? STARTING_CREDITS;
}

function buildWeaponGrid() {
  const grid = document.getElementById('weapon-grid');
  grid.innerHTML = '';
  const credits = myCredits();
  for (const [key, w] of Object.entries(WEAPONS)) {
    const cost = WEAPON_COSTS[key] ?? 0;
    const canAfford = credits >= cost;
    const btn = document.createElement('button');
    btn.className = 'wpn-btn' + (key === selectedWeapon ? ' selected' : '') + (!canAfford ? ' unaffordable' : '');
    btn.title = `${w.name} — dmg ${w.damage}, blast r${w.explodeR}, cost $${cost}`;
    btn.innerHTML = `${w.icon} ${w.name}<span class="wpn-cost">$${cost}</span>`;
    btn.dataset.weapon = key;
    btn.addEventListener('click', () => { if (canAfford || !myTurn) selectWeapon(key); });
    grid.appendChild(btn);
  }
}

function applyCredits(creditUpdates) {
  if (!gameState || !creditUpdates) return;
  for (const cu of creditUpdates) {
    const s = gameState.ships.find(sh => sh.id === cu.id);
    if (s) s.credits = cu.credits;
  }
  const mine = myCredits();
  const el = document.getElementById('credits-val');
  if (el) el.textContent = mine.toLocaleString();
  if (myTurn) buildWeaponGrid();
}

function selectWeapon(key) {
  selectedWeapon = key;
  document.querySelectorAll('.wpn-btn').forEach(b => b.classList.toggle('selected', b.dataset.weapon === key));
  updateAimHint();
}

// ─── Health bars ──────────────────────────────────────────────────────────────
function buildHealthBars() {
  const el = document.getElementById('health-bars');
  el.innerHTML = '';
  if (!gameState) return;
  for (const s of gameState.ships) {
    el.innerHTML += `
      <div class="hbar-row" id="hbar-${s.id}">
        <span class="hbar-name" style="color:${s.color}">${s.name}</span>
        <div class="hbar-track"><div class="hbar-fill" id="hfill-${s.id}" style="width:100%;background:${s.color}"></div></div>
        <span class="hbar-val" id="hval-${s.id}">100</span>
      </div>`;
  }
}
function updateHealthBars() {
  if (!gameState) return;
  for (const s of gameState.ships) {
    const row = document.getElementById('hbar-' + s.id);
    const fill = document.getElementById('hfill-' + s.id);
    const val  = document.getElementById('hval-'  + s.id);
    if (!row) continue;
    row.classList.toggle('dead', !s.alive);
    row.classList.toggle('current-turn', s.id === currentTurnId);
    if (fill) fill.style.width = s.health + '%';
    if (val)  val.textContent = s.health;
  }
}

// ─── Turn UI ──────────────────────────────────────────────────────────────────
function setFireEnabled(on) {
  document.getElementById('fire-btn').disabled = !on;
  const defBtn = document.getElementById('defend-btn');
  if (defBtn) defBtn.disabled = !on || myCredits() < SHIELD_COST;
  const moveBtn = document.getElementById('move-btn');
  if (moveBtn) moveBtn.disabled = !on;
  document.querySelectorAll('.wpn-btn').forEach(b => b.disabled = !on);
  document.getElementById('power-slider').disabled = !on;
  ['angle-l','angle-r','power-dn','power-up'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function onTurnStart({ playerId, playerName, isCpu }) {
  currentTurnId = playerId;
  myTurn = (playerId === myId);
  animating = false; activeShots = []; activeExplosions = [];
  activeMoveAnim = null;

  // Pan camera to current ship
  const currentShip = gameState?.ships.find(s => s.id === playerId);
  if (currentShip) camTarget = { x: currentShip.x, y: currentShip.y };

  const banner = document.getElementById('turn-banner');
  if (myTurn) {
    banner.textContent = '🎯 YOUR TURN';
    banner.className = 'your-turn';
    setFireEnabled(true);
    updateAimHint();
    playPing();
  } else {
    banner.textContent = `${playerName}${isCpu?' 🤖':''} firing…`;
    banner.className = '';
    setFireEnabled(false);
    document.getElementById('aim-hint').textContent = `Watching ${playerName}…`;
  }
  updateHealthBars();
  buildWeaponGrid();
}

// ─── Socket ───────────────────────────────────────────────────────────────────
socket.on('connect', () => { myId = socket.id; });

socket.on('room-joined', room => {
  myRoomId = room.id; isHost = (room.hostId === myId);
  document.getElementById('room-code-display').textContent = room.id;
  document.getElementById('room-panel').classList.remove('hidden');
  document.getElementById('start-btn').disabled = !isHost || room.players.length < 2;
  updatePlayerList(room); clearError();
});
socket.on('room-update', room => {
  isHost = (room.hostId === myId);
  document.getElementById('start-btn').disabled = !isHost || room.players.length < 2;
  updatePlayerList(room);
});
socket.on('error', msg => showError(msg));

socket.on('game-start', ({ planets, ships }) => {
  planets.forEach(p => { p.holes = p.holes || []; });
  ships.forEach(s => { s.credits = s.credits ?? STARTING_CREDITS; s.shield = s.shield ?? false; });
  gameState = { planets, ships };
  planetCache.clear();
  // Center camera on first ship
  if (ships.length > 0) {
    const myShip = ships.find(s => s.id === myId) || ships[0];
    cam.x = myShip.x; cam.y = myShip.y;
    camTarget = { x: cam.x, y: cam.y };
  }
  showGame();
  buildHealthBars();
  buildWeaponGrid();
  setFireEnabled(false);
  document.getElementById('credits-display').classList.remove('hidden');
  document.getElementById('credits-val').textContent = STARTING_CREDITS.toLocaleString();
  document.getElementById('turn-banner').textContent = 'Game starting…';
});

socket.on('turn-start', data => {
  if (data.creditUpdates) applyCredits(data.creditUpdates);

  // Animate any floating ships drifting to their new positions
  if (data.floatPaths && gameState) {
    for (const fp of data.floatPaths) {
      const s = gameState.ships.find(sh => sh.id === fp.shipId);
      if (!s) continue;
      // Quick slide animation for short float paths (single turn)
      if (fp.path && fp.path.length > 1) {
        const fromPt = fp.path[0];
        const toPt = fp.path[fp.path.length - 1];
        activeSlideAnims.push({ shipId: fp.shipId, fromX: fromPt.x, fromY: fromPt.y,
          toX: toPt.x, toY: toPt.y, age: 0, maxAge: Math.min(30, fp.path.length) });
      }
      // Apply final position
      if (fp.x !== undefined) s.x = fp.x;
      if (fp.y !== undefined) s.y = fp.y;
      if (fp.floating !== undefined) s.floating = fp.floating;
      if (fp.planetId !== undefined) s.planetId = fp.planetId;
      if (fp.surfaceAngle !== undefined) s.surfaceAngle = fp.surfaceAngle;
    }
  }

  onTurnStart(data);
});

socket.on('fire-result', payload => {
  pendingPlanetHoles = payload.planetHoles || null;

  // Show quip speech bubble for the firer
  if (payload.quip && payload.firer && gameState) {
    const firerShip = gameState.ships.find(s => s.id === payload.firer.id);
    activeQuip = {
      text: payload.quip,
      x: firerShip?.x ?? W / 2,
      y: firerShip?.y ?? H / 2,
      age: 0, maxAge: 200,
      color: firerShip?.color ?? '#fff',
    };
  }

  if (payload.creditUpdates) applyCredits(payload.creditUpdates);
  animating = true; activeShots = []; pendingUpdates = payload.shipUpdates;
  for (const shot of payload.shots) {
    let planetMask = null;
    if (shot.weapon === 'tunneler' && gameState) {
      planetMask = shot.pts.map(pt => {
        for (const p of gameState.planets) {
          if (Math.hypot(p.x - pt.x, p.y - pt.y) < p.r) {
            const inHole = (p.holes || []).some(h => Math.hypot(h.x - pt.x, h.y - pt.y) <= h.r);
            if (!inHole) return true;
          }
        }
        return false;
      });
    }
    activeShots.push({
      pts: shot.pts, idx: 0, trail: [],
      curX: shot.pts[0]?.x, curY: shot.pts[0]?.y,
      hx: shot.hx, hy: shot.hy, hitType: shot.hitType,
      weapon: shot.weapon, done: false, subShots: shot.subShots || null,
      planetMask, inPlanet: false,
    });
  }
  document.getElementById('aim-hint').textContent = '⚡ Projectile in flight…';
  animStep();
});

socket.on('move-result', ({ traj, shipUpdates }) => {
  const shipId = shipUpdates?.[0]?.id;
  const movedShip = gameState?.ships.find(s => s.id === shipId);

  if (traj && traj.pts && traj.pts.length > 0 && movedShip) {
    // Animate ship flying along its trajectory before applying final position
    activeMoveAnim = { shipId, pts: traj.pts, idx: 0 };
    const tick = () => {
      if (!activeMoveAnim || activeMoveAnim.shipId !== shipId) return;
      activeMoveAnim.idx = Math.min(activeMoveAnim.idx + ANIM_SPEED, traj.pts.length - 1);
      const pt = traj.pts[activeMoveAnim.idx];
      if (pt) camTarget = { x: pt.x, y: pt.y };
      if (activeMoveAnim.idx < traj.pts.length - 1) {
        setTimeout(tick, 1000 / 60);
      } else {
        activeMoveAnim = null;
        if (shipUpdates) applyShipUpdates(shipUpdates);
        const s = gameState?.ships.find(sh => sh.id === shipId);
        if (s) camTarget = { x: s.x, y: s.y };
        const label = traj.hitType === 'planet' ? 'landed on a planet' :
          traj.hitType === 'ring' ? 'hit a ring' : 'is now adrift in space';
        if (movedShip) addChatMsg('System', `${movedShip.name} ${label}`);
      }
    };
    tick();
  } else {
    if (shipUpdates) applyShipUpdates(shipUpdates);
    if (movedShip) {
      camTarget = { x: movedShip.x, y: movedShip.y };
      addChatMsg('System', `${movedShip.name} relocated`);
    }
  }
});

socket.on('defend-result', ({ shipId, creditUpdates, shipUpdates }) => {
  if (creditUpdates) applyCredits(creditUpdates);
  if (shipUpdates) applyShipUpdates(shipUpdates);
  const shieldShip = gameState?.ships.find(s => s.id === shipId);
  addChatMsg('System', `${shieldShip?.name || 'A ship'} raised shields!`);
});

socket.on('game-over', ({ winnerName, winnerColor }) => {
  animating = false; setFireEnabled(false);
  document.getElementById('overlay-title').textContent = '🏆 VICTORY';
  document.getElementById('overlay-title').style.color = winnerColor || '#ffcc00';
  document.getElementById('overlay-sub').textContent = `${winnerName} wins!`;
  document.getElementById('overlay').classList.remove('hidden');
  playDeath();
});
socket.on('player-left', ({ name }) => addChatMsg('System', `${name} disconnected`));
socket.on('chat', ({ name, message }) => addChatMsg(name, message));

// ─── Chat ─────────────────────────────────────────────────────────────────────
function addChatMsg(name, msg) {
  const box = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.innerHTML = `<span class="msg-name">${escHtml(name)}: </span>${escHtml(msg)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if(e.key==='Enter') sendChat(); });
function sendChat() {
  const el = document.getElementById('chat-input');
  const msg = el.value.trim(); if (!msg) return;
  socket.emit('chat', { message: msg }); el.value = '';
}

// ─── Lobby ────────────────────────────────────────────────────────────────────
function updatePlayerList(room) {
  const ul = document.getElementById('player-list');
  ul.innerHTML = '';
  room.players.forEach((p, i) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = PLAYER_COLORS[i % PLAYER_COLORS.length];
    li.appendChild(dot);
    li.appendChild(document.createTextNode(p.name + (p.id===room.hostId?' 👑':'') + (!p.isHuman?' 🤖':'')));
    if (isHost && p.id !== myId) {
      const rm = document.createElement('button');
      rm.className = 'remove-btn'; rm.textContent = '✕';
      rm.addEventListener('click', () => socket.emit('remove-player', { playerId: p.id }));
      li.appendChild(rm);
    }
    ul.appendChild(li);
  });
  document.getElementById('start-btn').disabled = !isHost || room.players.length < 2;
  document.getElementById('cpu-row').style.display = isHost ? 'flex' : 'none';
}

document.getElementById('create-btn').addEventListener('click', () => {
  ac();
  const name = document.getElementById('player-name').value.trim() || 'Pilot';
  socket.emit('create-room', { name });
});
document.getElementById('join-btn').addEventListener('click', joinRoom);
document.getElementById('room-code-input').addEventListener('keydown', e => { if(e.key==='Enter') joinRoom(); });
function joinRoom() {
  ac();
  const name = document.getElementById('player-name').value.trim() || 'Pilot';
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code) { showError('Enter a room code'); return; }
  socket.emit('join-room', { roomId: code, name });
}
document.querySelectorAll('.cpu-btn').forEach(btn => {
  btn.addEventListener('click', () => socket.emit('add-cpu', { difficulty: btn.dataset.diff }));
});
document.getElementById('start-btn').addEventListener('click', () => socket.emit('start-game'));
document.getElementById('copy-code-btn').addEventListener('click', () => {
  const code = document.getElementById('room-code-display').textContent;
  navigator.clipboard.writeText(code).then(() => {
    document.getElementById('lobby-msg').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('lobby-msg').textContent = ''; }, 2000);
  });
});
document.getElementById('overlay-btn').addEventListener('click', () => {
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('game').classList.add('hidden');
  document.getElementById('lobby').style.display = '';
  gameState = null; currentTurnId = null; myTurn = false; animating = false;
  activeShots = []; activeExplosions = []; activeParticles = []; activeQuip = null;
  if (myRoomId) document.getElementById('room-panel').classList.remove('hidden');
});

function showGame() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').classList.remove('hidden');
}
function showError(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg; el.classList.remove('hidden');
}
function clearError() { document.getElementById('lobby-error').classList.add('hidden'); }
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
render();
