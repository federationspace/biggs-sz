// Knockout Kingdom: an original open-world arcade boxing game.
// Single file, no dependencies, canvas 2D + WebAudio. All characters are original.
'use strict';
(() => {
const W = 960, H = 540, TS = 32;
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
cv.width = W; cv.height = H;
function fit() {
  const s = Math.min(innerWidth / W, innerHeight / H);
  cv.style.width = Math.floor(W * s) + 'px';
  cv.style.height = Math.floor(H * s) + 'px';
}
addEventListener('resize', fit); fit();
cv.focus();

// ---------------------------------------------------------------- utils
const FONT = 'ui-monospace, Menlo, Consolas, "Courier New", monospace';
const font = (sz, b = true) => { ctx.font = (b ? 'bold ' : '') + sz + 'px ' + FONT; };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const rr = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rr(a, b + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const lerpP = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t) });
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function shade(hex, a) {
  const n = parseInt(hex.slice(1), 16); const r = n >> 16, g = n >> 8 & 255, b = n & 255;
  const f = v => clamp(Math.round(a < 0 ? v * (1 + a) : v + (255 - v) * a), 0, 255);
  return '#' + ((1 << 24) | (f(r) << 16) | (f(g) << 8) | f(b)).toString(16).slice(1);
}
function text(s, x, y, col = '#fff', sz = 16, align = 'left', shadow = true) {
  font(sz); ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  if (shadow) { ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillText(s, x + 2, y + 2); }
  ctx.fillStyle = col; ctx.fillText(s, x, y);
}
function wrap(s, maxW, sz) {
  font(sz, false); const out = [];
  for (const para of String(s).split('\n')) {
    let line = '';
    for (const w of para.split(' ')) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}
function rrect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function panel(x, y, w, h, col = 'rgba(14,14,30,.94)', border = '#f5c542') {
  rrect(x, y, w, h, 10); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = border; ctx.stroke();
}
function circle(x, y, r, col) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r), 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
function ellipse(x, y, rx, ry, col) { ctx.beginPath(); ctx.ellipse(x, y, Math.max(.1, rx), Math.max(.1, ry), 0, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
function bar(x, y, w, h, frac, col, rev) {
  frac = clamp(frac, 0, 1);
  ctx.fillStyle = '#222'; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = '#511'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = frac < 0.3 ? '#f39c12' : col;
  if (rev) ctx.fillRect(x + w * (1 - frac), y, w * frac, h); else ctx.fillRect(x, y, w * frac, h);
  ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(x, y, w, h / 3);
}

// ---------------------------------------------------------------- input
const keys = {}, pressed = new Set();
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down', KeyZ: 'pl', KeyJ: 'pl', KeyX: 'pr', KeyK: 'pr', Space: 'star',
  Enter: 'act', KeyE: 'act', KeyC: 'duck', KeyL: 'duck', ShiftLeft: 'run', ShiftRight: 'run',
  KeyM: 'map', Escape: 'menu', KeyP: 'menu', Tab: 'menu', KeyQ: 'shake'
};
addEventListener('keydown', e => {
  const k = KEYMAP[e.code]; if (!k) return; e.preventDefault();
  if (!keys[k]) pressed.add(k); keys[k] = true; audioInit();
});
addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) { keys[k] = false; e.preventDefault(); } });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; if (F) F.paused = true; });
for (const el of document.querySelectorAll('.tb')) {
  const k = el.dataset.k;
  const on = e => { e.preventDefault(); if (!keys[k]) pressed.add(k); keys[k] = true; el.classList.add('on'); audioInit(); };
  const off = e => { e.preventDefault(); keys[k] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
}
cv.addEventListener('pointerdown', () => { audioInit(); cv.focus(); });
const hit = k => pressed.has(k);
const adv = () => hit('act') || hit('star') || hit('pl') || hit('pr');

// ---------------------------------------------------------------- audio
let AC = null;
function audioInit() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = false; } } else if (AC.state === 'suspended') AC.resume(); }
function tone(f, d, type = 'square', vol = 0.08, slide = 0, delay = 0) {
  if (!AC) return; const t = AC.currentTime + delay; const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + d);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + d + 0.02);
}
function noise(d, vol = 0.15) {
  if (!AC) return; const n = Math.floor(AC.sampleRate * d); const b = AC.createBuffer(1, n, AC.sampleRate); const ch = b.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = AC.createBufferSource(); s.buffer = b; const g = AC.createGain(); g.gain.value = vol; s.connect(g); g.connect(AC.destination); s.start();
}
const SFX = {
  punch() { noise(0.08, 0.3); tone(130, 0.09, 'sine', 0.25, -70); },
  big() { noise(0.18, 0.4); tone(90, 0.25, 'sine', 0.3, -50); },
  block() { tone(320, 0.05, 'square', 0.05); noise(0.03, 0.08); },
  whiff() { noise(0.06, 0.06); },
  hurt() { noise(0.14, 0.35); tone(95, 0.18, 'sawtooth', 0.12, -45); },
  bell() { [0, 0.28, 0.56].forEach(t => tone(1320, 0.7, 'triangle', 0.12, 0, t)); },
  star() { [660, 880, 1320].forEach((f, i) => tone(f, 0.12, 'square', 0.06, 0, i * 0.06)); },
  blip() { tone(880, 0.04, 'square', 0.04); },
  coin() { tone(988, 0.07, 'square', 0.05); tone(1319, 0.14, 'square', 0.05, 0, 0.07); },
  tell() { tone(1600, 0.05, 'square', 0.035); },
  down() { tone(220, 0.6, 'sawtooth', 0.1, -170); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'square', 0.06, 0, i * 0.12)); }
};

// ---------------------------------------------------------------- data
const REG = {
  rookie: { name: 'Rookie Row', col: '#6ab04c' },
  docks: { name: 'Iron Docks', col: '#4a90c2' },
  neon: { name: 'Neon Strip', col: '#e84393' },
  summit: { name: 'Summit Ridge', col: '#dfe6e9' }
};
const BELT_ORDER = ['rookie', 'docks', 'neon', 'summit'];

const ATK = {
  jabL: { type: 'jab', side: -1, wind: 0.62, dmg: 7, rec: 0.6, block: 0.25 },
  jabR: { type: 'jab', side: 1, wind: 0.62, dmg: 7, rec: 0.6, block: 0.25 },
  hookL: { type: 'hook', side: -1, wind: 0.85, dmg: 12, rec: 0.8, block: 0.4 },
  hookR: { type: 'hook', side: 1, wind: 0.85, dmg: 12, rec: 0.8, block: 0.4 },
  upper: { type: 'upper', side: 0, wind: 0.95, dmg: 16, rec: 0.95, block: 1 },
  body: { type: 'body', side: 0, wind: 0.72, dmg: 9, rec: 0.65, block: 0.2 },
  special: { type: 'special', side: 0, wind: 1.35, dmg: 26, rec: 1.35, block: 1 }
};

// All fighters are original characters.
const OPP = {
  al: { name: 'Alley Al', title: 'Rookie Row street brawler', hp: 60, dmg: 0.6, speed: 0.8, idle: [1.4, 2.4], guard: 1.4, adapt: 0.15, taunt: 0.08, feint: 0, combo: 0, grit: 0.45, maxCombo: 5,
    atk: { jabL: 3, jabR: 3, hookL: 1 }, skin: '#d9a066', hair: '#2b1d0e', style: 'buzz', trunks: '#7f8c8d', glove: '#b33939', build: 1.0, purse: 25,
    lines: ["You lost, kid? This is MY alley.", "Watch the shoes. They're new."], rematch: "Back for more? Half purse this time.",
    tip: "Al telegraphs everything. Dodge, then punish him while he stumbles." },
  pete: { name: 'Pretzel Pete', title: 'Twisted snack vendor', hp: 72, dmg: 0.7, speed: 0.88, idle: [1.2, 2.2], guard: 1.2, adapt: 0.2, taunt: 0.1, feint: 0, combo: 0.05, grit: 0.5, maxCombo: 5,
    atk: { jabL: 2, jabR: 2, hookL: 1, hookR: 1 }, skin: '#f1c27d', hair: '#a0522d', style: 'curly', trunks: '#e67e22', glove: '#c0392b', build: 1.05, purse: 32,
    lines: ["I'll tie you in knots, pal!", "Salted or unsalted? Your choice of knuckle."], rematch: "Pretzels are half off, and so is the purse.",
    tip: "Pete's hooks come from the side. Slip AWAY from the glove, or duck under it." },
  buster: { name: 'Buster Brickman', title: 'Rookie Row Gym champion', hp: 110, dmg: 0.9, speed: 1.0, idle: [1.0, 2.0], guard: 1.1, adapt: 0.4, taunt: 0.1, feint: 0, combo: 0.1, grit: 0.75, maxCombo: 4,
    atk: { jabL: 3, jabR: 3, hookL: 2, hookR: 2, body: 2, special: 1 }, special: { name: 'BRICK BREAKER', avoid: 'duck' },
    skin: '#c68642', hair: '#111111', style: 'flat', trunks: '#2c3e50', glove: '#e74c3c', build: 1.2, purse: 150, belt: 'rookie',
    lines: ["Nobody leaves Rookie Row with my belt. NOBODY.", "I've built walls tougher than you."], rematch: "Title defense? I've been laying bricks all week. Let's go.",
    tip: "When Buster raises both arms for the BRICK BREAKER, DUCK (C). He guards high after you tag his face twice; go to the body." },
  bev: { name: 'Barnacle Bev', title: 'Iron Docks deckhand', hp: 88, dmg: 0.8, speed: 0.98, idle: [1.0, 1.9], guard: 1.0, adapt: 0.3, taunt: 0.08, feint: 0, combo: 0.15, grit: 0.55, maxCombo: 4,
    atk: { jabL: 2, jabR: 2, body: 3, hookR: 1 }, skin: '#e0ac69', hair: '#5d4037', style: 'bun', trunks: '#16a085', glove: '#1e3799', build: 1.0, purse: 45,
    lines: ["I've scraped tougher things off a hull.", "Ahoy, punching bag."], rematch: "Thought you'd sunk. Half purse.",
    tip: "Bev loves body blows. Hold DOWN to block them, then counter." },
  crane: { name: 'Crane Kowalski', title: 'Crane operator', hp: 98, dmg: 0.9, speed: 0.95, idle: [1.1, 2.0], guard: 1.2, adapt: 0.25, taunt: 0.05, feint: 0, combo: 0.1, grit: 0.6, maxCombo: 4,
    atk: { jabL: 2, jabR: 2, upper: 2, hookL: 1 }, skin: '#ffdbac', hair: '#f6e58d', style: 'mohawk', trunks: '#f9ca24', glove: '#30336b', build: 1.25, purse: 55,
    lines: ["I lift containers for a living. You're a feather.", "Hard hat zone, buddy."], rematch: "The crane's on break and so's half your purse.",
    tip: "Uppercuts can't be blocked or ducked. Dodge left or right." },
  annie: { name: 'Anchor Annie', title: 'Iron Docks Gym champion', hp: 140, dmg: 1.0, speed: 1.12, idle: [0.9, 1.7], guard: 1.0, adapt: 0.45, taunt: 0.08, feint: 0.05, combo: 0.25, grit: 0.8, maxCombo: 4,
    atk: { jabL: 3, jabR: 3, hookL: 2, hookR: 2, upper: 2, body: 2, special: 1 }, special: { name: 'ANCHOR DROP', avoid: 'dodge' },
    skin: '#8d5524', hair: '#1b1b1b', style: 'beanie', hat: '#c0392b', trunks: '#0c2461', glove: '#f6b93b', build: 1.1, purse: 300, belt: 'docks',
    lines: ["Thirty years on the water. I've weathered worse storms than you.", "Drop anchor, rookie."], rematch: "The tide always comes back. So do I.",
    tip: "Annie's ANCHOR DROP can't be ducked. Slip it left or right, then unload." },
  vinnie: { name: 'Vinnie Velvet', title: 'Neon Strip lounge singer', hp: 106, dmg: 0.9, speed: 1.1, idle: [0.9, 1.8], guard: 0.9, adapt: 0.35, taunt: 0.15, feint: 0.15, combo: 0.15, grit: 0.6, maxCombo: 4,
    atk: { jabL: 2, jabR: 2, hookL: 2, hookR: 2, body: 1 }, skin: '#f1c27d', hair: '#2d3436', style: 'pomp', trunks: '#6c5ce7', glove: '#fd79a8', build: 1.0, purse: 80,
    lines: ["Let me sing you a lullaby, sweetheart.", "Mind the suit. It's velvet."], rematch: "An encore? Half price.",
    tip: "Vinnie fakes. If the glove twitches and stops, don't dodge yet." },
  tess: { name: 'Turbo Tess', title: 'Street racer', hp: 100, dmg: 0.8, speed: 1.28, idle: [0.7, 1.4], guard: 0.8, adapt: 0.3, taunt: 0.05, feint: 0.05, combo: 0.3, grit: 0.55, maxCombo: 4,
    atk: { jabL: 4, jabR: 4, body: 2 }, skin: '#c68642', hair: '#e84118', style: 'pony', trunks: '#273c75', glove: '#fbc531', build: 0.92, purse: 85,
    lines: ["Zero to KO in four seconds.", "Try to keep up!"], rematch: "Rematch? Green light. Half purse.",
    tip: "Tess is fast but light. Block her jabs and counter in the gaps." },
  dmitri: { name: 'Disco Dmitri', title: 'Neon Palace champion', hp: 165, dmg: 1.1, speed: 1.25, idle: [0.8, 1.6], guard: 0.9, adapt: 0.5, taunt: 0.15, feint: 0.25, combo: 0.3, grit: 0.85, maxCombo: 3,
    atk: { jabL: 3, jabR: 3, hookL: 2, hookR: 2, upper: 2, body: 2, special: 1 }, special: { name: 'MIRRORBALL SMASH', avoid: 'duck' },
    skin: '#ffe0bd', hair: '#130f40', style: 'pomp', trunks: '#f0932b', glove: '#e056fd', build: 1.05, purse: 500, belt: 'neon', stache: true,
    lines: ["The dance floor is MY ring, darling.", "Feel the rhythm. Feel the pain."], rematch: "The night is young. Encore!",
    tip: "Dmitri feints a lot. When he spins up the MIRRORBALL SMASH, DUCK." },
  gunnar: { name: 'Grizzly Gunnar', title: 'Mountain woodsman', hp: 132, dmg: 1.2, speed: 1.12, idle: [1.0, 1.8], guard: 1.1, adapt: 0.35, taunt: 0.1, feint: 0, combo: 0.2, grit: 0.7, maxCombo: 4,
    atk: { jabL: 2, jabR: 2, hookL: 3, hookR: 3, upper: 1 }, skin: '#f0c8a0', hair: '#7f3300', style: 'beard', trunks: '#2d6a4f', glove: '#6d4c41', build: 1.3, purse: 120,
    lines: ["I wrestle bears for fun. You're smaller.", "TIMBER!"], rematch: "Again? The bears are busy anyway.",
    tip: "Gunnar's hooks hit hard. Duck them." },
  malone: { name: 'Monk Malone', title: 'Wandering ascetic', hp: 120, dmg: 1.0, speed: 1.38, idle: [0.8, 1.5], guard: 0.7, adapt: 0.65, taunt: 0.05, feint: 0.1, combo: 0.25, grit: 0.7, maxCombo: 3,
    atk: { jabL: 3, jabR: 3, body: 2, upper: 2 }, skin: '#d2a679', hair: '#000000', style: 'bald', trunks: '#e1b12c', glove: '#c23616', build: 0.95, purse: 130,
    lines: ["The fist that is not thrown cannot miss.", "Breathe. Then fall down."], rematch: "We meet again. The purse, like the self, is diminished.",
    tip: "Malone reads your punches. Mix head and body, and wait for his misses." },
  kronos: { name: 'King Kronos', title: 'Summit Temple champion', hp: 210, dmg: 1.35, speed: 1.4, idle: [0.7, 1.4], guard: 0.8, adapt: 0.6, taunt: 0.1, feint: 0.15, combo: 0.4, grit: 0.92, maxCombo: 3,
    atk: { jabL: 3, jabR: 3, hookL: 2, hookR: 2, upper: 2, body: 2, special: 2 }, special: { name: 'THUNDERFALL', avoid: 'dodge' },
    skin: '#a0522d', hair: '#ecf0f1', style: 'crown', trunks: '#8e1b1b', glove: '#f1c40f', build: 1.25, purse: 1000, belt: 'summit',
    lines: ["Kneel, and I may let you walk down the mountain.", "Four belts. One king."], rematch: "The crown fits you poorly. Let me take it back.",
    tip: "Kronos chains combos. THUNDERFALL can only be dodged left or right. Stay calm and count his punches." },
  phantom: { name: 'The Phantom', title: 'Legend of the Sealed Ring', hp: 250, dmg: 1.5, speed: 1.6, idle: [0.6, 1.2], guard: 0.7, adapt: 0.7, taunt: 0.08, feint: 0.3, combo: 0.45, grit: 0.95, maxCombo: 3,
    atk: { jabL: 3, jabR: 3, hookL: 2, hookR: 2, upper: 2, body: 2, special: 2 }, special: { name: 'VANISHING FIST', avoid: 'duck' },
    skin: '#9aa5b1', hair: '#000000', style: 'hood', trunks: '#111111', glove: '#ecf0f1', build: 1.1, purse: 2000, glow: '#74f2ce',
    lines: ["...", "You collected the stars. Now you face the dark between them."], rematch: "...again.",
    tip: "The Phantom fakes constantly. Only react to the flash. VANISHING FIST: duck." }
};

