'use strict';
/**
 * Appwrite TablesDB behind the firebase-admin Firestore API.
 *
 * scripts/push-sender.cjs is carefully tuned code — transaction claims,
 * batched reindex commits, cursor pagination, zombie sweeps. Rewriting that
 * logic against a different wire protocol would be a rewrite of working code
 * to change a driver, so instead this module speaks the small slice of the
 * Firestore surface the sender actually uses and does the talking to
 * Appwrite. The sender keeps its original body.
 *
 * What is faithful
 *   - doc()/collection().where().orderBy().limit().get() with the same
 *     operator and ordering semantics (Appwrite combines filters with AND).
 *   - FieldValue.serverTimestamp(), Timestamp#toMillis(), snap.exists,
 *     snap.data(), snap.docs, snap.size, snap.empty, last.get(field).
 *   - set()/set(merge)/update() including Firestore's rule that update() on a
 *     missing document is an error and full set() replaces.
 *
 * What is not, and why it does not matter here
 *   - No atomicity. Firestore's writeBatch() and runTransaction() commit
 *     atomically; Appwrite's TablesDB has no transaction or batch-write
 *     endpoint. A batch is therefore a pooled set of independent PATCHes and a
 *     transaction is optimistic: every document read is re-checked against its
 *     $updatedAt immediately before the writes land, and the whole
 *     transaction retries if anything moved. That is enough for this sender,
 *     whose only transactional claim is "did I just claim this notification?"
 *     and whose batches are idempotent patches (pushState, searchText). A
 *     crash mid-batch can leave a partial batch; the next run re-derives the
 *     same patches from the same rows, so the outcome converges.
 *   - Deletes are supported but unused by the sender.
 *
 * Configuration (all read at first use, never written to a browser — this is
 * CI-side only):
 *   APPWRITE_ENDPOINT    default https://sgp.cloud.appwrite.io/v1
 *   APPWRITE_PROJECT_ID  required
 *   APPWRITE_DATABASE_ID required
 *   APPWRITE_API_KEY     required, server-only
 */

const SERVER_TIMESTAMP = Symbol('serverTimestamp');

function cfg() {
  const endpoint = (process.env.APPWRITE_ENDPOINT || 'https://sgp.cloud.appwrite.io/v1').replace(/\/+$/, '');
  const projectId = process.env.APPWRITE_PROJECT_ID || '';
  const databaseId = process.env.APPWRITE_DATABASE_ID || '';
  const apiKey = process.env.APPWRITE_API_KEY || '';
  if (!projectId || !databaseId || !apiKey) {
    const missing = [
      !projectId && 'APPWRITE_PROJECT_ID',
      !databaseId && 'APPWRITE_DATABASE_ID',
      !apiKey && 'APPWRITE_API_KEY'
    ].filter(Boolean);
    throw new Error(`missing Appwrite configuration: ${missing.join(', ')}`);
  }
  return { endpoint, projectId, databaseId, apiKey };
}

let cachedCfg = null;
function config() {
  if (!cachedCfg) cachedCfg = cfg();
  return cachedCfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ──────────────────────────────────────────────────────────────
// Appwrite answers 429 under bursts and the reindex batch is a burst. The
// whole point of the original Firestore watchdog was that a silent stall is
// worse than a slow one, so backoff is bounded and then it throws.
async function aw(method, path, body) {
  const { endpoint, projectId, apiKey } = config();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(endpoint + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Appwrite-Project': projectId,
          'X-Appwrite-Key': apiKey
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(200 * 2 ** attempt);
      continue;
    }

    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt);
      continue;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

    if (res.status >= 400) {
      const err = new Error((json && json.message) || `${method} ${path} -> HTTP ${res.status}`);
      err.status = res.status;
      err.code = (json && json.type) || undefined;
      throw err;
    }
    return json;
  }
}

// ── Values ────────────────────────────────────────────────────────────
// Appwrite returns datetime columns as ISO strings. Firestore hands back
// Timestamps and the sender calls .toMillis() on them, so every ISO-looking
// string is wrapped on the way in and unwrapped on the way out.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/;

class Timestamp {
  constructor(value) { this._value = value; this._ms = Date.parse(value); }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
  toISOString() { return new Date(this._ms).toISOString(); }
  get seconds() { return Math.floor(this._ms / 1000); }
  get nanoseconds() { return (this._ms % 1000) * 1e6; }
  valueOf() { return this._ms; }
}

function decodeValue(v) {
  return typeof v === 'string' && ISO_RE.test(v) ? new Timestamp(v) : v;
}

