// World Cafe Vault - AI relay and device sync (Cloudflare Worker)
//
// The app calls this Worker; the Worker calls Ollama Cloud. The Ollama API key
// lives only in the Worker secret OLLAMA_API_KEY and is never sent to the app.
// The Worker also keeps one synced copy of the library (plus the last 5 saved
// copies) in a D1 database, so the computer and phone stay in step.
//
// Settings in the Cloudflare dashboard (nothing secret is in this file):
//   Secret   OLLAMA_API_KEY  - your Ollama API key
//   Secret   APP_TOKEN       - long random code; the same value goes in the app's settings
//   Variable MODEL           - Ollama model name, e.g. gpt-oss:20b
//   Variable DAILY_LIMIT     - runs allowed per day (UTC), e.g. 60
//   KV binding RATE          - a KV namespace used only for the daily run counter
//   D1 binding DB            - the sync database (tables: see the CREATE TABLE lines below)
//
// Endpoints:
//   GET  /usage  -> { limit, used, left }          (does not count as a run)
//   POST /pick   -> { picks: [{ id, reason }], model, left }
//   GET  /sync?have=N             -> latest synced copy (or { unchanged: true } if N is current)
//   PUT  /sync?base=N&device=..   -> save a new copy; refused with 409 unless N is the latest version
//   GET  /sync/history            -> the last 5 saved copies (version, time, device, counts)
//   GET  /sync/copy?v=N           -> one saved copy
//   GET  /altradio?date=YYYY-MM-DD -> { date, html } from WHRO's public AltRadio day playlist
//                                    (read-only; WHRO's page cannot be read by the app directly)
// Sync and AltRadio requests never count as AI runs. Saved copies must not contain the YouTube API key,
// the relay token or the Worker address; the Worker refuses any copy that does.
//
// This Worker never logs requests or instructions. Turn Workers Logs off in the
// Worker's settings as well.

const ALLOWED_ORIGINS = ['https://jcreis3-oss.github.io', 'http://127.0.0.1:8080'];
const OLLAMA_URL = 'https://ollama.com/api/chat';
const MAX_BODY_BYTES = 200000;
const MAX_CANDIDATES = 1500;
const MAX_INSTRUCTION = 2000;
const MAX_TARGET = 50;
const MAX_SYNC_BYTES = 1900000; // D1 rows top out at about 2 MB
const KEEP_COPIES = 5;
const FORBIDDEN_KEYS = ['"youtubeApiKey"', '"aiAppToken"', '"aiWorkerUrl"'];

