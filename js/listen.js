// ─── Visibility-gated Firestore subscriptions ─────────────────────────
// An open listener costs nothing while the documents it watches don't
// change — but every document that DOES change while the tab is in the
// background is still billed as a read, and the user cannot see it anyway.
//
// Subscriptions that exist only to paint the current tab therefore go
// through subscribeWhileVisible(): they stream while the page is on screen
// and detach the moment it is hidden. Coming back re-attaches, and the
// first snapshot simply repaints whatever arrived meanwhile — no missed
// state, no reads spent on a tab nobody is looking at.
import { onSnapshot } from 'firebase/firestore';

const gates = new Set();
let pageVisible = !document.hidden;

document.addEventListener('visibilitychange', () => {
  pageVisible = !document.hidden;
  for (const gate of gates) {
    if (pageVisible) gate.resume();
    else gate.pause();
  }
});

/**
 * onSnapshot() that only streams while the page is visible.
 *
 * Returns an unsubscribe function that is idempotent AND removes the
 * subscription from the visibility registry — so a listener replaced by the
 * caller (e.g. the chat thread's "load earlier" re-query) can never be
 * revived behind the caller's back.
 */
export function subscribeWhileVisible(target, onNext, onError) {
  let unsub = null;
  const gate = {
    resume() {
      if (unsub) return;
      unsub = onError ? onSnapshot(target, onNext, onError) : onSnapshot(target, onNext);
    },
    pause() {
      if (!unsub) return;
      const stop = unsub;
      unsub = null;
      stop();
    }
  };
  gates.add(gate);
  if (pageVisible) gate.resume();
  return () => {
    gate.pause();
    gates.delete(gate);
  };
}
