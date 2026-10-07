// Review aid: find Firestore queries with no matching composite index.
// A missing composite index fails the query with FAILED_PRECONDITION /`failed-precondition`, which takes down a whole panel — it is what broke
// the referral stat cards — so this is checked at review time rather than in
// production.
//
// The matching rules below are not inferred; they were established by probing
// the live API with documents:runQuery and reading Firestore's own verdict:
//
//   * equality-only queries (no orderBy) merge single-field indexes and never
//     need a composite index, however many fields they filter;
//   * an unfiltered query is served by the automatic single-field index;
//   * otherwise one declared index must carry the orderBy run contiguously and
//     in the right direction, with every remaining index field equality-filtered
//     by the query. Equality filters the index omits are simply post-filtered.
//
// Run: node scripts/scan-indexes.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const declared = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8')
).indexes || [];

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(ROOT, 'js'));

// Every balanced-paren call to `token(` — same approach as scan-unbounded.cjs.
function callSpans(src, token) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf(token, i)) !== -1) {
    let depth = 0, j = i + token.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    out.push({ text: src.slice(i, j + 1), start: i });
    i = j + 1;
  }
  return out;
}
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// `query(...parts)` hides its clauses in `const parts = [...]` plus
// `parts.push(...)` calls, so pull them back out to see the real query. Only
// the declaration *preceding* this call counts — a file may build several
// different `parts` arrays, and a `parts` that is a function parameter
// (`loadRewards(parts)`) has no declaration at all, which returns null.
function builderClauses(src, name, pos) {
  const decl = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\[`, 'g');
  let declAt = -1;
  for (const m of src.matchAll(decl)) if (m.index < pos) declAt = m.index;
  if (declAt < 0) return null;

  let depth = 0, j = src.indexOf('[', declAt), end = j;
  for (; end < src.length; end++) {
    if (src[end] === '[') depth++;
    else if (src[end] === ']') { depth--; if (depth === 0) break; }
  }
  let text = src.slice(j + 1, end);

  const push = new RegExp(`\\b${name}\\.push\\(([\\s\\S]*?)\\)`, 'g');
  for (const m of src.matchAll(push)) {
    if (m.index > declAt && m.index < pos) text += ' ' + m[1];
  }
  return text;
}

const problems = [];
const skipped = [];

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');

  for (const span of callSpans(src, 'query(')) {
    let t = span.text;

    // Pull in clauses (and the collection) held by a spread builder.
    const spread = /\.\.\.([A-Za-z_$][\w$]*)/.exec(t);
    if (spread) {
      const b = builderClauses(src, spread[1], span.start);
      if (b === null) {
        skipped.push(`${rel}:${lineOf(src, span.start)} ('${spread[1]}' is passed in, not built here)`);
        continue;
      }
      t = `${t} ${b}`;
    }

    // Which collection, and what scope?
    const grp = /collectionGroup\s*\(\s*\w+\s*,\s*'([^']+)'/.exec(t);
    const plain = /collection\s*\(\s*\w+\s*,\s*'([^']+)'/.exec(t);
    const name = grp ? grp[1] : (plain ? plain[1] : null);
    if (!name) { skipped.push(`${rel}:${lineOf(src, span.start)} (collection not literal)`); continue; }
    const scope = grp ? 'COLLECTION_GROUP' : 'COLLECTION';

    const eq = new Set();      // equality / array-contains / in
    const ord = [];            // [{ f, dir, fromWhere }]
    let dynamic = false;

    for (const m of t.matchAll(/\bwhere\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
      eq.add(m[1]);
      if (!['==', 'array-contains', 'in'].includes(m[2])) {
        // Range and negated operators additionally pin that field as a sort key.
        ord.push({ f: m[1], dir: 'asc', fromWhere: true });
      }
    }
    for (const m of t.matchAll(/\borderBy\s*\(/g)) {
      const hit = /^\borderBy\s*\(\s*'([^']+)'\s*(?:,\s*'([^']+)'\s*)?/.exec(t.slice(m.index));
      if (!hit) { dynamic = true; continue; }
      ord.push({ f: hit[1], dir: (hit[2] || 'asc').toLowerCase() });
    }

    if (dynamic) { skipped.push(`${rel}:${lineOf(src, span.start)} (dynamic orderBy)`); continue; }

    const needed = new Set([...eq, ...ord.map((o) => o.f)]);
    if (needed.size < 2) continue;   // single field: automatic index covers it

    const candidates = declared.filter(
      (ix) => ix.collectionGroup === name && ix.queryScope === scope
    );
    if (!candidates.some((ix) => matches(ix.fields, eq, ord))) {
      problems.push({
        where: `${rel}:${lineOf(src, span.start)}`,
        query: `${scope === 'COLLECTION_GROUP' ? 'collectionGroup' : 'collection'} '${name}'`,
        fields: [...needed].join(', '),
        declared: candidates.length
          ? candidates.map((c) => '{' + c.fields.map((x) => `${x.fieldPath}:${(x.order || 'A').slice(0, 4)}`).join(' ') + '}').join('  ')
          : 'none'
      });
    }
  }
}

function matches(fields, eq, ord) {
  if (ord.length === 0) return true;          // equality only: merged single-field indexes
  if (eq.size === 0) return ord.length <= 1;  // unfiltered: one sort field is single-field-served

  const names = fields.map((x) => x.fieldPath);
  const orders = fields.map((x) => x.order || 'ASCENDING');
  // Merged builder branches (if unread) … (else if task) … each push their own
  // orderBy('createdAt'), which only ever executes once. Collapse repeats.
  const sortBy = [];
  for (const o of ord) {
    if (o.fromWhere) continue;
    if (sortBy.some((s) => s.f === o.f)) continue;
    sortBy.push(o);
  }
  if (!sortBy.length) return true;

  for (let p = 0; p + sortBy.length <= names.length; p++) {
    let run = true;
    for (let k = 0; k < sortBy.length; k++) {
      if (names[p + k] !== sortBy[k].f) { run = false; break; }
      const want = sortBy[k].dir === 'desc' ? 'DESCENDING' : 'ASCENDING';
      if (orders[p + k] !== want) { run = false; break; }
    }
    if (!run) continue;
    const rest = [...names.slice(0, p), ...names.slice(p + sortBy.length)];
    if (rest.every((n) => eq.has(n))) return true;
  }
  return false;
}

for (const p of problems) {
  console.log(`MISSING  ${p.where}`);
  console.log(`         ${p.query} on ${p.fields}`);
  console.log(`         declared for that collection: ${p.declared}`);
}
console.log(`\nQueries without a matching composite index: ${problems.length}`);
console.log(`Analysed multi-field queries: ${declared.length ? 'see above' : ''}${problems.length ? '' : ' (all covered)'}`);
if (skipped.length) {
  console.log(`Not analysed: ${skipped.length}`);
  for (const s of skipped.slice(0, 30)) console.log(`  ${s}`);
}
process.exit(problems.length ? 1 : 0);
