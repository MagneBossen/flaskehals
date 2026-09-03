// The room state machine. Every transition runs here on the server so that the
// spin result, the question, and the moment the wheel lands are decided once and
// broadcast — never computed on a client.
//
//   lobby → (countdown) → writing → wheel → result → wheel ...
//                            ↑                  ↓
//                            └──── refill ←── (pool empty)
//                                              → over

const R = require('./rooms');

// FH_FAST shrinks every wait so the socket harness can walk the whole game in
// seconds. Never set in production.
const F = process.env.FH_FAST ? Number(process.env.FH_FAST) || 10 : 1;

const COUNTDOWN_MS = 5000 / F;
const REFILL_EMPTY_MS = (30 * 1000) / F;   // "no questions yet — 30 more seconds"
const REFILL_WINDOW_MS = (60 * 1000) / F;  // "the pool's empty — 60 seconds, 5 more each"
const SPIN_DURATION_MS = 4400 / F;
const SPIN_LEAD_MS = 150;                   // gap between broadcast and animation start
const COOLDOWN_MS = 3000 / F;
const SOFTLOCK_MS = (45 * 1000) / F;
const SKIP_HOLD_MS = 2800 / F;             // show the punishment, then roll on — no second tap
const MAX_QUESTIONS_PER_PLAYER = 5;

// --- broadcast --------------------------------------------------------------
// Each player gets a personalised snapshot (their own question count, whether
// the wheel landed on them), so state goes out per-socket rather than to the
// socket.io room as one blob.

function broadcast(io, room) {
  R.touch(room);
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('room:state', R.publicState(room, p.id));
  }
}

function emitAll(io, room, event, payload) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit(event, payload);
  }
}

function clearTimer(room, key) {
  if (room._timers[key]) {
    clearTimeout(room._timers[key]);
    room._timers[key] = null;
  }
}

function clearAllTimers(room) {
  Object.keys(room._timers).forEach((k) => clearTimer(room, k));
}

// --- lobby → writing -------------------------------------------------------

function startCountdown(io, room) {
  if (room.phase !== 'lobby') return;
  if (R.activePlayers(room).length < 2) return;
  if (room._timers.countdown) return; // already counting
  const endsAt = R.serverNow() + COUNTDOWN_MS;
  room._timers.countdown = setTimeout(() => {
    room._timers.countdown = null;
    beginWriting(io, room);
  }, COUNTDOWN_MS);
  emitAll(io, room, 'countdown:start', { endsAt });
}

function cancelCountdown(io, room) {
  if (!room._timers.countdown) return;
  clearTimer(room, 'countdown');
  emitAll(io, room, 'countdown:cancel', {});
}

function beginWriting(io, room) {
  const duration = (room.settings.writingSeconds * 1000) / F;
  room.phase = 'writing';
  room.currentRound = null;
  room.forceContinue = false;
  room.players.forEach((p) => { p.questionsWritten = room.questions.filter((q) => q.authorId === p.id).length; });
  room.timer = { startAt: R.serverNow(), duration };
  clearTimer(room, 'phase');
  room._timers.phase = setTimeout(() => endWriting(io, room), duration);
  broadcast(io, room);
}

function endWriting(io, room) {
  if (room.phase !== 'writing') return;
  if (room.questions.length === 0) {
    // Empty pool: don't drop into a dead wheel. Reopen briefly.
    room.timer = { startAt: R.serverNow(), duration: REFILL_EMPTY_MS };
    room._timers.phase = setTimeout(() => endWriting(io, room), REFILL_EMPTY_MS);
    emitAll(io, room, 'pool:empty', { reopenedMs: REFILL_EMPTY_MS });
    broadcast(io, room);
    return;
  }
  beginWheel(io, room);
}

// --- wheel ----------------------------------------------------------------

function beginWheel(io, room) {
  room.phase = 'wheel';
  room.timer = null;
  room.spinLock = false;
  room.forceContinue = false;
  room.currentRound = null;
  room.activeSpin = null;
  clearAllTimers(room);
  broadcast(io, room);
}

function eligible(room) {
  const active = R.activePlayers(room);
  const fresh = active.filter((p) => !p.pickedThisCycle);
  return fresh.length ? fresh : active; // cycle exhausted → everyone eligible again
}