const GLOVES = [{ name: 'Leather Gloves', price: 60 }, { name: 'Pro Gloves', price: 150 }, { name: 'Iron Gloves', price: 320 }, { name: 'Golden Gloves', price: 650 }];
const CAP = { power: 9, stamina: 6, speed: 6, defense: 6 };
const need = l => 3 + l * 2;
const GOSSIP = [
  "Street fighters pay out every time, but only half after the first beating.",
  "Land a punch right after a miss and it counts double. Counters earn STARS.",
  "A face punch thrown early in an opponent's wind-up stops the punch cold.",
  "Getting hit wipes out your stars. Spend 'em with SPACE before you lose 'em.",
  "When you run out of hearts you get winded. Blocked punches cost hearts.",
  "Somebody saw a gold star glinting at the end of the Docks pier.",
  "There's a star badge up in the snow, far northwest corner.",
  "A badge is hiding in the far corner of Rookie Row, past the trees.",
  "Neon Strip's southeast corner, by the river. Shiny. That's all I'll say.",
  "Summit Ridge, down by the river bend in the southeast. Look sharp."
];

// ---------------------------------------------------------------- save
const NEW_SAVE = () => ({ v: 1, px: 10.5 * TS, py: 57.6 * TS, money: 40, power: 1, stamina: 1, speed: 1, defense: 1, gloves: 0,
  xp: { power: 0, stamina: 0, speed: 0, defense: 0 }, shakes: 1, belts: [], badges: [], wins: 0, losses: 0, kos: 0, beaten: {}, flags: {} });
let S = null;
function save() { if (!S) return; S.px = pl.x; S.py = pl.y; try { localStorage.setItem('kk_save', JSON.stringify(S)); } catch (e) { } }
function loadSave() { try { const s = JSON.parse(localStorage.getItem('kk_save')); return s && s.v === 1 ? s : null; } catch (e) { return null; } }
const PS = {
  maxHP: () => 100 + (S.defense - 1) * 12,
  maxHearts: () => 14 + S.stamina * 6 + S.badges.length * 3,
  dmg: () => 2 + S.power * 1.6,
  taken: () => 1 - (S.defense - 1) * 0.07,
  spd: () => 1 + (S.speed - 1) * 0.09
};

// ---------------------------------------------------------------- map
const MW = 112, MH = 84;
const T = { GRASS: 0, ROAD: 1, WATER: 2, TREE: 3, WALL: 4, SAND: 5, BRIDGE: 7, BOULDER: 8, SNOW: 9, DOOR: 10, GATE: 11, FLOWER: 12, PLANK: 13, NEON: 14, STONE: 15, LAMP: 16, CRATE: 17 };
const SOLID = new Set([T.WATER, T.TREE, T.WALL, T.BOULDER, T.DOOR, T.GATE, T.LAMP, T.CRATE]);
const BASE = new Set([T.GRASS, T.SAND, T.SNOW, T.NEON, T.STONE]);
const map = new Uint8Array(MW * MH);
const gt = (x, y) => (x < 0 || y < 0 || x >= MW || y >= MH) ? T.WATER : map[y * MW + x];
const st = (x, y, t) => { if (x >= 0 && y >= 0 && x < MW && y < MH) map[y * MW + x] = t; };
const fill = (x, y, w, h, t) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) st(i, j, t); };
const BUILD = [], DOORS = {};
const BSTYLE = {
  gym: { wall: '#8a3b2e', roof: '#c0392b' }, diner: { wall: '#e8dcc0', roof: '#2e86c1' }, shop: { wall: '#bdc3c7', roof: '#27ae60' },
  home: { wall: '#c8a27a', roof: '#7d4e2d' }, house: { wall: '#d6c3a5', roof: '#95a5a6' }, warehouse: { wall: '#7f8c8d', roof: '#566573' },
  club: { wall: '#2d1b3d', roof: '#8e44ad' }, secret: { wall: '#2d3436', roof: '#111111' }, hut: { wall: '#a1887f', roof: '#5d4037' }
};
function regionAt(tx, ty) { return ty >= 42 ? (tx < 51 ? 'rookie' : 'docks') : (tx < 51 ? 'summit' : 'neon'); }
const GATES = [
  { tiles: [[54, 58], [54, 59]], belt: 'rookie' },
  { tiles: [[80, 39], [81, 39]], belt: 'docks' },
  { tiles: [[48, 20], [48, 21]], belt: 'neon' }
];
const BADGES = [{ id: 0, x: 5, y: 76 }, { id: 1, x: 71, y: 79 }, { id: 2, x: 106, y: 37 }, { id: 3, x: 5, y: 4 }, { id: 4, x: 46, y: 37 }];
function addB(x, y, w, h, type, name, extra = {}) {
  const b = Object.assign({ x, y, w, h, type, name }, extra);
  fill(x, y, w, h, T.WALL); b.dx = x + Math.floor(w / 2); b.dy = y + h - 1; st(b.dx, b.dy, T.DOOR);
  DOORS[b.dx + ',' + b.dy] = b; BUILD.push(b); return b;
}
let minimap = null;
function buildWorld() {
  const R = mulberry(1337);
  fill(0, 0, MW, MH, T.WATER);
  fill(3, 44, 46, 34, T.GRASS);
  fill(54, 44, 55, 30, T.SAND);
  fill(54, 3, 55, 37, T.NEON);
  fill(3, 3, 46, 37, T.STONE);
  fill(3, 3, 46, 9, T.SNOW);
  // roads
  fill(3, 58, 46, 2, T.ROAD); fill(24, 44, 2, 34, T.ROAD);
  fill(54, 58, 55, 2, T.ROAD); fill(80, 44, 2, 28, T.ROAD);
  fill(54, 20, 55, 2, T.ROAD); fill(80, 3, 2, 37, T.ROAD);
  fill(3, 20, 46, 2, T.ROAD); fill(22, 10, 2, 30, T.ROAD);
  // boardwalk + pier
  fill(54, 72, 55, 2, T.PLANK); fill(70, 74, 3, 6, T.PLANK);
  // bridges
  fill(49, 58, 5, 2, T.BRIDGE); fill(80, 40, 2, 4, T.BRIDGE); fill(49, 20, 5, 2, T.BRIDGE);
  for (const g of GATES) for (const [x, y] of g.tiles) st(x, y, T.GATE);
  // buildings
  addB(8, 52, 5, 4, 'home', 'Home');
  addB(14, 46, 8, 6, 'gym', 'Rookie Row Gym', { champ: 'buster' });
  addB(30, 51, 6, 4, 'diner', "Mabel's Diner");
  addB(36, 62, 6, 4, 'shop', 'Glove Box');
  addB(10, 64, 5, 4, 'house', 'Cottage'); addB(28, 68, 5, 4, 'house', 'Cottage'); addB(40, 46, 5, 4, 'house', 'Cottage');
  addB(64, 48, 8, 6, 'gym', 'Iron Docks Gym', { champ: 'annie' });
  addB(88, 62, 6, 4, 'diner', 'Galley Grill');
  addB(60, 63, 6, 4, 'shop', 'Glove Box');
  addB(88, 46, 8, 6, 'warehouse', 'Warehouse 7'); addB(97, 46, 8, 6, 'warehouse', 'Warehouse 9'); addB(98, 62, 7, 5, 'warehouse', 'Cold Storage');
  addB(64, 8, 9, 6, 'gym', 'Neon Palace', { champ: 'dmitri' });
  addB(88, 26, 6, 4, 'diner', 'Midnight Diner');
  addB(60, 27, 6, 4, 'shop', 'Glove Box');
  addB(88, 7, 7, 5, 'club', 'Club Voltage'); addB(98, 7, 6, 5, 'club', 'The Velvet Room'); addB(98, 27, 6, 5, 'club', 'Arcade');
  addB(17, 4, 10, 6, 'gym', 'Summit Temple', { champ: 'kronos' });
  addB(30, 24, 6, 4, 'hut', 'Hot Spring Hut', { diner: true });
  addB(8, 24, 6, 4, 'shop', 'Glove Box');
  addB(36, 5, 7, 5, 'secret', 'Sealed Ring');
  // decoration
  const nearDoor = (x, y) => BUILD.some(b => Math.abs(x - b.dx) <= 2 && y - b.dy >= -1 && y - b.dy <= 3);
  const free = (x, y) => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const t = gt(x + i, y + j); if (!BASE.has(t) && t !== T.TREE && t !== T.FLOWER && t !== T.BOULDER) return false; }
    return !nearDoor(x, y);
  };
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const t = gt(x, y); if (!BASE.has(t) || !free(x, y)) continue; const r = R();
    if (t === T.GRASS) { if (r < 0.07) st(x, y, T.TREE); else if (r < 0.12) st(x, y, T.FLOWER); }
    else if (t === T.STONE) { if (r < 0.045) st(x, y, T.BOULDER); else if (r < 0.085) st(x, y, T.TREE); }
    else if (t === T.SNOW) { if (r < 0.06) st(x, y, T.TREE); else if (r < 0.08) st(x, y, T.BOULDER); }
    else if (t === T.SAND) { if (r < 0.03) st(x, y, T.CRATE); }
    else if (t === T.NEON) { if (r < 0.025) st(x, y, T.LAMP); }
  }
  const clearAround = (cx, cy, rad) => { for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) { const t = gt(cx + i, cy + j); if (t === T.TREE || t === T.BOULDER || t === T.LAMP || t === T.CRATE || t === T.FLOWER) st(cx + i, cy + j, baseFor(cx + i, cy + j)); } };
  const baseFor = (x, y) => { const r = regionAt(x, y); return r === 'rookie' ? T.GRASS : r === 'docks' ? T.SAND : r === 'neon' ? T.NEON : (y < 12 ? T.SNOW : T.STONE); };
  for (const b of BADGES) clearAround(b.x, b.y, 1);
  for (const n of NPC_DEFS) clearAround(n.x, n.y, 2);
  clearAround(10, 57, 2);
}
function applyGates() {
  for (const g of GATES) for (const [x, y] of g.tiles) st(x, y, S && S.belts.includes(g.belt) ? T.BRIDGE : T.GATE);
  buildMinimap();
}
const TILECOL = { 0: '#5a9e4b', 1: '#b39b72', 2: '#2f6fb3', 3: '#2f6b2f', 4: '#555', 5: '#d8c48a', 7: '#8b5a2b', 8: '#7f8c8d', 9: '#eef3f7', 10: '#4a2c17', 11: '#e74c3c', 12: '#6fb35a', 13: '#9b6b3d', 14: '#2a2a44', 15: '#8c8f86', 16: '#ff6bd6', 17: '#a0763c' };
function buildMinimap() {
  minimap = document.createElement('canvas'); minimap.width = MW * 4; minimap.height = MH * 4; const m = minimap.getContext('2d');
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) { m.fillStyle = TILECOL[gt(x, y)] || '#000'; m.fillRect(x * 4, y * 4, 4, 4); }
  for (const b of BUILD) { m.fillStyle = BSTYLE[b.type].roof; m.fillRect(b.x * 4, b.y * 4, b.w * 4, b.h * 4); }
}

