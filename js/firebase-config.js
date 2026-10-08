// ─── AfnoKamai Firebase configuration ────────────────────────────────
// Live project: afnokamainp (https://afnokamainp.web.app)
//
// Firebase supplies identity (Authentication) and hosting only. The data
// layer is Appwrite: reads are authorised by row permissions, and every
// write is proxied through an Appwrite Function that re-verifies the
// Firebase ID token (js/appwrite.js → functions/bridge/src/policy.js).
//
// These values are safe to expose publicly — Firebase web keys are not
// secrets; access is controlled by the rules above.
//
// NEVER place Brevo API keys, the Appwrite API key, service-account JSON or
// any other privileged credential in this file.

export const firebaseConfig = {
  apiKey: 'AIzaSyDSwDJig-c0TKzNWdmG40CNoF2EfKowcBw',
  authDomain: 'afnokamainp.firebaseapp.com',
  projectId: 'afnokamainp',
  storageBucket: 'afnokamainp.firebasestorage.app',
  messagingSenderId: '499255080798',
  appId: '1:499255080798:web:964e58007ab519f92cc1cf'
};

// Must match the region set on Cloud Functions (functions/index.js).
export const FUNCTIONS_REGION = 'asia-south1';

// ─── Web Push (VAPID) ────────────────────────────────────────────────
// PUBLIC half of the VAPID keypair (RFC 8292). Publishing this is
// mandatory — PushManager.subscribe() refuses to run without it, so it is
// not a secret.
//
// The matching PRIVATE key exists only as the GitHub Actions secret
// VAPID_PRIVATE_KEY consumed by scripts/push-sender.cjs. It must never be
// written into this repository, a bundle, or a page. A browser holding it
// could forge pushes to every user.
export const VAPID_PUBLIC_KEY =
  'BE059IWEP_ohblWyVzofCA0-hlYSD1-S7H8fCVK5SVe_E7GSzsoP2Wcf7FTvjmopy2xu1N5s9w9UKZ3htWVfMI4';

// How many devices one account may register at once. Enforced here as a
// soft limit and again by the sender's per-user query cap — a runaway
// script should not be able to attach a thousand endpoints to one account.
export const MAX_PUSH_DEVICES = 8;

export function isConfigured() {
  return !String(firebaseConfig.apiKey).startsWith('PASTE_');
}
