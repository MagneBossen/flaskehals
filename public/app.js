import { STRINGS, CHIPS, THEMES } from '/strings.js';
import { Wheel } from '/wheel.js';
import { AVATAR_IDS, avatarImg } from '/avatars.js';
import { loaderMarkup } from '/loaders.js';

const socket = io();
const $app = document.getElementById('app');

// --- persistent client bits (spec: localStorage only) --------------------
const LS = {
  get creds() { try { return JSON.parse(localStorage.getItem('fh_creds') || 'null'); } catch { return null; } },
  set creds(v) { v ? localStorage.setItem('fh_creds', JSON.stringify(v)) : localStorage.removeItem('fh_creds'); },
  get lang() { return localStorage.getItem('fh_lang') || null; },
  set lang(v) { v ? localStorage.setItem('fh_lang', v) : localStorage.removeItem('fh_lang'); },
  get name() { return capFirst(localStorage.getItem('fh_name') || ''); },
  set name(v) { const s = capFirst((v || '').replace(/^\s+/, '')); s.trim() ? localStorage.setItem('fh_name', s) : localStorage.removeItem('fh_name'); },
};

// --- local UI state -----------------------------------------------------
let view = 'landing';          // landing | create | join  (before a room)
let room = null;               // last room:state snapshot
let me = LS.creds || null;     // { code, playerId, token }
let clockOffset = 0;           // serverNow - localNow
let countdownEndsAt = 0;
let joinError = '';
let waking = false;
let sheetOpen = false;
let qrShown = false;
let avatarOpen = false;
let editingName = false;
let leaveArmed = 0;            // timestamp until which a second tap on the title leaves
let wheel = null;
let lastSpinId = null;
let spinOrder = null;          // segment order the server sent for the live spin
let spinResumeKey = null;      // startAt of the spin we've already started animating

const prefill = location.pathname.match(/^\/join\/([A-Za-z0-9]+)/);
let joinCode = prefill ? prefill[1].toUpperCase() : '';
// Arrived on a /join/<code> link (usually a QR scan): skip the landing screen,
// and if this phone already has a name saved, drop straight into the lobby.
if (prefill && !(me && me.token)) view = 'join';
let autoJoined = false;

// --- language ----------------------------------------------------------
// Purely a per-device choice: stored in localStorage, never sent to the server,
// never shared with the room. A Danish room with one English speaker just works
// — everyone reads their own language, same game. Defaults to Danish.
function lang() {
  return LS.lang === 'en' ? 'en' : 'da';
}
function t(id, ...args) {
  const v = (STRINGS[lang()] || STRINGS.da)[id];
  return typeof v === 'function' ? v(...args) : (v ?? id);
}

// --- clock sync (spec: estimate offset so phones land the wheel together) --
function syncClock(rounds = 5) {
  let best = Infinity;
  let sample = 0;
  let n = 0;
  const ping = () => {
    const t0 = Date.now();
    socket.emit('time:ping', t0, (res) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (rtt < best) {
        best = rtt;
        sample = res.server + rtt / 2 - t1; // serverNow - localNow at t1
      }
      if (++n < rounds) setTimeout(ping, 120);
      else { clockOffset = sample; }
    });
  };
  ping();
}

function serverNow() { return Date.now() + clockOffset; }

// --- socket wiring ---------------------------------------------------
socket.on('connect', () => {
  syncClock();
  if (me && me.token) {
    waking = false;
    socket.emit('room:rejoin', { code: me.code, token: me.token }, (res) => {
      if (res && res.ok) { me = res; LS.creds = res; }
      else { me = null; LS.creds = null; render(); }
    });
  } else if (prefill && !autoJoined && LS.name.trim()) {
    // QR scan + a remembered name → join without a single tap.
    autoJoined = true;
    doJoin();
  }
});

socket.io.on('reconnect_attempt', () => { waking = true; render(); });

socket.on('room:state', (s) => {
  room = s;
  waking = false;
  if (me) me.playerId = (room.players.find((p) => p.isMe) || {}).id || me.playerId;
  render();
  maybeResumeSpin();
});

socket.on('countdown:start', ({ endsAt }) => { countdownEndsAt = endsAt; render(); });
socket.on('countdown:cancel', () => { countdownEndsAt = 0; render(); });
// Same lobby, fresh game — wipe any leftover draft from the last round.
socket.on('game:restarted', () => { draftStarter = ''; draftText = ''; draftDare = ''; countdownEndsAt = 0; });
socket.on('pool:empty', () => { /* room:state carries the reopened timer */ });

