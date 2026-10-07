// ─── User-side operations (free-plan architecture) ───────────────────
// No Cloud Functions: every operation is a Firestore write that is
// validated by firestore.rules (format checks, state machines, dedupe).
// Financial state itself is applied exclusively by admin transactions.

import { auth, db } from './firebase.js';
import {
  doc, getDoc, getDocs, collection, query, where,
  orderBy, limit, serverTimestamp, Timestamp, increment,
  setDoc as fsSetDoc, updateDoc as fsUpdateDoc, addDoc as fsAddDoc,
  runTransaction as fsRunTransaction, writeBatch as fsWriteBatch
} from 'firebase/firestore';
import { withDeadline, boundBatch, WRITE_DEADLINE_MS } from './ui.js';

// ── Bounded writes ───────────────────────────────────────────────────
// Firestore retries RESOURCE_EXHAUSTED forever instead of rejecting, so an
// unbounded write can leave a caller awaiting a promise that never settles —
// and the busy button it is holding never releases. Every write this module
// performs therefore goes through a deadline, set once here so no call site
// can be forgotten.
const setDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsSetDoc(...a));
const updateDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsUpdateDoc(...a));
const addDoc = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsAddDoc(...a));
const runTransaction = (...a) => withDeadline(WRITE_DEADLINE_MS, () => fsRunTransaction(...a));
const writeBatch = (...a) => boundBatch(fsWriteBatch(...a));
import { hashPin, pinProof, PIN_META, isPin4, isWeakPin } from './pin.js';
import { isEmail, isNepaliPhone, isValidName } from './utils.js';
import { generateCode } from './referral.js';

function requireAuth() {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be logged in.');
  return user;
}

function ruleError(e, fallback) {
  const code = e && e.code;
  if (code === 'permission-denied') {
    return new Error(fallback || "You don't have permission to perform this action.");
  }
  if (code === 'failed-precondition') {
    return new Error('This action needs a database index that is not ready yet. Try again in a few minutes.');
  }
  if (code === 'unavailable' || code === 'network-request-failed') {
    return new Error("You're currently offline. Check your connection and try again.");
  }
  // Errors raised inside this file already carry user-facing wording and no
  // Firebase code — pass them through untouched.
  if (!code && e && e.message) return e;
  // Everything else is a backend detail: field names, index names, document
  // limits. Useful when debugging, useless (and actively revealing) to the
  // person on the other end of the UI, so it is logged rather than shown.
  console.warn('[ruleError]', code || '(no code)', (e && e.message) || e);
  return new Error(fallback || 'Something went wrong. Please try again.');
}

/** Create users/{uid} + wallets/{uid} if a previous signup was interrupted. */
export async function ensureUserDocs(user) {
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    // Referral identity ships with the account: a unique, stable code in the
    // same atomic batch as the user document. firestore.rules re-verify the
    // code → uid mapping (getAfter), so a client can never claim a code that
    // belongs to someone else. The referral doc is created here — not at
    // signup completion — because referral OWNERSHIP lives on the code
    // mapping; the referral RELATIONSHIP is only finalized later, once the
    // visitor finishes verification + profile setup (see js/referral.js).
    const code = generateCode();
    const batch = writeBatch(db);
    batch.set(userRef, {
      uid: user.uid,
      // Exactly as the ID token carries it: the create rule compares
      // email == request.auth.token.email, so any rewriting of the case can
      // make the very first write of a new account fail.
      email: user.email || '',
      emailVerified: false,
      fullName: '',
      phone: '',
      role: 'user',
      status: 'active',
      profileComplete: false,
      pinSetAt: null,
      pinSalt: null,
      createdAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
      stats: { assigned: 0, approved: 0, rejected: 0, earnedPaisa: 0, withdrawnPaisa: 0, penaltiesPaisa: 0 },
      referralCode: code,
      referralHandle: '',
      referralCodeSetAt: serverTimestamp(),
      referredBy: '',
      referredByCode: '',
      referralJoinedAt: null
    });
    batch.set(doc(db, 'referralCodes', code), {
      code,
      userId: user.uid,
      createdAt: serverTimestamp()
    });
    await batch.commit().catch((e) => { throw ruleError(e, 'Could not create your account profile. Please try again.'); });
  }
  const walletRef = doc(db, 'wallets', user.uid);
  if (!(await getDoc(walletRef)).exists()) {
    await setDoc(walletRef, {
      availablePaisa: 0, holdPaisa: 0, earnedPaisa: 0, withdrawnPaisa: 0,
      updatedAt: serverTimestamp()
    }).catch(() => {});
  }
}

