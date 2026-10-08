// ─── Route guards: authentication + registration chain ───────────────
// Flow: Login → Signup → Email Verification → Personal Info → PIN → Dashboard
import { auth, db, isConfigured } from './firebase.js';
import {
  onAuthStateChanged, signOut
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { esc } from './utils.js';
import { logo } from './icons.js';


/**
 * Root-absolute route. Every redirect used to be a page-relative string, which
 * meant admin pages (`/admin/…`) resolved `login.html` to `/admin/login.html`
 * — a 404. Anchoring to the site root makes the chain work from any depth.
 */
const R = (page) => `/${page}`;

/**
 * Signal (not an error) for "we are already navigating away".
 *
 * Every page does `let { user, profile, content } = await mountShell(...)` at
 * module top level with no try/catch, so a plain Error thrown here would surface
 * as an unhandled rejection and print a red console error on an otherwise
 * healthy page. This marker is swept up by the listener below, so intentional
 * redirects stay silent while genuine failures still get reported.
 */
export function redirectSignal() {
  const e = new Error('redirect');
  e.name = 'RedirectSignal';
  e.isRedirect = true;
  return e;
}

export function isRedirect(e) {
  return !!e && (e.isRedirect === true || e.message === 'redirect');
}

/**
 * Signal for "this page intentionally stopped rendering" — a
 * restricted (banned) account whose restriction screen is already
 * on screen, or a session that failed to mount behind the friendly
 * error screen. Same convention as redirectSignal: swept by the
 * listeners below so intentional stops stay silent while genuine
 * failures still get reported.
 */
export function restrictedSignal() {
  const e = new Error('restricted');
  e.name = 'RestrictedSignal';
  e.isRestricted = true;
  return e;
}

export function isRestricted(e) {
  return !!e && (e.isRestricted === true || e.message === 'restricted');
}

export function stopSignal() {
  const e = new Error('stopped');
  e.name = 'StopSignal';
  e.isStop = true;
  return e;
}

export function isStop(e) {
  return !!e && (e.isStop === true || e.name === 'StopSignal');
}

// Keep the console clean: swallow ONLY our own navigation/stop signals.
//
// Two channels, because a module top-level `await` rejection is reported
// differently from a normal one:
//   • 'unhandledrejection' — covers `promise.catch(...)` and other rejections.
//   • 'error' — a rejected top-level `await` inside a module is reported as an
//     UNCAUGHT EXCEPTION, so preventDefault() on 'unhandledrejection' alone
//     leaves a red console error behind. Caught here too.
window.addEventListener('unhandledrejection', (ev) => {
  if (isRedirect(ev.reason) || isRestricted(ev.reason) || isStop(ev.reason)) ev.preventDefault();
});
window.addEventListener('error', (ev) => {
  if (isRedirect(ev.error) || isRestricted(ev.error) || isStop(ev.error)) ev.preventDefault();
});

export function onAuth(cb) {
  if (!isConfigured()) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, cb);
}

export function waitForAuth() {
  return new Promise((resolve) => onAuth(resolve));
}

export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Decide where an authenticated user belongs in the registration chain. */
export function destinationFor(user, profile) {
  if (!user) return R('login.html');
  // Check Appwrite user document's emailVerified first (programmatically settable),
  // fall back to Firebase Auth's emailVerified.
  const appwriteDoc = profile; // fetchProfile already returns { id, ...data } including emailVerified
  const emailVerifiedFromAppwrite = appwriteDoc && appwriteDoc.emailVerified === true;
  const emailVerifiedFromFirebase = user.emailVerified;
  if (!(emailVerifiedFromAppwrite || emailVerifiedFromFirebase)) return R('verify-email.html');
  if (!profile) return R('profile-setup.html');
  if (!profile.profileComplete) return R('profile-setup.html');
  if (!profile.pinSetAt) return R('profile-setup.html#pin');
  return R('dashboard.html');
}

/** For index.html: route whichever way the visitor belongs. */
export async function routeOnBoot({ onStage = () => {} } = {}) {
  onStage('Checking your session…');
  const user = await waitForAuth();
  if (!user) { location.replace(R('login.html')); return; }
  onStage('Loading your account…');
  const profile = await fetchProfile(user.uid);
  location.replace(destinationFor(user, profile));
}

/** For login/signup pages: bounce authenticated users to their destination. */
export async function redirectIfAuthed() {
  const user = await waitForAuth();
  if (!user) return null;
  try {
    const profile = await fetchProfile(user.uid);
    location.replace(destinationFor(user, profile));
  } catch (_) {
    // Profile read failed (usually an offline blip right after sign-in).
    // Stay put and stay silent: the login form's submit flow retries this
    // exact redirect, and re-submitting is instant while the session
    // persists. Surfacing the failure would wrongly call a successful
    // login an error.
  }
  return user;
}