// ---------------------------------------------------------------- NPCs
const NPC_DEFS = [
  { id: 'coach', name: 'Coach Mabel', x: 13, y: 57, c: { skin: '#e0ac69', shirt: '#e67e22', pants: '#34495e', hair: '#dddddd' } },
  { name: 'Jogger Jen', x: 27, y: 50, wander: 3, c: { skin: '#c68642', shirt: '#16a085', pants: '#2c3e50', hair: '#111' }, lines: ["Hold SHIFT to jog. Champions do roadwork!", "I've jogged this whole road a hundred times. Never seen the river this calm."] },
  { name: 'Old Sal', x: 34, y: 60, c: { skin: '#f1c27d', shirt: '#7f8c8d', pants: '#5d4037', hair: '#eee' }, lines: ["They say five Golden Star Badges are hidden around the Kingdom.", "Each one makes your heart stronger. Collect all five and the Sealed Ring up on Summit Ridge might open..."] },
  { name: 'Kid Kev', x: 18, y: 62, wander: 2, c: { skin: '#ffdbac', shirt: '#f1c40f', pants: '#2980b9', hair: '#8d5524' }, lines: ["Buster Brickman covers his face once you tag it a couple times. Then go to the body!", "Body shot: Z or X. Face shot: hold UP and press Z or X."] },
  { name: 'Dockhand Dee', x: 75, y: 60, wander: 2, c: { skin: '#8d5524', shirt: '#2980b9', pants: '#34495e', hair: '#222' }, lines: ["Anchor Annie's ANCHOR DROP can't be ducked. Slip it left or right!"] },
  { name: 'Fishmonger Flo', x: 67, y: 70, c: { skin: '#f1c27d', shirt: '#1abc9c', pants: '#7f8c8d', hair: '#c0392b' }, lines: ["The pier's longer than it looks. Something shiny out at the end, they say."] },
  { name: 'DJ Lumen', x: 76, y: 24, wander: 2, c: { skin: '#e0ac69', shirt: '#e84393', pants: '#2d3436', hair: '#74b9ff' }, lines: ["Dmitri fakes you out. Wait for the flash; don't flinch at the twitch."] },
  { name: 'Bouncer Boyd', x: 91, y: 13, c: { skin: '#8d5524', shirt: '#2d3436', pants: '#2d3436', hair: '#000' }, lines: ["Club's closed tonight. Fights are at the Neon Palace."] },
  { name: 'Hermit Hu', x: 26, y: 30, wander: 1, c: { skin: '#d2a679', shirt: '#a29bfe', pants: '#6c5ce7', hair: '#bbb' }, lines: ["King Kronos never tires. Neither should you. Train your stamina with the jump rope."] },
  { name: 'Climber Cass', x: 12, y: 13, c: { skin: '#ffdbac', shirt: '#fd79a8', pants: '#2d3436', hair: '#f9ca24' }, lines: ["Brr! Up here you can see the whole Kingdom. Press M for your map."] }
];
const FIGHTERS = [
  { opp: 'al', x: 30, y: 63 }, { opp: 'pete', x: 12, y: 72 }, { opp: 'bev', x: 76, y: 66 }, { opp: 'crane', x: 95, y: 56 },
  { opp: 'vinnie', x: 92, y: 17 }, { opp: 'tess', x: 62, y: 17 }, { opp: 'gunnar', x: 34, y: 33 }, { opp: 'malone', x: 10, y: 17 }
];
let NPC = [];
function makeNPCs() {
  NPC = NPC_DEFS.map(d => ({ ...d, hx: (d.x + .5) * TS, hy: (d.y + .7) * TS, x: (d.x + .5) * TS, y: (d.y + .7) * TS, dir: 'down', ph: 0, t: rr(0, 3), tx: null, ty: null }));
  for (const f of FIGHTERS) {
    const o = OPP[f.opp];
    NPC.push({ name: o.name, fighter: f.opp, x: (f.x + .5) * TS, y: (f.y + .7) * TS, hx: (f.x + .5) * TS, hy: (f.y + .7) * TS, wander: 2, dir: 'down', ph: 0, t: rr(0, 3),
      c: { skin: o.skin, shirt: o.trunks, pants: shade(o.trunks, -0.3), hair: o.hair, glove: o.glove } });
  }
}

// ---------------------------------------------------------------- world state
const pl = { x: 0, y: 0, dir: 'down', ph: 0, moving: false };
let mode = 'title', ui = null, showMap = false, curRegion = '', bannerT = 0, worldTime = 0, toastT = 0, toast = '';
function blocked(x, y, r) {
  const pts = [[x - r, y - 4], [x + r, y - 4], [x - r, y + 6], [x + r, y + 6]];
  for (const [px, py] of pts) if (SOLID.has(gt(Math.floor(px / TS), Math.floor(py / TS)))) return true;
  return false;
}
function moveEnt(e, dx, dy, r) { if (!blocked(e.x + dx, e.y, r)) e.x += dx; if (!blocked(e.x, e.y + dy, r)) e.y += dy; }
const DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
function showToast(s) { toast = s; toastT = 2.5; }

function updWorld(dt) {
  worldTime += dt;
  if (hit('menu')) { openPause(); return; }
  if (hit('map')) showMap = !showMap;
  if (showMap) { if (adv()) showMap = false; return; }
  let dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0), dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (dx || dy) {
    const l = Math.hypot(dx, dy); dx /= l; dy /= l; const sp = keys.run ? 240 : 145;
    moveEnt(pl, dx * sp * dt, dy * sp * dt, 9); pl.ph += dt * (keys.run ? 16 : 10); pl.moving = true;
    pl.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
  } else pl.moving = false;
  for (const b of BADGES) {
    if (!S.badges.includes(b.id) && Math.hypot(pl.x - (b.x + .5) * TS, pl.y - (b.y + .5) * TS) < 24) {
      S.badges.push(b.id); S.money += 60; SFX.star(); save();
      say('Golden Star Badge', [`You found a Golden Star Badge! (${S.badges.length}/5)`, 'Your heart grows stronger: +3 max hearts, and $60 tucked behind it.' + (S.badges.length === 5 ? ' That was the last one... you hear a rumble from Summit Ridge.' : '')]);
    }
  }
  for (const n of NPC) updNPC(n, dt);
  const rg = regionAt(pl.x / TS, pl.y / TS); if (rg !== curRegion) { curRegion = rg; bannerT = 3; }
  bannerT -= dt; toastT -= dt;
  if (hit('act') || hit('star') || hit('pl')) interact();
}
function updNPC(n, dt) {
  if (!n.wander) return; n.t -= dt;
  if (n.t <= 0) {
    n.t = rr(1.5, 4);
    if (Math.random() < 0.6) { n.tx = n.hx + rr(-n.wander, n.wander) * TS; n.ty = n.hy + rr(-n.wander, n.wander) * TS; } else n.tx = null;
  }
  if (n.tx != null) {
    const dx = n.tx - n.x, dy = n.ty - n.y, d = Math.hypot(dx, dy);
    if (d < 3) { n.tx = null; return; }
    const sp = 38 * dt, ox = n.x, oy = n.y; moveEnt(n, dx / d * sp, dy / d * sp, 8); n.ph += dt * 8;
    if (Math.abs(n.x - ox) + Math.abs(n.y - oy) < 0.1) n.tx = null;
    n.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
  }
}
function interact() {
  const v = DIRV[pl.dir]; const fx = pl.x + v[0] * 26, fy = pl.y + v[1] * 26 - 4;
  let best = null, bd = 30;
  for (const n of NPC) { const d = Math.hypot(n.x - fx, n.y - fy); if (d < bd) { bd = d; best = n; } }
  if (best) return talk(best);
  const tx = Math.floor(fx / TS), ty = Math.floor(fy / TS), t = gt(tx, ty);
  if (t === T.DOOR) { const b = DOORS[tx + ',' + ty]; if (b) return enterBuilding(b); }
  if (t === T.GATE) {
    const g = GATES.find(G => G.tiles.some(([x, y]) => x === tx && y === ty));
    if (g) say('Gatekeeper', [`No belt, no bridge. Come back with the ${REG[g.belt].name} belt.`]);
  }
}
function faceTo(n) { const dx = pl.x - n.x, dy = pl.y - n.y; n.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'); n.tx = null; n.t = 3; }
function purseFor(oid, type) {
  const d = OPP[oid], n = S.beaten[oid] || 0;
  if (type === 'champ') return S.belts.includes(d.belt) ? Math.round(d.purse * 0.3) : d.purse;
  if (type === 'secret') return n ? Math.round(d.purse * 0.25) : d.purse;
  return n ? Math.round(d.purse / 2) : d.purse;
}
function talk(n) {
  faceTo(n);
  if (n.fighter) {
    const d = OPP[n.fighter], beaten = S.beaten[n.fighter], purse = purseFor(n.fighter, 'street');
    return choose(d.name, beaten ? d.rematch : pick(d.lines), [
      { label: `Put up your dukes! (purse $${purse})`, fn: () => preFight(n.fighter, { type: 'street' }) },
      { label: 'Not now' }]);
  }
  if (n.id === 'coach') return say('Coach Mabel', coachLines());
  say(n.name, n.lines);
}
function coachLines() {
  const b = S.belts.length;
  if (!S.flags.met) { S.flags.met = true; return [
    "There you are, kid! Welcome to the Knockout Kingdom.",
    "Four regions, four gyms, four champions. Win a belt and the Gatekeepers open the bridges to the next region.",
    "Walk with the arrow keys or WASD; hold SHIFT to jog. Press E, ENTER or SPACE to talk and to enter doors.",
    "Street fighters wander around. Beat them for cash, buy better gloves at the Glove Box, and train at any gym.",
    "Rookie Row Gym is just north of here. Press M for the map, ESC for the menu. Now go make me proud!"]; }
  if (S.flags.phantom) return ["You beat a legend, kid. There's nothing left to teach you.", "Well... maybe how to cook. Go see the diner."];
  if (b === 0) return ["Rookie Row Gym is north of here. Buster Brickman holds the belt.", "Warm up on Alley Al and Pretzel Pete first. Watch for the flash before a punch, dodge, then counter!"];
  if (b === 1) return ["The bridge east to the Iron Docks is open. Anchor Annie runs that gym.", "Uppercuts can't be blocked. Dodge left or right."];
  if (b === 2) return ["The north bridge from the Docks leads to the Neon Strip. Dmitri's a showboat; don't bite on his fakes."];
  if (b === 3) return ["The west bridge from the Neon Strip goes up to Summit Ridge. King Kronos is the real deal.", "Max out your training before you climb."];
  if (S.badges.length < 5) return ["Kingdom Champion! I knew it.", `But folks whisper about a Sealed Ring on Summit Ridge, and five Golden Star Badges. You've got ${S.badges.length}.`];
  return ["All four belts AND all five badges. The Sealed Ring on Summit Ridge is waiting for you.", "Whatever's in there... keep your hands up."];
}
function preFight(oid, info) {
  if (!S.flags.tut) {
    S.flags.tut = true;
    return say('Coach Mabel', [
      "First fight? Listen close.",
      "LEFT / RIGHT arrows dodge. Hold DOWN to block. C ducks.",
      "Z and X throw left and right jabs to the body. Hold UP while you punch to go for the face.",
      "When your opponent winds up, his glove FLASHES. Dodge, then hit him while he's off balance: that's a COUNTER, worth double, and it earns a STAR.",
      "Press SPACE to spend a star on a Star Uppercut. Getting hit loses your stars, so use 'em!",
      "Blocked punches cost hearts. Run out and you're winded for a few seconds. Now get in there!"
    ], () => startFight(oid, info));
  }
  startFight(oid, info);
}
function enterBuilding(b) {
  if (b.type === 'home') return choose('Home', 'Your tiny apartment. Smells like liniment.', [
    { label: 'Rest & save game', fn: () => { save(); SFX.coin(); say('Home', ['Game saved. You feel rested.']); } }, { label: 'Leave' }]);
  if (b.type === 'gym') {
    const c = OPP[b.champ], has = S.belts.includes(c.belt);
    return choose(b.name, has ? `The ${REG[c.belt].name} belt is yours. ${c.name} wants it back.` : `${c.name}, ${c.title}, holds the ${REG[c.belt].name} belt.`, [
      { label: has ? `Title defense vs ${c.name} ($${purseFor(b.champ, 'champ')})` : `Challenge ${c.name} for the belt ($${c.purse})`, fn: () => say(c.name, [has ? c.rematch : c.lines[0]], () => preFight(b.champ, { type: 'champ' })) },
      { label: 'Train ($25 per drill)', fn: () => trainMenu() },
      { label: 'Leave' }]);
  }
  if (b.type === 'diner' || b.diner) return choose(b.name, '"What\'ll it be, champ?"', [
    { label: `Protein Shake $20 (carrying ${S.shakes}/3)`, fn: () => {
      if (S.shakes >= 3) return say('Cook', ["You can't carry more than three, hon."]);
      if (S.money < 20) return say('Cook', ["Twenty bucks. No credit."]);
      S.money -= 20; S.shakes++; SFX.coin(); save(); say('Cook', ["Here ya go. Drink it between rounds with Q."]);
    } },
    { label: 'Ask for gossip', fn: () => say('Cook', [pick(GOSSIP)]) },
    { label: 'Leave' }]);
  if (b.type === 'shop') {
    const opts = [];
    if (S.gloves < GLOVES.length) {
      const gl = GLOVES[S.gloves];
      opts.push({ label: `${gl.name} $${gl.price} (+1 power)`, fn: () => {
        if (S.money < gl.price) return say('Clerk', [`${gl.name} are $${gl.price}. Come back when you've got it.`]);
        S.money -= gl.price; S.gloves++; S.power = Math.min(CAP.power, S.power + 1); SFX.coin(); save();
        say('Clerk', [`${gl.name}! Power is now ${S.power}.`]);
      } });
    } else opts.push({ label: 'Sold out: you own the Golden Gloves', fn: () => say('Clerk', ['Nothing better than gold, champ.']) });
    opts.push({ label: 'Leave' });
    return choose(b.name, 'Racks of gloves, wraps and mouthguards.', opts);
  }
  if (b.type === 'secret') {
    if (S.belts.length < 4 || S.badges.length < 5) return say('Sealed Ring', ['A heavy door with five star-shaped slots and four belt hooks. It will not budge.', `Belts: ${S.belts.length}/4   Badges: ${S.badges.length}/5`]);
    return choose('Sealed Ring', 'The door swings open. A hooded figure waits in a dark ring.', [
      { label: 'Step into the ring', fn: () => say('The Phantom', OPP.phantom.lines.slice(S.flags.phantom ? 0 : 0), () => preFight('phantom', { type: 'secret' })) },
      { label: 'Back away' }]);
  }
  say(b.name, [pick(['Nobody answers.', 'A dog barks inside.', '"We already gave at the office!"', 'You hear a TV playing an old fight.', 'Locked tight.'])]);
}
function trainMenu() {
  const lab = (n, s, d) => `${n} - ${d} (Lv ${S[s]}${S[s] >= CAP[s] ? ' MAX' : ''})`;
  choose('Trainer', 'Pick a drill. $25 a session. Hit the timing window!', [
    { label: lab('Heavy Bag', 'power', 'Power'), fn: () => startTrain('power') },
    { label: lab('Jump Rope', 'stamina', 'Stamina'), fn: () => startTrain('stamina') },
    { label: lab('Focus Mitts', 'speed', 'Speed'), fn: () => startTrain('speed') },
    { label: lab('Sparring', 'defense', 'Defense'), fn: () => startTrain('defense') },
    { label: 'Leave' }]);
}

// ---------------------------------------------------------------- UI (dialog / choice)
function say(who, lines, cb) { ui = { type: 'dialog', who, lines: Array.isArray(lines) ? lines : [lines], i: 0, t: 0, cb }; }
function choose(who, textS, opts) { ui = { type: 'choice', who, text: textS, opts, sel: 0, t: 0 }; }
function updUI(dt) {
  ui.t += dt;
  if (ui.type === 'dialog') {
    const full = ui.lines[ui.i]; const shown = Math.floor(ui.t * 70);
    if (adv() && ui.t > 0.1) {
      if (shown < full.length) ui.t = 999;
      else { ui.i++; ui.t = 0; SFX.blip(); if (ui.i >= ui.lines.length) { const cb = ui.cb; ui = null; if (cb) cb(); } }
    }
  } else {
    if (hit('up')) { ui.sel = (ui.sel + ui.opts.length - 1) % ui.opts.length; SFX.blip(); }
    if (hit('down')) { ui.sel = (ui.sel + 1) % ui.opts.length; SFX.blip(); }
    if (hit('menu')) { ui = null; return; }
    if (adv() && ui.t > 0.15) { const o = ui.opts[ui.sel]; ui = null; SFX.blip(); if (o.fn) o.fn(); }
  }
}
function drawUI() {
  if (!ui) return;
  const x = 40, w = W - 80;
  if (ui.type === 'dialog') {
    const h = 130, y = H - h - 16; panel(x, y, w, h);
    text(ui.who, x + 18, y + 28, '#f5c542', 18);
    const full = ui.lines[ui.i]; const shown = full.slice(0, Math.floor(ui.t * 70));
    wrap(shown, w - 40, 18).forEach((ln, i) => text(ln, x + 18, y + 56 + i * 24, '#fff', 18, 'left', false));
    if (shown.length >= full.length && Math.floor(worldTime * 3 + ui.t * 3) % 2) text('▼', x + w - 28, y + h - 14, '#f5c542', 16);
  } else {
    const lines = wrap(ui.text, w - 40, 17); const h = 50 + lines.length * 22 + ui.opts.length * 30; const y = H - h - 16;
    panel(x, y, w, h); text(ui.who, x + 18, y + 28, '#f5c542', 18);
    lines.forEach((ln, i) => text(ln, x + 18, y + 54 + i * 22, '#ddd', 17, 'left', false));
    ui.opts.forEach((o, i) => {
      const yy = y + 60 + lines.length * 22 + i * 30;
      if (i === ui.sel) { ctx.fillStyle = 'rgba(245,197,66,.18)'; ctx.fillRect(x + 12, yy - 20, w - 24, 28); }
      text((i === ui.sel ? '▶ ' : '  ') + o.label, x + 22, yy, i === ui.sel ? '#fff' : '#aab', 18, 'left', false);
    });
  }
}

// ---------------------------------------------------------------- pause / status
function openPause() {
  choose('Paused', `$${S.money}   Belts ${S.belts.length}/4   Badges ${S.badges.length}/5   Record ${S.wins}-${S.losses}`, [
    { label: 'Resume' },
    { label: 'Status', fn: () => { mode = 'status'; } },
    { label: 'Boxing controls', fn: () => say('Controls', [
      'WORLD: arrows/WASD move, SHIFT jog, E/ENTER/SPACE talk & enter, M map, ESC menu.',
      'FIGHT: LEFT/RIGHT dodge, hold DOWN block, C duck. Z/X body jabs; hold UP + Z/X for face shots. SPACE star uppercut. Q drinks a shake between rounds.',
      'Hooks: slip AWAY from the glove or duck. Uppercuts: dodge only. Body blows: block or dodge. Specials: watch the coach tip.']) },
    { label: 'Save game', fn: () => { save(); SFX.coin(); say('', ['Game saved.']); } },
    { label: 'Quit to title', fn: () => { save(); mode = 'title'; titleSel = 0; } }]);
}
function drawStatus() {
  drawWorld(); ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, W, H);
  panel(120, 50, 720, 440); text('STATUS', 480, 92, '#f5c542', 26, 'center');
  const rows = [
    ['Money', '$' + S.money], ['Record', `${S.wins} W - ${S.losses} L (${S.kos} KO)`],
    ['Power', `${S.power}/${CAP.power}  (${GLOVES[S.gloves - 1] ? GLOVES[S.gloves - 1].name : 'Hand wraps'})`],
    ['Stamina', `${S.stamina}/${CAP.stamina}  (${PS.maxHearts()} hearts)`], ['Speed', `${S.speed}/${CAP.speed}`],
    ['Defense', `${S.defense}/${CAP.defense}  (${PS.maxHP()} HP)`], ['Protein Shakes', S.shakes + '/3'],
    ['Star Badges', S.badges.length + '/5']];
  rows.forEach(([a, b], i) => { text(a, 170, 140 + i * 32, '#aab', 18, 'left', false); text(b, 400, 140 + i * 32, '#fff', 18, 'left', false); });
  text('BELTS', 170, 410, '#aab', 18, 'left', false);
  BELT_ORDER.forEach((k, i) => { const has = S.belts.includes(k); drawBelt(410 + i * 100, 404, has ? REG[k].col : '#333', has); text(REG[k].name, 410 + i * 100, 440, has ? '#fff' : '#555', 11, 'center', false); });
  text('Press any key', 480, 476, '#888', 14, 'center', false);
}
function drawBelt(x, y, col, lit) {
  ctx.fillStyle = shade(col, -0.3); ctx.fillRect(x - 40, y - 7, 80, 14);
  circle(x, y, 15, lit ? '#f5c542' : '#555'); circle(x, y, 9, col);
}

