// The wheel. The server decides who it lands on and the exact final angle; this
// only animates toward that angle, starting at a shared timestamp. Same inputs
// on every phone → same motion → it lands together. That shared moment is the
// whole point of the game (spec), so nothing here is random or clock-dependent
// beyond the corrected start time handed in by app.js.

const TAU = Math.PI * 2;

export class Wheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.angle = 0;          // current rotation, radians, clockwise
    this.segments = [];      // [{ id, name, color, emoji }]
    this.spin = null;        // active spin descriptor
    this.onLand = null;
    this._raf = null;
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this.draw(); });
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = this.canvas.clientWidth || 300;
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
  }

  setSegments(players) {
    this.segments = players;
    if (!this.spin) this.draw();
  }

  // startAtLocal is already corrected into this device's clock by app.js.
  // restAngleDeg is where the wheel comes to rest (mod 360); spinsDeg is the
  // whole-turn spin on top. We take the shortest forward path from `from` so a
  // second spin never jumps backwards.
  startSpin({ restAngleDeg, spinsDeg, durationMs, startAtLocal, selectedId }) {
    const from = this.angle;
    const fromMod = ((from % TAU) + TAU) % TAU;
    const restRad = (restAngleDeg * Math.PI) / 180;
    let forward = (restRad - fromMod) % TAU;
    if (forward < 0) forward += TAU;
    const to = from + (spinsDeg * Math.PI) / 180 + forward;
    this.spin = { from, to, durationMs, startAtLocal, selectedId };
    cancelAnimationFrame(this._raf);
    const tick = () => {
      const now = Date.now();
      const t = (now - startAtLocal) / durationMs;
      if (t <= 0) {
        this._raf = requestAnimationFrame(tick);
        return;
      }
      if (t >= 1) {
        this.angle = to;
        this.spin = null;
        this.draw(selectedId, true);
        if (this.onLand) this.onLand(selectedId);
        return;
      }
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      this.angle = from + (to - from) * eased;
      // don't telegraph the winner mid-spin — only dim the losers in the last beat
      this.draw(t > 0.88 ? selectedId : null, t > 0.94);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // Called if the server's authoritative land beats our animation (backgrounded
  // tab, dropped frames): snap to the end.
  settle(selectedId) {
    if (this.spin) {
      this.angle = this.spin.to;
      this.spin = null;
    }
    cancelAnimationFrame(this._raf);
    this.draw(selectedId, true);
  }

  draw(highlightId, glow) {
    const ctx = this.ctx;
    const s = this.size;
    const c = s / 2;
    const r = c - 12;
    const INK = '#14110C';
    const PAPER = '#F1EBDA';
    ctx.clearRect(0, 0, s, s);
    const n = this.segments.length;
    if (n === 0) return;
    const seg = TAU / n;
    const off = Math.max(3, s * 0.02); // shadow offset, scales with size

    // hard offset shadow disc behind the wheel — the brutalist drop shadow
    ctx.beginPath();
    ctx.arc(c + off, c + off * 1.2, r + 2, 0, TAU);
    ctx.fillStyle = INK;
    ctx.fill();

    for (let i = 0; i < n; i++) {
      const p = this.segments[i];
      // segment i spans [i*seg, (i+1)*seg] measured clockwise from the top
      const start = -Math.PI / 2 + i * seg + this.angle;
      const end = start + seg;
      const dimmed = highlightId && p.id !== highlightId;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, start, end);
      ctx.closePath();
      ctx.fillStyle = dimmed ? mix(p.color, PAPER, 0.78) : p.color;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.stroke();

      // label — full name when there's room, then first name, then initials,
      // then a single letter once the segments get thin (up to 20 players).
      const mid = start + seg / 2;
      ctx.save();
      ctx.translate(c + Math.cos(mid) * r * 0.62, c + Math.sin(mid) * r * 0.62);
      ctx.rotate(mid + Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const size = n > 14 ? 12 : Math.max(11, Math.min(18, 150 / n));
      ctx.font = `700 ${size}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillStyle = INK;
      ctx.globalAlpha = dimmed ? 0.4 : 1;
      const first = p.name.split(/\s+/)[0];
      let label = p.name;
      if (n > 14) label = first.slice(0, 2);
      else if (n > 10) label = first.slice(0, 4);
      else if (n > 7) label = first;
      ctx.fillText(label, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // outer ring
    ctx.beginPath();
    ctx.arc(c, c, r, 0, TAU);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4;
    ctx.stroke();

    // hub
    ctx.beginPath();
    ctx.arc(c, c, r * 0.15, 0, TAU);
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.stroke();

    // winner ring — red so it reads as "landed here"
    if (glow && highlightId) {
      ctx.beginPath();
      ctx.arc(c, c, r - 5, 0, TAU);
      ctx.strokeStyle = '#FF5C39';
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c, c, r - 5, 0, TAU);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // chunky pointer at 12 o'clock, with its own hard shadow
    const pw = Math.max(12, s * 0.045);
    const ph = Math.max(22, s * 0.085);
    const drawPointer = (dx, dy, fill) => {
      ctx.beginPath();
      ctx.moveTo(c - pw + dx, dy);
      ctx.lineTo(c + pw + dx, dy);
      ctx.lineTo(c + dx, ph + dy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (fill !== INK) { ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.stroke(); }
    };
    drawPointer(off * 0.7, off * 0.7, INK);
    drawPointer(0, 0, '#FF5C39');
  }
}

// Blend hex a toward hex b by t (0..1).
function mix(a, b, t) {
  const pa = hex(a), pb = hex(b);
  const ch = (i) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}
function hex(h) {
  const m = String(h).replace('#', '');
  const v = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
