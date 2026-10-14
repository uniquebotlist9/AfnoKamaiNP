// ─── Admin: chat center (list + thread + task request actions) ───────
import { db } from '../../firebase.js';
import { collection, query, where, limit, getDocs } from 'firebase/firestore';
import { subscribeWhileVisible } from '../../listen.js';
import { mountAdminShell } from '../../admin-shell.js?v=5';
import { esc, fmtNPR, fmtRelative } from '../../utils.js';
import { icon } from '../../icons.js';
import { toast, btnBusy, modal } from '../../ui.js';
import { mountChat } from '../../chat.js';
import { reviewTask } from '../../admin-actions.js';

let { user, profile, content } = await mountAdminShell('chats');
document.getElementById('page-skeleton')?.remove();

// Fixed-viewport chat: the page chrome is pinned and only the message list
// scrolls (Instagram / native-chat behaviour) — see .chat-viewport in chat.css.
document.body.classList.add('chat-viewport');

content.innerHTML = `
  <div class="page-head" style="margin-bottom:14px">
    <div>
      <h1 style="font-size:22px">Chats</h1>
      <p class="sub">Assign tasks, review evidence, and answer user questions.</p>
    </div>
  </div>`;

const chatRoot = document.createElement('div');
chatRoot.className = 'chat-root';
content.appendChild(chatRoot);

const targetUid = new URLSearchParams(location.search).get('uid');

await mountChat({ root: chatRoot, role: 'admin', selfUid: user.uid, selfName: profile.fullName });

// ── Prompt dialog (window.prompt is blocked in many mobile WebViews) ──
function promptDialog({ title, message, placeholder = '' }) {
  return new Promise((resolve) => {
    const m = modal({
      title, width: 460,
      body: `${message ? `<p class="confirm-msg">${esc(message)}</p>` : ''}
        <textarea class="input" id="pd-text" rows="3" placeholder="${esc(placeholder)}" maxlength="500"></textarea>`,
      actions: `
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="ok">Confirm</button>`,
      onClose: () => resolve(null)
    });
    const ta = m.root.querySelector('#pd-text');
    m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
    m.root.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const v = ta.value.trim();
      if (v.length < 5) { ta.classList.add('invalid'); return; }
      resolve(v);
      m.close();
    });
    setTimeout(() => ta.focus(), 140);
  });
}

// ── Pending task-request banner ──────────────────────────────────────
// One banner PER pending request — not one banner for whichever request the
// query happened to hand back first.
//
// The old code fetched up to five and then took docs[0] with no orderBy, so
// with two requests waiting an admin could not tell which one "Assign task"
// would act on; it was whichever row the backend returned first. Worse, the
// thread re-renders as messages stream in and rebuilt that single banner
// around a different assignment id, so the target could change under the
// cursor between reading it and clicking.
//
// Each banner now carries its own assignment id in data-asg and the handler
// reads it off the element it was clicked on, at click time. You assign
// exactly the row you pressed, whatever else arrives in the meantime.
const shownBanners = new Map(); // assignmentId -> banner element
let bannerFingerprint = null;   // ordered ids currently painted
// Ids we just acted on. The listener can fire before the write is visible in
// a fresh query, and without this the banner you dismissed repaints for a
// beat and invites a click that can only answer "already handled". An id
// stays here until the server stops returning it, so the entry clears itself.
const handled = new Set();

const tsMs = (v) => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  return typeof v.toMillis === 'function' ? v.toMillis() : 0;
};

function removeBanner(id) {
  const el = shownBanners.get(id);
  if (el) el.remove();
  shownBanners.delete(id);
  // Force the next pass to reconcile from the server, since we just changed
  // the painted set without a query to confirm it.
  bannerFingerprint = null;
}

