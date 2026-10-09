// ─── User application shell: sidebar, topbar, notifications, guard ───
import { auth, db, isConfigured } from './firebase.js';
import {
  doc, getDoc, onSnapshot, serverTimestamp, collection,
  query, where, orderBy, limit, getDocs,
  updateDoc as fsUpdateDoc, writeBatch as fsWriteBatch
} from 'firebase/firestore';

// ── Bounded writes ───────────────────────────────────────────────────
// Firestore retries RESOURCE_EXHAUSTED forever instead of rejecting, so an
// unbounded write can leave a promise pending indefinitely. Both writes here
// are fire-and-forget, but an unbounded one would keep re-hitting an already
// exhausted backend. onSnapshot is untouched: it is a stream, not a promise.
const updateDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsUpdateDoc(...a));
const writeBatch = (...a) => boundBatch(fsWriteBatch(...a));
import { requireAppAccess, doLogout, ensureConfigured, redirectSignal, isRedirect, stopSignal, readActiveProfile } from './guard.js';
import { icon, logo } from './icons.js';
import { esc, fmtRelative, initials } from './utils.js';
import { initOfflineBanner, emptyState, renderMountFailure, modal, toast, withDeadline, boundBatch, armMountWatch, WRITE_DEADLINE_MS } from './ui.js';
import { subscribeWhileVisible } from './listen.js';
import { initTheme, mountThemeControl } from './theme.js';
import { initInstallPopup } from './install-popup.js';
import { autoSyncIfGranted, pushSupported } from './push.js';

const PAGES = {
  dashboard: { title: 'Dashboard', icon: 'dashboard', group: 'main' },
  earn: { title: 'Earn', icon: 'briefcase', group: 'main' },
  withdraw: { title: 'Withdraw', icon: 'wallet', group: 'main' },
  referral: { title: 'Referral', icon: 'link', group: 'main' },
  notifications: { title: 'Notifications', icon: 'bell', group: 'secondary' },
  transactions: { title: 'Transactions', icon: 'list', group: 'secondary' },
  profile: { title: 'Profile', icon: 'user', group: 'secondary' },
  rules: { title: 'Task Rules', icon: 'scroll', group: 'secondary' },
  support: { title: 'Support', icon: 'lifebuoy', group: 'secondary' },
  chat: { title: 'Support Chat', icon: 'message', group: 'secondary' }
};

const MOBILE_PRIMARY = ['dashboard', 'earn', 'withdraw'];

function navLink(id, current, badgeId) {
  const p = PAGES[id];
  const href = `${id}`;
  return `
    <a class="side-link ${current === id ? 'active' : ''}" href="${href}" ${current === id ? 'aria-current="page"' : ''}>
      ${icon(p.icon)}<span>${esc(p.title)}</span>
      ${badgeId ? `<span class="side-badge" data-badge="${badgeId}" hidden></span>` : ''}
    </a>`;
}

/**
 * Mounts the user shell and enforces the auth chain + maintenance + ban.
 * Returns { user, profile }.
 */
let installEvent = null;

