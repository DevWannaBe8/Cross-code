// Spricht ausschliesslich mit dem konfigurierten Ollama-Server (LAN/localhost). Kein Internetzugriff.
const clean = (h) => String(h).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const base = (s) => `http://${clean(s.host)}:${s.port}`;

async function models(s) {
  const r = await fetch(base(s) + '/api/tags', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return (j.models || []).map((m) => m.name);
}

async function chat(s, messages, seed = 42) {
  const r = await fetch(base(s) + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: s.model, messages, stream: false,
      // Temperatur 0 = keine Zufallsstreuung. Die Seed wird nur bei Wiederholungen geaendert.
      options: { temperature: 0, top_p: 1, seed, num_ctx: 16384 }
    }),
    signal: AbortSignal.timeout(s.timeoutSec * 1000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return (j.message && j.message.content) || '';
}

module.exports = { models, chat };