socket.on('round:spin', (p) => {
  lastSpinId = p.selectedPlayerId;
  spinOrder = p.order;
  spinResumeKey = p.startAt;
  ensureWheel();
  if (wheel) {
    wheel.setSegments(orderedSegments(p.order));
    wheel.startSpin({
      restAngleDeg: p.restAngleDeg,
      spinsDeg: p.spinsDeg,
      durationMs: p.spinDurationMs,
      startAtLocal: p.startAt - clockOffset,
      selectedId: p.selectedPlayerId,
    });
  }
});
socket.on('round:landed', ({ selectedPlayerId }) => {
  spinOrder = null;
  if (wheel) wheel.settle(selectedPlayerId);
});

// A phone that joined or reconnected mid-spin gets room:state with an activeSpin
// but no round:spin event — start the animation from there. Wheel.startSpin
// works out the shortest forward path from the current angle, so a late start
// still lands on the same person.
function maybeResumeSpin() {
  const s = room && room.activeSpin;
  if (!s || spinResumeKey === s.startAt) return;
  const endsIn = (s.startAt - clockOffset) + s.spinDurationMs - Date.now();
  if (endsIn <= 60) return; // basically over — round:landed will place it
  spinResumeKey = s.startAt;
  spinOrder = s.order;
  lastSpinId = s.selectedPlayerId;
  ensureWheel();
  if (wheel) {
    wheel.setSegments(orderedSegments(s.order));
    wheel.startSpin({
      restAngleDeg: s.restAngleDeg,
      spinsDeg: s.spinsDeg,
      durationMs: s.spinDurationMs,
      startAtLocal: s.startAt - clockOffset,
      selectedId: s.selectedPlayerId,
    });
  }
}
socket.on('round:force-continue', () => { /* room:state carries forceContinue */ });

// --- helpers -------------------------------------------------------
function orderedSegments(order) {
  const byId = Object.fromEntries(room.players.map((p) => [p.id, p]));
  return (order || room.players.filter((p) => p.connected).map((p) => p.id))
    .map((id) => byId[id]).filter(Boolean)
    .map((p) => ({ id: p.id, name: p.name, color: p.color }));
}

// One canvas element that lives for the whole session. render() re-parents it
// into whichever screen needs it rather than recreating it, so an in-flight
// spin animation (its rAF loop, its accumulated angle) survives a re-render.
const sharedCanvas = document.createElement('canvas');
sharedCanvas.id = 'wheel-canvas';

function wheelHost(maxWidth) {
  const host = el('div', { class: 'wheel-wrap' }, sharedCanvas);
  if (maxWidth) host.style.maxWidth = maxWidth + 'px';
  return host;
}

function ensureWheel() {
  if (!document.body.contains(sharedCanvas)) return;
  if (!wheel) { wheel = new Wheel(sharedCanvas); }
  wheel._resize();
  // While a spin animation is running, keep the segments in the exact order the
  // server sent — a player dropping mid-spin must not re-cut the wheel under the
  // pointer, or it ends up pointing at someone other than the winner.
  wheel.setSegments(orderedSegments(wheel && wheel.spin ? spinOrder : null));
  // On the result screen, keep the landed player highlighted (unless a spin
  // animation is still finishing).
  if (!wheel.spin && room && room.phase === 'result' && room.currentRound) {
    wheel.settle(room.currentRound.selectedPlayerId);
  }
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

// A player's name, shown verbatim — never re-cased by CSS.
function raw(text) {
  return el('span', { class: 'raw' }, text);
}

// Names get an automatic capital first letter.
function capFirst(v) {
  v = (v || '');
  return v && v[0] !== v[0].toUpperCase() ? v[0].toUpperCase() + v.slice(1) : v;
}

// The one name input, used on the landing widget and the create/join screens.
// It force-capitalises the first letter as you type (cursor preserved) and
// writes straight to LS.name — the single source of truth.
function nameField(onEnter) {
  return el('input', {
    type: 'text', maxlength: 24, value: LS.name, placeholder: t('yourName'),
    autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false',
    oninput: (e) => {
      const pos = e.target.selectionStart;
      const v = capFirst(e.target.value);
      if (v !== e.target.value) { e.target.value = v; e.target.setSelectionRange(pos, pos); }
      LS.name = v;
    },
    onkeydown: onEnter ? (e) => { if (e.key === 'Enter') onEnter(); } : null,
  });
}

function toast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const tn = el('div', { class: 'toast' }, msg);
  document.body.append(tn);
  setTimeout(() => tn.remove(), 1800);
}

