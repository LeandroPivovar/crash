// Configurações do modo infinito, salvas no navegador (localStorage) pela página /configuracoes
// e lidas pelo jogo ao carregar. "auto" = comportamento padrão do jogo.
export const CONFIG_KEY = 'crash1-config';

export const DEFAULTS = {
  enemiesPerChunk: 'auto', // 'auto' ou número exato de inimigos em cada trecho sorteado
  enemiesStart: 0,         // inimigos no bloco inicial (começo real da fase)
  fruitMin: 3,             // tamanho mínimo de um grupo de frutas
  fruitMax: 5,             // tamanho máximo
  fruitPercent: 5,         // cada fruta vale esta porcentagem do valor depositado (5% → 20 frutas empatam)
  speedStart: 0.9,         // velocidade inicial (1 = velocidade original do jogo)
  speedGain: 0.058,        // quanto a velocidade aumenta a cada 100 m de distância
  speedMax: 1.6,           // velocidade máxima
  pitsMin: 0,             // buracos por chunk: o trecho é sorteado entre os que têm de pitsMin a pitsMax
  pitsMax: 2,              // buracos (cada trecho da fase real tem 0, 1 ou 2; o chunk junta vários se preciso)
  analiseAcimaDe: 5,       // servidor: pagamento acima de N × a entrada vai para análise do operador antes de creditar
  dificuldade: null,       // posição da barra de dificuldade (0–100) que gerou estas regras; null = ajuste à mão
  fluxo: Array(10).fill(null), // fluxo de partidas: dificuldade (0–100) da 1ª à 10ª partida de cada jogador; null = regras gerais
};

// Fluxo de partidas: cada jogador passa por FLUXO_TAM partidas seguidas; a N-ª usa a dificuldade da posição N
// (depois da última, recomeça da primeira). Partida cancelada antes do START não conta.
export const FLUXO_TAM = 10;

// Barra de dificuldade: seis níveis de referência (medidos com o robô de teste; a distância média cai a cada nível:
// ~1 200 m, ~360, ~270, ~180, ~125 e ~45). A barra vai de 0 a 100 e interpola entre eles, então cada ponto é um
// pouco mais difícil que o anterior. Só mexe em inimigos, buracos e velocidade; frutas e pagamento ficam como estão.
export const DIFICULDADES = [
  { nome: 'Muito fácil',   desc: 'Sem inimigos, quase sem buracos e devagar.',
    enemiesPerChunk: 0, enemiesStart: 0, pitsMin: 0, pitsMax: 1, speedStart: 0.9,  speedGain: 0.02,  speedMax: 1.1 },
  { nome: 'Fácil',         desc: 'Poucos inimigos e buracos; acelera devagar.',
    enemiesPerChunk: 1, enemiesStart: 0, pitsMin: 0, pitsMax: 2, speedStart: 0.95, speedGain: 0.04,  speedMax: 1.35 },
  { nome: 'Normal',        desc: 'Perto do jogo original.',
    enemiesPerChunk: 2, enemiesStart: 1, pitsMin: 1, pitsMax: 2, speedStart: 1.0,  speedGain: 0.058, speedMax: 1.6 },
  { nome: 'Difícil',       desc: 'Mais inimigos e buracos, e bem mais rápido.',
    enemiesPerChunk: 3, enemiesStart: 2, pitsMin: 1, pitsMax: 3, speedStart: 1.15, speedGain: 0.08,  speedMax: 1.9 },
  { nome: 'Muito difícil', desc: 'Para quem já domina o jogo.',
    enemiesPerChunk: 5, enemiesStart: 4, pitsMin: 2, pitsMax: 5, speedStart: 1.35, speedGain: 0.12,  speedMax: 2.4 },
  { nome: 'Impossível',    desc: 'Inimigos e buracos no máximo, velocidade extrema.',
    enemiesPerChunk: 8, enemiesStart: 8, pitsMin: 4, pitsMax: 8, speedStart: 1.8,  speedGain: 0.2,   speedMax: 3.5 },
];
// regras de inimigos, buracos e velocidade para a posição v da barra (0 = mais fácil, 100 = impossível)
export function regrasDaDificuldade(v) {
  const p = Math.max(0, Math.min(100, Number(v) || 0)) / 100 * (DIFICULDADES.length - 1);
  const i = Math.min(DIFICULDADES.length - 2, Math.floor(p)), t = p - i, a = DIFICULDADES[i], b = DIFICULDADES[i + 1];
  const mix = (k, casas) => { const x = a[k] + (b[k] - a[k]) * t; const f = 10 ** casas; return Math.round(x * f) / f; };
  const r = {
    enemiesPerChunk: mix('enemiesPerChunk', 0), enemiesStart: mix('enemiesStart', 0),
    pitsMin: mix('pitsMin', 0), pitsMax: mix('pitsMax', 0),
    speedStart: mix('speedStart', 2), speedGain: mix('speedGain', 3), speedMax: mix('speedMax', 2),
  };
  if (r.pitsMax < r.pitsMin) r.pitsMax = r.pitsMin;
  return r;
}
// Regras de uma partida na posição `posicao` (0..FLUXO_TAM−1) do fluxo: as gerais, com inimigos, buracos e
// velocidade trocados pelos da dificuldade daquela posição (se ela tiver uma).
export function regrasNoFluxo(regras, posicao) {
  const r = normalize(regras), d = r.fluxo[posicao];
  return d === null ? r : normalize({ ...r, ...regrasDaDificuldade(d), dificuldade: d });
}
// nome do nível para a posição v (a faixa mais próxima)
export const nomeDaDificuldade = v => DIFICULDADES[Math.round(Math.max(0, Math.min(100, Number(v) || 0)) / 100 * (DIFICULDADES.length - 1))];

