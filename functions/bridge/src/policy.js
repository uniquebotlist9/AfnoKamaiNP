'use strict';

// ─── firestore.rules, ported to JavaScript ──────────────────────────────
//
// The Appwrite write-proxy is the only thing standing between a browser and
// a row write, so it has to reproduce what firestore.rules enforced on
// every write path. This file is that port: one POLICY entry per collection
// with `create` / `update` / `delete` validators that mirror the matching
// `allow` clause.
//
// Contract
//   checkWrite({ table, op, rowId, data, current, ctx }) -> null when the
//   write is permitted, or a human-readable denial reason.
//
//   ctx = { uid, email, verified, admin, read(table,rowId), notBanned(),
//           effect(op) }   — `read` is the proxy's cached row reader, and
//   `effect` queues a follow-up row write the proxy performs server-side
//   (used to advance the chat pacing stamp, which firestore.rules kept in
//   the same atomic batch).
//
// Fidelity notes
//   * `changedKeys()` is computed by the caller against the stored row, so
//     the payloads here are the *changed* subset, not the whole document.
//   * Firestore rules evaluate `request.resource.data` — the document as it
//     will be — so branch checks use `merged` (current ∪ incoming).
//   * `get(...)` reads that happened-before the write in the same batch are
//     satisfied because the adapter applies batches in order.

const CODE_RE = /^AFK-[A-HJ-NP-Z2-9]{8}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FULLNAME_RE = /[A-Za-z][A-Za-z .-]{1,59}/;
const PHONE_RE = /(9[678][0-9]{8}|0?1[0-9]{7}|0?[2-7][0-9]{7})/;
const ESEWA_RE = /9[678][0-9]{8}/;
const MEDIA_RE = /^data:(image\/[a-zA-Z0-9.+-]+|application\/[a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=]+$/;
const SEC_ID_RE = /^sec_(password_changed|pin_changed|new_device|login_alert)_[A-Za-z0-9_-]{1,140}$/;

// Mirrors validReferralHandle()'s reserved words (js/referral.js keeps the
// same list client-side).
const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'admins', 'support', 'help', 'helpcenter', 'contact',
  'login', 'signin', 'signup', 'register', 'dashboard', 'settings', 'profile',
  'referral', 'referrals', 'invite', 'invites', 'reward', 'rewards', 'promo', 'promos',
  'api', 'system', 'official', 'afnokamai', 'www', 'mail', 'email', 'root',
  'staff', 'moderator', 'mod', 'superuser', 'billing', 'payments', 'pay', 'wallet',
  'withdraw', 'earn', 'tasks', 'task', 'chat', 'security', 'auth', 'account', 'accounts',
  'me', 'about', 'blog', 'news', 'legal', 'privacy', 'terms', 'status',
  'dev', 'debug', 'test', 'staging', 'index', 'home', 'static', 'assets', 'public',
  'files', 'docs', 'guide', 'faq', 'press', 'careers', 'jobs', 'partners', 'affiliates'
]);

/** Collections where every operation is admin-only in firestore.rules. */
const ADMIN_ONLY = new Set([
  'userNotes', 'tasks', 'transactions', 'penalties', 'referralRewards',
  'referralRiskFlags', 'announcements', 'config', 'adminLogs', 'stats',
  'riskFlags', 'notificationLog'
]);

/**
 * Operations firestore.rules denies to EVERYONE (`allow …: if false`),
 * checked before the admin bypass.
 */
const NEVER = {
  users: ['delete'],
  userPins: ['delete'],
  wallets: ['delete'],
  activeWithdrawals: ['update'],
  withdrawals: ['delete'],
  referralCodes: ['update', 'delete'],
  referralHandles: ['update'],
  notificationPrefs: ['delete'],
  conversations: ['delete'],
  adminLogs: ['update', 'delete'],
  notificationLog: ['create', 'update', 'delete']
};

// ── Small helpers ──────────────────────────────────────────────────────
const isStr = (v) => typeof v === 'string';

/** `hasOnly([...])`: no field outside the allow-list may be *affected*. */
function keysOnly(data, allowed) {
  const extra = Object.keys(data).filter((k) => !allowed.includes(k));
  return extra.length ? `unexpected field(s): ${extra.join(', ')}` : null;
}