function spin(io, room) {
  if (room.phase !== 'wheel' || room.spinLock) return;
  if (R.serverNow() < room.cooldownUntil) return;
  const pool = room.questions.filter((q) => !q.used);
  if (pool.length === 0) return beginRefill(io, room);
  const candidates = eligible(room);
  if (candidates.length === 0) return;

  // If the fresh set was empty we just rolled the cycle over — clear the flags.
  if (!R.activePlayers(room).some((p) => !p.pickedThisCycle)) {
    room.players.forEach((p) => { p.pickedThisCycle = false; });
  }

  const winner = candidates[Math.floor(Math.random() * candidates.length)];
  const question = pool[Math.floor(Math.random() * pool.length)];

  room.spinLock = true;
  winner.pickedThisCycle = true;
  question.used = true;

  // Wheel geometry. Segments are the ACTIVE players in array order; the pointer
  // sits at the top (12 o'clock). We send a resting angle (mod 360) and a number
  // of whole turns; the client works out the shortest forward path from wherever
  // its wheel currently sits to that resting angle. Same rest angle on every
  // phone → lands on the same person. Jitter keeps it from looking mechanical
  // and is baked into the rest angle so every phone shares it.
  const segs = R.activePlayers(room);
  const idx = segs.findIndex((p) => p.id === winner.id);
  const segAngle = 360 / segs.length;
  const jitter = (Math.random() - 0.5) * segAngle * 0.55;
  // segment i is centred at (i + 0.5) * segAngle clockwise from the top; rotate
  // the wheel by (360 - that) to bring it under the top pointer.
  let restAngleDeg = (360 - (idx + 0.5) * segAngle + jitter) % 360;
  if (restAngleDeg < 0) restAngleDeg += 360;
  const spinsDeg = (5 + Math.floor(Math.random() * 3)) * 360;

  const startAt = R.serverNow() + SPIN_LEAD_MS;
  // Kept on the room too, so a phone that joins or reconnects mid-spin can pick
  // the animation up from room:state instead of staring at a frozen wheel.
  room.activeSpin = {
    selectedPlayerId: winner.id,
    order: segs.map((p) => p.id),
    restAngleDeg,
    spinsDeg,
    spinDurationMs: SPIN_DURATION_MS,
    startAt,
  };
  emitAll(io, room, 'round:spin', room.activeSpin);

  clearTimer(room, 'phase');
  room._timers.phase = setTimeout(() => land(io, room, winner.id, question.id), SPIN_LEAD_MS + SPIN_DURATION_MS);
  broadcast(io, room);
}

function land(io, room, playerId, questionId) {
  room.phase = 'result';
  room.currentRound = { selectedPlayerId: playerId, questionId, skipped: false, punishmentShown: null };
  room.activeSpin = null;
  room.forceContinue = false;
  emitAll(io, room, 'round:landed', { selectedPlayerId: playerId });
  // Anti-softlock: if the picked player never taps, let anyone advance.
  clearTimer(room, 'softlock');
  room._timers.softlock = setTimeout(() => {
    room.forceContinue = true;
    emitAll(io, room, 'round:force-continue', {});
    broadcast(io, room);
  }, SOFTLOCK_MS);
  broadcast(io, room);
}

function baselinePunishment(room, question) {
  const setting = room.settings.punishment;
  if (setting === 'off') return null;
  if (setting === 'drink') return { type: 'drink', text: null };
  if (setting === 'dare') return { type: 'dare', text: question && question.dare ? question.dare : null };
  // both: prefer the author's dare, fall back to a drink
  if (question && question.dare) return { type: 'dare', text: question.dare };
  return { type: 'drink', text: null };
}

function skip(io, room, playerId) {
  if (room.phase !== 'result' || !room.currentRound || room.currentRound.skipped) return;
  if (room.currentRound.selectedPlayerId !== playerId) return;
  const q = room.questions.find((x) => x.id === room.currentRound.questionId);
  room.currentRound.skipped = true;
  room.currentRound.punishmentShown = baselinePunishment(room, q);
  broadcast(io, room);
  // Skip = "I drink, move on." Show the punishment for a beat, then roll
  // straight on — never make anyone tap a second time.
  clearTimer(room, 'softlock');
  clearTimer(room, 'skip');
  room._timers.skip = setTimeout(() => advanceFromResult(io, room), SKIP_HOLD_MS);
}

function continueRound(io, room, playerId) {
  if (room.phase !== 'result' || !room.currentRound) return;
  const isPicked = room.currentRound.selectedPlayerId === playerId;
  if (!isPicked && !room.forceContinue) return;
  advanceFromResult(io, room);
}

// result → wheel + cooldown. Shared by the picked player tapping "continue", a
// skip's auto-advance, and the force-continue path.
function advanceFromResult(io, room) {
  if (room.phase !== 'result' || !room.currentRound) return;

  room.history.push({
    playerId: room.currentRound.selectedPlayerId,
    questionId: room.currentRound.questionId,
    skipped: room.currentRound.skipped,
  });

  clearTimer(room, 'softlock');
  clearTimer(room, 'skip');
  room.phase = 'wheel';
  room.spinLock = true; // stays locked through the cooldown
  room.currentRound = null;
  room.forceContinue = false;
  room.cooldownUntil = R.serverNow() + COOLDOWN_MS;

  const remaining = room.questions.filter((x) => !x.used).length;
  broadcast(io, room);

  clearTimer(room, 'phase');
  room._timers.phase = setTimeout(() => {
    if (remaining === 0) return beginRefill(io, room);
    room.spinLock = false;
    broadcast(io, room);
  }, COOLDOWN_MS);
}