// ---------------------------------------------------------------- training
let TR = null;
function startTrain(stat) {
  if (S[stat] >= CAP[stat]) return say('Trainer', ["You've maxed that out, champ. Pick another drill."]);
  if (S.money < 25) return say('Trainer', ['Training costs $25. Go win some street fights.']);
  S.money -= 25; TR = { stat, tries: 0, max: 6, hits: 0, pos: 0, dir: 1, zone: rr(0.2, 0.8), zw: 0.22, fb: '', fbT: 0, done: false, t: 0, bag: 0 };
  mode = 'train';
}
function updTrain(dt) {
  const r = TR; r.t += dt; r.fbT -= dt; r.bag *= Math.pow(0.02, dt);
  if (!r.done) {
    r.pos += r.dir * dt * (0.9 + r.tries * 0.16); if (r.pos > 1) { r.pos = 1; r.dir = -1; } if (r.pos < 0) { r.pos = 0; r.dir = 1; }
    if (adv()) {
      const ok = Math.abs(r.pos - r.zone) < r.zw / 2;
      if (ok) { r.hits++; SFX.punch(); r.fb = pick(['NICE!', 'GREAT!', 'BOOM!']); r.bag = 1; } else { SFX.whiff(); r.fb = 'MISS'; }
      r.fbT = 0.6; r.tries++; r.zone = rr(0.15, 0.85); r.zw = Math.max(0.09, 0.22 - r.tries * 0.022);
      if (r.tries >= r.max) {
        r.done = true; r.t = 0; S.xp[r.stat] += r.hits; r.lv = 0;
        while (S[r.stat] < CAP[r.stat] && S.xp[r.stat] >= need(S[r.stat])) { S.xp[r.stat] -= need(S[r.stat]); S[r.stat]++; r.lv++; }
        if (S[r.stat] >= CAP[r.stat]) S.xp[r.stat] = 0;
        if (r.lv) SFX.win(); save();
      }
    }
  } else if (r.t > 0.6 && adv()) { mode = 'world'; }
}
function drawTrain() {
  const r = TR; const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#3b2f2f'); g.addColorStop(1, '#1b1414'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#5d4037'; ctx.fillRect(0, 380, W, 160);
  for (let i = 0; i < 12; i++) { ctx.fillStyle = i % 2 ? '#6d4c41' : '#5d4037'; ctx.fillRect(i * 80, 380, 80, 160); }
  const names = { power: 'HEAVY BAG', stamina: 'JUMP ROPE', speed: 'FOCUS MITTS', defense: 'SPARRING' };
  text(names[r.stat], 480, 60, '#f5c542', 32, 'center');
  text(`${r.stat.toUpperCase()} Lv ${S[r.stat]}   XP ${S.xp[r.stat]}/${need(S[r.stat])}`, 480, 92, '#ddd', 16, 'center');
  // prop
  const sw = Math.sin(r.t * 8) * 18 * r.bag;
  ctx.save(); ctx.translate(480, 110); ctx.rotate(sw * 0.01);
  ctx.strokeStyle = '#999'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 40); ctx.stroke();
  if (r.stat === 'power') { rrect(-45, 40, 90, 200, 30); ctx.fillStyle = '#8e2b2b'; ctx.fill(); ctx.fillStyle = '#6b1f1f'; ctx.fillRect(-45, 70, 90, 10); ctx.fillRect(-45, 200, 90, 10); }
  else if (r.stat === 'speed') { circle(-40, 160, 34, '#2980b9'); circle(40, 160, 34, '#2980b9'); circle(-40, 160, 18, '#fff'); circle(40, 160, 18, '#fff'); }
  else if (r.stat === 'stamina') { ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(0, 170, 120, 90 + Math.sin(r.t * 10) * 20, 0, 0, Math.PI * 2); ctx.stroke(); }
  else { ellipse(0, 150, 60, 80, '#34495e'); circle(0, 80, 30, '#e0ac69'); circle(-50, 120, 22, '#3498db'); circle(50, 120, 22, '#3498db'); }
  ctx.restore();
  // timing bar
  const bx = 180, by = 400, bw = 600;
  ctx.fillStyle = '#111'; ctx.fillRect(bx - 4, by - 4, bw + 8, 40);
  ctx.fillStyle = '#333'; ctx.fillRect(bx, by, bw, 32);
  ctx.fillStyle = '#2ecc71'; ctx.fillRect(bx + (r.zone - r.zw / 2) * bw, by, r.zw * bw, 32);
  ctx.fillStyle = '#fff'; ctx.fillRect(bx + r.pos * bw - 3, by - 8, 6, 48);
  for (let i = 0; i < r.max; i++) circle(400 + i * 32, 470, 10, i < r.tries ? (i < r.hits ? '#2ecc71' : '#555') : '#222');
  if (r.fbT > 0) text(r.fb, 480, 360, r.fb === 'MISS' ? '#e74c3c' : '#2ecc71', 36, 'center');
  if (!r.done) text('Press Z / SPACE / ENTER when the marker is in the green', 480, 515, '#aaa', 15, 'center');
  else {
    panel(260, 190, 440, 150);
    text(`${r.hits}/${r.max} hits  (+${r.hits} XP)`, 480, 240, '#fff', 22, 'center');
    text(r.lv ? `LEVEL UP! ${r.stat.toUpperCase()} is now ${S[r.stat]}` : `XP ${S.xp[r.stat]}/${need(S[r.stat])} to next level`, 480, 280, r.lv ? '#f5c542' : '#aaa', 18, 'center');
    text('Press any button', 480, 320, '#888', 14, 'center');
  }
}