/** Decode a value the adapter may have stored as a JSON string. */
function asJson(v) {
  if (typeof v !== 'string') return v;
  if (v.charAt(0) !== '[' && v.charAt(0) !== '{') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

const norm = (v) => (v === undefined ? null : v);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/**
 * Firestore's `changedKeys()`, adapted for a partial payload.
 *
 * Firestore rules always see the WHOLE resulting document, so its changedKeys
 * simply compares document to document. The adapter patches, so the payload
 * only carries the fields the caller actually set — a field that is absent
 * from the payload is one that keeps its current value and therefore has NOT
 * changed. Comparing absent-to-present would report every untouched column as
 * a mutation and make every legitimate update look like a rewrite.
 */
function changedKeys(current, incoming) {
  const out = [];
  const cur = current || {};
  const data = incoming || {};
  for (const k of Object.keys(data)) {
    if (k.charCodeAt(0) === 36) continue; // $id / $createdAt are not data
    if (!same(cur[k], data[k])) out.push(k);
  }
  return out;
}

/** `createdAt == request.time` and friends — client clock within tolerance. */
function nearNow(v, windowMs) {
  const t = Date.parse(typeof v === 'string' ? v : '');
  return Number.isFinite(t) && Math.abs(Date.now() - t) <= (windowMs || 600000);
}

const validCode = (c) => isStr(c) && CODE_RE.test(c);

// ── Row id compaction ─────────────────────────────────────────────────
// The client adapter (js/appwrite-db.js) maps Firestore-era logical ids
// longer than Appwrite's 36-char rowId limit onto deterministic compact ids.
// This must be the SAME function so a rule can recompute the row id a
// client should have used from the data it is validating. Ids that are
// already valid row ids pass through untouched.
const ROWID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

function compactHash(id) {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
    h3 = Math.imul(h3 ^ (c + i), 2246822519) >>> 0;
  }
  return [h1, h2, h3].map((h) => h.toString(16).padStart(8, '0')).join('');
}

function rowIdOf(logical) {
  const id = String(logical || '');
  return ROWID_RE.test(id) ? id : 'k' + compactHash(id);
}

async function validHandle(h, ctx) {
  if (!isStr(h) || h.length < 3 || h.length > 30 || !HANDLE_RE.test(h)) return false;
  if (RESERVED_HANDLES.has(h)) return false;
  const row = await ctx.read('referralHandles', h);
  // getAfter(referralHandles/{h}).userId == uid — the mapping must exist and
  // belong to the caller, or anyone could claim a handle nobody has taken.
  return !!row && row.userId === ctx.uid;
}

/** Branch combinator: the changed set must be a non-empty subset. */
const onlyChanged = (ch, allowed) => ch.length > 0 && ch.every((k) => allowed.includes(k));

// ── Per-collection policy ──────────────────────────────────────────────
const POLICY = {};

// ── users ──────────────────────────────────────────────────────────────
const USER_FIELDS = [
  'uid', 'email', 'emailVerified', 'fullName', 'phone', 'role', 'status',
  'profileComplete', 'pinSetAt', 'pinSalt', 'createdAt', 'lastActiveAt', 'stats',
  'referralCode', 'referralHandle', 'referralCodeSetAt',
  'referredBy', 'referredByCode', 'referralJoinedAt'
];
const USER_STATS_ZERO = ['assigned', 'approved', 'rejected', 'earnedPaisa', 'withdrawnPaisa', 'penaltiesPaisa'];

