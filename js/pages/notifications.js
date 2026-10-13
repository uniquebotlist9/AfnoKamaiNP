// ─── Notification centre (full page) ─────────────────────────────────
//
// v2: filtering and search moved from the client to Firestore.
//
// The old implementation fetched 25 rows and then filtered them in
// JavaScript. Because the list auto-pages, a category with no items in the
// current window rendered as "nothing here" even when hundreds existed
// further down — the filter could only ever see what had been fetched.
// Category and search are now `where` clauses backed by composite indexes
// (userId+category+createdAt, userId+searchText+createdAt).
//
// Consequence worth knowing: documents written before this version have no
// `category` field, so they only match All/Unread until the background
// reindex in scripts/push-sender.cjs has walked over them.

import { db } from '../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs,
  doc, serverTimestamp, startAfter,
  updateDoc as fsUpdateDoc, deleteDoc as fsDeleteDoc, writeBatch as fsWriteBatch
} from 'firebase/firestore';

// Bounded writes: Firestore retries RESOURCE_EXHAUSTED forever instead of
// rejecting, so an unbounded write can hold a promise — and the busy button
// awaiting it — indefinitely.
const updateDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsUpdateDoc(...a));
const deleteDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsDeleteDoc(...a));
const writeBatch = (...a) => boundBatch(fsWriteBatch(...a));
import { mountShell } from '../shell.js';
import { esc, safeHref, fmtRelative, fmtDateTime, fmtNPR, dayKey, dayLabel, debounce } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows, autoPager, confirmDialog, toast, withDeadline, boundBatch, WRITE_DEADLINE_MS } from '../ui.js';
import { CATEGORIES } from '../notify.js';

let { user, content } = await mountShell('notifications');
document.getElementById('page-skeleton')?.remove();

// ─── Tabs ────────────────────────────────────────────────────────────
// `in` lets one tab cover several buckets, so Announcements can swallow
// promotions and System can swallow maintenance without either becoming a
// tab of its own. Firestore caps `in` at 10 values.
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'task', label: 'Tasks' },
  { id: 'reward', label: 'Rewards' },
  { id: 'payment', label: 'Payments' },
  { id: 'referral', label: 'Referrals' },
  { id: 'security', label: 'Security' },
  { id: 'account', label: 'Account' },
  { id: 'announcement', label: 'Announcements', in: ['announcement', 'promotion'] },
  { id: 'system', label: 'System', in: ['system', 'maintenance'] }
];

// Display metadata only — the storage format is `type`, not this table.
const TONE = {
  task_approved: 'green', reward_released: 'green', reward_hold: 'amber',
  task_rejected: 'red', penalty: 'red', withdrawal: 'blue', task_assigned: 'blue',
  admin_message: 'gold', announcement: 'gold', security: 'red',
  referral_joined: 'green', referral_milestone: 'green', referral_reward: 'green',
  referral_review: 'amber'
};
const ICONS = {
  task_approved: 'check', task_rejected: 'x', reward_hold: 'clock', reward_released: 'unlock',
  withdrawal: 'bank', penalty: 'alert', announcement: 'megaphone', security: 'shield',
  task_assigned: 'briefcase', admin_message: 'message',
  maintenance: 'wrench', system: 'info',
  referral_joined: 'users', referral_milestone: 'coins', referral_reward: 'coins',
  referral_review: 'shield'
};
const PRIORITY_LABEL = { urgent: 'Priority', high: 'Important' };

const EMPTY = {
  all: ['No notifications yet', 'Task updates, rewards and announcements will appear here.'],
  unread: ["You're all caught up", 'No unread notifications.'],
  task: ['No task updates', 'Task assignments and review results will appear here.'],
  reward: ['No earning updates', 'Reward holds and releases will appear here.'],
  payment: ['No payment updates', 'Withdrawals, deposits and penalties will appear here.'],
  referral: ['No referral updates', 'Referral joins and rewards will appear here.'],
  security: ['No security alerts', 'Login, password and new-device warnings will appear here.'],
  account: ['No account messages', 'Replies from the admin team will appear here.'],
  announcement: ['No announcements', 'Platform news and offers will appear here.'],
  system: ['No system messages', 'Maintenance and other system notices will appear here.']
};

