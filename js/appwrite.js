// ─── AfnoKamai Appwrite configuration + REST transport ────────────────
//
// Database layer: Appwrite (region sgp).
// Auth: Firebase Authentication (unchanged).
// Hosting: Firebase Hosting (unchanged).
//
// These values are public project identifiers, like the Firebase web keys
// that already ship in firebase-config.js. No API key, secret or server
// credential is ever written here: every request the browser makes is
// authenticated with the caller's own Appwrite session, and row permissions
// are enforced by the tables' read grants.
//
// Writes never go straight to the database. js/appwrite-db.js routes every
// create/update/delete through APPWRITE_AUTH_FUNCTION_ID, an Appwrite
// Function that verifies the caller's Firebase ID token and applies the
// ported firestore.rules before touching a row with the server API key
// (see functions/bridge/src/policy.js). That separation is what lets the
// browser hold no secret at all.
//
// NEVER place an APPWRITE_API_KEY, a service-account JSON or any other
// privileged credential in this file.

export const APPWRITE_ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';
export const APPWRITE_PROJECT_ID = '6ac536e6001dd29da193';
export const APPWRITE_DATABASE_ID = '6ac53c92002a02a202fe';

// Appwrite Function acting as the auth bridge and the write proxy.
export const APPWRITE_AUTH_FUNCTION_ID = 'afnokamai-bridge';

// ── Session state ─────────────────────────────────────────────────────
// Appwrite authorises per-row read permissions with a session secret minted
// by the bridge. The Firebase session stays authoritative: we only mint an
// Appwrite session after Firebase has already authenticated the user.
let sessionSecret = null;
let bridgeUser = null;
let bridgeInFlight = null;
let lastBridgeAttempt = 0;

const BRIDGE_RETRY_COOLDOWN_MS = 10000;

export function hasAppwriteSession() {
  return !!sessionSecret;
}

export function setAppwriteSession(secret) {
  sessionSecret = secret || null;
  return sessionSecret;
}

export function clearAppwriteSession() {
  sessionSecret = null;
}

/** Remember the Firebase user so writes can fetch an ID token on demand. */
export function setBridgeUser(user) {
  bridgeUser = user || null;
  if (!bridgeUser) {
    clearAppwriteSession();
    bridgeInFlight = null;
  }
}

export function getBridgeUser() {
  return bridgeUser;
}

// ── Transport ─────────────────────────────────────────────────────────

/** Firestore-shaped error: code strings that js/api.js and friends map. */
function appwriteError(status, payload) {
  const type = (payload && payload.type) || '';
  let code = 'unknown';
  if (status === 401 || status === 403) code = 'permission-denied';
  else if (status === 404) code = 'not-found';
  else if (status === 409) code = 'already-exists';
  else if (status === 412) code = 'failed-precondition';
  else if (status === 429) code = 'resource-exhausted';
  else if (status === 400) code = 'invalid-argument';
  else if (status === 503 || status === 504) code = 'unavailable';
  else if (status >= 500) code = 'internal';
  if (type.includes('rate') || type.includes('quota')) code = 'resource-exhausted';
  const err = new Error((payload && payload.message) || `Appwrite request failed (${status})`);
  err.code = code;
  err.status = status;
  err.type = type;
  return err;
}

async function raw(method, path, body) {
  const headers = {
    'X-Appwrite-Project': APPWRITE_PROJECT_ID,
    'Content-Type': 'application/json'
  };
  if (sessionSecret) headers['X-Appwrite-Session'] = sessionSecret;

  let res;
  try {
    res = await fetch(APPWRITE_ENDPOINT + path, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body)
    });
  } catch (e) {
    // Network failure — mirror Firestore's offline code so existing
    // friendly error copy still triggers.
    const err = new Error("You're currently offline. Check your connection and try again.");
    err.code = 'network-request-failed';
    err.cause = e;
    throw err;
  }

  if (res.status === 204) return null;
  let payload = null;
  try { payload = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) throw appwriteError(res.status, payload);
  return payload;
}

/**
 * Authenticated Appwrite call. Waits for an in-flight bridge so the first
 * read after signing in cannot race the session, and re-bridges once when a
 * session has expired under a long-lived page.
 */
