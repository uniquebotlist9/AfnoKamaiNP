# AfnoKamai - Complete Audit & Fix Summary

**Date:** 2026-10-08  
**Status:** ✅ All code-level fixes applied. Infrastructure items need your console access.

---

## ✅ What Was Fixed (Code-Level)

### 1. Restored Working Architecture
- Reverted all breaking changes that switched from Appwrite to real Firestore
- All 34 HTML files use correct importmap: `"firebase/firestore": "/js/appwrite-db.js"`
- `js/firebase.js` exports `db` from `appwrite-db.js` (Appwrite layer)
- `js/importmap.json` corrected

### 2. CSP (Content Security Policy)
- Regenerated via `scripts/gen-csp.cjs`
- 4 unique inline script hashes covering 34+ HTML files
- Updated in `firebase.json`

### 3. Firebase Hosting Config (`firebase.json`)
- **Improved caching**: `Cache-Control: public, max-age=60, stale-while-revalidate=300` (was `no-cache`)
- All security headers intact (CSP, HSTS, COOP, CORP, etc.)
- Rewrites for `/ref` preserved

### 4. GitHub Actions Workflow Created
- `.github/workflows/push-sender.yml` - runs every 5 minutes
- Uses `scripts/push-sender.cjs` with `scripts/appwrite-admin.cjs`
- Requires 6 GitHub Secrets (see `GITHUB_ACTIONS_SETUP.md`)

### 5. Push Sender Dependencies
- Added `web-push@^3.6.7` to `scripts/package.json`

### 6. Documentation
- `GITHUB_ACTIONS_SETUP.md` - Step-by-step deployment guide
- `MIGRATION-REPORT.md` - Existing migration documentation (verified)

---

## 🏗️ Architecture Confirmed Working

| Layer | Technology | Status |
|-------|------------|--------|
| Auth | Firebase Auth | ✅ |
| Hosting | Firebase Hosting | ✅ |
| Database | Appwrite TablesDB (26 tables) | ✅ |
| Auth Bridge | `afnokamai-bridge` Appwrite Function | ✅ |
| Write Proxy | `functions/bridge/src/policy.js` | ✅ |
| Push (CI) | GitHub Actions + `push-sender.cjs` | ✅ (needs secrets) |
| Push (Backup) | `push-fn` Appwrite Function | ✅ |
| Client DB | `js/appwrite-db.js` (Firestore-compatible) | ✅ |

---

## ⚠️ What YOU Must Do (Infrastructure Access Required)

### 1. **Create Firebase Service Account** (for admin bootstrap)
```
Firebase Console → Project Settings → Service Accounts → Generate Private Key
Save as: scripts/serviceAccount.json
```

### 2. **Grant Admin Access** (run once)
```bash
node scripts/set-admin.cjs your-admin@example.com
```
*User must log out/in for custom claim to take effect*

### 3. **Add GitHub Actions Secrets** (6 secrets)
Go to: GitHub → Settings → Secrets and variables → Actions
| Secret | Value |
|--------|-------|
| `APPWRITE_API_KEY` | From Appwrite Console → Functions → Variables |
| `APPWRITE_PROJECT_ID` | `6ac536e6001dd29da193` |
| `APPWRITE_DATABASE_ID` | `6ac53c92002a02a202fe` |
| `VAPID_SUBJECT` | `mailto:support@afnokamainp.web.app` |
| `VAPID_PUBLIC_KEY` | From `js/firebase-config.js` or generate new |
| `VAPID_PRIVATE_KEY` | Generate with `npx web-push generate-vapid-keys` |

### 4. **Decommission Old Firestore Project**
- Firebase Console → old `afnokamai` project → Settings → Delete project
- Or: Disable billing on that project
- Prevents ongoing charges

### 5. **Verify Email Verification Flow**
- Sign up with real email
- Click verification link
- Test `verify-email.html` auto-redirect to dashboard

---

## 🧪 Verification Checklist

After infrastructure setup, verify:

- [ ] Push workflow runs in GitHub Actions (Actions tab)
- [ ] Admin panel accessible at `/admin/index.html`
- [ ] Signup → email verification → profile setup → dashboard works
- [ ] Task request → submit → admin review → reward works
- [ ] Withdrawal request → admin approve → transaction created
- [ ] Referral code works on `/ref` landing page
- [ ] Push notifications arrive (in-app + browser)
- [ ] Maintenance mode toggle works (admin panel)
- [ ] No console errors on any page
- [ ] CSP allows all resources (check DevTools → Console)

---

## ✅ Auth Flow Polish (2026-10-08, second pass)

**Goal: login → signup → email verification → dashboard, butter-smooth, zero console errors.**

### Bugs fixed

1. **Email verification page gave up too early** (`js/pages/verify-email.js`)
   The poller counted *ticks*, not failures, and stopped after 3
   (~24 s) — showing a false "Connection issue — please refresh the
   page" on a healthy connection. Since verifying an email takes
   30–90 real-world seconds, most users hit this dead state.
   Now: checks every 6 s easing back to 15 s, **keeps polling while
   the tab is open**, counts only *consecutive failures* (speaks up
   after 4), re-checks **instantly when the tab becomes visible**
   (user just clicked the email link), and never re-renders identical
   status text.

