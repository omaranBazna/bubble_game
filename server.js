// Bubble Splitter Online — authoritative game server
// Run: npm install && npm start   (then open http://localhost:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Game constants (must match client) ----------
const W = 540, H = 960, FLOOR = 912, WALL = 10, CEIL = 10;
const G = 1150;
const RADII = [8, 14, 22, 33, 45];
const HEIGHTS = [150, 240, 340, 450, 560];
const BOUNCE = HEIGHTS.map(h => Math.sqrt(2 * G * h));
const POINTS = [400, 250, 150, 100, 60];
const HSPEED = 95;
const LEVEL_TIME = 90;
const MAX_PLAYERS = 4;
const PLAYER_W = 30, PLAYER_H = 50;
const TICK = 1000 / 60;
const SEND_EVERY = 2; // 30 snapshots / second
const COLORS = ['#e8473f', '#2f8fe0', '#2fbf6a', '#a65be0'];

const LEVELS = [
  { name: 'Warm Up',       hue: 205, balls: [[2, 170, 200, 1]], plats: [] },
  { name: 'Big One',       hue: 270, balls: [[3, 160, 220, 1]], plats: [] },
  { name: 'Twins',         hue: 160, balls: [[2, 120, 200, 1], [2, 420, 200, -1]], plats: [] },
  { name: 'Odd Couple',    hue: 30,  balls: [[3, 130, 220, 1], [2, 410, 180, -1]], plats: [] },
  { name: 'The Giant',     hue: 330, balls: [[4, 180, 220, 1]], plats: [] },
  { name: 'Overhang',      hue: 190, balls: [[3, 110, 200, 1], [3, 430, 200, -1]],
    plats: [{ x: 200, y: 520, w: 140, h: 16 }] },
  { name: 'Crowd',         hue: 100, balls: [[4, 270, 200, 1], [2, 90, 160, 1], [2, 450, 160, -1]], plats: [] },
  { name: 'Two Ledges',    hue: 10,  balls: [[4, 160, 200, 1], [3, 400, 200, -1]],
    plats: [{ x: 70, y: 560, w: 110, h: 16 }, { x: 360, y: 560, w: 110, h: 16 }] },
  { name: 'Triple Threat', hue: 250, balls: [[3, 100, 180, 1], [3, 270, 180, -1], [3, 440, 180, 1]],
    plats: [{ x: 225, y: 460, w: 90, h: 16 }, { x: 60, y: 620, w: 90, h: 16 }, { x: 390, y: 620, w: 90, h: 16 }] },
  { name: 'Final Storm',   hue: 0,   balls: [[4, 130, 200, 1], [4, 410, 200, -1], [2, 270, 150, 1]],
    plats: [{ x: 150, y: 580, w: 80, h: 16 }, { x: 310, y: 580, w: 80, h: 16 }] },
];

