/**
 * AfnoKamai — Appwrite write-probe (read-after-write).
 *
 * Replaces scripts/firestore-probe.cjs, which existed to answer a question
 * that was specific to Firestore on the free tier: writes there can stall
 * forever instead of failing, so the only way to tell "write blocked" from
 * "response lost" is to write and then immediately read the same document
 * back. This keeps that question, and the same contract the workflow depends
 * on: print a line beginning with HUNG if an operation exceeds PROBE_CAP_MS,
 * and exit 0 when every probe returned.
 *
 *   write blocked  -> reads succeed, the set never returns, document absent
 *   response lost  -> the set never returns, document present after the fact
 *   healthy        -> the set returns and the document reads back
 *
 * Exit: 0 = all probes returned; 1 = script failed; 2 = watchdog.
 */

// Same Firestore-shaped API as scripts/push-sender.cjs uses, backed by
// Appwrite TablesDB. See scripts/appwrite-admin.cjs.
const admin = require('./appwrite-admin.cjs');

const CAP_MS = Number(process.env.PROBE_CAP_MS) || 15000;
const GRACE_MS = Number(process.env.PROBE_GRACE_MS) || 4000;
const OVERALL_MS = Number(process.env.PROBE_OVERALL_MS) || 240000;
// Appwrite rejects rowIds that begin with an underscore, so this cannot reuse
// the old Firestore probe's `_q_readback` name.
const DOC = 'config/probe_readback';

const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
if (!PROJECT_ID || !DATABASE_ID || !process.env.APPWRITE_API_KEY) {
  console.error('FATAL: APPWRITE_PROJECT_ID, APPWRITE_DATABASE_ID and APPWRITE_API_KEY are all required.');
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const overall = setTimeout(() => {
  console.error(`FATAL: probe still running after ${OVERALL_MS}ms.`);
  process.exit(2);
}, OVERALL_MS);

async function attempt(label, fn) {
  const started = Date.now();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ d: true }), CAP_MS); });

  let outcome;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn).then(() => ({ ok: true })),
      deadline
    ]);
    outcome = result.d ? { status: 'HUNG' } : { status: 'OK' };
  } catch (err) {
    outcome = { status: 'ERROR', message: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  console.log(`${outcome.status.padEnd(6)} ${label}${outcome.message ? ' — ' + outcome.message : ''}  (${ms}ms)`);
  return outcome;
}

/** @returns {Promise<boolean|null>} true = exists, false = absent, null = could not tell */
async function exists(label) {
  try {
    const snap = await db.doc(DOC).get();
    const present = snap.exists;
    console.log(`${'OK'.padEnd(6)} ${label} -> ${present ? 'DOCUMENT EXISTS' : 'document absent'}`);
    return present;
  } catch (err) {
    console.log(`${'ERROR'.padEnd(6)} ${label} — ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`probe start: project=${PROJECT_ID} database=${DATABASE_ID} doc=${DOC}`);
  console.log('question: after a set() that never returns, does the document exist?');

  await attempt('V1 READ baseline (should be absent)', () => db.doc(DOC).get());
  const before = await exists('V2 READ baseline detail');

  // Only columns config actually has: Appwrite rejects unknown ones, which
  // would read as a write failure rather than the stall this probe is for.
  const stamp = () => ({ updatedAt: new Date(), updatedBy: 'write-probe' });

  const write = await attempt('V3 SET  plain set', () => db.doc(DOC).set(stamp()));
  const afterSet = await exists('V4 READ immediately after hung set');

  await sleep(GRACE_MS);
  const afterGrace = await exists(`V5 READ after ${GRACE_MS}ms grace`);

  await attempt('V6 SET  same doc again', () => db.doc(DOC).set(stamp()));
  const afterRetry = await exists('V7 READ after second hung set');

  await attempt('V8 DEL  document', () => db.doc(DOC).delete());
  const afterDelete = await exists('V9 READ after delete');

  console.log('--- verdict ---');
  console.log(`write status            : ${write.status}`);
  console.log(`present before write    : ${before}`);
  console.log(`present after write     : ${afterSet}`);
  console.log(`present after grace     : ${afterGrace}`);
  console.log(`present after retry     : ${afterRetry}`);
  console.log(`present after delete    : ${afterDelete}`);

  if (afterSet === true || afterGrace === true || afterRetry === true) {
    console.log('VERDICT: WRITES COMMIT — the response never arrives. The database');
    console.log('         is being written; the client waits for an ack that will not come.');
  } else if (afterSet === false && afterGrace === false) {
    console.log('VERDICT: WRITES DO NOT COMMIT — blocked before they reach storage.');
    console.log('         Root cause is server-side (index build / quota / policy).');
  } else {
    console.log('VERDICT: INCONCLUSIVE — reads could not confirm state.');
  }

  if (afterGrace === true && afterDelete === false) {
    console.log('NOTE: delete() verifiably removed a confirmed-existing document.');
  }

  clearTimeout(overall);
  console.log('probe done');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe fatal', err);
  process.exit(1);
});
