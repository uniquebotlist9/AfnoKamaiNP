// ─── Firebase initialisation + shared instances ──────────────────────
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
// TODO: Remove analytics import if not needed
import { firebaseConfig, isConfigured } from './firebase-config.js';
import { ensureAppwriteSession, setBridgeUser } from './appwrite.js';

let app = null;
let auth = null;

if (isConfigured()) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);

  // Mirror the Firebase identity into Appwrite. The session secret this
  // mints is what row-level read grants address, and the write proxy
  // re-verifies the Firebase ID token on every mutation — so Firebase Auth
  // stays the only credential a person ever sees.
  //
  // Registered at module load (before any page boots) so the bridge is
  // already in flight by the time the first read runs; js/appwrite.js waits
  // for it instead of racing it.
  onAuthStateChanged(auth, (user) => {
    setBridgeUser(user);
    if (user) ensureAppwriteSession(user);
  });
  // Firestore initialization REMOVED — database layer now uses Appwrite.
  // Firebase Analytics only runs on https/localhost; load it lazily and never block the app.
  import('firebase/analytics')
    .then(async ({ getAnalytics, isSupported }) => {
      if (await isSupported()) {
        // Analytics intentionally omitted; keep Hosting behaviour unchanged.
      }
    })
    .catch(() => {});
}

export { app, auth };
export { isConfigured };

// ─── Database handle ───────────────────────────────────────────────────
// Every module keeps importing { db } from this file; it now points at the
// Appwrite adapter instead of Firestore. See js/appwrite-db.js.
export { db } from './appwrite-db.js';