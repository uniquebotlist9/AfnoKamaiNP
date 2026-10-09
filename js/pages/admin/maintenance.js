// ─── Admin: maintenance mode control ─────────────────────────────────
import { db } from '../../firebase.js';
import { doc, getDoc, serverTimestamp, setDoc as fsSetDoc } from 'firebase/firestore';

// Bounded writes: Firestore retries RESOURCE_EXHAUSTED forever instead of
// rejecting, so an unbounded write can hold a promise — and the busy button
// awaiting it — indefinitely. Shadowed here rather than at each call site so
// no write can be forgotten.
const setDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsSetDoc(...a));
import { mountAdminShell } from '../../admin-shell.js?v=5';
import { esc, fmtDateTime } from '../../utils.js';
import { icon } from '../../icons.js';
import { confirmDialog, btnBusy, toast, badge, withDeadline, WRITE_DEADLINE_MS } from '../../ui.js';

let { content } = await mountAdminShell('maintenance');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Maintenance mode</h1>
      <p class="sub">While enabled, normal users see a maintenance page. Administrators keep full access.</p>
    </div>
    <div id="maint-status"></div>
  </div>

  <div class="card maint-hero" style="margin-bottom:18px">
    <div style="display:flex; justify-content:center; margin-bottom:14px" id="maint-icon"></div>
    <h2 id="maint-preview-title">AfnoKamai is currently undergoing scheduled maintenance.</h2>
    <div id="maint-preview-msg" style="text-align:left; margin:12px auto 0; max-width:46ch">
      <p class="muted" style="margin:0 0 10px; line-height:1.6">We expect services to return shortly. Thank you for your patience.</p>
    </div>
    <p class="small muted" id="maint-preview-end" hidden></p>
    <p class="hint" style="margin-top:14px">This is a live preview of what users will see.</p>
  </div>

  <div class="card card-pad" style="max-width:640px">
    <form id="maint-form">
      <div style="display:flex; align-items:center; gap:14px; padding:6px 0 18px">
        <label class="switch">
          <input type="checkbox" id="m-enabled">
          <span class="slider"></span>
        </label>
        <div>
          <div style="font-weight:700" id="m-state-label">Maintenance mode is off</div>
          <div class="small muted">The state is stored in Firebase and applies to every user instantly.</div>
        </div>
      </div>
      <div class="field">
        <label class="label" for="m-title">Maintenance title</label>
        <input class="input" id="m-title" placeholder="AfnoKamai is currently undergoing scheduled maintenance.">
      </div>
      <div class="field">
        <label class="label" for="m-msg">Message</label>
        <textarea class="textarea" id="m-msg" placeholder="We expect services to return shortly. Thank you for your patience."></textarea>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
        <div class="field">
          <label class="label" for="m-start">Start time (optional)</label>
          <input class="input" type="datetime-local" id="m-start">
        </div>
        <div class="field">
          <label class="label" for="m-end">Expected end time (optional)</label>
          <input class="input" type="datetime-local" id="m-end">
        </div>
      </div>
      <button class="btn primary btn-lg" type="submit" id="m-save">${icon('check')} Save maintenance settings</button>
    </form>
  </div>`;

content.querySelector('#maint-icon').innerHTML = icon('wrench');

// Mirrors maintenance: one paragraph per line, **bold** / *italic*
// honoured, HTML escaped first. The preview must match the user-facing page.
const inlineMd = (s) => esc(s)
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
const renderMessage = (s) => String(s || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => `<p class="muted" style="margin:0 0 10px; line-height:1.6">${inlineMd(line)}</p>`)
  .join('');

function loadIntoForm(m) {
  content.querySelector('#m-enabled').checked = !!(m && m.enabled);
  content.querySelector('#m-title').value = m?.title || '';
  content.querySelector('#m-msg').value = m?.message || '';
  const toLocal = (ts) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  content.querySelector('#m-start').value = toLocal(m?.startedAt);
  content.querySelector('#m-end').value = toLocal(m?.expectedEndAt);
  content.querySelector('#m-state-label').textContent = m?.enabled ? 'Maintenance mode is ON — users see the maintenance page' : 'Maintenance mode is off';
  content.querySelector('#maint-status').innerHTML = m?.enabled
    ? badge('Maintenance active', 'red', { dot: true })
    : badge('All systems normal', 'green', { dot: true });
  content.querySelector('#maint-preview-title').textContent = m?.title || 'AfnoKamai is currently undergoing scheduled maintenance.';
  const msg = m?.message || 'We expect services to return shortly. Thank you for your patience.';
  content.querySelector('#maint-preview-msg').innerHTML = renderMessage(msg);
  const endEl = content.querySelector('#maint-preview-end');
  if (m?.expectedEndAt) { endEl.hidden = false; endEl.textContent = `Expected to return: ${fmtDateTime(m.expectedEndAt)}`; }
  else endEl.hidden = true;
}

// One read when the admin opens the page (and again after each save), not a
// permanent stream: the form is a snapshot of the current setting, and the
// admin is the only writer — a second session overwriting an edit in
// progress would be worse than a stale badge.
function loadFromServer() {
  return getDoc(doc(db, 'config', 'maintenance'))
    .then((snap) => loadIntoForm(snap.data()))
    .catch(() => {});
}
loadFromServer();

content.querySelector('#maint-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = content.querySelector('#m-enabled').checked;
  if (enabled) {
    const ok = await confirmDialog({
      title: 'Enable maintenance mode?',
      message: 'All normal users will be redirected to the maintenance page immediately. Administrators keep access.',
      confirmText: 'Enable maintenance',
      danger: true
    });
    if (!ok) return;
  }
  const btn = content.querySelector('#m-save');
  btnBusy(btn, true, 'Saving…');
  const toTs = (v) => v ? new Date(v) : null;
  try {
    await setDoc(doc(db, 'config', 'maintenance'), {
      enabled,
      title: content.querySelector('#m-title').value.trim(),
      message: content.querySelector('#m-msg').value.trim(),
      startedAt: toTs(content.querySelector('#m-start').value),
      expectedEndAt: toTs(content.querySelector('#m-end').value),
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast(enabled ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.', { type: 'success' });
    await loadFromServer(); // repaint status badge + preview from what actually saved
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
  btnBusy(btn, false);
});