const SEARCH_LIMIT = 100;
const PAGE = 25;

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Notifications</h1>
      <p class="sub">Updates about your tasks, rewards, withdrawals and account.</p>
    </div>
    <div class="page-head-actions">
      <span class="badge tone-green" id="unread-pill" hidden></span>
      <a class="btn ghost btn-sm" href="notification-settings">${icon('settings')} Settings</a>
      <button class="btn ghost btn-sm" id="mark-all">${icon('check')} Mark all read</button>
    </div>
  </div>

  <div class="card notif-panel">
    <div class="notif-tools">
      <label class="notif-search">
        ${icon('search')}
        <input type="search" id="notif-q" placeholder="Search notifications…"
               autocomplete="off" aria-label="Search notifications">
      </label>
    </div>
    <div class="tabs notif-tabs" role="tablist">
      ${TABS.map((t, i) => `<button class="tab ${i === 0 ? 'active' : ''}" role="tab" data-tab="${t.id}">${esc(t.label)}<span class="count" data-count="${t.id}" hidden></span></button>`).join('')}
    </div>
    <div id="notif-list">${skeletonRows(5, 58)}</div>
  </div>`;

let activeTab = 'all';
let searchTerm = '';
let cursor = null;
let lastDay = '';

// ── Count source ─────────────────────────────────────────────────────
// The badges used to need their own `getDocs` with no limit, so every visit
// downloaded the user's whole notification history TWICE: once through the
// autoPaging list below and once here, in parallel, into a different cache
// entry because the two queries have different shapes. The unfiltered list
// load fetches exactly the same rows, so it keeps a copy and the badges are
// computed from that — no fetch at all on the path people actually take.
// The download survives only as a fallback for what the copy cannot answer:
// a category/search refresh, or an unfiltered run superseded by a tab click
// before it finished paging.
let listRows = [];
let listComplete = false;  // listRows covers every notification this user has
let countsLoaded = false;  // the badge numbers currently on screen are current

const listEl = content.querySelector('#notif-list');
const unreadPill = content.querySelector('#unread-pill');
const searchInput = content.querySelector('#notif-q');

content.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  content.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  activeTab = tab.dataset.tab;
  refresh();
}));

content.querySelector('#mark-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    // 400 rather than "everything": this runs in the user's own session and
    // a batch is capped at 500 operations.
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      where('userId', '==', user.uid),
      where('read', '==', false),
      limit(400)
    ));
    if (snap.size) {
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.update(d.ref, { read: true, readAt: serverTimestamp() }));
      await batch.commit();
      toast(`Marked ${snap.size} as read.`);
    }
    // Everything the batch touched is on screen and already in the list copy,
    // so the badges and the unread dots can be corrected in place. Refetching
    // cost up to 400 reads for the query, then a full re-download of the list
    // and a second full download for the counts — on the order of 3N reads to
    // flip some booleans. Two cases still refetch: a full 400 (there may be
    // leftovers the query never reached), and any row the copy has no record
    // of — a notification that landed after the list was loaded, which means
    // the copy no longer describes the whole set.
    const known = new Set(listRows.map((r) => r.id));
    if (listComplete && snap.size < 400 && snap.docs.every((d) => known.has(d.id))) {
      listRows.forEach((r) => { r.read = true; });
      listEl.querySelectorAll('.notif-item.unread').forEach((el) => {
        el.classList.remove('unread');
        el.querySelector('.unread-dot')?.remove();
      });
      renderCounts(listRows);
    } else {
      refresh();
    }
  } catch (_) { toast('Could not mark all as read.', { type: 'error' }); }
  btn.disabled = false;
});

// ─── Search ──────────────────────────────────────────────────────────
// Debounced: one keystroke per query would turn typing a word into eight
// round trips against a free-tier quota we are already careful with.
const runSearch = debounce(() => {
  const next = searchInput.value.trim().toLowerCase();
  if (next === searchTerm) return;
  searchTerm = next;
  refresh();
}, 300);

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; runSearch(); }
});

/**
 * Backend search over `searchText` (a lowercased title+body index written
 * by js/notify.js). Prefix semantics: "with" matches "withd raw", which is
 * what people expect from a search box.
 */
function searchQuery() {
  return query(
    collection(db, 'notifications'),
    where('userId', '==', user.uid),
    where('searchText', '>=', searchTerm),
    where('searchText', '<=', searchTerm + ''),
    orderBy('searchText'),
    orderBy('createdAt', 'desc'),
    limit(SEARCH_LIMIT)
  );
}

function tabQuery() {
  const tab = TABS.find((t) => t.id === activeTab);
  const parts = [collection(db, 'notifications'), where('userId', '==', user.uid)];

  if (activeTab === 'unread') {
    parts.push(where('read', '==', false));
    parts.push(orderBy('createdAt', 'desc'), limit(PAGE));
  } else if (activeTab === 'all') {
    parts.push(orderBy('createdAt', 'desc'), limit(PAGE));
  } else {
    // Composite index: userId + category + createdAt.
    if (tab.in) parts.push(where('category', 'in', tab.in));
    else parts.push(where('category', '==', tab.id));
    parts.push(orderBy('createdAt', 'desc'), limit(PAGE));
  }
  if (cursor) parts.push(startAfter(cursor));
  return query(...parts);
}

// ─── Counts ──────────────────────────────────────────────────────────
// Client-side counting, over rows the list has already downloaded.
//
// `getCountFromServer` in this adapter has no server-side aggregate: it
// downloads every matching row and counts them (see collect()). Ten badges
// once meant ten full scans of the user's notifications per page load; that
// was collapsed into one unfiltered fetch — but that was still a second full
// download of the same rows, into a different cache entry, because the two
// queries have different shapes.
//
// It is now computed from `listRows`, which the unfiltered load keeps for
// exactly this. Same arithmetic as before: `r.category === id` is false for
// undefined, so documents predating the reindex are excluded here exactly as
// the old `where` clauses excluded them.
/** Paint the tab badges + unread pill from rows that are already in memory. */
function renderCounts(rows) {
  const total = rows.length;
  const unread = rows.filter((r) => r.read === false).length;
  const inTab = (t) => rows.filter((r) => (
    t.in ? t.in.includes(r.category) : r.category === t.id
  )).length;

  TABS.forEach((t, i) => {
    const el = content.querySelector(`[data-count="${t.id}"]`);
    if (!el) return;
    const n = i === 0 ? total : i === 1 ? unread : inTab(t);
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n);
  });

  unreadPill.hidden = !unread;
  unreadPill.textContent = unread > 99 ? '99+ unread' : `${unread} unread`;
}

/**
 * Fallback, and the only path that still pays for a full download. Reached
 * solely when the list copy cannot answer — see the note by `listRows`.
 */
async function loadCounts() {
  try {
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      where('userId', '==', user.uid)
    ));
    renderCounts(snap.docs.map((d) => d.data()));
    countsLoaded = true;
  } catch (e) {
    console.warn('notification counts failed', e);
  }
}

// ─── Rendering ───────────────────────────────────────────────────────

function renderItems(items) {
  if (!items.length) {
    if (searchTerm) {
      return emptyState({
        icon: 'search',
        title: 'No matches',
        message: `Nothing matches “${searchInput.value.trim()}”. Search covers title and description.`
      });
    }
    const [title, msg] = EMPTY[activeTab] || EMPTY.all;
    return emptyState({ icon: 'bell', title, message: msg });
  }

  return items.map((d) => {
    const n = d.data();
    const tone = TONE[n.type] || n.tone || 'gray';
    const ic = ICONS[n.type] || n.icon || (CATEGORIES[n.category] ? CATEGORIES[n.category].icon : 'info');
    const key = dayKey(n.createdAt);
    let head = '';
    if (key && key !== lastDay) {
      lastDay = key;
      const label = dayLabel(n.createdAt);
      if (label) head = `<div class="notif-group">${esc(label)}</div>`;
    }
    const amt = n.amountPaisa != null
      ? `<span class="act-amt ${n.amountPaisa >= 0 ? 'pos' : 'neg'}">${esc(fmtNPR(n.amountPaisa, { sign: 1 }))}</span>` : '';
    // Older notifications predate the `priority` field — fall back to type.
    // The result is then coerced to one of the two known keys before it is
    // interpolated into a class attribute, so a hand-written doc (or a future
    // new value) can never break out of the attribute or invent a class.
    const rawPrio = n.priority || (n.type === 'task_assigned' ? 'urgent' : n.type === 'admin_message' ? 'high' : '');
    const prio = Object.hasOwn(PRIORITY_LABEL, rawPrio) ? rawPrio : '';
    const prioLabel = PRIORITY_LABEL[prio];
    const link = esc(safeHref(n.link, ''));
    const when = n.createdAt ? ` title="${esc(fmtDateTime(n.createdAt))}"` : '';
    const cat = CATEGORIES[n.category];

    return `${head}
      <div class="notif-item ${!n.read ? 'unread' : ''} ${prio ? 'prior-' + prio : ''}" data-id="${esc(d.id)}"${when}>
        <button class="notif-main" data-open data-link="${link}" type="button">
          <span class="act-ic ${esc(tone)}">${icon(ic)}</span>
          <span class="act-body">
            <span class="act-title">${esc(n.title || 'Notification')}${prioLabel ? ` <span class="prio-pill ${prio}">${prioLabel}</span>` : ''}</span>
            ${n.body ? `<span class="act-desc">${esc(n.body)}</span>` : ''}
            <span class="act-time">${cat ? `${esc(cat.label)} · ` : ''}${esc(fmtRelative(n.createdAt))}</span>
          </span>
          ${amt}
          ${!n.read ? '<span class="unread-dot"></span>' : ''}
          ${link ? `<span class="ni-go">${icon('chevRight')}</span>` : ''}
        </button>
        <button class="notif-del" data-del type="button" aria-label="Delete notification" title="Delete">${icon('trash')}</button>
      </div>`;
  }).join('');
}

// One page of the list. `run` comes from autoPager: when a newer run starts
// (tab switch, search, mark-all) this one stops instead of appending stale rows.
async function load(reset, run) {
  // Only an unfiltered load can answer the tab counts: a category or search
  // query returns a strict subset of the same rows.
  const unfiltered = !searchTerm && activeTab === 'all';
  if (reset) {
    cursor = null;
    lastDay = '';
    listEl.innerHTML = skeletonRows(5, 58);
    if (unfiltered) { listRows = []; listComplete = false; }
  }
  try {
    const snap = await getDocs(searchTerm ? searchQuery() : tabQuery());
    if (run.stale) return null;

    // Search caps at SEARCH_LIMIT rows, so there is no cursor to page on.
    const items = snap.docs;
    if (reset) {
      listEl.innerHTML = renderItems(items);
      if (items.length) listEl.querySelectorAll('.notif-main, [data-del]').forEach(wireItem);
    } else if (items.length) {
      listEl.insertAdjacentHTML('beforeend', renderItems(items));
      listEl.querySelectorAll('.notif-main:not([data-wired]), [data-del]:not([data-wired])').forEach(wireItem);
    }
    cursor = searchTerm ? null : (snap.docs[snap.docs.length - 1] || null);

    // Keep the rows for the badges. Only fields the counts need are stored.
    if (unfiltered) {
      for (const d of items) {
        const n = d.data();
        listRows.push({ id: d.id, read: n.read, category: n.category });
      }
      // A short page means the pager has nothing left to ask for — including
      // the very first page of an empty list, so badges settle either way.
      if (items.length < PAGE) {
        listComplete = true;
        renderCounts(listRows);
        countsLoaded = true;
      }
    }
    return cursor;
  } catch (e) {
    console.warn('notifications load failed', e);
    if (reset) {
      listEl.innerHTML = emptyState({
        icon: 'alert',
        title: 'Could not load notifications',
        // The raw code/message is a backend detail — logged above, generic
        // wording shown here (details never render into the list).
        message: 'Please refresh the page.'
      });
    }
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);

async function refresh(reset = true) {
  const finished = await loadAll(reset);
  // `false` means a newer run took over; that run owns the badges from here.
  // When the unfiltered load finished it already painted them from its own
  // rows, so this stays a fallback rather than a second download.
  if (finished && !countsLoaded) await loadCounts();
}

function wireItem(btn) {
  btn.dataset.wired = '1';

  if (btn.hasAttribute('data-del')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.notif-item');
      const id = row.dataset.id;
      const ok = await confirmDialog({
        title: 'Delete this notification?',
        message: 'It is removed from your list only. This cannot be undone.',
        confirmText: 'Delete',
        danger: true
      });
      if (!ok) return;
      try {
        await deleteDoc(doc(db, 'notifications', id));
        row.remove();
        // One row left the list — adjust the badges from the copy rather than
        // re-downloading every notification to recount.
        if (listComplete) {
          const i = listRows.findIndex((r) => r.id === id);
          if (i >= 0) listRows.splice(i, 1);
          renderCounts(listRows);
        } else {
          loadCounts();
        }
        toast('Notification deleted.');
      } catch (err) {
        console.warn('delete failed', err);
        toast('Could not delete that notification.', { type: 'error' });
      }
    });
    return;
  }

  btn.addEventListener('click', async () => {
    const row = btn.closest('.notif-item');
    const id = row.dataset.id;
    try { await updateDoc(doc(db, 'notifications', id), { read: true, readAt: serverTimestamp() }); } catch (_) {}
    const link = btn.dataset.link;
    if (link) location.href = link;
  });
}

// ─── Boot ────────────────────────────────────────────────────────────

refresh(); // paints the list and, from those same rows, the tab badges
