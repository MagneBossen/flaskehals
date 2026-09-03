const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const R = require('./rooms');
const G = require('./game');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
// Render terminates TLS and forwards over plain http; without this req.protocol
// is "http" and every share link / QR points at an insecure URL.
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// A phone can't reach the host's "localhost". When someone is testing via
// localhost we swap in the LAN address so share links resolve from a handset.
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const virtual = /^(utun|tun|tap|bridge|vmnet|vboxnet|docker)/i.test(name);
      candidates.push({ address: a.address, rank: virtual ? 1 : 0 });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates.length ? candidates[0].address : null;
}
const LAN_IP = lanAddress();

function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host || '');
}

function shareOrigin(req) {
  const host = req && req.headers && req.headers.host;
  if (host && !isLocalHost(host)) return req.protocol + '://' + host;
  if (!LAN_IP) return null;
  const port = host && host.includes(':') ? host.split(':').pop() : PORT;
  return 'http://' + LAN_IP + ':' + port;
}

app.use(express.static(path.join(ROOT, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/join/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.get('/health', (req, res) => res.json({ ok: true, rooms: R.count() }));

app.get('/share-origin', (req, res) => {
  res.json({ origin: shareOrigin(req), lan: !!LAN_IP });
});

// QR for a live room, pointed at the join route. URL is built server-side from
// just the code, so it can't be aimed anywhere else.
app.get('/qr/:code.svg', async (req, res) => {
  const room = R.getRoom(req.params.code);
  if (!room) return res.status(404).type('text/plain').send('no such room');
  const origin = shareOrigin(req);
  if (!origin) return res.status(503).type('text/plain').send('no reachable address');
  try {
    // Link format is just the join route for now — change here if it ever moves
    // to a marketing domain or a deep link.
    const svg = await QRCode.toString(origin + '/join/' + room.code, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1,
      color: { dark: '#14110C', light: '#FFFFFF' },
    });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) {
    res.status(500).type('text/plain').send('qr failed');
  }
});

// --- sockets -------------------------------------------------------------

function ack(cb) {
  return typeof cb === 'function' ? cb : () => {};
}

function attachSocket(room, player, socket) {
  player.socketId = socket.id;
  player.connected = true;
  if (player._dropTimer) { clearTimeout(player._dropTimer); player._dropTimer = null; }
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join('bottle:' + room.code);
}

io.on('connection', (socket) => {
  // Clock sync: client pings a few times, keeps the lowest-RTT sample.
  socket.on('time:ping', (clientT, cb) => ack(cb)({ server: R.serverNow(), clientT }));

  socket.on('room:create', (payload, cb) => {
    const done = ack(cb);
    const name = String((payload && payload.name) || '').trim().slice(0, 24);
    if (!name) return done({ error: 'no-name' });
    // Rate limit: at most 3 room creations per minute from one socket.
    const now = Date.now();
    socket.data.creates = (socket.data.creates || []).filter((ts) => now - ts < 60000);
    if (socket.data.creates.length >= 3) return done({ error: 'busy' });
    const room = R.createRoom((payload && payload.settings) || {});
    if (!room) return done({ error: 'busy' }); // global room cap hit
    socket.data.creates.push(now);
    const player = R.addPlayer(room, name);
    attachSocket(room, player, socket);
    done({ ok: true, code: room.code, playerId: player.id, token: player.token });
    G.broadcast(io, room);
  });

  socket.on('room:join', (payload, cb) => {
    const done = ack(cb);
    const room = R.getRoom(payload && payload.code);
    const name = String((payload && payload.name) || '').trim().slice(0, 24);
    if (!room) return done({ error: 'no-room' });
    if (!name) return done({ error: 'no-name' });
    if (R.nameTaken(room, name)) return done({ error: 'name-taken' });
    // Count seats, not live connections — a locked phone still holds its seat.
    if (room.players.length >= R.MAX_PLAYERS) return done({ error: 'full' });
    // Late joiners are allowed in as normal, selectable players (spec's simplest
    // option) — they just haven't contributed questions.
    const player = R.addPlayer(room, name);
    attachSocket(room, player, socket);
    done({ ok: true, code: room.code, playerId: player.id, token: player.token });
    G.broadcast(io, room);
  });

  // Rejoin the same seat after a refresh / phone lock. The single most likely
  // thing to break at a real party, per the spec.
  socket.on('room:rejoin', (payload, cb) => {
    const done = ack(cb);
    const room = R.getRoom(payload && payload.code);
    if (!room) return done({ error: 'no-room' });
    const player = R.playerByToken(room, payload && payload.token);
    if (!player) return done({ error: 'no-seat' });
    // Drop any stale socket still mapped to this player, so a delayed disconnect
    // from it can't later knock this fresh session offline.
    if (player.socketId && player.socketId !== socket.id) {
      const stale = io.sockets.sockets.get(player.socketId);
      if (stale) {
        stale.data.code = null;
        stale.data.playerId = null;
        stale.leave('bottle:' + room.code);
      }
    }
    attachSocket(room, player, socket);
    done({ ok: true, code: room.code, playerId: player.id, token: player.token });
    G.broadcast(io, room);
  });

  function myRoomAndPlayer() {
    const room = R.getRoom(socket.data.code);
    if (!room) return {};
    const player = R.playerById(room, socket.data.playerId);
    return { room, player };
  }

  socket.on('player:avatar', (payload) => {
    const { room, player } = myRoomAndPlayer();
    if (room && player && R.setAvatar(room, player.id, payload && payload.avatar)) {
      G.broadcast(io, room);
    }
  });

  socket.on('writing:start', () => {
    const { room } = myRoomAndPlayer();
    if (room) G.startCountdown(io, room);
  });
  socket.on('writing:cancel', () => {
    const { room } = myRoomAndPlayer();
    if (room) G.cancelCountdown(io, room);
  });

  socket.on('question:add', (payload, cb) => {
    const { room, player } = myRoomAndPlayer();
    if (!room || !player) return ack(cb)({ error: 'gone' });
    ack(cb)(G.addQuestion(io, room, player, payload && payload.text, payload && payload.dare));
  });
  socket.on('question:remove', (payload) => {
    const { room, player } = myRoomAndPlayer();
    if (room && player) G.removeQuestion(io, room, player, payload && payload.id);
  });

  socket.on('wheel:spin', () => {
    const { room } = myRoomAndPlayer();
    if (room) G.spin(io, room);
  });
  socket.on('round:skip', () => {
    const { room, player } = myRoomAndPlayer();
    if (room && player) G.skip(io, room, player.id);
  });
  socket.on('round:continue', () => {
    const { room, player } = myRoomAndPlayer();
    if (room && player) G.continueRound(io, room, player.id);
  });

  socket.on('refill:end-game', () => {
    const { room } = myRoomAndPlayer();
    if (room) G.endGame(io, room);
  });

  socket.on('game:restart', () => {
    const { room } = myRoomAndPlayer();
    if (room) G.restartGame(io, room);
  });

  // Explicit leave — drop the seat straight away, no rejoin grace.
  socket.on('room:leave', () => {
    const { room, player } = myRoomAndPlayer();
    if (!room || !player) return;
    socket.leave('bottle:' + room.code);
    socket.data.code = null;
    socket.data.playerId = null;
    G.onPlayerGone(io, room, player.id);
    R.removePlayer(room, player.id);
    if (R.activePlayers(room).length === 0) R.endRoom(room.code);
    else G.broadcast(io, room);
  });

  socket.on('disconnect', () => {
    const { room, player } = myRoomAndPlayer();
    if (!room || !player) return;
    // This socket may have already been superseded: the player reloaded / scanned
    // the QR again and rejoined on a fresh socket while this one was still lingering
    // (mobile Safari often never sends a clean disconnect). If so, a late disconnect
    // here must NOT knock the live session offline.
    if (player.socketId && player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    if (player._dropTimer) clearTimeout(player._dropTimer);
    G.broadcast(io, room);
    // Hold the seat for the rejoin window, then drop them.
    player._dropTimer = setTimeout(() => {
      G.onPlayerGone(io, room, player.id);
      R.removePlayer(room, player.id);
      if (R.activePlayers(room).length === 0) {
        R.endRoom(room.code);
        return;
      }
      G.broadcast(io, room);
    }, R.REJOIN_WINDOW_MS);
  });
});

server.listen(PORT, () => {
  console.log('Flaskehals listening on http://localhost:' + PORT);
  if (LAN_IP) console.log('  LAN → http://' + LAN_IP + ':' + PORT);
});
