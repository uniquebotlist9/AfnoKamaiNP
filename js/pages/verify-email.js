// ─── Email verification page ─────────────────────────────────
import { auth, db, isConfigured } from '../firebase.js';
import { sendEmailVerification, signOut } from 'firebase/auth';
import { doc, updateDoc as fsUpdateDoc } from 'firebase/firestore';

// Bounded writes: Firestore retries RESOURCE_EXHAUSTED forever instead of
// rejecting, so an unbounded write can leave a promise pending indefinitely.
const updateDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsUpdateDoc(...a));
import { ensureConfigured, destinationFor, fetchProfile, doLogout } from '../guard.js';
import { toast, withDeadline, WRITE_DEADLINE_MS } from '../ui.js';
import { icon } from '../icons.js';

if (isConfigured()) {
  const statusEl = document.getElementById('verify-status');
  const emailPill = document.getElementById('email-pill');
  const checkBtn = document.getElementById('check-btn');
  const resendBtn = document.getElementById('resend-btn');
  const resendNote = document.getElementById('resend-note');
  const RESEND_COOLDOWN = 60;

  document.getElementById('mail-ic').innerHTML = icon('bell');

  // ── Polling cadence ─────────────────────────────────────────
  // Verifying an email is a real-world 30–90 second detour: open the
  // inbox, click the link, come back to this tab. The old poller
  // counted TICKS, not failures, and gave up after three of them
  // (~24 s) — telling users with a perfectly healthy connection to
  // "refresh the page". So: check fast at first, ease off with
  // backoff, keep going while the tab is open, and only ever complain
  // after several consecutive FAILURES (a genuine network problem).
  const POLL_START_MS = 6000;
  const POLL_MAX_MS = 15000;
  const MAX_CONSECUTIVE_FAILURES = 4;

  let user = null;
  let pollTimer = null;
  let pollDelay = POLL_START_MS;
  let consecutiveFailures = 0;
  let routed = false;
  let statusState = ''; // last painted status, so identical text is never re-rendered

  // Auth's `emailVerified` is the authority, but the users doc starts
  // as `false` and nothing ever wrote it back — so the admin panel showed
  // "Email verified: No" forever. Mirror it once, guarded so a repeat call
  // or a permissions failure can never break the verification flow.
  let synced = false;
  async function syncVerifiedFlag(u) {
    if (synced || !u || !u.emailVerified || !db) return;
    synced = true;
    // The write proxy validates this flip against the ID token's
    // email_verified claim, but the cached token can predate the click on
    // the verification link (reload() refreshes the user, not the token).
    // Mint a fresh token so the claim agrees with the flag being written.
    try { await u.getIdToken(true); } catch (_) { /* retried on the next check */ }
    updateDoc(doc(db, 'users', u.uid), { emailVerified: true })
      .catch(() => { synced = false; }); // retried on the next successful check
  }

  function setStatus(html, cls = '') {
    statusEl.className = `verify-status ${cls}`;
    statusEl.innerHTML = html;
  }

  /** Paint a status only when it actually changed — no DOM churn every poll. */
  function showStatus(key, html, cls = '') {
    if (statusState === key) return;
    statusState = key;
    setStatus(html, cls);
  }

  const WAITING_HTML = `${icon('clock')} Waiting for verification… We check automatically every few seconds.`;
  function showWaiting() {
    showStatus('waiting', WAITING_HTML);
  }

  function route(user, profile) {
    if (routed) return;
    routed = true;
    clearTimeout(pollTimer);
    // Let the success state be visible for a beat before the page
    // changes — a flash of "Email verified!" reads as confirmation.
    setTimeout(() => location.replace(destinationFor(user, profile)), 700);
  }

  async function checkNow() {
    const current = auth.currentUser;
    if (!current) return false;
    try {
      await current.reload();
      if (current.emailVerified) {
        consecutiveFailures = 0;
        syncVerifiedFlag(current);
        setStatus(`${icon('check')} Email verified!`, 'ok');
        statusState = 'verified';
        const profile = await fetchProfile(current.uid).catch(() => null);
        route(current, profile);
        return true;
      }
      consecutiveFailures = 0;
      showWaiting();
      return false;
    } catch (_) {
      // Network hiccup — count it, but only speak up after several in a
      // row so a single blip never interrupts the flow.
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        showStatus(
          'offline',
          `${icon('alert')} We can't reach the server right now. Check your connection, then press "Check again".`
        );
      }
      return false;
    }
  }

  /** One-shot timer (not setInterval) so a slow check never queues up
   *  behind itself, and the interval can back off over time. */
  function scheduleNext() {
    clearTimeout(pollTimer);
    if (routed) return;
    pollTimer = setTimeout(async () => {
      const done = await checkNow();
      if (done || routed) return;
      pollDelay = Math.min(pollDelay + 2000, POLL_MAX_MS);
      scheduleNext();
    }, pollDelay);
  }

  // The user just switched back to this tab — almost certainly from
  // clicking the link in their email. Check right away instead of
  // making them wait for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || routed) return;
    const current = auth.currentUser;
    if (!current || current.emailVerified) return;
    clearTimeout(pollTimer);
    (async () => {
      const done = await checkNow();
      if (!done && !routed) scheduleNext();
    })();
  });

  function setResendCountdown(sec) {
    if (sec <= 0) {
      resendNote.hidden = true;
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend verification email';
      return;
    }
    resendBtn.disabled = true;
    resendNote.hidden = false;
    resendNote.textContent = `You can request another email in ${sec}s.`;
    setTimeout(() => setResendCountdown(sec - 1), 1000);
  }

  onAuthStateChangedProxy();

  async function onAuthStateChangedProxy() {
    const { onAuth } = await import('../guard.js');
    onAuth(async (u) => {
      if (!u) { location.replace('login'); return; }
      user = u;
      emailPill.textContent = u.email;
      if (u.emailVerified) {
        syncVerifiedFlag(u);
        setStatus(`${icon('check')} Email verified!`, 'ok');
        statusState = 'verified';
        const profile = await fetchProfile(u.uid).catch(() => null);
        route(u, profile);
        return;
      }
      await checkNow();
      scheduleNext();
      setResendCountdown(0);
    });
  }

  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    await checkNow();
    checkBtn.disabled = false;
  });

  resendBtn.addEventListener('click', async () => {
    const current = auth.currentUser || user;
    if (!current) return;
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending…';
    try {
      await sendEmailVerification(current);
      toast('Verification email sent. Please check your inbox and spam folder.', { type: 'success', title: 'Email sent' });
      setResendCountdown(RESEND_COOLDOWN);
    } catch (err) {
      const msg = String(err && err.code || '').includes('too-many-requests')
        ? 'Too many requests. Please wait a minute before trying again.'
        : 'Could not send the email right now. Please try again shortly.';
      toast(msg, { type: 'error', title: "Couldn't send email" });
      setResendCountdown(20);
    }
  });

  document.getElementById('change-email-btn').addEventListener('click', async () => {
    const { confirmDialog } = await import('../ui.js');
    const ok = await confirmDialog({
      title: 'Use a different email?',
      message: 'You will be logged out and can sign up again with a different email address.',
      confirmText: 'Log out & change',
      danger: false
    });
    if (ok) { try { await signOut(auth); } catch (_) {} location.replace('signup'); }
  });

  document.getElementById('logout-btn').addEventListener('click', () => doLogout());
}
