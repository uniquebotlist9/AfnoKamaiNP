// Collect every absolute URL referenced in HTML/JS/CSS and check it against the
// firebase.json CSP directives + connect-src, so nothing gets CSP-blocked at runtime.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const fb = JSON.parse(readFileSync('firebase.json', 'utf8'));
const csp = fb.hosting.headers.find((h) => h.source === '**').headers.find((h) => h.key === 'Content-Security-Policy').value;
const dir = {};
for (const part of csp.split(';')) {
  const [name, ...vals] = part.trim().split(/\s+/);
  if (name) dir[name] = vals;
}
const hostAllowed = (spec, list = []) =>
  list.some((s) => {
    if (s === '*') return true;
    if (s.startsWith('https://') || s.startsWith('http://')) return spec.startsWith(s.replace(/\*\.?/, '')) || spec === s;
    if (s.startsWith('*.')) { try { return new URL(spec).hostname.endsWith(s.slice(1)); } catch { return false; } }
    return false;
  });

const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    if (['node_modules', '.git', '.firebase', '.tmp-awdump'].includes(name)) continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|js|css)$/.test(name)) files.push(p);
  }
})(process.cwd());

const usage = new Map(); // url -> [where]
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(process.cwd(), f);
  for (const m of src.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
    let u = m[0].replace(/[.,;:)\]}]+$/, '');
    try { new URL(u); } catch { continue; }
    if (!usage.has(u)) usage.set(u, []);
    if (usage.get(u).length < 3) usage.get(u).push(rel);
  }
}

// Categorize by how the browser would load each URL
function check(url) {
  // In practice we can't know exactly how each is used; report the strictest relevant directive.
  const out = [];
  const noDirective = [];
  const maps = { fetch: dir['connect-src'], img: dir['img-src'], script: dir['script-src'], style: dir['style-src'], font: dir['font-src'], frame: dir['frame-src'], worker: dir['worker-src'] };
  for (const [kind, list] of Object.entries(maps)) {
    const ok = list && (hostAllowed(url, list) || list.includes("'self'") && url.startsWith(location_placeholder()));
    if (!list) noDirective.push(kind);
    out.push([kind, ok]);
  }
  return { out, noDirective };
}
function location_placeholder() { return 'http://__never__'; }

// Simpler: for each URL, find which CSP directive *should* cover it and whether any allows it.
const findings = [];
for (const [url, where] of usage) {
  const host = new URL(url).hostname;
  const rel = ['connect-src', 'img-src', 'script-src', 'style-src', 'font-src', 'frame-src', 'worker-src', 'media-src']
    .map((d) => {
      const list = dir[d];
      if (!list) return `${d}=ABSENT`;
      const ok = hostAllowed(url, list);
      return `${d}:${ok ? 'OK' : 'BLOCK'}`;
    });
  const anyOk = rel.some((r) => r.endsWith('OK'));
  findings.push({ url, where, rel, anyOk });
}

// Only surface URLs that are blocked in EVERY directive (definitely a problem if used as that type),
// plus summarize per-host allow status.
const hosts = new Map();
for (const f of findings) {
  const host = new URL(f.url).hostname;
  if (!hosts.has(host)) hosts.set(host, { blocked: new Set(), ok: new Set(), sample: f.url });
  for (const r of f.rel) {
    const [d, s] = r.split(':');
    (s === 'OK' ? hosts.get(host).ok : hosts.get(host).blocked).add(d);
  }
}
console.log('Hosts referenced and their CSP status per directive:');
for (const [host, info] of [...hosts].sort()) {
  const allBlocked = info.sample.startsWith('http') && [...info.blocked].filter((d) => !d.endsWith('=ABSENT'));
  const fullyBlocked = info.ok.size === 0;
  console.log(`  ${fullyBlocked ? '❌' : '✅'} ${host}${fullyBlocked ? '  (blocked in all directives)' : ''} sample: ${info.sample.slice(0, 90)}`);
}
