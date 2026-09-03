// In-memory room store. Nothing survives a restart — party games are ephemeral.
// Unlike Vinylle (where the DJ's browser is the authority), here THE SERVER owns
// the game state: it has to, because the spin result and its timing must be
// identical on every phone. A room is just a plain object plus a few timer
// handles the game module manages.

const { freshCode } = require('./codes');

// FH_FAST shrinks every wait so the test harness can walk the whole game in
// seconds — same divisor game.js uses. Never set in production.
const F = process.env.FH_FAST ? Number(process.env.FH_FAST) || 10 : 1;

const IDLE_ROOM_MS = 2 * 60 * 60 * 1000;      // sweep rooms with no activity (spec)
const REJOIN_WINDOW_MS = (2 * 60 * 1000) / F; // how long a dropped player holds their seat
const MAX_PLAYERS = 20;                    // wheel labels shrink to initials past ~12
const MAX_ROOMS = 500;                     // hard cap so a script can't grow memory unbounded

// Assigned round-robin as players arrive so a name list still feels alive.
// Ordered so the first handful of players land on well-separated hues.
const COLORS = [
  '#E8563F', '#3FA8C4', '#F7D154', '#A05CC4', '#5FB56A',
  '#E06C9F', '#F2A93B', '#5C6BC0', '#4A9E8F', '#C77DFF',
  '#6D8B3C', '#7C5C3E', '#2E8B8B', '#D64550', '#3B7DD8',
  '#B0883B', '#8E44AD', '#5B8C3A', '#C2568C', '#4C6EF5',
];
// Avatar ids — single source of truth shared with the client (which fetches the
// same file). The WebP for each lives in public/avatars/<id>.webp.
const AVATARS = require('../public/avatar-ids.json');

const rooms = new Map();

function serverNow() {
  return Date.now();
}

function randomId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function createRoom(settings) {
  if (rooms.size >= MAX_ROOMS) return null;
  const code = freshCode((c) => rooms.has(c));
  const room = {
    code,
    phase: 'lobby',
    settings: {
      // Language is intentionally NOT here — it's a per-device choice stored in
      // each client's localStorage, never sent to the server or shared.
      showAuthors: !!settings.showAuthors,
      punishment: ['off', 'drink', 'dare', 'both'].includes(settings.punishment) ? settings.punishment : 'drink',
      writingSeconds: settings.writingSeconds === 120 ? 120 : 90,
    },
    players: [],
    questions: [],
    timer: null,                 // { startAt, duration } — server timestamps
    currentRound: null,          // { selectedPlayerId, questionId, skipped, punishmentShown }
    activeSpin: null,            // live spin descriptor while the wheel turns (for late joiners)
    spinLock: false,
    cooldownUntil: 0,
    forceContinue: false,        // anti-softlock: anyone may advance
    history: [],                 // { playerId, questionId, skipped }
    recapData: null,
    createdAt: serverNow(),
    touchedAt: serverNow(),
    _timers: {},                 // phase/cooldown/softlock handles, owned by game.js
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  if (!code) return null;
  return rooms.get(String(code).trim().toUpperCase()) || null;
}

function touch(room) {
  room.touchedAt = serverNow();
}

function activePlayers(room) {
  return room.players.filter((p) => p.connected);
}

function freeAvatars(room) {
  const used = new Set(room.players.map((p) => p.avatar));
  return AVATARS.filter((a) => !used.has(a));
}

function addPlayer(room, name) {
  const used = new Set(room.players.map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[room.players.length % COLORS.length];
  const freeA = freeAvatars(room);
  const avatar = (freeA.length ? freeA : AVATARS)[Math.floor(Math.random() * (freeA.length || AVATARS.length))];

  const player = {
    id: randomId('p'),
    token: randomId('t') + Math.random().toString(36).slice(2, 10),
    name,
    color,
    avatar,
    connected: true,
    pickedThisCycle: false,
    questionsWritten: 0,
    socketId: null,
    _dropTimer: null,
  };
  room.players.push(player);
  touch(room);
  return player;
}

function playerByToken(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token) || null;
}

function playerById(room, id) {
  return room.players.find((p) => p.id === id) || null;
}

function nameTaken(room, name) {
  const norm = name.trim().toLowerCase();
  return room.players.some((p) => p.name.trim().toLowerCase() === norm);
}

function removePlayer(room, playerId) {
  const i = room.players.findIndex((p) => p.id === playerId);
  if (i === -1) return null;
  const [gone] = room.players.splice(i, 1);
  if (gone._dropTimer) clearTimeout(gone._dropTimer);
  touch(room);
  return gone;
}

function endRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  Object.values(room._timers).forEach((t) => t && clearTimeout(t));
  room.players.forEach((p) => p._dropTimer && clearTimeout(p._dropTimer));
  rooms.delete(code);
}

