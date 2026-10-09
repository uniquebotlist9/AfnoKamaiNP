'use strict';

// ─── AfnoKamai — Web Push sender (Appwrite Function) ─────────────────────
//
// Why this exists: the GitHub Actions cron that used to drain this queue on
// `*/5` fired hours apart in practice — GitHub's scheduler drops most ticks
// — so a chat reply could sit queued until the following morning. This
// Function is triggered by the notification row's own creation, so the push
// leaves within a couple of seconds of the message; an every-five-minutes
// schedule is kept as a backstop, and the GitHub sender still runs as a
// second one.
//
// The queue protocol is deliberately identical to scripts/push-sender.cjs:
//   queued -> sending (claim) -> sent | skipped | failed | retrying
// Claims here are optimistic rather than transactional, but a lost race at
// worst double-sends, and the payload's `tag` is the notification id — the
// OS collapses the duplicate into the same notification bubble.
//
// Honesty note: web-push only confirms the *provider accepted* the message.
// We therefore record `sent`, never `delivered` — an OS that has since
// revoked permission will still report success at this layer.

const admin = require('./appwrite-admin.cjs');
const webpush = require('web-push');

// Checked before anything else runs, because every way this can be wrong
// otherwise surfaces as a different cryptic failure much later: a missing
// VAPID value only shows up as a web-push TypeError after the queue has
// already been read. A Function that cannot run should say so in one
// sentence an execution log can act on.
const REQUIRED_ENV = [
  'APPWRITE_API_KEY',
  'APPWRITE_PROJECT_ID',
  'APPWRITE_DATABASE_ID',
  'VAPID_SUBJECT',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY'
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);

const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;

// Transient (retry later) vs terminal (never retry) push failures.
const RETRYABLE = new Set([
  429, // provider rate limit
  500, 502, 503, 507, 509
]);
const TERMINAL = new Set([
  404, // endpoint gone — subscription must be retired
  410  // Gone — explicitly expired/revoked by the browser or OS
]);

const MAX_ATTEMPTS = 3;
const BATCH = 100;
const CLAIM_TTL_MS = 10 * 60 * 1000; // a crashed run's claim expires

// The function's own timeout is 30s; fail with a named phase well before
// the runtime cuts us off, so the log says where it stopped instead of
// just ending mid-sentence.
const RUN_DEADLINE_MS = Number(process.env.SENDER_DEADLINE_MS) || 25 * 1000;