function encodeValue(v) {
  if (v === undefined) return undefined;             // ignoreUndefinedProperties
  if (v === SERVER_TIMESTAMP) return new Date().toISOString();
  if (v instanceof Timestamp) return v.toISOString();
  if (v instanceof Date) return v.toISOString();
  return v;
}

function encodeData(data) {
  const out = {};
  for (const key of Object.keys(data)) {
    if (key.charCodeAt(0) === 36) continue;          // $-system fields are not data
    const value = encodeValue(data[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function decodeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    if (key.charCodeAt(0) === 36) continue;
    out[key] = decodeValue(row[key]);
  }
  return out;
}

// ── Paths and queries ─────────────────────────────────────────────────
const enc = encodeURIComponent;

function rowsPath(table) {
  return `/tablesdb/${enc(config().databaseId)}/tables/${enc(table)}/rows`;
}

function splitPath(path) {
  const parts = String(path).split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`expected "<collection>/<documentId>", got "${path}"`);
  }
  return parts;
}

const WHERE_METHOD = {
  '==': 'equal',
  '!=': 'notEqual',
  '>': 'greaterThan',
  '>=': 'greaterThanEqual',
  '<': 'lessThan',
  '<=': 'lessThanEqual'
};

// ── Documents ─────────────────────────────────────────────────────────
class DocumentSnapshot {
  constructor(ref, row) { this.ref = ref; this.id = ref.id; this._row = row; }
  get exists() { return !!this._row; }
  data() { return this._row ? decodeRow(this._row) : undefined; }
  get(field) {
    if (!this._row) return undefined;
    return decodeValue(this._row[field]);
  }
}

class DocumentReference {
  constructor(table, id) { this.table = table; this.id = id; this.path = `${table}/${id}`; }

  async get() {
    try {
      const row = await aw('GET', `${rowsPath(this.table)}/${enc(this.id)}`);
      return new DocumentSnapshot(this, row);
    } catch (err) {
      if (err.status === 404) return new DocumentSnapshot(this, null);
      throw err;
    }
  }

  /** Firestore update(): missing document is an error, not a create. */
  async update(data) {
    await aw('PATCH', `${rowsPath(this.table)}/${enc(this.id)}`, { data: encodeData(data) });
  }

  /**
   * Firestore set(): create when absent, replace when present. merge:true
   * creates when absent and merges when present.
   */
  async set(data, opts) {
    const payload = encodeData(data);
    const existing = await this.get();
    if (!existing.exists) {
      await aw('POST', rowsPath(this.table), { rowId: this.id, data: payload });
      return;
    }
    if (opts && opts.merge) {
      await aw('PATCH', `${rowsPath(this.table)}/${enc(this.id)}`, { data: payload });
      return;
    }
    // Full replace: fields the payload omits must end up null, exactly as
    // Firestore would drop them.
    const replaced = { ...payload };
    for (const key of Object.keys(existing._row)) {
      if (key.charCodeAt(0) === 36) continue;
      if (!(key in payload)) replaced[key] = null;
    }
    await aw('PATCH', `${rowsPath(this.table)}/${enc(this.id)}`, { data: replaced });
  }

  async delete() {
    try {
      await aw('DELETE', `${rowsPath(this.table)}/${enc(this.id)}`);
    } catch (err) {
      if (err.status !== 404) throw err;   // Firestore delete() is idempotent
    }
  }
}

// ── Queries ───────────────────────────────────────────────────────────
class QuerySnapshot {
  constructor(collection, rows) {
    this.docs = rows.map((row) =>
      new DocumentSnapshot(new DocumentReference(collection, row.$id || row.rowId), row)
    );
  }
  get empty() { return this.docs.length === 0; }
  get size() { return this.docs.length; }
  forEach(fn) { this.docs.forEach(fn); }
}

class Query {
  constructor(collection) {
    this.collection = collection;
    this.filters = [];
    this.order = null;
    this.max = null;
  }
  where(field, op, value) {
    const method = WHERE_METHOD[op];
    if (!method) throw new Error(`unsupported query operator: ${op}`);
    this.filters.push({ method, attribute: field, values: [encodeValue(value)] });
    return this;
  }
  orderBy(field, dir) {
    this.order = { method: dir === 'desc' ? 'orderDesc' : 'orderAsc', attribute: field, values: [] };
    return this;
  }
  limit(n) { this.max = n; return this; }

