'use strict';

// ─── Bridge policy check: vanity referral handles ────────────────────────
//
// referralHandles/{handle} is the row /ref/<handle> resolves against, so its
// id is a public URL. POLICY.referralHandles.create therefore has to validate
// the HANDLE, not only that the code belongs to the caller — otherwise anyone
// who can reach the bridge could squat /ref/admin and collect sign-ups meant
// for the site. That check was only ever applied to the profile field on the
// users doc, never to the mapping row itself.
//
// This drives checkWrite() directly against the real policy module, so the
// guarantee is executed rather than merely written down. It also pins the two
// adjacent properties the fix relies on: an update is hard-denied (no
// ownership transfer), and the legitimate claim paths still succeed — a rule
// that denies everything is not a secure rule, it is an outage.

const path = require('path');
const { checkWrite } = require(
  path.join(__dirname, '..', 'functions', 'bridge', 'src', 'policy.js')
);

const CODE_A = 'AFK-AAAA2222';
const CODE_B = 'AFK-BBBB3333';

const rows = {
  referralCodes: {
    [CODE_A]: { code: CODE_A, userId: 'userA' },
    [CODE_B]: { code: CODE_B, userId: 'userB' }
  },
  referralHandles: {
    mine: { handle: 'mine', userId: 'userB', code: CODE_B },
    theirs: { handle: 'theirs', userId: 'userA', code: CODE_A }
  }
};

const ctxFor = (uid) => ({
  uid,
  email: uid + '@test.invalid',
  verified: true,
  admin: false,
  read: async (table, rowId) => (rows[table] && rows[table][rowId]) || null,
  notBanned: async () => true,
  effect: () => {}
});

const createHandle = (ctx, handle, code, uid) => checkWrite({
  table: 'referralHandles', op: 'create', rowId: handle, current: null,
  data: { handle, userId: uid, code, createdAt: 1 }, ctx
});

const changeProfile = (ctx, uid, handle) => checkWrite({
  table: 'users', op: 'update', rowId: uid,
  current: { uid, referralCode: CODE_B, referralHandle: 'oldone' },
  data: { referralHandle: handle }, ctx
});

let failures = 0;
const denied = async (name, promise) => {
  const d = await promise;
  if (d) { console.log('  ok   ' + name); } else { failures++; console.log('  FAIL ' + name + ' (was allowed)'); }
};
const allowed = async (name, promise) => {
  const d = await promise;
  if (!d) { console.log('  ok   ' + name); } else { failures++; console.log('  FAIL ' + name + ' (was denied: ' + d + ')'); }
};

(async () => {
  const b = ctxFor('userB');

  // The create branch must reject every handle the client would reject.
  await denied('reserved handle "admin" is refused', createHandle(b, 'admin', CODE_B, 'userB'));
  await denied('reserved handle "official" is refused', createHandle(b, 'official', CODE_B, 'userB'));
  await denied('reserved handle "afnokamai" is refused', createHandle(b, 'afnokamai', CODE_B, 'userB'));
  await denied('uppercase "Sanjaya" is refused', createHandle(b, 'Sanjaya', CODE_B, 'userB'));
  await denied('two-char handle is refused', createHandle(b, 'ab', CODE_B, 'userB'));
  await denied('31-char handle is refused', createHandle(b, 'a'.repeat(31), CODE_B, 'userB'));
  await denied('leading dot ".abc" is refused', createHandle(b, '.abc', CODE_B, 'userB'));

  // …and must still let an honest user through.
  await allowed('30-char handle is allowed', createHandle(b, 'a'.repeat(30), CODE_B, 'userB'));
  await allowed('ordinary claim with own code is allowed', createHandle(b, 'sanjaya', CODE_B, 'userB'));
  await denied("somebody else's code is refused", createHandle(b, 'sanjaya', CODE_A, 'userB'));
  await denied('claiming a handle for another uid is refused', checkWrite({
    table: 'referralHandles', op: 'create', rowId: 'sanjaya', current: null,
    data: { handle: 'sanjaya', userId: 'userA', code: CODE_B, createdAt: 1 }, ctx: b
  }));
  await denied('row id that is not the handle is refused', checkWrite({
    table: 'referralHandles', op: 'create', rowId: 'other', current: null,
    data: { handle: 'sanjaya', userId: 'userB', code: CODE_B, createdAt: 1 }, ctx: b
  }));

  // Ownership cannot be moved by an update — NEVER denies this before the
  // admin bypass, which is what keeps the row a claim and not a transfer.
  const held = { handle: 'sanjaya', userId: 'userA', code: CODE_A, createdAt: 1 };
  await denied('update is hard-denied, even for the owner', checkWrite({
    table: 'referralHandles', op: 'update', rowId: 'sanjaya', current: held,
    data: { userId: 'userB' }, ctx: b
  }));
  await denied('delete by a non-owner is refused', checkWrite({
    table: 'referralHandles', op: 'delete', rowId: 'sanjaya', current: held,
    data: {}, ctx: b
  }));
  await allowed('delete by the owner is allowed', checkWrite({
    table: 'referralHandles', op: 'delete', rowId: 'sanjaya', current: held,
    data: {}, ctx: ctxFor('userA')
  }));

  // The profile field must keep agreeing with the mapping row.
  await allowed('profile may point at a handle we own', changeProfile(b, 'userB', 'mine'));
  await denied("profile may not point at someone else's handle", changeProfile(b, 'userB', 'theirs'));
  await denied('profile may not point at a reserved word', changeProfile(b, 'userB', 'admin'));
  await denied('profile may not point at an unclaimed handle', changeProfile(b, 'userB', 'unclaimed'));

  if (failures) {
    console.error('\ncheck-referral-handles: ' + failures + ' case(s) failed');
    process.exit(1);
  }
  console.log('check-referral-handles: all cases pass');
})().catch((e) => { console.error(e); process.exit(1); });