POLICY.users = {
  async create(d, rowId, ctx) {
    let e = keysOnly(d, USER_FIELDS); if (e) return e;
    if (rowId !== ctx.uid || d.uid !== ctx.uid) return 'a user document is bound to the caller';
    if (!isStr(d.email) || d.email.toLowerCase() !== String(ctx.email || '').toLowerCase()) {
      return 'email must match the verified token';
    }
    if (d.emailVerified !== false) return 'emailVerified must start false';
    if (d.role !== 'user' || d.status !== 'active' || d.profileComplete !== false) {
      return 'role/status/profileComplete must start at their defaults';
    }
    if (d.fullName !== '' || d.phone !== '') return 'fullName/phone must start empty';
    if ((d.referredBy || '') !== '' || (d.referredByCode || '') !== '') {
      return 'referral attribution must start empty';
    }
    if ((d.referralHandle || '') !== '') return 'referralHandle must start empty';
    const stats = asJson(d.stats) || {};
    for (const k of USER_STATS_ZERO) {
      if ((stats[k] === undefined ? 0 : stats[k]) !== 0) return `stats.${k} must start at 0`;
    }
    const code = d.referralCode || '';
    if (code !== '') {
      if (!validCode(code)) return 'malformed referral code';
      // Absent is fine — signup creates the mapping later in the SAME batch,
      // and pass 1 of the proxy already folds that into what we read here.
      // Present-and-mine is fine. Present-and-yours is the attack.
      const row = await ctx.read('referralCodes', code);
      if (row && row.userId !== ctx.uid) return 'that referral code belongs to another account';
    }
    return null;
  },

  async update(d, cur, rowId, ctx) {
    if (rowId !== ctx.uid) return 'not your user document';
    if (!(await ctx.notBanned())) return 'account is not active';

    const ch = changedKeys(cur, d);
    if (!ch.length) return null; // nothing moved — Firestore allows no-op writes
    const merged = Object.assign({}, cur, d);
    const chOnly = (list) => onlyChanged(ch, list);

    // 1) complete onboarding (name/phone, exactly once)
    if (!cur.profileComplete && chOnly(['fullName', 'phone', 'profileComplete'])
      && merged.profileComplete === true
      && isStr(merged.fullName) && FULLNAME_RE.test(merged.fullName)
      && isStr(merged.phone) && PHONE_RE.test(merged.phone)) return null;

    // 2) refresh lastActiveAt
    if (chOnly(['lastActiveAt'])) return null;

    // 3) flip emailVerified false -> true, only with a verified token
    if (chOnly(['emailVerified']) && cur.emailVerified === false
      && merged.emailVerified === true && ctx.verified) return null;

    // 4) PIN salt / setAt metadata
    if (chOnly(['pinSalt', 'pinSetAt'])) return null;

    // 5) claim the referral identity once
    if (chOnly(['referralCode', 'referralHandle', 'referralCodeSetAt'])
      && !cur.referralCode
      && (merged.referredBy || '') === (cur.referredBy || '')
      && validCode(merged.referralCode)
      && isStr(merged.referralHandle || '')
      && ((merged.referralHandle || '') === '' || await validHandle(merged.referralHandle, ctx))) {
      const row = await ctx.read('referralCodes', merged.referralCode);
      if (row && row.userId === ctx.uid) return null;
    }

    // 6) change the vanity handle (code and ownership stay put)
    if (chOnly(['referralHandle']) && cur.referralCode
      && isStr(merged.referralHandle || '')
      && ((merged.referralHandle || '') === '' || await validHandle(merged.referralHandle, ctx))) {
      return null;
    }

    // 7) referral attribution applied once at the end of signup
    if (chOnly(['referredBy', 'referredByCode', 'referralJoinedAt'])
      && !cur.referredBy
      && isStr(merged.referredBy) && merged.referredBy && merged.referredBy !== ctx.uid
      && validCode(merged.referredByCode)) {
      const row = await ctx.read('referrals', rowIdOf(`${merged.referredBy}_${ctx.uid}`));
      if (row && row.referredUserId === ctx.uid) return null;
    }

    return 'that field change is not allowed on your profile';
  }
};

// ── users/{uid}/private/pin  →  userPins (id is the uid) ───────────────
POLICY.userPins = {
  async create(d, rowId, ctx) {
    if (rowId !== ctx.uid) return 'not your PIN record';
    return pinFields(d);
  },
  async update(d, cur, rowId, ctx) {
    if (rowId !== ctx.uid) return 'not your PIN record';
    return pinFields(d);
  }
};
function pinFields(d) {
  let e = keysOnly(d, ['pinHash', 'pinAlgo', 'pinIterations']); if (e) return e;
  if (!isStr(d.pinHash) || d.pinHash.length < 40 || d.pinHash.length > 128) return 'pinHash out of range';
  if (d.pinAlgo !== 'PBKDF2-SHA256') return 'unsupported PIN algorithm';
  if (!Number.isInteger(d.pinIterations) || d.pinIterations < 100000 || d.pinIterations > 200000) {
    return 'pinIterations out of range';
  }
  return null;
}

// ── wallets ────────────────────────────────────────────────────────────
POLICY.wallets = {
  async create(d, rowId, ctx) {
    if (rowId !== ctx.uid) return 'not your wallet';
    const e = keysOnly(d, ['availablePaisa', 'holdPaisa', 'earnedPaisa', 'withdrawnPaisa', 'updatedAt']);
    if (e) return e;
    for (const k of ['availablePaisa', 'holdPaisa', 'earnedPaisa', 'withdrawnPaisa']) {
      if ((d[k] === undefined ? 0 : d[k]) !== 0) return `a new wallet must start with ${k} at 0`;
    }
    return null;
  }
  // update: admin only   delete: never
};