/**
 * What the security rules will see when they read users/{uid}. The onboarding
 * and PIN branches read this document (status, profileComplete) before allowing
 * a write, so its state decides whether a save is allowed at all.
 */
async function readProfileState(user) {
  const snap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
  if (!snap || !snap.exists()) return { exists: false };
  const p = snap.data() || {};
  return {
    exists: true,
    profileComplete: p.profileComplete === true,
    status: p.status || 'active'
  };
}

/** Step 1 of setup: full name + phone (validated by security rules). */
export async function completeProfile({ fullName, phone }) {
  const user = requireAuth();
  const name = String(fullName || '').trim().replace(/\s+/g, ' ');
  const cleanPhone = String(phone || '').replace(/[\s-]/g, '');
  if (!isValidName(name)) throw new Error('Please enter your full name (letters only, 2–60 characters).');
  if (!isNepaliPhone(cleanPhone)) throw new Error('Please enter a valid Nepali phone number, e.g. 98XXXXXXXX.');

  // The onboarding rule evaluates the EXISTING document (status +
  // profileComplete). If signup never created users/{uid} — an interrupted or
  // pre-rules signup, which signup.js deliberately swallows — the update is
  // denied with permission-denied, never `not-found`, so the old heal-below
  // could never trigger: the user was stuck on "Could not save your details"
  // forever. Create the documents up front instead.
  if (!(await readProfileState(user)).exists) await ensureUserDocs(user);

  const userRef = doc(db, 'users', user.uid);
  const payload = { fullName: name, phone: cleanPhone, profileComplete: true };
  const save = () => updateDoc(userRef, payload);
  try {
    await save();
  } catch (e) {
    console.warn('[completeProfile] failed:', e && e.code, e && e.message);
    const code = String(e.code);
    if (code === 'not-found' || code === 'permission-denied') {
      // Either the document vanished, or the rules read it and said no.
      // heal once, then explain the ACTUAL reason instead of a dead end.
      try {
        await ensureUserDocs(user);
        await save();
        return { ok: true };
      } catch (e2) {
        console.warn('[completeProfile] retry failed:', e2 && e2.code, e2 && e2.message);
        const s = await readProfileState(user);
        if (s.exists && s.profileComplete) return { ok: true }; // saved in another tab
        if (!s.exists) {
          throw new Error("We couldn't find your account. Please sign out, sign in again and retry — or contact support.");
        }
        if (s.status !== 'active') {
          throw new Error('Your account is currently restricted, so setup is on hold. Please contact support.');
        }
        throw ruleError(e2, 'Could not save your details. Please try again.');
      }
    }
    throw ruleError(e, 'Could not save your details. Please try again.');
  }
  return { ok: true };
}

/** Step 2 of setup: security PIN — hash is write-only (never readable). */
export async function setPin({ pin }) {
  const user = requireAuth();
  if (!isPin4(pin)) throw new Error('The security PIN must be exactly 4 digits.');
  if (isWeakPin(pin)) throw new Error('That PIN is too easy to guess. Avoid repeated digits and sequences.');
  const { salt, hash } = await hashPin(pin);
  const writeAll = () => {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', user.uid), {
      pinSalt: salt,
      pinSetAt: serverTimestamp()
    });
    batch.set(doc(db, 'users', user.uid, 'private', 'pin'), {
      pinHash: hash,
      pinAlgo: PIN_META.algo,
      pinIterations: PIN_META.iterations
    });
    return batch.commit();
  };
  // Same trap as completeProfile: the rules read users/{uid} before allowing
  // this batch, so a document that signup never created is reported as
  // permission-denied and would never reach a `not-found` heal. Create first.
  if (!(await readProfileState(user)).exists) await ensureUserDocs(user);
  try {
    await writeAll();
  } catch (e) {
    console.warn('[setPin] failed:', e && e.code, e && e.message);
    const code = String(e.code);
    if (code === 'not-found' || code === 'permission-denied') {
      try {
        await ensureUserDocs(user);
        await writeAll();
      } catch (e2) {
        console.warn('[setPin] retry failed:', e2 && e2.code, e2 && e2.message);
        const s = await readProfileState(user);
        if (!s.exists) {
          throw new Error("We couldn't find your account. Please sign out, sign in again and retry — or contact support.");
        }
        if (s.status !== 'active') {
          throw new Error('Your account is currently restricted, so setup is on hold. Please contact support.');
        }
        throw ruleError(e2, 'Could not set your PIN. Please try again.');
      }
    } else {
      throw ruleError(e, 'Could not set your PIN. Please try again.');
    }
  }
  return { ok: true };
}