function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : String(s);
}

// --- render -------------------------------------------------------
let ticker = null;
function render() {
  document.documentElement.lang = lang();
  $app.innerHTML = '';
  if (waking && !room) return $app.append(screenWaking());

  let node;
  if (!room) {
    node = view === 'create' ? screenCreate() : view === 'join' ? screenJoin() : screenLanding();
  } else {
    node = ({
      lobby: screenLobby,
      writing: screenWriting,
      wheel: screenWheel,
      result: screenResult,
      refill: screenWriting, // refill reuses the writing UI
      over: screenOver,
    }[room.phase] || screenLanding)();
  }
  $app.append(node);
  if (sheetOpen) $app.append(sheetLanguage());
  if (qrShown && room) $app.append(qrOverlay());
  if (avatarOpen && room) $app.append(avatarSheet());
  ensureWheel();

  // one interval drives every countdown on screen
  clearInterval(ticker);
  if (needsTicker()) ticker = setInterval(tick, 250);
}

function needsTicker() {
  if (countdownEndsAt) return true;
  if (room && room.timer) return true;
  if (room && room.phase === 'wheel' && room.cooldownUntil > serverNow()) return true;
  return false;
}

function tick() {
  // countdown banner
  const cb = document.getElementById('cd-num');
  if (cb && countdownEndsAt) {
    const left = Math.ceil((countdownEndsAt - serverNow()) / 1000);
    cb.textContent = Math.max(0, left);
    if (left <= 0) { countdownEndsAt = 0; }
  }
  // phase timer
  const tn = document.getElementById('timer-num');
  if (tn && room && room.timer) {
    const left = room.timer.startAt + room.timer.duration - serverNow();
    tn.textContent = fmtTime(left);
    const wrap = document.getElementById('timer-wrap');
    if (wrap) wrap.classList.toggle('low', left < 15000);
    const bar = document.getElementById('timer-bar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, (left / room.timer.duration) * 100)) + '%';
  }
  // spin cooldown — count the seconds down on the button, then unlock
  const sb = document.getElementById('spin-btn');
  if (sb && room && room.phase === 'wheel') {
    const cool = room.cooldownUntil - serverNow();
    if (cool > 0) { sb.disabled = true; sb.textContent = String(Math.ceil(cool / 1000)); }
    else if (!room.spinLock) { sb.disabled = false; sb.classList.remove('spinning'); sb.textContent = t('spin'); }
  }
}

// --- screens: pre-room --------------------------------------------
function brand(withTag = true) {
  return el('div', { class: 'brand' },
    el('div', { class: 'wordmark' }, 'FLASKEHALS'),
    withTag && el('div', { class: 'tag' }, t('tagline')),
  );
}

function loader() {
  const slot = el('div', { class: 'loader-slot' });
  slot.innerHTML = loaderMarkup();
  return slot;
}

function screenWaking() {
  return el('div', { class: 'screen' },
    el('div', { class: 'spacer' }),
    brand(),
    loader(),
    el('div', { class: 'waking' }, t('waking')),
    el('div', { class: 'spacer' }),
  );
}

function langToggle() {
  const set = (v) => { LS.lang = v; render(); };
  return el('div', { class: 'lang-toggle' },
    el('button', { class: lang() === 'da' ? 'on' : '', onclick: () => set('da') }, 'DA'),
    el('button', { class: lang() === 'en' ? 'on' : '', onclick: () => set('en') }, 'EN'),
  );
}

// Remembered name, shown on the landing screen with an inline edit. This is the
// single source of truth for the player's name — create/join read from it too.
function nameWidget() {
  const nm = LS.name;
  if (editingName || !nm) {
    return el('div', { class: 'name-edit' },
      nameField(() => { editingName = false; render(); }),
      el('button', { class: 'btn-primary', onclick: () => { editingName = false; render(); } }, t('ok')),
    );
  }
  return el('button', { class: 'name-show', onclick: () => { editingName = true; render(); } },
    el('span', {}, t('playingAs')),
    el('b', {}, nm),
    el('span', { class: 'pen' }, '✎'),
  );
}

function screenLanding() {
  // The spec keeps non-triggered motion to the lobby only, so no wobbling
  // bottle here — just the pitch and the two doors.
  return el('div', { class: 'screen' },
    el('div', { style: 'display:flex;justify-content:flex-end' }, langToggle()),
    el('div', { class: 'spacer' }),
    brand(),
    el('ol', { class: 'how' },
      el('li', {}, t('how1')),
      el('li', {}, t('how2')),
      el('li', {}, t('how3')),
    ),
    el('div', { class: 'spacer' }),
    nameWidget(),
    el('div', { class: 'stack' },
      el('button', { class: 'btn-primary btn-big', onclick: () => { view = 'create'; render(); } }, t('create')),
      el('button', { class: 'btn-ghost btn-big', onclick: () => { view = 'join'; render(); } }, t('join')),
    ),
  );
}

let createDraft = { showAuthors: false, punishment: 'drink', writingSeconds: 90 };
function screenCreate() {
  const d = createDraft;
  const segRow = (label, opts, key, fmt) => el('div', {},
    el('label', {}, label),
    el('div', { class: 'seg' }, opts.map((o) => el('button', {
      class: d[key] === o ? 'on' : '',
      onclick: () => { d[key] = o; render(); },
    }, fmt(o)))),
  );
  return el('div', { class: 'screen' },
    brand(),
    el('div', { class: 'card stack' },
      el('div', {},
        el('label', {}, t('yourName')),
        nameField(),
      ),
      el('h3', {}, t('settingsTitle')),
      segRow(t('showAuthors'), [false, true], 'showAuthors', (o) => o ? t('showName') : t('anonymous')),
      segRow(t('punishment'), ['off', 'drink', 'dare', 'both'], 'punishment',
        (o) => ({ off: t('punOff'), drink: t('punDrink'), dare: t('punDare'), both: t('punBoth') }[o])),
      segRow(t('writingTime'), [90, 120], 'writingSeconds', (o) => o === 90 ? t('sec90') : t('min2')),
    ),
    joinError && el('div', { class: 'error' }, joinError),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn-ghost', onclick: () => { view = 'landing'; joinError = ''; render(); } }, t('back')),
      el('button', { class: 'btn-primary', onclick: doCreate }, t('createAndGo')),
    ),
  );
}

