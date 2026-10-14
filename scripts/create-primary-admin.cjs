#!/usr/bin/env node
// ─── Bootstrap the PRIMARY administrator (Firebase Auth + Appwrite row) ───
//
// set-admin.cjs grants the claim and mirrors `role`, but it assumes the
// account already exists and has finished onboarding. This script builds the
// whole account in one shot, because an admin account created through the
// normal sign-up funnel cannot get there cleanly:
//
//   * requireAdminAccess() (js/guard.js) runs the full registration chain
//     first — emailVerified, profileComplete, pinSetAt — and only then checks
//     the admin claim AND profile.role === 'admin'. Both are required.
//   * profileComplete is set by a policy branch that demands a valid phone
//     (functions/bridge/src/policy.js), so an admin with no phone cannot be
//     produced by walking the UI. Only a direct row write can do it.
//
// What it does:
//   1. Firebase Auth — create or update the account, mark it verified (so the
//      verify-email gate is skipped), set the display name and password, and
//      set the `admin` custom claim. The claim is what the write proxy trusts;
//      policy.js short-circuits on it and nothing else.
//   2. Appwrite users row — role:'admin', profileComplete:true, phone:'',
//      emailVerified:true. Written with the server API key, which is exactly
//      why it bypasses the phone rule; that is the point of this script.
//   3. referralCodes row, so the profile is not malformed next to every
//      other account.
//   4. adminLogs entry, so the grant is in the audit trail.
//
// It deliberately does NOT create a PIN. The PIN is a withdrawal control and
// should be chosen by the human who will type it, never by a script that had
// to be pasted into a shell. On first login the guard sends them straight to
// the PIN step (profile is already complete, so step 1 is skipped) and
// /admin works from then on.
//
// Usage:
//   cd scripts && npm install
//   # save the service-account key as scripts/serviceAccount.json
//   $env:APPWRITE_PROJECT_ID='6ac536e6001dd29da193'
//   $env:APPWRITE_DATABASE_ID='6ac53c92002a02a202fe'
//   $env:APPWRITE_API_KEY='<server key>'
//   node create-primary-admin.cjs admin@afnokamai.com --password '…' --name 'Admin'
//
// The password is taken from --password or $PRIMARY_ADMIN_PASSWORD on purpose:
// it is never hardcoded here, so this file can be committed without becoming
// a credential in the repository.

const fs = require('fs');
const path = require('path');

// ── arguments ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
// Positional args, skipping over any --flag value pairs.
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--password' || argv[i] === '--name') { i += 1; continue; }
  if (argv[i].startsWith('--')) continue;
  positional.push(argv[i]);
}
const email = (positional[0] || '').toLowerCase();
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const password = flagValue('--password') || process.env.PRIMARY_ADMIN_PASSWORD || '';
const displayName = flagValue('--name') || 'Admin';

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node create-primary-admin.cjs <email> --password <pw> [--name "Admin"]');
  process.exit(1);
}
if (!password || password.length < 8) {
  console.error('A password of at least 8 characters is required (--password or $PRIMARY_ADMIN_PASSWORD).');
  process.exit(1);
}

// ── credentials ──────────────────────────────────────────────────────────
let serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!serviceAccountPath) {
  const local = path.join(__dirname, 'serviceAccount.json');
  if (fs.existsSync(local)) serviceAccountPath = local;
  else {
    console.error('Save your service-account key as scripts/serviceAccount.json (or set GOOGLE_APPLICATION_CREDENTIALS).');
    process.exit(1);
  }
}
const APPWRITE_ENDPOINT = (process.env.APPWRITE_ENDPOINT || 'https://sgp.cloud.appwrite.io/v1').replace(/\/+$/, '');
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
if (!APPWRITE_PROJECT_ID || !APPWRITE_DATABASE_ID || !APPWRITE_API_KEY) {
  console.error('Set APPWRITE_PROJECT_ID, APPWRITE_DATABASE_ID and APPWRITE_API_KEY.');
  process.exit(1);
}

const firebaseAdmin = require(path.join(__dirname, 'node_modules', 'firebase-admin'));
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')))
});
const auth = firebaseAdmin.auth();

// Row grants are the part a hand-rolled row write most easily gets wrong:
// `users` is read:'owner', so without `read("user:<uid>")` on the row the
// account cannot read its own profile and the app breaks on first load.
// Import the REAL model the bridge and js/appwrite-db.js both use rather than
// transcribing it — a copy here would silently drift from the source of truth.
const { pathToFileURL } = require('url');
let permissionsFor = null;

