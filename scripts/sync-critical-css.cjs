// ─── Critical-CSS synchroniser ─────────────────────────────────────────
//
// The auth / entry pages used to block first paint on two full stylesheets
// (global.css is 69 KB). A visitor saw a blank screen until BOTH had been
// downloaded and parsed, even though the only thing on screen is a logo, a
// spinner and a form.
//
// This script makes paint depend on the HTML alone:
//
//   1. it slices the rules an auth page actually needs out of css/global.css
//      (design tokens, base/typography, focus, brand, buttons + keyframes,
//      forms, cards, badges, states, setup screens, the dark-theme token
//      block, skip-link, reduced-motion), appends css/auth.css, minifies the
//      result and inlines it between the ak-critical markers in each page;
//   2. it flips those pages' stylesheet links to media="print" data-akcss,
//      so the FULL css keeps downloading in the background without holding
//      the renderer hostage. js/head.js swaps media back to "all" on load —
//      the same trick the Google Fonts link has always used here;
//   3. it adds a <noscript> copy of the links, so a no-JS visitor still
//      gets a styled page.
//
// Re-run it after ANY edit to css/global.css, css/auth.css or the page list:
//
//     node scripts/sync-critical-css.cjs
//
// It is idempotent — running it twice changes nothing. The CI can use
// `node scripts/sync-critical-css.cjs --check` to fail when it is stale.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Pages that paint real content straight from HTML (routers + auth flow).
// App pages are NOT listed: they already carry a fully self-contained inline
// splash, so nothing of theirs depends on the stylesheet to appear.
const PAGES = [
  'index.html',
  'login.html',
  'signup.html',
  'verify-email.html',
  'profile-setup.html',
  'maintenance.html',
  'ref.html'
];

/**
 * Slices of css/global.css that make up "critical". Each boundary is an
 * anchor string rather than a line number, so the day someone inserts a
 * section the extract does not silently drift — a missing anchor is a hard
 * error telling you to update this list.
 *
 * `nth` picks the nth occurrence of `from` (1-based, default 1).
 */
const REGIONS = [
  { from: ':root {', to: '/* \u2500\u2500 Buttons' },                       // tokens, reset, base, typography, focus, brand
  { from: '/* \u2500\u2500 Buttons', to: '/* \u2500\u2500 Toasts' },        // buttons, keyframes, forms, cards, badges
  { from: '/* \u2500\u2500 States', to: '/* \u2500\u2500 Tables' },         // .state-block + shimmer
  { from: '/* \u2500\u2500 Setup / config screens', to: '/* \u2500\u2500 Banned overlay' },
  { from: 'Dark theme (Light / Dark / System', to: '/* \u2500\u2500 Key-value stat cells' },
  { from: '@keyframes fade-in {', to: '/* Anchor jumps land clear', nth: 2 }, // animation lib + .skip-link
  { from: 'Reduced motion \u2014 the OS preference wins', to: '\u0000EOF' }
];

const START_MARK = '<!-- ak-critical:start -->';
const END_MARK = '<!-- ak-critical:end -->';

function fail(msg) {
  console.error('sync-critical-css: ' + msg);
  process.exit(1);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** nth-occurrence indexOf, or -1. */
function indexOfN(hay, needle, nth) {
  let i = -1;
  for (let n = 0; n < nth; n++) {
    i = hay.indexOf(needle, i + 1);
    if (i === -1) return -1;
  }
  return i;
}

/**
 * Several anchors are section titles that live INSIDE the comment that
 * introduces the section. Slicing from the title would start mid-comment and
 * leave the tail of the comment sitting in the output as literal text, so
 * walk back to the comment opener whenever the anchor falls inside one.
 */
function expandToCommentStart(src, i) {
  const open = src.lastIndexOf('/*', i);
  if (open === -1) return i;
  const close = src.indexOf('*/', open + 2);
  return close === -1 || close > i ? open : i;
}

function sliceCritical(globalCss) {
  const parts = [];
  for (const r of REGIONS) {
    const nth = r.nth || 1;
    const found = indexOfN(globalCss, r.from, nth);
    if (found === -1) fail(
      `anchor ${JSON.stringify(r.from)}${nth > 1 ? ` (occurrence ${nth})` : ''} not found in css/global.css — ` +
      'a section moved or was renamed; update REGIONS in scripts/sync-critical-css.cjs'
    );
    const start = expandToCommentStart(globalCss, found);
    let end;
    if (r.to === '\u0000EOF') end = globalCss.length;
    else {
      end = globalCss.indexOf(r.to, found + r.from.length);
      if (end === -1) fail(`end anchor ${JSON.stringify(r.to)} not found after ${JSON.stringify(r.from)}`);
    }
    parts.push(globalCss.slice(start, end));
  }
  return parts.join('\n');
}

/**
 * Comment-strip + whitespace squeeze. String literals (the `url("data:…")`
 * select chevron in particular) are lifted out first, so the punctuation
 * rules can never rewrite the inside of a data URI.
 */
function minify(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const parts = noComments.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g);
  return parts
    .map((p, i) => (i % 2
      ? p
      : p
        .replace(/\s+/g, ' ')
        .replace(/\s*([{}])\s*/g, '$1')
        .replace(/;\s+/g, ';')
        .replace(/\s*:\s+/g, ':')
        .replace(/\s*,\s*/g, ',')))
    .join('')
    .trim();
}