function doCreate() {
  const d = createDraft;
  if (!LS.name.trim()) { joinError = t('errNoName'); return render(); }
  joinError = '';
  socket.emit('room:create', {
    name: LS.name.trim(),
    settings: { showAuthors: d.showAuthors, punishment: d.punishment, writingSeconds: d.writingSeconds },
  }, (res) => {
    if (res && res.ok) { me = res; LS.creds = res; }
    else { joinError = res && res.error === 'busy' ? t('errBusy') : t('errNoName'); render(); }
  });
}

function screenJoin() {
  return el('div', { class: 'screen' },
    brand(),
    el('div', { class: 'card stack' },
      el('div', {},
        el('label', {}, t('roomCode')),
        el('input', { type: 'text', maxlength: 6, value: joinCode, placeholder: 'ABCDEF',
          readonly: !!prefill,
          style: 'text-transform:uppercase;letter-spacing:6px;font-family:"IBM Plex Mono",monospace',
          oninput: (e) => { joinCode = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); e.target.value = joinCode; } }),
      ),
      el('div', {},
        el('label', {}, t('yourName')),
        nameField(doJoin),
      ),
    ),
    joinError && el('div', { class: 'error' }, joinError),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn-ghost', onclick: () => { view = 'landing'; joinError = ''; render(); } }, t('back')),
      el('button', { class: 'btn-primary', onclick: doJoin }, t('join')),
    ),
  );
}

function doJoin() {
  if (!joinCode.trim()) { joinError = t('errNoRoom'); return render(); }
  if (!LS.name.trim()) { joinError = t('errNoName'); return render(); }
  joinError = '';
  socket.emit('room:join', { code: joinCode, name: LS.name.trim() }, (res) => {
    if (res && res.ok) { me = res; LS.creds = res; return; }
    joinError = {
      'no-room': t('errNoRoom'), 'no-name': t('errNoName'),
      'name-taken': t('errNameTaken'), 'full': t('errFull'),
    }[res && res.error] || t('errNoRoom');
    render();
  });
}

