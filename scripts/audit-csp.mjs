// Verify every inline <script> in every HTML file matches a sha256 hash in the
// firebase.json CSP script-src, and that no CSP hash is unused.
// Also flags inline event handlers (onclick= etc.), which 'unsafe-hashes' would be needed for.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const fb = JSON.parse(readFileSync('firebase.json', 'utf8'));
const cspHeaders = fb.hosting.headers.find((h) => h.source === '**').headers;
const csp = cspHeaders.find((h) => h.key === 'Content-Security-Policy').value;
const scriptSrc = csp.match(/script-src ([^;]+)/)[1];
const allowedHashes = new Set([...scriptSrc.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]));

const htmlFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.firebase', '.tmp-awdump', 'scripts'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.html')) htmlFiles.push(p);
  }
})(process.cwd());

const used = new Map(); // hash -> [files]
const problems = [];

for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  const rel = relative(process.cwd(), f);
  let m;
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    if (/\bsrc\s*=/i.test(attrs)) continue;           // external script
    if (/type\s*=\s*["']importmap["']/i.test(attrs)) continue; // importmap not subject to script-src hashes
    if (/type\s*=\s*["'](application\/(ld\+json|json))["']/i.test(attrs)) continue;
    const hash = createHash('sha256').update(body, 'utf8').digest('base64');
    if (!used.has(hash)) used.set(hash, []);
    used.get(hash).push(rel);
    if (!allowedHashes.has(hash)) {
      problems.push(`NOT IN CSP: ${rel} — inline script sha256-${hash} (first 24: ${body.trim().slice(0, 60).replace(/\s+/g, ' ')}…)`);
    }
  }
  // inline event handlers are blocked unless 'unsafe-hashes' present
  const handler = html.match(/\son(?:click|load|error|input|change|submit|mouseover|focus|blur)\s*=\s*["'][^"']*["']/i);
  if (handler && !scriptSrc.includes("'unsafe-hashes'")) {
    problems.push(`INLINE HANDLER: ${rel} — ${handler[0].slice(0, 70)} (blocked: no 'unsafe-hashes')`);
  }
}

// CSP hashes not used anywhere (stale, from older edits — harmless but signals drift)
for (const h of allowedHashes) {
  if (!used.has(h)) problems.push(`STALE CSP HASH: sha256-${h} matches no current inline script`);
}

console.log(`HTML files checked: ${htmlFiles.length}`);
console.log(`Unique inline scripts: ${used.size}, CSP hashes: ${allowedHashes.size}`);
console.log(`\nProblems: ${problems.length}`);
for (const p of problems) console.log('  ' + p);
console.log('\nHash → files:');
for (const [h, files] of used) console.log(`  sha256-${h.slice(0, 16)}… ×${files.length}: ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}`);
