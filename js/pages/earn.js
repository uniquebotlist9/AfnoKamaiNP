// ─── Earn: task marketplace + my assignments ─────────────────────────
import { db } from '../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, Timestamp
} from 'firebase/firestore';
import { mountShell, renderRestriction } from '../shell.js';
import { esc, fmtNPR, fmtRelative, countdownUntil, fmtDateTime, fmtDate, DIFFICULTY } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows, badge, confirmDialog, btnBusy, toast } from '../ui.js';
import { requestTask, submitTask } from '../api.js';

let { user, profile, content } = await mountShell('earn');
if (profile.status === 'banned') {
  document.getElementById('page-skeleton')?.remove();
  renderRestriction(profile);
  throw new Error('restricted');
}
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Earn</h1>
      <p class="sub">Request a task, follow the instructions, submit evidence, and get rewarded after review.</p>
    </div>
    <div class="page-head-actions">
      <a class="btn ghost" href="chat.html">${icon('message')} Chat with admin</a>
      <a class="btn subtle" href="rules.html">${icon('scroll')} Task rules</a>
    </div>
  </div>

  <section style="margin-bottom:26px">
    <div class="card">
      <div class="card-head">
        <div><h3>My tasks</h3><div class="sub">Your requested and assigned tasks</div></div>
        <button class="btn ghost btn-sm" id="refresh-lists">${icon('refresh')} Refresh</button>
      </div>
      <div id="assignments">${skeletonRows(2)}</div>
    </div>
  </section>

  <section>
    <div class="card">
      <div class="card-head">
        <div><h3>Available tasks</h3><div class="sub">Pick a task and request it — an administrator will guide you in chat</div></div>
      </div>
      <div class="filters-bar" style="padding:14px 18px 0; margin-bottom:0">
        <input class="input search" id="t-search" placeholder="Search tasks…" aria-label="Search tasks">
        <select class="select" id="t-cat" aria-label="Filter by category">
          <option value="">All categories</option>
        </select>
        <select class="select" id="t-diff" aria-label="Filter by difficulty">
          <option value="">Any difficulty</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
        <select class="select" id="t-sort" aria-label="Sort tasks">
          <option value="new">Newest first</option>
          <option value="reward">Highest reward</option>
        </select>
      </div>
      <div class="card-pad" id="tasks-grid">${skeletonRows(2, 120)}</div>
    </div>
  </section>`;

// ── My tasks: one cached read instead of a permanent listener ──
// This list used to stream via onSnapshot(). Task assignments don't change
// faster than a human can act on them, so it is now a single bounded
// getDocs() that paints instantly from sessionStorage and revalidates in
// the background: pull-to-refresh (a page reload) and the Refresh button
// just re-run it, and returning to the tab revalidates if the data is
// older than 30 s. A listener would have streamed every change forever.
const CACHE_NS = 'ak_earn_v1';
const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // never paint a list staler than this
const REVALIDATE_AFTER_MS = 30 * 1000;    // refresh-on-return threshold

const lastFetch = { assignments: 0, tasks: 0 };

// JSON flattens Firestore Timestamps, which the render code needs as real
// instances (.toMillis / fmtRelative). The stringify replacer marks them and
// the parse reviver rebuilds them, so cached docs behave like fresh ones.
// Keyed by uid: logging out and into another account in the same tab must
// never paint the previous user's tasks, even for a frame.
function cacheKey(key) { return `${CACHE_NS}:${user.uid}:${key}`; }

function cachePut(key, docs) {
  try {
    const raw = JSON.stringify(
      { at: Date.now(), docs },
      (_, v) => (v && typeof v === 'object' && typeof v.toMillis === 'function' ? { __t: v.toMillis() } : v)
    );
    sessionStorage.setItem(cacheKey(key), raw);
  } catch (_) { /* quota/private mode: the cache is an optimisation only */ }
}

function reviveStamp(v) {
  if (!v || typeof v !== 'object') return v;
  if (typeof v.__t === 'number') return Timestamp.fromMillis(v.__t);
  // Fallback: a Timestamp that serialised through its own toJSON().
  if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number' && Object.keys(v).length === 2) {
    return Timestamp.fromMillis(v.seconds * 1000 + Math.round(v.nanoseconds / 1e6));
  }
  return v;
}

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(cacheKey(key));
    if (!raw) return null;
    const entry = JSON.parse(raw, (_, v) => reviveStamp(v));
    if (!entry || !Array.isArray(entry.docs) || Date.now() - entry.at > CACHE_MAX_AGE_MS) return null;
    return entry;
  } catch (_) { return null; }
}

const qMine = query(
  collection(db, 'taskAssignments'),
  where('userId', '==', user.uid),
  orderBy('requestedAt', 'desc'),
  limit(20)
);

let assignmentsPainted = false;
let assignmentsFetching = null;
let loadSeq = 0; // generation: a superseded read never renders or caches

function renderAssignments(items) {
  const el = content.querySelector('#assignments');
  if (!items.length) {
    el.innerHTML = emptyState({
      icon: 'briefcase',
      title: 'No tasks requested yet',
      message: 'Pick a task below and tap "Request Task" to get started.'
    });
  } else {
    el.innerHTML = items.map((a) => renderAssignment(a.id, a)).join('');
    wireAssignmentActions(el);
  }
  assignmentsPainted = true;
}

/**
 * One bounded read of "my tasks".
 *
 * Non-forced calls paint from cache first and skip entirely when the data
 * is under 30 s old — that is what makes pull-to-refresh cheap and lets the
 * tab revalidate on return without a listener. `force` always fetches and
 * skips the cached paint: used right after an action, when the user must
 * see the new status rather than the stale list it replaces.
 */
function loadAssignments({ force = false } = {}) {
  if (!force) {
    if (assignmentsFetching) return assignmentsFetching;
    if (assignmentsPainted && Date.now() - lastFetch.assignments < REVALIDATE_AFTER_MS) return Promise.resolve();
  }
  if (!force) {
    const cached = cacheGet('assignments');
    if (cached) renderAssignments(cached.docs);
    else if (!assignmentsPainted) content.querySelector('#assignments').innerHTML = skeletonRows(2);
  }
  const seq = ++loadSeq;
  assignmentsFetching = (async () => {
    try {
      const snap = await getDocs(qMine);
      if (seq !== loadSeq) return; // a newer read superseded this one
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      lastFetch.assignments = Date.now();
      cachePut('assignments', items);
      renderAssignments(items);
    } catch (_) {
      if (seq !== loadSeq) return;
      if (!assignmentsPainted) {
        content.querySelector('#assignments').innerHTML = emptyState({ icon: 'alert', title: 'Could not load your tasks', message: 'Please refresh the page.' });
      }
    } finally {
      if (seq === loadSeq) assignmentsFetching = null;
    }
  })();
  return assignmentsFetching;
}

loadAssignments();

// ── Refresh affordances ──
// The button is the desktop equivalent of pull-to-refresh: both just re-run
// the two cached reads, which is exactly the refresh path that replaces the
// old listener.
content.querySelector('#refresh-lists').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btnBusy(btn, true, 'Refreshing…');
  await Promise.all([loadAssignments({ force: true }), loadTasks({ force: true })]);
  btnBusy(btn, false);
  toast('Task lists refreshed.', { type: 'success' });
});

// Returning to the tab revalidates anything older than 30 s — the catch-up a
// listener used to provide, for one bounded query instead of a permanent
// stream that billed every change.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  loadAssignments();
  loadTasks();
});

function renderAssignment(id, a) {
  const st = { requested: ['Waiting for approval', 'amber'], assigned: ['In progress', 'blue'], submitted: ['Submitted for review', 'blue'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'], clarification: ['Clarification needed', 'amber'], cancelled: ['Cancelled', 'gray'] }[a.status] || [a.status, 'gray'];
  let action = '';
  if (a.status === 'assigned' || a.status === 'clarification') {
    action = `<button class="btn primary btn-sm" data-complete="${esc(id)}">${icon('check')} I've completed this task</button>`;
  }
  let deadlineLine = '';
  if (['assigned', 'clarification'].includes(a.status) && a.deadline && a.deadline.toMillis) {
    const ms = a.deadline.toMillis() - Date.now();
    if (ms > 0) deadlineLine = `<span class="as-countdown">${icon('calendar')} Due in ${esc(countdownUntil(a.deadline))}</span>`;
    else deadlineLine = `<span class="as-countdown" style="color:var(--red-600)">${icon('calendar')} Deadline passed — contact support</span>`;
  }
  let holdLine = '';
  if (a.status === 'approved' && a.holdUntil) {
    holdLine = `<span class="as-countdown">${icon('clock')} Withdrawable in ${esc(countdownUntil(a.holdUntil))} · ${esc(fmtDateTime(a.holdUntil))}</span>`;
  }
  return `
    <div class="assignment-item">
      <span class="avatar gold">${icon('briefcase')}</span>
      <div class="as-body">
        <div class="as-title">${esc(a.title)} ${badge(st[0], st[1], { dot: true })}</div>
        <div class="as-sub">
          Reward ${esc(fmtNPR(a.rewardPaisa))} · requested ${esc(fmtRelative(a.requestedAt))}
          ${a.submittedAt ? ` · submitted ${esc(fmtRelative(a.submittedAt))}` : ''}
        </div>
        ${a.status === 'rejected' && a.rejectionReason ? `<div class="as-reason"><strong>Rejected:</strong> ${esc(a.rejectionReason)}</div>` : ''}
        ${a.status === 'clarification' && a.clarificationReason ? `<div class="as-reason warn"><strong>Admin:</strong> ${esc(a.clarificationReason)}</div>` : ''}
        ${a.status === 'submitted' && a.evidenceNote ? `<div class="as-sub" style="margin-top:6px">${icon('paperclip')} Evidence: ${esc(a.evidenceNote)}</div>` : ''}
        ${deadlineLine}
        ${holdLine}
      </div>
      <div class="as-actions">
        ${action}
        <a class="btn ${a.status === 'requested' ? 'primary' : 'ghost'} btn-sm" href="chat.html">${icon('message')} ${a.status === 'requested' ? 'Chat with admin' : 'Chat'}</a>
      </div>
    </div>`;
}

