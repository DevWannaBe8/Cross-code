const { chat } = require('./ollama');

const POLICY = {
  a: 'use the value from version A',
  b: 'use the value from version B',
  auto: 'follow the developer notes; without notes use the value from version A'
};

function system(prefer) {
  return `You are a precise code merge engine. You merge two independently modified versions (A and B) of the same code region.
Rules:
1. Keep every change of both versions that does not contradict the other. Combine them into one coherent implementation.
2. If both versions changed the same thing to different values (a different timing, color, number, text or logic), keep exactly ONE value and never both: ${POLICY[prefer] || POLICY.a}. Never write the same declaration or statement twice.
3. Do not rename, reorder or reformat existing code unless required to avoid a name collision.
4. Never use placeholders, never omit code, never write conflict markers, never add explanations.
5. Match the indentation and style of the surrounding code.
6. Output ONLY the merged replacement for the conflict region (not the context), inside <merged></merged>.`;
}

const block = (lines) => '```\n' + lines.join('\n') + '\n```';

function buildPrompt(p) {
  let s = `File: ${p.path}
Developer notes A: ${p.notesA || '(none)'}
Developer notes B: ${p.notesB || '(none)'}

Context before the region:
${block(p.before)}

ORIGINAL region:
${p.o.length ? block(p.o) : '(not available or empty)'}

VERSION A:
${block(p.a)}

VERSION B:
${block(p.b)}

Context after the region:
${block(p.after)}
`;
  if (p.prev) s += `\nA previous attempt was rejected.\nPrevious result:\n${block(p.prev.code.split('\n'))}\nProblems found:\n- ${p.prev.issues.join('\n- ')}\nProduce a corrected result.\n`;
  return s + '\nReturn the merged region inside <merged></merged>.';
}

function extract(txt) {
  const m = txt.match(/<merged>([\s\S]*?)<\/merged>/);
  let s = m ? m[1] : txt;
  const f = s.match(/```[\w+-]*\n([\s\S]*?)```/);
  if (f) s = f[1];
  return s.replace(/^\r?\n/, '').replace(/\s+$/, '');
}

const ns = (l) => l.replace(/\s+/g, '');
const tok = (l) => new Set(l.toLowerCase().split(/[^a-z0-9_$-]+/).filter(Boolean));
function sim(x, y) {
  const A = tok(x), B = tok(y);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const t of A) if (B.has(t)) i++;
  return i / (A.size + B.size - i);
}