// ---------- Static file server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') { res.writeHead(200); res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Rooms ----------
const rooms = new Map();
let nextId = 1;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function cleanName(n) {
  return String(n || '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 12) || 'Player';
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player
    this.hostId = null;
    this.state = 'lobby';     // lobby | intro | play | clear | over | win
    this.level = 0;
    this.balls = []; this.shots = []; this.pus = [];
    this.timeLeft = LEVEL_TIME;
    this.freezeT = 0;
    this.stateT = 0;
    this.events = [];
    this.tickN = 0;
    this.ballId = 1;
  }

  colorFree() {
    const used = new Set([...this.players.values()].map(p => p.color));
    return COLORS.find(c => !used.has(c)) || COLORS[0];
  }

  addPlayer(ws, name) {
    const id = nextId++;
    const p = {
      id, ws, name: cleanName(name), color: this.colorFree(),
      x: W / 2, face: 1, moving: false, score: 0, lives: 3, alive: true,
      inv: 0, shield: false, doubleT: 0, shootT: 0, lastPosAt: Date.now(),
    };
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    // late joiners spectate until the next level
    if (this.state !== 'lobby') { p.alive = false; p.lives = 0; }
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.shots = this.shots.filter(s => s.owner !== id);
    if (this.hostId === id) this.hostId = this.players.size ? this.players.keys().next().value : null;
    if (this.players.size === 0) { rooms.delete(this.code); return; }
    this.broadcastLobby();
    if (this.state === 'play' || this.state === 'intro') this.checkAllDead();
  }

  spreadPlayers() {
    const ps = [...this.players.values()];
    ps.forEach((p, i) => { p.x = W * (i + 1) / (ps.length + 1); p.inv = 0; p.doubleT = 0; p.shootT = 0; });
  }

  loadLevel(i, { revive = false, fullLives = false } = {}) {
    this.level = i;
    const L = LEVELS[i];
    this.balls = L.balls.map(b => ({ id: this.ballId++, s: b[0], r: RADII[b[0]], x: b[1], y: b[2], vx: HSPEED * b[3], vy: 0 }));
    this.shots = []; this.pus = [];
    this.timeLeft = LEVEL_TIME; this.freezeT = 0;
    for (const p of this.players.values()) {
      if (fullLives) { p.lives = 3; p.alive = true; p.shield = false; }
      else if (revive && !p.alive) { p.lives = 1; p.alive = true; }
    }
    this.spreadPlayers();
    this.state = 'intro'; this.stateT = 1.8;
    this.sendAll({ t: 'level', level: i, name: L.name, hue: L.hue, plats: L.plats });
  }

  startGame() {
    for (const p of this.players.values()) { p.score = 0; p.lives = 3; p.alive = true; p.shield = false; }
    this.loadLevel(0);
  }

  // ---------- messaging ----------
  sendAll(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(data);
  }
  broadcastLobby() {
    this.sendAll({
      t: 'lobby', code: this.code, hostId: this.hostId, state: this.state, level: this.level,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color })),
    });
  }

  // ---------- input ----------
  onMessage(p, m) {
    switch (m.t) {
      case 'pos': {
        if (typeof m.x !== 'number' || !isFinite(m.x)) return;
        const now = Date.now();
        const dt = Math.min(0.25, (now - p.lastPosAt) / 1000);
        p.lastPosAt = now;
        const maxStep = 950 * dt + 12; // anti-teleport
        const nx = Math.max(p.x - maxStep, Math.min(p.x + maxStep, m.x));
        p.moving = Math.abs(nx - p.x) > 0.5;
        if (nx !== p.x) p.face = nx > p.x ? 1 : -1;
        p.x = Math.max(WALL + PLAYER_W / 2, Math.min(W - WALL - PLAYER_W / 2, nx));
        break;
      }
      case 'fire': this.fire(p); break;
      case 'start':
        if (p.id === this.hostId && (this.state === 'lobby' || this.state === 'win' || this.state === 'over')) this.startGame();
        break;
      case 'retry':
        if (p.id === this.hostId && this.state === 'over') {
          for (const q of this.players.values()) q.score = Math.floor(q.score / 2); // small penalty
          this.loadLevel(this.level, { fullLives: true });
        }
        break;
      case 'lobby':
        if (p.id === this.hostId && (this.state === 'over' || this.state === 'win')) { this.state = 'lobby'; this.broadcastLobby(); }
        break;
    }
  }

  fire(p) {
    if (this.state !== 'play' || !p.alive) return;
    const mine = this.shots.filter(s => s.owner === p.id).length;
    if (mine >= (p.doubleT > 0 ? 2 : 1)) return;
    this.shots.push({ owner: p.id, x: p.x, y: FLOOR - 4, t: 0 });
    p.shootT = 0.18;
    this.events.push(['shoot', p.id]);
  }

  // ---------- simulation ----------
  splitBall(idx, shooter) {
    const b = this.balls[idx];
    this.balls.splice(idx, 1);
    if (shooter) shooter.score += POINTS[b.s];
    this.events.push(['pop', Math.round(b.x), Math.round(b.y), b.s, shooter ? shooter.id : 0, POINTS[b.s]]);
    if (b.s > 0) {
      const s = b.s - 1, r = RADII[s];
      const y = Math.max(CEIL + r + 2, b.y);
      const pop = -Math.min(BOUNCE[s] * 0.75, 560);
      this.balls.push({ id: this.ballId++, s, r, x: Math.max(WALL + r, b.x - r * 0.6), y, vx: -HSPEED, vy: pop });
      this.balls.push({ id: this.ballId++, s, r, x: Math.min(W - WALL - r, b.x + r * 0.6), y, vx: HSPEED, vy: pop });
    }
    if (Math.random() < 0.14) {
      const roll = Math.random();
      const type = roll < 0.35 ? 'double' : roll < 0.65 ? 'freeze' : roll < 0.9 ? 'shield' : 'life';
      this.pus.push({ type, x: b.x, y: b.y, vy: -120, life: 7 });
    }
    if (this.balls.length === 0) this.levelCleared();
  }

  levelCleared() {
    const bonus = Math.ceil(this.timeLeft) * 20;
    for (const p of this.players.values()) if (p.alive) p.score += bonus;
    this.events.push(['clear', bonus]);
    if (this.level === LEVELS.length - 1) { this.state = 'win'; }
    else { this.state = 'clear'; this.stateT = 3; }
    this.shots = [];
  }

  hurt(p, reason) {
    if (p.shield && reason === 'hit') { p.shield = false; p.inv = 1.5; this.events.push(['shield', p.id]); return; }
    p.lives--; p.inv = 2.2;
    this.events.push(['hurt', p.id, Math.round(p.x)]);
    if (p.lives <= 0) { p.alive = false; p.lives = 0; this.shots = this.shots.filter(s => s.owner !== p.id); }
  }

  checkAllDead() {
    const anyAlive = [...this.players.values()].some(p => p.alive);
    if (!anyAlive && this.players.size) { this.state = 'over'; this.events.push(['over']); }
  }

  step(dt) {
    if (this.state === 'intro') { this.stateT -= dt; if (this.stateT <= 0) this.state = 'play'; return; }
    if (this.state === 'clear') { this.stateT -= dt; if (this.stateT <= 0) this.loadLevel(this.level + 1, { revive: true }); return; }
    if (this.state !== 'play') return;

    this.timeLeft -= dt;
    if (this.freezeT > 0) this.freezeT -= dt;
    for (const p of this.players.values()) {
      if (p.inv > 0) p.inv -= dt;
      if (p.doubleT > 0) p.doubleT -= dt;
      if (p.shootT > 0) p.shootT -= dt;
      if (Date.now() - p.lastPosAt > 150) p.moving = false;
    }

    if (this.timeLeft <= 0) {
      this.events.push(['timeup']);
      for (const p of this.players.values()) if (p.alive) { p.shield = false; this.hurt(p, 'time'); }
      this.checkAllDead();
      if (this.state === 'play') this.loadLevel(this.level);
      return;
    }

    const plats = LEVELS[this.level].plats;

    // shots
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.y -= 720 * dt; s.t += dt;
      let dead = s.y <= CEIL;
      if (!dead) for (const p of plats) if (s.x >= p.x && s.x <= p.x + p.w && s.y <= p.y + p.h) { dead = true; break; }
      if (!dead) {
        for (let j = this.balls.length - 1; j >= 0; j--) {
          const b = this.balls[j];
          const cy = Math.max(s.y, Math.min(b.y, FLOOR));
          const dx = b.x - s.x, dy = b.y - cy;
          if (dx * dx + dy * dy < b.r * b.r) { this.splitBall(j, this.players.get(s.owner)); dead = true; break; }
        }
      }
      if (dead) this.shots.splice(i, 1);
      if (this.state !== 'play') return;
    }

    // balls
    if (this.freezeT <= 0) {
      for (const b of this.balls) {
        b.vy += G * dt; b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.y + b.r >= FLOOR) { b.y = FLOOR - b.r; b.vy = -BOUNCE[b.s]; }
        if (b.y - b.r <= CEIL) { b.y = CEIL + b.r; b.vy = Math.abs(b.vy); }
        if (b.x - b.r <= WALL) { b.x = WALL + b.r; b.vx = Math.abs(b.vx); }
        if (b.x + b.r >= W - WALL) { b.x = W - WALL - b.r; b.vx = -Math.abs(b.vx); }
        for (const p of plats) collideBallRect(b, p);
      }
    }

    // power-ups
    for (let i = this.pus.length - 1; i >= 0; i--) {
      const u = this.pus[i];
      u.vy += 700 * dt; u.y += u.vy * dt;
      if (u.y > FLOOR - 12) { u.y = FLOOR - 12; u.vy = 0; }
      u.life -= dt;
      let taken = false;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (Math.abs(u.x - p.x) < 26 && u.y > FLOOR - PLAYER_H - 10) {
          if (u.type === 'double') p.doubleT = 15;
          if (u.type === 'freeze') this.freezeT = 5;
          if (u.type === 'shield') p.shield = true;
          if (u.type === 'life') p.lives++;
          this.events.push(['power', p.id, u.type, Math.round(u.x), Math.round(u.y)]);
          taken = true; break;
        }
      }
      if (taken || u.life <= 0) this.pus.splice(i, 1);
    }

    // player hits
    for (const p of this.players.values()) {
      if (!p.alive || p.inv > 0) continue;
      const px = p.x - PLAYER_W / 2 + 4, pw = PLAYER_W - 8;
      const py = FLOOR - PLAYER_H + 8, ph = PLAYER_H - 8;
      for (const b of this.balls) {
        const cx = Math.max(px, Math.min(b.x, px + pw));
        const cy = Math.max(py, Math.min(b.y, py + ph));
        const dx = b.x - cx, dy = b.y - cy;
        if (dx * dx + dy * dy < (b.r * 0.9) ** 2) { this.hurt(p, 'hit'); break; }
      }
    }
    this.checkAllDead();
  }

  snapshot() {
    const r1 = v => Math.round(v * 10) / 10;
    return {
      t: 's', st: this.state, lv: this.level, time: Math.max(0, Math.ceil(this.timeLeft)), fz: this.freezeT > 0 ? 1 : 0,
      host: this.hostId,
      b: this.balls.map(b => [b.id, r1(b.x), r1(b.y), b.s]),
      sh: this.shots.map(s => [r1(s.x), r1(s.y), s.owner]),
      pu: this.pus.map(u => [r1(u.x), r1(u.y), u.type, u.life < 2 ? 1 : 0]),
      p: [...this.players.values()].map(p => ({
        id: p.id, n: p.name, c: p.color, x: r1(p.x), f: p.face, m: p.moving ? 1 : 0, sc: p.score, l: p.lives,
        a: p.alive ? 1 : 0, iv: p.inv > 0 ? 1 : 0, sd: p.shield ? 1 : 0, d: Math.max(0, Math.ceil(p.doubleT)), st: p.shootT > 0 ? 1 : 0,
      })),
      ev: this.events,
    };
  }

  tick(dt) {
    this.step(dt);
    this.tickN++;
    if (this.tickN % SEND_EVERY === 0) {
      this.sendAll(this.snapshot());
      this.events = [];
    }
  }
}

