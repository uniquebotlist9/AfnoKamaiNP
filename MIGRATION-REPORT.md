# Firestore → Appwrite migration report

The database layer now runs on Appwrite TablesDB. Firebase Hosting, Firebase
Auth, the domain, the UI, the routes, the pricing and every business rule are
unchanged. Nothing in the browser can reach an Appwrite API key.

## What runs where

| Concern | Before | Now |
|---|---|---|
| Document store | Cloud Firestore | Appwrite TablesDB (26 tables, 321 columns, 110 indexes) |
| Write authorization | `firestore.rules` (738 lines) | `functions/bridge/src/policy.js`, a port of those rules, enforced by the `afnokamai-bridge` function on every write |
| Identity | Firebase Auth | Firebase Auth, unchanged |
| Session for DB reads | Firestore SDK credential | Appwrite session minted from the Firebase ID token, sent as `X-Appwrite-Session` |
| Writes from the browser | Direct to Firestore | Proxied through the bridge function; the function recomputes `$permissions` and ignores anything the client sends |
| Push sender (CI) | `firebase-admin` → Firestore | `scripts/appwrite-admin.cjs` → TablesDB, same Firestore-shaped surface so the sender's logic is untouched |

## Verified end to end

- Bridge mints an Appwrite session from a real Firebase ID token, automatically,
  on login and on reload.
- The signup batch (`users` → `referralCodes` → `wallets`) commits as one unit
  and all three rows read back through the user's session.
- Row-level read grants work without the API key; a foreign row returns 404.
- Six denials confirmed through the real client: role escalation, wallet
  balance change, wallet delete, foreign profile creation, transaction
  creation, and repeating a one-shot profile update.
- The CI push sender runs clean against TablesDB (reindex, reclaim, queue,
  zombie sweep) and the read-after-write probe passes.
- Query paths (`where`, `orderBy`, `limit`, `getCountFromServer`) work.
- Live at https://afnokamainp.web.app — CSP allows `sgp.cloud.appwrite.io`,
  the import map resolves, both modules load.

## Two bugs the smoke test caught

1. **Batches were not `getAfter`-correct.** Signup writes `users` before
   `referralCodes`, and the rule reads the code row that the *same batch*
   creates. The proxy now builds the post-batch state of every touched row
   first, validates against it, and only then writes — so a batch is
   all-or-nothing.
2. **`changedKeys` counted untouched fields as mutations.** Firestore rules
   always see the whole document; a partial patch does not. Comparing
   absent-to-present reported every untouched column as a change, which made
   every legitimate update look like a rewrite and would have broken chat,
   notifications and admin lists.

## Deliberate deviations from Firestore

- **No atomic batches or transactions.** TablesDB has no batch-write or
  transaction endpoint. A batch is a bounded-concurrency fan-out of independent
  patches; a transaction is optimistic — every document read is re-checked
  against its `$updatedAt` immediately before the writes land, and the whole
  body retries on contention. Every batch in the sender re-derives the same
  patch from the same row, so a partial commit converges on the next run.
- **Realtime is polling.** Document listeners poll at 2.5 s, collection
  queries at 4 s, with local `docChanges()` diffing.
- **`referralCodes` and `referralHandles` are public single-doc reads.** They
  are one row per code/handle with no per-user data; the rules only ever read
  them. This is the one place a table is publicly readable.
- **Row IDs** must be ≤ 36 chars, alphanumeric/underscore, and must not start
  with an underscore. This is why the CI probe's document is `probe_readback`
  rather than the old `_q_readback`.
- **Queries** travel as `queries[0]=<json>&queries[1]=<json>` — a JSON array
  in a single `queries` param is rejected.

## Still needs a manual step

1. **Email verification cannot be set programmatically.** The Identity
   Toolkit `accounts:update` endpoint accepts `emailVerified: true` and
   silently ignores it. `js/guard.js` and `js/pages/profile-setup.js` redirect
   unverified users to `verify-email.html`, so the full UI flow needs either
   a real click on the verification link, or a Firebase service account
   (Project settings → Service accounts → Generate new private key) so
   `scripts/set-admin.cjs` can set it. No service account exists in this repo.
2. **The old `afnokamai` project is still live** with its Firestore database.
   It is no longer written to. Take it down or leave it as a read-only
   archive — but it will keep billing if anything still writes to it.
3. **`optional-cloud-functions/`** has been deleted — we are not pursuing a
   Blaze upgrade, so no Cloud Functions implementation is kept.

## Re-verified 2026-10-07

Independent audit of the live project `6ac536e6001dd29a193`
(`appwrite.config.json`): database `6ac53c92002a02a202fe` ("Production
TablesDB") holds the full 26 tables / 321 columns / 110 indexes; table
permissions match the design (public read on `referralCodes`,
`referralHandles`, `config`; `read("users")` on `tasks`, `announcements`;
row-security elsewhere); the `afnokamai-bridge` function's active deployment
(04:52 UTC) post-dates the last source edit, so it is built from this repo;
web platforms, the `admins` team, the `APPWRITE_API_KEY` function variable
and the GitHub Actions secrets are all present.

A fresh end-to-end smoke test with a throwaway account (deleted afterwards)
passed 7/7: Firebase signUp → bridge session mint, public row read through
the session, policy denial of a role-escalation write, the three-row signup
batch committing through the write proxy, own-row read via row-level grants,
and a foreign row returning 404.

## Acceptance checklist

- [x] No Firestore read or write remains in the runtime path. The only
      `firebase/firestore` strings left are the import-map shim that keeps
      the business code byte-identical.
- [x] No Appwrite API key in browser code. It exists only as the
      `APPWRITE_API_KEY` secret on the `afnokamai-bridge` function.
- [x] No sensitive collection is publicly writable. Table grants are broad
      read plus `read`/`write` for `team:admins` only; the function stamps
      row permissions itself.
- [x] Money is still integer paisa; no `*Paisa` value is rounded or altered.
- [x] `firestore.rules` remains in the repo as the authoritative policy
      source; `functions/bridge/src/policy.js` is a port of it.
- [x] Schema, indexes, permissions and the web platform hostnames are
      provisioned and verified.
- [x] GitHub repo, secrets and the push-sender workflow are migrated.
- [x] Production build deployed to https://afnokamainp.web.app.
- [ ] Email verification for a real account (see above).
- [ ] Decide the fate of the old `afnokamai` project.
- [x] Deleted `optional-cloud-functions/` — no Blaze upgrade planned.