// --- gear / language sheet --------------------------------------
function gear() {
  return el('button', { class: 'gear', 'aria-label': t('myLanguage'),
    onclick: () => { sheetOpen = true; render(); } }, '⚙︎');
}

// Leave the room. One tap on the title arms it (turns red, "FORLAD?"), a second
// tap within 3s actually leaves — cheap guard against a rage-quitting mis-tap.
function tapTitle() {
  if (Date.now() < leaveArmed) { leaveRoom(); return; }
  leaveArmed = Date.now() + 3000;
  render();
  setTimeout(() => { if (Date.now() >= leaveArmed) { leaveArmed = 0; render(); } }, 3100);
}

function leaveRoom() {
  socket.emit('room:leave');
  LS.creds = null;
  me = null; room = null; leaveArmed = 0;
  countdownEndsAt = 0; sheetOpen = false; qrShown = false; avatarOpen = false;
  spinOrder = null; spinResumeKey = null;
  // Drop the /join/<code> path so a reload doesn't silently auto-join us back in.
  autoJoined = true;
  if (location.pathname !== '/') history.replaceState(null, '', '/');
  view = 'landing';
  render();
}

// In-room screen header: the wordmark title doubles as the leave button (tap to
// arm, tap again to leave); gear on the right.
function head(title) {
  const armed = Date.now() < leaveArmed;
  return el('div', { class: 'head' },
    el('button', { class: 'wordmark title-btn' + (armed ? ' armed' : ''), onclick: tapTitle },
      armed ? t('leaveArm') : (title || 'Flaskehals')),
    gear(),
  );
}
function sheetLanguage() {
  const pick = (v) => { LS.lang = v; sheetOpen = false; render(); };
  return el('div', { class: 'sheet-back', onclick: (e) => { if (e.target.classList.contains('sheet-back')) { sheetOpen = false; render(); } } },
    el('div', { class: 'sheet stack' },
      el('h3', {}, t('myLanguage')),
      el('div', { class: 'seg' },
        el('button', { class: lang() === 'da' ? 'on' : '', onclick: () => pick('da') }, 'Dansk'),
        el('button', { class: lang() === 'en' ? 'on' : '', onclick: () => pick('en') }, 'English'),
      ),
      el('div', { class: 'tag', style: 'color:var(--muted);font-size:12px' }, t('langNote')),
      el('button', { class: 'btn-ghost', onclick: () => { sheetOpen = false; render(); } }, t('close')),
    ),
  );
}

// Full-screen QR to hold up so someone can scan straight into the lobby.
// The QR is rendered server-side from just the room code (/qr/:code.svg), so
// the link format lives in one place on the server and can move later.
function qrOverlay() {
  const close = () => { qrShown = false; render(); };
  const img = el('img', { class: 'qr-img', alt: 'QR', src: `/qr/${room.code}.svg?t=${Date.now()}` });
  img.addEventListener('error', () => {
    const box = img.parentElement;
    if (box) { img.remove(); box.prepend(el('div', { class: 'qr-fail' }, t('qrFail'))); }
  });
  return el('div', { class: 'sheet-back', onclick: (e) => { if (e.target.classList.contains('sheet-back')) close(); } },
    el('div', { class: 'sheet stack', style: 'align-items:center;text-align:center' },
      el('h3', {}, t('scanToJoin')),
      el('div', { class: 'qr-box' }, img),
      el('div', { class: 'code', style: 'font-family:var(--mono);font-size:28px;letter-spacing:8px' }, room.code),
      el('button', { class: 'btn-ghost', style: 'align-self:stretch', onclick: close }, t('close')),
    ),
  );
}

function avatarNode(id, cls = 'av') {
  const n = el('div', { class: cls });
  n.innerHTML = avatarImg(id);
  return n;
}

// --- screens: in-room --------------------------------------------
function playersGrid(interactive = false) {
  return el('div', { class: 'players' }, room.players.map((p) => el('div', {
    class: 'player-card' + (p.connected ? '' : ' off') + (p.isMe ? ' me' : ''),
    onclick: interactive && p.isMe ? () => { avatarOpen = true; render(); } : null,
  },
    avatarNode(p.avatar || AVATAR_IDS[0]),
    el('div', { class: 'nm' }, p.name),
    interactive && p.isMe && el('div', { class: 'edit' }, '✎'),
  )));
}

