// Fila de replays: uma thread (replay-worker.mjs) refaz uma corrida por vez, sem travar o servidor.
// Se uma corrida demorar demais, a thread é reiniciada e o pedido falha.
const { Worker } = require('worker_threads');
const path = require('path');

const LIMITE_MS = 60e3;
let worker = null, pronto = null, versao = null;
const pendentes = new Map();
let proximo = 1;

function iniciar() {
  worker = new Worker(path.join(__dirname, 'replay-worker.mjs'));
  pronto = new Promise((ok, falha) => {
    const aoPronto = m => { if (m && m.pronto) { versao = m.versao; worker.off('message', aoPronto); ok(); } };
    worker.on('message', aoPronto);
    worker.once('error', falha);
  });
  worker.on('message', m => {
    if (!m || m.pronto) return;
    const p = pendentes.get(m.id);
    if (!p) return;
    pendentes.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.ok(m.resultado); else p.falha(new Error(m.erro));
  });
  worker.on('error', e => { console.error('[replay] erro na thread:', e); reiniciar(e); });
  worker.on('exit', c => { if (c !== 0 && worker) reiniciar(new Error('thread de replay saiu')); });
}
function reiniciar(erro) {
  const w = worker; worker = null;
  for (const [, p] of pendentes) { clearTimeout(p.timer); p.falha(erro); }
  pendentes.clear();
  try { w && w.terminate(); } catch {}
  iniciar();
}

// Refaz uma corrida: { regras, semente, rle } → { frutas, distancia, passos, morreu, ms, versao }
async function refazer({ regras, semente, rle }) {
  if (!worker) iniciar();
  await pronto;
  const id = proximo++;
  return new Promise((ok, falha) => {
    const timer = setTimeout(() => { pendentes.delete(id); falha(new Error('replay demorou demais')); reiniciar(new Error('tempo esgotado')); }, LIMITE_MS);
    pendentes.set(id, { ok, falha, timer });
    worker.postMessage({ id, regras, semente, rle });
  });
}
const versaoSimulacao = async () => { if (!worker) iniciar(); await pronto; return versao; };

module.exports = { iniciar, refazer, versaoSimulacao };