// ---------------------------------------------------------------- fight
let F = null, crowd = [];
const ROUND_LEN = 60;
function makeCrowd(seed) {
  const R = mulberry(seed); const c = []; const cols = ['#e17055', '#fdcb6e', '#74b9ff', '#a29bfe', '#55efc4', '#fab1a0', '#dfe6e9', '#636e72', '#ff7675'];
  for (let row = 0; row < 6; row++) for (let i = 0; i < 34; i++) c.push({ x: i * 29 + (row % 2) * 14 + R() * 6, y: 70 + row * 26 + R() * 4, c: cols[Math.floor(R() * cols.length)], s: shade(['#f1c27d', '#c68642', '#8d5524', '#ffdbac', '#e0ac69'][Math.floor(R() * 5)], -0.3), ph: R() * 6 });
  return c;
}
function startFight(oid, info) {
  const d = OPP[oid];
  F = { oid, d, info, time: 0, phase: 'intro', phT: 0, round: 1, clock: 0, shake: 0, flash: 0, msgs: [], sparks: [], pts: { p: 0, o: 0 }, count: 0, countT: 0, result: null, paused: false,
    o: { hp: d.hp, max: d.hp, st: 'idle', t: 0, dur: 1.5, atk: null, ak: '', aSide: 1, guard: 'high', guardT: 1, nextGuard: null, combo: 0, kdR: 0, kdT: 0, enraged: false, missed: false, feint: false, queue: 0, hits: [], getUp: 99, told: false, hitSide: 'L', hitHigh: true, fallDir: 1 },
    p: { hp: PS.maxHP(), max: PS.maxHP(), hearts: PS.maxHearts(), maxH: PS.maxHearts(), stars: 0, st: 'idle', t: 0, side: 'L', high: false, resolved: false, tired: 0, kdR: 0, kdT: 0, mash: 0, need: 10 }
  };
  crowd = makeCrowd(oid.length * 977 + d.hp);
  mode = 'fight';
}
function msg(t, col = '#fff', big = false) { F.msgs.push({ text: t, col, big, t: 0 }); }
function spark(x, y, big) { F.sparks.push({ x, y, big, t: 0 }); }
function toIdle() {
  const o = F.o, d = F.d; o.st = 'idle'; o.t = 0; o.missed = false; o.told = false;
  o.dur = rr(d.idle[0], d.idle[1]) / (o.enraged ? 1.3 : 1);
  if (o.queue > 0) { o.queue--; o.dur = 0.14; }
}
function startAtk(k, durOverride) {
  const o = F.o, d = F.d; const a = ATK[k];
  o.ak = k; o.atk = a; o.st = 'windup'; o.t = 0; o.told = false; o.missed = false; o.combo = 0;
  o.aSide = a.side || (Math.random() < 0.5 ? -1 : 1);
  const spd = d.speed * (o.enraged ? 1.12 : 1);
  o.dur = durOverride || a.wind / spd;
  o.feint = !durOverride && k !== 'special' && Math.random() < d.feint;
  if (k === 'special') { msg(d.special.name + '!', '#ff5e5e', true); o.dur = a.wind / Math.min(spd, 1.3); }
}
function chooseAction() {
  const o = F.o, d = F.d;
  if (Math.random() < d.taunt) { o.st = 'taunt'; o.t = 0; o.dur = 1.1; msg('"' + pick(d.lines) + '"', '#ffd', false); return; }
  const entries = Object.entries(d.atk); let tot = 0;
  const wt = ([k, w]) => w * (k === 'special' && o.hp / o.max < 0.5 ? 2 : 1);
  for (const e of entries) tot += wt(e);
  let r = Math.random() * tot, k = entries[0][0];
  for (const e of entries) { r -= wt(e); if (r <= 0) { k = e[0]; break; } }
  if (o.queue === 0 && k !== 'special' && Math.random() < d.combo) o.queue = d.combo > 0.35 ? 2 : 1;
  startAtk(k);
}
function updOpp(dt) {
  const f = F, o = f.o, d = f.d; o.t += dt;
  switch (o.st) {
    case 'idle':
      o.guardT -= dt;
      if (o.guardT <= 0) { o.guard = o.nextGuard || (Math.random() < 0.5 ? 'high' : 'low'); o.nextGuard = null; o.guardT = rr(0.6, 1.4) * d.guard; }
      if (o.t >= o.dur) chooseAction();
      break;
    case 'windup':
      if (!o.told && o.t >= o.dur * 0.5) { o.told = true; SFX.tell(); }
      if (o.feint && o.t >= o.dur * 0.6) { o.feint = false; o.queue = 0; toIdle(); o.dur = 0.22; msg('FAKE!', '#aaa'); break; }
      if (o.t >= o.dur) { o.st = 'strike'; o.t = 0; o.dur = 0.13; resolveOppAttack(); }
      break;
    case 'strike':
      if (o.t >= o.dur) { o.t = 0; if (o.missed) { o.st = 'recover'; o.dur = o.atk.rec / (o.enraged ? 1.1 : 1); } else { o.st = 'retract'; o.dur = 0.28; } }
      break;
    case 'recover': if (o.t >= o.dur) { o.queue = 0; toIdle(); } break;
    case 'retract': case 'hit': case 'taunt': if (o.t >= o.dur) toIdle(); break;
  }
}
function resolveOppAttack() {
  const f = F, o = f.o, d = f.d, p = f.p, a = o.atk;
  if (f.phase !== 'fight') return;
  const dodgeWin = 0.36 / PS.spd() + 0.04;
  const dodging = (p.st === 'dodgeL' || p.st === 'dodgeR') && p.t < dodgeWin;
  const ddir = p.st === 'dodgeL' ? -1 : 1;
  const ducking = p.st === 'duck' && p.t < 0.42;
  const blocking = p.st === 'block';
  let res = 'hit', mul = 1;
  switch (a.type) {
    case 'jab': res = (dodging || ducking) ? 'miss' : blocking ? 'block' : 'hit'; break;
    case 'hook': res = ducking ? 'miss' : dodging ? (ddir !== o.aSide ? 'miss' : 'hit') : blocking ? 'block' : 'hit'; if (dodging && ddir === o.aSide) mul = 1.3; break;
    case 'upper': res = dodging ? 'miss' : 'hit'; if (ducking) mul = 1.4; break;
    case 'body': res = blocking ? 'block' : dodging ? 'miss' : 'hit'; break;
    case 'special': res = (d.special.avoid === 'duck' ? ducking : dodging) ? 'miss' : 'hit'; break;
  }
  if (res === 'miss') { o.missed = true; SFX.whiff(); return; }
  let dmg = a.dmg * d.dmg * PS.taken() * mul * (o.enraged ? 1.1 : 1);
  if (res === 'block') { dmg *= a.block; p.hp -= dmg; SFX.block(); f.shake = 3; msg('BLOCK', '#9cf'); }
  else {
    p.hp -= dmg; f.pts.o += dmg; if (p.stars) msg('STARS LOST', '#f88'); p.stars = 0; loseHearts(2); setP('hit');
    if (a.type === 'special') SFX.big(); else SFX.hurt();
    f.shake = a.type === 'special' ? 18 : 10; f.flash = 1;
  }
  if (p.hp <= 0) { p.hp = 0; knockdownPlayer(); }
}
function setP(s) { F.p.st = s; F.p.t = 0; F.p.resolved = false; }
function loseHearts(n) {
  const p = F.p; if (p.tired > 0) return; p.hearts = Math.max(0, p.hearts - n);
  if (p.hearts === 0) { p.tired = 3.2; msg('WINDED!', '#f66', true); }
}
function gainStar(why) { const p = F.p; if (p.stars < 3) { p.stars++; SFX.star(); msg(why + '  ★', '#ffd84a', true); } else msg(why, '#ffd84a', true); }
function updPlayer(dt) {
  const p = F.p, spd = PS.spd(); p.t += dt;
  if (p.tired > 0) { p.tired -= dt; if (p.tired <= 0) { p.tired = 0; p.hearts = Math.ceil(p.maxH * 0.35); msg('SECOND WIND', '#9f9'); } }
  switch (p.st) {
    case 'idle': case 'block':
      if (p.st === 'block' && !keys.down) p.st = 'idle';
      if (hit('left')) setP('dodgeL');
      else if (hit('right')) setP('dodgeR');
      else if (hit('duck')) setP('duck');
      else if (hit('pl') || hit('pr')) {
        if (p.tired > 0) { msg('TOO TIRED', '#f66'); }
        else { setP('punch'); p.side = hit('pl') ? 'L' : 'R'; p.high = !!keys.up; }
      }
      else if (hit('star')) {
        if (p.stars <= 0) msg('NO STARS', '#888');
        else if (p.tired > 0) msg('TOO TIRED', '#f66');
        else { p.stars--; setP('star'); SFX.star(); }
      }
      else if (keys.down) p.st = 'block';
      break;
    case 'dodgeL': case 'dodgeR': if (p.t >= 0.5 / spd) setP('idle'); break;
    case 'duck': if (p.t >= 0.55 / spd) setP('idle'); break;
    case 'punch': {
      const dur = 0.26 / spd;
      if (!p.resolved && p.t >= dur * 0.4) { p.resolved = true; resolvePunch(p.side, p.high, false); }
      if (p.t >= dur) setP('idle');
      break;
    }
    case 'star':
      if (!p.resolved && p.t >= 0.36) { p.resolved = true; resolvePunch('R', true, true); }
      if (p.t >= 0.62) setP('idle');
      break;
    case 'hit': if (p.t >= 0.42) setP('idle'); break;
  }
}
function resolvePunch(side, high, star) {
  const f = F, o = f.o, d = f.d, p = f.p;
  if (f.phase !== 'fight' || o.st === 'down') return;
  const tx = 480 + (side === 'L' ? -22 : 22), ty = high ? 175 : 300;
  let dmg = PS.dmg() * (high ? 1.25 : 1), landed = false, counter = false, stuff = false;
  if (star) { landed = true; dmg = PS.dmg() * 3.2 + 8; if (o.st === 'windup' || o.st === 'recover' || o.st === 'taunt') { counter = true; dmg *= 1.4; } }
  else if (o.st === 'recover' || o.st === 'taunt') { landed = true; counter = true; }
  else if (o.st === 'windup') {
    landed = true;
    if (high && o.t < o.dur * 0.45 && o.ak !== 'special') stuff = true;
  }
  else if (o.st === 'strike' || o.st === 'retract') landed = true;
  else if (o.st === 'hit') {
    o.combo++;
    if (o.combo >= d.maxCombo) {
      o.guard = high ? 'high' : 'low'; p.hearts = Math.max(0, p.hearts - 1);
      SFX.block(); msg('BLOCKED', '#bbb'); spark(tx, ty, false);
      o.queue = 0; startAtk(Math.random() < 0.5 ? 'jabL' : 'jabR', 0.42); return;
    }
    landed = true;
  }
  else if (o.st === 'idle') {
    landed = !((o.guard === 'high' && high) || (o.guard === 'low' && !high));
    if (landed) o.combo++;
  }
  if (!landed) { loseHearts(1); SFX.block(); msg('BLOCKED', '#bbb'); spark(tx, ty, false); return; }
  if (counter) dmg *= 2;
  if (star) { msg('STAR UPPERCUT!', '#ffd84a', true); SFX.big(); f.shake = 16; }
  else if (counter) gainStar('COUNTER!');
  else if (stuff) gainStar('STUFFED!');
  o.hp -= dmg; f.pts.p += dmg; if (!star) SFX.punch(); f.shake = Math.max(f.shake, counter ? 9 : 5);
  spark(tx, star ? 170 : ty, counter || star);
  o.hits.push(high); if (o.hits.length > 2) o.hits.shift();
  if (o.hits.length === 2 && o.hits[0] === o.hits[1] && Math.random() < d.adapt) o.nextGuard = high ? 'high' : 'low';
  const interrupts = star || counter || stuff || !['windup', 'strike', 'retract'].includes(o.st);
  if (interrupts) { if (o.st !== 'hit') o.queue = 0; o.st = 'hit'; o.t = 0; o.dur = star ? 0.55 : 0.3; o.hitSide = side; o.hitHigh = high; }
  if (o.hp / o.max < 0.35 && !o.enraged) { o.enraged = true; }
  if (o.hp <= 0) { o.hp = 0; knockdownOpp(side); }
}
function knockdownOpp(side) {
  const f = F, o = f.o, d = f.d; o.st = 'down'; o.t = 0; o.kdR++; o.kdT++; o.fallDir = side === 'L' ? 1 : -1; o.queue = 0;
  f.pts.p += 15; f.phase = 'oppDown'; f.count = 0; f.countT = -0.7; SFX.down(); msg('DOWN!', '#ffd84a', true);
  const chance = clamp(d.grit - 0.2 * (o.kdT - 1), 0.05, 0.95);
  o.getUp = (o.kdR < 3 && Math.random() < chance) ? ri(3, 9) : 99;
  setP('idle');
}
function knockdownPlayer() {
  const f = F, p = f.p; p.kdR++; p.kdT++; f.pts.o += 15; f.phase = 'plDown'; f.count = 0; f.countT = -0.6; p.mash = 0;
  p.need = 10 + 7 * (p.kdT - 1); setP('down'); SFX.down(); msg('YOU\'RE DOWN!', '#ff6b6b', true);
  F.o.queue = 0; F.o.st = 'taunt'; F.o.t = 0; F.o.dur = 99;
}
function finish(win, how) {
  const f = F; f.phase = 'result'; f.phT = 0; f.result = { win, how, purse: win ? purseFor(f.oid, f.info.type) : 0 };
  if (win) SFX.win(); else SFX.down();
}
function endRound() {
  const f = F, p = f.p, o = f.o; SFX.bell();
  if (f.round >= 3) {
    const champ = f.info.type !== 'street';
    return finish(f.pts.p > f.pts.o * (champ ? 1.15 : 1), 'DECISION');
  }
  f.phase = 'rest'; f.phT = 0; f.rest = { drank: false };
  p.hp = Math.min(p.max, p.hp + p.max * 0.2); p.hearts = p.maxH; p.tired = 0; setP('idle');
  o.hp = Math.min(o.max, o.hp + o.max * 0.08); o.kdR = 0; p.kdR = 0; o.queue = 0; toIdle();
}
function updFight(dt) {
  const f = F;
  if (hit('menu') && f.phase !== 'result') f.paused = !f.paused;
  if (f.paused) { if (adv()) f.paused = false; return; }
  f.time += dt; f.phT += dt; f.shake = Math.max(0, f.shake - dt * 40); f.flash = Math.max(0, f.flash - dt * 3);
  for (const m of f.msgs) m.t += dt; f.msgs = f.msgs.filter(m => m.t < 1.1).slice(-4);
  for (const s of f.sparks) s.t += dt; f.sparks = f.sparks.filter(s => s.t < 0.35);
  const p = f.p, o = f.o;
  switch (f.phase) {
    case 'intro': if (f.phT > 0.8 && adv()) { f.phase = 'fight'; f.phT = 0; SFX.bell(); toIdle(); o.dur = 1.3; msg('FIGHT!', '#ffd84a', true); } break;
    case 'fight':
      f.clock += dt; updPlayer(dt); if (f.phase === 'fight') updOpp(dt);
      if (f.phase === 'fight' && f.clock >= ROUND_LEN && !['windup', 'strike'].includes(o.st)) endRound();
      break;
    case 'oppDown':
      o.t += dt; f.countT += dt; p.t += dt;
      if (o.kdR >= 3) { if (f.countT > 1.2) finish(true, 'TKO'); break; }
      if (f.countT >= 0.75) {
        f.countT = 0; f.count++; SFX.blip();
        if (f.count >= o.getUp && f.count < 10) {
          o.hp = Math.round(o.max * clamp(0.65 - 0.13 * o.kdT, 0.2, 0.65)); o.enraged = true; f.phase = 'fight'; toIdle(); o.dur = 0.9; msg('BACK UP!', '#ff9c6b', true);
        } else if (f.count >= 10) finish(true, 'KO');
      }
      break;
    case 'plDown':
      f.countT += dt; o.t += dt;
      if (p.kdR >= 3) { if (f.countT > 1.2) finish(false, 'TKO'); break; }
      if (hit('pl') || hit('pr') || hit('act') || hit('star')) { p.mash++; SFX.blip(); }
      if (p.mash >= p.need) {
        p.hp = Math.round(p.max * clamp(0.55 - 0.1 * (p.kdT - 1), 0.2, 0.55)); p.hearts = Math.max(p.hearts, 8); p.tired = 0;
        setP('idle'); f.phase = 'fight'; toIdle(); o.dur = 1.0; msg('BACK ON YOUR FEET!', '#7CFC9A', true); break;
      }
      if (f.countT >= 0.9) { f.countT = 0; f.count++; if (f.count >= 10) finish(false, 'KO'); }
      break;
    case 'rest':
      if (hit('shake') && S.shakes > 0 && !f.rest.drank) { S.shakes--; f.rest.drank = true; p.hp = Math.min(p.max, p.hp + p.max * 0.45); SFX.coin(); }
      if (f.phT > 1 && adv()) { f.round++; f.clock = 0; f.phase = 'fight'; SFX.bell(); toIdle(); o.dur = 1.2; msg('ROUND ' + f.round, '#ffd84a', true); }
      break;
    case 'result':
      if (f.phT > 1.2 && adv()) endFight();
      break;
  }
}
function endFight() {
  const f = F, d = f.d, r = f.result; mode = 'world'; F = null;
  const after = [];
  if (r.win) {
    S.wins++; if (r.how !== 'DECISION') S.kos++; S.money += r.purse; S.beaten[f.oid] = (S.beaten[f.oid] || 0) + 1;
    after.push(`You beat ${d.name} by ${r.how}! Purse: $${r.purse}.`);
    if (f.info.type === 'champ' && !S.belts.includes(d.belt)) {
      S.belts.push(d.belt); applyGates();
      after.push(`NEW ${REG[d.belt].name.toUpperCase()} CHAMPION!`);
      const gi = BELT_ORDER.indexOf(d.belt);
      if (gi < 3) after.push(`Somewhere, a Gatekeeper raises the barrier. The road to ${REG[BELT_ORDER[gi + 1]].name} is open.`);
      else after.push('You hold all four belts. You are the Kingdom Champion!' + (S.badges.length < 5 ? ' Old-timers mutter about five Golden Star Badges...' : ' The Sealed Ring on Summit Ridge is waiting.'));
    }
    if (f.info.type === 'secret' && !S.flags.phantom) {
      S.flags.phantom = true;
      after.push('The Phantom bows, and fades into the dark. You are the TRUE CHAMPION of the Knockout Kingdom!', 'Thanks for playing. The Kingdom is yours to roam; every fighter still wants a rematch.');
    }
  } else {
    S.losses++;
    after.push(`${d.name} wins by ${r.how}.`, pick(["Coach Mabel: \"Shake it off. Train, buy better gloves, and go again.\"", "Coach Mabel: \"Watch for the flash, kid. Patience wins fights.\"", "Coach Mabel: \"Read the tip between rounds. Every fighter has a weakness.\""]));
  }
  save(); say(r.win ? 'Victory' : 'Defeat', after);
}

