'use strict';

// ─── AfnoKamai bridge + write-proxy ─────────────────────────────────────
//
// One Appwrite Function (node-22, execute: ["any"]) replacing the two things
// Firestore used to give us for free:
//
//   action 'bridge' — verifies a Firebase ID token, mirrors that identity
//     into Appwrite (user $id == Firebase uid, `admins` team membership from
//     the `admin` custom claim) and returns a server-minted session secret.
//     The browser then sends `X-Appwrite-Session` so row-level read grants
//     can address the real user. Firebase Auth stays the only credential a
//     person ever sees.
//
//   action 'write'  — the ONLY path by which a browser can create, update or
//     delete a row. Appwrite evaluates a `create` grant against the table
//     alone (probed live), so a table that let users create would also let
//     them overwrite every row it owns. Hence: no table grants write to
//     users, and this Function authenticates the caller and runs the ported
//     firestore.rules (src/policy.js) before touching the row with the
//     server-side API key.
//
// No secret lives in this file: APPWRITE_API_KEY is injected as an Appwrite
// environment variable, never committed to the repo.

const crypto = require('node:crypto');
const { checkWrite } = require('./policy');

const EP = process.env.APPWRITE_ENDPOINT || 'https://sgp.cloud.appwrite.io/v1';
const PID = process.env.APPWRITE_PROJECT_ID || '6ac536e6001dd29da193';
const DB = process.env.APPWRITE_DATABASE_ID || '6ac53c92002a02a202fe';
const FB_PROJECT = process.env.FIREBASE_PROJECT_ID || 'afnokamainp';
const ADMIN_TEAM = process.env.APPWRITE_ADMIN_TEAM || 'admins';
const KEY = process.env.APPWRITE_API_KEY;

const rowsBase = (t) => `/tablesdb/${DB}/tables/${t}/rows`;
const rowUrl = (t, id) => `${rowsBase(t)}/${encodeURIComponent(id)}`;

// ── Appwrite REST (server side, API key) ───────────────────────────────
async function aw(method, path, body) {
  const headers = {
    'X-Appwrite-Project': PID,
    'Content-Type': 'application/json',
    'X-Appwrite-Key': KEY
  };
  const res = await fetch(EP + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { message: text.slice(0, 400) }; }
  return { status: res.status, json, text };
}

// ── Firebase ID token verification (dependency free) ───────────────────
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = null;
let jwksAt = 0;

async function jwkFor(kid, force) {
  if (force || !jwks || Date.now() - jwksAt > 60 * 60 * 1000) {
    const r = await fetch(JWKS_URL);
    const body = await r.json();
    const map = new Map();
    for (const k of body.keys || []) if (k.kid) map.set(k.kid, k);
    if (!map.size) throw new Error('could not load Firebase signing keys');
    jwks = map;
    jwksAt = Date.now();
  }
  const jwk = jwks.get(kid);
  if (!jwk) {
    if (force) throw new Error('unknown signing key');
    return jwkFor(kid, true); // key rotation — refetch once
  }
  return jwk;
}

function b64url(input) {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
}

async function verifyIdToken(idToken) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw new Error('missing idToken');
  const parts = idToken.split('.');
  let header, claims;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    claims = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch (_) { throw new Error('malformed idToken'); }

  if (header.alg !== 'RS256') throw new Error('unsupported token algorithm');
  const jwk = await jwkFor(header.kid, false);
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.createVerify('RSA-SHA256')
    .update(parts[0] + '.' + parts[1])
    .verify(publicKey, b64url(parts[2]));
  if (!ok) throw new Error('bad token signature');

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== 'https://securetoken.google.com/' + FB_PROJECT) throw new Error('wrong issuer');
  if (claims.aud !== FB_PROJECT) throw new Error('wrong audience');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new Error('bad subject');
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new Error('token expired');
  if (!Number.isFinite(claims.iat) || claims.iat > now + 300) throw new Error('token issued in the future');

  return {
    uid: claims.sub,
    email: claims.email || '',
    name: claims.name || '',
    verified: claims.email_verified === true,
    admin: claims.admin === true
  };
}

// ── Row helpers ────────────────────────────────────────────────────────
async function readRow(table, rowId) {
  const r = await aw('GET', rowUrl(table, rowId));
  if (r.status === 404) return null;
  if (r.status >= 300) throw new Error((r.json && r.json.message) || 'read failed (' + r.status + ')');
  return r.json;
}

