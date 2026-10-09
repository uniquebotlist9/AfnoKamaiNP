// Validate every HTML file:
//  1. Importmap entries (local paths) resolve to real files.
//  2. <script src>, <link href>, <img src> local refs resolve.
//  3. ES-module import specifiers in imported JS resolve via importmap or relative path.
//  4. Importmaps are consistent across files.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = process.cwd();
const htmlFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.firebase', '.tmp-awdump'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.html')) htmlFiles.push(p);
  }
})(ROOT);

const problems = [];
const importmapVariants = new Map();

function attrRefs(html) {
  const refs = [];
  // script src / link href / img src / iframe src / source src / a href to files
  const re = /<(script|link|img|iframe|source|audio|video)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) refs.push({ tag: m[1], attr: m[2], url: m[3], index: m.index });
  return refs;
}

function checkLocalUrl(htmlFile, url) {
  if (!url) return null;
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('mailto:') ||
      url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('blob:')) return null;
  let path = url.split('?')[0].split('#')[0];
  if (!path) return null;
  if (path.startsWith('/')) path = path.slice(1);
  else path = relative(ROOT, resolve(dirname(htmlFile), path));
  return path;
}

for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);

  // --- importmap consistency ---
  const imMatch = html.match(/<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (imMatch) {
    let parsed = null;
    try { parsed = JSON.parse(imMatch[1]); } catch (e) { problems.push(`${rel}: importmap JSON invalid — ${e.message}`); }
    if (parsed) {
      const sig = JSON.stringify(parsed);
      if (!importmapVariants.has(sig)) importmapVariants.set(sig, []);
      importmapVariants.get(sig).push(rel);
      for (const [spec, target] of Object.entries(parsed.imports || {})) {
        if (/^https?:/.test(target)) continue;
        const p = target.startsWith('/') ? target.slice(1) : relative(ROOT, resolve(dirname(f), target));
        if (!existsSync(p)) problems.push(`${rel}: importmap "${spec}" → ${target} MISSING`);
      }
    }
  }

  // --- resource refs ---
  for (const { tag, attr, url } of attrRefs(html)) {
    const p = checkLocalUrl(f, url);
    if (p && !existsSync(p)) problems.push(`${rel}: <${tag} ${attr}="${url}"> MISSING (${p})`);
  }

  // --- inline module imports ---
  const inlineModules = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, code] of inlineModules) {
    for (const im of code.matchAll(/(?:^|[^\w.)])import\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"']+)["']/g)) {
      checkSpecifier(f, rel, im[1], parsedImportmap(parsedOrNull(html)));
    }
  }
}

function parsedOrNull(html) {
  const m = html.match(/<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function parsedImportmap(map) { return map && map.imports ? map.imports : {}; }

function checkSpecifier(htmlFile, rel, spec, imports) {
  if (/^https?:/.test(spec)) return;
  // bare specifier
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    const keys = Object.keys(imports);
    const matched = keys.some((k) => (k.endsWith('/') ? spec.startsWith(k) : spec === k));
    if (!matched) problems.push(`${rel}: bare import "${spec}" not in importmap`);
    return;
  }
  const p = spec.startsWith('/') ? spec.slice(1) : relative(ROOT, resolve(dirname(htmlFile), spec));
  if (!existsSync(p)) problems.push(`${rel}: import "${spec}" MISSING (${p})`);
}

// --- external module graph: resolve relative imports in js/ ---
const jsFiles = [];
(function walkJs(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.firebase', '.tmp-awdump'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJs(p);
    else if (name.endsWith('.js')) jsFiles.push(p);
  }
})(ROOT);

// Gather a global importmap (union of all variants) for bare-specifier resolution.
let globalImports = {};
for (const sig of importmapVariants.keys()) Object.assign(globalImports, JSON.parse(sig).imports || {});

for (const f of jsFiles) {
  const rel = relative(ROOT, f);
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:^|[^\w.)])import\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"']+)["']/g)) {
    const spec = m[1];
    if (/^https?:/.test(spec)) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      const keys = Object.keys(globalImports);
      const matched = keys.some((k) => (k.endsWith('/') ? spec.startsWith(k) : spec === k));
      if (!matched) problems.push(`${rel}: bare import "${spec}" not in any importmap`);
      continue;
    }
    const base = spec.startsWith('/') ? spec.slice(1) : relative(ROOT, resolve(dirname(f), spec));
    const candidates = [base, `${base}.js`, join(base, 'index.js')];
    if (!candidates.some((c) => existsSync(c))) problems.push(`${rel}: import "${spec}" MISSING`);
  }
  // dynamic import() specifiers
  for (const m of src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];
    if (/^(https?:|data:)/.test(spec)) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      const keys = Object.keys(globalImports);
      if (!keys.some((k) => (k.endsWith('/') ? spec.startsWith(k) : spec === k))) problems.push(`${rel}: dynamic bare import "${spec}" not in importmap`);
      continue;
    }
    const base = spec.startsWith('/') ? spec.slice(1) : relative(ROOT, resolve(dirname(f), spec));
    if (![base, `${base}.js`, join(base, 'index.js')].some((c) => existsSync(c))) problems.push(`${rel}: dynamic import "${spec}" MISSING`);
  }
}

console.log(`HTML files: ${htmlFiles.length}`);
console.log(`Importmap variants: ${importmapVariants.size}`);
for (const [sig, files] of importmapVariants) {
  console.log(`  variant (${files.length} files): ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`);
}
console.log(`\nProblems: ${problems.length}`);
for (const p of problems) console.log('  ' + p);
