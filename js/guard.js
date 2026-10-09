// ─── Route guards: authentication + registration chain ───────────────
// Flow: Login → Signup → Email Verification → Personal Info → PIN → Dashboard
import { auth, db, isConfigured } from './firebase.js';
import {
  onAuthStateChanged, signOut
} from 'firebase/auth';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { esc } from './utils.js';
import { logo } from './icons.js';
import { renderMountFailure } from './ui.js';


/**
 * Root-absolute route. Every redirect used to be a page-relative string, which
 * meant admin pages (`/admin/…`) resolved `login` to `/admin/login`
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
  if (isRedirect(ev.reason) || isRestricted(ev.reason) || isStop(ev.reason)) { ev.preventDefault(); return; }
  recoverIfNeverRendered();
});
window.addEventListener('error', (ev) => {
  if (isRedirect(ev.error) || isRestricted(ev.error) || isStop(ev.error)) { ev.preventDefault(); return; }
  recoverIfNeverRendered();
});

/**
 * If an uncaught failure lands while the page is still on its loading screen
 * (the inline splash or the shell skeleton), the module graph is broken and
 * nothing will ever render on its own — swap in the friendly retry screen
 * instead of leaving the spinner up forever. Errors that arrive AFTER content
 * rendered are left alone: the console already reports those.
 */
function recoverIfNeverRendered() {
  try {
    if (document.getElementById('ak-splash') || document.getElementById('page-skeleton')) {
      renderMountFailure();
    }
  } catch (_) { /* never mask the original error */ }
}

export function onAuth(cb) {
  if (!isConfigured()) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, cb);
}

export function waitForAuth() {
  return new Promise((resolve) => onAuth(resolve));
}

export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  const profile = snap.exists() ? { id: snap.id, ...snap.data() } : null;
  // Mirror the result so the NEXT navigation can paint the shell without a
  // round-trip (see requireAppAccess). Stale-while-revalidate: a read that
  // succeeds refreshes the mirror, a missing doc clears it, a failed read
  // (offline) throws before touching it and the cached copy survives.
  if (profile) writeCachedProfile(uid, profile);
  else clearCachedProfile(uid);
  return profile;
}

// ── Profile mirror: instant page switches ─────────────────────────────
// requireAppAccess() gates EVERY navigation, and it used to await a network
// profile read before the shell could paint — so on a slow connection every
// section switch waited a full round-trip behind the splash. The profile of
// the signed-in user is mirrored to localStorage instead: paints happen from
// cache in ~0ms and a background read keeps it honest (one navigation behind
// at most; real security is enforced server-side by the document rules).
// Timestamps are class instances whose methods JSON drops, so they are
// written with an explicit marker and revived on read.
const PROFILE_PREFIX = 'ak_profile_';
const profileKey = (uid) => PROFILE_PREFIX + uid;

// Timestamp defines toJSON(), which JSON.stringify applies BEFORE any
// replacer sees the value — so instances would silently degrade to plain
// ISO strings in the mirror and lose their methods (createdAt.toMillis()
// etc.). Pre-walk instead: emit {__ts} markers here, revive them on read,
// and the mirror stays type-identical to a live read.
function toCacheShape(v) {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(toCacheShape);
  if (v && typeof v === 'object' && v.constructor === Object) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toCacheShape(v[k]);
    return out;
  }
  return v;
}

function writeCachedProfile(uid, profile) {
  try {
    localStorage.setItem(profileKey(uid), JSON.stringify(toCacheShape(profile)));
    localStorage.setItem(ACTIVE_UID_KEY, uid);
  } catch (_) { /* quota / private mode — switches just fall back to network */ }
}

function clearCachedProfile(uid) {
  try { localStorage.removeItem(profileKey(uid)); } catch (_) {}
}

function readCachedProfile(uid) {
  try {
    const raw = localStorage.getItem(profileKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw, (k, v) =>
      v && typeof v === 'object' && typeof v.__ts === 'number' && Object.keys(v).length === 1
        ? Timestamp.fromMillis(v.__ts) : v);
    return parsed && typeof parsed === 'object' && parsed.id ? parsed : null;
  } catch (_) { return null; }
}

// Which uid's mirror is the live one. Named with the ak_profile_ prefix so
// doLogout's sweep clears marker and mirrors together.
const ACTIVE_UID_KEY = 'ak_profile_uid';

