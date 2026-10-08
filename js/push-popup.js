// ─── Push-permission popup (task-request flow) ──────────────────────────────
// The same card as the PWA install popup (js/install-popup.js) — identical
// `.ip-*` markup, entrance animation, focus handling and three exits — but it
// asks for notification permission instead of an install.
//
// It exists because requesting a task drops the user into a chat: if
// notifications are off, the administrator's reply only lands when the user
// happens to reopen the page.
//
// Exits (every one of them resolves the promise the caller is awaiting, so
// navigation chained on the popup can never be cut off or hang):
//   • Enable notifications → Notification.requestPermission() + subscription sync
//   • X / Escape / overlay → temporary dismissal, nothing is written
//   • Don't show again     → afnokamai_push_popup_dismissed = "true"
//
// Suppressed when:
//   • afnokamai_push_popup_dismissed === "true"  (the "never again" tick)
//   • push is unsupported (no Notification / PushManager / service worker)
//   • notifications are already enabled — permission 'granted' or a live
//     subscription. Those users go straight to the chat.
// Not suppressed when permission is 'denied': that is NOT enabled, so the
// card still appears — it offers unblock instructions rather than a prompt
// the browser would silently swallow.

import { icon } from './icons.js';
import { pushSupported, hasActiveSubscription, enablePush } from './push.js';

const DISMISS_KEY = 'afnokamai_push_popup_dismissed';

let popupRoot = null;

/**
 * Show the popup (unless it is suppressed) and wait for the user to deal
 * with it. Resolves as soon as the card is gone — including immediately,
 * when nothing needs asking.
 *
 * The rule, exactly:
 *   enabled (granted / subscribed) OR "Don't show again" ticked → skip, go
 *   straight to the chat. Otherwise → popup first, chat afterwards.
 * A blocked browser ('denied') is NOT "enabled", so those users still get
 * the card — with unblock instructions instead of a prompt that the browser
 * would silently refuse.
 */
export async function promptPushOnRequest() {
  if (popupRoot) return; // never stack two prompts
  let needed = false;
  try { needed = await shouldPrompt(); } catch (_) { needed = false; }
  if (!needed) return;
  await new Promise((resolve) => open(resolve));
}

/** True when this request should interrupt the user with a permission ask. */
async function shouldPrompt() {
  try {
    if (localStorage.getItem(DISMISS_KEY) === 'true') return false; // ticked before
  } catch (_) { /* private mode — treat as not dismissed */ }
  if (!pushSupported()) return false; // nothing to enable on this browser
  if (Notification.permission === 'granted') return false; // already enabled
  if (await hasActiveSubscription()) return false;         // already enabled
  return true; // 'default' → ask, 'denied' → show how to unblock
}

// ── Popup lifecycle ─────────────────────────────────────────────────────────

function open(done) {
  const overlay = document.createElement('div');
  overlay.className = 'ip-overlay';
  overlay.innerHTML = `
    <div class="ip-card" role="dialog" aria-modal="true" aria-labelledby="pp-title">
      <button class="ip-close" aria-label="Close notification popup" title="Close">${icon('x')}</button>
      <div class="ip-icon"><span class="brand" style="color:var(--green-600)">${icon('bell')}</span></div>
      <h2 class="ip-title" id="pp-title">Never miss a message</h2>
      <p class="ip-desc">Turn on notifications so the administrator's reply reaches this device the moment it lands — even when AfnoKamai isn't open.</p>
      <button class="ip-install" id="pp-enable-btn">${icon('bell')} Enable notifications</button>
      <button class="ip-dismiss" id="pp-dismiss-btn">Don't show again</button>
    </div>`;
  document.body.appendChild(overlay);
  popupRoot = overlay;
  const invoker = document.activeElement;

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKey);
    if (popupRoot === overlay) popupRoot = null;
    overlay.classList.remove('open');
    overlay.classList.add('closing');
    setTimeout(() => {
      overlay.remove();
      // Only refocus if the user is still on this document — after a
      // successful enable we are usually mid-navigation to the chat.
      if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) {
        invoker.focus();
      }
      // Resolve only once the card is actually gone: the caller chains its
      // next navigation on this, and firing early would cut the exit
      // animation off with a page change mid-fade.
      done();
    }, 200);
  }

  function onKey(e) {
    if (e.key === 'Escape') finish();
  }
  document.addEventListener('keydown', onKey);

  // Close on overlay click (outside the card), same as the install popup.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) finish();
  });

  // ── Card controls ──
  // Assigned (not added) so re-wiring after a state change replaces the old
  // handler instead of stacking a second one on the same node.
  function wireCard() {
    const closeBtn = overlay.querySelector('.ip-close');
    if (closeBtn) closeBtn.onclick = finish;

    const dismissBtn = overlay.querySelector('#pp-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        try { localStorage.setItem(DISMISS_KEY, 'true'); } catch (_) { /* ok */ }
        finish();
      };
    }

    const enableBtn = overlay.querySelector('#pp-enable-btn');
    if (enableBtn) enableBtn.onclick = () => enable(enableBtn);

    const continueBtn = overlay.querySelector('#pp-continue-btn');
    if (continueBtn) continueBtn.onclick = finish;
  }

  async function enable(btn) {
    btn.disabled = true;
    btn.innerHTML = icon('bell') + ' Turning on…';
    let res;
    try {
      res = await enablePush(); // called straight from the click → valid gesture
    } catch (_) {
      res = { ok: false, reason: 'error' };
    }
    if (res.ok) return showSuccess();
    if (res.reason === 'dismissed') return finish(); // native prompt closed
    return showHelp(res.reason);
  }

  function showSuccess() {
    overlay.querySelector('.ip-card').innerHTML = `
      <button class="ip-close" aria-label="Close notification popup" title="Close">${icon('x')}</button>
      <div class="ip-icon"><span class="brand" style="color:var(--green-600)">${icon('check')}</span></div>
      <h2 class="ip-title" id="pp-title">You're all set</h2>
      <p class="ip-desc">Notifications are on for this device — we'll ping you the moment the administrator replies.</p>`;
    wireCard();
    setTimeout(finish, 1700); // let it read, then continue to the chat
  }

  function showHelp(reason) {
    const msg =
      reason === 'denied'
        ? 'Notifications are blocked for this site. Open the lock (or bell) icon in your browser\'s address bar, allow notifications for AfnoKamai, then request again.'
        : reason === 'device_limit'
          ? 'This account already has the maximum number of notification devices. Remove an old one in Notification settings, then try again.'
          : 'We couldn\'t turn on notifications right now — you can switch them on later from Notification settings.';

    const card = overlay.querySelector('.ip-card');
    const btn = card.querySelector('#pp-enable-btn');
    if (!card.querySelector('.ip-instructions')) {
      const hint = document.createElement('div');
      hint.className = 'ip-instructions';
      hint.innerHTML = `<p>${msg}</p>`;
      // Ahead of the button, not after it: the panel explains why the ask
      // failed, and the button is the way out — reading order should match.
      card.insertBefore(hint, btn || card.querySelector('#pp-dismiss-btn'));
    }
    // Nothing more to do here — the exit becomes "carry on to the chat".
    if (btn) {
      btn.id = 'pp-continue-btn';
      btn.disabled = false;
      btn.innerHTML = 'Continue';
    }
    wireCard();
  }

  wireCard();
  requestAnimationFrame(() => overlay.classList.add('open'));
  setTimeout(() => overlay.querySelector('#pp-enable-btn')?.focus(), 150);
}
