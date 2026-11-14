'use strict';
// 摸鱼酒馆 server: serves index.html and a WebSocket room service on one port.
// No free text ever crosses the wire: every client field is an index into a fixed list.
// Start: node server.js   (PORT=8787 HOST=127.0.0.1 by default)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // read X-Forwarded-For only behind your own proxy
const ROOM_MAX = 100;
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP || '6', 10);
const MAX_CLIENTS = parseInt(process.env.MAX_CLIENTS || '5000', 10);
const MAX_PAYLOAD = 256;          // bytes per message
const RATE_BURST = 12;            // token bucket size
const RATE_REFILL = 6;            // tokens per second
const HELLO_TIMEOUT = 10000;
const HEARTBEAT_MS = 20000;
const ROUND_GUEST_CD = 600;       // seconds, per guest (not per IP: whole offices share one NAT address)
const ROUND_ROOM_CD = 60;         // seconds, per room
const GESTURES = 4;               // 0 举杯 1 干杯 2 叹气 3 趴桌
const COLORS = 8;
const DRINKS = 10;
const SIPS = 5;
const SEATS = 100;                // seat indices 0..99: 0-15 bar stools, 16-63 high tables, 64-99 booths (layout lives in the client)
const SEAT_CD = 2000;             // ms between seat moves
const MOODS = 5;                  // jukebox moods / songs
const SONG_ROOM_CD = 90;          // seconds per room between song changes
const DICE_CD = 2000;             // ms between dice rolls per guest
const SING_MS = parseInt(process.env.SING_MS || '40000', 10); // performance length (override only for tests)
const SING_GUEST_CD = 600;        // seconds per guest between performances
const crypto = require('crypto');

const INDEX = path.join(__dirname, 'index.html');
// Read list sizes from the page so the two never drift apart.
let NADJ = 18, NANI = 16;
try {
  const m = fs.readFileSync(INDEX, 'utf8').match(/const LISTS = (\{.*?\});/);
  if (m) { const L = JSON.parse(m[1]); NADJ = L.adj.length; NANI = L.animal.length; }
} catch (e) { console.warn('could not read list sizes from index.html, using defaults'); }

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const dayKey = () => new Date().toDateString();

// ---- HTTP ----
// Explicit allowlist of static files; nothing else on disk is reachable.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/index2d.html': ['index2d.html', 'text/html; charset=utf-8'],
  '/bar3d.js': ['bar3d.js', 'text/javascript; charset=utf-8'],
  '/three.module.js': ['node_modules/three/build/three.module.js', 'text/javascript; charset=utf-8', true],
  '/three.core.js': ['node_modules/three/build/three.core.js', 'text/javascript; charset=utf-8', true],
  '/songs/monday.mp3': ['songs/monday.mp3', 'audio/mpeg', true],
  '/tip.png': ['tip.png', 'image/png'],   // optional, supplied by the owner
};
const zlib = require('zlib');
const gzCache = new Map(); // file -> {mtime, gz}
const HEAD = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}</style></head><body>';
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const f = Object.prototype.hasOwnProperty.call(STATIC, url) ? STATIC[url] : null;
  if ((req.method === 'GET' || req.method === 'HEAD') && f) {
    const file = path.join(__dirname, f[0]);
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      const binary = f[1].startsWith('image/') || f[1].startsWith('audio/');
      const headers = { 'Content-Type': f[1], 'Cache-Control': f[2] ? 'public, max-age=2592000' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
      const gzipOK = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !binary;
      const finish = buf => { headers['Content-Length'] = buf.length; res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : buf); };
      const c = gzCache.get(file);
      if (c && c.mtime === st.mtimeMs) { if (gzipOK) { headers['Content-Encoding'] = 'gzip'; return finish(c.gz); } return finish(c.raw); }
      fs.readFile(file, (err2, buf) => {
        if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
        // the html pages are written as Artifact bodies (no doctype/head); wrap them so browsers render in standards mode
        if (f[0].endsWith('.html')) buf = Buffer.concat([Buffer.from(HEAD), buf, Buffer.from('</body></html>')]);
        const entry = { mtime: st.mtimeMs, raw: buf, gz: binary ? buf : zlib.gzipSync(buf, { level: 9 }) };
        gzCache.set(file, entry);
        if (gzipOK) { headers['Content-Encoding'] = 'gzip'; return finish(entry.gz); }
        finish(buf);
      });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
});

// ---- rooms ----
let nextGuestId = 1, nextRoomId = 1;
const rooms = new Map();      // id -> {id, guests: Map, toasts, rounds, day, lastRound}
const ipCount = new Map();
let online = 0;