/**
 * A referral code captured at signup is finalized at the END of setup; a
 * failure there (offline, a rejected write) defers it to exactly here.
 * One attempt per page load: finalizeReferral keeps the pending code unless
 * the outcome is final, so a transient failure simply tries again later.
 */
let referralRetried = false;
async function retryDeferredReferral() {
  if (referralRetried) return;
  referralRetried = true;
  try {
    const { readPendingCode, finalizeReferral } = await import('./referral.js');
    const pending = readPendingCode();
    if (!pending) return;
    const res = await finalizeReferral(pending);
    if (!res.ok) console.info('Referral attribution deferred:', res.reason);
  } catch (_) { /* retried on the next page load */ }
}

/**
 * For authenticated app pages. Enforces the full chain and returns
 * { user, profile }. Throws Redirect signal internally via location.
 */
export async function requireAppAccess() {
  const user = await waitForAuth();
  if (!user) { location.replace(R('login.html')); throw redirectSignal(); }

  let profile = await fetchProfile(user.uid);
  if (!profile) {
    // Auth user exists but Appwrite doc missing (interrupted signup) → heal.
    const { ensureUserDocs } = await import('./api.js');
    await ensureUserDocs(user).catch(() => { /* retried on next load */ });
    profile = await fetchProfile(user.uid);
  }
  // Check Appwrite user document's emailVerified first (programmatically settable),
  // fall back to Firebase Auth's emailVerified.
  const appwriteDoc = profile; // fetchProfile already returns { id, ...data } including emailVerified
  const emailVerifiedFromAppwrite = appwriteDoc && appwriteDoc.emailVerified === true;
  const emailVerifiedFromFirebase = user.emailVerified;
  if (!(emailVerifiedFromAppwrite || emailVerifiedFromFirebase)) { location.replace(R('verify-email.html')); throw redirectSignal(); }
  if (!profile || !profile.profileComplete || !profile.pinSetAt) {
    location.replace(R('profile-setup.html')); throw redirectSignal();
  }
  retryDeferredReferral();
  return { user, profile };
}

/** Admin pages: require claim + mirror flag. */
export async function requireAdminAccess() {
  const { user, profile } = await requireAppAccess();
  const token = await user.getIdTokenResult();
  const isAdmin = token.claims && token.claims.admin === true;
  if (!isAdmin || profile.role !== 'admin') {
    location.replace(R('index.html'));
    throw redirectSignal();
  }
  return { user, profile };
}

/**
 * Local-storage keys that hold STATE FOR A SPECIFIC SIGNED-IN ACCOUNT.
 * They must not outlive the session: the next person to use this browser
 * (or a shared/public machine) would otherwise inherit the previous user's
 * remembered email, admin stats cache, push endpoint and dismissed items.
 *
 * Device-level preferences are deliberately kept: theme, install-popup
 * dismissal and any referral code captured before sign-up belong to the
 * browser, not to an account.
 */
const ACCOUNT_SCOPED_KEYS = [
  'ak_remember_email',        // js/pages/login.js — remembered email
  'ak_chart_stats',           // js/pages/admin/index.js — cached admin revenue/stats
  'ak_last_sweep',            // js/admin-shell.js — admin hold-release sweep stamp
  'ak_push_last_endpoint',    // js/push.js — push subscription endpoint of last user
  'ak_push_device_name',      // js/push.js — device label chosen by last user
  'ak_dismissed_ann',         // js/pages/dashboard.js — dismissed announcements
];

export async function doLogout() {
  try { sessionStorage.clear(); } catch (_) {}
  try {
    for (const key of ACCOUNT_SCOPED_KEYS) localStorage.removeItem(key);
  } catch (_) { /* private mode / storage disabled */ }
  await signOut(auth);
  // Root-absolute: this is called from /admin/* as well, where a relative
  // "login.html" would 404 on /admin/login.html.
  location.replace(R('login.html'));
}

/** Guard for pages where Firebase has not been configured yet. */
export function ensureConfigured() {
  if (isConfigured()) return true;
  document.body.innerHTML = `
    <div class="setup-screen">
      ${logo({})}
      <h1>Firebase configuration needed</h1>
      <p>This deployment of AfnoKamai is not connected to a Firebase project yet.
         Open <code>js/firebase-config.js</code> and paste the web-app config values
         from your Firebase console (Project settings → Your apps).</p>
      <p class="muted">After configuring, reload this page. Deployment steps are in the project README.</p>
    </div>`;
  return false;
}