/** Change PIN (the profile page requires a fresh Firebase login first). */
export async function changePin({ newPin }) {
  const user = requireAuth();
  if (!isPin4(newPin)) throw new Error('The security PIN must be exactly 4 digits.');
  if (isWeakPin(newPin)) throw new Error('That PIN is too easy to guess.');
  const { salt, hash } = await hashPin(newPin);
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', user.uid), { pinSalt: salt, pinSetAt: serverTimestamp() });
    batch.set(doc(db, 'users', user.uid, 'private', 'pin'), {
      pinHash: hash, pinAlgo: PIN_META.algo, pinIterations: PIN_META.iterations
    });
    await batch.commit();
  } catch (e) {
    throw ruleError(e, 'Could not change your PIN. Please try again.');
  }
  return { ok: true };
}

// ── Tasks ────────────────────────────────────────────────────────────

export async function requestTask({ taskId }) {
  const user = requireAuth();
  // Check Appwrite user document's emailVerified first (programmatically settable),
  // fall back to Firebase Auth's emailVerified.
  if (!user.emailVerified) {
    try {
      const meSnap = await getDoc(doc(db, 'users', user.uid));
      const me = meSnap.data() || {};
      if (!me.emailVerified) throw new Error('Please verify your email address first.');
    } catch (_) { /* if we can't read the doc, fall through to Firebase check below */ }
  }

  const taskRef = doc(db, 'tasks', taskId);
  const asgRef = doc(db, 'taskAssignments', `${user.uid}_${taskId}`);

  // Best-effort duplicate + cap checks (rules are authoritative).
  const activeStatuses = ['requested', 'assigned', 'submitted', 'clarification'];
  const mine = await getDocs(query(
    collection(db, 'taskAssignments'),
    where('userId', '==', user.uid),
    where('status', 'in', activeStatuses),
    limit(20)
  ));
  if (mine.docs.some((d) => d.data().taskId === taskId)) {
    throw new Error('You already have an active request for this task.');
  }
  if (mine.size >= 5) {
    throw new Error('You can have at most 5 active tasks at once. Finish or wait for review.');
  }

  // Read the display name BEFORE the transaction so no plain read happens
  // between the transaction's own reads and its writes.
  const mySnap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
  const myName = mySnap?.data()?.fullName || '';

  try {
    await runTransaction(db, async (tx) => {
      const [taskSnap, existing] = await Promise.all([tx.get(taskRef), tx.get(asgRef)]);
      if (!taskSnap.exists() || taskSnap.data().status !== 'published') {
        throw new Error('This task is no longer available.');
      }
      if (existing.exists()) throw new Error('You already have an active request for this task.');
      const t = taskSnap.data();
      tx.set(asgRef, {
        taskId,
        title: t.title || '',
        description: t.description || '',
        instructions: t.instructions || '',
        category: t.category || '',
        difficulty: t.difficulty || 'easy',
        estimatedMinutes: typeof t.estimatedMinutes === 'number' && Number.isInteger(t.estimatedMinutes) ? t.estimatedMinutes : (t.estimatedMinutes || 10),
        rewardPaisa: t.rewardPaisa,
        slotsTotal: t.slotsTotal || 0,
        deadline: t.deadline || null,
        evidenceRequired: !!t.evidenceRequired,
        priority: t.priority || '',
        userId: user.uid,
        userName: myName,
        userEmail: (user.email || '').toLowerCase(),
        status: 'requested',
        note: '',
        evidenceNote: '',
        requestedAt: serverTimestamp(),
        assignedAt: null, submittedAt: null, reviewedAt: null,
        reviewedBy: null, reviewedByName: null,
        holdUntil: null, rejectionReason: '', clarificationReason: '',
        isHistory: false
      });
    });
  } catch (e) {
    if (e.message && !String(e.code)) throw e; // our own friendly error
    throw ruleError(e, 'Could not request this task. Please try again.');
  }

  // Surface the request in the support conversation (cosmetic fields only).
  const taskSnap = await getDoc(taskRef).catch(() => null);
  const title = String(taskSnap?.data()?.title || 'a task').slice(0, 80);
  await bumpAdminUnread(`Task request: ${title}`, 'text').catch(() => {});

  return { ok: true };
}

export async function submitTask({ assignmentId, note, evidenceNote }) {
  const user = requireAuth();
  const cleanNote = String(note || '').slice(0, 1000).trim();
  const cleanEvidence = String(evidenceNote || '').slice(0, 1000).trim();
  try {
    await updateDoc(doc(db, 'taskAssignments', assignmentId), {
      status: 'submitted',
      submittedAt: serverTimestamp(),
      note: cleanNote,
      evidenceNote: cleanEvidence
    });
  } catch (e) {
    throw ruleError(e, 'Could not submit this task. Refresh the page and try again.');
  }
  const asg = await getDoc(doc(db, 'taskAssignments', assignmentId)).catch(() => null);
  const submittedTitle = String(asg?.data()?.title || 'task').slice(0, 80);
  await bumpAdminUnread(`Submitted “${submittedTitle}” for review`, 'text').catch(() => {});
  return { ok: true };
}