// ---------------------------------------------------------------- fight drawing
const WINDPOS = { jab: (s) => ({ x: s * 95, y: 200, r: 24 }), hook: (s) => ({ x: s * 150, y: 215, r: 26 }), upper: (s) => ({ x: s * 70, y: 350, r: 24 }), body: (s) => ({ x: s * 92, y: 295, r: 24 }), special: (s) => ({ x: s * 80, y: 92, r: 32 }) };
const STRIKEPOS = { jab: (s) => ({ x: s * 22, y: 395, r: 60 }), hook: (s) => ({ x: -s * 40, y: 375, r: 56 }), upper: (s) => ({ x: s * 10, y: 270, r: 62 }), body: (s) => ({ x: s * 25, y: 445, r: 52 }), special: () => ({ x: 0, y: 380, r: 82 }) };
function oppPose() {
  const f = F, o = f.o; const sx = o.aSide;
  const P = { bx: 0, by: Math.sin(f.time * 5) * 4, hx: 0, hy: 0, face: 'normal', flash: 0, rot: 0, drop: 0, glow: 0, atkIdx: -1 };
  const gHigh = [{ x: -46, y: 178, r: 30 }, { x: 46, y: 178, r: 30 }], gLow = [{ x: -62, y: 300, r: 30 }, { x: 62, y: 300, r: 30 }], gMid = [{ x: -58, y: 240, r: 30 }, { x: 58, y: 240, r: 30 }];
  let g = (o.guard === 'high' ? gHigh : gLow).map(v => ({ ...v }));
  if (o.st === 'idle') { g.forEach((v, i) => { v.y += Math.sin(f.time * 5 + i) * 4; }); if (o.enraged) P.face = 'angry'; }
  if (o.st === 'windup' || o.st === 'strike' || o.st === 'retract') {
    const a = o.atk, k = o.t / o.dur, idx = sx < 0 ? 0 : 1; P.atkIdx = idx;
    g = gHigh.map(v => ({ ...v }));
    const back = WINDPOS[a.type](sx), tgt = STRIKEPOS[a.type](sx);
    let pos;
    if (o.st === 'windup') {
      pos = lerpP(g[idx], back, ease(k * 1.7)); P.face = 'angry';
      if (k > 0.5) { P.flash = Math.floor(f.time * 22) % 2 ? 1 : 0.35; pos.x += rr(-3, 3); pos.y += rr(-3, 3); }
      if (a.type === 'hook') P.bx = -sx * 14 * ease(k * 2);
      if (a.type === 'upper') P.by += 14 * ease(k * 2);
      if (a.type === 'special') { g[1 - idx] = lerpP(g[1 - idx], { x: -sx * 80, y: 92, r: 32 }, ease(k * 2)); P.bx = rr(-4, 4) * k; P.glow = k; }
    } else if (o.st === 'strike') { pos = lerpP(back, tgt, ease(k)); P.face = 'angry'; if (a.type === 'hook') P.bx = sx * 18; }
    else pos = lerpP(tgt, g[idx], ease(k));
    g[idx] = pos;
  } else if (o.st === 'recover') { g = [{ x: -88, y: 335, r: 28 }, { x: 88, y: 335, r: 28 }]; P.face = 'dizzy'; P.hy = 12; P.bx = Math.sin(f.time * 9) * 9; }
  else if (o.st === 'hit') {
    const amt = 1 - clamp(o.t / o.dur, 0, 1); g = gMid.map(v => ({ ...v }));
    if (o.hitHigh) { P.hx = (o.hitSide === 'L' ? 1 : -1) * 20 * amt; P.hy = -6 * amt; } else { P.by += 12 * amt; P.hy = 10 * amt; }
    P.face = 'hurt';
  } else if (o.st === 'taunt') { g = [{ x: -78, y: 322, r: 30 }, { x: 78, y: 322, r: 30 }]; P.face = 'grin'; P.bx = Math.sin(f.time * 10) * 10; }
  else if (o.st === 'down') { const k = clamp(o.t / 0.6, 0, 1); P.rot = o.fallDir * 0.4 * ease(k); P.drop = ease(k) * 190; P.face = 'ko'; g = [{ x: -92, y: 300, r: 28 }, { x: 92, y: 300, r: 28 }]; }
  P.g = g; return P;
}
function drawGlove(v, col, flash) {
  circle(v.x, v.y + v.r * 0.12, v.r * 1.02, shade(col, -0.45));
  circle(v.x, v.y, v.r, col);
  circle(v.x - v.r * 0.3, v.y - v.r * 0.35, v.r * 0.32, shade(col, 0.4));
  ctx.fillStyle = shade(col, -0.25); ctx.fillRect(v.x - v.r * 0.55, v.y + v.r * 0.55, v.r * 1.1, v.r * 0.35);
  if (flash) { ctx.globalAlpha = flash * 0.75; circle(v.x, v.y, v.r * 1.05, '#ffffff'); ctx.globalAlpha = 1; }
}
function drawHead(x, y, d, P) {
  const r = 40;
  const hairC = d.hair, sk = d.skin;
  if (d.style === 'hood') { circle(x, y - 2, r * 1.32, '#15151d'); }
  if (d.style === 'pony') { ellipse(x + r * 0.9, y + 10, 14, 34, hairC); }
  circle(x - r * 0.95, y + 4, 9, shade(sk, -0.12)); circle(x + r * 0.95, y + 4, 9, shade(sk, -0.12));
  ellipse(x, y, r * 0.95, r * 1.06, sk);
  ellipse(x, y + r * 0.45, r * 0.7, r * 0.45, shade(sk, -0.05));
  ctx.fillStyle = hairC;
  const cap = (ry = 0.7) => { ctx.beginPath(); ctx.ellipse(x, y - r * 0.35, r * 0.98, r * ry, 0, Math.PI, 2 * Math.PI); ctx.fill(); };
  switch (d.style) {
    case 'buzz': cap(0.62); break;
    case 'flat': ctx.fillRect(x - r * 0.9, y - r * 1.25, r * 1.8, r * 0.75); break;
    case 'curly': for (let i = -3; i <= 3; i++) circle(x + i * 12, y - r * 0.85 + Math.abs(i) * 4, 13, hairC); break;
    case 'mohawk': cap(0.5); ctx.fillStyle = shade(hairC, -0.1); ctx.fillRect(x - 9, y - r * 1.65, 18, r * 1.0); break;
    case 'pomp': cap(0.6); ellipse(x + 8, y - r * 0.95, r * 0.9, r * 0.42, hairC); ellipse(x + 20, y - r * 1.05, r * 0.4, r * 0.22, shade(hairC, 0.25)); break;
    case 'bun': cap(0.62); circle(x, y - r * 1.15, 15, hairC); break;
    case 'pony': cap(0.62); break;
    case 'beanie': ctx.fillStyle = d.hat; ctx.beginPath(); ctx.ellipse(x, y - r * 0.35, r * 1.02, r * 0.8, 0, Math.PI, 2 * Math.PI); ctx.fill(); ctx.fillStyle = shade(d.hat, -0.25); ctx.fillRect(x - r * 1.02, y - r * 0.5, r * 2.04, 12); break;
    case 'beard': cap(0.62); ctx.beginPath(); ctx.ellipse(x, y + r * 0.5, r * 0.85, r * 0.65, 0, 0, Math.PI); ctx.fill(); ctx.fillRect(x - r * 0.85, y + r * 0.1, r * 1.7, r * 0.4); break;
    case 'bald': ellipse(x - 12, y - r * 0.6, 12, 6, 'rgba(255,255,255,.35)'); break;
    case 'crown': cap(0.62); ctx.fillStyle = '#f1c40f'; ctx.beginPath(); ctx.moveTo(x - 32, y - r * 0.8); ctx.lineTo(x - 32, y - r * 1.5); ctx.lineTo(x - 16, y - r * 1.15); ctx.lineTo(x, y - r * 1.6); ctx.lineTo(x + 16, y - r * 1.15); ctx.lineTo(x + 32, y - r * 1.5); ctx.lineTo(x + 32, y - r * 0.8); ctx.closePath(); ctx.fill(); circle(x, y - r * 1.05, 5, '#e74c3c'); break;
    case 'hood': ctx.fillStyle = '#15151d'; ctx.beginPath(); ctx.ellipse(x, y - r * 0.2, r * 1.05, r * 0.95, 0, Math.PI, 2 * Math.PI); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(x - r, y - r * 0.25, r * 2, r * 0.5); break;
  }
  // eyes
  const ex = r * 0.36, ey = y - 4;
  const eyeGlow = P.glow > 0.3 || d.glow;
  const brow = (ang) => { ctx.strokeStyle = shade(hairC === '#ecf0f1' ? '#888888' : hairC, -0.1); ctx.lineWidth = 5; ctx.lineCap = 'round'; for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + s * (ex - 10), ey - 14 + (ang * s < 0 ? 0 : 0) + ang); ctx.lineTo(x + s * (ex + 10), ey - 14 - ang); ctx.stroke(); } };
  ctx.lineCap = 'round';
  if (P.face === 'ko' || P.face === 'hurt') {
    ctx.strokeStyle = '#222'; ctx.lineWidth = 3;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      if (P.face === 'ko') { ctx.moveTo(x + s * ex - 6, ey - 6); ctx.lineTo(x + s * ex + 6, ey + 6); ctx.moveTo(x + s * ex + 6, ey - 6); ctx.lineTo(x + s * ex - 6, ey + 6); }
      else { ctx.moveTo(x + s * ex - 7, ey - 5); ctx.lineTo(x + s * ex + 5 * s, ey); ctx.lineTo(x + s * ex - 7, ey + 5); }
      ctx.stroke();
    }
    ellipse(x, y + r * 0.45, 9, 11, '#5a1a1a');
  } else if (P.face === 'dizzy') {
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2.5;
    for (const s of [-1, 1]) { ctx.beginPath(); for (let a = 0; a < 12; a += 0.4) { const rr2 = a * 0.7; ctx.lineTo(x + s * ex + Math.cos(a + F.time * 8) * rr2, ey + Math.sin(a + F.time * 8) * rr2); } ctx.stroke(); }
    ellipse(x, y + r * 0.48, 10, 8, '#5a1a1a');
    for (let i = 0; i < 3; i++) { const a = F.time * 4 + i * 2.1; text('★', x + Math.cos(a) * 50, y - r - 6 + Math.sin(a) * 10, '#ffd84a', 16, 'center', false); }
  } else {
    for (const s of [-1, 1]) {
      ellipse(x + s * ex, ey, 9, 7, eyeGlow ? (d.glow || '#fff27a') : '#fff');
      if (!eyeGlow) circle(x + s * ex, ey + 2, 3.5, '#1a1a1a');
    }
    if (P.face === 'angry') brow(5); else if (P.face === 'grin') brow(-3); else brow(0);
    if (P.face === 'grin') { ctx.fillStyle = '#5a1a1a'; ctx.beginPath(); ctx.arc(x, y + r * 0.35, 16, 0, Math.PI); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillRect(x - 13, y + r * 0.35, 26, 5); }
    else if (P.face === 'angry') { ctx.fillStyle = '#fff'; ctx.fillRect(x - 13, y + r * 0.4, 26, 8); ctx.strokeStyle = '#5a1a1a'; ctx.lineWidth = 2; ctx.strokeRect(x - 13, y + r * 0.4, 26, 8); }
    else { ctx.strokeStyle = '#5a1a1a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 11, y + r * 0.45); ctx.lineTo(x + 11, y + r * 0.45); ctx.stroke(); }
  }
  ellipse(x, y + 10, 6, 5, shade(sk, -0.18));
  if (d.stache) { ctx.fillStyle = hairC; ctx.beginPath(); ctx.ellipse(x - 9, y + r * 0.28, 11, 5, 0.3, 0, Math.PI * 2); ctx.ellipse(x + 9, y + r * 0.28, 11, 5, -0.3, 0, Math.PI * 2); ctx.fill(); }
}
function drawOpp() {
  const f = F, d = f.d, P = oppPose(), s = d.build, sk = d.skin;
  ctx.save(); ctx.translate(480 + P.bx, 330 + P.by + P.drop); ctx.rotate(P.rot); ctx.translate(0, -330);
  ctx.fillStyle = shade(sk, -0.15); ctx.fillRect(-42 * s, 410, 32 * s, 130); ctx.fillRect(10 * s, 410, 32 * s, 130);
  rrect(-64 * s, 345, 128 * s, 82, 14); ctx.fillStyle = d.trunks; ctx.fill();
  ctx.fillStyle = shade(d.trunks, 0.35); ctx.fillRect(-66 * s, 343, 132 * s, 14);
  ctx.fillStyle = shade(d.trunks, -0.25); ctx.fillRect(-4, 362, 8, 60);
  rrect(-68 * s, 205, 136 * s, 152, 42); ctx.fillStyle = sk; ctx.fill();
  ellipse(-26 * s, 248, 26 * s, 15, shade(sk, -0.08)); ellipse(26 * s, 248, 26 * s, 15, shade(sk, -0.08));
  for (let i = 0; i < 3; i++) { ellipse(-12, 285 + i * 20, 10, 7, shade(sk, -0.06)); ellipse(12, 285 + i * 20, 10, 7, shade(sk, -0.06)); }
  if (d.style === 'hood') { rrect(-70 * s, 200, 140 * s, 150, 40); ctx.fillStyle = '#1b1b24'; ctx.fill(); }
  ctx.fillStyle = shade(sk, -0.1); ctx.fillRect(-17, 168, 34, 44);
  const shL = { x: -62 * s, y: 225 }, shR = { x: 62 * s, y: 225 };
  const arm = (sh, gv) => {
    ctx.lineCap = 'round'; ctx.strokeStyle = shade(sk, -0.25); ctx.lineWidth = 32 * s; ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(gv.x, gv.y); ctx.stroke();
    ctx.strokeStyle = d.style === 'hood' ? '#1b1b24' : sk; ctx.lineWidth = 26 * s; ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(gv.x, gv.y); ctx.stroke();
  };
  const [gl, gr] = P.g;
  arm(shL, gl); arm(shR, gr);
  drawHead(P.hx, 148 + P.hy, d, P);
  const order = P.atkIdx === 0 ? [1, 0] : [0, 1];
  for (const i of order) drawGlove(P.g[i], d.glove, i === P.atkIdx ? P.flash : 0);
  if (P.glow > 0) { ctx.globalAlpha = P.glow * 0.35 * (0.6 + 0.4 * Math.sin(f.time * 30)); circle(0, 200, 170, d.glow || '#ff4d4d'); ctx.globalAlpha = 1; }
  ctx.restore();
}
function drawPlayerBack() {
  const f = F, p = f.p, spd = PS.spd(), stt = p.st, t = p.t;
  let ox = 0, oy = 0, lean = 0;
  if (stt === 'dodgeL' || stt === 'dodgeR') { const sx = stt === 'dodgeL' ? -1 : 1, k = t / (0.5 / spd); const e = k < 0.22 ? ease(k / 0.22) : k < 0.7 ? 1 : 1 - ease((k - 0.7) / 0.3); ox = sx * 135 * e; lean = sx * 0.25 * e; }
  if (stt === 'duck') { const k = t / (0.55 / spd); const e = k < 0.18 ? ease(k / 0.18) : k < 0.75 ? 1 : 1 - ease((k - 0.75) / 0.25); oy = 90 * e; }
  if (stt === 'hit') { ox = rr(-6, 6); oy = 14; }
  if (p.tired > 0) oy += 10 + Math.sin(f.time * 6) * 4;
  if (stt === 'down') oy = 280 * ease(t / 0.5);
  if (f.phase === 'rest' || f.phase === 'intro') oy += 30;
  const skin = '#c98b5b', tank = '#1f9d55', glove = '#27ae60';
  ctx.save(); ctx.globalAlpha = 0.94; ctx.translate(480 + ox, 470 + oy); ctx.rotate(lean); ctx.translate(0, -470);
  let gl = { x: -66, y: 452, r: 27 }, gr = { x: 66, y: 452, r: 27 };
  if (stt === 'block') { gl = { x: -26, y: 392, r: 31 }; gr = { x: 26, y: 392, r: 31 }; }
  if (p.tired > 0 && stt === 'idle') { gl.y = 485; gr.y = 485; }
  if (stt === 'punch') {
    const dur = 0.26 / spd, k = clamp(t / dur, 0, 1); const ext = k < 0.4 ? ease(k / 0.4) : 1 - ease((k - 0.4) / 0.6);
    const tg = p.high ? { x: (p.side === 'L' ? -22 : 22), y: 178, r: 19 } : { x: (p.side === 'L' ? -30 : 30), y: 300, r: 21 };
    if (p.side === 'L') gl = lerpP(gl, tg, ext); else gr = lerpP(gr, tg, ext);
  }
  if (stt === 'star') {
    if (t < 0.3) gr = lerpP(gr, { x: 34, y: 530, r: 30 }, ease(t / 0.3));
    else if (t < 0.42) gr = lerpP({ x: 34, y: 530, r: 30 }, { x: 0, y: 175, r: 24 }, ease((t - 0.3) / 0.12));
    else gr = lerpP({ x: 0, y: 175, r: 24 }, { x: 66, y: 452, r: 27 }, ease((t - 0.42) / 0.2));
  }
  rrect(-82, 445, 164, 150, 46); ctx.fillStyle = skin; ctx.fill();
  rrect(-56, 452, 112, 150, 18); ctx.fillStyle = tank; ctx.fill();
  text('K', 0, 520, shade(tank, 0.4), 34, 'center', false);
  const arm = (sh, gv) => { ctx.lineCap = 'round'; ctx.strokeStyle = shade(skin, -0.2); ctx.lineWidth = 26; ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(gv.x, gv.y); ctx.stroke(); ctx.strokeStyle = skin; ctx.lineWidth = 20; ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(gv.x, gv.y); ctx.stroke(); };
  const front = (stt === 'punch' || stt === 'star');
  if (!front) { arm({ x: -66, y: 470 }, gl); arm({ x: 66, y: 470 }, gr); }
  circle(0, 418, 13, shade(skin, -0.1));
  circle(0, 398, 34, skin); ellipse(0, 390, 35, 31, '#2a1a0e'); ctx.fillStyle = '#d63031'; ctx.fillRect(-35, 382, 70, 9);
  circle(-33, 402, 7, shade(skin, -0.1)); circle(33, 402, 7, shade(skin, -0.1));
  if (front) { arm({ x: -66, y: 470 }, gl); arm({ x: 66, y: 470 }, gr); }
  drawGlove(gl, glove, 0); drawGlove(gr, glove, 0);
  if (stt === 'star' && t > 0.3) { for (let i = 0; i < 6; i++) { const a = f.time * 12 + i; text('✦', gr.x + Math.cos(a) * 34, gr.y + Math.sin(a) * 34, '#ffd84a', 18, 'center', false); } }
  if (p.tired > 0) { for (let i = 0; i < 3; i++) text('💧', -50 + i * 50, 360 - ((f.time * 60 + i * 30) % 40), '#7fd', 14, 'center', false); }
  ctx.restore();
}
function drawArena() {
  const f = F, d = f.d, acc = REG[d.belt || (['al', 'pete'].includes(f.oid) ? 'rookie' : ['bev', 'crane'].includes(f.oid) ? 'docks' : ['vinnie', 'tess'].includes(f.oid) ? 'neon' : 'summit')];
  const bg = f.oid === 'phantom' ? '#050508' : '#0d0d1c';
  const g = ctx.createLinearGradient(0, 0, 0, 330); g.addColorStop(0, bg); g.addColorStop(1, shade(acc.col, -0.75)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const sp = ctx.createRadialGradient(480, 90, 10, 480, 200, 420); sp.addColorStop(0, 'rgba(255,255,230,.18)'); sp.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = sp; ctx.fillRect(0, 0, W, H);
  if (f.oid !== 'phantom') for (const c of crowd) {
    const j = Math.max(0, Math.sin(f.time * 6 + c.ph)) * (f.phase === 'oppDown' || f.phase === 'result' ? 7 : 2);
    ctx.fillStyle = shade(c.c, -0.4); ctx.fillRect(c.x - 9, c.y - j + 8, 18, 18); circle(c.x, c.y - j, 8, c.s);
    if (Math.random() < 0.002) circle(c.x, c.y - j, 16, 'rgba(255,255,255,.8)');
  }
  ctx.fillStyle = '#d9dfe6'; ctx.beginPath(); ctx.moveTo(150, 330); ctx.lineTo(810, 330); ctx.lineTo(980, 540); ctx.lineTo(-20, 540); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.beginPath(); ctx.ellipse(480, 440, 220, 60, 0, 0, Math.PI * 2); ctx.fill();
  font(40); ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillText('KNOCKOUT KINGDOM', 480, 455);
  ctx.fillStyle = acc.col; ctx.fillRect(140, 210, 20, 125); ctx.fillRect(800, 210, 20, 125);
  ['#e74c3c', '#ecf0f1', '#3498db'].forEach((c, i) => {
    const y = 232 + i * 30; ctx.strokeStyle = c; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(150, y); ctx.lineTo(810, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(150, y); ctx.lineTo(-40, y + 150); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(810, y); ctx.lineTo(1000, y + 150); ctx.stroke();
  });
  ellipse(480, 470, 110, 18, 'rgba(0,0,0,.18)');
}
function drawFight() {
  const f = F, p = f.p, o = f.o, d = f.d;
  ctx.save();
  if (f.shake > 0) ctx.translate(rr(-f.shake, f.shake) * 0.6, rr(-f.shake, f.shake) * 0.6);
  drawArena(); drawOpp(); drawPlayerBack();
  for (const s of f.sparks) { const k = s.t / 0.35, r = (s.big ? 60 : 36) * (0.4 + k); ctx.globalAlpha = 1 - k; ctx.strokeStyle = s.big ? '#ffd84a' : '#fff'; ctx.lineWidth = 4; ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; ctx.moveTo(s.x + Math.cos(a) * r * 0.4, s.y + Math.sin(a) * r * 0.4); ctx.lineTo(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r); } ctx.stroke(); ctx.globalAlpha = 1; }
  ctx.restore();
  if (f.flash > 0) { ctx.fillStyle = `rgba(255,0,0,${f.flash * 0.25})`; ctx.fillRect(0, 0, W, H); }
  // HUD
  ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(0, 0, W, 64);
  text('YOU', 16, 22, '#7CFC9A', 15); bar(16, 30, 290, 16, p.hp / p.max, '#2ecc71');
  text('♥ ' + p.hearts, 318, 46, p.tired > 0 ? '#f66' : '#ff8fa3', 18);
  for (let i = 0; i < 3; i++) text(i < p.stars ? '★' : '☆', 392 + i * 20, 46, '#ffd84a', 20, 'left', false);
  text(d.name.toUpperCase(), W - 16, 22, '#ff9c6b', 15, 'right'); bar(W - 306, 30, 290, 16, o.hp / o.max, '#e74c3c', true);
  text('ROUND ' + f.round, 480, 22, '#fff', 15, 'center');
  const rem = Math.ceil(Math.max(0, ROUND_LEN - f.clock) * 3); text(Math.floor(rem / 60) + ':' + String(rem % 60).padStart(2, '0'), 480, 50, '#ffd84a', 22, 'center');
  for (let i = 0; i < p.kdR; i++) circle(300 - i * 12, 56, 4, '#f66');
  for (let i = 0; i < o.kdR; i++) circle(W - 300 + i * 12, 56, 4, '#f66');
  if (f.phase === 'fight' && S.wins < 3) text('←/→ dodge  ↓ block  C duck  Z/X body  ↑+Z/X face  SPACE star', 480, 532, 'rgba(255,255,255,.55)', 13, 'center', false);
  f.msgs.forEach((m, i) => { const a = 1 - m.t / 1.1; ctx.globalAlpha = a; text(m.text, 480, (m.big ? 130 : 110) + i * 34 - m.t * 30, m.col, m.big ? 34 : 20, 'center'); ctx.globalAlpha = 1; });
  // phase overlays
  if (f.phase === 'intro') {
    panel(200, 110, 560, 260);
    text(d.name.toUpperCase(), 480, 165, '#ff9c6b', 34, 'center');
    text(d.title, 480, 195, '#ccc', 16, 'center');
    text(`${d.hp} HP   Purse $${purseFor(f.oid, f.info.type)}`, 480, 228, '#f5c542', 16, 'center');
    wrap('"' + d.lines[0] + '"', 500, 17).forEach((l, i) => text(l, 480, 268 + i * 22, '#fff', 17, 'center', false));
    text('Press Z / ENTER to start', 480, 345, '#aaa', 15, 'center', false);
  } else if (f.phase === 'oppDown' || f.phase === 'plDown') {
    if (f.count > 0) text(String(f.count), 480, 240, '#fff', 90, 'center');
    if (f.phase === 'plDown' && p.kdR < 3) {
      text('MASH Z / X TO GET UP!', 480, 300, '#ffd84a', 26, 'center');
      ctx.fillStyle = '#222'; ctx.fillRect(330, 316, 300, 18); ctx.fillStyle = '#2ecc71'; ctx.fillRect(330, 316, 300 * clamp(p.mash / p.need, 0, 1), 18);
    }
  } else if (f.phase === 'rest') {
    panel(180, 90, 600, 330);
    text(`END OF ROUND ${f.round}`, 480, 135, '#f5c542', 28, 'center');
    text('Coach Mabel says:', 220, 175, '#aaa', 16, 'left', false);
    wrap(d.tip, 520, 17).forEach((l, i) => text(l, 220, 202 + i * 22, '#fff', 17, 'left', false));
    text(`Your HP ${Math.round(p.hp)}/${p.max}    Score ${Math.round(f.pts.p)} - ${Math.round(f.pts.o)}`, 480, 320, '#ddd', 16, 'center', false);
    text(f.rest.drank ? 'Shake: gulped!' : S.shakes > 0 ? `Q: drink a Protein Shake (+45% HP, ${S.shakes} left)` : 'No Protein Shakes (buy them at diners)', 480, 352, f.rest.drank ? '#7CFC9A' : '#9cf', 16, 'center', false);
    text('Press Z / ENTER for the next round', 480, 395, '#aaa', 15, 'center', false);
  } else if (f.phase === 'result') {
    const r = f.result; panel(220, 130, 520, 230, 'rgba(14,14,30,.95)', r.win ? '#f5c542' : '#e74c3c');
    text(r.win ? 'YOU WIN!' : 'YOU LOSE', 480, 195, r.win ? '#f5c542' : '#e74c3c', 48, 'center');
    text('by ' + r.how, 480, 235, '#fff', 22, 'center');
    text(`Score ${Math.round(f.pts.p)} - ${Math.round(f.pts.o)}`, 480, 270, '#bbb', 16, 'center', false);
    if (r.win) text(`Purse: $${r.purse}`, 480, 300, '#7CFC9A', 20, 'center');
    text('Press Z / ENTER', 480, 340, '#aaa', 15, 'center', false);
  }
  if (f.paused) { ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, W, H); text('PAUSED', 480, 260, '#fff', 40, 'center'); text('Press Z / ENTER to resume', 480, 300, '#aaa', 16, 'center'); }
}