// buracos: qualquer valor até 99 (o chunk junta trechos da fase até somar o número sorteado)
export const LIMITS = { enemies: 8, enemiesStart: 8, fruit: 10, pits: 99 };

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

const clampNum = (v, lo, hi, def) => {
  const n = Math.round(Number(String(v).replace(',', '.')) * 1000) / 1000; // aceita vírgula; 3 casas
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

export function normalize(c) {
  const d = DEFAULTS, o = { ...d, ...(c || {}) };
  // configuração antiga (um número só de buracos): vira mínimo = máximo
  if (c && c.pitsPerChunk !== undefined && c.pitsMin === undefined) {
    if (c.pitsPerChunk !== 'auto') o.pitsMin = o.pitsMax = c.pitsPerChunk;
  }
  const out = {
    enemiesPerChunk: o.enemiesPerChunk === 'auto' ? 'auto' : clampInt(o.enemiesPerChunk, 0, LIMITS.enemies, d.enemiesPerChunk),
    enemiesStart: clampInt(o.enemiesStart, 0, LIMITS.enemiesStart, d.enemiesStart),
    fruitMin: clampInt(o.fruitMin, 1, LIMITS.fruit, d.fruitMin),
    fruitMax: clampInt(o.fruitMax, 1, LIMITS.fruit, d.fruitMax),
    fruitPercent: clampNum(o.fruitPercent, 0.01, 1000, d.fruitPercent),
    speedStart: clampNum(o.speedStart, 0.1, 10, d.speedStart),
    speedGain: clampNum(o.speedGain, 0, 10, d.speedGain),
    speedMax: clampNum(o.speedMax, 0.1, 10, d.speedMax),
    pitsMin: clampInt(o.pitsMin, 0, LIMITS.pits, d.pitsMin),
    pitsMax: clampInt(o.pitsMax, 0, LIMITS.pits, d.pitsMax),
    analiseAcimaDe: clampNum(o.analiseAcimaDe, 1, 1000, d.analiseAcimaDe),
    dificuldade: o.dificuldade === null || o.dificuldade === undefined || o.dificuldade === '' ? null : clampInt(o.dificuldade, 0, 100, null),
    fluxo: Array.from({ length: FLUXO_TAM }, (_, i) => {
      const v = Array.isArray(o.fluxo) ? o.fluxo[i] : null;
      return v === null || v === undefined || v === '' ? null : clampInt(v, 0, 100, null);
    }),
  };
  if (out.fruitMax < out.fruitMin) out.fruitMax = out.fruitMin;
  if (out.pitsMax < out.pitsMin) out.pitsMax = out.pitsMin;
  if (out.speedMax < out.speedStart) out.speedMax = out.speedStart;
  return out;
}

// Frutas necessárias para receber de volta o valor depositado (empatar).
export const breakEvenFruits = pct => Math.ceil(100 / pct - 1e-9);

export function loadConfig() {
  try { return normalize(JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null')); } catch { return normalize(null); }
}

export function saveConfig(c) {
  const n = normalize(c);
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(n)); } catch {}
  return n;
}