// ── Appwrite REST (server key: bypasses row permissions, by design) ──────
async function aw(method, p, body) {
  const res = await fetch(APPWRITE_ENDPOINT + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Appwrite-Project': APPWRITE_PROJECT_ID,
      'X-Appwrite-Key': APPWRITE_API_KEY
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (res.status >= 400) throw new Error((json && json.message) || `${method} ${p} -> HTTP ${res.status}`);
  return { status: res.status, json };
}
const rows = (table) =>
  `/tablesdb/${encodeURIComponent(APPWRITE_DATABASE_ID)}/tables/${encodeURIComponent(table)}/rows`;
const rowUrl = (table, id) => `${rows(table)}/${encodeURIComponent(id)}`;

// Same alphabet as js/referral.js — no 0/O/1/I, so a code survives being read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateCode = () =>
  'AFK-' + Array.from({ length: 8 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

(async () => {
  ({ permissionsFor } = await import(pathToFileURL(
    path.join(__dirname, '..', 'functions', 'bridge', 'src', 'appwrite-acl.mjs')
  ).href));
  const now = new Date().toISOString();

  // ── 1. Firebase Auth ───────────────────────────────────────────────────
  let user;
  let created = false;
  try {
    user = await auth.getUserByEmail(email);
    console.log(`· Auth account already exists (${user.uid}) — updating it.`);
    await auth.updateUser(user.uid, { password, emailVerified: true, displayName });
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    user = await auth.createUser({
      email, password, emailVerified: true, displayName,
      // No phoneNumber: this account is deliberately phoneless.
    });
    created = true;
    console.log(`+ Auth account created (${user.uid}).`);
  }
  // The claim is the real gate: the bridge reads claims.admin === true from
  // the ID token, and the write proxy trusts nothing else. It only lands in a
  // FRESHLY minted token, which is why the account must sign out and back in.
  await auth.setCustomUserClaims(user.uid, { admin: true });
  console.log('+ `admin` custom claim set.');

  // ── 2. Appwrite users row ──────────────────────────────────────────────
  const { status: rowStatus, json: existing } = await aw('GET', rowUrl('users', user.uid))
    .catch((e) => { if (/404|not found|missing/i.test(String(e.message))) return { status: 404, json: null }; throw e; });

  let referralCode = null;
  if (rowStatus === 404 || !existing) {
    referralCode = generateCode();
    const data = {
      uid: user.uid,
      email,
      emailVerified: true,
      fullName: displayName,
      phone: '',                       // the whole point: no phone number
      role: 'admin',
      status: 'active',
      profileComplete: true,           // set directly; the policy route needs a phone
      pinSetAt: null,                  // chosen on first login, never here
      pinSalt: null,
      createdAt: now,
      lastActiveAt: now,
      stats: { assigned: 0, approved: 0, rejected: 0, earnedPaisa: 0, withdrawnPaisa: 0, penaltiesPaisa: 0 },
      referralCode,
      referralHandle: '',
      referralCodeSetAt: now,
      referredBy: '',
      referredByCode: '',
      referralJoinedAt: null
    };
    await aw('POST', rows('users'), {
      rowId: user.uid,
      data,
      permissions: permissionsFor('users', data, user.uid)
    });
    console.log('+ Appwrite users row created (role: admin, profileComplete: true, phone: none).');

    const codeData = { code: referralCode, userId: user.uid, createdAt: now };
    await aw('POST', rows('referralCodes'), {
      rowId: referralCode,
      data: codeData,
      permissions: permissionsFor('referralCodes', codeData, referralCode)
    }).catch((e) => console.warn(`  ! referralCodes/${referralCode} not written: ${e.message}`));
    console.log(`+ Referral code ${referralCode} registered.`);
  } else {
    // Existing account: touch only what this script owns. Never clobber a
    // phone or name the person may have set themselves.
    const patch = { role: 'admin', emailVerified: true };
    if (!existing.fullName) patch.fullName = displayName;
    if (existing.profileComplete !== true) patch.profileComplete = true;
    await aw('PATCH', rowUrl('users', user.uid), { data: patch });
    console.log(`+ Existing users row updated: ${Object.keys(patch).join(', ')}.`);
    if (existing.phone) console.log(`  (kept existing phone: ${existing.phone})`);
  }

  // ── 3. audit trail ─────────────────────────────────────────────────────
  const logData = {
    adminId: 'cli', adminEmail: 'cli-bootstrap',
    action: 'admin_role_granted',
    targetType: 'user', targetId: user.uid,
    metadata: JSON.stringify({ email, note: 'primary administrator bootstrap' }),
    createdAt: now
  };
  await aw('POST', rows('adminLogs'), {
    rowId: `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    data: logData,
    permissions: permissionsFor('adminLogs', logData, user.uid)
  }).catch((e) => console.warn(`  ! adminLogs entry not written: ${e.message}`));

  console.log('\nDone. Next steps:');
  console.log('  1. Sign in at /login, then sign OUT and back in — the custom claim only');
  console.log('     lands in a freshly minted ID token, so nothing changes until you do.');
  console.log('  2. On first login you will be asked to set a PIN (a withdrawal control).');
  console.log('     The account is already marked complete, so it goes straight there.');
  console.log('  3. Then /admin is reachable.');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED: ' + (e.message || e)); process.exit(1); });