// A player left or dropped. A disconnect is a guess and the softlock timer
// covers it; an explicit leave is a fact — if they were the one on the spot in
// a result, don't make the whole room wait out the 45s softlock.
function onPlayerGone(io, room, playerId) {
  if (room.phase !== 'result' || !room.currentRound) return;
  if (room.currentRound.selectedPlayerId !== playerId || room.forceContinue) return;
  clearTimer(room, 'softlock');
  room.forceContinue = true;
  emitAll(io, room, 'round:force-continue', {});
}

// --- refill / end -------------------------------------------------------

function beginRefill(io, room) {
  room.phase = 'refill';
  room.spinLock = false;
  room.currentRound = null;
  room.players.forEach((p) => { p.questionsWritten = room.questions.filter((q) => q.authorId === p.id && !q.used).length; });
  room.timer = { startAt: R.serverNow(), duration: REFILL_WINDOW_MS };
  clearTimer(room, 'phase');
  room._timers.phase = setTimeout(() => {
    const more = room.questions.filter((q) => !q.used).length;
    if (more === 0) return endGame(io, room);
    beginWheel(io, room);
  }, REFILL_WINDOW_MS);
  broadcast(io, room);
}

function endGame(io, room) {
  clearAllTimers(room);
  room.phase = 'over';
  room.timer = null;
  room.currentRound = null;

  const rounds = room.history.length;
  const pickCount = {};
  const skipCount = {};
  for (const h of room.history) {
    pickCount[h.playerId] = (pickCount[h.playerId] || 0) + 1;
    if (h.skipped) skipCount[h.playerId] = (skipCount[h.playerId] || 0) + 1;
  }
  const name = (id) => (R.playerById(room, id) || {}).name || '—';
  const top = (obj) => {
    const e = Object.entries(obj).sort((a, b) => b[1] - a[1])[0];
    return e ? { name: name(e[0]), count: e[1] } : null;
  };
  room.recapData = {
    rounds,
    mostPicked: top(pickCount),
    mostSkipped: top(skipCount),
  };
  broadcast(io, room);
}

// "Play again" from the over screen — same room, same players, fresh game.
// Nobody has to re-join.
function restartGame(io, room) {
  if (room.phase !== 'over') return;
  clearAllTimers(room);
  room.phase = 'lobby';
  room.questions = [];
  room.history = [];
  room.recapData = null;
  room.currentRound = null;
  room.activeSpin = null;
  room.timer = null;
  room.spinLock = false;
  room.cooldownUntil = 0;
  room.forceContinue = false;
  room.players.forEach((p) => { p.pickedThisCycle = false; p.questionsWritten = 0; });
  emitAll(io, room, 'game:restarted', {});
  broadcast(io, room);
}

// --- writing-phase question edits -------------------------------------

function addQuestion(io, room, player, text, dare) {
  if (!['writing', 'refill'].includes(room.phase)) return { error: 'wrong-phase' };
  const clean = String(text || '').trim().slice(0, 240);
  if (!clean) return { error: 'empty' };
  const mineUnused = room.questions.filter((q) => q.authorId === player.id && !q.used).length;
  if (mineUnused >= MAX_QUESTIONS_PER_PLAYER) return { error: 'limit' };
  const wantsDare = ['dare', 'both'].includes(room.settings.punishment);
  const q = {
    id: 'q_' + Math.random().toString(36).slice(2, 10),
    text: clean,
    authorId: player.id,
    dare: wantsDare && dare ? String(dare).trim().slice(0, 160) : null,
    used: false,
  };
  room.questions.push(q);
  player.questionsWritten = room.questions.filter((x) => x.authorId === player.id).length;
  broadcast(io, room);
  return { ok: true, id: q.id };
}

function removeQuestion(io, room, player, questionId) {
  if (!['writing', 'refill'].includes(room.phase)) return;
  const i = room.questions.findIndex((q) => q.id === questionId && q.authorId === player.id && !q.used);
  if (i === -1) return;
  room.questions.splice(i, 1);
  player.questionsWritten = room.questions.filter((x) => x.authorId === player.id).length;
  broadcast(io, room);
}

module.exports = {
  MAX_QUESTIONS_PER_PLAYER,
  broadcast,
  emitAll,
  clearAllTimers,
  startCountdown,
  cancelCountdown,
  beginWriting,
  spin,
  skip,
  onPlayerGone,
  continueRound,
  beginRefill,
  endGame,
  restartGame,
  addQuestion,
  removeQuestion,
};