// ---------------------------------------------------------------- world drawing
function drawPerson(x, y, dir, c, ph, moving, gloves) {
  const bob = moving ? Math.abs(Math.sin(ph)) * 2.5 : 0;
  ellipse(x, y + 2, 11, 5, 'rgba(0,0,0,.28)');
  const lg = moving ? Math.sin(ph) * 3 : 0;
  ctx.fillStyle = c.pants; ctx.fillRect(x - 6, y - 6 - bob + lg * 0, 5, 8 + lg); ctx.fillRect(x + 1, y - 6 - bob, 5, 8 - lg);
  rrect(x - 8, y - 20 - bob, 16, 16, 5); ctx.fillStyle = c.shirt; ctx.fill();
  circle(x, y - 27 - bob, 8, c.skin);
  ctx.fillStyle = c.hair;
  if (dir === 'up') { circle(x, y - 28 - bob, 8, c.hair); }
  else { ctx.beginPath(); ctx.arc(x, y - 29 - bob, 8, Math.PI, 2 * Math.PI); ctx.fill(); }
  if (dir === 'down') { circle(x - 3, y - 26 - bob, 1.4, '#111'); circle(x + 3, y - 26 - bob, 1.4, '#111'); }
  else if (dir === 'left') circle(x - 4, y - 26 - bob, 1.4, '#111');
  else if (dir === 'right') circle(x + 4, y - 26 - bob, 1.4, '#111');
  if (gloves) { const sw = moving ? Math.sin(ph) * 2 : 0; circle(x - 10, y - 14 - bob + sw, 4.5, gloves); circle(x + 10, y - 14 - bob - sw, 4.5, gloves); }
}
function drawTile(t, tx, ty, x, y) {
  const h = hash(tx, ty); const rg = regionAt(tx, ty);
  const base = rg === 'rookie' ? '#5a9e4b' : rg === 'docks' ? '#d8c48a' : rg === 'neon' ? '#24243a' : (ty < 12 ? '#eef3f7' : '#8c8f86');
  switch (t) {
    case T.GRASS: ctx.fillStyle = h < 0.5 ? '#5a9e4b' : '#57984a'; ctx.fillRect(x, y, TS, TS); if (h > 0.8) { ctx.fillStyle = '#4c8a3e'; ctx.fillRect(x + h * 20, y + 10, 2, 6); ctx.fillRect(x + h * 14 + 6, y + 18, 2, 5); } break;
    case T.FLOWER: ctx.fillStyle = '#5a9e4b'; ctx.fillRect(x, y, TS, TS); for (let i = 0; i < 4; i++) circle(x + 6 + hash(tx + i, ty) * 20, y + 6 + hash(tx, ty + i) * 20, 2.5, ['#ff7675', '#fdcb6e', '#fff', '#a29bfe'][i]); break;
    case T.ROAD: ctx.fillStyle = rg === 'rookie' ? '#b39b72' : rg === 'docks' ? '#8e8e8e' : rg === 'neon' ? '#33334a' : '#9b8f80'; ctx.fillRect(x, y, TS, TS);
      if (rg === 'docks') { ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.strokeRect(x + 0.5, y + 0.5, TS / 2, TS / 2); ctx.strokeRect(x + TS / 2 + 0.5, y + TS / 2 + 0.5, TS / 2 - 1, TS / 2 - 1); }
      if (rg === 'neon' && (tx + ty) % 3 === 0) { ctx.fillStyle = '#f9ca24'; ctx.fillRect(x + 12, y + 14, 8, 4); }
      if (h > 0.85) { ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(x + h * 18, y + h * 12, 5, 3); } break;
    case T.WATER: { ctx.fillStyle = '#2f6fb3'; ctx.fillRect(x, y, TS, TS); const w = Math.sin(worldTime * 2 + tx * 0.7 + ty * 0.4); ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(x + 6 + w * 4, y + 10 + h * 10, 10, 2); break; }
    case T.TREE:
      ctx.fillStyle = base; ctx.fillRect(x, y, TS, TS); ellipse(x + 16, y + 28, 12, 4, 'rgba(0,0,0,.25)');
      if (rg === 'summit') { ctx.fillStyle = '#5d4037'; ctx.fillRect(x + 13, y + 20, 6, 10); ctx.fillStyle = ty < 12 ? '#2d6a4f' : '#1e5631'; ctx.beginPath(); ctx.moveTo(x + 16, y - 10); ctx.lineTo(x + 30, y + 22); ctx.lineTo(x + 2, y + 22); ctx.closePath(); ctx.fill(); if (ty < 12) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x + 16, y - 10); ctx.lineTo(x + 22, y + 3); ctx.lineTo(x + 10, y + 3); ctx.closePath(); ctx.fill(); } }
      else { ctx.fillStyle = '#6d4c41'; ctx.fillRect(x + 13, y + 16, 6, 14); circle(x + 16, y + 10, 14, '#2f7d32'); circle(x + 11, y + 6, 7, '#43a047'); } break;
    case T.SAND: ctx.fillStyle = h < 0.5 ? '#d8c48a' : '#d4bf84'; ctx.fillRect(x, y, TS, TS); break;
    case T.SNOW: ctx.fillStyle = h < 0.5 ? '#eef3f7' : '#e6edf2'; ctx.fillRect(x, y, TS, TS); break;
    case T.STONE: ctx.fillStyle = h < 0.5 ? '#8c8f86' : '#878a81'; ctx.fillRect(x, y, TS, TS); if (h > 0.8) { ctx.fillStyle = '#7a7d75'; ctx.fillRect(x + 8, y + 12, 6, 4); } break;
    case T.NEON: ctx.fillStyle = '#24243a'; ctx.fillRect(x, y, TS, TS); ctx.strokeStyle = '#2f2f4d'; ctx.strokeRect(x + 0.5, y + 0.5, TS - 1, TS - 1); break;
    case T.BRIDGE: ctx.fillStyle = '#8b5a2b'; ctx.fillRect(x, y, TS, TS); ctx.fillStyle = '#6f4520'; for (let i = 0; i < 4; i++) ctx.fillRect(x + (tx < 49 || tx > 53 ? 0 : i * 8), y + (tx < 49 || tx > 53 ? i * 8 : 0), tx < 49 || tx > 53 ? TS : 2, tx < 49 || tx > 53 ? 2 : TS); break;
    case T.PLANK: ctx.fillStyle = '#9b6b3d'; ctx.fillRect(x, y, TS, TS); ctx.fillStyle = '#7d5530'; ctx.fillRect(x, y + 10, TS, 2); ctx.fillRect(x, y + 21, TS, 2); break;
    case T.BOULDER: ctx.fillStyle = base; ctx.fillRect(x, y, TS, TS); ellipse(x + 16, y + 20, 13, 10, '#6c6f68'); ellipse(x + 12, y + 16, 6, 4, '#9a9d95'); if (ty < 12) ellipse(x + 16, y + 13, 10, 4, '#fff'); break;
    case T.LAMP: ctx.fillStyle = '#24243a'; ctx.fillRect(x, y, TS, TS); ctx.fillStyle = '#555'; ctx.fillRect(x + 14, y + 4, 4, 26); { const c = ['#ff6bd6', '#6bf2ff', '#fff36b'][Math.floor(h * 3)]; circle(x + 16, y + 4, 6, c); ctx.globalAlpha = 0.25 + 0.1 * Math.sin(worldTime * 4 + h * 9); circle(x + 16, y + 4, 16, c); ctx.globalAlpha = 1; } break;
    case T.CRATE: ctx.fillStyle = '#d8c48a'; ctx.fillRect(x, y, TS, TS); ctx.fillStyle = '#a0763c'; ctx.fillRect(x + 4, y + 4, 24, 24); ctx.strokeStyle = '#6f4f24'; ctx.lineWidth = 2; ctx.strokeRect(x + 4, y + 4, 24, 24); ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + 28, y + 28); ctx.stroke(); break;
    case T.GATE: ctx.fillStyle = '#8b5a2b'; ctx.fillRect(x, y, TS, TS); for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#fff' : '#e74c3c'; ctx.fillRect(x + 2, y + 6 + i * 6, TS - 4, 6); } break;
    default: ctx.fillStyle = '#444'; ctx.fillRect(x, y, TS, TS);
  }
}
function drawBuilding(b, cx, cy) {
  const x = b.x * TS - cx, y = b.y * TS - cy, w = b.w * TS, h = b.h * TS;
  if (x > W || y > H || x + w < 0 || y + h < 0) return;
  const s = BSTYLE[b.type];
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x + 8, y + 10, w, h);
  const fh = Math.min(h * 0.5, 2 * TS), fy = y + h - fh;
  ctx.fillStyle = s.wall; ctx.fillRect(x, fy, w, fh);
  ctx.fillStyle = s.roof; ctx.fillRect(x - 4, y, w + 8, h - fh + 6);
  ctx.fillStyle = shade(s.roof, -0.15); for (let i = y + 8; i < y + h - fh; i += 10) ctx.fillRect(x - 4, i, w + 8, 2);
  ctx.fillStyle = shade(s.roof, -0.3); ctx.fillRect(x - 4, y + h - fh, w + 8, 6);
  for (let i = 0; i < b.w; i++) { if (b.x + i === b.dx) continue; const wx = x + i * TS + 8; ctx.fillStyle = b.type === 'club' || b.type === 'secret' ? '#8e44ad' : '#9fd3ff'; if (b.type === 'secret') ctx.fillStyle = '#1e272e'; ctx.fillRect(wx, fy + 18, 16, 14); ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(wx, fy + 18, 6, 14); }
  const dx = (b.dx - b.x) * TS + x;
  ctx.fillStyle = b.type === 'secret' ? '#000' : '#4a2c17'; ctx.fillRect(dx + 6, y + h - TS + 2, TS - 12, TS - 2);
  circle(dx + TS - 11, y + h - 14, 2, '#f5c542');
  if (b.type === 'secret' && S && S.belts.length >= 4 && S.badges.length >= 5) { ctx.globalAlpha = 0.4 + 0.3 * Math.sin(worldTime * 4); circle(dx + 16, y + h - 16, 22, '#74f2ce'); ctx.globalAlpha = 1; }
  font(12); const tw = ctx.measureText(b.name).width + 14;
  const neon = regionAt(b.x, b.y) === 'neon';
  ctx.fillStyle = neon ? '#111' : '#3b2a1a'; ctx.fillRect(x + w / 2 - tw / 2, fy - 12, tw, 18);
  text(b.name, x + w / 2, fy + 2, neon ? '#ff6bd6' : '#f5e6c8', 12, 'center', false);
  if (b.type === 'gym') {
    const c = OPP[b.champ]; const has = S && S.belts.includes(c.belt);
    circle(x + w / 2, y + (h - fh) / 2, 13, '#c0392b'); circle(x + w / 2 - 4, y + (h - fh) / 2 - 4, 4, '#ff8a80');
    if (has) text('★', x + w / 2 + 22, y + (h - fh) / 2 + 6, '#f5c542', 18, 'left');
  }
}
function drawWorld() {
  const cx = clamp(pl.x - W / 2, 0, MW * TS - W), cy = clamp(pl.y - H / 2, 0, MH * TS - H);
  const x0 = Math.floor(cx / TS), y0 = Math.floor(cy / TS);
  for (let ty = y0; ty <= y0 + Math.ceil(H / TS); ty++) for (let tx = x0; tx <= x0 + Math.ceil(W / TS); tx++) {
    const t = gt(tx, ty); if (t === T.WALL || t === T.DOOR) continue;
    drawTile(t, tx, ty, tx * TS - cx, ty * TS - cy);
  }
  for (const b of BADGES) if (!S.badges.includes(b.id)) {
    const bx = (b.x + .5) * TS - cx, by = (b.y + .5) * TS - cy + Math.sin(worldTime * 3) * 3;
    ctx.globalAlpha = 0.3; circle(bx, by, 14, '#fff27a'); ctx.globalAlpha = 1; text('★', bx, by + 8, '#f5c542', 22, 'center');
  }
  const ents = [];
  for (const b of BUILD) ents.push({ y: (b.y + b.h) * TS, d: () => drawBuilding(b, cx, cy) });
  for (const n of NPC) ents.push({ y: n.y, d: () => {
    const x = n.x - cx, y = n.y - cy; if (x < -40 || x > W + 40 || y < -40 || y > H + 40) return;
    drawPerson(x, y, n.dir, n.c, n.ph, n.tx != null, n.fighter ? n.c.glove : null);
    const near = Math.hypot(n.x - pl.x, n.y - pl.y);
    if (n.fighter && !S.beaten[n.fighter] && near < 140) { circle(x, y - 50, 9, '#e74c3c'); text('!', x, y - 45, '#fff', 14, 'center', false); }
    if (near < 90) text(n.name, x, y - 40 - (n.fighter && !S.beaten[n.fighter] ? 20 : 0), n.fighter ? '#ff9c6b' : '#fff', 11, 'center');
  } });
  ents.push({ y: pl.y, d: () => drawPerson(pl.x - cx, pl.y - cy, pl.dir, { skin: '#c98b5b', shirt: '#1f9d55', pants: '#2c3e50', hair: '#2a1a0e' }, pl.ph, pl.moving, '#27ae60') });
  ents.sort((a, b) => a.y - b.y).forEach(e => e.d());
  for (const g of GATES) if (!S.belts.includes(g.belt)) {
    const [gx, gy] = g.tiles[0]; const horiz = g.tiles[0][0] === g.tiles[1][0];
    const px = (gx + (horiz ? 0.5 : 1)) * TS - cx, py = (gy + (horiz ? 1 : 0.4)) * TS - cy + (horiz ? 18 : -14);
    drawPerson(px + (horiz ? 26 : 0), py, 'down', { skin: '#e0ac69', shirt: '#34495e', pants: '#2c3e50', hair: '#111' }, 0, false, null);
  }
  // HUD
  ctx.fillStyle = 'rgba(0,0,0,.55)'; rrect(10, 10, 300, 40, 8); ctx.fill();
  text('$' + S.money, 22, 37, '#7CFC9A', 18);
  BELT_ORDER.forEach((k, i) => { const has = S.belts.includes(k); circle(122 + i * 22, 30, 8, has ? '#f5c542' : '#333'); circle(122 + i * 22, 30, 4, has ? REG[k].col : '#222'); });
  text('★ ' + S.badges.length + '/5', 218, 37, '#f5c542', 16);
  text('🥤' + S.shakes, 270, 36, '#fff', 14, 'left', false);
  if (bannerT > 0) { ctx.globalAlpha = clamp(bannerT, 0, 1); text(REG[curRegion].name.toUpperCase(), 480, 90, REG[curRegion].col, 34, 'center'); ctx.globalAlpha = 1; }
  if (toastT > 0) text(toast, 480, 130, '#fff', 18, 'center');
  if (!ui) text('E/SPACE talk & enter   SHIFT jog   M map   ESC menu', 480, 530, 'rgba(255,255,255,.6)', 12, 'center');
  if (showMap) drawMap();
}
function drawMap() {
  ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(0, 0, W, H);
  const mx = (W - MW * 4) / 2, my = 70;
  panel(mx - 14, my - 50, MW * 4 + 28, MH * 4 + 70);
  text('MAP OF THE KNOCKOUT KINGDOM', 480, my - 20, '#f5c542', 18, 'center');
  ctx.drawImage(minimap, mx, my);
  const lab = [['rookie', 25, 76], ['docks', 81, 70], ['neon', 81, 37], ['summit', 25, 37]];
  for (const [k, x, y] of lab) text(REG[k].name, mx + x * 4, my + y * 4, '#fff', 13, 'center');
  for (const b of BUILD) if (b.type === 'gym') { const c = OPP[b.champ]; text(S.belts.includes(c.belt) ? '★' : 'G', mx + (b.x + b.w / 2) * 4, my + (b.y + b.h / 2) * 4 + 5, S.belts.includes(c.belt) ? '#f5c542' : '#fff', 14, 'center'); }
  if (Math.floor(worldTime * 4) % 2) circle(mx + pl.x / TS * 4, my + pl.y / TS * 4, 5, '#fff');
  circle(mx + pl.x / TS * 4, my + pl.y / TS * 4, 3, '#2ecc71');
  text('G = gym   ★ = belt won   red bars = gates   (any button to close)', 480, my + MH * 4 + 12, '#aaa', 12, 'center', false);
}