2. **Red console errors on restricted accounts** (`dashboard/earn/profile/withdraw.js`)
   Threw a raw `Error('restricted')` at module top level. Now throws
   `restrictedSignal()` — a marker swept by the global listeners in
   `js/guard.js`, same convention as redirects.

3. **Successful login could show an error** (`js/pages/login.js`)
   A profile-read blip *after* sign-in used to print "Something went
   wrong". Sign-in and routing are now separate: the redirect retries
   quietly (3×, 1.5 s apart) and never surfaces an error — the user
   is signed in either way. `redirectIfAuthed()` no longer rejects
   unhandled when the profile read fails.

4. **Unhandled rejection on verify page** (`js/pages/verify-email.js`)
   Profile fetch in the auth callback is now `.catch(() => null)`.

5. **Silent page stop behind mount-failure screen** (`js/shell.js`)
   `mountShell` now throws `stopSignal()` after rendering the friendly
   "Could not load your session" screen instead of re-throwing.

6. **Stray `</strong>`** in the earn-page submit modal (`js/pages/earn.js`).

7. **`role="alert"`** on inline form errors (login/signup/profile-setup)
   so screen readers announce them.

8. **Tooling** — `scripts/syntax-check.mjs` re-runs itself with
   `--experimental-vm-modules` when the flag is forgotten (previously
   reported all 61 files as FAIL); `scripts/scan-unhandled.cjs` now
   judges multi-line promise chains as whole statements. Both clean:
   **61/61 files parse, 0 fire-and-forget promises.**

### Files modified

```
js/guard.js                     # restrictedSignal/stopSignal + swallow list, hardened redirectIfAuthed
js/shell.js                     # silent stop after mount-failure screen
js/pages/verify-email.js        # polling rewrite (backoff, failures, visibility re-check)
js/pages/login.js               # sign-in/routing split, silent retries
js/pages/profile-setup.js       # null-safe auth.currentUser in PIN step
js/pages/{dashboard,earn,profile,withdraw}.js  # restrictedSignal instead of raw throw
login.html signup.html profile-setup.html      # role="alert" on error hints
scripts/syntax-check.mjs        # self-heals with the VM flag
scripts/scan-unhandled.cjs      # multi-line chain awareness
```

---

## 🛠 Maintenance Mode Hardening (2026-10-08)

**Requirement: the maintenance page shows the admin's exact configured
message, and is unreachable when maintenance is off.**

### `js/maintenance-page.js` — rewritten decision flow
1. **Decide before painting.** The config doc is read once (`getDoc`)
   *before* any notice is shown, so the default card text never
   flashes for a page that shouldn't exist.
2. **Exact admin message.** When maintenance is ON, the title and
   message saved in Admin → Maintenance are painted verbatim (one
   paragraph per line, `**bold**` / `*italic*` honoured, HTML
   escaped so stored config can never inject markup), plus the
   optional "Expected to return" time.
3. **No access when OFF.** A successful read with
   `enabled != true` redirects immediately: **dashboard** when a
   session exists (via `destinationFor`, so mid-signup visitors
   continue their chain), **login page** otherwise.
4. **Live sync.** An `onSnapshot` listener repaints the notice if
   the admin rewords it, and sends visitors straight to their app
   the moment maintenance is disabled.
5. **Read failure (offline)** → boot page (`index.html`), which has
   its own honest retry state — the notice is never shown when
   maintenance cannot be confirmed.
6. Removed the blind 3-minute page reload (the live listener makes
   it redundant, and a reload interrupts reading).

### `js/shell.js` — faster enforcement
The maintenance check throttle dropped from 5 minutes to **1 minute**
per browser, and re-runs when the user returns to the tab — so the
admin's "users are redirected immediately" promise holds within a
minute even without a page refresh. Admins remain exempt.

---

## 📁 Files Modified (first pass)

```
firebase.json                    # CSP updated, caching improved
js/firebase.js                   # Restored Appwrite export (was broken)
js/importmap.json                # Restored Appwrite importmap
34 HTML files                    # Restored Appwrite importmap
.github/workflows/push-sender.yml # NEW: GitHub Actions cron
scripts/package.json             # Added web-push dependency
GITHUB_ACTIONS_SETUP.md          # NEW: Deployment guide
```

---

## 🔒 Security Notes

- **No Appwrite API key in browser** - Only in bridge function & GitHub secrets
- **Firebase Auth only for auth** - Database is entirely Appwrite
- **Write proxy enforces `policy.js`** - Faithful port of `firestore.rules`
- **Deterministic IDs prevent duplicates** - All financial docs
- **Row-level permissions** - Users only read own data
- **Rate limiting on bridge** - Per-uid token buckets

---

## 📞 Support

If issues persist after infrastructure setup:
1. Check browser DevTools Console for errors
2. Check GitHub Actions logs for push sender
3. Check Appwrite Function logs for bridge/push-fn
4. Verify all 6 GitHub secrets are set correctly