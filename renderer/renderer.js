const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let S;
const state = {
  paths: { a: '', b: '', base: '', out: '' }, res: null, sel: 0, view: 'file', busy: false, cancel: false,
  mode: 'list', filter: 'relevant', query: '', folders: new Map(), report: null
};
const t = (k, v) => {
  let s = (I18N[S.language] || I18N.de)[k] || k;
  if (v) for (const x in v) s = s.replace('{' + x + '}', v[x]);
  return s;
};

function applyLang() {
  document.documentElement.lang = S.language;
  document.querySelectorAll('[data-i18n]').forEach((e) => (e.textContent = t(e.dataset.i18n)));
  document.querySelectorAll('[data-i18n-ph]').forEach((e) => (e.placeholder = t(e.dataset.i18nPh)));
  $('#sf-filter').innerHTML = [['relevant', 'fRelevant'], ['all', 'fAll'], ['conflicts', 'fConflicts']]
    .map(([v, k]) => `<option value="${v}" ${state.filter === v ? 'selected' : ''}>${esc(t(k))}</option>`).join('');
  if (state.res) refresh();
}
function showView(v) {
  document.querySelectorAll('.view').forEach((e) => (e.hidden = e.id !== 'view-' + v));
  document.querySelectorAll('.tab').forEach((e) => e.classList.toggle('active', e.dataset.view === v));
}
function setMsg(el, text, kind) { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }
const refresh = () => { renderList(); renderDetail(); updateBar(); };

async function checkAI() {
  const box = $('#aiStatus');
  const r = await api.models();
  if (r.error) { box.className = 'ai off'; $('#aiText').textContent = t('aiOffline'); return r; }
  if (!S.model) { box.className = 'ai off'; $('#aiText').textContent = t('aiNoModel'); return r; }
  box.className = 'ai on'; $('#aiText').textContent = t('aiOn', { m: S.model });
  return r;
}

/* ---------- Auswahl und Vergleich ---------- */
document.addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const p = await api.pickFolder();
    if (p) { state.paths[pick.dataset.pick] = p; $('#p-' + pick.dataset.pick).value = p; }
  }
  const tab = e.target.closest('.tab');
  if (tab) showView(tab.dataset.view);
});

$('#compareBtn').onclick = async () => {
  const { a, b, base, out } = state.paths, msg = $('#setupMsg');
  if (!a || !b || !out) return setMsg(msg, t('needFolders'), 'err');
  if (out === a || out === b) return setMsg(msg, t('sameFolder'), 'err');
  setMsg(msg, t('comparing'));
  const r = await api.compare({ a, b, base });
  if (r.error) return setMsg(msg, t('error') + r.error, 'err');
  r.files.forEach((f) => { f.include = true; f.binChoice = 'a'; });
  Object.assign(state, { res: r, sel: Math.max(0, r.files.findIndex((f) => f.status === 'conflict')), view: 'file', report: null, folders: new Map() });
  setMsg(msg, '');
  $('#setup').hidden = true; $('#workspace').hidden = false; $('#bar').hidden = false;
  refresh();
};

/* ---------- Daten-Helfer ---------- */
const conflicts = (f) => (f.chunks || []).filter((c) => c.type === 'conflict');
const isResolved = (f) => f.status !== 'conflict' || conflicts(f).every((c) => c.resolution !== null);
const dispStatus = (f) => (f.status === 'conflict' && isResolved(f) ? 'resolved' : f.status);
const toLines = (s) => (s === '' ? [] : s.split(/\r?\n/));
const buildText = (f) => f.chunks.flatMap((c) => (c.type === 'ok' ? c.lines : toLines(c.resolution || ''))).join(f.eol);
const openList = () => {
  const out = [];
  state.res.files.forEach((f) => { if (f.include && f.status === 'conflict') f.chunks.forEach((c, i) => { if (c.type === 'conflict' && c.resolution === null) out.push([f, i]); }); });
  return out;
};
const openCount = () => openList().length;
const failedList = () => {
  const out = [];
  state.res.files.forEach((f) => { if (f.include && f.status === 'conflict') f.chunks.forEach((c, i) => { if (c.type === 'conflict' && c.resolution !== null && c.ai && !c.ai.ok) out.push([f, i]); }); });
  return out;
};
const visible = (f) =>
  (state.filter === 'all' || (state.filter === 'relevant' && f.status !== 'same') || (state.filter === 'conflicts' && (f.status === 'conflict' || f.status === 'binary'))) &&
  (!state.query || f.path.toLowerCase().includes(state.query));