function roomDay(r) { const d = dayKey(); if (r.day !== d) { r.day = d; r.toasts = 0; r.rounds = 0; } }
function endSing(r) {
  if (!r.perf) return;
  clearTimeout(r.perf.timer);
  broadcast(r, { t: 'singend', id: r.perf.id, cheers: r.perf.cheers });
  r.perf = null;
}
function perfPub(r) { return r.perf ? { id: r.perf.id, m: r.perf.m, left: Math.max(0, r.perf.end - Date.now()), cheers: r.perf.cheers } : null; }
function pickRoom() {
  let best = null;
  for (const r of rooms.values()) if (r.guests.size < ROOM_MAX && (!best || r.guests.size > best.guests.size)) best = r;
  if (!best) { best = { id: nextRoomId++, guests: new Map(), toasts: 0, rounds: 0, day: dayKey(), lastRound: 0, song: 0, songAt: 0, perf: null }; rooms.set(best.id, best); }
  roomDay(best);
  return best;
}
function freeSeat(r) {
  const used = new Set(); for (const g of r.guests.values()) used.add(g.s);
  for (let i = 0; i < SEATS; i++) if (!used.has(i)) return i;
  return SEATS - 1;
}
function pub(g) { return { id: g.id, a: g.a, n: g.n, c: g.c, s: g.s, d: g.d, l: g.l, g: g.g }; }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(r, obj, except) {
  const s = JSON.stringify(obj);
  for (const g of r.guests.values()) if (g.ws !== except && g.ws.readyState === 1) g.ws.send(s);
}

// ---- message validation: exact key sets, integer ranges ----
const SCHEMA = {
  hello: { a: [0, () => NADJ - 1], n: [0, () => NANI - 1], c: [0, () => COLORS - 1], d: [-1, () => DRINKS - 1], l: [0, () => SIPS] },
  nick:  { a: [0, () => NADJ - 1], n: [0, () => NANI - 1] },
  drink: { d: [-1, () => DRINKS - 1], l: [0, () => SIPS] },
  g:     { g: [0, () => GESTURES - 1] },
  round: { d: [0, () => DRINKS - 1] },
  seat:  { s: [0, () => SEATS - 1] },
  dice:  {},
  song:  { m: [0, () => MOODS - 1] },
  sing:  { m: [0, () => MOODS - 1] },
};
function validate(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return false;
  const sc = SCHEMA[msg.t]; if (!sc) return false;
  const keys = Object.keys(msg);
  if (keys.length !== Object.keys(sc).length + 1) return false;
  for (const k of Object.keys(sc)) if (!isInt(msg[k], sc[k][0], sc[k][1]())) return false;
  if (msg.t === 'drink' && msg.d === -1 && msg.l !== 0) return false;
  return true;
}

// ---- WebSocket ----
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const [url, qs] = (req.url || '').split('?');
  let ip = req.socket.remoteAddress || '?';
  if (TRUST_PROXY && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  if (url !== '/ws' || online >= MAX_CLIENTS || (ipCount.get(ip) || 0) >= MAX_PER_IP) {
    socket.write('HTTP/1.1 ' + (url !== '/ws' ? '404 Not Found' : '429 Too Many Requests') + '\r\nConnection: close\r\n\r\n');
    socket.destroy(); return;
  }
  const rawUid = qs ? new URLSearchParams(qs).get('uid') : '';
  const cid = /^[a-zA-Z0-9_-]{8,48}$/.test(rawUid || '') ? rawUid : null;
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  socket.once('close', () => { const n = (ipCount.get(ip) || 1) - 1; if (n <= 0) ipCount.delete(ip); else ipCount.set(ip, n); });
  wss.handleUpgrade(req, socket, head, ws => { ws.ip = ip; ws.cid = cid; wss.emit('connection', ws); });
});