// Run once in the D1 console when setting up:
// CREATE TABLE vault (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, device TEXT, tracks INTEGER, playlists INTEGER);
// CREATE TABLE vault_history (version INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, device TEXT, tracks INTEGER, playlists INTEGER);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        }
      : { Vary: 'Origin' };
    const reply = (status, obj) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

    if (!allowed) return reply(403, { error: 'Origin not allowed.' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const token = request.headers.get('X-App-Token') || '';
    if (!env.APP_TOKEN || !(await sameText(token, env.APP_TOKEN))) {
      return reply(401, { error: 'App token missing or wrong.' });
    }
    const url = new URL(request.url);
    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return handleSync(request, env, url, cors, reply);
    if (url.pathname === '/altradio') {
      if (request.method !== 'GET') return reply(405, { error: 'Use GET.' });
      return handleAltRadio(url, reply);
    }

    if (!env.RATE) return reply(500, { error: 'Worker setup: KV binding RATE is missing.' });
    const limit = Math.max(0, parseInt(env.DAILY_LIMIT || '60', 10) || 0);
    const day = new Date().toISOString().slice(0, 10);
    const counterKey = 'runs:' + day;
    const used = parseInt((await env.RATE.get(counterKey)) || '0', 10) || 0;

    if (request.method === 'GET' && url.pathname === '/usage') {
      return reply(200, { limit, used, left: Math.max(0, limit - used), day });
    }
    if (request.method !== 'POST' || url.pathname !== '/pick') return reply(404, { error: 'Not found.' });
    if (used >= limit) return reply(429, { error: 'Daily limit reached.', limit, used, left: 0 });
    if (!env.OLLAMA_API_KEY) return reply(500, { error: 'Worker setup: secret OLLAMA_API_KEY is missing.' });

    // ---- read and check the request ----
    const declared = parseInt(request.headers.get('Content-Length') || '0', 10) || 0;
    if (declared > MAX_BODY_BYTES) return reply(413, { error: 'Request too large.' });
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, { error: 'Request too large.' });
    let body;
    try { body = JSON.parse(raw); } catch (e) { return reply(400, { error: 'Request is not valid JSON.' }); }

    const instruction = String(body.instruction || '').trim().slice(0, MAX_INSTRUCTION);
    const target = Math.min(MAX_TARGET, Math.max(1, parseInt(body.target, 10) || 15));
    const scope = String(body.scope || 'All sources').slice(0, 40);
    const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, MAX_CANDIDATES) : [];
    if (!instruction) return reply(400, { error: 'Instruction is empty.' });
    if (!candidates.length) return reply(400, { error: 'No candidate tracks were sent.' });

    const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n|]+/g, ' ').trim().slice(0, n);
    const lines = candidates
      .map((c) => [clip(c.id, 12), clip(c.artist, 120), clip(c.song, 160), clip(c.album, 120),
        clip(c.source, 30), clip(c.type, 30), clip(c.notes, 200)].join(' | '))
      .join('\n');

    // Count the run before calling Ollama, so failed or slow calls still count toward the cap.
    await env.RATE.put(counterKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    const left = Math.max(0, limit - used - 1);

    const system =
      'You are a music curator building a playlist from a fixed list of candidate tracks. ' +
      'Each candidate line is: id | artist | song | album | source | type | notes. ' +
      'Choose ONLY from the candidates, and refer to each choice by its exact id. Never invent ids or tracks. ' +
      'Use the track details plus your own general music knowledge. If you are unsure whether a track fits, leave it out. ' +
      'Return at most ' + target + ' picks, best fit first, each id at most once. If fewer tracks fit, return fewer. ' +
      'Answer with JSON only, in this exact shape: {"picks":[{"id":"t1","reason":"one short sentence"}]}';
    const user =
      'Playlist request: ' + instruction + '\n' +
      'Source scope: ' + scope + '\n' +
      'Target length: ' + target + '\n\n' +
      'Candidates:\n' + lines;

    let upstream;
    try {
      upstream = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.OLLAMA_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.MODEL || 'gpt-oss:20b',
          stream: false,
          format: 'json',
          options: { temperature: 0.3 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
    } catch (e) {
      return reply(502, { error: 'Could not reach Ollama.', left });
    }
    if (!upstream.ok) {
      const status = upstream.status;
      const hint = status === 401 || status === 403 ? 'Ollama refused the API key.'
        : status === 404 ? 'Ollama does not know the model "' + (env.MODEL || 'gpt-oss:20b') + '".'
        : status === 429 ? 'Ollama rate limit reached.'
        : 'Ollama returned an error.';
      return reply(502, { error: hint + ' (HTTP ' + status + ')', left });
    }

    let data;
    try { data = await upstream.json(); } catch (e) { return reply(502, { error: 'Ollama sent an unreadable reply.', left }); }
    const content = (data && data.message && data.message.content) || '';
    const parsed = parsePicks(content);
    if (!parsed) return reply(502, { error: 'The model did not answer in the expected format.', left });

    const picks = parsed
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({ id: String(p.id || '').trim().slice(0, 12), reason: String(p.reason || '').trim().slice(0, 300) }))
      .filter((p) => p.id)
      .slice(0, MAX_TARGET * 2);
    return reply(200, { picks, model: env.MODEL || 'gpt-oss:20b', left, limit });
  },
};

