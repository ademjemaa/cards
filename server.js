// Hindsight multiplayer server. No dependencies: Node 18+.
// Run: PORT=3000 node server.js
//
// One Server-Sent Events stream per browser tab (GET /stream?id=...) carries both the lobby list
// and the state of the table that tab sits at. Tabs send changes with small JSON POSTs.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
const pub = f => fs.readFileSync(path.join(__dirname, 'public', f));
const HTML = pub('index.html'), HTML_GZ = zlib.gzipSync(HTML);
const SERIES = pub('series.json'), SERIES_GZ = zlib.gzipSync(SERIES);
const MAX_PRESENCE = 8192;   // bytes of JSON per player
const GRACE_MS = 20000;      // how long a dropped tab keeps its seat
const MAX_SEATS_PER_TABLE = 24;

const clients = new Map();   // id -> { conns:Set<res>, table:code|null, goneAt }
const tables = new Map();    // code -> Map(id -> presence)

const okCode = c => /^[A-Z]{4}$/.test(c || '');
const okId = i => /^[a-z0-9]{6,40}$/.test(i || '');
const log = (...a) => console.log(new Date().toISOString(), ...a);

function send(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} }
function sendClient(id, obj) { const c = clients.get(id); if (c) for (const r of c.conns) send(r, obj); }
function tableMsg(code) { const t = tables.get(code); return { type: 'table', code, peers: t ? [...t].map(([id, presence]) => ({ id, presence })) : [] }; }
function pushTable(code) { const t = tables.get(code); if (!t) return; const m = tableMsg(code); for (const id of t.keys()) sendClient(id, m); scheduleLobby(); }
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
function scheduleLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => { lobbyTimer = null; const m = { type: 'lobby', tables: lobbyList() }; for (const id of clients.keys()) sendClient(id, m); }, 200);
}
function removeFromTable(id) {
  const c = clients.get(id); if (!c || !c.table) return;
  const code = c.table, t = tables.get(code); c.table = null;
  if (!t) return;
  t.delete(id);
  if (!t.size) { tables.delete(code); log('table closed', code); scheduleLobby(); } else pushTable(code);
}
setInterval(() => { // drop tabs that have been gone longer than the grace period
  const now = Date.now();
  for (const [id, c] of clients) if (!c.conns.size && c.goneAt && now - c.goneAt > GRACE_MS) { removeFromTable(id); clients.delete(id); }
}, 3000);
setInterval(() => { for (const c of clients.values()) for (const r of c.conns) { try { r.write(': ping\n\n'); } catch (e) {} } }, 15000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_PRESENCE * 2) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function serve(req, res, body, gz, type, cache) {
  const ok = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ...(ok ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(ok ? gz : body);
}
function merge(prev, patch) {
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete next[k]; else next[k] = v; }
  return next;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return serve(req, res, HTML, HTML_GZ, 'text/html; charset=utf-8', 'no-cache');
    if (req.method === 'GET' && u.pathname === '/series.json') return serve(req, res, SERIES, SERIES_GZ, 'application/json', 'public, max-age=3600');
    if (u.pathname === '/health') return json(res, 200, { ok: true, tables: tables.size, clients: clients.size });

    if (req.method === 'GET' && u.pathname === '/stream') {
      const id = u.searchParams.get('id');
      if (!okId(id)) return json(res, 400, { error: 'bad id' });
      if (!clients.has(id)) clients.set(id, { conns: new Set(), table: null, goneAt: 0 });
      const c = clients.get(id); c.conns.add(res); c.goneAt = 0;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      send(res, { type: 'hello', table: c.table });
      send(res, { type: 'lobby', tables: lobbyList() });
      if (c.table) send(res, tableMsg(c.table));
      req.on('close', () => { c.conns.delete(res); if (!c.conns.size) c.goneAt = Date.now(); });
      return;
    }

    if (req.method !== 'POST') { res.writeHead(404); return res.end('Not found'); }
    const b = await readBody(req);
    if (!okId(b.id)) return json(res, 400, { error: 'bad id' });
    const c = clients.get(b.id);
    if (!c) return json(res, 409, { error: 'not connected', code: 'not_connected' });

    if (u.pathname === '/join') {
      const code = String(b.t || '').toUpperCase();
      if (!okCode(code)) return json(res, 400, { error: 'Table codes are 4 letters.', code: 'bad_code' });
      if (!tables.has(code)) {
        if (!b.create && !b.reseat) return json(res, 404, { error: 'No table with that code. Check the letters or ask the host to create one.', code: 'no_table' });
        tables.set(code, new Map()); log('table opened', code);
      } else if (b.create && !b.reseat && c.table !== code) return json(res, 409, { error: 'That code is taken. Try again.', code: 'taken' });
      const t = tables.get(code);
      if (!t.has(b.id) && t.size >= MAX_SEATS_PER_TABLE) return json(res, 409, { error: 'That table is full.', code: 'full' });
      if (c.table && c.table !== code) removeFromTable(b.id);
      const p = merge(t.get(b.id) || {}, b.presence);
      if (JSON.stringify(p).length > MAX_PRESENCE) return json(res, 413, { error: 'Too much data.' });
      t.set(b.id, p); c.table = code; pushTable(code);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/presence') {
      const t = c.table && tables.get(c.table);
      if (!t || !t.has(b.id)) return json(res, 409, { error: 'not at a table', code: 'no_seat' });
      const p = merge(t.get(b.id), b.patch);
      if (JSON.stringify(p).length > MAX_PRESENCE) return json(res, 413, { error: 'Too much data.' });
      t.set(b.id, p); pushTable(c.table);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/leave') { removeFromTable(b.id); return json(res, 200, { ok: true }); }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 400, { error: 'bad request' });
  }
});
server.listen(PORT, () => log('Hindsight listening on port ' + PORT));