let aclModule = null;
async function acl() {
  if (!aclModule) aclModule = await import('./appwrite-acl.mjs');
  return aclModule;
}

// ── Identity: mirror the Firebase user into Appwrite ───────────────────
async function ensureAppwriteUser(id) {
  const r = await aw('POST', '/users', {
    userId: id.uid,
    email: id.email || id.uid + '@placeholder.afnokamai.invalid',
    name: id.name || id.email || id.uid
  });
  if (r.status === 409) {
    // Already mirrored — keep it in step with Firebase, best effort.
    try {
      await aw('PATCH', '/users/' + encodeURIComponent(id.uid), {
        name: id.name || id.email || id.uid,
        emailVerified: id.verified
      });
    } catch (_) { /* email/name drift is not fatal */ }
  } else if (r.status >= 300) {
    // A uid Appwrite refuses as a user id is a hard failure: without an
    // Appwrite identity there is no session and no row-level read access.
    throw new Error((r.json && r.json.message) || 'could not create Appwrite user (' + r.status + ')');
  }
}

const confirmed = (m) => !!m && (m.confirm === true || m.confirmation === true || m.status === 'active');

async function syncAdminTeam(id) {
  try {
    const listed = await aw('GET', '/teams/' + ADMIN_TEAM + '/memberships');
    const mine = ((listed.json && listed.json.memberships) || []).filter((m) => m.userId === id.uid);

    if (!id.admin) {
      for (const m of mine) await aw('DELETE', '/teams/' + ADMIN_TEAM + '/memberships/' + m.$id);
      return;
    }
    if (mine.some(confirmed)) return;

    let pending = mine[0] || null;
    if (!pending) {
      const created = await aw('POST', '/teams/' + ADMIN_TEAM + '/memberships', {
        userId: id.uid, email: id.email, name: id.name || id.email, roles: ['owner']
      });
      if (created.status >= 300 && created.status !== 409) return; // non-fatal
      pending = created.json && created.json.$id ? created.json : null;
    }
    if (!pending) return;

    // Server-side confirmation: the API key reads the invite secret and
    // activates the membership without an email round-trip.
    const secret = await aw('GET', '/teams/' + ADMIN_TEAM + '/memberships/' + pending.$id + '/secret');
    const value = secret.json && (secret.json.secret || secret.json.$secret);
    if (value) {
      await aw('PATCH', '/teams/' + ADMIN_TEAM + '/memberships/' + pending.$id, {
        secret: value, roles: ['owner']
      });
    }
  } catch (e) {
    // Admin sync is an availability concern, never a security one: the token
    // claim is what the policy trusts.
    console.warn('[bridge] admin team sync failed: ' + (e && e.message));
  }
}

async function mintSession(uid) {
  const base = '/users/' + encodeURIComponent(uid);
  let r = await aw('POST', base + '/sessions', {});
  if (r.status < 300 && r.json && r.json.secret) return r.json.secret;

  // Session cap reached (the client re-bridges on every page load): prune the
  // stale server-created sessions and retry once.
  const stale = await aw('GET', base + '/sessions');
  const list = (stale.json && stale.json.sessions) || [];
  for (const s of list.slice(0, 20)) await aw('DELETE', base + '/sessions/' + s.$id);
  if (list.length) r = await aw('POST', base + '/sessions', {});
  if (r.status < 300 && r.json && r.json.secret) return r.json.secret;
  throw new Error((r.json && r.json.message) || 'could not mint a session (' + r.status + ')');
}

async function doBridge(payload) {
  const id = await verifyIdToken(payload.idToken);
  await ensureAppwriteUser(id);
  await syncAdminTeam(id);
  const secret = await mintSession(id.uid);
  return { ok: true, userId: id.uid, secret };
}

// ── The write proxy ────────────────────────────────────────────────────
const bannedCache = new Map();

function makeCtx(id) {
  const rowCache = new Map();
  const effects = [];
  return {
    uid: id.uid,
    email: id.email,
    verified: id.verified,
    admin: id.admin,
    effects,
    async read(table, rowId) {
      const key = table + '/' + rowId;
      if (rowCache.has(key)) return rowCache.get(key);
      let row = null;
      try { row = await readRow(table, rowId); } catch (_) { row = null; }
      rowCache.set(key, row);
      return row;
    },
    async notBanned() {
      const hit = bannedCache.get(id.uid);
      if (hit && Date.now() - hit.at < 5000) return hit.value;
      let value = true;
      try {
        const me = await readRow('users', id.uid);
        value = !me || (me.status || 'active') === 'active';
      } catch (_) { value = true; }
      bannedCache.set(id.uid, { value: value, at: Date.now() });
      return value;
    },
    effect(op) { effects.push(op); }
  };
}