// ---------------- Device sync ----------------
async function handleSync(request, env, url, cors, reply) {
  if (!env.DB) return reply(500, { error: 'Worker setup: D1 binding DB is missing.' });
  const head = 'SELECT version, updated_at, device, tracks, playlists FROM ';
  const meta = (r) => ({ version: r.version, updatedAt: r.updated_at, device: r.device || '', tracks: r.tracks, playlists: r.playlists });
  const rawReply = (r) => new Response(
    '{"version":' + r.version + ',"updatedAt":' + JSON.stringify(r.updated_at) + ',"device":' + JSON.stringify(r.device || '') +
    ',"tracks":' + (r.tracks | 0) + ',"playlists":' + (r.playlists | 0) + ',"data":' + r.data + '}',
    { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  if (request.method === 'GET' && url.pathname === '/sync') {
    const row = await env.DB.prepare(head + 'vault WHERE id = 1').first();
    if (!row) return reply(200, { version: 0 });
    const have = parseInt(url.searchParams.get('have') || '-1', 10);
    if (have === row.version) return reply(200, { ...meta(row), unchanged: true });
    const full = await env.DB.prepare('SELECT version, updated_at, device, tracks, playlists, data FROM vault WHERE id = 1').first();
    return rawReply(full);
  }
  if (request.method === 'GET' && url.pathname === '/sync/history') {
    const { results } = await env.DB.prepare(head + 'vault_history ORDER BY version DESC LIMIT ?').bind(KEEP_COPIES).all();
    return reply(200, { copies: (results || []).map(meta) });
  }
  if (request.method === 'GET' && url.pathname === '/sync/copy') {
    const v = parseInt(url.searchParams.get('v') || '0', 10);
    const row = await env.DB.prepare('SELECT version, updated_at, device, tracks, playlists, data FROM vault_history WHERE version = ?').bind(v).first();
    return row ? rawReply(row) : reply(404, { error: 'That saved copy is no longer kept.' });
  }
  if (request.method === 'PUT' && url.pathname === '/sync') {
    const base = parseInt(url.searchParams.get('base') || '', 10);
    if (!(base >= 0)) return reply(400, { error: 'Missing base version.' });
    const device = String(url.searchParams.get('device') || '').replace(/[^\w .-]/g, '').slice(0, 30);
    const tracks = Math.max(0, parseInt(url.searchParams.get('tracks') || '0', 10) || 0);
    const playlists = Math.max(0, parseInt(url.searchParams.get('playlists') || '0', 10) || 0);
    const declared = parseInt(request.headers.get('Content-Length') || '0', 10) || 0;
    if (declared > MAX_SYNC_BYTES) return reply(413, { error: 'Library too large to sync.' });
    const data = await request.text();
    if (new TextEncoder().encode(data).length > MAX_SYNC_BYTES) return reply(413, { error: 'Library too large to sync.' });
    if (data[0] !== '{' || !data.includes('"tracks"')) return reply(400, { error: 'That is not a library copy.' });
    if (FORBIDDEN_KEYS.some((k) => data.includes(k))) return reply(400, { error: 'Refused: the copy contains a key, token or Worker address.' });

    const now = new Date().toISOString();
    const res = base === 0
      ? await env.DB.prepare('INSERT INTO vault (id, version, data, updated_at, device, tracks, playlists) VALUES (1, 1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
          .bind(data, now, device, tracks, playlists).run()
      : await env.DB.prepare('UPDATE vault SET version = version + 1, data = ?, updated_at = ?, device = ?, tracks = ?, playlists = ? WHERE id = 1 AND version = ?')
          .bind(data, now, device, tracks, playlists, base).run();
    if (!res.meta || res.meta.changes !== 1) {
      const cur = await env.DB.prepare(head + 'vault WHERE id = 1').first();
      return reply(409, { error: 'The synced copy changed on another device.', ...(cur ? meta(cur) : { version: 0 }) });
    }
    const version = base + 1;
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO vault_history (version, data, updated_at, device, tracks, playlists) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(version, data, now, device, tracks, playlists),
      env.DB.prepare('DELETE FROM vault_history WHERE version NOT IN (SELECT version FROM vault_history ORDER BY version DESC LIMIT ?)').bind(KEEP_COPIES),
    ]);
    return reply(200, { version, updatedAt: now, device, tracks, playlists });
  }
  return reply(404, { error: 'Not found.' });
}

// ---------------- AltRadio playlist (read-only) ----------------
// Fetches only WHRO's public AltRadio day page for one date and passes its text back unchanged;
// the app reads it. Nothing is stored. Cloudflare's cache keeps past days for a day, today for 5 minutes.
const ALTRADIO_URL = 'https://mediaplayer.whro.org/playlists/altradio/';
const ALTRADIO_MAX_BYTES = 600000;

async function handleAltRadio(url, reply) {
  const date = url.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply(400, { error: 'Use date=YYYY-MM-DD.' });
  const today = new Date().toISOString().slice(0, 10);
  let res;
  try {
    res = await fetch(ALTRADIO_URL + date + '.txt', { cf: { cacheEverything: true, cacheTtl: date < today ? 86400 : 300 } });
  } catch (e) {
    return reply(502, { error: 'Could not reach WHRO.' });
  }
  if (res.status === 404) return reply(404, { error: 'No AltRadio playlist for that date.', noPlaylist: true });
  if (!res.ok) return reply(502, { error: 'WHRO answered HTTP ' + res.status + '.' });
  const html = await res.text();
  if (new TextEncoder().encode(html).length > ALTRADIO_MAX_BYTES) return reply(502, { error: 'WHRO sent an unexpectedly large page.' });
  // WHRO's own player treats a full HTML page as "no playlist" (an error page, not a day file).
  if (/^\s*<!DOCTYPE/i.test(html)) return reply(404, { error: 'No AltRadio playlist for that date.', noPlaylist: true });
  return reply(200, { date, html });
}

function parsePicks(text) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  let obj = tryParse(text);
  if (!obj) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(text.slice(a, b + 1));
  }
  if (!obj) return null;
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.picks)) return obj.picks;
  return null;
}

// Compares two strings without leaking how much of them matched.
async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
