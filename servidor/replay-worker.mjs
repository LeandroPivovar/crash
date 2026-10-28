// Thread que refaz corridas (fase 3). Carrega o nível uma vez e, para cada pedido, roda a MESMA simulação do
// jogo (site/js/jogo/mundo.js) com a semente, as regras e os comandos gravados da partida.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(aqui, '..', 'site');
const M = await import(pathToFileURL(path.join(site, 'js', 'jogo', 'mundo.js')).href);
const C = await import(pathToFileURL(path.join(site, 'js', 'jogo', 'config.js')).href);

const json = JSON.parse(fs.readFileSync(path.join(site, 'data', 'level.json'), 'utf8'));
const b = fs.readFileSync(path.join(site, 'data', 'level.bin'));
// medida do chão pronta (o mesmo arquivo que o navegador usa); sem ele, calcula (dá o mesmo resultado)
let plano = null;
try { plano = JSON.parse(fs.readFileSync(path.join(site, 'data', 'plano.json'), 'utf8')); } catch { /* calcula */ }
const nivel = M.prepararNivel(json, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), plano);

parentPort.on('message', ({ id, regras, semente, rle }) => {
  try {
    const t = performance.now();
    const r = M.refazerCorrida(nivel, { config: C.normalize(regras), semente, rle });
    parentPort.postMessage({ id, ok: true, resultado: { ...r, ms: Math.round(performance.now() - t), versao: M.SIM_VERSAO } });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, erro: String(e && e.stack || e) });
  }
});
parentPort.postMessage({ pronto: true, versao: M.SIM_VERSAO });