function wireAssignmentActions(el) {
  el.querySelectorAll('[data-complete]').forEach((btn) => btn.addEventListener('click', () => submitFlow(btn.dataset.complete)));
}

async function submitFlow(assignmentId) {
  const asgSnap = await getDoc(doc(db, 'taskAssignments', assignmentId)).catch(() => null);
  const asg = asgSnap?.data() || {};
  const needsEvidence = !!asg.evidenceRequired;

  const m = await import('../ui.js').then(({ modal }) => modal({
    title: 'Submit for review',
    width: 520,
    body: `
      <p class="confirm-msg">Please confirm that you have completed the task according to the provided instructions.
      ${needsEvidence ? '<strong>This task requires evidence</strong> — send a screenshot or photo in the chat first, then describe it below.</strong>' : ''} False claims can lead to rejection or penalties.</p>
      <div class="field">
        <label class="label">Completion note</label>
        <textarea class="textarea" id="sub-note" maxlength="1000" placeholder="Briefly describe what you did…"></textarea>
      </div>
      ${needsEvidence ? `
      <div class="field">
        <label class="label">Evidence description <span class="req">*</span></label>
        <input class="input" id="sub-evidence" maxlength="1000" placeholder="e.g. Screenshot sent in chat showing the completed form">
        <p class="hint">Attach the actual screenshot/image in the <a href="chat.html">chat</a> — reviewers check it against your description.</p>
      </div>` : ''}`,
    actions: `
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="send">${icon('check')} Submit for review</button>`
  }));
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.root.querySelector('[data-act="send"]').addEventListener('click', async (ev) => {
    const note = m.root.querySelector('#sub-note').value.trim();
    const evidence = m.root.querySelector('#sub-evidence') ? m.root.querySelector('#sub-evidence').value.trim() : '';
    if (needsEvidence && evidence.length < 5) {
      m.root.querySelector('#sub-evidence').classList.add('invalid');
      return;
    }
    const btn = ev.currentTarget;
    btnBusy(btn, true, 'Submitting…');
    try {
      await submitTask({ assignmentId, note, evidenceNote: evidence });
      m.close();
      // The cached list above still shows the old status — force a re-read
      // so "Submitted for review" appears without waiting for the next
      // manual refresh.
      loadAssignments({ force: true });
      toast('Submitted for review. An administrator will check your work shortly.', { type: 'success', title: 'Task submitted' });
    } catch (err) {
      btnBusy(btn, false);
      toast(err.message, { type: 'error' });
    }
  });
}

