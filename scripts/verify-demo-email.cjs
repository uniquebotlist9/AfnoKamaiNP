// One-off: mark the demo account's Firebase email as verified.
//
// The bridge's secure actions (set-pin, request-withdrawal) gate on the ID
// token's own email_verified claim, not the Appwrite row, so a demo account
// whose address can never receive mail would otherwise be stuck at the PIN
// step. This mirrors what clicking the real verification link does.
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uid = process.argv[2];
if (!uid) {
  console.error('usage: node verify-demo-email.cjs <uid>');
  process.exit(1);
}

admin
  .auth()
  .updateUser(uid, { emailVerified: true })
  .then((u) => console.log(`ok: ${u.uid} ${u.email} emailVerified=${u.emailVerified}`))
  .catch((e) => {
    console.error('failed:', e.code, e.message);
    process.exit(1);
  })
  .finally(() => admin.app().delete());
