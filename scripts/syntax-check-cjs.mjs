// Check .cjs files parse as CommonJS scripts.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';

const files = readdirSync('scripts').filter((f) => f.endsWith('.cjs')).map((f) => join('scripts', f));
let bad = 0;
for (const f of files) {
  try {
    new vm.Script(readFileSync(f, 'utf8'), { filename: f });
  } catch (e) {
    bad++;
    console.log(`FAIL ${f}\n  ${e.message}`);
  }
}
console.log(`${files.length} cjs files checked, ${bad} problems`);