async function doWrite(payload, id) {
  const table = payload.table;
  const rowId = payload.rowId;
  const op = payload.op;
  const data = (payload.data && typeof payload.data === 'object') ? payload.data : {};

  if (!table || !rowId || ['create', 'update', 'delete'].indexOf(op) < 0) {
    const e = new Error('malformed write request');
    e.status = 400; e.code = 'invalid-argument';
    throw e;
  }

  const modules = await acl();
  if (modules.TABLES.indexOf(table) < 0) {
    const e = new Error('unknown collection: ' + table);
    e.status = 400; e.code = 'invalid-argument';
    throw e;
  }

  const ctx = makeCtx(id);
  const current = await readRow(table, rowId);

  const denial = await checkWrite({ table: table, op: op, rowId: rowId, data: data, current: current, ctx: ctx });
  if (denial) {
    const e = new Error(denial);
    e.status = 403; e.code = 'permission-denied';
    throw e;
  }

  let res;
  if (op === 'create') {
    const permissions = modules.permissionsFor(table, data, rowId);
    res = await aw('POST', rowsBase(table), { rowId: rowId, data: data, permissions: permissions });
  } else if (op === 'update') {
    res = await aw('PATCH', rowUrl(table, rowId), { data: data });
  } else {
    res = await aw('DELETE', rowUrl(table, rowId));
  }

  if (res.status >= 300 && !(op === 'delete' && res.status === 404)) {
    const e = new Error((res.json && res.json.message) || 'write failed (' + res.status + ')');
    e.status = res.status;
    e.type = res.json && res.json.type;
    e.code = res.status === 409 ? 'already-exists' : 'invalid-argument';
    throw e;
  }

  // Server-side follow-ups for the half of a Firestore batch the adapter
  // cannot make atomic (the chat pacing stamp).
  for (const fx of ctx.effects) {
    try {
      await aw('PATCH', rowUrl(fx.table, fx.rowId), { data: fx.data });
    } catch (e) {
      console.warn('[bridge] effect failed: ' + (e && e.message));
    }
  }

  return { ok: true };
}

// ── Runtime glue ───────────────────────────────────────────────────────
function parseBody(req) {
  try {
    const j = req.bodyJson;
    if (j && typeof j === 'object') return j;
  } catch (_) { /* empty body */ }
  const raw = (typeof req.body === 'string' && req.body)
    ? req.body
    : (typeof req.bodyText === 'string' ? req.bodyText : '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function handler(ctx) {
  const req = ctx.req;
  const res = ctx.res;
  const log = typeof ctx.log === 'function' ? ctx.log : function () {};
  const send = (body, status) => res.json(body, status);

  try {
    if (!KEY) {
      const e = new Error('bridge is not configured (APPWRITE_API_KEY missing)');
      e.status = 500; e.code = 'internal';
      throw e;
    }

    const payload = parseBody(req);
    if (!payload || typeof payload !== 'object') {
      const e = new Error('expected a JSON body');
      e.status = 400; e.code = 'invalid-argument';
      throw e;
    }

    if (payload.action === 'bridge') {
      return send(await doBridge(payload), 200);
    }

    if (payload.action === 'write') {
      const id = await verifyIdToken(payload.idToken);
      return send(await doWrite(payload, id), 200);
    }

    const e = new Error('unknown action');
    e.status = 400; e.code = 'invalid-argument';
    throw e;
  } catch (err) {
    const msg = (err && err.message) || 'request failed';
    const authFailure = /idToken|token|signature|issuer|audience|subject/i.test(msg);
    const status = (err && err.status) || (authFailure ? 401 : 500);
    const code = (err && err.code) || (status === 401 ? 'unauthenticated' : 'internal');
    log('error ' + status + ': ' + msg);
    const body = { ok: false, error: msg, code: code };
    if (err && err.type) body.type = err.type;
    return send(body, status);
  }
}

module.exports = handler;
module.exports.default = handler;