export async function mountShell(pageId) {
  if (!ensureConfigured()) throw redirectSignal();
  initTheme();

  const gate = async () => {
    try {
      return await requireAppAccess();
    } catch (e) {
      // 'redirect' means we are already navigating away — stay quiet.
      if (isRedirect(e)) throw e;
      renderMountFailure('Could not load your session', 'Check your connection and try again.');
      // The friendly screen is up; stop this page silently instead of
      // surfacing a module-level error behind it.
      throw stopSignal();
    }
  };

  // PAINT FIRST, GATE RIGHT AFTER. The gate waits for Firebase Auth's first
  // emission, which performs an accounts:lookup round-trip — waiting for it
  // behind the inline splash is what flashed a loading screen on every
  // section switch. The chrome needs only fullName/email, which the local
  // profile mirror carries, so the shell goes on screen immediately and the
  // real gate runs right after: an ended session or a pending chain step
  // (verify-email / setup) then redirects from a painted shell instead of a
  // splash. First run — no mirror — keeps the original blocking path.
  let access = null;
  let profile = readActiveProfile();
  if (!profile) { access = await gate(); profile = access.profile; }

  const layout = document.createElement('div');
  layout.className = 'app-layout';
  layout.innerHTML = `
    <a class="skip-link" href="#page-content">Skip to main content</a>
    <aside class="sidebar" id="sidebar">
      <a class="brand" href="dashboard">${logo({ light: true })}</a>
      <div class="side-label">Main</div>
      <nav class="side-nav" aria-label="Main">
        ${navLink('dashboard', pageId)}
        ${navLink('earn', pageId)}
        ${navLink('withdraw', pageId)}
        ${navLink('referral', pageId)}
        <div class="side-label">Account</div>
        ${navLink('notifications', pageId, 'notif')}
        ${navLink('transactions', pageId)}
        ${navLink('profile', pageId)}
        ${navLink('rules', pageId)}
        ${navLink('support', pageId)}
        <div class="side-foot">
          <div class="side-user">
            <span class="avatar">${esc(initials(profile.fullName))}</span>
            <div class="meta">
              <div class="nm">${esc(profile.fullName)}</div>
              <div class="em">${esc(profile.email)}</div>
            </div>
          </div>
          <a class="side-link" href="#" id="side-logout">${icon('logout')}<span>Log out</span></a>
        </div>
      </nav>
    </aside>
    <div class="sidebar-backdrop" id="sidebar-backdrop" hidden></div>
    <div class="app-main">
      <header class="topbar">
        <button class="btn-icon menu-btn" id="menu-btn" aria-label="Open navigation">${icon('menu')}</button>
        <div class="topbar-actions">
          <div class="notif-wrap" id="notif-wrap">
            <button class="btn-icon" id="notif-bell" aria-label="Notifications">
              ${icon('bell')}<span class="side-badge" data-badge="notif-bell" style="position:absolute; transform:translate(14px,-14px);" hidden></span>
            </button>
          </div>
          <button class="avatar-btn" id="user-btn" aria-label="Account menu">
            <span class="avatar">${esc(initials(profile.fullName))}</span>
          </button>
        </div>
      </header>
      <main class="app-content" id="page-content" tabindex="-1">
        <div class="skeleton-list" id="page-skeleton">
          <div class="skeleton-row" style="height:110px"></div>
          <div class="skeleton-row" style="height:220px"></div>
        </div>
      </main>
    </div>
    <nav class="mobile-nav" aria-label="Quick navigation">
      ${MOBILE_PRIMARY.map((id) => `
        <a href="${id}" class="${pageId === id ? 'active' : ''}">
          ${icon(PAGES[id].icon)}<span>${esc(PAGES[id].title)}</span>
        </a>`).join('')}
      <button id="more-btn">${icon('menu')}<span>More</span></button>
    </nav>`;
  document.body.appendChild(layout);
  // The inline splash has done its job: the shell (with its skeleton) is on
  // screen now, so retire it and start the silent-hang watchdog.
  document.getElementById('ak-splash')?.remove();
  armMountWatch();

  // Shell is on screen — finish the real gate here, where the slow part
  // (Firebase Auth's accounts:lookup) no longer hides behind the splash.
  if (!access) {
    access = await gate();
    profile = access.profile;
  }
  const { user } = access;

  const content = layout.querySelector('#page-content');

  // ── Sidebar mobile behaviour ──
  const sidebar = layout.querySelector('#sidebar');
  const backdrop = layout.querySelector('#sidebar-backdrop');
  const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.hidden = true; };
  layout.querySelector('#menu-btn').addEventListener('click', () => { sidebar.classList.add('open'); backdrop.hidden = false; });
  backdrop.addEventListener('click', closeSidebar);

  // ── More sheet (mobile) ──
  layout.querySelector('#more-btn').addEventListener('click', () => {
    const ov = document.createElement('div');
    ov.className = 'sheet-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet';
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="side-label">More</div>
      ${['notifications', 'referral', 'transactions', 'profile', 'rules', 'support'].map((id) => navLink(id, pageId)).join('')}
      <button class="side-link" id="sheet-logout">${icon('logout')}<span>Log out</span></button>`;
    document.body.append(ov, sheet);
    requestAnimationFrame(() => { ov.classList.add('open'); sheet.classList.add('open'); });
    const close = () => { ov.classList.remove('open'); sheet.classList.remove('open'); setTimeout(() => { ov.remove(); sheet.remove(); }, 250); };
    ov.addEventListener('click', close);
    sheet.querySelector('#sheet-logout').addEventListener('click', () => doLogout());
  });

  // ── User menu dropdown ──
  const userBtn = layout.querySelector('#user-btn');
  userBtn.addEventListener('click', () => {
    if (layout.querySelector('.user-menu')) { layout.querySelector('.user-menu').remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'user-menu';
    menu.innerHTML = `
      <div class="um-head">
        <div class="nm">${esc(profile.fullName)}</div>
        <div class="em">${esc(profile.email)}</div>
      </div>
      <button id="um-profile">${icon('user')} Profile & security</button>
      <button id="um-referral">${icon('link')} Invite &amp; earn</button>
      <button id="um-support">${icon('lifebuoy')} Help & support</button>
      <button id="um-install" hidden>${icon('download')} Install app</button>
      <div style="padding:8px 12px 4px" id="um-theme"></div>
      <button id="um-logout" class="danger">${icon('logout')} Log out</button>`;
    layout.querySelector('.topbar-actions').appendChild(menu);
    menu.querySelector('#um-profile').addEventListener('click', () => { location.href = 'profile'; });
    menu.querySelector('#um-referral').addEventListener('click', () => { location.href = 'referral'; });
    menu.querySelector('#um-support').addEventListener('click', () => { location.href = 'support'; });
    menu.querySelector('#um-logout').addEventListener('click', () => doLogout());
    mountThemeControl(menu.querySelector('#um-theme'));
    const installBtn = menu.querySelector('#um-install');
    if (installEvent) {
      installBtn.hidden = false;
      installBtn.addEventListener('click', async () => {
        installBtn.hidden = true;
        try { await installEvent.prompt(); } catch (_) {}
        installEvent = null;
      });
    }
    setTimeout(() => document.addEventListener('click', function h(e) {
      if (!menu.contains(e.target) && e.target !== userBtn) { menu.remove(); document.removeEventListener('click', h); }
    }), 0);
  });

  layout.querySelector('#side-logout').addEventListener('click', (e) => { e.preventDefault(); doLogout(); });

  // ── Notification bell + badge ──
  setupNotifications(layout, user.uid);

  // ── Heartbeat, maintenance watch, offline, SW ──
  startHeartbeat(user.uid);
  await watchMaintenance(profile);
  initOfflineBanner();
  registerSW();
  initInstallPopup();
  initPushBridge();
  initNavPrefetch();

  // Every app page shows the restriction screen for banned accounts. It used
  // to be wired per page, so chat/notifications/transactions/rules/support
  // silently let restricted users through.
  renderRestriction(profile);

  return { user, profile, content };
}

// ── Priority surfacing ───────────────────────────────────────────────
// `priority` on a notification decides HOW it reaches the user:
//   'urgent' → modal popup with an "Open chat" button (task assignments — the
//              acceptance is what unlocks the private instructions in chat)
//   'high'   → live toast with an "Open chat" action (admin messages)
//   (none)   → bell badge + notification centre only
// A popup is shown at most once per notification per browser tab, so
// navigating between pages never re-opens it.
const SHOWN_POPUPS_KEY = 'ak_shown_notif_popups';

function loadShownPopups() {
  try {
    const v = JSON.parse(sessionStorage.getItem(SHOWN_POPUPS_KEY) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch (_) { return new Set(); }
}

function rememberPopup(set, id) {
  set.add(id);
  try { sessionStorage.setItem(SHOWN_POPUPS_KEY, JSON.stringify([...set].slice(-40))); } catch (_) {}
}

function onChatPage() {
  // Clean URLs: the live pathname is `/chat` (the `.html` form only exists
  // for one redirect hop), so the check must accept both.
  return /(^|\/)(chat|chats)(\.html)?$/i.test(location.pathname);
}

// ── Browser tab title indicator ──
// Shows unread count in the tab title so users notice new messages
// even when the tab is in the background.
let unreadCount = 0;
function updateTabTitle() {
  const base = 'AfnoKamai';
  if (unreadCount > 0) {
    document.title = `(${unreadCount > 99 ? '99+' : unreadCount}) ${base}`;
  } else {
    document.title = base;
  }
}

/** Acknowledge a notification so the badge (and any repeat popup) clears. */
function markNotificationRead(id) {
  if (!id) return;
  updateDoc(doc(db, 'notifications', id), { read: true, readAt: serverTimestamp() }).catch(() => {});
}

/** Modal popup: task accepted → "Open chat". Returns true when it was shown. */
function showPriorityPopup(n) {
  if (onChatPage()) return false; // the thread is already open in front of them
  const m = modal({
    title: n.title || 'Task assigned',
    width: 470,
    body: `
      <div class="prio-popup">
        <span class="act-ic ${esc(n.tone || 'blue')}">${icon(n.icon || 'briefcase')}</span>
        <div class="pp-body">
          <p class="confirm-msg">${esc(n.body || '')}</p>
          <p class="pp-hint">${icon('lock')} Further private details are shared only in the chat.</p>
        </div>
      </div>`,
    actions: `
      <a class="btn ghost" href="earn">View my tasks</a>
      <a class="btn primary" href="chat">${icon('message')} Open chat</a>`
  });
  const openChat = m.root.querySelector('.modal-foot .btn.primary');
  if (openChat) openChat.addEventListener('click', () => markNotificationRead(n.id));
  const first = m.root.querySelector('.modal-foot .btn');
  if (first) setTimeout(() => first.focus(), 140);
  return true;
}

/** Toast: new admin message → badge already updated, this adds the popup.
 *  Returns true only when the toast actually went on screen, so the caller
 *  knows whether to record it as "surfaced".
 *  Every admin message gets its own toast — they are all high priority. */
function showAdminMessageToast(n) {
  if (onChatPage()) return false;   // already reading the thread
  toast(n.body || 'New message', {
    title: n.title || 'New message from admin',
    type: 'info',
    duration: 7000,
    action: {
      label: 'Open chat',
      onClick: () => { markNotificationRead(n.id); location.href = 'chat'; }
    }
  });
  return true;
}

const tsMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (v ? (new Date(v).getTime() || 0) : 0));
// A backlog older than a day is still a badge + centre entry; only recent
// admin messages are worth interrupting the user on the first paint.
const FIRST_LOAD_SURFACE_MS = 24 * 60 * 60 * 1000;

function setupNotifications(layout, uid) {
  // Bounded: the badge already caps at "99+", so fetching at most 100 unread
  // rows cannot change what the user sees while keeping a user with a large
  // backlog from streaming their whole notification history on every page load.
  const qUnread = query(
    collection(db, 'notifications'),
    where('userId', '==', uid),
    where('read', '==', false),
    limit(100)
  );
  const shownPopups = loadShownPopups();
  let firstSnapshot = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) firstSnapshot = true;
  });

  subscribeWhileVisible(qUnread, (snap) => {
    const n = snap.size;
    unreadCount = n;
    updateTabTitle();
    layout.querySelectorAll('[data-badge="notif"], [data-badge="notif-bell"]').forEach((b) => {
      b.hidden = n === 0;
      b.textContent = n > 99 ? '99+' : n;
    });

    // Items that arrived while this page was already open are surfaced live.
    // Items present in the FIRST snapshot were written while the user was
    // elsewhere — those still have to reach them, otherwise a user who opens
    // the site after an admin message would only ever see a badge count.
    const urgentBacklog = [];
    const highBacklog = [];
    for (const ch of snap.docChanges()) {
      if (ch.type !== 'added') continue;
      const item = { id: ch.doc.id, ...ch.doc.data() };
      const urgent = item.priority === 'urgent' || item.type === 'task_assigned';
      const high = item.priority === 'high' || item.type === 'admin_message';
      if (shownPopups.has(item.id)) continue;

      if (urgent) {
        if (firstSnapshot) { urgentBacklog.push(item); continue; }
        if (showPriorityPopup(item)) rememberPopup(shownPopups, item.id);
        continue;
      }
      if (!high) continue;
      if (firstSnapshot) { highBacklog.push(item); continue; }
      if (showAdminMessageToast(item)) rememberPopup(shownPopups, item.id);
    }

    if (firstSnapshot && urgentBacklog.length) {
      urgentBacklog.sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
      const newest = urgentBacklog[0];
      if (showPriorityPopup(newest)) rememberPopup(shownPopups, newest.id);
    } else if (firstSnapshot && highBacklog.length) {
      highBacklog.sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
      highBacklog.forEach((item, i) => {
        setTimeout(() => {
          if (showAdminMessageToast(item)) rememberPopup(shownPopups, item.id);
        }, i * 1200);
      });
    }
    firstSnapshot = false;
  }, () => { /* badge is best-effort */ }, { maxPollMs: 10000 });

  const bell = layout.querySelector('#notif-bell');
  bell.addEventListener('click', () => {
    location.href = 'notifications';
  });
}

function startHeartbeat(uid) {
  // Presence only needs 5-minute granularity (chat.js treats a user as online
  // when lastActiveAt is under 5 min old), so 4 min leaves a 60s safety margin.
  // The beat is also visibility- and staleness-gated: a backgrounded tab
  // writes NOTHING, and returning to a stale tab writes exactly once. The
  // 60s timer below is a local clock check — it only reaches the network
  // when the tab is visible and the last beat is older than 4 minutes.
  let lastBeat = 0;
  const beat = (force) => {
    if (!force && document.hidden) return;
    const now = Date.now();
    if (!force && now - lastBeat < 4 * 60 * 1000) return;
    lastBeat = now;
    updateDoc(doc(db, 'users', uid), { lastActiveAt: serverTimestamp() }).catch(() => {});
  };
  beat(true);
  setInterval(beat, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
  window.addEventListener('beforeunload', () => { try { beat(true); } catch (_) {} });
}

// Deliberately NOT visibility-gated in the adapter sense: this is
// the one check that must react when an admin flips maintenance.
// Since the config doc lives in Appwrite Tables and may not yet be
// provisioned, we do a single read rather than an ongoing
// subscription — this avoids repeated 404 errors when the
// table/row is missing. The check is throttled to once a minute
// per browser (not per page load) so navigating the app doesn't
// amplify into a read storm, and it re-runs when the user returns
// to the tab — so an admin's toggle is noticed within a minute
// even without a refresh.
//
// (If the table/row is provisioned in Appwrite, the read will return the
// current state immediately.)
async function watchMaintenance(profile) {
  // Admins are exempt from the redirect, so the read only buys a
  // non-admin a duplicate of what the last page load already fetched.
  if (profile && profile.role === 'admin') return;
  const check = async () => {
    try {
      const last = Number(localStorage.getItem('ak_maint_checked_at') || 0);
      if (Date.now() - last < 60 * 1000) return;
      localStorage.setItem('ak_maint_checked_at', String(Date.now()));
      const snap = await getDoc(doc(db, 'config', 'maintenance'));
      const m = snap.data();
      if (m && m.enabled) location.replace('maintenance');
    } catch (_) {
      // Config row missing — maintenance mode is effectively off.
      // No-op: the admin can enable it later and users will see it on refresh.
    }
  };
  await check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

/**
 * Warm a nav link's target the moment the pointer touches it (or the tap
 * starts), so switching sections is a direct swap instead of click →
 * round-trip → splash. The response lands in the HTTP cache and, through
 * the service worker's asset branch, the SW page cache — the switch then
 * answers from cache. One shot per link per page load.
 */
function initNavPrefetch() {
  const seen = new Set();
  const warm = (a) => {
    if (!a || a.origin !== location.origin) return;
    if (seen.has(a.href) || a.href === location.href) return;
    seen.add(a.href);
    fetch(a.href, { credentials: 'same-origin' }).catch(() => {});
  };
  const on = (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a) warm(a); };
  document.addEventListener('pointerover', on, { passive: true });
  document.addEventListener('pointerdown', on, { passive: true });
}

function registerSW() {
  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

/**
 * Two things the page must do that a service worker cannot.
 *
 * 1. Navigate when a notification is clicked while a window is already
 *    open: a worker can focus a client but cannot change its URL, so it
 *    posts `notification:navigate` and we honour it here.
 * 2. Reconcile an existing push subscription with Firestore. This only
 *    ever runs when permission is ALREADY granted — see js/push.js — so
 *    loading a page can never produce a permission dialog.
 */
function initPushBridge() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.type !== 'notification:navigate') return;
      const url = String(data.url || '').trim();
      // Only same-site, root-relative destinations. The value has already
      // been origin-checked in sw.js; this is defence in depth.
      // Root-relative only: `//host` and `/\host` are protocol-relative URLs
      // that would leave this origin despite starting with a slash.
      if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return;
      if (url === location.pathname + location.search) return;
      location.assign(url);
    });
  }

  if (pushSupported()) autoSyncIfGranted().catch(() => {});
}