function avatarSheet() {
  const me2 = room.players.find((p) => p.isMe);
  const mine = me2 ? me2.avatar : null;
  const free = new Set(room.freeAvatars || AVATAR_IDS);
  const close = () => { avatarOpen = false; render(); };
  return el('div', { class: 'sheet-back', onclick: (e) => { if (e.target.classList.contains('sheet-back')) close(); } },
    el('div', { class: 'sheet stack' },
      el('h3', {}, t('pickAvatar')),
      el('div', { class: 'av-grid' }, AVATAR_IDS.map((id) => {
        const b = el('button', {
          class: id === mine ? 'on' : '',
          disabled: id !== mine && !free.has(id),
          onclick: () => { socket.emit('player:avatar', { avatar: id }); avatarOpen = false; render(); },
        });
        b.innerHTML = avatarImg(id);
        return b;
      })),
      el('button', { class: 'btn-ghost', onclick: close }, t('close')),
    ),
  );
}

function screenLobby() {
  const n = room.players.filter((p) => p.connected).length;
  const counting = countdownEndsAt > serverNow();
  const shareUrl = `${location.origin}/join/${room.code}`;
  return el('div', { class: 'screen' },
    head(t('lobbyTitle')),
    el('div', { class: 'card code-box', id: 'code-box', onclick: () => {
      navigator.clipboard?.writeText(room.code).then(() => {
        document.getElementById('code-box')?.classList.add('copied');
        toast(t('copied'));
      });
    } },
      el('div', { class: 'code' }, room.code),
      el('div', { class: 'hint' }, t('tapToCopy')),
    ),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn-ghost', onclick: () => {
        if (navigator.share) navigator.share({ url: shareUrl, title: 'Flaskehals' });
        else navigator.clipboard?.writeText(shareUrl).then(() => toast(t('copied')));
      } }, t('shareLink')),
      el('button', { class: 'btn-ghost', onclick: () => { qrShown = true; render(); } }, t('showQr')),
    ),
    playersGrid(true),
    el('div', { class: 'count-line' }, n < 2 ? t('waitingOne') : t('playersHere', n)),
    el('div', { class: 'count-line', style: 'font-size:11px' }, t('tapCardHint')),
    counting
      ? el('div', { class: 'countdown-banner' },
          t('startingIn') + ' ',
          el('span', { id: 'cd-num' }, Math.max(0, Math.ceil((countdownEndsAt - serverNow()) / 1000))),
          '…')
      : loader(),
    el('div', { class: 'spacer' }),
    counting
      ? el('button', { class: 'btn-ghost', onclick: () => socket.emit('writing:cancel') }, t('cancel'))
      : el('button', { class: 'btn-go btn-big', disabled: n < 2, onclick: () => socket.emit('writing:start') }, t('startWriting')),
    n >= 2 && !counting && el('div', { class: 'count-line' }, t('anyoneCanStart')),
  );
}

function timerBlock() {
  if (!room.timer) return null;
  const left = room.timer.startAt + room.timer.duration - serverNow();
  return el('div', { class: 'timer', id: 'timer-wrap' },
    el('div', { class: 'n', id: 'timer-num' }, fmtTime(left)),
    el('div', { class: 'bar' }, el('i', { id: 'timer-bar', style: `width:${Math.max(0, Math.min(100, left / room.timer.duration * 100))}%` })),
  );
}

let draftStarter = '';  // a locked opener chosen from a chip — not editable
let draftText = '';
let draftDare = '';
// A writing-screen nudge, not a rule: this phone shows one random prompt,
// re-rolled each time the writing phase opens, and it can be dismissed.
let themeHintIdx = Math.floor(Math.random() * THEMES.da.length);
let themeHintPhase = null;   // which phase the current pick belongs to
let themeHintOff = false;

