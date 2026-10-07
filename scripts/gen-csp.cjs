// ─── Content-Security-Policy generator ─────────────────────────────────
//
// Every HTML page in this project carries inline scripts (the theme
// bootstrap, the Firebase import map, and maintenance.html's module). A CSP
// built from SHA-256 hashes of those exact script bodies blocks every OTHER
// inline script — which is what actually stops an injected payload from
// running — without needing 'unsafe-inline'.
//
// The price of hashes is that editing an inline script changes its hash, so
// this script must be re-run after any such edit:
//
//     node scripts/gen-csp.cjs
//
// It rewrites the `Content-Security-Policy` values in firebase.json in place.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FIREBASE_JSON = path.join(ROOT, 'firebase.json');

// Directives that do NOT depend on page content.
const STATIC_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  // 'self' + the two CDNs the markup actually loads: gstatic (Firebase SDKs)
  // and jsdelivr (Chart.js). Hashes cover the inline scripts.
  "script-src 'self' https://www.gstatic.com https://cdn.jsdelivr.net",
  // 'unsafe-inline' is required here for the inline style="" attributes used
  // throughout the templates; it does NOT weaken script-src.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // data: — chat attachments are stored inline as data URLs.
  "img-src 'self' data: blob: https://www.gstatic.com https://*.googleusercontent.com",
  // googleapis covers Identity Toolkit, token refresh and installations;
  // cloudfunctions covers the optional backend; sgp.cloud.appwrite.io is the
  // database (and the auth-bridge/write-proxy Function invocation).
  "connect-src 'self' https://*.googleapis.com https://*.cloudfunctions.net " +
    "https://sgp.cloud.appwrite.io " +
    "https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com",
  "worker-src 'self' blob:",
  "frame-src 'self' https://*.firebaseapp.com",
  "manifest-src 'self'",
  "media-src 'self' data: blob:",
  'upgrade-insecure-requests'
];

/** All HTML files in the deployable tree (scripts/ is excluded from deploy). */
function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'functions') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'scripts' || e.name === 'optional-cloud-functions') continue;
      htmlFiles(p, out);
    } else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** SHA-256 (base64) CSP hash for one inline script body, CSP-style. */
function hashOf(body) {
  return "'sha256-" + crypto.createHash('sha256').update(body, 'utf8').digest('base64') + "'";
}

function collectHashes() {
  const hashes = new Set();
  const byHash = new Map();

  for (const file of htmlFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[1] || '';
      if (/\bsrc\s*=/.test(attrs)) continue; // external script — covered by source list
      const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      // Data blocks (JSON-LD, import maps are NOT data blocks) are never
      // executed, so CSP does not need to allow them.
      const isDataBlock = type && !/^(module|importmap|text\/javascript|application\/javascript)$/i.test(type);
      if (isDataBlock) continue;
      const body = m[2];
      if (!body.trim()) continue;
      const h = hashOf(body);
      hashes.add(h);
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  return { hashes: [...hashes].sort(), byHash };
}

function buildCsp() {
  const { hashes, byHash } = collectHashes();
  const scriptSrc = STATIC_DIRECTIVES.find((d) => d.startsWith('script-src '));
  const csp = [
    ...STATIC_DIRECTIVES.map((d) => (d.startsWith('script-src ') ? `${scriptSrc} ${hashes.join(' ')}` : d))
  ].join('; ');

  if (!hashes.length) {
    console.error('No inline scripts found — something is wrong with the scan.');
    process.exit(1);
  }
  console.log(`Inline script hashes: ${hashes.length}`);
  for (const [h, files] of byHash) console.log(`  ${h}  ${files.length} file(s)`);
  return csp;
}

function main() {
  const csp = buildCsp();
  const json = JSON.parse(fs.readFileSync(FIREBASE_JSON, 'utf8'));
  let replaced = 0;

  const walkHeaders = (rules) => {
    for (const rule of rules || []) {
      for (const h of rule.headers || []) {
        if (h.key === 'Content-Security-Policy') { h.value = csp; replaced++; }
      }
    }
  };
  walkHeaders(json.hosting && json.hosting.headers);

  if (!replaced) {
    console.error('No Content-Security-Policy header found in firebase.json to update.');
    process.exit(1);
  }

  fs.writeFileSync(FIREBASE_JSON, JSON.stringify(json, null, 2) + '\n');
  console.log(`\nUpdated ${replaced} Content-Security-Policy value(s) in firebase.json`);
}

main();