// ── taskAssignments ────────────────────────────────────────────────────
const ASSIGNMENT_FIELDS = [
  'taskId', 'title', 'description', 'instructions', 'category', 'difficulty',
  'estimatedMinutes', 'rewardPaisa', 'slotsTotal', 'deadline', 'evidenceRequired',
  'priority', 'userId', 'userName', 'userEmail', 'status', 'note', 'evidenceNote',
  'requestedAt', 'assignedAt', 'submittedAt', 'reviewedAt', 'reviewedBy',
  'reviewedByName', 'holdUntil', 'rejectionReason', 'clarificationReason', 'isHistory'
];
POLICY.taskAssignments = {
  async create(d, rowId, ctx) {
    if (d.isHistory === true) return 'history rows are written by admins';
    if (d.userId !== ctx.uid) return 'an assignment is bound to the worker';
    if (rowId !== rowIdOf(`${ctx.uid}_${d.taskId}`)) return 'document id must be <uid>_<taskId>';
    if (!ctx.verified) return 'verify your email first';
    if (!(await ctx.notBanned())) return 'account is not active';
    let e = keysOnly(d, ASSIGNMENT_FIELDS); if (e) return e;
    if (d.status !== 'requested') return 'a new assignment must be requested';
    if (d.note !== '' || d.evidenceNote !== '') return 'notes must start empty';
    if (d.reviewedAt !== null && d.reviewedAt !== undefined) return 'reviewedAt must start null';
    if (!Number.isInteger(d.rewardPaisa) || d.rewardPaisa <= 0 || d.rewardPaisa > 10000000) {
      return 'reward out of range';
    }
    const task = await ctx.read('tasks', d.taskId);
    if (!task) return 'task not found';
    if (task.status !== 'published') return 'task is not open';
    if (task.rewardPaisa !== d.rewardPaisa || task.title !== d.title) {
      return 'assignment snapshot does not match the task';
    }
    return null;
  },
  async update(d, cur, rowId, ctx) {
    if (cur.userId !== ctx.uid) return 'not your assignment';
    if (!['assigned', 'clarification'].includes(cur.status)) return 'this assignment cannot be submitted';
    if (!(await ctx.notBanned())) return 'account is not active';
    const ch = changedKeys(cur, d);
    if (!ch.length) return null;
    if (!onlyChanged(ch, ['status', 'submittedAt', 'note', 'evidenceNote'])) {
      return 'only the submission fields may change';
    }
    const merged = Object.assign({}, cur, d);
    if (merged.status !== 'submitted') return 'status must move to submitted';
    if (!isStr(merged.note) || merged.note.length > 1000) return 'note too long';
    if (!isStr(merged.evidenceNote) || merged.evidenceNote.length > 1000) return 'evidenceNote too long';
    return null;
  }
  // delete: admin only
};

// ── activeWithdrawals (id is the uid — the concurrency lock) ───────────
POLICY.activeWithdrawals = {
  async create(d, rowId, ctx) {
    if (rowId !== ctx.uid) return 'the withdrawal lock is bound to the caller';
    if (!ctx.verified) return 'verify your email first';
    if (!(await ctx.notBanned())) return 'account is not active';
    const e = keysOnly(d, ['withdrawalId', 'amountPaisa', 'createdAt']); if (e) return e;
    if (!isStr(d.withdrawalId) || !d.withdrawalId) return 'withdrawalId required';
    if (!Number.isInteger(d.amountPaisa) || d.amountPaisa <= 0) return 'amountPaisa must be a positive integer';
    return null;
  }
  // update: never   delete: admin only
};

// ── withdrawals ────────────────────────────────────────────────────────
const WITHDRAWAL_FIELDS = [
  'userId', 'userName', 'userEmail', 'amountPaisa', 'esewaName', 'esewaNumber',
  'status', 'pinProof', 'pinProofAlgo', 'pinIterations', 'pinSaltUsed',
  'requestedAt', 'reviewedAt', 'reviewedBy', 'reviewedByName', 'reason', 'txId'
];
POLICY.withdrawals = {
  async create(d, rowId, ctx) {
    if (d.userId !== ctx.uid) return 'a withdrawal request is bound to the caller';
    if (!ctx.verified) return 'verify your email first';
    if (!(await ctx.notBanned())) return 'account is not active';
    let e = keysOnly(d, WITHDRAWAL_FIELDS); if (e) return e;
    if (d.status !== 'pending') return 'a new withdrawal must be pending';
    if (!Number.isInteger(d.amountPaisa) || d.amountPaisa < 10000 || d.amountPaisa > 50000000) {
      return 'amount out of range';
    }
    if (!isStr(d.esewaName) || d.esewaName.length < 3 || d.esewaName.length > 60) return 'esewaName out of range';
    if (!isStr(d.esewaNumber) || !ESEWA_RE.test(d.esewaNumber)) return 'esewaNumber must be a Nepali number';
    if (!isStr(d.pinProof) || d.pinProof.length < 40 || d.pinProof.length > 128) return 'pinProof out of range';
    if (d.pinProofAlgo !== 'PBKDF2-SHA256') return 'unsupported PIN algorithm';
    if (!Number.isInteger(d.pinIterations)) return 'pinIterations must be an integer';
    if (d.txId !== '' || d.reason !== '') return 'txId/reason must start empty';
    return null;
  }
  // update: admin only   delete: never
};

