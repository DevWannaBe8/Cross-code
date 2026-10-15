const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { compareProjects } = require('./lib/compare');
const ollama = require('./lib/ollama');
const aimerge = require('./lib/aimerge');

const DEFAULT_IGNORE = ['# Ein Muster pro Zeile. * ist Platzhalter, # beginnt einen Kommentar.', 'data/sessions', 'data/chats', 'data/uploads', '*.log', '.DS_Store'].join('\n');
const DEFAULTS = { language: 'de', host: '127.0.0.1', port: 11434, model: '', retries: 3, selfReview: true, timeoutSec: 300, prefer: 'a', fallback: true, ignore: DEFAULT_IGNORE };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
const safe = (fn) => async (_e, arg) => { try { return await fn(arg); } catch (e) { return { error: e.message || String(e) }; } };

/* Syntaxpruefung: JSON, JS, CSS (eingebaut), PHP (php -l, sonst Klammerpruefung als Heuristik) */
function balanceCheck(text, ext) {
  let s = text.replace(/\/\*[\s\S]*?\*\//g, '');
  if (ext !== '.css') s = s.replace(/^\s*(\/\/|#(?!\[)).*$/gm, '');
  s = s.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
  const c = { '(': 0, '[': 0, '{': 0 }, close = { ')': '(', ']': '[', '}': '{' };
  for (const ch of s) { if (ch in c) c[ch]++; else if (ch in close) { c[close[ch]]--; if (c[close[ch]] < 0) return { checked: true, ok: false, heuristic: true, msg: 'Unbalanced brackets: unexpected ' + ch }; } }
  const bad = Object.keys(c).filter((k) => c[k] !== 0);
  return bad.length ? { checked: true, ok: false, heuristic: true, msg: 'Unbalanced brackets: ' + bad.join(' ') } : { checked: true, ok: true, heuristic: true };
}
const hasCmd = (cmd, args) => { try { return spawnSync(cmd, args, { timeout: 5000 }).status === 0; } catch { return false; } };
let phpOk = null;
function lint(rel, text) {
  const ext = path.extname(rel).toLowerCase();
  try {
    if (ext === '.json') { JSON.parse(text); return { checked: true, ok: true }; }
    if (ext === '.css') return balanceCheck(text, ext);
    if (ext === '.js' || ext === '.cjs') {
      if (/^\s*(import|export)\s/m.test(text)) return balanceCheck(text, ext);
      new vm.Script(text, { filename: rel }); return { checked: true, ok: true };
    }
    if (ext === '.php') {
      if (phpOk === null) phpOk = hasCmd('php', ['-v']);
      if (!phpOk) return balanceCheck(text, ext);
      const tmp = path.join(os.tmpdir(), 'mergeassist_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.php');
      fs.writeFileSync(tmp, text);
      const r = spawnSync('php', ['-l', tmp], { encoding: 'utf8', timeout: 15000 });
      fs.unlinkSync(tmp);
      if (r.status === 0) return { checked: true, ok: true };
      return { checked: true, ok: false, msg: ((r.stdout || '') + (r.stderr || '')).split(tmp).join(rel).trim().split('\n')[0] };
    }
  } catch (e) { return { checked: true, ok: false, msg: e.message }; }
  return { checked: false };
}

ipcMain.handle('settings:get', safe(() => loadSettings()));
ipcMain.handle('settings:set', safe((s) => {
  const merged = { ...loadSettings(), ...s, port: Number(s.port) || 11434, retries: Math.max(0, Number(s.retries) || 0), timeoutSec: Math.max(10, Number(s.timeoutSec) || 300) };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(merged, null, 2));
  return merged;
}));
ipcMain.handle('dialog:folder', safe(async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}));
ipcMain.handle('compare', safe((p) => compareProjects(p.a, p.b, p.base, loadSettings().ignore)));
ipcMain.handle('ollama:models', safe((s) => ollama.models({ ...loadSettings(), ...(s || {}) })));
ipcMain.handle('ollama:merge', safe((p) => aimerge.resolve(loadSettings(), p)));
ipcMain.handle('validate:chunk', safe((p) => aimerge.validate(p, p.code)));
/* Vollstaendigkeit: Funktionen, Klassen, Animationen und CSS-Variablen aus A und B muessen im Ergebnis stehen */
function symbols(text, ext) {
  const out = new Set();
  const add = (re, pre = '') => { let m; while ((m = re.exec(text))) out.add(pre + m[1]); };
  if (ext === '.css') {
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');
    add(/@keyframes\s+([\w-]+)/g, '@keyframes '); add(/(--[\w-]+)\s*:/g);
    return out;
  }
  if (['.js', '.cjs', '.mjs', '.php'].includes(ext)) {
    add(/\bfunction\s+&?([A-Za-z_$][\w$]*)\s*\(/g, 'function ');
    add(/\bclass\s+([A-Za-z_$][\w$]*)/g, 'class ');
    add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g, 'fn ');
    if (ext === '.php') add(/\bdefine\(\s*['"]([A-Za-z_]\w*)['"]/g, 'define ');
    return out;
  }
  return null;
}
function missingSymbols(p, it) {
  const ext = path.extname(it.path).toLowerCase();
  const rd = (root) => { try { return root ? fs.readFileSync(path.join(root, it.path), 'utf8') : null; } catch { return null; } };
  const m = symbols(it.content, ext);
  if (!m) return null;
  const A = rd(p.a), B = rd(p.b), O = rd(p.base);
  const sa = A ? symbols(A, ext) : new Set(), sb = B ? symbols(B, ext) : new Set(), so = O ? symbols(O, ext) : null;
  const miss = [];
  for (const s of new Set([...sa, ...sb])) {
    if (m.has(s)) continue;
    if (so && so.has(s) && !(sa.has(s) && sb.has(s))) continue; // wurde absichtlich geloescht
    miss.push(s);
  }
  return miss.slice(0, 20);
}
ipcMain.handle('verify:run', safe((p) => ({ results: p.items.map((it) => ({ ...lint(it.path, it.content), missing: missingSymbols(p, it) })) })));
ipcMain.handle('result:write', safe((p) => {
  const warnings = []; let written = 0;
  for (const it of p.items) {
    const dest = path.join(p.out, it.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (it.kind === 'text') {
      fs.writeFileSync(dest, it.content, 'utf8');
      const l = lint(it.path, it.content);
      if (l.checked && !l.ok) warnings.push({ path: it.path, msg: l.msg });
    } else {
      fs.copyFileSync(path.join(it.from === 'a' ? p.a : p.b, it.path), dest);
    }
    written++;
  }
  return { written, warnings };
}));

app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1000, minHeight: 640, backgroundColor: '#eef1f4',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  w.setMenuBarVisibility(false);
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});
app.on('window-all-closed', () => app.quit());