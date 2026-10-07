// ─── Appwrite Database adapter with a Firestore-compatible API ────────
//
// This site has no build step: every page loads the database layer from the
// bare specifier "firebase/firestore", and the HTML import maps now point
// that specifier at this file. The business logic in js/** therefore stays
// byte-identical to the Firestore version — only this adapter talks to
// Appwrite, which keeps the migration a pure infrastructure change.
//
// Firebase Authentication and Firebase Hosting are untouched; Appwrite is
// reached with the caller's own session, never with an API key (a browser
// must never hold one).
//
// Deliberate, documented deviations from Firestore:
//  * serverTimestamp() uses the writer's clock — Appwrite has no writable
//    server-assigned field we can target.
//  * writeBatch() applies its operations in order rather than atomically;
//    runTransaction() is optimistic instead (see below).
//  * onSnapshot() polls (2.5s document / 4s query) and diffs locally,
//    because an Appwrite realtime channel streams a whole table rather than
//    one query's results.

import { api, executeWrite, APPWRITE_DATABASE_ID } from './appwrite.js';

const DB = APPWRITE_DATABASE_ID;

/** The handle every module passes to collection()/doc()/writeBatch()/… */
export const db = Object.freeze({ __appwrite: true, databaseId: DB });

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const GUESSABLE_JSON_RE = /^\s*[\[{][\s\S]*[\]}]\s*$/;

// Fields that hold free text. They are excluded from the ISO-datetime and
// JSON sniffing below so a message that happens to read like a timestamp or
// an object literal is never silently rewritten on the way out of the DB.
const TEXT_FIELDS = new Set([
  'text', 'title', 'message', 'body', 'email', 'note', 'notes', 'evidenceNote',
  'reason', 'rejectionReason', 'clarificationReason', 'description',
  'instructions', 'userName', 'fullName', 'phone', 'esewaNumber', 'esewaName',
  'endpoint', 'mediaUrl', 'mediaName', 'lastMessage', 'clientRef', 'code',
  'referralCode', 'txId', 'deviceId', 'deviceName', 'name', 'comment'
]);

// Collections whose values are nested objects. Appwrite has no object
// attribute type, so these are stored as JSON strings and decoded here.
const JSON_FIELDS = {
  users: ['stats', 'ban', 'referralStats'],
  referralRiskFlags: ['signals'],
  adminLogs: ['metadata'],
  pushSubscriptions: ['keys'],
  notificationPrefs: ['categories']
};
// Discovered at runtime if a payload nests an object we have not listed.
const JSON_FIELDS_DYNAMIC = new Set();