// ── referralCodes / referralHandles ────────────────────────────────────
POLICY.referralCodes = {
  async create(d, rowId, ctx) {
    const e = keysOnly(d, ['code', 'userId', 'createdAt']); if (e) return e;
    if (d.code !== rowId || !validCode(rowId)) return 'document id must be the code itself';
    if (d.userId !== ctx.uid) return 'you may only issue your own code';
    return null;
  }
};

POLICY.referralHandles = {
  async create(d, rowId, ctx) {
    const e = keysOnly(d, ['handle', 'userId', 'code', 'createdAt']); if (e) return e;
    if (d.handle !== rowId) return 'document id must be the handle itself';
    if (d.userId !== ctx.uid) return 'you may only claim your own handle';
    if (!validCode(d.code)) return 'malformed referral code';
    const code = await ctx.read('referralCodes', d.code);
    if (!code || code.userId !== ctx.uid) return 'that referral code is not yours';
    return null;
  },
  async delete(cur, rowId, ctx) {
    if (cur.userId !== ctx.uid) return 'not your handle';
    return null;
  }
};

// ── referrals + events ─────────────────────────────────────────────────
const REFERRAL_FIELDS = [
  'referrerId', 'referredUserId', 'referredName', 'referralCode', 'status',
  'approvedTaskCount', 'totalEarnedPaisa', 'milestoneReached',
  'milestoneRewardTransactionId', 'rewardsSuspended', 'underReview',
  'deviceSig', 'createdAt', 'lastRewardAt', 'lastCountedAt'
];
POLICY.referrals = {
  async create(d, rowId, ctx) {
    if (!ctx.verified) return 'verify your email first';
    if (!(await ctx.notBanned())) return 'account is not active';
    let e = keysOnly(d, REFERRAL_FIELDS); if (e) return e;
    if (rowId !== rowIdOf(`${d.referrerId}_${ctx.uid}`)) return 'document id must be <referrer>_<referred>';
    if (!isStr(d.referrerId) || !d.referrerId) return 'referrerId required';
    if (d.referrerId === ctx.uid) return 'you cannot refer yourself';
    if (d.referredUserId !== ctx.uid) return 'the referred user must be you';
    if (!isStr(d.referredName) || d.referredName.length > 60) return 'referredName out of range';
    if (!validCode(d.referralCode)) return 'malformed referral code';
    const code = await ctx.read('referralCodes', d.referralCode);
    if (!code || code.userId !== d.referrerId) return 'code does not map to that referrer';
    if (d.status !== 'joined') return 'a new referral must be joined';
    if (d.approvedTaskCount !== 0 || d.totalEarnedPaisa !== 0) return 'counters must start at 0';
    if (d.milestoneReached !== false || d.rewardsSuspended !== false || d.underReview !== false) {
      return 'review flags must start false';
    }
    if (d.milestoneRewardTransactionId !== null && d.milestoneRewardTransactionId !== undefined) {
      return 'milestoneRewardTransactionId must start null';
    }
    if (!isStr(d.deviceSig) || d.deviceSig.length > 128) return 'deviceSig out of range';
    if (!nearNow(d.createdAt)) return 'createdAt must be the server time of this write';
    return null;
  }
  // update / delete: admin only
};

const REFERRAL_EVENT_FIELDS = [
  'referrerId', 'referredUserId', 'type', 'title', 'amountPaisa', 'taskId',
  'createdAt', 'referralId' // referralId is injected by the adapter
];
POLICY.referralEvents = {
  async create(d, rowId, ctx) {
    // The parent referral is named by DATA (the adapter injects referralId
    // on every write); a compacted row id has no splittable structure.
    const referralId = isStr(d.referralId) ? d.referralId : '';
    if (!referralId || referralId !== `${d.referrerId || ''}_${d.referredUserId || ''}`) {
      return 'the event must match its referral relationship';
    }
    if (rowId !== rowIdOf(`${referralId}__joined`)) return 'only the joined event is user-writable';
    if (!ctx.verified) return 'verify your email first';
    let e = keysOnly(d, REFERRAL_EVENT_FIELDS); if (e) return e;
    const ref = await ctx.read('referrals', rowIdOf(referralId));
    if (!ref || ref.referredUserId !== ctx.uid) return 'no referral relationship for this event';
    if (!isStr(d.referrerId) || !d.referrerId) return 'referrerId required';
    if (d.type !== 'joined') return 'type must be joined';
    if (!isStr(d.title) || d.title.length > 160) return 'title out of range';
    if (d.amountPaisa !== 0 || d.taskId !== '') return 'a joined event carries no money';
    if (!nearNow(d.createdAt)) return 'createdAt must be the server time of this write';
    return null;
  }
  // further events, update and delete: admin only
};

