// ─── Login page ──────────────────────────────────────────────────────
import { auth, isConfigured } from '../firebase.js';
import {
  signInWithEmailAndPassword, sendPasswordResetEmail
} from 'firebase/auth';
import { ensureConfigured, redirectIfAuthed } from '../guard.js';
import { isEmail, authErrorText, esc } from '../utils.js';
import { mountAside, mountVisibilityToggle, showFormError } from '../auth-common.js';
import { modal, toast, btnBusy } from '../ui.js';
import { icon } from '../icons.js';

mountAside();
mountVisibilityToggle('password', 'toggle-vis');

if (isConfigured()) {
  redirectIfAuthed();

  const form = document.getElementById('login-form');
  const emailEl = document.getElementById('email');
  const passEl = document.getElementById('password');
  const errId = 'form-error';

  // remember email
  try {
    const saved = localStorage.getItem('ak_remember_email');
    if (saved) { emailEl.value = saved; document.getElementById('remember').checked = true; }
  } catch (_) {}

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError(errId, '');
    const email = emailEl.value.trim().toLowerCase();
    const password = passEl.value;
    if (!isEmail(email)) { showFormError(errId, 'Please enter a valid email address.'); emailEl.focus(); return; }
    if (!password) { showFormError(errId, 'Please enter your password.'); passEl.focus(); return; }

    const btn = document.getElementById('login-btn');
    btnBusy(btn, true, 'Logging in…');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      btnBusy(btn, false);
      showFormError(errId, authErrorText(err));
      return;
    }
    if (document.getElementById('remember').checked) {
      try { localStorage.setItem('ak_remember_email', email); } catch (_) {}
    } else {
      try { localStorage.removeItem('ak_remember_email'); } catch (_) {}
    }
    // The auth-state listener from redirectIfAuthed() routes as soon
    // as the profile is readable. This explicit hop just skips the
    // wait — and a failure here must NEVER surface as an error,
    // because the login itself succeeded. Retry briefly (a transient
    // blip usually clears in seconds), then hand off silently:
    // re-submitting is instant while the session persists.
    await redirectAfterLogin(btn);
  });

  /** Navigate to the user's destination, quietly. */
  async function redirectAfterLogin(btn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { destinationFor, fetchProfile } = await import('../guard.js');
        const user = auth.currentUser;
        if (!user) { btnBusy(btn, false); return; }
        const profile = await fetchProfile(user.uid);
        location.replace(destinationFor(user, profile));
        return;
      } catch (_) {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    // Still unreachable (offline): release the button and stay put.
    // Nothing failed from the user's point of view — they are signed in.
    btnBusy(btn, false);
  }

  // Forgot password
  document.getElementById('forgot-link').addEventListener('click', (e) => {
    e.preventDefault();
    const m = modal({
      title: 'Reset your password',
      width: 440,
      body: `
        <p class="confirm-msg">Enter your account email and we'll send you a password reset link.</p>
        <input class="input" id="fp-email" type="email" placeholder="you@example.com" value="${esc(emailEl.value.trim())}">`,
      actions: `
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="send">Send reset link</button>`
    });
    m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
    m.root.querySelector('[data-act="send"]').addEventListener('click', async (ev) => {
      const email = m.root.querySelector('#fp-email').value.trim().toLowerCase();
      if (!isEmail(email)) { m.root.querySelector('#fp-email').classList.add('invalid'); return; }
      const btn2 = ev.currentTarget;
      btnBusy(btn2, true, 'Sending…');
      try {
        await sendPasswordResetEmail(auth, email);
        m.close();
        toast('If an account exists for this email, a reset link has been sent.', { type: 'success', title: 'Check your inbox' });
      } catch (err) {
        btnBusy(btn2, false);
        // Do not reveal whether the email exists.
        m.close();
        toast('If an account exists for this email, a reset link has been sent.', { type: 'success', title: 'Check your inbox' });
      }
    });
  });
}