// ── Available tasks with search / filters / sorting ──
let allTasks = [];
let tasksPainted = false;
let tasksFetching = null;
let tasksSeq = 0;
const grid = content.querySelector('#tasks-grid');
content.querySelector('#t-cat').innerHTML = '<option value="">All categories</option>';

/**
 * One bounded read of the published task list — same cache contract as
 * loadAssignments(): paint from cache, revalidate when stale, `force` skips
 * the stale paint. The category dropdown is rebuilt from the fresh data but
 * keeps the user's current selection so a background revalidation can't
 * silently clear an active filter.
 */
function loadTasks({ force = false } = {}) {
  if (!force) {
    if (tasksFetching) return tasksFetching;
    if (tasksPainted && Date.now() - lastFetch.tasks < REVALIDATE_AFTER_MS) return Promise.resolve();
    const cached = cacheGet('tasks');
    if (cached) renderTasks(cached.docs);
    else if (!tasksPainted) grid.innerHTML = skeletonRows(2, 120);
  }
  const seq = ++tasksSeq;
  tasksFetching = (async () => {
    try {
      const snap = await getDocs(query(
        collection(db, 'tasks'),
        where('status', 'in', ['published', 'full']),
        orderBy('createdAt', 'desc'),
        limit(50)
      ));
      if (seq !== tasksSeq) return;
      allTasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      lastFetch.tasks = Date.now();
      cachePut('tasks', allTasks);
      renderTasks(allTasks);
    } catch (_) {
      if (seq !== tasksSeq) return;
      if (!tasksPainted) grid.innerHTML = emptyState({ icon: 'alert', title: 'Could not load tasks', message: 'Please refresh the page.' });
    } finally {
      if (seq === tasksSeq) tasksFetching = null;
    }
  })();
  return tasksFetching;
}