async function bumpAdminUnread(preview, type) {
  const user = requireAuth();
  const convRef = doc(db, 'conversations', user.uid);
  const snap = await getDoc(convRef);
  const payload = {
    lastMessage: preview, lastType: type,
    lastMessageAt: serverTimestamp(), lastSenderId: user.uid, lastSenderRole: 'user'
  };
  if (!snap.exists()) {
    const me = await getDoc(doc(db, 'users', user.uid));
    const u = me.data() || {};
    // Rules require BOTH unread counters to be 0 on create — bump afterwards.
    await setDoc(convRef, {
      participants: [user.uid], userId: user.uid,
      userName: u.fullName || '', userEmail: u.email || '',
      createdAt: serverTimestamp(),
      ...payload,
      unreadForAdmin: 0, unreadForUser: 0,
      userTyping: false, adminTyping: false
    });
    await updateDoc(convRef, { unreadForAdmin: increment(1) });
  } else {
    // increment() keeps this correct under concurrent writes (no read-then-write).
    await updateDoc(convRef, { ...payload, unreadForAdmin: increment(1) });
  }
}

// ── Withdrawals ──────────────────────────────────────────────────────

// Withdrawal eligibility required by the Terms of Service. Enforced here as
// a backstop so the rule holds even if the withdraw page's check is bypassed.
const MIN_APPROVED_TASKS = 50;

export async function requestWithdrawal({ amountPaisa, esewaName, esewaNumber, pin }) {
  const user = requireAuth();
  // Check Appwrite user document's emailVerified first (programmatically settable),
  // fall back to Firebase Auth's emailVerified.
  if (!user.emailVerified) {
    try {
      const meSnap = await getDoc(doc(db, 'users', user.uid));
      const me = meSnap.data() || {};
      if (!me.emailVerified) throw new Error('Please verify your email address first.');
    } catch (_) {
      // If we can't read the Appwrite doc, the Firebase check below will catch it.
    }
  }
  const amount = Number(amountPaisa);
  const name = String(esewaName || '').trim().replace(/\s+/g, ' ');
  const number = String(esewaNumber || '').replace(/[\s-]/g, '');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Please enter a valid withdrawal amount.');
  if (name.length < 3) throw new Error('Please enter the account name registered on eSewa.');
  if (!/^9[678]\d{8}$/.test(number)) throw new Error('Please enter a valid eSewa mobile number, e.g. 98XXXXXXXX.');
  if (!isPin4(pin)) throw new Error('Please enter your 4-digit security PIN.');

  const meSnap = await getDoc(doc(db, 'users', user.uid));
  const me = meSnap.data() || {};
  const approvedCount = Number(me.stats?.approved) || 0;
  if (approvedCount < MIN_APPROVED_TASKS) {
    throw new Error(`You need at least ${MIN_APPROVED_TASKS} approved tasks to withdraw — you currently have ${approvedCount}.`);
  }
  const salt = me.pinSalt;
  if (!salt) throw new Error('No security PIN is set on your account.');
  const proof = await pinProof(pin, salt);

  const wRef = doc(collection(db, 'withdrawals'));
  const lockRef = doc(db, 'activeWithdrawals', user.uid);

  try {
    await runTransaction(db, async (tx) => {
      const lock = await tx.get(lockRef);
      if (lock.exists()) {
        throw new Error('You already have a withdrawal being processed. Wait for it to complete or be rejected.');
      }
      tx.set(wRef, {
        userId: user.uid,
        userName: me.fullName || '',
        userEmail: (user.email || '').toLowerCase(),
        amountPaisa: amount,
        esewaName: name,
        esewaNumber: number,
        status: 'pending',
        pinProof: proof,
        pinProofAlgo: PIN_META.algo,
        pinIterations: PIN_META.iterations,
        pinSaltUsed: salt,
        requestedAt: serverTimestamp(),
        reviewedAt: null, reviewedBy: null, reviewedByName: null,
        reason: '',
        txId: ''
      });
      tx.set(lockRef, {
        withdrawalId: wRef.id,
        amountPaisa: amount,
        createdAt: serverTimestamp()
      });
    });
  } catch (e) {
    if (e.message && !String(e.code)) throw e;
    throw ruleError(e, 'Could not submit the withdrawal. Please try again.');
  }
  return { ok: true, withdrawalId: wRef.id };
}
