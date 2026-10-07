// Heuristic XSS audit: find template-literal interpolations that are written
// into HTML without passing through esc()/rich() (or an equivalent safe call).
// Not a security proof — a review aid. Run: node scripts/scan-xss.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = new Set(['.js', '.cjs', '.html']);

// Functions whose return value is safe to interpolate as HTML/text.
const SAFE = ['esc', 'rich', 'icon', 'logo', 'badge', 'emptyState', 'errorState',
  'spinnerBlock', 'skeletonRows', 'fmtNPR', 'fmtDate', 'fmtDateTime', 'fmtTime',
  'fmtRelative', 'fmtBytes', 'fmtPaisa', 'initials', 'dayLabel', 'countdownUntil',
  'greeting', 'actionHTML', 'presenceHtml'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

// Extract ${...} expressions from a raw template-literal body (braces balanced).
function interpolations(body) {
  const found = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 0, j = i + 1, instr = null;
      for (; j < body.length; j++) {
        const c = body[j];
        if (instr) {
          if (c === '\\') { j++; continue; }
          if (c === instr) instr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') { instr = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
      found.push({ expr: body.slice(i + 2, j), start: i });
      i = j;
    }
  }
  return found;
}

const SAFE_EXPR = new RegExp(`\\b(${SAFE.join('|')})\\s*\\(`);
// Ternaries/constants-only are usually fine (string literals, numbers, booleans).
const LITERAL_ONLY = /^\s*['"`]|\btrue\b|\bfalse\b|\bnull\b|\bundefined\b/;

const hits = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  // crude template-literal scan: backticks not inside comments/strings
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (!line.includes('${')) continue;
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    const body = line;
    for (const { expr } of interpolations(body)) {
      if (SAFE_EXPR.test(expr)) continue;
      if (LITERAL_ONLY.test(expr)) continue;
      // arithmetic/number-only
      if (/^[\d\s+\-*/().,]+$/.test(expr)) continue;
      // likely not HTML: assignment of plain data into a DOM/text node
      hits.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: ln + 1,
        expr: expr.slice(0, 160),
        text: line.trim().slice(0, 200)
      });
    }
  }
}

console.log(`Total candidate interpolations: ${hits.length}\n`);
const byFile = {};
for (const h of hits) (byFile[h.file] ||= []).push(h);
for (const [f, hs] of Object.entries(byFile)) {
  console.log(`── ${f}`);
  for (const h of hs) console.log(`   ${h.line}: \${${h.expr}}`);
  console.log('');
}