// Public snapshot sent to clients. Question TEXT is never included here — the
// pool is blind until a question comes up on the wheel (spec). Only counts leak.
function publicState(room, forPlayerId) {
  return {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      avatar: p.avatar,
      connected: p.connected,
      pickedThisCycle: p.pickedThisCycle,
      questionsWritten: p.questionsWritten,
      isMe: p.id === forPlayerId,
    })),
    freeAvatars: freeAvatars(room),
    pool: {
      total: room.questions.length,
      remaining: room.questions.filter((q) => !q.used).length,
      mine: room.questions.filter((q) => q.authorId === forPlayerId).length,
    },
    // A player may see and manage their OWN questions (they wrote them); the
    // rest of the pool stays blind until it comes up on the wheel.
    myQuestions: room.questions
      .filter((q) => q.authorId === forPlayerId && !q.used)
      .map((q) => ({ id: q.id, text: q.text, dare: q.dare || null })),
    timer: room.timer,
    activeSpin: room.activeSpin || null,
    spinLock: room.spinLock,
    cooldownUntil: room.cooldownUntil,
    forceContinue: room.forceContinue,
    currentRound: revealRound(room, forPlayerId),
    recapData: room.recapData,
    maxPlayers: MAX_PLAYERS,
    now: serverNow(),
  };
}

// The current round is only meaningful in result phase, where the question IS
// revealed to everyone at once.
function revealRound(room, forPlayerId) {
  if (!room.currentRound) return null;
  const q = room.questions.find((x) => x.id === room.currentRound.questionId) || null;
  const author = q ? playerById(room, q.authorId) : null;
  return {
    selectedPlayerId: room.currentRound.selectedPlayerId,
    isMe: room.currentRound.selectedPlayerId === forPlayerId,
    questionText: q ? q.text : '',
    dare: q ? (q.dare || null) : null,
    authorName: room.settings.showAuthors && author ? author.name : null,
    skipped: room.currentRound.skipped,
    punishmentShown: room.currentRound.punishmentShown || null,
  };
}

// Sweep abandoned rooms.
setInterval(() => {
  const cutoff = serverNow() - IDLE_ROOM_MS;
  for (const room of Array.from(rooms.values())) {
    if (room.touchedAt < cutoff) endRoom(room.code);
  }
}, 10 * 60 * 1000).unref();

// Change a player's avatar to any that isn't currently taken by someone else.
function setAvatar(room, playerId, avatar) {
  if (!AVATARS.includes(avatar)) return false;
  const taken = room.players.some((p) => p.id !== playerId && p.avatar === avatar);
  if (taken) return false;
  const player = playerById(room, playerId);
  if (!player) return false;
  player.avatar = avatar;
  touch(room);
  return true;
}

module.exports = {
  IDLE_ROOM_MS,
  REJOIN_WINDOW_MS,
  MAX_PLAYERS,
  MAX_ROOMS,
  AVATARS,
  serverNow,
  createRoom,
  getRoom,
  touch,
  activePlayers,
  addPlayer,
  playerByToken,
  playerById,
  nameTaken,
  removePlayer,
  setAvatar,
  endRoom,
  publicState,
  count: () => rooms.size,
  _rooms: rooms,
};
