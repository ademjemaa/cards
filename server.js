// Hindsight multiplayer server (Node 18+, socket.io).
// Run: npm install && PORT=3000 node server.js
//
// Each browser tab opens one socket.io connection (WebSocket, falling back to HTTP long-polling
// when a network or antivirus blocks streaming). The server keeps tables of players; every player's
// state is a small JSON object ("presence") that the server merges and rebroadcasts to the table.
// All game logic runs in the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Server } = require('socket.io');

const PORT = +process.env.PORT || 3000;
const pub = f => fs.readFileSync(path.join(__dirname, 'public', f));
const HTML = pub('index.html'), HTML_GZ = zlib.gzipSync(HTML);
const SERIES = pub('series.json'), SERIES_GZ = zlib.gzipSync(SERIES);
const MAX_PRESENCE = 8192;   // bytes of JSON per player
const GRACE_MS = 20000;      // how long a dropped tab keeps its seat
const MAX_SEATS_PER_TABLE = 24;

const clients = new Map();   // tab id -> { socks:Set, table:code|null, goneAt }
const tables = new Map();    // code -> Map(tab id -> presence)

const okCode = c => /^[A-Z]{4}$/.test(c || '');
const okId = i => /^[a-z0-9]{6,40}$/.test(i || '');
const log = (...a) => console.log(new Date().toISOString(), ...a);

function serve(req, res, body, gz, type, cache) {
  const ok = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ...(ok ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(ok ? gz : body);
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return serve(req, res, HTML, HTML_GZ, 'text/html; charset=utf-8', 'no-cache');
  if (req.method === 'GET' && u.pathname === '/series.json') return serve(req, res, SERIES, SERIES_GZ, 'application/json', 'public, max-age=3600');
  if (u.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, tables: tables.size, clients: clients.size })); }
  res.writeHead(404); res.end('Not found');
});
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 64 * 1024 });

function emitTo(id, ev, data) { const c = clients.get(id); if (c) for (const s of c.socks) s.emit(ev, data); }
function tableMsg(code) { const t = tables.get(code); return { code, peers: t ? [...t].map(([id, presence]) => ({ id, presence })) : [] }; }
function pushTable(code) { const t = tables.get(code); if (!t) return; const m = tableMsg(code); for (const id of t.keys()) emitTo(id, 'table', m); scheduleLobby(); }
function lobbyList() {
  const out = [];
  for (const [code, t] of tables) {
    const ps = [...t.values()].filter(p => p && p.nick);
    const host = ps.find(p => p.host && p.game);
    if (!host) continue;
    out.push({ code, nick: String(host.nick).slice(0, 16), n: Math.min(8, ps.length), phase: (host.game && host.game.phase) || 'setup' });
  }
  return out.slice(0, 40);
}
let lobbyTimer = null;
function scheduleLobby() { if (lobbyTimer) return; lobbyTimer = setTimeout(() => { lobbyTimer = null; io.emit('lobby', { tables: lobbyList() }); }, 200); }
function removeFromTable(id) {
  const c = clients.get(id); if (!c || !c.table) return;
  const code = c.table, t = tables.get(code); c.table = null;
  if (!t) return;
  t.delete(id);
  if (!t.size) { tables.delete(code); log('table closed', code); scheduleLobby(); } else pushTable(code);
}
setInterval(() => { // drop tabs that have been gone longer than the grace period
  const now = Date.now();
  for (const [id, c] of clients) if (!c.socks.size && c.goneAt && now - c.goneAt > GRACE_MS) { removeFromTable(id); clients.delete(id); }
}, 3000);
function merge(prev, patch) {
  const next = { ...prev };
  if (patch && typeof patch === 'object') for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
  return next;
}
const tooBig = p => JSON.stringify(p).length > MAX_PRESENCE;

io.on('connection', sock => {
  const id = sock.handshake.auth && sock.handshake.auth.id;
  if (!okId(id)) return sock.disconnect(true);
  if (!clients.has(id)) clients.set(id, { socks: new Set(), table: null, goneAt: 0 });
  const c = clients.get(id); c.socks.add(sock); c.goneAt = 0;
  sock.emit('hello', { table: c.table });
  sock.emit('lobby', { tables: lobbyList() });
  if (c.table) sock.emit('table', tableMsg(c.table));
  const reply = (ack, obj) => { if (typeof ack === 'function') ack(obj); };

  sock.on('join', (b, ack) => {
    b = b || {};
    const code = String(b.t || '').toUpperCase();
    if (!okCode(code)) return reply(ack, { ok: false, code: 'bad_code', error: 'Table codes are 4 letters.' });
    if (!tables.has(code)) {
      if (!b.create && !b.reseat) return reply(ack, { ok: false, code: 'no_table', error: 'No table with that code. Check the letters or ask the host to create one.' });
      tables.set(code, new Map()); log('table opened', code);
    } else if (b.create && !b.reseat && c.table !== code) return reply(ack, { ok: false, code: 'taken', error: 'That code is taken. Try again.' });
    const t = tables.get(code);
    if (!t.has(id) && t.size >= MAX_SEATS_PER_TABLE) return reply(ack, { ok: false, code: 'full', error: 'That table is full.' });
    const p = merge(t.get(id) || {}, b.presence);
    if (tooBig(p)) return reply(ack, { ok: false, code: 'too_big', error: 'Too much data.' });
    if (c.table && c.table !== code) removeFromTable(id);
    t.set(id, p); c.table = code; pushTable(code);
    reply(ack, { ok: true });
  });
  sock.on('presence', (b, ack) => {
    const t = c.table && tables.get(c.table);
    if (!t || !t.has(id)) return reply(ack, { ok: false, code: 'no_seat' });
    const p = merge(t.get(id), b && b.patch);
    if (tooBig(p)) return reply(ack, { ok: false, code: 'too_big', error: 'Too much data.' });
    t.set(id, p); pushTable(c.table);
    reply(ack, { ok: true });
  });
  sock.on('leave', (_b, ack) => { removeFromTable(id); reply(ack, { ok: true }); });
  sock.on('disconnect', () => { c.socks.delete(sock); if (!c.socks.size) c.goneAt = Date.now(); });
});

server.listen(PORT, () => log('Hindsight listening on port ' + PORT));
