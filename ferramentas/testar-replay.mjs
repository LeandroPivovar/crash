// Teste do replay (fase 3): um robô joga com a simulação do jogo (site/js/jogo/mundo.js) e o resultado é
// refeito a partir da gravação dos comandos, como o servidor faz. Se algum dia der "igual": false, a
// simulação deixou de ser determinística (algo fora da semente ou do passo fixo entrou na corrida).
//   node ferramentas/testar-replay.mjs [semente] [segundos] [arquivo-da-gravacao.json] [nervoso]
import path from 'path';
import { fileURLToPath } from 'url';
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.argv.splice(2, 0, raiz);
import fs from "fs";
import { pathToFileURL } from 'url';
const semente = Number(process.argv[3] || 123456), segundos = Number(process.argv[4] || 300);
const nervoso = process.argv[6] === 'nervoso';
const M = await import(pathToFileURL(raiz + '/site/js/jogo/mundo.js').href);
const C = await import(pathToFileURL(raiz + '/site/js/jogo/config.js').href);
const json = JSON.parse(fs.readFileSync(raiz + '/site/data/level.json', 'utf8'));
const b = fs.readFileSync(raiz + '/site/data/level.bin');
const nivel = M.prepararNivel(json, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const config = C.normalize(null);
const m = M.criarMundo(nivel, { config, semente });
const g = new M.Gravador();
let hold = 0, zAnt = 0, xAtual = 0;
for (let i = 0; i < 60 * segundos && !m.estado.fim; i++) {
  const p = m.player.pos;
  let jump = false;
  const v = Math.max(300, Math.hypot(m.player.vel.x, m.player.vel.z) * 0.28); // olha mais longe quanto mais rápido
  let buraco = false;
  for (let d = 150; d <= v + 150; d += 50) { const gd = m.player.guide(p.z - d); if (gd && gd.pit) buraco = true; }
  const parado = i > 30 && Math.abs(p.z - zAnt) < 1; zAnt = p.z;
  if (m.player.onGround && (buraco || parado)) { jump = true; hold = 24; }
  // mira: fruta viva mais próxima à frente (até 2 500)
  let alvo = null;
  for (const f of m.pickups) if (f.alive && f.z < p.z && p.z - f.z < 2500 && (!alvo || f.z > alvo.z)) alvo = f;
  const gd = m.player.guide(p.z);
  const xAlvo = alvo ? alvo.x : (gd ? gd.cx : p.x);
  // ajusta o desvio 6 vezes por segundo, como uma pessoa (e não a cada passo, o que pareceria robô)
  if (i % 10 === 0) xAtual = M.quantizarX((xAlvo - p.x) / 250);
  // modo "nervoso" (6º argumento): balança o desvio um oitavo para cada lado a cada passo, como um robô faria
  const x = nervoso ? M.quantizarX(xAtual + (i % 2 ? 0.125 : -0.125)) : xAtual;
  const input = { x, jump, jumpHeld: hold-- > 0, spin: false };
  const codigo = M.codificar(input);
  m.passo(M.decodificar(codigo));
  g.add(codigo);
}
const sim = { passos: m.estado.passos, frutas: m.estado.fim ? m.estado.fim.frutas : m.estado.frutas, distancia: Math.round(m.estado.fim ? m.estado.fim.distancia : m.estado.distancia), morreu: !!m.estado.fim };
const rep = M.refazerCorrida(nivel, { config, semente, rle: g.rle });
console.log(JSON.stringify({ semente, sim, replay: rep, igual: sim.frutas === rep.frutas && sim.passos === rep.passos && sim.distancia === rep.distancia, rlePares: g.rle.length }));
if (process.argv[5]) fs.writeFileSync(process.argv[5], JSON.stringify({ semente, rle: g.rle, ...sim }));
