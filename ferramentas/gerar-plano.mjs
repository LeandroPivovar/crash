// Gera site/data/plano.json: a medida da trilha e do chão (mapa plano) já pronta, para o navegador e o servidor
// não precisarem calcular ao abrir. Rode de novo se mudar a fase (level.bin) ou a regra de medida em mundo.js.
//   node ferramentas/gerar-plano.mjs
// No fim, confere que carregar o arquivo dá exatamente o mesmo resultado que calcular.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = await import(pathToFileURL(path.join(raiz, 'site/js/jogo/mundo.js')).href);
const json = JSON.parse(fs.readFileSync(path.join(raiz, 'site/data/level.json'), 'utf8'));
const b = fs.readFileSync(path.join(raiz, 'site/data/level.bin'));
const bin = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
let t = performance.now();
const calculado = M.prepararNivel(json, bin);
const tCalc = performance.now() - t;
const arq = path.join(raiz, 'site/data/plano.json');
fs.writeFileSync(arq, JSON.stringify(calculado.plano));
const plano = JSON.parse(fs.readFileSync(arq, 'utf8'));
t = performance.now();
const carregado = M.prepararNivel(json, bin, plano);
const tCarr = performance.now() - t;
// mesma altura do chão e mesma trilha em milhares de pontos
let dif = 0;
for (let z = 132000; z > 99000; z -= 37) for (let x = 5000; x < 11000; x += 113) {
  if (calculado.alturaChao(x, z) !== carregado.alturaChao(x, z)) dif++;
  const a = calculado.guideLocal(z), c = carregado.guideLocal(z);
  if (JSON.stringify(a) !== JSON.stringify(c)) dif++;
}
const tpl = JSON.stringify(calculado.templates.map(t => ({ ...t, geoms: undefined, groundAt: undefined }))) === JSON.stringify(carregado.templates.map(t => ({ ...t, geoms: undefined, groundAt: undefined })));
console.log(JSON.stringify({ arquivo: path.relative(raiz, arq), kb: Math.round(fs.statSync(arq).size / 1024), calcularMs: Math.round(tCalc), carregarMs: Math.round(tCarr), diferencas: dif, trechosIguais: tpl }));
process.exit(dif || !tpl ? 1 : 0);