/* ---------- Seitenleiste: Liste und Baum ---------- */
function renderNode(n, prefix) {
  let h = '';
  for (const name of Object.keys(n.dirs).sort()) {
    const p = prefix + name + '/', all = state.res.files.filter((f) => f.path.startsWith(p));
    const attn = all.some((f) => (f.status === 'conflict' && !isResolved(f)) || f.status === 'binary');
    const open = state.folders.has(p) ? state.folders.get(p) : attn;
    h += `<details data-p="${esc(p)}" ${open ? 'open' : ''}><summary><input type="checkbox" class="dchk" data-p="${esc(p)}" ${all.every((f) => f.include) ? 'checked' : ''}><span class="dname">${esc(name)}</span>${attn ? '<span class="dotst s-conflict"></span>' : ''}<span class="dcount">${all.length}</span></summary><div class="tchildren">${renderNode(n.dirs[name], p)}</div></details>`;
  }
  for (const x of n.files.sort((a, b) => a.name.localeCompare(b.name))) {
    const k = dispStatus(x.f);
    h += `<div class="file tf ${state.view === 'file' && x.i === state.sel ? 'active' : ''}" data-i="${x.i}"><span class="dotst s-${k}"></span><span class="fname2" title="${esc(x.f.path)}">${esc(x.name)}</span><span class="tstat">${esc(t('st_' + k))}</span></div>`;
  }
  return h;
}
function treeHtml(items) {
  const root = { dirs: {}, files: [] };
  for (const { f, i } of items) {
    const parts = f.path.split('/');
    let n = root;
    for (const p of parts.slice(0, -1)) n = n.dirs[p] || (n.dirs[p] = { dirs: {}, files: [] });
    n.files.push({ f, i, name: parts[parts.length - 1] });
  }
  return renderNode(root, '');
}
function renderList() {
  const r = state.res, cnt = {};
  r.files.forEach((f) => { const k = dispStatus(f); cnt[k] = (cnt[k] || 0) + 1; });
  const items = r.files.map((f, i) => ({ f, i })).filter((x) => visible(x.f));
  const hid = r.files.length - items.length;
  $('#summary').innerHTML = `<div class="sumhead">${r.files.length} ${esc(t('files'))}${hid ? ` <span class="muted" style="margin:0">(${esc(t('hidden', { n: hid }))})</span>` : ''}</div>` +
    Object.keys(cnt).map((k) => `<div class="sumrow"><span>${esc(t('st_' + k))}</span><b>${cnt[k]}</b></div>`).join('') +
    `<button class="btn small" id="backBtn">${esc(t('back'))}</button>`;
  $('#backBtn').onclick = () => { $('#setup').hidden = false; $('#workspace').hidden = true; $('#bar').hidden = true; state.res = null; };
  $('#m-list').classList.toggle('active', state.mode === 'list');
  $('#m-tree').classList.toggle('active', state.mode === 'tree');
  if (!items.length) { $('#fileList').innerHTML = `<div class="empty">${esc(t('noMatch'))}</div>`; return; }
  $('#fileList').innerHTML = state.mode === 'tree' ? treeHtml(items) : items.map(({ f, i }) => {
    const k = dispStatus(f);
    return `<div class="file ${state.view === 'file' && i === state.sel ? 'active' : ''}" data-i="${i}"><span class="badge b-${k}">${esc(t('st_' + k))}</span><span class="fname" title="${esc(f.path)}">&lrm;${esc(f.path)}</span></div>`;
  }).join('');
}
$('#fileList').addEventListener('click', (e) => {
  const chk = e.target.closest('.dchk');
  if (chk) {
    e.preventDefault();
    const files = state.res.files.filter((f) => f.path.startsWith(chk.dataset.p));
    const to = !files.every((f) => f.include);
    files.forEach((f) => (f.include = to));
    refresh();
    return;
  }
  const el = e.target.closest('.file');
  if (el) { state.sel = Number(el.dataset.i); state.view = 'file'; refresh(); }
});
$('#fileList').addEventListener('toggle', (e) => { if (e.target.dataset && e.target.dataset.p) state.folders.set(e.target.dataset.p, e.target.open); }, true);
$('#sf-q').oninput = (e) => { state.query = e.target.value.trim().toLowerCase(); if (state.res) renderList(); };
$('#sf-filter').onchange = (e) => { state.filter = e.target.value; if (state.res) renderList(); };
$('#m-list').onclick = () => { state.mode = 'list'; renderList(); };
$('#m-tree').onclick = () => { state.mode = 'tree'; renderList(); };

