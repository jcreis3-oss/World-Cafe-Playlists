// World Cafe Vault - AI relay (Cloudflare Worker)
//
// The app calls this Worker; the Worker calls Ollama Cloud. The Ollama API key
// lives only in the Worker secret OLLAMA_API_KEY and is never sent to the app.
//
// Settings in the Cloudflare dashboard (nothing secret is in this file):
//   Secret   OLLAMA_API_KEY  - your Ollama API key
//   Secret   APP_TOKEN       - long random code; the same value goes in the app's settings
//   Variable MODEL           - Ollama model name, e.g. gpt-oss:20b
//   Variable DAILY_LIMIT     - runs allowed per day (UTC), e.g. 60
//   KV binding RATE          - a KV namespace used only for the daily run counter
//
// Endpoints:
//   GET  /usage  -> { limit, used, left }          (does not count as a run)
//   POST /pick   -> { picks: [{ id, reason }], model, left }
//
// This Worker never logs requests or instructions. Turn Workers Logs off in the
// Worker's settings as well.

const ALLOWED_ORIGINS = ['https://jcreis3-oss.github.io', 'http://127.0.0.1:8080'];
const OLLAMA_URL = 'https://ollama.com/api/chat';
const MAX_BODY_BYTES = 200000;
const MAX_CANDIDATES = 1500;
const MAX_INSTRUCTION = 2000;
const MAX_TARGET = 50;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    if (!env.RATE) return reply(500, { error: 'Worker setup: KV binding RATE is missing.' });

    const url = new URL(request.url);
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