function screenWriting() {
  const wantsDare = ['dare', 'both'].includes(room.settings.punishment);
  const mine = (room.myQuestions || []).length;
  const chips = CHIPS[lang()] || CHIPS.da;
  const atLimit = mine >= 5;
  const hasDraft = () => !!(draftStarter || draftText.trim());
  const clearDraft = () => { draftStarter = ''; draftText = ''; render(); };

  if (themeHintPhase !== room.phase) {
    themeHintPhase = room.phase;
    themeHintIdx = Math.floor(Math.random() * THEMES.da.length);
    themeHintOff = false;
  }
  const themeList = THEMES[lang()] || THEMES.da;

  // Keep the "Add" button and the ✕ in sync as the field is typed into, without
  // a full re-render (that would drop the caret / blur the textarea mid-word).
  const syncDraftControls = () => {
    const btn = document.getElementById('add-q-btn');
    if (btn) btn.disabled = atLimit || !hasDraft();
    const x = document.getElementById('q-clear-btn');
    if (x) x.hidden = !hasDraft();
  };

  return el('div', { class: 'screen' },
    head(t('writingTitle')),
    !themeHintOff && el('div', { class: 'theme-pill' },
      t('themeHint', themeList[themeHintIdx]),
      el('button', { class: 'x', 'aria-label': t('clear'),
        onclick: () => { themeHintOff = true; render(); } }, '✕'),
    ),
    timerBlock(),
    room.phase === 'refill' && el('div', { class: 'count-line' }, t('refillSub')),

    // All six openers, always the same six (no shuffling on tap — that jump was
    // annoying). Tap to lock one as the start of your question; tap again to drop it.
    el('div', { class: 'chips' }, chips.map((c) => {
      const val = c.text.trim();
      return el('button', {
        class: 'chip' + (draftStarter === val ? ' on' : ''),
        disabled: atLimit,
        onclick: () => {
          draftStarter = draftStarter === val ? '' : val;
          render();
        },
      }, c.label);
    })),

    el('div', { class: 'card stack' },
      draftStarter && el('div', { class: 'starter-lock' },
        el('span', {}, draftStarter),
        el('button', { class: 'x', 'aria-label': t('clear'),
          onclick: () => { draftStarter = ''; render(); } }, '✕'),
      ),
      el('div', { class: 'q-row' },
        el('textarea', { id: 'q-input', maxlength: 240,
          placeholder: draftStarter ? t('continuePlaceholder') : t('questionPlaceholder'),
          disabled: atLimit, oninput: (e) => { draftText = e.target.value; syncDraftControls(); } }, draftText),
        el('button', { id: 'q-clear-btn', class: 'q-clear', 'aria-label': t('clear'),
          hidden: !hasDraft(), onclick: clearDraft }, '✕'),
      ),
      wantsDare && el('input', { type: 'text', id: 'd-input', maxlength: 160, placeholder: t('darePlaceholder'),
        value: draftDare, disabled: atLimit, oninput: (e) => { draftDare = e.target.value; } }),
      el('button', { id: 'add-q-btn', class: 'btn-primary', disabled: atLimit || !hasDraft(), onclick: addQuestion }, t('addQuestion')),
      atLimit && el('div', { class: 'error' }, t('limitReached')),
    ),

    (room.myQuestions || []).length > 0 && el('div', { class: 'mine-list' },
      room.myQuestions.map((q) => el('div', { class: 'mine-item' },
        el('span', {}, q.text),
        el('button', { class: 'x', onclick: () => socket.emit('question:remove', { id: q.id }) }, '✕'),
      )),
    ),

    el('div', { class: 'counters' },
      el('span', {}, t('ofWritten', mine, 5)),
      el('span', {}, t('poolCount', room.pool.total)),
    ),
    el('div', { class: 'count-line', style: 'font-size:12px' }, t('blindNote')),
    room.phase === 'refill' && el('button', { class: 'btn-ghost', onclick: () => socket.emit('refill:end-game') }, t('endGame')),
  );
}

function addQuestion() {
  const body = draftText.trim();
  const text = ((draftStarter ? draftStarter + ' ' : '') + body).trim();
  if (!text) return;
  socket.emit('question:add', { text, dare: draftDare.trim() }, (res) => {
    if (res && res.ok) { draftStarter = ''; draftText = ''; draftDare = ''; render(); }
    else if (res && res.error === 'limit') toast(t('limitReached'));
  });
}

function screenWheel() {
  const cool = room.cooldownUntil - serverNow();
  const locked = room.spinLock || cool > 0;
  return el('div', { class: 'screen' },
    head(t('wheelTitle')),
    wheelHost(),
    el('div', { class: 'spacer' }),
    el('button', {
      id: 'spin-btn', class: 'spin-btn' + (locked && cool <= 0 ? ' spinning' : ''), disabled: locked,
      onclick: () => socket.emit('wheel:spin'),
    }, cool > 0 ? String(Math.ceil(cool / 1000)) : locked ? '…' : t('spin')),
    el('div', { class: 'count-line', style: 'margin-top:16px' }, t('waitingForSpin')),
  );
}