/* ---------- Detailbereich ---------- */
function cardHtml(f, c, idx, n) {
  const cols = [['a', t('colA'), c.a], ...(f.hasBase ? [['o', t('colO'), c.o]] : []), ['b', t('colB'), c.b]];
  const info = c.busy ? `<div class="info">${esc(t('aiBusy'))}</div>`
    : c.err ? `<div class="msg err">${esc(c.err)}</div>`
    : c.ai ? (c.ai.ok ? `<div class="info">${esc(t('aiOk', { n: c.ai.attempts }))}</div>`
      : `<div class="info">${esc(t('aiWarn', { n: c.ai.attempts }))}</div><ul class="issues">${c.ai.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`) : '';
  const rows = Math.min(24, Math.max(5, (c.resolution || '').split('\n').length + 1));
  return `<div class="cc" data-ci="${idx}">
    <div class="cchead"><b>${esc(t('conflict'))} ${n}</b><span class="muted" style="margin:0">${esc(t('lineA'))}: ${esc(t('line'))} ${c.aFrom}-${c.aFrom + Math.max(c.a.length, 1) - 1} &nbsp; ${esc(t('lineB'))}: ${esc(t('line'))} ${c.bFrom}-${c.bFrom + Math.max(c.b.length, 1) - 1}</span></div>
    <div class="cols ${f.hasBase ? '' : 'two'}">${cols.map(([k, h, l]) => `<div class="col ${k}"><div class="colh">${esc(h)}</div><pre>${esc(l.join('\n'))}</pre></div>`).join('')}</div>
    <div class="colh muted">${esc(t('result'))}</div>
    <textarea class="res" rows="${rows}" spellcheck="false" ${c.busy ? 'disabled' : ''}>${esc(c.resolution === null ? '' : c.resolution)}</textarea>
    <div class="ccbtns">
      <button class="btn small primary" data-act="ai" ${c.busy || state.busy ? 'disabled' : ''}>${esc(t('ai'))}</button>
      <button class="btn small" data-act="a">${esc(t('takeA'))}</button>
      <button class="btn small" data-act="b">${esc(t('takeB'))}</button>
      <button class="btn small" data-act="both">${esc(t('both'))}</button>
    </div>${info}</div>`;
}

const fmtPct = (x) => (Math.floor(x * 100) / 100).toFixed(2).replace('.', S.language === 'de' ? ',' : '.');
function renderReport() {
  const r = state.report;
  if (!r) { $('#detail').innerHTML = `<h3>${esc(t('reportTitle'))}</h3><p class="muted">${esc(t('reportNone'))}</p><button class="btn primary" id="runVerify">${esc(t('runCheck'))}</button>`; return; }
  const pct = r.total ? fmtPct((r.passed / r.total) * 100) + ' %' : '-';
  $('#detail').innerHTML = `<h3>${esc(t('reportTitle'))}</h3>
    <div class="score ${r.fails.length ? 'warn' : 'good'}"><span class="pct">${pct}</span><span class="muted" style="margin:0">${esc(t('reportDetail', { p: r.passed, n: r.total }))}</span></div>
    <p class="info">${esc(t('reportSplit', { ai: r.aiCount, m: r.manual, u: r.unchecked.length }))}</p>
    <h3 style="margin:16px 0 8px;font-size:14px">${esc(t('reportFails'))}</h3>
    ${r.fails.length ? r.fails.map((x) => `<button class="failrow" data-i="${x.i}"><b>${esc(x.path)}</b> (${esc(x.label)})<span>${esc(x.msg)}</span></button>`).join('') : `<p class="muted">${esc(t('reportOk'))}</p>`}
    <p class="info" style="margin-top:16px">${esc(t('reportNote'))}</p>
    ${r.heur ? `<p class="info">${esc(t('reportPhp'))}</p>` : ''}
    <div class="ccbtns"><button class="btn" id="runVerify">${esc(t('rerun'))}</button>${failedList().length ? `<button class="btn primary" id="retryFailed">${esc(t('retryFailed'))}</button>` : ''}</div>`;
}

