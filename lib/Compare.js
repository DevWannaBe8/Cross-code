const fs = require('fs');
const path = require('path');
const Diff = require('diff');
const { diff3Merge } = require('node-diff3');

const BUILTIN_IGNORE = new Set(['.git', 'node_modules']);

// Muster: "ordner/unter" (Pfadpraefix) oder "*.log" / "name" (passt auf jeden Pfadteil). * = beliebig ausser /, ** = beliebig.
function makeIgnore(text) {
  const toRe = (p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]') + '$');
  const rules = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map((p) => {
    const c = p.replace(/^\/+|\/+$/g, '');
    return { slash: c.includes('/'), re: toRe(c) };
  });
  return (rel) => {
    const segs = rel.split('/');
    if (segs.some((s) => BUILTIN_IGNORE.has(s))) return true;
    return rules.some((r) => (r.slash ? segs.some((_, i) => r.re.test(segs.slice(0, i + 1).join('/'))) : segs.some((s) => r.re.test(s))));
  };
}

function walk(root, ignored) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  (function rec(d, relDir) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (ignored(rel)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p, rel);
      else if (e.isFile()) out.push(rel);
    }
  })(root, '');
  return out;
}

function read(root, rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  const bin = buf.includes(0) || buf.length > 3e6;
  return { buf, bin, text: bin ? '' : buf.toString('utf8') };
}

const split = (t) => t.split(/\r?\n/);

function single(root, rel, status) {
  const f = read(root, rel);
  return { path: rel, status, preview: f.bin ? '' : f.text.slice(0, 4000) };
}

const GAP = 8; // Konflikte, die weniger als GAP Zeilen auseinanderliegen, werden zu einem Block zusammengefasst

function normalize(chunks) {
  const out = [];
  for (const c of chunks) {
    const l = out[out.length - 1];
    if (c.type === 'ok' && l && l.type === 'ok') l.lines = l.lines.concat(c.lines);
    else out.push(c.type === 'ok' ? { type: 'ok', lines: c.lines.slice() } : c);
  }
  return out;
}

// Die Zeilen dazwischen sind bereits aufgeloester Text und stehen daher in A, B und Original gleich.
function coalesce(chunks, hasBase) {
  const out = [];
  for (const c of chunks) {
    const n = out.length;
    if (c.type === 'conflict' && n >= 2 && out[n - 1].type === 'ok' && out[n - 1].lines.length <= GAP && out[n - 2].type === 'conflict') {
      const gap = out[n - 1].lines, p = out[n - 2];
      p.a = p.a.concat(gap, c.a); p.b = p.b.concat(gap, c.b); p.o = hasBase ? p.o.concat(gap, c.o) : [];
      out.pop();
    } else out.push(c);
  }
  return out;
}

function mergeText(rel, A, B, O) {
  const al = split(A.text), bl = split(B.text);
  let chunks = [], union = 0;
  if (O) {
    for (const r of diff3Merge(al, split(O.text), bl, true)) {
      if (r.ok) chunks.push({ type: 'ok', lines: r.ok });
      else chunks.push({ type: 'conflict', a: r.conflict.a, o: r.conflict.o, b: r.conflict.b, aFrom: r.conflict.aIndex + 1, bFrom: r.conflict.bIndex + 1, resolution: null });
    }
    chunks = coalesce(normalize(chunks), true);
  } else {
    // Ohne Originalstand: gemeinsame Zeilen sind die Basis. Bloecke, die nur in einem Stand vorkommen
    // (z. B. eine neue Funktion), werden komplett uebernommen. Nur echte Abweichungen sind Konflikte.
    let ai = 0, bi = 0, pa = [], pb = [], pai = 0, pbi = 0;
    const flush = () => {
      if (!pa.length && !pb.length) return;
      if (!pa.length || !pb.length) { union++; chunks.push({ type: 'ok', lines: pa.length ? pa : pb }); }
      else chunks.push({ type: 'conflict', a: pa, o: [], b: pb, aFrom: pai + 1, bFrom: pbi + 1, resolution: null });
      pa = []; pb = [];
    };
    for (const part of Diff.diffArrays(al, bl)) {
      if (part.added) { if (!pa.length && !pb.length) { pai = ai; pbi = bi; } pb = pb.concat(part.value); bi += part.count; }
      else if (part.removed) { if (!pa.length && !pb.length) { pai = ai; pbi = bi; } pa = pa.concat(part.value); ai += part.count; }
      else { flush(); chunks.push({ type: 'ok', lines: part.value }); ai += part.count; bi += part.count; }
    }
    flush();
    chunks = coalesce(normalize(chunks), false);
  }
  const hasConflict = chunks.some((c) => c.type === 'conflict');
  return { path: rel, status: hasConflict ? 'conflict' : 'merged', hasBase: !!O, union, eol: A.text.includes('\r\n') ? '\r\n' : '\n', chunks };
}

function compareProjects(a, b, base, ignoreText) {
  const ig = makeIgnore(ignoreText);
  const fa = new Set(walk(a, ig)), fb = new Set(walk(b, ig)), fo = new Set(walk(base, ig));
  const files = [];
  for (const p of [...new Set([...fa, ...fb])].sort()) {
    if (fa.has(p) && !fb.has(p)) { files.push(single(a, p, 'onlyA')); continue; }
    if (fb.has(p) && !fa.has(p)) { files.push(single(b, p, 'onlyB')); continue; }
    const A = read(a, p), B = read(b, p);
    if (A.buf.equals(B.buf)) { files.push({ path: p, status: 'same', preview: A.bin ? '' : A.text.slice(0, 4000) }); continue; }
    if (A.bin || B.bin) { files.push({ path: p, status: 'binary' }); continue; }
    files.push(mergeText(p, A, B, fo.has(p) ? read(base, p) : null));
  }
  const rank = { conflict: 0, binary: 1, merged: 2, onlyA: 3, onlyB: 3, same: 4 };
  files.sort((x, y) => rank[x.status] - rank[y.status] || x.path.localeCompare(y.path));
  return { files };
}

module.exports = { compareProjects };