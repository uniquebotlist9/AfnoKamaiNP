// ─── Admin: permanent account deletion ───────────────────────────────
//
// The one action a browser cannot perform on its own: killing the Firebase
// Auth login (the Gmail), the mirrored Appwrite identity and every row the
// person owns. It is a single call to the bridge function's `delete-user`
// action, which re-verifies the `admin` custom claim server-side and also
// refuses self-deletion, admin targets and unconfirmed requests — the
// checks below exist only to fail fast with a readable message.
//
// Deliberately imports ONLY exports that predate this feature (auth, api,
// APPWRITE_AUTH_FUNCTION_ID): the entry script is cache-busted on deploy
// while its dependencies can be served from the HTTP/service-worker cache
// for up to an hour, and consuming a *new* named export from a stale copy
// would break the whole page for exactly that hour.

import { auth } from '../../firebase.js';
import { api, APPWRITE_AUTH_FUNCTION_ID } from '../../appwrite.js';

/**
 * POST a payload to the bridge and unwrap the Appwrite execution envelope.
 *
 * Mirrors executeWrite() in js/appwrite.js: the Firebase ID token travels in
 * the body because the executions API does not reliably forward request
 * headers, and it is refreshed once when an attempt comes back 401.
 */
async function invokeBridge(payload) {
  let attempt = 0;
  for (;;) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be signed in to do that.');
    const idToken = await user.getIdToken(attempt > 0);

    const out = await api('POST', `/functions/${APPWRITE_AUTH_FUNCTION_ID}/executions`, {
      body: JSON.stringify(Object.assign({}, payload, { idToken })),
      async: false,
      headers: JSON.stringify({ 'content-type': 'application/json' })
    });

    let body = null;
    try {
      body = out && out.responseBody ? JSON.parse(out.responseBody) : null;
    } catch (_) { body = null; }
    const status = (out && out.responseStatusCode) || 500;

    if (status === 401 && attempt === 0) { attempt += 1; continue; }
    if (status >= 300 || !body || body.ok !== true) {
      throw new Error((body && body.error) || `Request failed (${status})`);
    }
    return body;
  }
}

/**
 * Permanently delete a user's account and all of their records.
 *
 * @param {{ uid: string }} target
 * @returns {Promise<{ uid: string, rows: Record<string, number>, totalRows: number }>}
 */
export async function deleteUserAccount({ uid }) {
  if (!uid) throw new Error('No user selected.');
  const me = auth.currentUser;
  if (!me) throw new Error('You must be signed in to do that.');
  if (me.uid === uid) throw new Error('You cannot delete your own account.');
  return invokeBridge({ action: 'delete-user', uid, confirm: true });
}
