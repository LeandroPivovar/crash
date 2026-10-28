// Simulação da corrida (fase 3): o MESMO código roda no navegador (jogo) e no servidor (que refaz a corrida
// a partir dos comandos do jogador para confirmar as frutas). Nada aqui desenha: o que é visual entra por
// ganchos opcionais (`visual`), e sem eles a simulação roda "sem tela" (Node).
//
// Para dar o mesmo resultado nos dois lados:
//  - passo fixo de 1/60 s (SIM_DT), sempre;
//  - tudo que é sorteado vem da semente da partida;
//  - o desvio para os lados é arredondado para oitavos (quantizarX) antes de entrar na simulação.
import * as THREE from 'three';
import { Collision } from './collision.js';
import { Player } from './player.js';
import { Enemy } from './enemies.js';
import { LevelChain } from './levelchain.js';

export const SIM_DT = 1 / 60;
export const SIM_VERSAO = 6; // muda quando a simulação muda (6: pulo com margem e antecipado; 5: mapa plano; 4: sem giro; 3: desvio livre; 2: faixas)

// Fim da trilha real usada nos trechos (chão plano antes do primeiro degrau da escada, que começa em z 101 200)
export const LEVEL_END_Z = 101300;
// O primeiro trecho (começo real da fase) tem só 2 buracos (122 600 e 115 900); termina em 113 000, no mesmo
// corte dos trechos-modelo, e dali em diante vêm os trechos sorteados.
export const LOOP_END_Z = 113000;
// Dificuldade: cresce com a distância desde o início (0 → 1 em 120 000 unidades); conta inimigos extras.
const RAMP_DISTANCE = 120000;
// Frutas soltas na trilha: altura acima do chão e alcance a partir dos pés.
export const FRUIT_LIFT = 260;
const FRUIT_REACH = 230, FRUIT_REACH_UP = 750;
const GUIDE_MARGIN = 150;   // folga do corredor até a borda medida da trilha
const SAFE_START = 1500;    // nenhum trecho pode ter buraco nos primeiros 1 500

// ---------- comandos do jogador ----------
// Um número por passo: x em oitavos (−8..8 → 0..16, 5 bits) + pulo (bit 5) + pulo segurado (bit 6).
// O bit 7 era o giro, que saiu do jogo: a simulação ignora e o servidor recusa.
export const quantizarX = x => Math.round(Math.max(-1, Math.min(1, x)) * 8) / 8;
export const codificar = ({ x = 0, jump = false, jumpHeld = false, spin = false }) =>
  (Math.round(quantizarX(x) * 8) + 8) | (jump ? 32 : 0) | (jumpHeld ? 64 : 0) | (spin ? 128 : 0);
