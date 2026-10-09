# AfnoKamai - Fixes for CSS Error & Stuck Loading Issue

## Issues Fixed

### 1. **Race Condition in `routeOnBoot` (Main Cause of "Stuck" Loading)**
**File:** `js/guard.js`
- Added explicit wait for Appwrite session before calling `fetchProfile`
- Added 10-second timeout for Appwrite session readiness
- Added graceful fallback if Appwrite session fails (proceeds anyway)
- Added error handling for `fetchProfile` failures - redirects to login instead of hanging

### 2. **Service Worker Stale Cache**
**File:** `sw.js`
- Bumped version from `afnokamai-v12` to `afnokamai-v13`
- Forces cache invalidation for all users

### 3. **Boot Timeout & Error Handling**
**File:** `js/pages/boot.js`
- Reduced timeout from 12s to 8s for faster feedback
- Added console logging for debugging (`[boot] Starting routeOnBoot`, `[boot] stage:`, `[boot] routeOnBoot error:`)
- Better error recovery

### 4. **Firebase Auth Error Handling**
**File:** `js/firebase.js`
- Added try/catch around `onAuthStateChanged` callback
- Logs errors without breaking auth state flow

### 5. **Importmap Browser Compatibility**
**File:** `index.html`
- Added `es-module-shims` polyfill from CDN for older browsers
- Fixed importmap to correctly map `firebase/firestore` → `/js/appwrite-db.js` (was incorrectly changed to Firebase SDK)

### 6. **Profile Fetch Timeout**
**File:** `js/guard.js`
- Added 8-second timeout with AbortController for `fetchProfile`
- Prevents indefinite hanging on network issues

## Deployment Steps

```bash
# 1. Deploy to Firebase Hosting
firebase deploy --only hosting

# 2. Verify deployment
# Visit https://afnokamainp.web.app/ and check:
# - No "Taking you to AfnoKamai..." stuck state
# - Console shows "[boot] Starting routeOnBoot" and stage messages
# - Page redirects to login.html (if not authenticated) or dashboard.html (if authenticated)
```

## Verification Checklist

- [ ] Site loads without "stuck" loading state
- [ ] Console shows boot stage messages
- [ ] Unauthenticated users redirect to `login.html`
- [ ] Authenticated users redirect to appropriate page (dashboard/profile-setup/verify-email)
- [ ] No CSP violations in console
- [ ] CSS loads correctly (no layout issues)
- [ ] Service worker updates to v13 (check Application tab > Service Workers)

## If Issues Persist

### Check Appwrite Bridge Function
The `ensureAppwriteSession` calls an Appwrite Function (`afnokamai-bridge`). Verify:
1. Function is deployed in Appwrite Console
2. Function has correct permissions
3. Function returns `{ secret: "..." }` on success

### Check Firebase Configuration
Verify in Firebase Console:
1. Authorized domains include `afnokamainp.web.app` and `afnokamainp.firebaseapp.com`
2. Auth providers (Email/Password) are enabled
3. API key matches `js/firebase-config.js`

### Check Network Connectivity
- Appwrite endpoint: `https://sgp.cloud.appwrite.io/v1`
- Firebase endpoints: `https://www.gstatic.com`, `https://identitytoolkit.googleapis.com`
- CDN: `https://cdn.jsdelivr.net`, `https://fonts.googleapis.com`, `https://fonts.gstatic.com`

### Browser Console Errors to Watch For
- `Failed to load module script` - Importmap/module resolution issue
- `Content Security Policy violation` - CSP blocking resource
- `Appwrite session timeout` - Bridge function not responding
- `fetchProfile error` - Database query failing

## Files Modified

| File | Change |
|------|--------|
| `js/guard.js` | Fixed race condition, added timeouts, error handling |
| `js/pages/boot.js` | Reduced timeout, added logging |
| `js/firebase.js` | Added error handling for auth state callback |
| `sw.js` | Version bump to v13 |
| `index.html` | Added es-module-shims, fixed importmap |
| `firebase.json` | No changes needed (CSP already allows CDN) |

## Rollback Plan

If issues occur after deployment:
```bash
# Revert to previous version
firebase hosting:clone SOURCE_SITE:TARGET_SITE
# Or redeploy previous known-good commit
git checkout <previous-commit> -- .
firebase deploy --only hosting
```