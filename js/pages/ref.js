// ─── Public referral landing page (/ref/CODE or ?ref=CODE) ───────────
// Anonymous-safe: validates the referral code against Firestore
// (referralCodes / referralHandles are public-lookup docs) and captures it
// for the signup form. NOTHING here creates a referral relationship —
// attribution happens only at the end of the registration chain, inside
// js/referral.js finalizeReferral(), which firestore.rules hard-validate.
// Already-signed-in visitors are never re-attributed: ownership is fixed.
import { db, isConfigured } from '../firebase.js';
import { doc, getDoc } from 'firebase/firestore';
import { onAuth } from '../guard.js';
import { mountAside } from '../auth-common.js';
import { icon } from '../icons.js';
import { normalizeCode, normalizeHandle, isValidHandle, storeCapturedCode, copyText } from '../referral.js';
import { toast } from '../ui.js';

mountAside();

const body = document.getElementById('ref-landing-body');

/**
 * Referral link segment from /ref/CODE (hosting rewrite) or ?ref=CODE.
 * Both accepted forms are returned so boot() can resolve which one it is:
 *   code   — the normalised AFK-XXXXXXXX code, when the segment is one
 *   handle — the raw segment, lowercased, for the vanity form (/ref/alex)
 * The handle must NOT be run through normalizeCode(): that would rewrite
 * it into an AFK- prefix and the handle lookup could never match.
 */
function readCodeFromUrl() {
  const fromQuery = new URLSearchParams(location.search).get('ref') || '';
  const m = location.pathname.match(/\/ref\/([^/?#]+)/i);
  const fromPath = m ? decodeURIComponent(m[1] || '') : '';
  const raw = fromPath.trim() || fromQuery.trim();
  return {
    code: normalizeCode(fromQuery) || normalizeCode(fromPath),
    handle: normalizeHandle(raw)
  };
}

function signupUrl(code) {
  return code ? `/signup.html?ref=${encodeURIComponent(code)}` : '/signup.html';
}

function renderGeneric(message) {
  body.innerHTML = `
    <div class="auth-head">
      <h1>You've been invited to AfnoKamai</h1>
      <p>Join AfnoKamai and participate in legitimate earning opportunities.</p>
    </div>
    ${message ? `<p class="hint" style="margin-bottom:14px">${message}</p>` : ''}
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px">
      <a class="btn btn-primary btn-lg" href="${signupUrl('')}">${icon('user')} Create Account</a>
      <a class="btn ghost btn-lg" href="/login.html">${icon('logout')} Login</a>
    </div>
    <p class="hint" style="margin-top:16px">AfnoKamai does not promise income. Rewards depend on completing and getting tasks approved — follow all platform and third-party rules.</p>`;
}

function renderInvalid() {
  body.innerHTML = `
    <div class="auth-head">
      <h1>This referral link isn't valid</h1>
      <p>The referral code could not be found or has expired. You can still join AfnoKamai — just without a referral code.</p>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px">
      <a class="btn btn-primary btn-lg" href="/signup.html">${icon('user')} Create Account</a>
      <a class="btn ghost btn-lg" href="/login.html">${icon('logout')} Login</a>
    </div>`;
}

function renderValid(code, meta) {
  body.innerHTML = `
    <div class="auth-head">
      <h1>You've been invited to AfnoKamai</h1>
      <p>Join AfnoKamai and participate in legitimate earning opportunities. Your Work. Your Kamai.</p>
    </div>
    <div class="kv-cell tone-green" style="margin-bottom:16px">
      <div class="k">Referral code applied</div>
      <div class="v" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
        <span style="letter-spacing:.08em; font-weight:800">${esc(code)}</span>
        <button class="btn ghost btn-sm" id="ref-copy-code">${icon('copy')} Copy</button>
      </div>
      <div class="small muted" style="margin-top:4px">It will be pre-filled when you create your account.</div>
    </div>
    ${meta && meta.handle ? `<p class="hint" style="margin-bottom:12px">Invited through <strong>afnokamainp.web.app/ref/${esc(meta.handle)}</strong></p>` : ''}
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px">
      <a class="btn btn-primary btn-lg" href="${signupUrl(code)}">${icon('user')} Create Account</a>
      <a class="btn ghost btn-lg" href="/login.html">${icon('logout')} Login</a>
    </div>
    <p class="hint" style="margin-top:16px">When someone joins using your link and completes approved tasks, the inviter earns referral rewards — starting with रु15 after the new member's first 2 approved tasks, then रु5 for each approved task after that.</p>`;
  const btn = body.querySelector('#ref-copy-code');
  if (btn) btn.addEventListener('click', async () => {
    const ok = await copyText(code);
    toast(ok ? 'Referral code copied!' : 'Could not copy — the code is shown above.', { type: ok ? 'success' : 'error' });
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function boot() {
  const { code: linkedCode, handle } = readCodeFromUrl();
  if (!isConfigured()) { renderGeneric(''); return; }

  // Already signed in? Never re-attribute an existing account through a URL.
  const authed = await new Promise((resolve) => {
    const unsub = onAuth((u) => { unsub(); resolve(u); });
  });
  if (authed) {
    body.innerHTML = `
      <div class="auth-head">
        <h1>You're already signed in</h1>
        <p>Referral invitations apply to new AfnoKamai accounts. Your current account keeps its existing referral status — nothing changes by opening this link.</p>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px">
        <a class="btn btn-primary btn-lg" href="/dashboard.html">${icon('dashboard')} Go to Dashboard</a>
        <a class="btn ghost btn-lg" href="/referral.html">${icon('link')} My referrals</a>
      </div>`;
    return;
  }

  // The segment must be one of the two accepted shapes — an AFK-XXXXXXXX
  // code or a valid vanity handle (3–30 chars, not reserved) — before we
  // touch the database.
  if (!linkedCode && !isValidHandle(handle)) { renderInvalid(); return; }

  try {
    // Codes are public lookup docs — the anonymous landing page validates
    // them before signup; ownership binding happens later, in rules.
    let code = linkedCode;
    let meta = {};
    let snap = code ? await getDoc(doc(db, 'referralCodes', code)) : null;

    if (!snap || !snap.exists()) {
      // Vanity handle form: /ref/alex → referralHandles/alex → the code.
      // (Also the fall-through for a code-shaped segment that is not a real
      // code, e.g. a handle that happens to look like one.)
      code = '';
      snap = null;
      if (isValidHandle(handle)) {
        const hSnap = await getDoc(doc(db, 'referralHandles', handle));
        if (hSnap.exists()) {
          const d = hSnap.data() || {};
          meta = { handle: d.handle || handle };
          code = normalizeCode(d.code || '');
        }
      }
      if (code) snap = await getDoc(doc(db, 'referralCodes', code));
    }

    if (!code || !snap || !snap.exists()) { renderInvalid(); return; }
    storeCapturedCode(code);
    renderValid(code, meta);
  } catch (_) {
    // Offline / Firestore error — keep the generic invite (never fake a code).
    renderGeneric('We could not verify the referral code right now. You can still create an account and enter a code later.');
  }
}

boot();