function screenResult() {
  const r = room.currentRound || {};
  const picked = room.players.find((p) => p.id === r.selectedPlayerId) || {};
  const iAmPicked = r.isMe;
  const canContinue = iAmPicked || room.forceContinue;
  const wantsDare = ['dare', 'both'].includes(room.settings.punishment);
  const skippedDare = r.skipped && r.punishmentShown && r.punishmentShown.type === 'dare';

  let punishNode = null;
  if (r.skipped) {
    const ps = r.punishmentShown;
    let msg;
    if (!ps) msg = t('skipOff');
    else if (ps.type === 'drink') msg = t('skipDrink');
    else if (ps.type === 'dare') msg = ps.text ? `${t('skipDare')} ${ps.text}` : t('skipDareNone');
    punishNode = el('div', { class: 'punish' }, msg);
  }

  return el('div', { class: 'screen' },
    head(null),
    wheelHost(220),
    el('div', { class: 'result-name' + (iAmPicked ? ' you' : '') },
      iAmPicked ? t('youreUp') : [raw(picked.name || ''), ' ', t('isUpSuffix')]),
    el('div', { class: 'card q-card' },
      r.questionText || '…',
      r.authorName
        ? el('div', { class: 'q-author' }, t('fromPre') + ' ', raw(r.authorName))
        : (room.settings.showAuthors ? null : el('div', { class: 'q-author' }, t('anonQuestion'))),
    ),
    // In dare mode the dare is the alternative to answering — show it up front so
    // it's a real either/or, not a surprise after skipping.
    !r.skipped && wantsDare && r.dare && el('div', { class: 'dare-or' },
      el('span', { class: 'lbl' }, t('orDare')), ' ', r.dare),
    punishNode,
    r.skipped
      ? (skippedDare ? null : el('div', { class: 'count-line' }, t('skipAdvancing')))
      : (!iAmPicked && (picked.connected === false
          ? el('div', { class: 'count-line' }, t('pickedGone'))
          : (room.forceContinue
              ? el('div', { class: 'count-line' }, t('theyDropped'))
              : el('div', { class: 'count-line' }, [t('waitingForPre') + ' ', raw(picked.name || ''), '…'])))),
    el('div', { class: 'spacer' }),
    // Buttons stay while choosing; after a skip they stay only for a dare (a
    // drink auto-advances). A dare needs an explicit "done" tap.
    (!r.skipped || skippedDare) && (iAmPicked || room.forceContinue)
      ? el('div', { class: 'btn-row' },
          !r.skipped && el('button', { class: 'btn-danger', disabled: !iAmPicked,
            onclick: () => socket.emit('round:skip') }, t('skip')),
          el('button', { class: 'btn-primary', disabled: !canContinue,
            onclick: () => socket.emit('round:continue') },
            skippedDare ? t('dareDone')
              : (room.forceContinue && !iAmPicked ? t('forceContinue') : t('continue'))),
        )
      : null,
  );
}

function screenOver() {
  const d = room.recapData || { rounds: 0 };
  return el('div', { class: 'screen' },
    el('div', { class: 'brand' }, el('div', { class: 'wordmark' }, t('endMark')), el('div', { class: 'tag' }, t('overTitle'))),
    el('div', { class: 'card' },
      el('div', { class: 'recap-row' }, el('span', {}, t('recapRounds', d.rounds)), el('span', {}, '🍾')),
      el('div', { class: 'recap-row' },
        el('span', {}, t('recapMostPicked')),
        d.mostPicked ? el('span', {}, raw(d.mostPicked.name), ` (${d.mostPicked.count})`) : el('span', {}, t('nobody'))),
      el('div', { class: 'recap-row' },
        el('span', {}, t('recapMostSkipped')),
        d.mostSkipped ? el('span', {}, raw(d.mostSkipped.name), ` (${d.mostSkipped.count})`) : el('span', {}, t('nobody'))),
    ),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn-primary btn-big', onclick: () => socket.emit('game:restart') }, t('playAgain')),
    el('button', { class: 'btn-ghost', onclick: () => { LS.creds = null; location.href = '/'; } }, t('leaveGame')),
  );
}

// --- boot -------------------------------------------------------
if (me && me.token) waking = true; // show waking until rejoin resolves or socket connects
render();
