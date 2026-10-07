// ─── AfnoKamai Appwrite permission model ──────────────────────────────
//
// The single source of truth for how firestore.rules maps onto Appwrite
// TablesDB permissions. Three consumers import it:
//
//   * js/appwrite-db.js        — stamps $permissions on every row it creates
//   * scripts/appwrite-schema  — sets the table-level permissions
//   * the Appwrite write-proxy Function — recomputes permissions server-side
//
// Appwrite semantics, verified against the live project (see migration
// report): table-level and row-level grants are OR-combined, and `create`
// is evaluated against the TABLE grant only. Row-level `read`/`update`/
// `delete` are evaluated against the union of both.
//
// Consequences that shape this file:
//   * No table ever grants `write` to a regular user — otherwise that user
//     could overwrite any row in the table, owner or not.
//   * No row ever grants `write` to a regular user either, for the same
//     reason: a row grant would let its owner bypass the proxy and forge
//     fields that firestore.rules would have rejected.
//   * Every user write therefore travels through the write-proxy Function,
//     which authenticates the Firebase ID token and stamps the row itself.
//     Admins write directly (table + row grant `team:admins`), and the
//     server-side sender uses an API key, which bypasses permissions.
//   * Row grants are read-only for users; that is enough, because reads are
//     checked against table OR row and a read-only row grant is the exact
//     shape of "you may see your own document".

export const ADMIN_ROLE = 'team:admins';

/** Data fields that name the document's owner (firestore.rules' `== uid`). */
export const OWNER_FIELDS = [
  'userId', 'uid', 'senderId', 'ownerId', 'referrerId',
  'referredUserId', 'referredId', 'recipientId'
];

/** Collections whose owner is the document id itself. */
export const OWNER_BY_DOCID = new Set([
  'users', 'wallets', 'notificationPrefs', 'activeWithdrawals', 'userPins'
]);

/**
 * Per-collection access, read straight out of firestore.rules.
 *
 *   read: 'any'    → public (config, referral code/handle validation pages)
 *        : 'users' → any signed-in account (task board, announcements)
 *        : 'owner' → the owner fields / document id, plus admins
 *        : 'admin' → admins only (ledger metadata, audit log, PIN hashes)
 *   write: always 'admin' — user writes are proxied, see header.
 */
export const ACL = {
  config: { read: 'any', write: 'admin' },
  referralCodes: { read: 'any', write: 'admin' },
  referralHandles: { read: 'any', write: 'admin' },

  announcements: { read: 'users', write: 'admin' },
  tasks: { read: 'users', write: 'admin' },

  stats: { read: 'admin', write: 'admin' },
  adminLogs: { read: 'admin', write: 'admin' },
  referralRiskFlags: { read: 'admin', write: 'admin' },
  userPins: { read: 'admin', write: 'admin' },
  // Internal admin notes about a user — firestore.rules marks them
  // "NEVER visible to the user", so they are admin-read despite carrying the
  // noted user's id.
  userNotes: { read: 'admin', write: 'admin' },

  users: { read: 'owner', write: 'admin' },
  wallets: { read: 'owner', write: 'admin' },
  taskAssignments: { read: 'owner', write: 'admin' },
  activeWithdrawals: { read: 'owner', write: 'admin' },
  transactions: { read: 'owner', write: 'admin' },
  withdrawals: { read: 'owner', write: 'admin' },
  penalties: { read: 'owner', write: 'admin' },
  referrals: { read: 'owner', write: 'admin' },
  referralEvents: { read: 'owner', write: 'admin' },
  referralRewards: { read: 'owner', write: 'admin' },
  notifications: { read: 'owner', write: 'admin' },
  pushSubscriptions: { read: 'owner', write: 'admin' },
  notificationPrefs: { read: 'owner', write: 'admin' },
  notificationLog: { read: 'owner', write: 'admin' },
  conversations: { read: 'owner', write: 'admin' },
  messages: { read: 'owner', write: 'admin' }
};

export const DEFAULT_ACL = { read: 'owner', write: 'admin' };

/** Every collection this model knows about (used by provisioning + tests). */
export const TABLES = Object.keys(ACL);

/** The uids that may read a row: its owners, plus admins. */
export function ownerIdsOf(table, data, documentId) {
  const ids = new Set();
  for (const field of OWNER_FIELDS) {
    const v = data[field];
    if (typeof v === 'string' && v) ids.add(v);
  }
  if (OWNER_BY_DOCID.has(table)) ids.add(documentId);
  if (Array.isArray(data.participants)) {
    for (const p of data.participants) if (typeof p === 'string' && p) ids.add(p);
  }
  if (table === 'messages') {
    // Flat ids are `<conversationId>__<messageId>` and the conversation id is
    // the participant's uid, so the other side of the chat can read it back.
    const sep = documentId.indexOf('__');
    if (sep > 0) ids.add(documentId.slice(0, sep));
  }
  return [...ids];
}

/**
 * Row-level `$permissions` for a document being created.
 * Read: whoever firestore.rules let read it. Write: admins only.
 */
export function permissionsFor(table, data, documentId) {
  const acl = ACL[table] || DEFAULT_ACL;
  const owners = ownerIdsOf(table, data, documentId);
  const perms = [];
  const add = (p) => { if (p && !perms.includes(p)) perms.push(p); };

  if (acl.read === 'any') add('read("any")');
  else if (acl.read === 'users') add('read("users")');
  if (acl.read === 'owner') for (const id of owners) add(`read("user:${id}")`);

  add(`read("${ADMIN_ROLE}")`);
  // Writes: the proxy Function stamps rows with the API key, which ignores
  // permissions, so no row needs to hand a write grant to a user.
  add(`write("${ADMIN_ROLE}")`);

  if (acl.read === 'owner' && !owners.length) {
    console.warn(`[appwrite-acl] ${table}/${documentId} has no owner field; admins only.`);
  }
  return perms;
}

/**
 * Table-level `$permissions`. These apply to *every* row, so they carry only
 * grants that are safe for the whole table: the broad read that
 * firestore.rules already gave the collection, admin read, and admin write
 * (admin `create` is impossible without a table-level write grant).
 */
export function tablePermissions(table) {
  const acl = ACL[table] || DEFAULT_ACL;
  const perms = [];
  const add = (p) => { if (!perms.includes(p)) perms.push(p); };

  if (acl.read === 'any') add('read("any")');
  else if (acl.read === 'users') add('read("users")');
  add(`read("${ADMIN_ROLE}")`);
  add(`write("${ADMIN_ROLE}")`);
  return perms;
}