/**
 * The last signed-in account's profile, read synchronously. Shells use this
 * to paint their chrome immediately instead of waiting out Firebase Auth's
 * first emission (an accounts:lookup round-trip that used to hold the splash
 * on screen through every section switch); the real gate still runs right
 * after paint. Null on first run — callers fall back to the blocking path.
 */
export function readActiveProfile() {
  try {
    const uid = localStorage.getItem(ACTIVE_UID_KEY);
    return uid ? readCachedProfile(uid) : null;
  } catch (_) { return null; }
}

/** Background refresh; fetchProfile itself updates/clears the mirror. */
function revalidateProfile(uid) {
  fetchProfile(uid).catch(() => { /* offline: keep the copy; retried next switch */ });
}

/** Cache-first read for boot-time routing (landing / login bounce). */
async function loadProfileSmart(uid) {
  const cached = readCachedProfile(uid);
  if (cached) { revalidateProfile(uid); return cached; }
  return fetchProfile(uid);
}

/** Decide where an authenticated user belongs in the registration chain. */
export function destinationFor(user, profile) {
  if (!user) return R('login');
  // Check Appwrite user document's emailVerified first (programmatically settable),
  // fall back to Firebase Auth's emailVerified.
  const appwriteDoc = profile; // fetchProfile already returns { id, ...data } including emailVerified
  const emailVerifiedFromAppwrite = appwriteDoc && appwriteDoc.emailVerified === true;
  const emailVerifiedFromFirebase = user.emailVerified;
  if (!(emailVerifiedFromAppwrite || emailVerifiedFromFirebase)) return R('verify-email');
  if (!profile) return R('profile-setup');
  if (!profile.profileComplete) return R('profile-setup');
  if (!profile.pinSetAt) return R('profile-setup#pin');
  return R('dashboard');
}

/** For index.html: route whichever way the visitor belongs. */
export async function routeOnBoot({ onStage = () => {} } = {}) {
  onStage('Checking your session…');
  const user = await waitForAuth();
  if (!user) { location.replace(R('login')); return; }
  onStage('Loading your account…');
  const profile = await loadProfileSmart(user.uid);
  location.replace(destinationFor(user, profile));
}

/** For login/signup pages: bounce authenticated users to their destination. */
export async function redirectIfAuthed() {
  const user = await waitForAuth();
  if (!user) return null;
  try {
    const profile = await loadProfileSmart(user.uid);
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
  if (!user) { location.replace(R('login')); throw redirectSignal(); }

  let profile = readCachedProfile(user.uid);
  if (profile) {
    // Paint from the mirror — no network on the critical path, so switching
    // sections is instant even on a slow connection. The background read
    // corrects any drift before the next navigation.
    revalidateProfile(user.uid);
  } else {
    profile = await fetchProfile(user.uid);
    if (!profile) {
      // Auth user exists but Appwrite doc missing (interrupted signup) → heal.
      const { ensureUserDocs } = await import('./api.js');
      await ensureUserDocs(user).catch(() => { /* retried on next load */ });
      profile = await fetchProfile(user.uid);
    }
  }
  // Check Appwrite user document's emailVerified first (programmatically settable),
  // fall back to Firebase Auth's emailVerified.
  const appwriteDoc = profile; // fetchProfile already returns { id, ...data } including emailVerified
  const emailVerifiedFromAppwrite = appwriteDoc && appwriteDoc.emailVerified === true;
  const emailVerifiedFromFirebase = user.emailVerified;
  if (!(emailVerifiedFromAppwrite || emailVerifiedFromFirebase)) { location.replace(R('verify-email')); throw redirectSignal(); }
  if (!profile || !profile.profileComplete || !profile.pinSetAt) {
    location.replace(R('profile-setup')); throw redirectSignal();
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
    location.replace('/');
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
    // Profile mirrors are uid-suffixed — sweep them by prefix so a shared
    // machine never hands the next person the previous user's account data.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PROFILE_PREFIX)) localStorage.removeItem(key);
    }
  } catch (_) { /* private mode / storage disabled */ }
  await signOut(auth);
  // Root-absolute: this is called from /admin/* as well, where a relative
  // "login" would 404 on /admin/login.
  location.replace(R('login'));
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
