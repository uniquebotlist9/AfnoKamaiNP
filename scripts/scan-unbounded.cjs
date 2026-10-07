// Review aid: list Firestore query() calls that carry no limit().
// Run: node scripts/scan-unbounded.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !d.includes('scripts')) files.push(p);
  }
})(ROOT);

let total = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // find query( ... ) call spans with balanced parens
  for (let i = 0; i < src.length; i++) {
    if (!src.startsWith('query(', i)) continue;
    let depth = 0, j = i + 5;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    const span = src.slice(i, j + 1);
    if (/\blimit\(/.test(span)) continue;
    if (/\bgetCountFromServer\b/.test(src.slice(Math.max(0, i - 200), i))) continue;
    const line = src.slice(0, i).split('\n').length;
    console.log(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${line}`);
    console.log(`   ${span.replace(/\s+/g, ' ').slice(0, 220)}`);
    total++;
  }
}
console.log(`\nUnbounded queries: ${total}`);