function buildRequestBanner(p) {
  const banner = document.createElement('div');
  banner.className = 'chat-req-banner';
  banner.dataset.asg = p.id;
  banner.innerHTML = `
    <span class="ic">${icon('briefcase')}</span>
    <div class="crb-body">
      <strong>Task request: ${esc(p.a.title)}</strong>
      Reward ${esc(fmtNPR(p.a.rewardPaisa))} · requested ${esc(fmtRelative(p.a.requestedAt))} · waiting to be assigned
    </div>
    <button class="btn primary btn-sm" data-act="assign">${icon('check')} Assign task</button>
    <button class="btn ghost btn-sm" data-act="decline">Decline</button>`;

  banner.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !banner.contains(btn) || btn.disabled) return;
    // Read from the element, not a closure: whatever row this button lives
    // in is the request it controls.
    const assignmentId = banner.dataset.asg;
    const action = btn.dataset.act;

    if (action === 'assign') {
      btnBusy(btn, true, 'Assigning…');
      try {
        await reviewTask({ assignmentId, action: 'assign' });
        handled.add(assignmentId);
        removeBanner(assignmentId);
        toast('Task assigned — instructions were sent to the chat.', { type: 'success' });
      } catch (err) {
        toast((err && err.message) || 'Could not assign the task.', { type: 'error' });
        btnBusy(btn, false); // keep the button usable so the admin can retry
      }
      return;
    }

    const reason = await promptDialog({
      title: 'Decline this request',
      message: 'The reason is shown to the user.',
      placeholder: 'e.g. This task is no longer available.'
    });
    if (!reason) return;
    btnBusy(btn, true, 'Declining…');
    try {
      await reviewTask({ assignmentId, action: 'cancel', reason });
      handled.add(assignmentId);
      removeBanner(assignmentId);
      toast('Request declined.', { type: 'success' });
    } catch (err) {
      toast((err && err.message) || 'Could not decline the request.', { type: 'error' });
      btnBusy(btn, false); // keep the button usable so the admin can retry
    }
  });
  return banner;
}

async function maybeShowRequestBanner(uid) {
  if (!uid || !document.body.contains(content)) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'taskAssignments'),
      where('userId', '==', uid),
      where('status', '==', 'requested'),
      limit(5)
    ));
    // Deliberately NOT orderBy('requestedAt'): it would need a composite
    // index on (userId, status, requestedAt) that may not exist, and this
    // whole call sits inside a catch that swallows — a missing index would
    // not warn, it would silently delete the banner. Five rows sorted
    // locally is free, and newest-first is the order an admin expects.
    const rows = snap.docs
      .map((d) => ({ id: d.id, a: d.data() }))
      .sort((x, y) => tsMs(y.a.requestedAt) - tsMs(x.a.requestedAt));
    // Drop anything already handled here, and forget ids the server no longer
    // returns — that is how the entry knows the write has landed.
    const serverIds = new Set(rows.map((r) => r.id));
    for (const id of [...handled]) if (!serverIds.has(id)) handled.delete(id);
    const pending = rows.filter((r) => !handled.has(r.id));

    const fingerprint = pending.map((p) => p.id).join(',');
    // Nothing changed since the last pass: leave the DOM alone. Touching it
    // is what used to swap ids out from under the cursor.
    if (fingerprint === bannerFingerprint) return;

    for (const id of [...shownBanners.keys()]) removeBanner(id);
    bannerFingerprint = fingerprint;
    if (!pending.length) return;
    if (!content.querySelector('#admin-thread')) { bannerFingerprint = null; return; }

    let anchor = null;
    for (const p of pending) {
      const el = buildRequestBanner(p);
      shownBanners.set(p.id, el);
      if (anchor) anchor.after(el); else content.insertBefore(el, content.firstChild);
      anchor = el;
    }
  } catch (_) { /* non-fatal: banner is advisory */ }
}

// One snapshot listener per conversation instead of a 5-second poll: the poll
// cost up to 5 reads every 5 s (≈3,600 reads/hour) while a request was pending.
// A listener costs 1 read on attach and then only fires on real changes —
// and subscribeWhileVisible() drops even that while the admin is looking at
// another tab (the banner reappears from the snapshot on return).
let bannerUnsub = null;
function watchRequests(uid) {
  if (bannerUnsub) { bannerUnsub(); bannerUnsub = null; }
  if (!uid) return;
  bannerUnsub = subscribeWhileVisible(
    query(collection(db, 'taskAssignments'),
      where('userId', '==', uid), where('status', '==', 'requested'), limit(5)),
    () => maybeShowRequestBanner(uid),
    undefined,
    { maxPollMs: 10000 } // a pending request banner must not sit 30s behind the user
  );
  maybeShowRequestBanner(uid);
}

if (targetUid) {
  watchRequests(targetUid);
  // Refresh the banner when a conversation is opened from the list.
  chatRoot.addEventListener('click', () => {
    const uid = new URLSearchParams(location.search).get('uid');
    if (uid && uid !== targetUid) {
      watchRequests(uid);
    } else {
      setTimeout(() => maybeShowRequestBanner(uid || targetUid), 600);
    }
  });
  window.addEventListener('pagehide', () => {
    if (bannerUnsub) { bannerUnsub(); bannerUnsub = null; }
  });
}