let db = null;
if (!missingEnv.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const stats = { queued: 0, sent: 0, skipped: 0, failed: 0, retired: 0, errors: 0 };
let phase = 'startup';

// The runtime hands the handler ctx.log; mirror to stdout as well so both
// the execution log and any local run carry the same lines.
let emit = (msg) => console.log(msg);
function log(msg, extra) {
  const line = `[${new Date().toISOString()}] ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`;
  emit(line);
}

/**
 * Idempotency guard. A crash between claim and send must not double-send on
 * the next run, and an overlapping run must not either — so the claim itself
 * is a transaction on pushState, not a read-then-write. Appwrite has no
 * transaction endpoint, so appwrite-admin implements the optimistic variant:
 * re-read and only write if the row has not moved.
 */
async function claim(notification) {
  const ref = notification.ref;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const d = snap.data();
    const stale = d.pushClaimedAt &&
      Date.now() - d.pushClaimedAt.toMillis() > CLAIM_TTL_MS;

    if (d.pushState === 'queued' || (d.pushState === 'sending' && stale)) {
      tx.update(ref, {
        pushState: 'sending',
        pushAttempts: (d.pushAttempts || 0) + 1,
        pushClaimedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    }
    return false;
  });
}

/** Preferences gate. Security alerts bypass every user-facing toggle. */
async function wantsPush(cat, recipientId, notification) {
  // Security is locked: no document, no toggle and no opt-out can silence
  // it. That is a product rule, not an oversight — being unable to be told
  // your password changed is the one failure a notification system must
  // never have.
  if (cat === 'security') return true;

  if (notification.expiresAt && notification.expiresAt.toMillis() < Date.now()) {
    return { skip: 'expired' };
  }

  try {
    const prefSnap = await db.doc(`notificationPrefs/${recipientId}`).get();
    if (!prefSnap.exists) return true; // no prefs written yet => default on
    const p = prefSnap.data();
    if (p.push === false) return { skip: 'master_off' };
    // Absent key = on. Only an explicit false suppresses a bucket.
    if ((p.categories || {})[cat] === false) return { skip: `cat_off:${cat}` };
    return true;
  } catch (e) {
    // Failing open on a *read* error would spam; failing closed would hide
    // money notifications. Read errors here are rare and non-security, so we
    // send — a lost notification is worse than a rare duplicate.
    log('pref read failed, defaulting to send', { err: e.message });
    return true;
  }
}

/**
 * Turn a notification's `userId` into real accounts that can receive push.
 *
 * Admin traffic uses the pseudo-account `__admins__`, which has no push
 * subscriptions of its own. Resolve it to the people who actually hold the
 * admin role, otherwise team alerts would silently never send.
 */
async function resolveRecipients(notification) {
  if (notification.userId !== '__admins__') return [notification.userId];

  try {
    const snap = await db.collection('users')
      .where('role', '==', 'admin')
      .limit(25)
      .get();
    const ids = snap.docs.map((d) => d.id);
    return ids.length ? ids : [];
  } catch (e) {
    log('admin resolution failed', { err: e.message });
    return [];
  }
}

async function activeSubscriptions(userId) {
  const snap = await db
    .collection('pushSubscriptions')
    .where('userId', '==', userId)
    .where('isActive', '==', true)
    .limit(25)
    .get();
  return snap.docs;
}

async function writeLog(fields) {
  // Deterministic id => a retry rewrites the same row instead of piling up
  // duplicate delivery records.
  const id = `${fields.notificationId}_${fields.subscriptionId}`;
  await db.doc(`notificationLog/${id}`).set({
    ...fields,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function sendToOne(notification, subDoc) {
  const sub = subDoc.data();
  const payload = JSON.stringify({
    notificationId: notification.id,
    title: notification.title || 'AfnoKamai',
    body: notification.body || '',
    // Minimal payload on purpose: never put balances, PII or tokens in a
    // push body. The authenticated app fetches detail after the click.
    url: notification.link || '/',
    icon: '/assets/icon-512.png',
    badge: '/assets/icon-512.png',
    tag: notification.id,
    category: notification.category || 'system',
    // Urgent items pin themselves on screen (see requireInteraction in sw.js).
    priority: notification.priority || ''
  });

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload
    );
    stats.sent++;
    await subDoc.ref.update({
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
      failCount: 0
    });
    await writeLog({
      notificationId: notification.id,
      userId: notification.userId,
      subscriptionId: subDoc.id,
      channel: 'push',
      status: 'sent',
      provider: 'webpush',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return 'sent';
  } catch (err) {
    const status = err.statusCode || 0;
    log('push error', { sub: subDoc.id, status, msg: err.body || err.message });

    if (TERMINAL.has(status)) {
      // Endpoint is permanently dead — stop ever addressing it again.
      await subDoc.ref.update({
        isActive: false,
        deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
        deactivateReason: `http_${status}`
      });
      stats.retired++;
      await writeLog({
        notificationId: notification.id,
        userId: notification.userId,
        subscriptionId: subDoc.id,
        channel: 'push',
        status: 'failed',
        provider: 'webpush',
        error: `http_${status}`
      });
      return 'retired';
    }

    if (RETRYABLE.has(status) || status === 0) {
      await subDoc.ref.update({
        failCount: (sub.failCount || 0) + 1
      });
      await writeLog({
        notificationId: notification.id,
        userId: notification.userId,
        subscriptionId: subDoc.id,
        channel: 'push',
        status: 'retry',
        provider: 'webpush',
        error: `http_${status || 'network'}`
      });
      return 'retry';
    }

    await writeLog({
      notificationId: notification.id,
      userId: notification.userId,
      subscriptionId: subDoc.id,
      channel: 'push',
      status: 'failed',
      provider: 'webpush',
      error: `http_${status}`
    });
    return 'failed';
  }
}

async function processNotification(notification) {
  const n = { id: notification.id, ...notification.data() };
  stats.queued++;
  const ref = notification.ref;

  const claimed = await claim(notification);
  if (!claimed) return; // someone else owns it, or it already advanced

  try {
    const recipients = await resolveRecipients(n);
    if (!recipients.length) {
      await ref.update({
        pushState: 'skipped',
        pushSkipReason: n.userId === '__admins__' ? 'no_admins' : 'no_recipient',
        pushAt: admin.firestore.FieldValue.serverTimestamp()
      });
      stats.skipped++;
      return;
    }

    const allResults = [];
    let totalSubs = 0;
    let anyWant = false;

    for (const recipientId of recipients) {
      const wants = await wantsPush(n.category || 'system', recipientId, n);
      if (wants !== true) continue;
      anyWant = true;

      const subs = await activeSubscriptions(recipientId);
      totalSubs += subs.length;
      if (!subs.length) continue;

      // Hand sendToOne a recipient-scoped copy so the delivery log records
      // which real account the endpoint belonged to, not `__admins__`.
      const scoped = { ...n, userId: recipientId };
      const results = await Promise.all(subs.map((s) => sendToOne(scoped, s)));
      allResults.push(...results);
    }

    if (!anyWant) {
      await ref.update({
        pushState: 'skipped',
        pushSkipReason: 'opted_out',
        pushAt: admin.firestore.FieldValue.serverTimestamp()
      });
      stats.skipped++;
      return;
    }

    if (!allResults.length) {
      await ref.update({
        pushState: 'skipped',
        pushSkipReason: 'no_devices',
        pushAt: admin.firestore.FieldValue.serverTimestamp()
      });
      stats.skipped++;
      return;
    }

    const sent = allResults.filter((r) => r === 'sent').length;
    const retry = allResults.filter((r) => r === 'retry').length;
    const attempts = n.pushAttempts || 1;

    let finalState;
    if (sent > 0) finalState = 'sent';
    // Unsent-and-retryable goes back to `queued`, not `failed`: the next
    // run retries it until MAX_ATTEMPTS, so a provider blip does not
    // drop a payment alert on the floor.
    else if (retry > 0 && attempts < MAX_ATTEMPTS) finalState = 'queued';
    else if (retry > 0) finalState = 'retrying';
    else finalState = 'failed';

    await ref.update({
      pushState: finalState,
      pushAt: admin.firestore.FieldValue.serverTimestamp(),
      pushDeviceCount: totalSubs,
      pushSentCount: sent
    });
    if (finalState === 'failed') stats.failed++;
  } catch (err) {
    stats.errors++;
    log('notification processing error', { id: n.id, err: err.message });
    // Return it to the queue so a transient bug doesn't drop the alert, but
    // bound it via pushAttempts so we can never loop forever.
    const attempts = (n.pushAttempts || 1);
    await ref.update({
      pushState: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
      pushLastError: String(err.message || err).slice(0, 200)
    }).catch(() => {});
  }
}

/** Crashed runs can strand a claim; sweep those back to queued. */
async function reclaimStuck() {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  const snap = await db.collection('notifications')
    .where('pushState', '==', 'sending')
    .limit(BATCH)
    .get();

  if (snap.empty) return;

  let n = 0;
  const batch = db.batch();
  for (const d of snap.docs) {
    const t = d.data().pushClaimedAt;
    if (t && t.toMillis() < cutoff) {
      batch.update(d.ref, { pushState: 'queued' });
      n++;
    }
  }
  if (!n) return;

  try {
    await batch.commit();
    log('reclaimed stuck claims', { count: n });
  } catch (e) {
    // Best effort: if this fails those claims simply age out again on a
    // later run. It must never be the reason the sender fails outright.
    log('reclaim commit failed', { err: e.message });
  }
}

/**
 * Subscriptions that have failed repeatedly are almost certainly dead but
 * never returned a 410 (e.g. browser data cleared). Retire them so we stop
 * paying for doomed sends.
 */
async function sweepZombieSubscriptions() {
  const snap = await db.collection('pushSubscriptions')
    .where('isActive', '==', true)
    .where('failCount', '>=', 5)
    .limit(50)
    .get();
  if (snap.empty) return;

  const batch = db.batch();
  for (const d of snap.docs) {
    batch.update(d.ref, {
      isActive: false,
      deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deactivateReason: 'repeated_failure'
    });
  }

  try {
    await batch.commit();
    stats.retired += snap.size;
    log('retired zombie subscriptions', { count: snap.size });
  } catch (e) {
    log('zombie sweep commit failed', { err: e.message });
  }
}

async function drain() {
  // Deliberately BEFORE the queue query, never after. A crashed run can
  // strand claims in `sending`, and those documents are invisible to a
  // `pushState == 'queued'` query — so if reclaim ran only when that query
  // came back non-empty, an entirely stranded batch would make the queue
  // look empty forever and the sender would never wake up again.
  phase = 'reclaim-stuck';
  await reclaimStuck();

  phase = 'query-queue';
  const snap = await db.collection('notifications')
    .where('pushState', '==', 'queued')
    .orderBy('createdAt', 'asc')
    .limit(BATCH)
    .get();

  log('queued notifications', { count: snap.size });

  if (snap.empty) {
    phase = 'done-idle';
    log('queue empty', stats);
    return;
  }

  // Sequential on purpose: parallel fan-out against a free-tier provider
  // just earns us 429s, and a small queue fits comfortably in the timeout.
  let n = 0;
  for (const doc of snap.docs) {
    n++;
    phase = `send:${n}/${snap.size}`;
    await processNotification(doc);
  }

  phase = 'sweep-zombies';
  await sweepZombieSubscriptions();

  phase = 'done';
  log('finished', stats);
}

module.exports = async function handler(ctx) {
  const clog = ctx && typeof ctx.log === 'function' ? ctx.log.bind(ctx) : null;
  // ctx.log and stdout are captured as two streams; writing to both would
  // duplicate every line in the execution log, so prefer ctx.log.
  emit = (line) => {
    if (clog) {
      try { clog(line); return; } catch (_) { /* fall through to stdout */ }
    }
    console.log(line);
  };

  const reply = (body, status) => {
    if (ctx && ctx.res && typeof ctx.res.json === 'function') {
      return ctx.res.json(body, status || 200);
    }
    return body;
  };

  if (missingEnv.length) {
    const msg = `not configured: missing ${missingEnv.join(', ')}`;
    log(`FATAL ${msg}`);
    return reply({ ok: false, error: msg }, 500);
  }

  phase = 'startup';
  let trigger = 'unknown';
  try {
    const req = ctx && ctx.req;
    const ev = (req && (req.bodyJson || req.event)) || null;
    trigger = typeof ev === 'string' ? ev.slice(0, 120)
      : ev && ev.event ? String(ev.event).slice(0, 120)
      : (req ? 'request' : 'direct');
  } catch (_) { /* keep 'unknown' */ }
  log('push sender starting', { project: PROJECT_ID, trigger });

  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`deadline after ${RUN_DEADLINE_MS}ms, phase "${phase}"`)),
      RUN_DEADLINE_MS
    );
  });

  const work = drain();
  // A drain that loses the deadline race keeps running; swallow its late
  // rejection so it never surfaces as an unhandled error after we replied.
  work.catch((e) => log('late drain error after deadline', { err: String((e && e.message) || e) }));

  try {
    await Promise.race([work, deadline]);
    return reply({ ok: true, stats });
  } catch (err) {
    const msg = `failed in phase "${phase}": ${(err && err.message) || err}`;
    log(`ERROR ${msg}`);
    return reply({ ok: false, error: msg, stats }, 500);
  } finally {
    clearTimeout(timer);
  }
};