// ── notifications ──────────────────────────────────────────────────────
const NOTIF_FIELDS = [
  'userId', 'audience', 'type', 'category', 'eventId', 'pushState',
  'title', 'body', 'link', 'tone', 'icon', 'searchText', 'read', 'createdAt'
];
const SECURITY_TYPES = new Set(['password_changed', 'pin_changed', 'new_device', 'login_alert']);

POLICY.notifications = {
  async create(d, rowId, ctx) {
    let e = keysOnly(d, NOTIF_FIELDS); if (e) return e;
    if (d.audience !== 'user') return 'audience must be user';
    if (!isStr(d.title) || d.title.length > 140) return 'title out of range';
    if (!isStr(d.body) || d.body.length > 600) return 'body out of range';
    if (d.read !== false) return 'a new notification starts unread';
    if (d.pushState !== 'queued') return 'pushState must start queued';
    if (d.searchText !== undefined && (!isStr(d.searchText) || d.searchText.length > 400)) {
      return 'searchText out of range';
    }
    if (d.link !== undefined && (!isStr(d.link) || d.link.length > 300)) return 'link out of range';
    if (d.icon !== undefined && (!isStr(d.icon) || d.icon.length > 30)) return 'icon out of range';
    if (d.tone !== undefined && (!isStr(d.tone) || d.tone.length > 30)) return 'tone out of range';
    if (!nearNow(d.createdAt)) return 'createdAt must be the server time of this write';

    // (A) the exactly-once referral alert, written by the referred user
    if (d.type === 'referral_joined') {
      if (!isStr(d.userId) || !d.userId || d.userId === ctx.uid) return 'referral alert must address the inviter';
      const logicalId = `referral_joined_${d.userId}_${ctx.uid}`;
      if (rowId !== rowIdOf(logicalId)) return 'deterministic id mismatch';
      if (d.category !== 'referral' || d.eventId !== logicalId) return 'referral alert fields are pinned';
      if (d.link !== 'referral.html') return 'referral alert link is pinned';
      const ref = await ctx.read('referrals', rowIdOf(`${d.userId}_${ctx.uid}`));
      if (!ref || ref.referredUserId !== ctx.uid) return 'no referral relationship for this alert';
      return null;
    }

    // (B) self-only security event
    if (SECURITY_TYPES.has(d.type)) {
      if (d.userId !== ctx.uid) return 'a security alert can only address you';
      if (d.category !== 'security' || !isStr(d.eventId)) return 'security alert fields are pinned';
      if (!SEC_ID_RE.test(d.eventId)) return 'security id must be sec_<type>_<suffix>';
      if (d.eventId.indexOf(`sec_${d.type}_`) !== 0) return 'security id must embed its own type';
      if (rowId !== rowIdOf(d.eventId)) return 'deterministic id mismatch';
      return null;
    }

    return 'users may only write referral and security notifications';
  },

  async update(d, cur, rowId, ctx) {
    if (cur.userId !== ctx.uid) return 'not your notification';
    const ch = changedKeys(cur, d);
    if (!ch.length) return null;
    if (!onlyChanged(ch, ['read', 'readAt'])) return 'only read state may change';
    return null;
  },

  async delete(cur, rowId, ctx) {
    if (cur.userId !== ctx.uid) return 'not your notification';
    return null;
  }
};