function renderDetail() {
  if (state.view === 'report') return renderReport();
  const f = state.res.files[state.sel];
  if (!f) { $('#detail').innerHTML = ''; return; }
  const k = dispStatus(f);
  let h = `<div class="dhead"><div><h3>${esc(f.path)}</h3><span class="badge b-${k}">${esc(t('st_' + k))}</span></div>
    <label class="chk"><input type="checkbox" id="incl" ${f.include ? 'checked' : ''}>${esc(t('include'))}</label></div>`;
  if (f.status === 'binary') {
    h += `<p>${esc(t('binaryChoice'))}</p><div class="radios">
      <label class="chk"><input type="radio" name="bin" value="a" ${f.binChoice === 'a' ? 'checked' : ''}>${esc(t('useA'))}</label>
      <label class="chk"><input type="radio" name="bin" value="b" ${f.binChoice === 'b' ? 'checked' : ''}>${esc(t('useB'))}</label></div>`;
  } else if (f.status === 'conflict') {
    if (f.union) h += `<p class="info">${esc(t('autoAdded', { n: f.union }))}</p>`;
    h += `<div class="toolbar"><button class="btn" id="aiAll" ${state.busy ? 'disabled' : ''}>${esc(t('aiAll'))}</button></div>`;
    f.chunks.forEach((c, i) => { if (c.type === 'conflict') h += cardHtml(f, c, i, conflicts(f).indexOf(c) + 1); });
  } else if (f.status === 'merged') {
    h += `<p class="muted">${esc(t('autoMerged'))}${f.union ? ' ' + esc(t('autoAdded', { n: f.union })) : ''}</p><pre class="code">${esc(buildText(f).slice(0, 20000))}</pre>`;
  } else {
    h += f.preview ? `<pre class="code">${esc(f.preview)}</pre>` : `<p class="muted">${esc(t('noPreview'))}</p>`;
  }
  $('#detail').innerHTML = h;
}

function updateBar() {
  const n = openCount();
  if (!state.busy) $('#barInfo').textContent = n ? t('unresolvedInfo', { n }) : t('allResolved');
  $('#writeBtn').disabled = n > 0 || state.busy;
  $('#allBtn').disabled = state.busy;
  $('#reportBtn').disabled = state.busy;
  $('#stopBtn').hidden = !state.busy || !state.bulk;
}