function renderTasks(items) {
  const catSel = content.querySelector('#t-cat');
  const selected = catSel.value;
  const cats = [...new Set(items.map((t) => t.category).filter(Boolean))];
  catSel.innerHTML =
    '<option value="">All categories</option>' +
    cats.map((c) => `<option>${esc(c)}</option>`).join('');
  if ([...catSel.options].some((o) => o.value === selected)) catSel.value = selected;
  tasksPainted = true;
  applyFilters();
}

function applyFilters() {
  const term = (content.querySelector('#t-search')?.value || '').toLowerCase().trim();
  const cat = content.querySelector('#t-cat')?.value || '';
  const diff = content.querySelector('#t-diff')?.value || '';
  const sort = content.querySelector('#t-sort')?.value || 'new';
  let list = allTasks.filter((t) => {
    if (cat && t.category !== cat) return false;
    if (diff && (t.difficulty || 'easy') !== diff) return false;
    if (term && !(`${t.title} ${t.description}`.toLowerCase().includes(term))) return false;
    return true;
  });
  if (sort === 'reward') list.sort((a, b) => (b.rewardPaisa || 0) - (a.rewardPaisa || 0));

  if (!list.length) {
    grid.innerHTML = emptyState({
      icon: 'inbox',
      title: allTasks.length ? 'No tasks match your filters' : 'No tasks available right now',
      message: allTasks.length ? 'Try clearing the search or filters.' : 'New tasks are posted by administrators. Check back soon — or ask in support chat.'
    });
    return;
  }
  grid.innerHTML = '<div class="task-grid">' + list.map((t) => renderTaskCard(t.id, t)).join('') + '</div>';
  grid.querySelectorAll('[data-request]').forEach((btn) =>
    btn.addEventListener('click', () => doRequest(btn.dataset.request, btn)));
}

