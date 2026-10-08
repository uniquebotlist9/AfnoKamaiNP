// ─── Maintenance page: read the config row and paint the notice ────────
// This lives in its own file on purpose. An inline module would need its
// exact content hash pinned in firebase.json's CSP script-src, and any
// edit to the notice logic would silently block the whole page behind a
// CSP violation. External same-origin scripts are allowed by 'self'.
import { db, isConfigured } from './firebase.js';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { icon, logo } from './icons.js';
import { esc, fmtDateTime } from './utils.js';
import { onAuth, fetchProfile, destinationFor } from './guard.js';

document.getElementById('m-brand').innerHTML = logo({ size: 40 });
document.getElementById('m-ic').innerHTML = icon('wrench');

// The admin's message is plain text with one paragraph per line; each
// line renders as its own <p>, with **bold** / *italic* honoured. HTML is
// escaped first so nothing stored in the config row can inject markup.
const inlineMd = (s) => esc(s)
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
const renderMessage = (s) => String(s || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => `<p class="muted">${inlineMd(line)}</p>`)
  .join('');

/** Paint the admin's configured notice — the exact title and message
 *  saved in the maintenance section of the admin panel. */
function paint(m) {
  if (m.title) document.getElementById('m-title').textContent = m.title;
  if (m.message) document.getElementById('m-msg').innerHTML = renderMessage(m.message);
  const endEl = document.getElementById('m-end');
  if (m.expectedEndAt) {
    endEl.hidden = false;
    endEl.textContent = 'Expected to return: ' + fmtDateTime(m.expectedEndAt);
  }
}

/** This page must never be reachable while maintenance is OFF.
 *  Send the visitor where they belong: their dashboard when they
 *  have a session, the login page otherwise. Mid-signup visitors
 *  continue their chain (email verification / profile setup) —
 *  destinationFor is the same router the boot page uses. */
let leaving = false;
function leaveMaintenance() {
  if (leaving) return;
  leaving = true;
  onAuth(async (u) => {
    if (!u) { location.replace('login.html'); return; }
    const profile = await fetchProfile(u.uid).catch(() => null);
    location.replace(destinationFor(u, profile));
  });
}

/** The config could not be read at all (offline, transient error).
 *  We cannot confirm maintenance is on, so do not show the notice —
 *  the boot page routes to login/dashboard and has its own honest
 *  "taking longer than usual / try again" state for offline. */
function bailToBoot() {
  location.replace('index.html');
}

if (isConfigured()) {
  const ref = doc(db, 'config', 'maintenance');
  // Decide BEFORE painting anything: the card ships with default
  // text, and flashing it for a second would be wrong the moment
  // maintenance is off (or the admin changed the wording).
  getDoc(ref).then((snap) => {
    const m = snap.data();
    if (!m || !m.enabled) { leaveMaintenance(); return; }
    paint(m);
    // Stay in sync while the page is open: the moment the admin
    // disables maintenance (or rewords the notice), the visitor is
    // sent straight to their app or sees the new message.
    onSnapshot(ref, (s) => {
      const live = s.data();
      if (!live || !live.enabled) { leaveMaintenance(); return; }
      paint(live);
    }, () => { /* listener errors auto-retry; the notice stays up */ });
  }).catch(bailToBoot);
}
// No blind page reload: the snapshot listener above already keeps
// the notice live, and a reload every few minutes would interrupt
// someone reading the message.