function buildCriticalCss() {
  const slice = sliceCritical(read('css/global.css'));
  const auth = read('css/auth.css');
  return minify(slice + '\n' + auth);
}

/** Swap local stylesheet links to the non-blocking form (idempotent). */
function deferStylesheets(html) {
  return html.replace(
    /<link rel="stylesheet" (?![^>]*media=)(?![^>]*data-akfonts)(href="(?:\.\/)?\/?css\/[^"]+")>/g,
    '<link rel="stylesheet" media="print" data-akcss $1>'
  );
}

/** Every previous <noscript> stylesheet block — lifted out before rewriting. */
const NOSCRIPT_RE = /\s*<noscript><link rel="stylesheet"[\s\S]*?<\/noscript>/g;

/** Rebuild the <noscript> mirror from the deferred links (idempotent). */
function insertNoscript(html) {
  const matches = [...html.matchAll(/<link rel="stylesheet" media="print" data-akcss [^>]+>/g)];
  if (!matches.length) return html;
  const links = matches
    .map((m) => m[0].replace(' media="print" data-akcss', ''))
    .join('');
  const last = matches[matches.length - 1];
  const at = last.index + last[0].length;
  return html.slice(0, at) + `\n  <noscript>${links}</noscript>` + html.slice(at);
}

/** Drop any previously written block, then insert the fresh one (idempotent). */
function writeCriticalBlock(html, css) {
  html = html.replace(
    new RegExp(START_MARK + '[\\s\\S]*?' + END_MARK + '\\s*', 'g'),
    ''
  );
  const block = `${START_MARK}\n  <style>${css}</style>\n  ${END_MARK}\n  `;
  // Prefer to sit directly after the (non-blocking) font stylesheet: that
  // keeps the blocking-free CSS as high in <head> as possible.
  const anchor = /<link rel="stylesheet" media="print" data-akfonts[^>]+>/;
  if (anchor.test(html)) return html.replace(anchor, (m) => m + '\n  ' + block);
  const alt = /<link rel="stylesheet" media="print" data-akcss[^>]+>/;
  if (alt.test(html)) return html.replace(alt, (m) => m + '\n  ' + block);
  return fail('no anchor found to insert the critical block into ' + html.slice(0, 60));
}

function transform(page, css) {
  let html = read(page);
  const before = html;
  // Lift the generated pieces out first so the link rewriter can never
  // re-process a <noscript> link (which would then be re-emitted forever).
  html = html.replace(NOSCRIPT_RE, '');
  html = deferStylesheets(html);
  html = writeCriticalBlock(html, css);
  html = insertNoscript(html);
  if (html === before && !html.includes(START_MARK)) fail('no change produced for ' + page);
  return html;
}

function main() {
  const check = process.argv.includes('--check');
  const css = buildCriticalCss();
  let stale = 0;

  for (const page of PAGES) {
    const file = path.join(ROOT, page);
    if (!fs.existsSync(file)) fail('missing page ' + page);
    const next = transform(page, css);
    const current = fs.readFileSync(file, 'utf8');
    if (current === next) continue;
    stale++;
    if (check) {
      console.error('stale: ' + page);
    } else {
      fs.writeFileSync(file, next);
      console.log('updated ' + page);
    }
  }

  if (check && stale) fail(`${stale} page(s) out of date — run: node scripts/sync-critical-css.cjs`);
  const gz = require('zlib').gzipSync(Buffer.from(css)).length;
  console.log(
    `${check ? 'checked' : 'synced'} ${PAGES.length} pages — critical css ` +
    `${css.length} bytes raw, ${gz} bytes gzipped`
  );
}

main();