['t-search', 't-cat', 't-diff', 't-sort'].forEach((id) =>
  content.querySelector(`#${id}`).addEventListener('input', applyFilters));
content.querySelector('#t-search').addEventListener('input', applyFilters);

function renderTaskCard(id, t) {
  const diff = DIFFICULTY[t.difficulty] || DIFFICULTY.easy;
  const slotsTotal = t.slotsTotal || 0;
  const taken = t.slotsTaken || 0;
  const remaining = slotsTotal > 0 ? Math.max(slotsTotal - taken, 0) : null;
  const full = remaining === 0 || t.status === 'full';
  let deadlineChip = '';
  if (t.deadline && t.deadline.toMillis) {
    const overdue = t.deadline.toMillis() < Date.now();
    deadlineChip = `<span class="chip">${icon('calendar')} Due ${esc(fmtDate(t.deadline))}</span>`;
    if (overdue) deadlineChip = `<span class="chip" style="color:var(--red-600)">${icon('calendar')} Expired</span>`;
  }
  return `
    <div class="card task-card">
      <div class="tc-top">
        <div class="tc-title">${esc(t.title)}</div>
        <div class="tc-reward"><div class="rw num">${esc(fmtNPR(t.rewardPaisa))}</div><div class="rw-lb">Reward</div></div>
      </div>
      <div class="tc-desc">${esc(t.description || '')}</div>
      <div class="tc-meta">
        ${badge(diff.label, diff.tone)}
        <span class="chip">${icon('clock')} ${esc(t.estimatedMinutes || '10–15')} min</span>
        <span class="chip">${icon('list')} ${esc(t.category || 'Task')}</span>
        ${t.priority ? badge(t.priority === 'high' ? 'Priority' : esc(t.priority), 'gold') : ''}
        ${remaining !== null ? `<span class="chip">${icon('users')} ${full ? 'Full' : `${remaining} slot${remaining === 1 ? '' : 's'} left`}</span>` : ''}
        ${deadlineChip}
        ${t.evidenceRequired ? `<span class="chip">${icon('paperclip')} Evidence required</span>` : ''}
      </div>
      <div class="tc-actions">
        <button class="btn primary btn-block" data-request="${esc(id)}" ${full ? 'disabled' : ''}>
          ${full ? icon('check') + ' Task full' : icon('arrowRight') + ' Request Task'}
        </button>
      </div>
    </div>`;
}

async function doRequest(taskId, btn) {
  btnBusy(btn, true, 'Requesting…');
  try {
    await requestTask({ taskId });
    toast('Task request sent — opening chat with the administrator.', { type: 'success', title: 'Request sent' });
    // Both lists just changed server-side (new assignment, slot consumed):
    // refresh them now so they are current when the user comes back from chat.
    loadAssignments({ force: true });
    loadTasks({ force: true });
    const tSnap = await getDoc(doc(db, 'tasks', taskId)).catch(() => null);
    const title = tSnap?.data()?.title || 'a task';
    // Take the user straight to the admin chat to follow the request.
    setTimeout(() => { location.href = 'chat.html'; }, 900);
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not request task' });
    btnBusy(btn, false);
  }
}
loadTasks();