// Deterministische Pruefung, unabhaengig von der KI
function validate(p, code) {
  const issues = [];
  if (!code.trim() && (p.a.join('').trim() || p.b.join('').trim())) issues.push('The result is empty.');
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(code)) issues.push('Conflict markers are present.');
  const src = p.a.concat(p.b).join('\n');
  if (/^\s*(\/\/|#|\/\*)?\s*\.{3,}\s*(\*\/)?\s*$/m.test(code) && !/^\s*(\/\/|#|\/\*)?\s*\.{3,}/m.test(src)) issues.push('The result contains placeholders instead of real code.');

  const bal = (t) => {
    const c = { '(': 0, '[': 0, '{': 0 }, close = { ')': '(', ']': '[', '}': '{' };
    for (const ch of t) { if (ch in c) c[ch]++; else if (ch in close) c[close[ch]]--; }
    return c;
  };
  const ba = bal(p.a.join('\n')), bb = bal(p.b.join('\n')), bm = bal(code);
  for (const k of ['(', '[', '{']) if (ba[k] === 0 && bb[k] === 0 && bm[k] !== 0) issues.push(`Unbalanced brackets of type ${k}.`);

  // Zeilen aus A/B muessen vorkommen. Ausnahme: widerspruechliche Aenderungen (ein aehnlicher Wert der Gegenseite ist enthalten).
  const lines = code.split('\n').filter((l) => l.trim());
  const have = new Set(lines.map(ns)), orig = new Set(p.o.map(ns));
  const present = (l) => have.has(ns(l)) || lines.some((m) => sim(m, l) >= 0.85);
  for (const [name, mine, other] of [['A', p.a, p.b], ['B', p.b, p.a]]) {
    const miss = mine.filter((l) => {
      const k = ns(l);
      if (k.length < 4 || orig.has(k) || present(l)) return false;
      return !other.some((o) => !orig.has(ns(o)) && sim(o, l) >= 0.4 && present(o));
    });
    if (miss.length) issues.push(`Lines added by version ${name} are missing in the result, e.g.: ${miss.slice(0, 3).map((x) => x.trim()).join(' | ')}`);
  }

  // Widerspruechliche Werte derselben Eigenschaft (z. B. CSS "animation: ...") duerfen nicht beide stehen bleiben
  const key = (l) => { const m = l.trim().match(/^([\w-]+)\s*:/); return m ? m[1].toLowerCase() : null; };
  const kA = new Set(p.a.filter((l) => !orig.has(ns(l))).map(key).filter(Boolean));
  const both = new Set();
  for (const l of p.b) {
    const k = key(l);
    if (!k || orig.has(ns(l)) || !kA.has(k) || !have.has(ns(l))) continue;
    if (p.a.some((x) => key(x) === k && ns(x) !== ns(l) && have.has(ns(x)))) both.add(k);
  }
  if (both.size) issues.push(`Contradicting values of the same property were both kept (use only one): ${[...both].slice(0, 3).join(', ')}`);

  // Dieselbe Zeile darf nicht oefter vorkommen als in A, B oder dem Original
  const cnt = (arr) => { const m = new Map(); arr.map(ns).filter((k) => k.length >= 12).forEach((k) => m.set(k, (m.get(k) || 0) + 1)); return m; };
  const cm = cnt(lines), ca = cnt(p.a), cb = cnt(p.b), co = cnt(p.o);
  const dup = [...cm].filter(([k, n]) => n > Math.max(ca.get(k) || 0, cb.get(k) || 0, co.get(k) || 0));
  if (dup.length) issues.push(`Duplicated lines in the result, e.g.: ${dup.slice(0, 2).map(([k]) => k.slice(0, 80)).join(' | ')}`);
  return issues;
}

async function review(s, p, code) {
  const reply = await chat(s, [
    { role: 'system', content: 'You are a strict code reviewer. Answer with exactly "OK" or "PROBLEM: <short description>".' },
    { role: 'user', content: `Check the MERGED result. Report PROBLEM only for: lost functionality that both versions agree on, syntax errors, or code duplicated although it was not duplicated in A or B. Do NOT report a problem when a contradicting value was resolved by choosing one version.\n\nORIGINAL:\n${block(p.o)}\n\nA:\n${block(p.a)}\n\nB:\n${block(p.b)}\n\nMERGED:\n${block(code.split('\n'))}` }
  ], 7);
  const t = reply.trim();
  return /^OK\b/i.test(t) ? null : 'Review: ' + t.slice(0, 300);
}

async function resolve(s, p) {
  if (!s.model) throw new Error('NO_MODEL');
  const msgs = [{ role: 'system', content: system(s.prefer) }, { role: 'user', content: buildPrompt(p) }];
  const max = Math.max(1, Number(s.retries) + 1), seed = 42 + (p.round || 0) * 101;
  let best = null, attempts = 0;
  for (let i = 0; i < max; i++) {
    attempts++;
    const reply = await chat(s, msgs, seed + i);
    const code = extract(reply);
    let issues = validate(p, code);
    if (!issues.length && s.selfReview) { const rv = await review(s, p, code); if (rv) issues = [rv]; }
    if (!best || issues.length <= best.issues.length) best = { code, issues };
    if (!issues.length) break;
    msgs.push({ role: 'assistant', content: reply },
      { role: 'user', content: 'Your result has problems:\n- ' + issues.join('\n- ') + '\nFix them and return the complete corrected merged region again inside <merged></merged>.' });
  }
  if (!best.issues.length) return { code: best.code, issues: [], attempts, ok: true, nIssues: 0 };
  // Kein gueltiges Ergebnis: lieber eine komplette, in sich stimmige Seite als kaputten Mischcode
  if (s.fallback !== false) {
    const side = s.prefer === 'b' ? 'b' : 'a';
    return {
      code: p[side].join('\n'), attempts, ok: false, fallback: side, nIssues: best.issues.length,
      aiCode: best.code, aiIssues: best.issues,
      issues: best.issues.concat(`Fallback: version ${side.toUpperCase()} was used as a whole. Changes of the other version in this region are NOT included. Please review.`)
    };
  }
  return { code: best.code, issues: best.issues, attempts, ok: false, nIssues: best.issues.length };
}

module.exports = { resolve, validate };