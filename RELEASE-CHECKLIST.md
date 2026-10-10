# Chat, notifications and secure-withdrawal release

## Status

Implemented locally, with synthetic/offline checks. This document is **not a
deployment receipt**. No production rows, permissions, credentials or functions
were changed by the implementation session. Do not claim that the live site is
running these repairs until the coordinated cutover and smoke checks succeed.

## Before deployment

1. Back up Appwrite schema, permissions and financial records through the
   existing authorized backup procedure. Do not copy private exports into Git.
2. Use a staging project and synthetic user/admin accounts to validate the native
   transaction behavior. The local tests model it; they are not a cloud probe.
3. Check the Function runtime is Node 22+ and the API key has only the necessary
   table/row, transaction, user/session and team scopes.
4. Configure server-only environment variables through the deployment console:
   `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_DATABASE_ID`,
   `APPWRITE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, and
   `WITHDRAWAL_ATTESTATION_SECRET` (at least 32 random bytes). Never paste secret
   values into chat or browser JavaScript. Retain the attestation key while
   outstanding requests refer to it; rotation requires a planned migration.
5. Configure push VAPID values in the worker/Actions secret store, not frontend
   code. See `functions/push-fn/README.md` for worker runtime/timeout requirements.

## Required schema and permissions

- New table **`bridgeSecurity`**, row security enabled, table and row grants `[]`.
  Required string column `state`, size 2048. Row `write-barrier` initially has
  `{ "state": "initial" }`. PIN attempt counters also live here, server-only.
- Withdrawal columns must accept `pinProofAlgo: "server-verified-v1"`, a
  64-character `pinProof` HMAC, `pinIterations: 0`, and `pinSaltUsed: ""`.
  No extra withdrawal columns are needed. Legacy hashes are not accepted as new
  authorizations; reject pending legacy requests and ask for secure resubmission.
- `notificationLog.attempts`: optional integer with default 0. If statuses are
  enums, include notification states `partial` and `unknown`, and delivery-log
  states `sending` and `unknown`, as listed in the push worker README.
- Verify indexes for the user/status hold query, withdrawal history, notification
  filters and message/conversation pagination. No private hash is browser-readable.
- Apply table **and existing-row** ACL repairs: messages grant their validated
  conversation participant read access; browser write grants, including admin
  writes, are removed. All normal writes go through the policy bridge.

## Cutover order

1. Put the site into a controlled maintenance window and stop old admin clients
   and writers. Do not rely on the maintenance banner as a database lock.
2. Review the CLI's plan using environment-provided credentials:
   ```sh
   node scripts/repair-appwrite-acl.cjs --provision-security
   ```
   This is dry-run by default. Inspect every intended table/permission change.
3. Only after operator approval, provision/repair against the explicit project:
   ```sh
   node scripts/repair-appwrite-acl.cjs --provision-security --apply --confirm-project=<PROJECT_ID>
   ```
4. Deploy the complete bridge source with its secure actions and dependencies;
   deploy the push worker and configured event/scheduled triggers. Run a staging
   transaction rollback/conflict smoke test before allowing money operations.
5. Deploy Firebase Hosting from the reviewed workspace (`firebase deploy --only
   hosting`) using the existing project selection. Legacy Firestore rules, if
   still needed, are a separate deployment; `firebase.json` currently has no
   active Firestore deployment configuration.
6. Close old tabs and reopen so the new versioned service worker can activate.
   Do not force mixed frontend/bridge protocol versions to coexist. Verify the
   HTML, modules and worker come from the same release.
7. Validate the smoke checks below, then end the maintenance window.

Administrator demotion must use the updated `scripts/set-admin.cjs --remove`
workflow or an equivalent operator action that removes Firebase claims, revokes
refresh tokens, removes Appwrite team membership and revokes mirrored sessions.
Changing only a profile `role` field is not access revocation.

The transaction barrier protects all bridge writers. Any privileged financial
maintenance tool using an API key must use the same transaction protocol or run
with all other writers stopped. API-key operations bypass row permissions.

## Staging smoke checks (not yet executed against a deployed project)

Use synthetic accounts, balances and message text; never test transfers with
real money or share browser authentication data.

- **Mobile admin chat:** 360/390/768px, portrait/landscape and iOS/Android keyboard.
  List visible initially; open a thread and Back; deep-link to an older user;
  composer and attachments reachable without page overflow; long text/media fit.
- **Desktop chat:** two panes, conversation search/pagination, scroll up while a
  new message arrives, load older messages, resize, background/return and switch
  conversations rapidly. No unwanted jump or stale thread repaint.
- **Delivery:** user/admin text, photo and PDF; temporarily drop the response
  after server commit. Check delivery must find the original message and must
  not create a duplicate or increment unread twice. Unviewed messages stay unread.
- **Permissions:** new and historical admin/system messages are readable by the
  intended user only. Normal users cannot read another conversation, private
  PIN records, internal notes or the bridge-security table.
- **Notifications:** badge/read state after opening a message, pagination and
  mark-all-read with >100 rows; no old-alert toast storm. Test denied permission,
  device rotation, remote-device removal, logout/account switch, mixed-device
  push outcomes and provider failures. Inspect sanitized worker receipts.
- **Withdrawal:** accounts with 0/1/49/50 approved tasks and NPR500 balance may
  apply; NPR499.99 is rejected. Wrong PIN, insufficient funds, concurrent request
  and duplicate requestId are handled safely. Rules/Terms still mention50.
- **Payment consistency:** concurrent admins, failed third stage and dropped
  commit response cannot produce half a wallet/ledger update or duplicate debit.
  A legacy request requires rejection and secure resubmission before processing.
- **PIN/security:** initial onboarding, change after recent reauthentication,
  rejection of stale authentication, attempt limit, ban and admin demotion.
- **UI:** keyboard-only dialogs, dark contrast, focus restoration, reduced
  motion, offline errors and install-prompt dismissal across navigation.

## Rollback

Do not restore the old frontend while leaving only the new write protocol, or
restore permissive ACLs to make old clients work. Keep maintenance enabled,
disable financial writes, and roll forward the affected coordinated component
or restore a tested compatible release/schema/permission set from backup. Native
transaction conflicts are retryable only when explicitly reported precommit;
timeouts require checking durable state rather than blindly resending.

## Local verification

Run `npm run check` from `scripts/`. It covers:

- JavaScript parsing; named exports; local HTML/module references.
- CSP hash inventory, including import maps with browser-normalized newlines.
- Static dark-theme color-pair scan (not a full WCAG certification).
- 25 bridge/policy/native-transaction model checks.
- 15 adapter/session/wallet checks.
- 12 chat rendering/state/delivery/lifecycle checks.
- 18 notifications/push/worker checks.
- 3 user-facing secure-action/withdrawal-policy contract checks.

Both package directories have locked dependencies. Run `npm audit --omit=dev`
in `scripts/` and `functions/push-fn/` separately. Do not interpret a green local
test run as proof of real push arrival, cloud permissions, mobile keyboard
behavior or live eSewa transfer success.

For a backend-free rendering check, run `node scripts/preview-chat.cjs` and open
`http://127.0.0.1:4387/?uid=demo-user`. It mounts the real chat component against
synthetic in-memory data, binds only to loopback, blocks external connections,
and serves an explicit source-file allowlist. It cannot send real messages or
access accounts. The local HTTP response was verified; the built-in browser
timed out opening this preview, so rendered/mobile visual checks remain pending.