// ── pushSubscriptions ──────────────────────────────────────────────────
const PUSH_FIELDS = [
  'userId', 'deviceId', 'endpoint', 'keys', 'platform', 'browser',
  'deviceName', 'isActive', 'permissionStatus', 'failCount',
  'lastUsedAt', 'createdAt', 'updatedAt'
];
POLICY.pushSubscriptions = {
  async create(d, rowId, ctx) {
    let e = keysOnly(d, PUSH_FIELDS); if (e) return e;
    if (!isStr(d.deviceId) || d.deviceId.length < 8 || d.deviceId.length > 64) return 'deviceId out of range';
    if (rowId !== rowIdOf(`${ctx.uid}_${d.deviceId}`)) return 'document id must be <uid>_<deviceId>';
    if (d.userId !== ctx.uid) return 'a subscription is bound to the caller';
    if (!isStr(d.endpoint) || !d.endpoint.length || d.endpoint.length > 2048) return 'endpoint out of range';
    if (d.endpoint.slice(0, 8) !== 'https://') return 'push endpoints must be https';
    const keys = asJson(d.keys);
    if (!keys || typeof keys !== 'object') return 'push keys must be an object';
    if (!isStr(keys.p256dh) || !keys.p256dh) return 'p256dh key required';
    if (!isStr(keys.auth) || !keys.auth) return 'auth key required';
    if (d.deviceName !== undefined && (!isStr(d.deviceName) || d.deviceName.length > 80)) {
      return 'deviceName out of range';
    }
    if (d.isActive !== true || d.failCount !== 0) return 'a new subscription starts active and clean';
    if (!nearNow(d.createdAt)) return 'createdAt must be the server time of this write';
    return null;
  },
  async update(d, cur, rowId, ctx) {
    if (cur.userId !== ctx.uid) return 'not your subscription';
    const ch = changedKeys(cur, d);
    if (!ch.length) return null;
    if (!onlyChanged(ch, ['isActive', 'deviceName', 'permissionStatus', 'lastUsedAt', 'updatedAt'])) {
      return 'only your own switch and bookkeeping may change';
    }
    const merged = Object.assign({}, cur, d);
    if (merged.userId !== cur.userId || merged.endpoint !== cur.endpoint) {
      return 'identity and endpoint are immutable';
    }
    return null;
  },
  async delete(cur, rowId, ctx) {
    if (cur.userId !== ctx.uid) return 'not your subscription';
    return null;
  }
};

// ── notificationPrefs (id is the uid) ──────────────────────────────────
POLICY.notificationPrefs = {
  async create(d, rowId, ctx) {
    if (rowId !== ctx.uid) return 'not your preferences';
    return prefs(d);
  },
  async update(d, cur, rowId, ctx) {
    if (rowId !== ctx.uid) return 'not your preferences';
    return prefs(d);
  }
};
function prefs(d) {
  const e = keysOnly(d, ['push', 'categories', 'updatedAt']); if (e) return e;
  if (typeof d.push !== 'boolean') return 'push must be a boolean';
  if (!nearNow(d.updatedAt)) return 'updatedAt must be the server time of this write';
  return null;
}

// ── conversations (id is the uid) ──────────────────────────────────────
// userName/userEmail: chat.js and api.js's bumpAdminUnread both stamp them
// on create; the columns exist in the table, and admins search on them.
const CONV_CREATE_FIELDS = [
  'participants', 'userId', 'userName', 'userEmail', 'unreadForAdmin',
  'unreadForUser', 'userTyping', 'userTypingAt', 'userLastReadAt',
  'adminTyping', 'adminTypingAt', 'adminLastReadAt', 'lastMessage',
  'lastMessageAt', 'lastSenderId', 'lastSenderRole', 'lastType',
  'createdAt', 'updatedAt'
];
const CONV_UPDATE_FIELDS = [
  'userTyping', 'userTypingAt', 'unreadForUser', 'userLastReadAt',
  'lastMessage', 'lastMessageAt', 'lastSenderId', 'lastSenderRole',
  'lastType', 'unreadForAdmin', 'adminTyping', 'adminTypingAt',
  'unreadForUser', 'adminLastReadAt', 'updatedAt'
];
POLICY.conversations = {
  async create(d, rowId, ctx) {
    if (rowId !== ctx.uid) return 'your conversation is identified by your uid';
    if (!(await ctx.notBanned())) return 'account is not active';
    let e = keysOnly(d, CONV_CREATE_FIELDS); if (e) return e;
    if (!Array.isArray(d.participants) || d.participants.length !== 1 || d.participants[0] !== ctx.uid) {
      return 'you may only open a conversation with yourself';
    }
    if (d.userId !== ctx.uid) return 'the conversation belongs to you';
    if (d.unreadForAdmin !== 0 || d.unreadForUser !== 0) return 'counters must start at 0';
    return null;
  },
  async update(d, cur, rowId, ctx) {
    if (rowId !== ctx.uid) return 'not your conversation';
    if (!(await ctx.notBanned())) return 'account is not active';
    const ch = changedKeys(cur, d);
    if (!ch.length) return null;
    if (!onlyChanged(ch, CONV_UPDATE_FIELDS)) return 'that field change is not allowed on a conversation';
    if (ch.includes('lastMessageAt') && !nearNow(d.lastMessageAt)) {
      return 'the send stamp must be the server time of this write';
    }
    return null;
  }
};

