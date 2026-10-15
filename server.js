// Hindsight multiplayer server. No dependencies: Node 16+.
// Run: PORT=3000 node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const HTML_GZ = zlib.gzipSync(HTML);
const SERIES = fs.readFileSync(path.join(__dirname, 'public', 'series.json'));
const SERIES_GZ = zlib.gzipSync(SERIES);
const MAX_PRESENCE = 8192;
const GRACE_MS = 15000;

// tables: code -> { peers: Map(id -> {presence, conns:Set, goneAt}) }
const tables = new Map();
const lobbyConns = new Set();

const okCode = c => /^[A-Z]{4}$/.test(c || '');
const okId = i => /^[a-z0-9]{6,32}$/.test(i || '');

function tableState(code) {
  const t = tables.get(code);
  if (!t) return { peers: [] };
  return { peers: [...t.peers].map(([id, p]) => ({ id, presence: p.presence })) };
}
function send(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} }
function broadcast(code) {
  const t = tables.get(code); if (!t) return;
  const st = tableState(code);
  for (const p of t.peers.values()) for (const res of p.conns) send(res, st);
  broadcastLobby();
}
function lobbyList() {
  const out = [];
  for (const [code, t] of tables) {
    const ps = [...t.peers.values()].map(p => p.presence).filter(p => p && p.nick);
    const host = ps.find(p => p.host && p.game);
    if (!host) continue;
    out.push({ code, nick: String(host.nick).slice(0, 16), n: Math.min(8, ps.length), phase: host.game.phase || 'setup' });
  }
  return out.slice(0, 30);
}
let lobbyTimer = null;
function broadcastLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => { lobbyTimer = null; const l = { tables: lobbyList() }; for (const r of lobbyConns) send(r, l); }, 250);
}
function sweep() {
  const now = Date.now();
  for (const [code, t] of tables) {
    let changed = false;
    for (const [id, p] of t.peers) if (!p.conns.size && p.goneAt && now - p.goneAt > GRACE_MS) { t.peers.delete(id); changed = true; }
    if (!t.peers.size) tables.delete(code); else if (changed) broadcast(code);
  }
}
setInterval(sweep, 3000);
setInterval(() => { // keep-alive comments so proxies don't drop streams
  for (const t of tables.values()) for (const p of t.peers.values()) for (const r of p.conns) { try { r.write(': ping\n\n'); } catch (e) {} }
  for (const r of lobbyConns) { try { r.write(': ping\n\n'); } catch (e) {} }
}, 20000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_PRESENCE * 2) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
  });
}
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gz ? HTML_GZ : HTML);
    }
    if (req.method === 'GET' && u.pathname === '/series.json') {
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gz ? SERIES_GZ : SERIES);
    }
    if (req.method === 'GET' && u.pathname === '/lobby') {
      sse(res); lobbyConns.add(res); send(res, { tables: lobbyList() });
      req.on('close', () => lobbyConns.delete(res));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      const code = (u.searchParams.get('t') || '').toUpperCase(), id = u.searchParams.get('id');
      if (!okCode(code) || !okId(id)) return json(res, 400, { error: 'bad table or id' });
      if (!tables.has(code)) tables.set(code, { peers: new Map() });
      const t = tables.get(code);
      if (!t.peers.has(id)) t.peers.set(id, { presence: {}, conns: new Set(), goneAt: 0 });
      const p = t.peers.get(id); p.conns.add(res); p.goneAt = 0;
      sse(res); send(res, tableState(code));
      req.on('close', () => { p.conns.delete(res); if (!p.conns.size) p.goneAt = Date.now(); });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/presence') {
      const b = await readBody(req);
      const code = String(b.t || '').toUpperCase();
      if (!okCode(code) || !okId(b.id) || typeof b.patch !== 'object' || !b.patch) return json(res, 400, { error: 'bad request' });
      const t = tables.get(code); const p = t && t.peers.get(b.id);
      if (!p) return json(res, 404, { error: 'not in table' });
      const next = { ...p.presence };
      for (const [k, v] of Object.entries(b.patch)) { if (v === null) delete next[k]; else next[k] = v; }
      if (JSON.stringify(next).length > MAX_PRESENCE) return json(res, 413, { error: 'presence too large' });
      p.presence = next; broadcast(code);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/leave') {
      const b = await readBody(req);
      const code = String(b.t || '').toUpperCase(); const t = tables.get(code);
      if (t && t.peers.has(b.id)) { const p = t.peers.get(b.id); for (const r of p.conns) { try { r.end(); } catch (e) {} } t.peers.delete(b.id); if (!t.peers.size) tables.delete(code); broadcast(code); }
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/health') return json(res, 200, { ok: true, tables: tables.size });
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 400, { error: 'bad request' });
  }
});
server.listen(PORT, () => console.log('Hindsight listening on port ' + PORT));