/* ---------- Interaktion ---------- */
$('#detail').addEventListener('change', (e) => {
  const f = state.res.files[state.sel];
  if (e.target.id === 'incl') { f.include = e.target.checked; renderList(); updateBar(); }
  if (e.target.name === 'bin') f.binChoice = e.target.value;
});
$('#detail').addEventListener('input', (e) => {
  if (!e.target.classList.contains('res')) return;
  const f = state.res.files[state.sel], c = f.chunks[Number(e.target.closest('.cc').dataset.ci)];
  c.resolution = e.target.value; c.ai = null; updateBar(); renderList();
});
$('#detail').addEventListener('click', async (e) => {
  if (e.target.id === 'runVerify') return runVerify();
  if (e.target.id === 'retryFailed') return $('#allBtn').click();
  const fail = e.target.closest('.failrow');
  if (fail) { state.sel = Number(fail.dataset.i); state.view = 'file'; return refresh(); }
  const f = state.res.files[state.sel];
  if (e.target.id === 'aiAll') {
    state.busy = true; state.bulk = false; renderDetail(); updateBar();
    for (const [i, c] of f.chunks.entries()) if (c.type === 'conflict' && c.resolution === null) { await solveChunk(f, i); renderDetail(); }
    state.busy = false; refresh();
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const idx = Number(btn.closest('.cc').dataset.ci), c = f.chunks[idx];
  if (btn.dataset.act === 'ai') {
    state.busy = true; renderDetail(); updateBar();
    await solveChunk(f, idx);
    state.busy = false; refresh();
    return;
  }
  c.ai = null; c.err = null;
  c.resolution = btn.dataset.act === 'a' ? c.a.join('\n') : btn.dataset.act === 'b' ? c.b.join('\n') : c.a.concat(c.b).join('\n');
  refresh();
});

async function solveChunk(f, idx) {
  const c = f.chunks[idx];
  if (!S.model) { c.err = t('noModel'); return false; }
  const prev = f.chunks[idx - 1], next = f.chunks[idx + 1];
  const prevFail = c.ai && !c.ai.ok ? { code: c.ai.aiCode !== undefined ? c.ai.aiCode : c.resolution, issues: c.ai.aiIssues || c.ai.issues } : null;
  const round = c.round || 0;
  c.round = round + 1; c.busy = true; c.err = null;
  if (state.res.files[state.sel] === f) renderDetail();
  const r = await api.aiMerge({
    path: f.path, a: c.a, b: c.b, o: c.o,
    before: prev && prev.type === 'ok' ? prev.lines.slice(-25) : [],
    after: next && next.type === 'ok' ? next.lines.slice(0, 25) : [],
    notesA: $('#n-a').value.trim(), notesB: $('#n-b').value.trim(), round, prev: prevFail
  });
  c.busy = false;
  if (r.error) { c.err = r.error === 'NO_MODEL' ? t('noModel') : t('error') + r.error; return false; }
  if (prevFail && !r.ok && r.nIssues > c.ai.nIssues) return true; // schlechteres Ergebnis verwerfen
  c.resolution = r.code; c.ai = r;
  return true;
}

/* ---------- Alles zusammenfuehren + Pruefung ---------- */
function ask(title, text, ok) {
  return new Promise((res) => {
    $('#dlgTitle').textContent = title; $('#dlgText').textContent = text;
    $('#dlgOk').textContent = ok; $('#dlgCancel').textContent = t('cancel');
    const d = $('#dlg'); d.returnValue = ''; d.onclose = () => res(d.returnValue === 'ok'); d.showModal();
  });
}

$('#allBtn').onclick = async () => {
  const msg = $('#barMsg'), todo = openList().concat(failedList());
  if (!todo.length) { setMsg(msg, t('nothingToDo')); return runVerify(); }
  if (!S.model) return setMsg(msg, t('noModel'), 'err');
  const fcount = new Set(todo.map(([f]) => f.path)).size;
  if (!(await ask(t('confirmTitle'), t('confirmText', { n: todo.length, f: fcount }), t('confirmOk')))) return;
  state.busy = true; state.bulk = true; state.cancel = false; updateBar();
  let done = 0, failed = null;
  for (const [f, idx] of todo) {
    if (state.cancel) break;
    $('#barInfo').textContent = t('progress', { x: done + 1, n: todo.length });
    const ok = await solveChunk(f, idx);
    if (!ok) { failed = f.chunks[idx].err; break; }
    done++;
    renderList(); if (state.view === 'file' && state.res.files[state.sel] === f) renderDetail();
  }
  state.busy = false; state.bulk = false;
  refresh();
  if (failed) setMsg(msg, t('aborted') + failed, 'err');
  else if (state.cancel) setMsg(msg, t('stopped', { x: done, n: todo.length }));
  await runVerify();
};
$('#stopBtn').onclick = () => { state.cancel = true; };
$('#reportBtn').onclick = () => { state.view = 'report'; refresh(); if (!state.report) runVerify(); };

async function runVerify() {
  const msg = $('#barMsg');
  setMsg(msg, t('verifying'));
  const checks = [], unchecked = [], items = [];
  let manual = 0, aiCount = 0;
  for (const [i, f] of state.res.files.entries()) {
    if (!f.include || (f.status !== 'conflict' && f.status !== 'merged')) continue;
    for (const c of conflicts(f)) {
      if (c.resolution === null) continue;
      if (!c.ai) { manual++; continue; }
      aiCount++;
      const iss = await api.validateChunk({ a: c.a, b: c.b, o: c.o, code: c.resolution });
      const list = (Array.isArray(iss) ? iss : []).concat(c.ai.ok ? [] : c.ai.issues);
      checks.push({ i, path: f.path, label: t('failChunk', { n: conflicts(f).indexOf(c) + 1 }), ok: list.length === 0, msg: [...new Set(list)].join(' | ') });
    }
    if (isResolved(f)) items.push({ i, path: f.path, content: buildText(f) }); else unchecked.push(f.path);
  }
  const v = await api.verify({ a: state.paths.a, b: state.paths.b, base: state.paths.base, items: items.map(({ path, content }) => ({ path, content })) });
  if (v.error) return setMsg(msg, t('error') + v.error, 'err');
  v.results.forEach((r, k) => {
    const it = items[k];
    if (!r.checked) unchecked.push(it.path);
    else checks.push({ i: it.i, path: it.path, label: t('failFile'), ok: r.ok, msg: r.msg || '' });
    if (Array.isArray(r.missing)) checks.push({ i: it.i, path: it.path, label: t('failComplete'), ok: r.missing.length === 0, msg: r.missing.length ? t('missingSyms', { s: r.missing.join(', ') }) : '' });
  });
  const passed = checks.filter((c) => c.ok).length;
  state.report = { passed, total: checks.length, fails: checks.filter((c) => !c.ok), manual, aiCount, unchecked, heur: v.results.filter((r) => r.heuristic).length };
  state.view = 'report';
  setMsg(msg, '');
  refresh();
};

/* ---------- Ergebnis schreiben ---------- */
$('#writeBtn').onclick = async () => {
  const msg = $('#barMsg');
  if (openCount()) return setMsg(msg, t('needResolve'), 'err');
  const items = [];
  for (const f of state.res.files) {
    if (!f.include) continue;
    if (f.status === 'conflict' || f.status === 'merged') items.push({ path: f.path, kind: 'text', content: buildText(f) });
    else items.push({ path: f.path, kind: 'copy', from: f.status === 'onlyB' ? 'b' : f.status === 'binary' ? f.binChoice : 'a' });
  }
  setMsg(msg, t('writing'));
  const r = await api.write({ out: state.paths.out, a: state.paths.a, b: state.paths.b, items });
  if (r.error) return setMsg(msg, t('error') + r.error, 'err');
  const warn = r.warnings.map((w) => t('syntaxWarn', { p: w.path, m: w.msg })).join(' | ');
  setMsg(msg, t('written', { n: r.written }) + (warn ? ' ' + warn : ''), warn ? 'err' : 'good');
};

/* ---------- Einstellungen ---------- */
function fillSettings() {
  $('#s-lang').value = S.language; $('#s-host').value = S.host; $('#s-port').value = S.port; $('#s-model').value = S.model;
  $('#s-retries').value = S.retries; $('#s-timeout').value = S.timeoutSec; $('#s-review').checked = S.selfReview; $('#s-ignore').value = S.ignore; $('#s-prefer').value = S.prefer || 'a'; $('#s-fallback').checked = S.fallback !== false;
}
const readSettings = () => ({
  language: $('#s-lang').value, host: $('#s-host').value.trim(), port: $('#s-port').value, model: $('#s-model').value.trim(),
  retries: $('#s-retries').value, timeoutSec: $('#s-timeout').value, selfReview: $('#s-review').checked, fallback: $('#s-fallback').checked, prefer: $('#s-prefer').value, ignore: $('#s-ignore').value
});
async function loadModels() {
  const sm = $('#s-msg');
  S = await api.setSettings(readSettings());
  const r = await checkAI();
  if (r.error) return setMsg(sm, t('error') + r.error, 'err');
  $('#modelList').innerHTML = r.map((m) => `<option value="${esc(m)}">`).join('');
  setMsg(sm, t('connOk', { n: r.length }), 'good');
}
$('#s-load').onclick = loadModels;
$('#s-test').onclick = loadModels;
$('#s-save').onclick = async () => {
  S = await api.setSettings(readSettings());
  applyLang(); await checkAI(); setMsg($('#s-msg'), t('saved'), 'good');
};

(async function init() {
  S = await api.getSettings();
  fillSettings(); applyLang();
  await checkAI();
})();