// ---------------------------------------------------------------- title
let titleSel = 0, titleT = 0;
function titleOpts() { const o = []; if (loadSave()) o.push('Continue'); o.push('New Game'); return o; }
function updTitle(dt) {
  titleT += dt; const opts = titleOpts();
  if (hit('up') || hit('down')) { titleSel = (titleSel + 1) % opts.length; SFX.blip(); }
  titleSel = Math.min(titleSel, opts.length - 1);
  if (adv()) {
    const o = opts[titleSel]; SFX.bell();
    if (o === 'Continue') S = loadSave(); else S = NEW_SAVE();
    S.flags = S.flags || {};
    pl.x = S.px; pl.y = S.py; if (blocked(pl.x, pl.y, 9)) { pl.x = 10.5 * TS; pl.y = 57.6 * TS; }
    applyGates(); makeNPCs(); mode = 'world'; curRegion = ''; save();
    if (o === 'New Game') say('Coach Mabel', coachLines());
  }
}
function drawTitle() {
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#120a24'); g.addColorStop(1, '#3a0d1f'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) { const x = (i * 97 + titleT * 20) % W, y = (i * 53) % 260; circle(x, y, 1.5, 'rgba(255,255,255,.5)'); }
  const sp = ctx.createRadialGradient(480, 200, 10, 480, 200, 360); sp.addColorStop(0, 'rgba(255,200,120,.25)'); sp.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = sp; ctx.fillRect(0, 0, W, H);
  const b = Math.sin(titleT * 3) * 6;
  drawGlove({ x: 200, y: 200 + b, r: 70 }, '#c0392b', 0); drawGlove({ x: 760, y: 200 - b, r: 70 }, '#27ae60', 0);
  ctx.shadowColor = '#ff4d6d'; ctx.shadowBlur = 24;
  text('KNOCKOUT', 480, 170, '#ffd84a', 72, 'center'); text('KINGDOM', 480, 245, '#ff6b6b', 72, 'center');
  ctx.shadowBlur = 0;
  text('an open-world arcade boxing adventure', 480, 285, '#ddd', 18, 'center');
  const opts = titleOpts();
  opts.forEach((o, i) => text((i === titleSel ? '▶ ' : '  ') + o, 480, 350 + i * 36, i === titleSel ? '#fff' : '#888', 24, 'center'));
  text('Arrows/WASD + Z/X/SPACE/ENTER   •   Press ENTER', 480, 470, '#999', 14, 'center', false);
  text('Explore 4 regions, beat 4 champions, find 5 hidden star badges.', 480, 500, '#777', 13, 'center', false);
}

// ---------------------------------------------------------------- main loop
let last = performance.now(), lastErr = null;
function update(dt) {
  if (mode === 'title') return updTitle(dt);
  if (mode === 'status') { if (adv() || hit('menu')) mode = 'world'; return; }
  if (ui) { worldTime += dt; return updUI(dt); }
  if (mode === 'world') updWorld(dt);
  else if (mode === 'fight') updFight(dt);
  else if (mode === 'train') updTrain(dt);
}
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  if (mode === 'title') drawTitle();
  else if (mode === 'world') drawWorld();
  else if (mode === 'status') drawStatus();
  else if (mode === 'fight') drawFight();
  else if (mode === 'train') drawTrain();
  drawUI();
  if (lastErr) text('Error: ' + lastErr, 10, H - 10, '#f66', 12, 'left');
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  try { update(dt); draw(); } catch (e) { lastErr = e.message; console.error(e); }
  pressed.clear(); requestAnimationFrame(frame);
}
buildWorld(); buildMinimap();
window.__kk = { get mode() { return mode; }, get F() { return F; }, get S() { return S; }, get ui() { return ui; }, pl, startFight, keys, pressed, OPP };
requestAnimationFrame(frame);
})();