export const decodificar = c => ({ x: ((c & 31) - 8) / 8, jump: !!(c & 32), jumpHeld: !!(c & 64), spin: !!(c & 128) });
// Gravação compacta: [[código, repetições], ...]
export class Gravador {
  constructor() { this.rle = []; this.passos = 0; }
  add(codigo) {
    const u = this.rle[this.rle.length - 1];
    if (u && u[0] === codigo) u[1]++; else this.rle.push([codigo, 1]);
    this.passos++;
  }
  // pedaço novo desde `desde` (índice no rle; o último par pode ter crescido, então ele vai de novo)
  pedaco(desde) { return this.rle.slice(desde); }
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- parte fixa do nível (pode ser reaproveitada entre partidas) ----------
// Trilha medida na colisão, trechos-modelo e guia. Não muda durante a corrida.
// plano (opcional): a medida da trilha e do chão já feita (data/plano.json, gerado por ferramentas/gerar-plano.mjs).
// É o mesmo resultado do cálculo, só que pronto: o navegador e o servidor abrem mais rápido. Sem ele, calcula.
export function prepararNivel(json, bin, plano = null) {
  const collision = new Collision(json.collision, bin);
  const crash = json.entities.find(e => e.gool === 'Will');

  // Mede a trilha real ao longo de z: centro (x) e altura do chão, varrendo a largura livre entre as paredes.
  const trail = new Map();
  const groundTop = (x, z, yGuess) => {
    let top = -1e9;
    collision.cellsInBox(x - 6, yGuess - 1500, z - 6, x + 6, yGuess + 1500, z + 6, (v, a, b, c, d, e) => {
      const t = (v & 0xe) >> 1;
      if ((t === 1 || t === 2) && e > top && e < yGuess + 600) top = e;
    });
    return top;
  };
  if (plano) for (const [z, cx, y, w] of plano.trilha) trail.set(z, { cx, y, w });
  else {
    const wall = (x, y, z) => { let w = false; collision.cellsInBox(x - 4, y + 250, z - 4, x + 4, y + 500, z + 4, () => { w = true; }); return w; };
    let cx = crash.path[0][0], y = crash.path[0][1];
    // vai 2 500 além do fim usado (escada final): os triângulos que cruzam o corte do último trecho também são achatados
    for (let z = Math.floor(crash.path[0][2] / 250) * 250; z >= LEVEL_END_Z - 2500; z -= 250) {
      const g = groundTop(cx, z, y + 300);
      if (g > -1e8) y = g;
      let L = 0, R = 0;
      while (L < 4000 && !wall(cx - L - 25, y, z) && groundTop(cx - L - 25, z, y + 250) > y - 400) L += 25;
      while (R < 4000 && !wall(cx + R + 25, y, z) && groundTop(cx + R + 25, z, y + 250) > y - 400) R += 25;
      if (L + R > 0) cx = Math.round(cx + (R - L) / 2);
      trail.set(z, { cx, y, w: L + R });
    }
  }
  const trailAt = z => trail.get(Math.round(z / 250) * 250);

  // ---------- mapa plano ----------
  // Altura do chão da trilha original numa grade: a cada 25 ao longo de z e a cada 100 para os lados (até 1 500
  // do centro). Tudo o que tem altura (colisão, cenário, inimigos, frutas, câmera) é "achatado" subtraindo
  // alturaChao(x, z): o chão da trilha fica em y = 0 do começo ao fim, de um lado ao outro. Os trechos
  // sorteados são pedaços da mesma trilha, então a mesma função vale para eles (no x/z local do trecho).
  //  - buracos: não têm chão; a altura vem das bordas (interpolada), e o buraco continua buraco;
  //  - paredes e rochas altas na beira: não são chão; vale a altura da trilha ao lado;
  //  - obstáculos no caminho (pilastras deitadas, a fileira de blocos de pedra): o que fica mais de 150 acima do
  //    chão de antes E do de depois (parte mais baixa de 1 000 de cada lado, ao longo de z) sai da medida, então
  //    continua obstáculo sobre o chão plano. Dunas, degraus e escadas são medidos e somem.
  const PERFIL_PASSO = 25, LARG = 1500, COL_PASSO = 100, NCOL = 2 * LARG / COL_PASSO + 1, MEDIANA = 40, OBSTACULO = 150;
  const perfilZ0 = Math.floor(crash.path[0][2] / 250) * 250, perfilZ1 = LEVEL_END_Z - 2500;
  const medirChao = () => {
  const linhas = []; // { cx, alt: [NCOL] }
  for (let z = perfilZ0; z >= perfilZ1; z -= PERFIL_PASSO) {
    // amostras da trilha logo atrás (A, z maior) e logo à frente (B) deste ponto
    const za = Math.floor(z / 250) * 250, A0 = trail.get(za + 250), B0 = trail.get(za);
    const A = A0 || B0, B = B0 || A0;
    const p = (za + 250 - z) / 250; // 0 em A, 1 em B
    const cx = A && B ? A.cx + (B.cx - A.cx) * p : crash.path[0][0];
    const alt = new Array(NCOL).fill(null);
    if (A && B && A.w > 0 && B.w > 0) {
      // referência: a trilha mais baixa num raio de 1 000 (numa fileira de blocos, a trilha medida fica no topo
      // deles, e a areia ao lado não pode parecer "fundo de buraco")
      let yMin = Math.min(A.y, B.y);
      for (let k = -4; k <= 4; k++) { const q = trail.get(za + k * 250); if (q && q.w > 0) yMin = Math.min(yMin, q.y); }
      const lo = yMin - 700, hi = Math.max(A.y, B.y) + 300;
      for (let j = 0; j < NCOL; j++) {
        const g = groundTop(cx - LARG + j * COL_PASSO, z, hi);
        if (g > lo && g < hi) alt[j] = g; // fundo de buraco ou topo de parede/rocha alta: não é chão
      }
    }
    linhas.push({ cx, alt });
  }
  const N = linhas.length;
  // obstáculos fora da medida: mediana ao longo de z, coluna por coluna (só amostras válidas)
  const filtrada = linhas.map(l => ({ cx: l.cx, alt: l.alt.slice() }));
  for (let j = 0; j < NCOL; j++) {
    for (let i = 0; i < N; i++) {
      if (linhas[i].alt[j] === null) continue;
      // chão antes e depois deste ponto (até 1 000 de cada lado): a parte mais baixa (quartil de 25%), porque
      // obstáculo fica EM CIMA do chão
      const mediana = (k0, k1) => {
        const vals = [];
        for (let k = Math.max(0, k0); k <= Math.min(N - 1, k1); k++) if (linhas[k].alt[j] !== null) vals.push(linhas[k].alt[j]);
        if (!vals.length) return null;
        vals.sort((u, v) => u - v);
        return vals[vals.length >> 2];
      };
      const antes = mediana(i - MEDIANA, i - 1), depois = mediana(i + 1, i + MEDIANA);
      // bem acima do chão dos DOIS lados (pilastra, tronco): não é chão. Degrau de escada fica acima só do
      // chão de antes (o de depois continua alto), então é medido e some como o resto.
      const ref = Math.max(antes ?? -Infinity, depois ?? -Infinity);
      if (antes !== null && depois !== null && linhas[i].alt[j] - ref > OBSTACULO) filtrada[i].alt[j] = null;
    }
  }
  // linha em que a maior parte do chão medido era obstáculo (fileira de blocos de lado a lado): a linha inteira
  // vira obstáculo, e o chão vem das bordas (antes e depois), como num buraco
  for (let i = 0; i < N; i++) {
    let medidas = 0, tiradas = 0;
    for (let j = 0; j < NCOL; j++) if (linhas[i].alt[j] !== null) { medidas++; if (filtrada[i].alt[j] === null) tiradas++; }
    if (medidas && tiradas * 2 >= medidas) filtrada[i].alt.fill(null);
  }
  // linhas com chão: as colunas sem chão (paredes) copiam a coluna válida mais próxima
  for (const l of filtrada) {
    if (!l.alt.some(v => v !== null)) continue;
    for (let j = 0; j < NCOL; j++) {
      if (l.alt[j] !== null) continue;
      let d = 1;
      while (d < NCOL && l.alt[j - d] == null && l.alt[j + d] == null) d++;
      l.alt[j] = l.alt[j - d] ?? l.alt[j + d];
    }
  }
  // linhas sem chão nenhum (buracos): liga as bordas ao longo de z, coluna por coluna
  for (let i = 0; i < N; i++) {
    if (filtrada[i].alt[0] !== null) continue;
    let k = i; while (k < N && filtrada[k].alt[0] === null) k++;
    for (let j = 0; j < NCOL; j++) {
      const ya = i > 0 ? filtrada[i - 1].alt[j] : (k < N ? filtrada[k].alt[j] : crash.path[0][1]);
      const yb = k < N ? filtrada[k].alt[j] : ya;
      for (let q = i; q < k; q++) filtrada[q].alt[j] = ya + (yb - ya) * (q - i + 1) / (k - i + 1);
    }
    i = k - 1;
  }
  return filtrada;
  };
  const filtrada = plano ? plano.chao.map(([cx, ...alt]) => ({ cx, alt })) : medirChao();
  const N = filtrada.length;
  const alturaChao = (x, z) => {
    const f = Math.max(0, Math.min(N - 1, (perfilZ0 - z) / PERFIL_PASSO));
    const i = Math.min(N - 2, Math.floor(f)), p = f - i;
    const L0 = filtrada[i], L1 = filtrada[i + 1];
    const cx = L0.cx + (L1.cx - L0.cx) * p;
    const g = Math.max(0, Math.min(NCOL - 1, (x - cx + LARG) / COL_PASSO));
    const j = Math.min(NCOL - 2, Math.floor(g)), q = g - j;
    const h0 = L0.alt[j] + (L0.alt[j + 1] - L0.alt[j]) * q;
    const h1 = L1.alt[j] + (L1.alt[j + 1] - L1.alt[j]) * q;
    return h0 + (h1 - h0) * p;
  };
  // Colisão no espaço plano: a pergunta (y plano) vira y original somando a altura do chão; as células
  // voltam com y plano (altura do chão no centro de cada célula).
  const collisionPlana = {
    cellsInBox(x0, y0, z0, x1, y1, z1, cb) {
      let lo = Infinity, hi = -Infinity;
      for (const x of [x0, (x0 + x1) / 2, x1]) for (const z of [z0, (z0 + z1) / 2, z1]) {
        const h = alturaChao(x, z);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      collision.cellsInBox(x0, y0 + lo, z0, x1, y1 + hi, z1, (v, a, b, c, d, e, f) => {
        const h = alturaChao((a + d) / 2, (c + f) / 2);
        if (e - h < y0 || b - h > y1) return; // fora da caixa depois de achatar
        cb(v, a, b - h, c, d, e - h, f);
      });
    },
  };
  // Altura exata do chão na emenda, medida 100 para dentro do trecho (é o chão que o Crash pisa ali).
  const seamY = (cx, z, inward) => {
    const guess = trailAt(z).y;
    const g = groundTop(cx, z + inward, guess + 300);
    return g > -1e8 ? g : guess;
  };
  // pontos livres da trilha para frutas/inimigos extras: chão largo, longe de buracos e das pontas
  function freeSpots(zA, zB) {
    const spots = [];
    for (let z = zA - 500; z > zB + 500; z -= 250) {
      const s = trailAt(z);
      if (!s || s.w < 1100) continue;
      let nearPit = false;
      for (let k = -3; k <= 3; k++) { const q = trailAt(z + k * 250); if (!q || q.w === 0 || Math.abs(q.y - s.y) > 120 * Math.abs(k) + 150) nearPit = true; }
      if (!nearPit) spots.push({ x: s.cx, y: s.y, z, w: s.w });
    }
    return spots;
  }
  function countPits(zA, zB) {
    let pits = 0, inPit = false;
    for (let z = zA; z > zB; z -= 250) {
      const q = trailAt(z), pit = !q || q.w === 0;
      if (pit && !inPit) pits++;
      inPit = pit;
    }
    return pits;
  }

  // Trechos-modelo, cortados em pontos estreitos para as emendas casarem. Buracos da trilha real (z):
  // 122 600–122 100, 115 900–115 200, 108 300–107 600 e 106 300–105 200.
  const TEMPLATE_CUTS = [
    { name: 'descida', zA: 124500, zB: 119000 },
    { name: 'baixada', zA: 119000, zB: 113000 },
    { name: 'subida', zA: 113000, zB: 105000 },
    { name: 'ruinas', zA: 105000, zB: LEVEL_END_Z },
  ];
  const templates = TEMPLATE_CUTS.map(cut => {
    const a = trailAt(cut.zA), b = trailAt(cut.zB);
    const inside = e => e.path[0][2] <= cut.zA && e.path[0][2] > cut.zB && Math.abs(e.path[0][0] - a.cx) < 4500;
    let safeStart = true, prevY = a.y;
    for (let z = cut.zA; z >= cut.zA - SAFE_START; z -= 250) {
      const q = trailAt(z);
      if (!q || q.w === 0 || Math.abs(q.y - prevY) > 300) safeStart = false;
      if (q) prevY = q.y;
    }
    // tudo o que vai para os trechos já sai no espaço plano (o chão da trilha em y = 0)
    const plano = (y, x, z) => y - alturaChao(x, z);
    return {
      ...cut, cxA: a.cx, yA: plano(seamY(a.cx, cut.zA, -100), a.cx, cut.zA - 100), cxB: b.cx, yB: plano(seamY(b.cx, cut.zB, 100), b.cx, cut.zB + 100),
      spots: freeSpots(cut.zA, cut.zB).map(s => ({ ...s, y: 0 })), pits: countPits(cut.zA, cut.zB), safeStart,
      groundAt: z => { const q = trailAt(z); return q && q.w > 0 ? { ...q, y: 0 } : null; },
      geoms: [], // o navegador põe aqui as geometrias do cenário de cada trecho
      boxes: json.entities.filter(e => e.gool === 'Boxs' && inside(e)).map(e => ({ sub: e.sub, x: e.path[0][0], y: plano(e.path[0][1], e.path[0][0], e.path[0][2]), z: e.path[0][2] })),
      enemies: json.entities.filter(e => (e.gool === 'Crab' || e.gool === 'Turt') && inside(e)).map(e => ({ gool: e.gool, path: e.path.map(p => [p[0], plano(p[1], p[0], p[2]), p[2]]), id: e.id })),
      decor: json.entities.filter(e => e.gool === 'JunO' && inside(e)).map(e => ({ key: e.model, x: e.path[0][0], y: plano(e.path[0][1], e.path[0][0], e.path[0][2]), z: e.path[0][2], rot: -e.rot / 4096 * Math.PI * 2 })),
    };
  });

  // Guia: centro e meia-largura da trilha (o Crash fica nesse corredor, sem colidir com paredes e teto).
  const sampleW = z => {
    // nos buracos (largura 0) vale a dos vizinhos; nas outras amostras, o menor valor com os vizinhos
    const ws = [-1, 0, 1].map(k => trailAt(z + k * 250)).filter(Boolean).map(q => q.w).filter(w => w > 0);
    return ws.length ? Math.min(...ws) : 800;
  };
  const guideLocal = z => {
    const z0 = Math.floor(z / 250) * 250, z1 = z0 + 250;
    const a = trailAt(z0), b = trailAt(z1);
    if (!a && !b) return null;
    const p = a && b ? (z - z0) / 250 : 0, A = a || b, B = b || a;
    const w = sampleW(z0) * (1 - p) + sampleW(z1) * p;
    const pit = (a && a.w === 0) || (b && b.w === 0); // buraco: morrer na hora ao cair
    return { cx: A.cx + (B.cx - A.cx) * p, half: Math.max(200, w / 2 - GUIDE_MARGIN), pit };
  };

  // a medida pronta, para salvar em data/plano.json
  const planoPronto = { versao: 1, trilha: [...trail].map(([z, q]) => [z, q.cx, q.y, q.w]), chao: filtrada.map(l => [l.cx, ...l.alt]) };
  return { plano: planoPronto, json, bin, collision, collisionPlana, alturaChao, crash, trailAt, groundTop, seamY, freeSpots, templates, guideLocal, TEMPLATE_CUTS };
}

// ---------- uma corrida ----------
// visual (opcional, só no navegador):
//   jogadorMesh(key) → Mesh;  som(nome);  cena (Scene) e materiais [4] para os trechos; decoracao(key) → Mesh
//   inimigoMesh(kind, entidadeOuNull) → Mesh;  removerMesh(mesh)
//   fruta(f) → objeto visual da fruta;  removerFruta(f);  coletou(f)
//   morreu();  matou()
export function criarMundo(nivel, { config, semente, visual = {} }) {
  const { json, crash, templates, guideLocal, alturaChao } = nivel;
  const collision = nivel.collisionPlana; // mapa plano: a simulação inteira vive no espaço achatado
  const plano = (y, x, z) => y - alturaChao(x, z);
  const SCALE = 1 / 256;

  // malhas "de mentira" para rodar sem tela
  const objetoVazio = () => { const o = new THREE.Object3D(); o.geometry = { setAttribute() {} }; return o; };
  const animFrames = visual.animFrames || (key => json.anims[key]);
  const animatedGeometry = visual.animatedGeometry || (() => ({ setAttribute() {} }));
  const jogadorMesh = visual.jogadorMesh || (key => {
    const o = objetoVazio();
    o.userData.frames = json.anims[key].length;
    o.userData.setFrame = () => {};
    return o;
  });
  const cena = visual.cena || { add() {}, remove() {} };

  const estado = { frutas: 0, distancia: 0, passos: 0, fim: null };
  const enemies = [];
  const pickups = [];
  const boxes = []; // sem caixas no modo infinito

  const player = new Player({
    collision, boxes, enemies, makeMesh: jogadorMesh, scale: SCALE,
    anims: { idle: 'WiS1V', run: 'WiWaV', jump: 'WiJuV', spin: 'WiBlV', fall: 'WiJSV', k1: 'WiK1V', k2: 'WiK2V', k3: 'WiK3V', k4: 'WiK4V' },
    spawn: [crash.path[0][0], plano(crash.path[0][1], crash.path[0][0], crash.path[0][2]), crash.path[0][2]],
  });
  player.onSound = visual.som;
  player.onKill = () => visual.matou?.();
  player.onDie = () => {
    if (!estado.fim) estado.fim = { passo: estado.passos, frutas: estado.frutas, distancia: Math.round(estado.distancia) };
    visual.morreu?.();
  };

  const novoInimigo = (entity, mesh) => {
    const e = new Enemy({ entity, mesh, scale: SCALE, animatedGeometry, animFrames, onKill: () => player.onKill?.() });
    enemies.push(e);
    return e;
  };
  // inimigos da fase original: só os do bloco inicial que a configuração pede (os demais somem)
  for (const ent of json.entities) {
    if (ent.gool !== 'Crab' && ent.gool !== 'Turt') continue;
    const plana = { ...ent, path: ent.path.map(p => [p[0], plano(p[1], p[0], p[2]), p[2]]) };
    novoInimigo(plana, visual.inimigoMesh ? visual.inimigoMesh(ent.gool, plana) : objetoVazio());
  }
  const keepReal = new Set(enemies.filter(e => e.pts[0].z > LOOP_END_Z).slice(0, config.enemiesStart));
  for (const e of enemies) if (!keepReal.has(e)) e.die();

  const speedMul = () => Math.min(config.speedMax, config.speedStart + config.speedGain * estado.distancia / 10000);
  const endReal = nivel.trailAt(LOOP_END_Z);
  const track = new LevelChain({
    scene: cena, scale: SCALE, collision, templates,
    materials: visual.materiais || [],
    start: { x: endReal.cx, y: 0, z: LOOP_END_Z },
    plano: true, // trechos sem deslocamento vertical: o chão de todos fica em y = 0
    noBoxes: true,
    config,
    seed: semente,
    addBox() { return null; },
    removeBox() {},
    addEnemy(kind, path, id) {
      return novoInimigo({ gool: kind, path, id }, visual.inimigoMesh ? visual.inimigoMesh(kind, null) : objetoVazio());
    },
    removeEnemy(e) {
      const i = enemies.indexOf(e);
      if (i >= 0) enemies.splice(i, 1);
      visual.removerMesh?.(e.mesh);
    },
    addFruitGroup(pts) {
      return pts.map((p, k) => {
        const f = { x: p.x, y: p.y + FRUIT_LIFT, z: p.z, phase: k * 3, alive: true };
        f.visual = visual.fruta?.(f);
        pickups.push(f);
        return f;
      });
    },
    removeFruitGroup(list) {
      for (const f of list) {
        const i = pickups.indexOf(f);
        if (i >= 0) pickups.splice(i, 1);
        visual.removerFruta?.(f);
      }
    },
    makeDecoration: visual.decoracao || (() => null),
  });

  // Bloco inicial: completa os inimigos pedidos com caranguejos atravessando a trilha, em pontos livres
  // (longe de buracos), a partir de 2 500 do ponto de partida e espaçados. Sorteio pela semente.
  {
    const rand = mulberry32((semente ^ 0x5bd1e995) >>> 0);
    const startZ = crash.path[0][2];
    const placed = [...keepReal].map(e => e.pts[0].z);
    const free = nivel.freeSpots(startZ - 2500, LOOP_END_Z);
    let k = 0;
    while (placed.length < config.enemiesStart && free.length) {
      const sp = free.splice(Math.floor(rand() * free.length), 1)[0];
      if (placed.some(z => Math.abs(z - sp.z) < 1500)) continue;
      const half = Math.max(300, sp.w / 2 - 250), path = [];
      for (let q = 0; q <= 8; q++) path.push([sp.x - half + q * (2 * half) / 8, 0, sp.z]);
      track.addEnemy('Crab', path, 9000 + k++);
      placed.push(sp.z);
    }
  }

  // guia e colisão do mundo: octree real antes do ponto de troca, pista gerada depois
  player.guide = z => {
    if (z >= LOOP_END_Z) return guideLocal(z);
    const piece = track.pieceAt(z);
    if (!piece) return null;
    const g = guideLocal(z - piece.off.z);
    return g && { cx: g.cx + piece.off.x, half: g.half, pit: g.pit };
  };
  player.collision = {
    cellsInBox(x0, y0, z0, x1, y1, z1, cb) {
      if (z1 > LOOP_END_Z) collision.cellsInBox(x0, y0, Math.max(z0, LOOP_END_Z), x1, y1, z1, (v, a, b, c, d, e, f) => {
        if ((c + f) / 2 >= LOOP_END_Z) cb(v, a, b, c, d, e, f);
      });
      if (z0 < LOOP_END_Z) track.cellsInBox(x0, y0, z0, x1, y1, Math.min(z1, LOOP_END_Z), cb);
    },
  };

  let lastZ = crash.path[0][2], lastPiece = null;
  function coletar() {
    if (player.deadTimer > 0) return;
    const p = player.pos;
    for (const f of pickups) {
      if (!f.alive) continue;
      const dy = f.y - p.y;
      if (Math.hypot(f.x - p.x, f.z - p.z) < FRUIT_REACH && dy > -150 && dy < FRUIT_REACH_UP) {
        f.alive = false;
        estado.frutas++;
        visual.coletou?.(f);
      }
    }
  }
  function atualizarTrilha() {
    if (player.deadTimer > 0) { lastZ = player.respawn.z; return; }
    const dz = lastZ - player.pos.z; // distância: só o avanço para frente (−z) conta
    if (dz > 0 && dz < 2000) estado.distancia += dz;
    lastZ = player.pos.z;
    const difficulty = Math.min(1, estado.distancia / RAMP_DISTANCE);
    player.speedMul = speedMul();
    if (player.pos.z < LOOP_END_Z) {
      // renasce no começo do trecho em que está (como um checkpoint a cada trecho)
      const piece = track.pieceAt(player.pos.z);
      if (piece && piece !== lastPiece) {
        lastPiece = piece;
        player.respawn.set(piece.t.cxA + piece.off.x, piece.t.yA + piece.off.y + 20, piece.zStart - 150);
      }
    }
    track.update(player.pos.z, difficulty);
  }
  player.speedMul = speedMul();

  // Um passo de 1/60 s. input: { x, jump, jumpHeld, spin } (x já arredondado com quantizarX).
  function passo(input) {
    player.update(SIM_DT, { x: input.x, z: player.deadTimer > 0 ? 0 : -1, jump: input.jump, jumpHeld: input.jumpHeld, spin: false });
    for (const en of enemies) en.update(Math.min(SIM_DT, 0.1) * speedMul());
    coletar();
    atualizarTrilha();
    estado.passos++;
  }

  return { player, enemies, pickups, track, estado, passo, speedMul };
}

// Refaz uma corrida inteira a partir da gravação (servidor). Para na morte ou no fim da gravação.
export function refazerCorrida(nivel, { config, semente, rle }) {
  const m = criarMundo(nivel, { config, semente });
  outer: for (const [codigo, n] of rle) {
    const input = decodificar(codigo);
    for (let i = 0; i < n; i++) {
      m.passo(input); // cada passo exatamente como foi gravado (o jogo grava o que aplicou)
      if (m.estado.fim) break outer;
    }
  }
  const fim = m.estado.fim;
  return {
    frutas: fim ? fim.frutas : m.estado.frutas,
    distancia: Math.round(fim ? fim.distancia : m.estado.distancia),
    passos: m.estado.passos,
    morreu: !!fim,
  };
}
