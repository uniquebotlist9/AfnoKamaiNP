#!/usr/bin/env node
// ─── Bootstrap an AfnoKamai administrator ────────────────────────────
// Works on the FREE plan — uses only the Admin SDK from your machine.
//
// One-time setup:
//   cd scripts && npm install
//   # download a service-account key: Firebase console → Project settings →
//   # Service accounts → Generate new private key → save as serviceAccount.json here
//
// Grant admin:
//   node set-admin.mjs admin@example.com
// Revoke:
//   node set-admin.mjs admin@example.com --remove
//
// The user must have signed up once (so the Auth account exists). Sets the
// `admin` custom claim (source of truth for the write proxy's admin check)
// and mirrors role: "admin" on the users document in Appwrite.
//
// The custom claim is Firebase Auth's; the role mirror is Appwrite's. Both
// are needed: the bridge function reads the claim, the admin UI reads the row.

const fs = require('fs');
const path = require('path');

const email = process.argv[2];
const remove = process.argv.includes('--remove');
if (!email) {
  console.error('Usage: node set-admin.mjs <email> [--remove]');
  process.exit(1);
}

let serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!serviceAccountPath) {
  const local = path.join(__dirname, 'serviceAccount.json');
  if (fs.existsSync(local)) serviceAccountPath = local;
  else {
    console.error('Save your service-account key as scripts/serviceAccount.json (or set GOOGLE_APPLICATION_CREDENTIALS).');
    process.exit(1);
  }
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
const admin = require(path.join(__dirname, 'node_modules', 'firebase-admin'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const auth = admin.auth();

// The database is Appwrite now, so the role mirror and the audit log go over
// TablesDB with the server API key. Only the custom claim still needs the
// Admin SDK — Firebase Auth is unchanged by the migration.
const APPWRITE_ENDPOINT = (process.env.APPWRITE_ENDPOINT || 'https://sgp.cloud.appwrite.io/v1').replace(/\/+$/, '');
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
if (!APPWRITE_PROJECT_ID || !APPWRITE_DATABASE_ID || !APPWRITE_API_KEY) {
  console.error('Set APPWRITE_PROJECT_ID, APPWRITE_DATABASE_ID and APPWRITE_API_KEY.');
  process.exit(1);
}

async function aw(method, path, body) {
  const res = await fetch(APPWRITE_ENDPOINT + path, {
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
  if (res.status >= 400) {
    throw new Error((json && json.message) || `${method} ${path} -> HTTP ${res.status}`);
  }
  return json;
}

const rows = (table) =>
  `/tablesdb/${encodeURIComponent(APPWRITE_DATABASE_ID)}/tables/${encodeURIComponent(table)}/rows`;

async function patchUser(uid, data) {
  await aw('PATCH', `${rows('users')}/${encodeURIComponent(uid)}`, { data });
}

async function addAdminLog(entry) {
  await aw('POST', rows('adminLogs'), {
    rowId: `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    data: entry
  });
}

(async () => {
  const user = await auth.getUserByEmail(email.toLowerCase());
  if (remove) {
    await auth.setCustomUserClaims(user.uid, { admin: false });
    await patchUser(user.uid, { role: 'user' });
    console.log(`✓ ${email} is no longer an administrator.`);
  } else {
    await auth.setCustomUserClaims(user.uid, { admin: true });
    await patchUser(user.uid, { role: 'admin', uid: user.uid, email: email.toLowerCase() });
    await addAdminLog({
      adminId: 'cli',
      adminEmail: 'cli-bootstrap',
      action: 'admin_role_granted',
      targetType: 'user',
      targetId: user.uid,
      metadata: JSON.stringify({ email: email.toLowerCase() }),
      createdAt: new Date().toISOString()
    });
    console.log(`✓ ${email} (${user.uid}) is now an administrator.`);
    console.log('  Note: the user must log out and back in for the claim to take effect.');
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