// ── Timestamp ─────────────────────────────────────────────────────────
export class Timestamp {
  constructor(ms) {
    this._ms = ms;
    this.seconds = Math.floor(ms / 1000);
    this.nanoseconds = (ms % 1000) * 1e6;
  }
  static now() { return new Timestamp(Date.now()); }
  static fromMillis(ms) { return new Timestamp(Number(ms)); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  static fromISO(s) { return new Timestamp(Date.parse(s)); }
  static isTimestamp(v) { return v instanceof Timestamp; }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
  toISOString() { return new Date(this._ms).toISOString(); }
  valueOf() { return this._ms; }
  toJSON() { return this.toISOString(); }
  toString() { return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`; }
  isEqual(other) { return other instanceof Timestamp && other._ms === this._ms; }
}

// ── Field-value sentinels ─────────────────────────────────────────────
const SENT = Symbol('firestore-sentinel');
const serverTimestamp = () => ({ [SENT]: 'now' });
const increment = (n) => ({ [SENT]: 'increment', n: Number(n) || 0 });
const arrayUnion = (...values) => ({ [SENT]: 'arrayUnion', values });
const arrayRemove = (...values) => ({ [SENT]: 'arrayRemove', values });
const deleteField = () => ({ [SENT]: 'deleteField' });
export { serverTimestamp, increment, arrayUnion, arrayRemove, deleteField };

const isSentinel = (v) => !!v && typeof v === 'object' && v[SENT] !== undefined;

/** Values that need a read-before-write: everything except now/delete. */
function needsReadBeforeWrite(payload) {
  for (const key of Object.keys(payload)) {
    if (key.includes('.')) return true;
    const v = payload[key];
    if (isSentinel(v)) {
      const kind = v[SENT];
      if (kind === 'increment' || kind === 'arrayUnion' || kind === 'arrayRemove') return true;
    }
  }
  return false;
}

// ── Query constraints ─────────────────────────────────────────────────
export const where = (field, op, value) => ({ __c: 'where', field, op, value });
export const orderBy = (field, dir = 'asc') => ({ __c: 'orderBy', field, dir });
export const limit = (n) => ({ __c: 'limit', n: Number(n) || 0 });
export const startAfter = (cursor) => ({ __c: 'cursor', cursor, dir: 'after' });
export const endBefore = (cursor) => ({ __c: 'cursor', cursor, dir: 'before' });

// ── Paths ─────────────────────────────────────────────────────────────
//
// Firestore subcollections do not exist in Appwrite, so each one is flattened
// into its own table with a deterministic document id. Reading and writing
// always go through these rules, so a path round-trips: the logical id the
// app stores is turned into the flat id here, and turned back on the way out.
const SUBCOLLECTIONS = [
  {
    reDoc: /^users\/([^/]+)\/private\/pin$/,
    table: 'userPins',
    flat: (m) => m[1]
  },
  {
    reDoc: /^users\/([^/]+)\/notes\/([^/]+)$/,
    reColl: /^users\/([^/]+)\/notes$/,
    table: 'userNotes',
    flat: (m) => `${m[1]}__${m[2]}`,
    logical: (m) => m[2],
    prefix: (m) => m[1],
    inject: (m) => ({ userId: m[1] })
  },
  {
    reDoc: /^referrals\/([^/]+)\/events\/([^/]+)$/,
    reColl: /^referrals\/([^/]+)\/events$/,
    table: 'referralEvents',
    flat: (m) => `${m[1]}__${m[2]}`,
    logical: (m) => m[2],
    prefix: (m) => m[1],
    inject: (m) => ({ referralId: m[1] })
  },
  {
    reDoc: /^conversations\/([^/]+)\/messages\/([^/]+)$/,
    reColl: /^conversations\/([^/]+)\/messages$/,
    table: 'messages',
    flat: (m) => `${m[1]}__${m[2]}`,
    logical: (m) => m[2],
    prefix: (m) => m[1],
    inject: (m) => ({ conversationId: m[1] })
  }
];

// collectionGroup('events') in Firestore searched every subcollection with
// that name; here that is just one flat table.
const COLLECTION_GROUPS = { events: 'referralEvents' };

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function autoId() {
  let out = '';
  for (let i = 0; i < 20; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}

/** Turn a Firestore path into { table, documentId, logical id, injected }. */
function resolvePath(path) {
  for (const rule of SUBCOLLECTIONS) {
    if (rule.reDoc && rule.reDoc.test(path)) {
      const m = path.match(rule.reDoc);
      const logical = rule.flat(m);
      return { table: rule.table, documentId: logical, logical, inject: rule.inject ? rule.inject(m) : {} };
    }
  }
  const segments = path.split('/');
  if (segments.length === 1) {
    // doc(collection(db, 'x')) — the caller wants an id of their own
    const logical = autoId();
    return { table: segments[0], documentId: logical, logical, inject: {} };
  }
  if (segments.length === 2) {
    return { table: segments[0], documentId: segments[1], logical: segments[1], inject: {} };
  }
  for (const rule of SUBCOLLECTIONS) {
    if (rule.reColl && rule.reColl.test(path)) {
      const m = path.match(rule.reColl);
      const logical = autoId();
      return {
        table: rule.table,
        documentId: `${rule.prefix(m)}__${logical}`,
        logical,
        inject: rule.inject ? rule.inject(m) : {}
      };
    }
  }
  throw new Error(`Unsupported document path: ${path}`);
}

function makeRef(path) {
  const r = resolvePath(path);
  return {
    __ref: true,
    path,
    table: r.table,
    documentId: r.documentId,
    id: r.logical,
    inject: r.inject || {}
  };
}

export function collection(target, ...segments) {
  const base = target && (target.__coll || target.__ref) ? target.path : '';
  const path = [base, ...segments].filter(Boolean).join('/');
  return { __coll: true, path };
}

export function collectionGroup(_db, name) {
  return { __cg: true, group: name };
}

export function doc(target, ...segments) {
  const base = target && (target.__coll || target.__ref) ? target.path : '';
  const path = [base, ...segments].filter((s) => s !== undefined && s !== null && s !== '').join('/');
  if (!path) throw new Error('doc() needs a path');
  return makeRef(path);
}

export function query(base, ...parts) {
  let path = null;
  let group = null;
  const constraints = [];
  if (base && base.__coll) path = base.path;
  else if (base && base.__cg) group = base.group;
  else if (base && base.__q) {
    path = base.path;
    group = base.group;
    constraints.push(...base.constraints);
  } else if (base && base.__ref) {
    path = base.path.split('/').slice(0, -1).join('/');
    constraints.push(...parts);
    return { __q: true, path, group: null, constraints };
  } else {
    throw new Error('query() needs a collection, group or query');
  }
  for (const p of parts) constraints.push(p);
  return { __q: true, path, group, constraints };
}

function tableOf(q) {
  if (q.__q) {
    if (q.group) return COLLECTION_GROUPS[q.group] || q.group;
    return resolvePath(q.path).table;
  }
  if (q.__coll) return resolvePath(q.path).table;
  if (q.__cg) return COLLECTION_GROUPS[q.group] || q.group;
  if (q.__ref) return q.table;
  throw new Error('Not a collection or query');
}

function toQuery(target) {
  if (target.__q) return target;
  if (target.__coll) return { __q: true, path: target.path, group: null, constraints: [] };
  if (target.__cg) return { __q: true, path: null, group: target.group, constraints: [] };
  if (target.__ref) return { __q: true, path: target.path.split('/').slice(0, -1).join('/'), group: null, constraints: [] };
  throw new Error('Expected a collection, group or query');
}

// ── Wire encoding ─────────────────────────────────────────────────────
function isJsonField(table, field) {
  const list = JSON_FIELDS[table];
  if (list && list.includes(field)) return true;
  return JSON_FIELDS_DYNAMIC.has(`${table}.${field}`);
}

function rememberJsonField(table, field) {
  JSON_FIELDS_DYNAMIC.add(`${table}.${field}`);
}

function encodeValue(table, field, value) {
  if (value === undefined) return undefined;
  if (isSentinel(value)) {
    switch (value[SENT]) {
      case 'now': return new Date().toISOString();
      case 'deleteField': return null;
      // Without a read we cannot add to an existing value; used only where a
      // document is being created, in which case the base is zero/empty.
      case 'increment': return value.n;
      case 'arrayUnion': return value.values;
      case 'arrayRemove': return [];
      default: return null;
    }
  }
  if (value === null) return null;
  if (value instanceof Timestamp) return value.toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.some((v) => v && typeof v === 'object' && !(v instanceof Date))) {
      rememberJsonField(table, field);
      return JSON.stringify(value);
    }
    return value.map((v) => encodeValue(table, field, v));
  }
  if (typeof value === 'object') {
    rememberJsonField(table, field);
    return JSON.stringify(value);
  }
  return value;
}

function encodeData(table, data) {
  const out = {};
  for (const key of Object.keys(data)) {
    if (key.charCodeAt(0) === 36) continue; // never write $id/$createdAt/…
    const encoded = encodeValue(table, key, data[key]);
    if (encoded !== undefined) out[key] = encoded;
  }
  return out;
}

function decodeValue(table, field, value) {
  if (typeof value !== 'string') return value;
  if (!TEXT_FIELDS.has(field) && ISO_RE.test(value)) return Timestamp.fromISO(value);
  if ((isJsonField(table, field) || (GUESSABLE_JSON_RE.test(value) && !TEXT_FIELDS.has(field)))) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* not JSON after all */ }
  }
  return value;
}

function decodeData(table, raw) {
  const out = {};
  for (const key of Object.keys(raw)) {
    if (key.charCodeAt(0) === 36) continue;
    out[key] = decodeValue(table, key, raw[key]);
  }
  return out;
}

// ── Read-modify-write for nested paths and increments ─────────────────
function currentAt(container, key) {
  if (container && typeof container === 'object') return container[key];
  return undefined;
}

function resolveAgainstCurrent(table, field, current, value) {
  if (!isSentinel(value)) return encodeValue(table, field, value);
  switch (value[SENT]) {
    case 'now': return new Date().toISOString();
    case 'deleteField': return null;
    case 'increment': return (Number(current) || 0) + value.n;
    case 'arrayUnion': {
      const base = Array.isArray(current) ? current.slice() : [];
      for (const v of value.values) if (!base.some((x) => x === v)) base.push(v);
      return base;
    }
    case 'arrayRemove': {
      const base = Array.isArray(current) ? current.slice() : [];
      return base.filter((x) => !value.values.some((v) => v === x));
    }
    default: return null;
  }
}

function decodeContainer(value) {
  if (typeof value === 'string' && GUESSABLE_JSON_RE.test(value)) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return { value: parsed, wasString: true };
    } catch (_) { /* plain string */ }
  }
  if (value && typeof value === 'object') return { value: Array.isArray(value) ? value.slice() : { ...value }, wasString: false };
  return null;
}

/** Apply a Firestore-style update payload onto a raw Appwrite document. */
function applyUpdate(table, raw, payload) {
  const out = {};
  for (const key of Object.keys(raw)) if (key.charCodeAt(0) !== 36) out[key] = raw[key];

  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (value === undefined) continue;
    if (!key.includes('.')) {
      out[key] = resolveAgainstCurrent(table, key, decodeValue(table, key, out[key]), value);
      continue;
    }
    // Nested path: 'stats.assigned' — Appwrite has no dot-path updates, so
    // the owning object is decoded, mutated and re-encoded.
    const parts = key.split('.');
    const top = parts[0];
    const container = decodeContainer(out[top]) || { value: {}, wasString: isJsonField(table, top) };
    let node = container.value;
    for (let i = 1; i < parts.length - 1; i++) {
      const next = decodeContainer(node[parts[i]]) || { value: {}, wasString: false };
      node[parts[i]] = next.value;
      node = next.value;
    }
    const leaf = parts[parts.length - 1];
    node[leaf] = resolveAgainstCurrent(table, leaf, currentAt(node, leaf), value);
    out[top] = container.wasString || isJsonField(table, top) ? JSON.stringify(container.value) : container.value;
  }
  return out;
}

// ── Permissions ───────────────────────────────────────────────────────
//
// The row- and table-level grants live in js/appwrite-acl.mjs, the single
// counterpart of firestore.rules shared with the provisioning script and the
// write-proxy Function. Only the parts that need the running app are here.

// ── HTTP paths ────────────────────────────────────────────────────────
// The database is a TablesDB, so rows live under /tablesdb/…/tables/…/rows.
const rowsBase = (table) => `/tablesdb/${DB}/tables/${table}/rows`;
const rowUrl = (ref) => `${rowsBase(ref.table)}/${encodeURIComponent(ref.documentId)}`;

// A flattened table can always be turned back into the Firestore path it
// came from, so a document the app reads exposes the same logical id the
// Firestore version did and round-trips through doc().
const FLATTENED_PATH = {
  userPins: (flat) => `users/${flat}/private/pin`,
  userNotes: (flat) => splitFlat(flat, (p, l) => `users/${p}/notes/${l}`),
  referralEvents: (flat) => splitFlat(flat, (p, l) => `referrals/${p}/events/${l}`),
  messages: (flat) => splitFlat(flat, (p, l) => `conversations/${p}/messages/${l}`)
};

function splitFlat(flat, build) {
  const sep = flat.indexOf('__');
  return sep > 0 ? build(flat.slice(0, sep), flat.slice(sep + 2)) : `${flat}`;
}

function refForRow(table, row) {
  const flat = row.$id;
  const build = FLATTENED_PATH[table];
  if (build) return makeRef(build(flat));
  return makeRef(`${table}/${flat}`);
}

// ── Queries ───────────────────────────────────────────────────────────
function wireValue(v) {
  if (v instanceof Timestamp) return v.toISOString();
  if (v instanceof Date) return v.toISOString();
  return v;
}

function queryObjects(constraints) {
  const out = [];
  let total = null;
  let cursor = null;
  for (const c of constraints) {
    switch (c.__c) {
      case 'where': {
        const values = Array.isArray(c.value) ? c.value.map(wireValue) : [wireValue(c.value)];
        const method = {
          '==': 'equal',
          '!=': 'notEqual',
          '<': 'lessThan',
          '<=': 'lessThanEqual',
          '>': 'greaterThan',
          '>=': 'greaterThanEqual',
          'in': 'equal',
          'not-in': 'notEqual',
          'array-contains': 'contains',
          'array-contains-any': 'contains'
        }[c.op];
        if (!method) throw new Error(`Unsupported query operator: ${c.op}`);
        out.push({ method, attribute: c.field, values });
        break;
      }
      case 'orderBy':
        out.push({ method: c.dir === 'desc' ? 'orderDesc' : 'orderAsc', attribute: c.field });
        break;
      case 'limit':
        total = c.n;
        break;
      case 'cursor': {
        const id = c.cursor && c.cursor.ref ? c.cursor.ref.documentId
          : c.cursor && c.cursor.__ref ? c.cursor.documentId : null;
        if (!id) throw new Error('Pagination cursors must be a document snapshot.');
        cursor = { method: c.dir === 'before' ? 'cursorBefore' : 'cursorAfter', values: [id] };
        break;
      }
      default:
        break;
    }
  }
  if (cursor) out.push(cursor);
  return { objects: out, total };
}

// Queries travel as indexed JSON params: queries[0]=<json>, queries[1]=<json>.
// Verified against the server — `queries=` (repeated) is rejected, and the
// column key is `attribute`.
function buildUrl(base, objects, pageSize) {
  const params = objects.map((o, i) => `queries[${i}]=${encodeURIComponent(JSON.stringify(o))}`);
  if (pageSize != null) params.push(`limit=${pageSize}`);
  return params.length ? `${base}?${params.join('&')}` : base;
}

async function listPage(base, objects, pageSize) {
  return api('GET', buildUrl(base, objects, pageSize));
}

function payloadRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.documents)) return payload.documents;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

const PAGE_SIZE = 500;
const MAX_PAGES = 100;

async function fetchDocs(target) {
  const q = toQuery(target);
  const table = tableOf(q);
  const { objects, total } = queryObjects(q.constraints);

  const base = rowsBase(table);
  const rows = [];
  let cursor = objects.find((o) => o.method === 'cursorAfter' || o.method === 'cursorBefore') || null;
  const withoutCursor = objects.filter((o) => o.method !== 'cursorAfter' && o.method !== 'cursorBefore');

  for (let page = 0; page < MAX_PAGES; page++) {
    const pageSize = total != null ? Math.min(PAGE_SIZE, Math.max(total - rows.length, 1)) : PAGE_SIZE;
    const batch = await listPage(base, cursor ? [...withoutCursor, cursor] : withoutCursor, pageSize);
    const got = payloadRows(batch);
    rows.push(...got);
    if (got.length < pageSize) break;
    if (total != null && rows.length >= total) break;
    cursor = { method: 'cursorAfter', values: [got[got.length - 1].$id] };
  }
  return total != null ? rows.slice(0, total) : rows;
}

// ── Snapshots ─────────────────────────────────────────────────────────
function makeDocSnapshot(ref, raw) {
  const base = {
    id: ref.id,
    ref,
    exists: () => !!raw,
    data: () => (raw ? decodeData(ref.table, raw) : undefined)
  };
  Object.defineProperty(base, '__raw', { value: raw, enumerable: false });
  return base;
}

function makeQuerySnapshot(table, rows, previous) {
  const docs = rows.map((row) => makeDocSnapshot(refForRow(table, row), row));
  const before = previous ? new Map(previous.docs.map((d) => [d.ref.documentId, d])) : null;
  const changes = docs.map((doc) => {
    const prior = before ? before.get(doc.ref.documentId) : null;
    if (!prior) return { type: 'added', doc };
    return JSON.stringify(prior.__raw) === JSON.stringify(doc.__raw)
      ? null
      : { type: 'modified', doc };
  }).filter(Boolean);
  if (before) {
    for (const [id, doc] of before) {
      if (!docs.some((d) => d.ref.documentId === id)) changes.push({ type: 'removed', doc });
    }
  }
  const snap = {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (fn) => docs.forEach(fn),
    docChanges: () => changes
  };
  Object.defineProperty(snap, '__raw', { value: rows, enumerable: false });
  return snap;
}

async function readRaw(ref) {
  try {
    return await api('GET', rowUrl(ref));
  } catch (e) {
    if (e.code === 'not-found') return null;
    throw e;
  }
}

export async function getDoc(ref) {
  const raw = await readRaw(ref);
  return makeDocSnapshot(ref, raw);
}

export async function getDocs(target) {
  const q = toQuery(target);
  const rows = await fetchDocs(q);
  const table = tableOf(q);
  return makeQuerySnapshot(table, rows, null);
}

// ── Writes ────────────────────────────────────────────────────────────
//
// Every mutation below goes through executeWrite(), i.e. through the
// Appwrite Function that authenticates the Firebase ID token and applies the
// ported firestore.rules. Appwrite's `create` grant is evaluated against the
// table alone, so no table or row hands a browser a write grant — if it did,
// one user could overwrite another user's rows. The Function therefore
// stamps $permissions itself, and `withPermissions` no longer decides that.
async function createDoc(ref, payload, withPermissions) {
  const data = encodeData(ref.table, payload);
  return executeWrite({ op: 'create', table: ref.table, rowId: ref.documentId, data });
}

async function patchDoc(ref, data) {
  return executeWrite({ op: 'update', table: ref.table, rowId: ref.documentId, data });
}

async function applyWrite(op) {
  const { ref } = op;
  if (op.kind === 'delete') {
    await executeWrite({ op: 'delete', table: ref.table, rowId: ref.documentId, data: {} })
      .catch((e) => { if (e.code !== 'not-found') throw e; });
    return;
  }

  const payload = { ...op.data, ...(ref.inject || {}) };
  const dynamic = needsReadBeforeWrite(payload);

  if (op.kind === 'update') {
    if (dynamic) {
      const raw = await readRaw(ref);
      if (!raw) {
        const e = new Error('Cannot update a document that does not exist.');
        e.code = 'not-found';
        throw e;
      }
      await patchDoc(ref, applyUpdate(ref.table, raw, payload));
      return;
    }
    await patchDoc(ref, payload);
    return;
  }

  // setDoc — read first so a full replace can clear fields it omits, the way
  // Firestore's setDoc() does.
  const raw = await readRaw(ref);
  if (!raw) {
    await createDoc(ref, payload, true);
    return;
  }
  if (op.merge) {
    await patchDoc(ref, dynamic ? applyUpdate(ref.table, raw, payload) : payload);
    return;
  }
  // Full replace: fields the payload omits are cleared, and nested paths
  // ('stats.assigned') count as touching their owning field.
  const touched = new Set(Object.keys(payload).map((k) => k.split('.')[0]));
  const replaced = dynamic ? applyUpdate(ref.table, raw, payload) : encodeData(ref.table, payload);
  for (const key of Object.keys(raw)) {
    if (key.charCodeAt(0) === 36) continue;
    if (!touched.has(key)) replaced[key] = null;
  }
  await patchDoc(ref, replaced);
}

export async function setDoc(ref, data, options) {
  await applyWrite({ kind: 'set', ref, data, merge: !!(options && options.merge) });
}

export async function updateDoc(ref, data) {
  await applyWrite({ kind: 'update', ref, data });
}

export async function deleteDoc(ref) {
  await applyWrite({ kind: 'delete', ref });
}

export async function addDoc(colRef, data) {
  const ref = doc(colRef);
  await applyWrite({ kind: 'set', ref, data, merge: false });
  return ref;
}

// ── Batches ───────────────────────────────────────────────────────────
export function writeBatch() {
  const ops = [];
  const batch = {
    set(ref, data, options) {
      ops.push({ kind: 'set', ref, data, merge: !!(options && options.merge) });
      return batch;
    },
    update(ref, data) {
      ops.push({ kind: 'update', ref, data });
      return batch;
    },
    delete(ref) {
      ops.push({ kind: 'delete', ref });
      return batch;
    },
    async commit() {
      // Not atomic: Firestore's WriteBatch was. Operations are applied in
      // the order they were queued so the outcome is deterministic, and
      // callers that need atomicity use runTransaction() instead.
      for (const op of ops) await applyWrite(op);
    }
  };
  return batch;
}

// ── Transactions ──────────────────────────────────────────────────────
//
// Appwrite has no conditional write primitive, so this is optimistic: the
// function runs against fresh reads, every document it both reads and writes
// is re-checked against $updatedAt immediately before the writes are applied,
// and a changed document restarts the whole function. That is the same
// contract Firestore gives — reads-then-writes with a retry on conflict.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTransaction(_db, fn, options) {
  const maxAttempts = (options && options.maxAttempts) || 5;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reads = new Map();
    const ops = [];
    const keyOf = (ref) => `${ref.table}/${ref.documentId}`;

    const tx = {
      async get(ref) {
        const raw = await readRaw(ref);
        reads.set(keyOf(ref), { ref, rev: raw ? raw.$updatedAt : null });
        return makeDocSnapshot(ref, raw);
      },
      set(ref, data, opts) {
        ops.push({ kind: 'set', ref, data, merge: !!(opts && opts.merge) });
      },
      update(ref, data) {
        ops.push({ kind: 'update', ref, data });
      },
      delete(ref) {
        ops.push({ kind: 'delete', ref });
      }
    };

    const result = await fn(tx);
    if (!ops.length) return result;

    // Verify only the documents that were both read and written: those are
    // the read-modify-write cycles a concurrent writer could have spoiled.
    const written = new Set(ops.map((op) => keyOf(op.ref)));
    let conflicted = false;
    for (const [key, seen] of reads) {
      if (!written.has(key)) continue;
      const latest = await readRaw(seen.ref);
      if ((latest ? latest.$updatedAt : null) !== seen.rev) {
        conflicted = true;
        break;
      }
    }
    if (conflicted) {
      lastError = Object.assign(
        new Error('This record changed while you were working on it. Please try again.'),
        { code: 'failed-precondition' }
      );
      await sleep(40 * attempt + Math.random() * 60);
      continue;
    }

    try {
      for (const op of ops) await applyWrite(op);
      return result;
    } catch (e) {
      if (e.code !== 'resource-exhausted' && e.code !== 'unavailable' && e.code !== 'failed-precondition') throw e;
      lastError = e;
      await sleep(60 * attempt);
    }
  }

  throw lastError || Object.assign(new Error('Could not finish that change. Please try again.'), { code: 'failed-precondition' });
}

// ── Aggregates ────────────────────────────────────────────────────────
//
// Appwrite has no aggregate endpoint, so counts and sums are computed from
// the documents themselves. Both are bounded by MAX_PAGES and by the
// caller's own limit where it set one.
export function sum(field) {
  return { __sum: field };
}

async function collect(target) {
  const q = toQuery(target);
  const { total } = queryObjects(q.constraints);
  const rows = await fetchDocs(q);
  return { table: tableOf(q), rows, capped: total != null };
}

export async function getCountFromServer(target) {
  const { rows } = await collect(target);
  return { data: () => ({ count: rows.length }) };
}

export async function getAggregateFromServer(target, aggregates) {
  const { rows, table } = await collect(target);
  const out = {};
  for (const [name, agg] of Object.entries(aggregates || {})) {
    if (agg && agg.__sum) {
      out[name] = rows.reduce((total, row) => {
        const value = decodeValue(table, agg.__sum, row[agg.__sum]);
        return total + (Number(value) || 0);
      }, 0);
    } else {
      out[name] = 0;
    }
  }
  return { data: () => out };
}

// ── Live listeners ────────────────────────────────────────────────────
//
// Firestore streamed only the documents matching a query. Appwrite streams a
// whole table, so a listener re-runs its own query on a timer and reports
// only what actually changed — including the docChanges() shell.js uses to
// decide which notifications deserve a popup.
const DOC_POLL_MS = 2500;
const QUERY_POLL_MS = 4000;

export function onSnapshot(target, onNext, onError) {
  const isDocument = !!(target && target.__ref);
  let stopped = false;
  let prevKey = null;
  let prevSnap = null;
  let inFlight = false;
  let timer = null;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      if (isDocument) {
        const raw = await readRaw(target);
        const key = JSON.stringify(raw || null);
        if (key !== prevKey) {
          prevKey = key;
          if (!stopped) onNext(makeDocSnapshot(target, raw));
        }
      } else {
        const q = toQuery(target);
        const table = tableOf(q);
        const rows = await fetchDocs(q);
        const key = rows.map((r) => `${r.$id}:${JSON.stringify(r)}`).join('|');
        if (key !== prevKey) {
          const snap = makeQuerySnapshot(table, rows, prevSnap);
          prevKey = key;
          prevSnap = snap;
          if (!stopped) onNext(snap);
        }
      }
    } catch (e) {
      if (!stopped && onError) onError(e);
    } finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(tick, isDocument ? DOC_POLL_MS : QUERY_POLL_MS);
    }
  };

  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