export async function api(method, path, body) {
  if (bridgeInFlight) {
    try { await bridgeInFlight; } catch (_) { /* bridge failure surfaces below */ }
  } else if (bridgeUser && !sessionSecret) {
    await ensureAppwriteSession(bridgeUser);
  }

  try {
    return await raw(method, path, body);
  } catch (e) {
    if (e && e.status === 401 && bridgeUser && sessionSecret) {
      clearAppwriteSession();
      const revived = await ensureAppwriteSession(bridgeUser, true);
      if (revived) return raw(method, path, body);
    }
    throw e;
  }
}

// ── Function invocations ──────────────────────────────────────────────
// The Appwrite REST `data` parameter is not forwarded to the function on
// this version; `body` is (probed: payloads up to 2 MB arrive intact).

function parseExecution(out) {
  let body = null;
  try {
    body = out && out.responseBody ? JSON.parse(out.responseBody) : null;
  } catch (_) {
    body = null;
  }
  return { status: (out && out.responseStatusCode) || 500, body };
}

async function invokeFunction(payload) {
  return raw('POST', `/functions/${APPWRITE_AUTH_FUNCTION_ID}/executions`, {
    body: JSON.stringify(payload),
    async: false,
    headers: JSON.stringify({ 'content-type': 'application/json' })
  });
}

function executionError(status, body) {
  const err = new Error((body && body.error) || `Request failed (${status})`);
  err.status = status;
  err.type = body && body.type;
  // The function already speaks Firestore's vocabulary; fall back to the
  // HTTP mapping when it could not produce a body.
  err.code = (body && body.code) || appwriteError(status, body || {}).code;
  return err;
}

/**
 * Exchange a verified Firebase ID token for an Appwrite session so per-row
 * read permissions can address the real user. Firebase Auth remains the only
 * credential users ever see; this just mirrors its identity into Appwrite.
 *
 * Returns true when a session was established. Failures are non-fatal: the
 * app then runs in guest mode and permission failures surface as the
 * friendly errors js/api.js already expects.
 */
export async function ensureAppwriteSession(user, force) {
  setBridgeUser(user || null);
  if (!user) return false;
  if (sessionSecret && !force) return true;
  if (!APPWRITE_AUTH_FUNCTION_ID) return false;
  if (bridgeInFlight && !force) return bridgeInFlight;

  // A bridge that just failed (offline, revoked token) must not be retried on
  // every read — that would turn one broken credential into a rate limit.
  if (!force && Date.now() - lastBridgeAttempt < BRIDGE_RETRY_COOLDOWN_MS && !sessionSecret) {
    return false;
  }
  lastBridgeAttempt = Date.now();

  bridgeInFlight = (async () => {
    try {
      const out = await invokeFunction({ action: 'bridge', idToken: await user.getIdToken(!!force) });
      const { status, body } = parseExecution(out);
      if (status >= 300 || !body || !body.secret) {
        console.warn('[appwrite] bridge failed:', status, body && body.error);
        return false;
      }
      sessionSecret = body.secret;
      return true;
    } catch (e) {
      console.warn('[appwrite] session bridge failed:', e && e.code, e && e.message);
      return false;
    } finally {
      bridgeInFlight = null;
    }
  })();
  return bridgeInFlight;
}

/**
 * The write proxy: the only way this app mutates a row.
 *
 * `payload` is `{ op, table, rowId, data }`; the Firebase ID token travels
 * in the body because the Appwrite execution API does not forward arbitrary
 * request headers reliably.
 */
export async function executeWrite(payload) {
  if (!APPWRITE_AUTH_FUNCTION_ID) {
    const err = new Error('Saving is unavailable right now. Please try again shortly.');
    err.code = 'failed-precondition';
    throw err;
  }
  if (!bridgeUser) {
    const err = new Error('You must be signed in to do that.');
    err.code = 'permission-denied';
    throw err;
  }

  let attempt = 0;
  for (;;) {
    // forceRefresh on the second pass: a rejected token is usually an
    // expired one, and getIdToken(true) mints a fresh copy.
    const idToken = await bridgeUser.getIdToken(attempt > 0);
    let out;
    try {
      out = await invokeFunction(Object.assign({}, payload, { idToken }));
    } catch (e) {
      if (e && e.status === 401 && attempt === 0) { attempt += 1; continue; }
      throw e;
    }
    const { status, body } = parseExecution(out);
    if (status === 401 && attempt === 0) { attempt += 1; continue; }
    if (status >= 300) throw executionError(status, body);
    return body;
  }
}