// ── messages (id is <conversationId>__<messageId>) ─────────────────────
// The conversation is named by DATA (the adapter injects conversationId on
// every write); a compacted row id has no splittable structure, so the
// rowId prefix is only a fallback for ids that still carry it.
const conversationOf = (d, rowId) => {
  if (isStr(d.conversationId) && d.conversationId) return d.conversationId;
  const sep = String(rowId || '').indexOf('__');
  return sep > 0 ? String(rowId).slice(0, sep) : '';
};

POLICY.messages = {
  async create(d, rowId, ctx) {
    const cid = conversationOf(d, rowId);
    if (d.conversationId !== undefined && d.conversationId !== cid) return 'conversation id mismatch';
    if (!isStr(d.senderId) || !d.senderId) return 'senderId required';

    const isAdminSender = ctx.admin && (d.senderRole === 'admin' || d.senderRole === 'system');
    if (!isAdminSender) {
      if (cid !== ctx.uid) return 'you can only write into your own conversation';
      if (d.senderId !== ctx.uid || d.senderRole !== 'user') return 'sender must be you';
      if (!(await ctx.notBanned())) return 'account is not active';

      let e = mediaFields(d); if (e) return e;

      // ── pacedSend ──
      // One message per second. firestore.rules kept this in the same atomic
      // batch as the conversation's stamp; here the proxy advances the stamp
      // itself, so skipping the paired conversation update no longer buys a
      // scripting client anything. The PREVIOUS stamp must be read with
      // ctx.pre() (resource.data semantics): ctx.read() sees the post-batch
      // state, where this batch's own new lastMessageAt would make every
      // legitimate send look like it arrived within the 1s window.
      const conv = await ctx.pre('conversations', cid);
      if (!conv) return 'no conversation to send into';
      const prev = conv.lastMessageAt ? Date.parse(conv.lastMessageAt) : null;
      const now = Date.now();
      if (prev !== null && Number.isFinite(prev) && now <= prev + 1000) {
        return 'please wait a moment before sending another message';
      }
      ctx.effect({ table: 'conversations', rowId: cid, data: { lastMessageAt: new Date(now).toISOString() } });
    } else {
      let e = mediaFields(d); if (e) return e;
    }
    return null;
  },
  async update(d, cur, rowId, ctx) {
    const cid = conversationOf(d, rowId) || conversationOf(cur, rowId);
    if (cid !== ctx.uid && !ctx.admin) return 'not your conversation';
    const ch = changedKeys(cur, d);
    if (!ch.length) return null;
    if (!onlyChanged(ch, ['readAt'])) return 'only read receipts may change';
    return null;
  }
  // delete: admin only
};

function mediaFields(d) {
  if (!isStr(d.text) || d.text.length > 4000) return 'message text out of range';
  if (!['text', 'image', 'file'].includes(d.type)) return 'unsupported message type';
  const url = d.mediaUrl === undefined ? '' : d.mediaUrl;
  const name = d.mediaName === undefined ? '' : d.mediaName;
  if (d.type === 'text') {
    if (url !== '') return 'a text message carries no attachment';
    return null;
  }
  if (!isStr(url) || url.length > 750000) return 'attachment too large';
  if (!MEDIA_RE.test(url)) return 'attachment must be a base64 data URL';
  if (!isStr(name) || name.length > 255) return 'attachment name out of range';
  return null;
}

// ── Entry point ────────────────────────────────────────────────────────
/**
 * @returns {Promise<string|null>} null when permitted, otherwise the reason.
 */
async function checkWrite({ table, op, rowId, data, current, ctx }) {
  const hard = NEVER[table];
  if (hard && hard.includes(op)) return `${table} records are immutable`;

  if (ctx.admin) return null; // isAdmin() short-circuits the rules above

  if (ADMIN_ONLY.has(table)) return `${table} is maintained by administrators`;

  const p = POLICY[table];
  if (!p) return `${table} cannot be written from the app`;

  if (op === 'create') {
    if (current) return `${table}/${rowId} already exists`;
    if (!p.create) return `${table} rows cannot be created from the app`;
    return p.create(data, rowId, ctx);
  }
  if (op === 'update') {
    if (!current) return `${table}/${rowId} does not exist`;
    if (!p.update) return `${table} rows are not editable from the app`;
    return p.update(data, current, rowId, ctx);
  }
  if (op === 'delete') {
    if (!current) return null; // already gone — the DELETE will 404 harmlessly
    if (!p.delete) return `${table} rows cannot be deleted from the app`;
    return p.delete(current, rowId, ctx);
  }
  return 'unknown operation';
}

module.exports = { checkWrite, ADMIN_ONLY, NEVER, POLICY, changedKeys };
