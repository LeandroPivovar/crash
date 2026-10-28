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
};

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