/** Render a restriction screen when the signed-in account is banned.
 *  Idempotent: mountShell and individual pages may both call it. */
export function renderRestriction(profile) {
  const ban = (profile && profile.ban) || {};
  const restricted = !!ban.type;
  const existing = document.querySelector('.restrict-overlay');
  if (!restricted) { if (existing) existing.remove(); return; }
  if (existing) return; // already shown — don't stack a second overlay

  const temp = ban.type === 'temporary' && ban.until;
  const overlay = document.createElement('div');
  overlay.className = 'restrict-overlay';
  overlay.innerHTML = `
    <div class="card restrict-card">
      <div class="restrict-ic">${icon('ban')}</div>
      <h2>Your AfnoKamai account has been ${ban.type === 'permanent' ? 'permanently restricted' : 'temporarily restricted'}.</h2>
      ${ban.reason ? `<div class="reason"><strong>Reason:</strong> ${esc(ban.reason)}</div>` : ''}
      ${temp ? `<p class="muted">Restriction ends: <strong>${esc(fmtDateTimeSafe(ban.until))}</strong></p>` : ''}
      ${ban.type === 'permanent' ? '<p class="muted">This restriction does not expire. If you believe this is a mistake, contact support.</p>' : ''}
      <p class="muted small">You cannot request tasks, submit work, or withdraw funds while restricted.</p>
      <button class="btn ghost" id="restrict-logout">Log out</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#restrict-logout').addEventListener('click', () => doLogout());
}

function fmtDateTimeSafe(ts) {
  try {
    if (ts && ts.toDate) {
      const d = ts.toDate();
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      }).format(d);
    }
    return String(ts);
  } catch (_) { return ''; }
}
