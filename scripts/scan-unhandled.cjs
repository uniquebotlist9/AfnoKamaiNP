// Diagnostic only (git-ignored): finds fire-and-forget promises in page modules.
// Anything awaited is fine; the risk is `promise.then(...)` / direct write
// calls with no `.catch()` and no `await`, which surface as unhandled
// rejections in production.
//
// Statements are reassembled across lines (until parentheses balance) so a
// multi-line chain is judged as a whole — a `.catch()` on the last line of
// the chain counts, and an `await` anywhere in the statement counts.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['js', 'js/pages', 'js/pages/admin'];
const RISKY = /\.(then|updateDoc|setDoc|addDoc|deleteDoc|writeBatch|runTransaction)\s*\(/;

function parenDelta(s) {
  let d = 0;
  for (const ch of s) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
  }
  return d;
}

for (const d of DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (!name.endsWith('.js')) continue;
    const f = path.join(abs, name);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*')) continue;
      if (!RISKY.test(t)) continue;
      // Reassemble the full statement: follow parentheses across
      // lines, and keep going at depth 0 while the next line is
      // another link of the same method chain (.catch, .finally…).
      let stmt = t;
      let depth = parenDelta(stmt);
      let j = i;
      while (j + 1 < lines.length) {
        const nt = lines[j + 1].trim();
        if (!nt || nt.startsWith('//')) { j++; continue; }
        const isChain = depth <= 0 && (nt.startsWith('.') || stmt.trimEnd().endsWith('.'));
        if (depth <= 0 && !isChain) break;
        j++;
        stmt += ' ' + nt;
        depth += parenDelta(nt);
      }
      const safe =
        /\.catch\s*\(/.test(stmt) ||                 // explicitly handled
        /\bawait\b/.test(stmt) ||                    // awaited somewhere
        /^\s*return\b/.test(line) ||                 // returned to the caller
        /^export\b/.test(t);                         // exported promise
      if (!safe) console.log(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${i + 1}: ${t.slice(0, 130)}`);
      i = j; // continuation lines were judged as part of this statement
    }
  }
}
console.log('\n(done)');