wss.on('connection', ws => {
  ws.alive = true; ws.tokens = RATE_BURST; ws.last = Date.now(); ws.guest = null; ws.room = null;
  online++;
  const helloTimer = setTimeout(() => { if (!ws.guest) ws.terminate(); }, HELLO_TIMEOUT);
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data, isBinary) => {
    // rate limit
    const now = Date.now();
    ws.tokens = Math.min(RATE_BURST, ws.tokens + (now - ws.last) / 1000 * RATE_REFILL); ws.last = now;
    if (ws.tokens < 1) return ws.terminate();
    ws.tokens -= 1;
    if (isBinary) return ws.terminate();
    let msg; try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return ws.terminate(); }
    if (!validate(msg)) return ws.terminate();
    const g = ws.guest;
    if (!g) {
      if (msg.t !== 'hello') return ws.terminate();
      clearTimeout(helloTimer);
      let existing = null;
      if (ws.cid) {
        for (const o of wss.clients) if (o !== ws && o.guest && o.cid === ws.cid && o.room) { existing = o; break; }
      }
      if (existing) {
        const r = existing.room, guest = existing.guest;
        roomDay(r);
        guest.ws = ws; guest.a = msg.a; guest.n = msg.n; guest.c = msg.c; guest.d = msg.d; guest.l = msg.d < 0 ? 0 : msg.l;
        ws.guest = guest; ws.room = r;
        existing.guest = null; existing.room = null;
        try { existing.close(4001, 'replaced'); } catch (e) {}
        send(ws, { t: 'welcome', id: guest.id, room: r.id, roster: [...r.guests.values()].map(pub), toasts: r.toasts, rounds: r.rounds, online: Math.max(1, online - 1), song: r.song, perf: perfPub(r) });
        broadcast(r, { t: 'upd', id: guest.id, a: guest.a, n: guest.n, d: guest.d, l: guest.l }, ws);
        return;
      }
      const r = pickRoom();
      const guest = { id: nextGuestId++, a: msg.a, n: msg.n, c: msg.c, s: freeSeat(r), d: msg.d, l: msg.d < 0 ? 0 : msg.l, g: -1, ws, roundAt: 0, seatAt: 0, diceAt: 0, singAt: 0 };
      r.guests.set(guest.id, guest); ws.guest = guest; ws.room = r;
      send(ws, { t: 'welcome', id: guest.id, room: r.id, roster: [...r.guests.values()].map(pub), toasts: r.toasts, rounds: r.rounds, online, song: r.song, perf: perfPub(r) });
      broadcast(r, { t: 'join', p: pub(guest) }, ws);
      return;
    }
    const r = ws.room; roomDay(r);
    switch (msg.t) {
      case 'hello': return ws.terminate();
      case 'nick': g.a = msg.a; g.n = msg.n; broadcast(r, { t: 'upd', id: g.id, a: g.a, n: g.n }); break;
      case 'drink': g.d = msg.d; g.l = msg.l; broadcast(r, { t: 'upd', id: g.id, d: g.d, l: g.l }, ws); break;
      case 'g':
        g.g = msg.g;
        if (msg.g === 1) r.toasts++;
        if (r.perf && r.perf.id !== g.id && msg.g <= 1) r.perf.cheers++;
        broadcast(r, { t: 'g', id: g.id, g: msg.g, toasts: r.toasts });
        break;
      case 'seat': {
        const taken = [...r.guests.values()].some(o => o.s === msg.s);
        if (taken || now - g.seatAt < SEAT_CD) { send(ws, { t: 'seatno', s: msg.s, why: taken ? 0 : 1 }); break; }
        g.seatAt = now; g.s = msg.s;
        broadcast(r, { t: 'upd', id: g.id, s: g.s });
        break;
      }
      case 'dice': {
        if (now - g.diceAt < DICE_CD) break; // too soon: silently ignored
        g.diceAt = now;
        const v = []; for (let i = 0; i < 5; i++) v.push(crypto.randomInt(1, 7));
        broadcast(r, { t: 'dice', id: g.id, v });
        break;
      }
      case 'song': {
        const wait = r.songAt + SONG_ROOM_CD * 1000 - now;
        if (wait > 0) { send(ws, { t: 'songno', s: Math.ceil(wait / 1000) }); break; }
        r.songAt = now; r.song = msg.m;
        broadcast(r, { t: 'song', id: g.id, m: msg.m });
        break;
      }
      case 'sing': {
        if (r.perf) { send(ws, { t: 'singno', why: 0, s: Math.ceil((r.perf.end - now) / 1000) }); break; }
        const wait = g.singAt + SING_GUEST_CD * 1000 - now;
        if (g.singAt && wait > 0) { send(ws, { t: 'singno', why: 1, s: Math.ceil(wait / 1000) }); break; }
        g.singAt = now;
        r.perf = { id: g.id, m: msg.m, end: now + SING_MS, cheers: 0, timer: setTimeout(() => endSing(r), SING_MS) };
        broadcast(r, { t: 'sing', id: g.id, m: msg.m, left: SING_MS });
        break;
      }
      case 'round': {
        const waitGuest = g.roundAt + ROUND_GUEST_CD * 1000 - now;
        const waitRoom = r.lastRound + ROUND_ROOM_CD * 1000 - now;
        const wait = Math.max(waitGuest, waitRoom);
        if (wait > 0) { send(ws, { t: 'roundno', s: Math.ceil(wait / 1000), why: waitGuest >= waitRoom ? 0 : 1 }); break; }
        g.roundAt = now; r.lastRound = now; r.rounds++;
        broadcast(r, { t: 'round', from: g.id, drink: msg.d, rounds: r.rounds });
        break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    online--;
    const g = ws.guest, r = ws.room;
    if (g && r) {
      r.guests.delete(g.id);
      if (r.perf && r.perf.id === g.id) endSing(r);
      if (r.guests.size === 0) { if (r.perf) clearTimeout(r.perf.timer); rooms.delete(r.id); }
      else broadcast(r, { t: 'leave', id: g.id });
    }
  });
  ws.on('error', () => {});
});

// heartbeat: reap sockets that miss a pong
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; try { ws.ping(); } catch (e) {}
  }
}, HEARTBEAT_MS);

// online count, sent only when it changes
let lastOnline = -1;
const oc = setInterval(() => {
  if (online === lastOnline) return; lastOnline = online;
  const s = JSON.stringify({ t: 'online', n: online });
  for (const ws of wss.clients) if (ws.guest && ws.readyState === 1) ws.send(s);
}, 3000);

server.listen(PORT, HOST, () => console.log(`摸鱼酒馆 listening on http://${HOST}:${PORT}  (lists: ${NADJ} adj, ${NANI} animals)`));
function shutdown() { clearInterval(hb); clearInterval(oc); for (const ws of wss.clients) ws.terminate(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
