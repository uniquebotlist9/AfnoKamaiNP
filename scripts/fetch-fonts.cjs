// ─── Self-host the web fonts ───────────────────────────────────────────
//
// Google Fonts is served from two cross-origin hosts and its stylesheet is
// only fresh for 5 minutes (max-age=300). On a repeat visit that means a
// ~200 ms round trip to fonts.googleapis.com inside the critical path of the
// `load` event — the single biggest obstacle to a sub-100 ms warm load.
// Served from our own origin, the same file comes out of the service-worker
// cache in ~0 ms instead.
//
//     node scripts/fetch-fonts.cjs
//
// Downloads only the subsets this site actually renders (latin, latin-ext
// for Inter; devanagari + latin for Noto Sans Devanagari) into assets/fonts/
// and rewrites css/fonts.css. Run it again whenever a weight is added.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'fonts');
const CSS_OUT = path.join(ROOT, 'css', 'fonts.css');

// The css2 endpoint returns TTF to ancient user agents; this gets woff2.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SOURCE =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter:wght@400;500;600;700;800' +
  '&family=Noto+Sans+Devanagari:wght@400;600' +
  '&display=swap';

// Only these subsets are kept. Everything else (cyrillic, greek, vietnamese…)
// is dead weight for a Nepali/English site.
const KEEP = new Set(['latin', 'latin-ext', 'devanagari']);

function get(url, asBuffer) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(new URL(res.headers.location, url).href, asBuffer));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(url + ' -> HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : buf.toString('utf8'));
      });
    }).on('error', reject);
  });
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main() {
  const css = await get(SOURCE, false);
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  const rules = [];
  let m;
  while ((m = re.exec(css))) {
    const subset = m[1];
    if (!KEEP.has(subset)) continue;
    const block = m[2];
    const family = (block.match(/font-family:\s*'([^']+)'/) || [])[1];
    const weight = (block.match(/font-weight:\s*(\d+)/) || [])[1];
    const url = (block.match(/url\((https:[^)]+)\)/) || [])[1];
    const range = (block.match(/unicode-range:\s*([^;]+);/) || [])[1];
    if (!family || !weight || !url) continue;
    const file = `${slug(family)}-${weight}-${subset}.woff2`;
    rules.push({ family, weight, subset, url, range: range && range.trim(), file });
  }
  if (!rules.length) {
    console.error('No font-face rules matched — Google may have changed the CSS format.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0;
  for (const r of rules) {
    const buf = await get(r.url, true);
    fs.writeFileSync(path.join(OUT_DIR, r.file), buf);
    bytes += buf.length;
  }

  const header =
    '/* Web fonts, self-hosted — regenerate with `node scripts/fetch-fonts.cjs`.\n' +
    '   Same bytes as fonts.googleapis.com, but served from our own origin so the\n' +
    '   service worker can answer them from cache; the 5-minute Google stylesheet\n' +
    '   revalidation used to add a full round trip to every warm load. Keep the\n' +
    '   latin / latin-ext / devanagari subsets only. */\n\n';
  const body = rules
    .map((r) =>
      `@font-face {\n` +
      `  font-family: '${r.family}';\n` +
      `  font-style: normal;\n` +
      `  font-weight: ${r.weight};\n` +
      `  font-display: swap;\n` +
      `  src: url(../assets/fonts/${r.file}) format('woff2');\n` +
      (r.range ? `  unicode-range: ${r.range};\n` : '') +
      `}`
    )
    .join('\n\n');
  fs.writeFileSync(CSS_OUT, header + body + '\n');

  console.log(`${rules.length} font files, ${(bytes / 1024).toFixed(0)} KB -> assets/fonts/`);
  for (const r of rules) console.log(`  ${r.file}`);
  console.log(`css/fonts.css written (${fs.statSync(CSS_OUT).size} bytes)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