  async get() {
    const queries = [...this.filters];
    if (this.order) queries.push(this.order);
    if (this.max) queries.push({ method: 'limit', values: [this.max] });

    // Queries travel as indexed JSON params: queries[0]=<json>, queries[1]=<json>.
    // Verified against the server: `queries=<json array>` is rejected with
    // "Value must be a valid string" — each query must be its own string.
    const qs = queries
      .map((q, i) => `queries[${i}]=${encodeURIComponent(JSON.stringify(q))}`)
      .join('&');
    const json = await aw('GET', `${rowsPath(this.collection)}${qs ? '?' + qs : ''}`);
    return new QuerySnapshot(this.collection, (json && json.rows) || []);
  }
}

// ── Batches ───────────────────────────────────────────────────────────
// Firestore's writeBatch() is atomic and ordered. Ours is neither: Appwrite
// has no batch endpoint, so this is a bounded-concurrency fan-out of
// independent patches. See the note at the top of the file — every batch in
// push-sender.cjs re-derives the same patch from the same row, so a partial
// commit converges on the next run.
const BATCH_CONCURRENCY = 8;

async function runPool(items, limit, worker) {
  const queue = items.slice();
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(lanes);
}

class WriteBatch {
  constructor() { this.ops = []; }
  update(ref, data) { this.ops.push({ kind: 'update', ref, data }); return this; }
  set(ref, data, opts) { this.ops.push({ kind: 'set', ref, data, opts }); return this; }
  delete(ref) { this.ops.push({ kind: 'delete', ref }); return this; }
  async commit() {
    const ops = this.ops;
    this.ops = [];
    await runPool(ops, BATCH_CONCURRENCY, async (op) => {
      if (op.kind === 'delete') return op.ref.delete();
      if (op.kind === 'update') return op.ref.update(op.data);
      return op.ref.set(op.data, op.opts);
    });
  }
}

// ── Transactions ──────────────────────────────────────────────────────
// Optimistic, per the file header: read everything first, do the work, then
// re-read every touched document and only write if none of them moved.
// Firestore retries the whole body on contention; so do we.
const TX_ATTEMPTS = 6;

class Transaction {
  constructor() {
    this.reads = new Map();   // path -> $updatedAt observed at read time
    this.writes = [];         // { ref, data }
  }
  async get(ref) {
    const snap = await ref.get();
    this.reads.set(ref.path, snap.exists ? snap._row.$updatedAt : null);
    return snap;
  }
  update(ref, data) { this.writes.push({ ref, data }); return this; }
  set(ref, data, opts) { this.writes.push({ ref, data, opts, merge: true }); return this; }
}

async function commitTransaction(tx) {
  for (const [path, seenUpdatedAt] of tx.reads) {
    const [table, id] = splitPath(path);
    let current = null;
    try {
      current = await aw('GET', `${rowsPath(table)}/${enc(id)}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if ((current && current.$updatedAt) !== seenUpdatedAt) return false;
  }
  for (const w of tx.writes) {
    if (w.opts) await w.ref.set(w.data, w.opts);
    else await w.ref.update(w.data);
  }
  return true;
}

async function runTransaction(body) {
  let lastError = null;
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt++) {
    const tx = new Transaction();
    let result;
    try {
      result = await body(tx);
    } catch (err) {
      throw err;   // the body itself failed — retrying will not change that
    }
    let committed = false;
    try {
      committed = await commitTransaction(tx);
    } catch (err) {
      lastError = err;
      if (err.status !== 429 && err.status < 500) throw err;
      committed = false;
    }
    if (committed) return result;
    await sleep(30 * attempt + Math.random() * 40);
  }
  throw lastError || new Error('transaction contention: gave up after ' + TX_ATTEMPTS + ' attempts');
}

// ── The firebase-admin-shaped entry point ─────────────────────────────
function firestore() {
  return {
    settings() { /* Appwrite needs no client tuning; accepted for API parity. */ },
    doc(path) {
      const [table, id] = splitPath(path);
      return new DocumentReference(table, id);
    },
    collection(name) { return new Query(name); },
    batch() { return new WriteBatch(); },
    runTransaction(body) { return runTransaction(body); },
    FieldValue: {
      serverTimestamp() { return SERVER_TIMESTAMP; },
      increment(n) { return { __increment: n }; },
      arrayUnion(...v) { return { __arrayUnion: v }; }
    },
    Timestamp
  };
}
firestore.FieldValue = {
  serverTimestamp() { return SERVER_TIMESTAMP; },
  increment(n) { return { __increment: n }; },
  arrayUnion(...v) { return { __arrayUnion: v }; }
};
firestore.Timestamp = Timestamp;

module.exports = {
  initializeApp() { /* Appwrite authenticates per request with the API key. */ },
  credential: {
    cert(serviceAccount) { return { serviceAccount }; }
  },
  firestore
};
