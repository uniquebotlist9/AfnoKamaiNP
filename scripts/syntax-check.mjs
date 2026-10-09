// Syntax-check every JS file as an ES module (the browser's parse mode).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

// vm.SourceTextModule lives behind --experimental-vm-modules.
// Re-run ourselves with the flag instead of reporting every
// file as a failure when the flag was forgotten.
if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', process.argv[1]], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', '.firebase', '.tmp-awdump', 'scripts']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

let bad = 0;
const files = walk(ROOT);
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  try {
    // Parse as a module: catches syntax errors the browser would throw.
    new vm.SourceTextModule(src, { identifier: relative(ROOT, f) });
  } catch (e) {
    bad++;
    console.log(`FAIL ${relative(ROOT, f)}\n  ${e.message}`);
  }
}
console.log(`\n${files.length} files checked, ${bad} with problems`);