function collideBallRect(b, p) {
  const cx = Math.max(p.x, Math.min(b.x, p.x + p.w));
  const cy = Math.max(p.y, Math.min(b.y, p.y + p.h));
  const dx = b.x - cx, dy = b.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= b.r * b.r) return;
  const d = Math.sqrt(d2) || 0.0001;
  let nx = dx / d, ny = dy / d;
  if (d2 === 0) { nx = 0; ny = b.y < p.y + p.h / 2 ? -1 : 1; }
  const push = b.r - d;
  b.x += nx * push; b.y += ny * push;
  if (Math.abs(ny) >= Math.abs(nx)) b.vy = ny < 0 ? -Math.abs(b.vy) : Math.abs(b.vy);
  else b.vx = nx > 0 ? Math.abs(b.vx) : -Math.abs(b.vx);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', ws => {
  let room = null, player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const send = m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (!room) {
      if (m.t === 'create') {
        room = new Room(makeCode());
        rooms.set(room.code, room);
        player = room.addPlayer(ws, m.name);
        send({ t: 'joined', id: player.id, code: room.code });
        room.broadcastLobby();
      } else if (m.t === 'join') {
        const code = String(m.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) return send({ t: 'error', msg: 'Room not found. Check the code.' });
        if (r.players.size >= MAX_PLAYERS) return send({ t: 'error', msg: 'That room is full (4 players max).' });
        room = r;
        player = room.addPlayer(ws, m.name);
        send({ t: 'joined', id: player.id, code: room.code });
        room.broadcastLobby();
        if (room.state !== 'lobby') {
          const L = LEVELS[room.level];
          send({ t: 'level', level: room.level, name: L.name, hue: L.hue, plats: L.plats });
        }
      }
      return;
    }
    room.onMessage(player, m);
  });

  ws.on('close', () => { if (room && player) room.removePlayer(player.id); });
});

// heartbeat: drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

// game loop
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const room of rooms.values()) room.tick(dt);
}, TICK);

server.listen(PORT, () => console.log(`Bubble Splitter Online running on http://localhost:${PORT}`));
