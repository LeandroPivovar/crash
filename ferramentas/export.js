// Exporta o cenário (entries WGEO) de uma fase para o visualizador web.
// Uso: node export.js <SCUS_949.00> <arquivo.NSF> <pasta de saída>
//
// Formatos (confirmados contra a função de desenho do jogo em 0x80035438, ver c1c/srczz/zz_35438.h):
//   WGEO item0: x,y,z (deslocamento no mundo), nº polígonos, nº vértices, nº structs,
//               nº tpages, ?, 8 EIDs de chunks de textura, depois as structs (palavras de 32 bits).
//   item1: polígonos de 8 bytes; item2: vértices de 8 bytes.
const fs = require('fs'), path = require('path');
const nsf = require('./nsf.js');

const [exePath, nsfPath, outDir] = process.argv.slice(2);
const exe = fs.readFileSync(exePath);
const UVTAB = 0x80051774 - 0x80010000 + 0x800; // tabela global de UVs (8 bytes por índice)

const chunks = nsf.load(nsfPath);
const texChunks = new Map(); // eid -> índice na textura empilhada
const texData = [];
for (const c of chunks) if (c.type === 1 && !texChunks.has(c.id)) { texChunks.set(c.id, texData.length); texData.push(c.data); }

const seen = new Set(), wgeo = [];
for (const c of chunks) for (const e of c.entries) if (e.type === 3 && !seen.has(e.eid)) { seen.add(e.eid); wgeo.push(e); }

// Duas passadas: opaca e semitransparente. Cada vértice: pos(3 f32), cor(3 u8 + pad), info(8 i16).
// O céu (entries 's*') é desenhado em volta da câmera, então fica numa passada própria.
const passes = { opaque: [], trans: [], sky: [] };
const bounds = [];
const stats = { polys: 0, untextured: 0, animated: 0, missingTex: 0 };

for (const e of wgeo) {
  const h = e.items[0], P = e.items[1], V = e.items[2];
  const ox = h.readInt32LE(0), oy = h.readInt32LE(4), oz = h.readInt32LE(8);
  const pc = h.readInt32LE(12), vc = h.readInt32LE(16);
  const tpages = [];
  for (let k = 0; k < 8; k++) tpages.push(texChunks.get(h.readUInt32LE(32 + 4 * k)));
  const S = k => h.readUInt32LE(64 + 4 * k);

  const vert = i => {
    const w0 = V.readUInt32LE(8 * i), x = V.readInt16LE(8 * i + 4), y = V.readInt16LE(8 * i + 6);
    const z = ((w0 >>> 24) | (((x >> 1) & 3) << 8) | ((y & 7) << 10)) << 19 >> 19;
    return { p: [ox + (x & ~7), oy + (y & ~7), oz + z * 8], c: [w0 & 0xff, (w0 >> 8) & 0xff, (w0 >> 16) & 0xff] };
  };

  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vc; i++) { const q = vert(i).p; for (let c = 0; c < 3; c++) { bb[c] = Math.min(bb[c], q[c]); bb[c + 3] = Math.max(bb[c + 3], q[c]); } }
  bounds.push(bb);

  for (let i = 0; i < pc; i++) {
    const a = P.readUInt32LE(8 * i), b = P.readUInt32LE(8 * i + 4);
    const vi = [b >>> 20, (b >>> 8) & 0xfff, a >>> 20];
    const si = (a >>> 8) & 0xfff;
    const top = S(si) >>> 24;
    const vs = vi.map(vert);
    stats.polys++;
    let info = [[0, 0], [0, 0], [0, 0]], flat = [-1, 0, 0, 0, 0, -1], pass = 'opaque';
    if (top & 0x80) {
      let k = 0;
      if (b & 0x1e) { k = (a & 0x1f) & ((b & 0x1e) | 1); stats.animated++; } // textura animada: quadro 0
      const w1 = S(si + k + 1);
      const chunk = tpages[(a >>> 5) & 7];
      if (chunk === undefined) { stats.missingTex++; }
      else {
        const cm = (w1 >>> 20) & 3, seg = (w1 >>> 18) & 3;
        const uoff = (((w1 >>> 13) & 0x1f) * 8) >> cm, voff = (w1 & 0x1f) * 4;
        const t = exe.readUInt32LE(UVTAB + 8 * (w1 >>> 22)), t2 = exe.readUInt16LE(UVTAB + 8 * (w1 >>> 22) + 4);
        const uv = [t & 0xffff, t >>> 16, t2];
        info = uv.map(q => [(q & 0xff) + uoff, (q >> 8) + voff]);
        const mode = (top & 0x60) === 0x60 ? -1 : (top & 0x60) >> 5;
        flat = [chunk, seg, cm, (top & 0xf) * 16, (w1 >>> 6) & 0x7f, mode];
        if (mode >= 0) pass = 'trans';
      }
    } else stats.untextured++;
    if (e.name.startsWith('s')) pass = 'sky';
    for (let k = 0; k < 3; k++) passes[pass].push({ p: vs[k].p, c: vs[k].c, uv: info[k], f: flat });
  }
}

// Entidades (caixas, inimigos, Crash) ficam nas zonas (entries tipo 7, ZDAT).
//   item0: cabeçalho da zona; em 0x204 nº de itens de cabeçalho, 0x208 nº de caminhos de câmera, 0x20C nº de entidades.
//   item1: x, y, z, largura, altura, profundidade da zona.
//   entidade: +4 flags, +6 proctype, +8 id, +10 nº de pontos, +12 rotação, +18 tipo GOOL, +19 subtipo, +20 pontos (3 × s16).
//   Posição no mundo = origem da zona + ponto × 4.
const gool = new Map(); // tipo GOOL -> { name, category }
for (const c of chunks) for (const e of c.entries) if (e.type === 11 && e.items[0].length >= 8) {
  const t = e.items[0].readUInt32LE(0);
  if (!gool.has(t) || !e.name.startsWith('Wil9')) gool.set(t, { name: e.name.slice(0, 4), category: e.items[0].readUInt32LE(4) >> 8 });
}
// Colisão: item1 da zona é uma octree. Cabeçalho: x, y, z, largura, altura, profundidade (int32),
// 0x1C nó raiz (u16), 0x1E..0x22 profundidade máxima em x, y, z. Nó = offset (u16, par) para os filhos;
// folha = 0 (vazio) ou valor ímpar (sólido; o valor diz o tipo). O item vai cru para o visualizador.
const collisionZones = [], camPaths = [];
const entities = [], seenZone = new Set(), seenEntity = new Set();
for (const c of chunks) for (const z of c.entries) {
  if (z.type !== 7 || seenZone.has(z.eid)) continue;
  seenZone.add(z.eid);
  const h = z.items[0], zi = z.items[1];
  const zx = zi.readInt32LE(0), zy = zi.readInt32LE(4), zz = zi.readInt32LE(8);
  const hc = h.readUInt32LE(0x204), sc = h.readUInt32LE(0x208), ec = h.readUInt32LE(0x20c);
  collisionZones.push({ name: z.name, item: zi });
  // Caminhos de câmera (itens hc .. hc+sc-1): cabeçalho de 50 bytes, pontos de 12 bytes (x, y, z, rotação x, y, z como s16).
  for (let k = 0; k < sc; k++) {
    const p = z.items[hc + k], len = p.readUInt16LE(30), pts = [];
    for (let i = 0; i < len; i++) pts.push([0, 1, 2, 3, 4, 5].map(q => p.readInt16LE(50 + 12 * i + 2 * q)));
    const links = [];
    for (let d = 0; d < Math.min(4, p.readUInt32LE(8)); d++) links.push([p[12 + 4 * d], p[13 + 4 * d], p[14 + 4 * d], p[15 + 4 * d]]);
    camPaths.push({ zone: z.name, index: k, origin: [zi.readInt32LE(0), zi.readInt32LE(4), zi.readInt32LE(8)],
      neighbors: [...Array(h.readUInt32LE(0x210)).keys()].map(q => nsf.eidName(h.readUInt32LE(0x214 + 4 * q))),
      links, entrance: p[28], exit: p[29], mode: p.readInt16LE(32), avg: p.readInt16LE(34), zoom: p.readInt16LE(36),
      dir: [44, 46, 48].map(o => p.readInt16LE(o)), pts });
  }
  for (let k = 0; k < ec; k++) {
    const it = z.items[hc + sc + k];
    const id = it.readUInt16LE(8);
    if (seenEntity.has(id)) continue; // a mesma entidade pode aparecer em zonas vizinhas
    seenEntity.add(id);
    const n = it.readUInt16LE(10), type = it[18], sub = it[19];
    const path = [];
    for (let p = 0; p < n; p++) {
      const o = 20 + 6 * p;
      path.push([zx + it.readInt16LE(o) * 4, zy + it.readInt16LE(o + 2) * 4, zz + it.readInt16LE(o + 4) * 4]);
    }
    const g = gool.get(type) || { name: '?', category: 0 };
    entities.push({ id, zone: z.name, type, sub, gool: g.name, category: g.category, rot: it.readInt16LE(12), path });
  }
}
stats.entities = entities.length;

// Modelos (confirmado contra a função de desenho em 0x8003460C, c1c/srczz/zz_3460c.h).
//   GOOL item5: lista de animações, 8 bytes cada (u16 ?, u16 nº de quadros, u32 EID da SVTX).
//   SVTX: um item por quadro. Cabeçalho de 56 bytes: nº de vértices, EID do modelo (TGEO),
//         deslocamento x/y/z, caixa de colisão (×256), ...; depois vértices de 6 bytes (x, y, z, nx, ny, nz).
//         Posição local = (byte + deslocamento − 128) × 4.
//   TGEO item0: nº de polígonos, escala x/y/z (/4096), nº de palavras de struct, structs.
//         Struct texturizada (3 palavras): cor RGB + flags, EID do chunk de textura, palavra de textura (igual ao cenário).
//         Struct sem textura: 1 palavra (cor).
//   TGEO item1: polígonos de 8 bytes: offsets dos vértices A, B, C (em bytes) e índice da struct (palavras);
//         bit 15 do índice = sem iluminação.
const byName = new Map(), byEid = new Map();
for (const c of chunks) for (const e of c.entries) if (!byEid.has(e.eid)) { byEid.set(e.eid, e); byName.set(e.name, e); }
const goolAnims = name => {
  const g = [...byEid.values()].find(e => e.type === 11 && e.name.startsWith(name));
  if (!g || g.items.length < 6) return [];
  const it = g.items[5], out = [];
  for (let o = 0; o + 8 <= it.length; o += 8) { const v = byEid.get(it.readUInt32LE(o + 4)); if (v && v.type === 1) out.push(v.name); }
  return out;
};
const LIGHT = [0.4, 0.8, 0.45];
const models = {};
// Exporta todos os quadros de uma animação. A topologia (polígonos, UVs) vem do TGEO e é a mesma em todos
// os quadros; só posições e iluminação mudam.
function exportModel(svtxName) {
  if (models[svtxName]) return svtxName;
  const frames = [];
  for (const f of byName.get(svtxName).items) {
    const tris = exportFrame(f);
    if (frames.length && tris.length !== frames[0].length) continue; // quadro com outro modelo: ignora
    frames.push(tris);
  }
  models[svtxName] = frames;
  return svtxName;
}
function exportFrame(f) {
  const vc = f.readInt32LE(0), tg = byEid.get(f.readUInt32LE(4));
  const off = [f.readInt32LE(8), f.readInt32LE(12), f.readInt32LE(16)];
  const h = tg.items[0], P = tg.items[1];
  const pc = h.readInt32LE(0), scale = [h.readInt32LE(4), h.readInt32LE(8), h.readInt32LE(12)];
  const W = k => h.readUInt32LE(20 + 4 * k);
  const vert = o => {
    const p = [0, 1, 2].map(c => (f[56 + o + c] + off[c] - 128) * 4 * scale[c] / 4096);
    const nrm = [3, 4, 5].map(c => f.readInt8(56 + o + c) / 127);
    return { p, nrm };
  };
  const tris = [];
  for (let i = 0; i < pc; i++) {
    const a = P.readUInt16LE(8 * i), b = P.readUInt16LE(8 * i + 2), c = P.readUInt16LE(8 * i + 4), s = P.readUInt16LE(8 * i + 6);
    const si = s & 0x7fff, unlit = !!(s & 0x8000);
    const w0 = W(si), top = w0 >>> 24;
    const base = [w0 & 0xff, (w0 >> 8) & 0xff, (w0 >> 16) & 0xff];
    const vs = [a, b, c].map(vert);
    let uv = [[0, 0], [0, 0], [0, 0]], flat = [-1, 0, 0, 0, 0, -1];
    if (top & 0x80) {
      const chunk = texChunks.get(W(si + 1)), w1 = W(si + 2);
      if (chunk !== undefined) {
        const cm = (w1 >>> 20) & 3, seg = (w1 >>> 18) & 3;
        const uoff = (((w1 >>> 13) & 0x1f) * 8) >> cm, voff = (w1 & 0x1f) * 4;
        const t = exe.readUInt32LE(UVTAB + 8 * (w1 >>> 22)), t2 = exe.readUInt16LE(UVTAB + 8 * (w1 >>> 22) + 4);
        uv = [t & 0xffff, t >>> 16, t2].map(q => [(q & 0xff) + uoff, (q >> 8) + voff]);
        flat = [chunk, seg, cm, (top & 0xf) * 16, (w1 >>> 6) & 0x7f, (top & 0x60) === 0x60 ? -1 : (top & 0x60) >> 5];
      } else stats.missingTex++;
    }
    for (let k = 0; k < 3; k++) {
      const n = vs[k].nrm, d = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
      const l = unlit ? 1 : 0.6 + 0.5 * d;
      tris.push({ p: vs[k].p, c: base.map(x => Math.min(255, Math.round(x * l))), uv: uv[k], f: flat });
    }
  }
  return tris;
}

// Qual animação mostrar: a 1ª do objeto; para caixas, o subtipo escolhe.
// Tabela tirada do código GOOL de BoxsC (node disgool.js <NSF> BoxsC <subtipo>): cada subtipo leva a um
// estado que executa ANID com o modelo; o estado 0 compara o subtipo com constantes (8, 9, 10, 17, 20).
const BOX_MODELS = {
  0: ['BT10V', 'TNT'], 2: ['BN10V', 'comum'], 3: ['BS10V', 'seta (pula)'], 4: ['BC10V', 'checkpoint'],
  5: ['BI10V', 'ferro'], 6: ['BF10V', 'ripada (várias frutas)'], 7: ['BA10V', '"!"'], 8: ['BL10V', 'vida extra'],
  9: ['BD10V', 'Aku Aku'], 10: ['Bp10V', '"?"'], 13: ['BG10V', 'contorno'], 17: ['Bp10V', '"?"'], 20: ['BN10V', 'comum'],
};
// Animação de repouso do Crash (WiI1V); os demais usam a 1ª animação do objeto (andar, para inimigos).
const ANIM_OVERRIDE = { Will: 'WiI1V' };
for (const e of entities) {
  let anim = ANIM_OVERRIDE[e.gool] && byName.has(ANIM_OVERRIDE[e.gool]) ? ANIM_OVERRIDE[e.gool] : goolAnims(e.gool)[0];
  if (e.gool === 'Boxs') {
    const [m, label] = BOX_MODELS[e.sub] || ['BN10V', 'desconhecida'];
    anim = byName.has(m) ? m : 'BN10V';
    e.label = 'Caixa ' + label;
  }
  if (anim) e.model = exportModel(anim);
  // inimigos: todas as animações do objeto (andar, esmagado, virado, levantando…)
  if (e.gool === 'Crab' || e.gool === 'Turt') e.anims = goolAnims(e.gool).filter((n, i, a) => a.indexOf(n) === i).map(n => exportModel(n));
}
// Sprites (animações tipo 2 no item5 do GOOL): cabeçalho u16 tipo=2, u16 nº de quadros, u32 EID da página de
// textura; depois um par de palavras por quadro (cor/flags, palavra de textura igual à do cenário).
// Os 4 cantos vêm da tabela de UVs (ordem do POLY_FT4: cima-esq., cima-dir., baixo-esq., baixo-dir.).
function exportSprite(goolName, index = 0) {
  const g = [...byEid.values()].find(e => e.type === 11 && e.name.startsWith(goolName));
  const it = g.items[5];
  let o = 0, k = 0;
  while (o + 8 <= it.length) {
    const kind = it.readUInt16LE(o), n = it.readUInt16LE(o + 2);
    if (kind === 2 && k++ === index) {
      const chunk = texChunks.get(it.readUInt32LE(o + 4)), frames = [];
      for (let f = 0; f < n; f++) {
        const w0 = it.readUInt32LE(o + 8 + 8 * f), w1 = it.readUInt32LE(o + 12 + 8 * f), top = w0 >>> 24;
        const cm = (w1 >>> 20) & 3, uoff = (((w1 >>> 13) & 0x1f) * 8) >> cm, voff = (w1 & 0x1f) * 4;
        const t = UVTAB + 8 * (w1 >>> 22);
        const uv = [0, 2, 4, 6].map(q => [exe[t + q] + uoff, exe[t + q + 1] + voff]);
        frames.push({ uv, page: [chunk, (w1 >>> 18) & 3, cm, (top & 0xf) * 16, (w1 >>> 6) & 0x7f, -1] });
      }
      return { frames };
    }
    o += kind === 1 ? 8 : 8 + 8 * n; // modelo: 8 bytes; sprite: cabeçalho + quadros
  }
  return null;
}
const sprites = { fruit: exportSprite('Frui') };
stats.fruitFrames = sprites.fruit ? sprites.fruit.frames.length : 0;
const akuModel = byName.has('WD10V') ? exportModel('WD10V') : null; // máscara do Aku Aku (DoctC)

// Todas as animações do Crash (o jogador usa parado/correr/pular).
const crashAnims = goolAnims('Will').filter((n, i, a) => a.indexOf(n) === i).map(n => exportModel(n));
// Galeria de todas as animações das caixas (para identificar os subtipos).
const gallery = goolAnims('Boxs').map(n => exportModel(n));

// Texturas para a pista procedural: os ladrilhos mais usados no cenário perto do fim do trecho real
// (selva/ruínas), separados em chão (normal para cima) e parede (normal na horizontal).
function pickTiles(z0, z1) {
  const count = { ground: new Map(), wall: new Map() };
  const tris = passes.opaque;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
    if (a.f[0] < 0) continue;
    const zc = (a.p[2] + b.p[2] + c.p[2]) / 3;
    if (zc < z0 || zc > z1) continue;
    const u = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]], v = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1, ny = Math.abs(n[1] / len);
    const kind = ny > 0.85 ? 'ground' : ny < 0.25 ? 'wall' : null;
    if (!kind) continue;
    const us = [a.uv[0], b.uv[0], c.uv[0]], vs = [a.uv[1], b.uv[1], c.uv[1]];
    const rect = [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
    if (rect[2] - rect[0] < 15 || rect[3] - rect[1] < 15) continue; // ladrilhos inteiros, não lascas
    const key = JSON.stringify([a.f, rect]);
    count[kind].set(key, (count[kind].get(key) || 0) + len);   // pesa pela área
  }
  const best = m => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k]) => { const [page, rect] = JSON.parse(k); return { page, rect }; });
  return { ground: best(count.ground), wall: best(count.wall) };
}
const procTiles = pickTiles(100300, 118000);
stats.procTiles = `${procTiles.ground.length} chão, ${procTiles.wall.length} parede`;

// Sons (entries ADIO, tipo 12): item0 é ADPCM do PS1 (VAG sem cabeçalho), em blocos de 16 bytes:
// byte0 = shift (4 bits baixos) e filtro (4 altos), byte1 = flags, 14 bytes = 28 amostras de 4 bits.
const VAG_FILTER = [[0, 0], [60, 0], [115, -52], [98, -55], [122, -60]];
function decodeVag(buf) {
  const out = [];
  let s1 = 0, s2 = 0;
  for (let o = 0; o + 16 <= buf.length; o += 16) {
    const shift = buf[o] & 0xf, filter = Math.min(4, buf[o] >> 4), flags = buf[o + 1];
    const [f0, f1] = VAG_FILTER[filter];
    for (let i = 2; i < 16; i++) {
      for (const nib of [buf[o + i] & 0xf, buf[o + i] >> 4]) {
        let s = ((nib << 28) >> 28) << 12 >> shift;          // 4 bits com sinal, escalados
        s += (s1 * f0 + s2 * f1) / 64;
        s = Math.max(-32768, Math.min(32767, Math.round(s)));
        s2 = s1; s1 = s;
        out.push(s);
      }
    }
    if (flags & 1) break; // fim do som
  }
  return out;
}
function wavFile(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  return b;
}
// Taxa: o GOOL toca com pitch ~1024 (= velocidade original). A taxa de amostragem não está no ADIO;
// 11 025 Hz é uma suposição (as durações ficam plausíveis: pulo 0,44 s, passo 0,21 s, grito de queda 1,04 s).
// Se os sons parecerem lentos/graves demais, troque para 22 050.
const SFX_RATE = 11025;
const sfx = {};
fs.mkdirSync(path.join(outDir, 'sfx'), { recursive: true });
for (const e of byEid.values()) {
  if (e.type !== 12 || !e.items[0]) continue;
  const samples = decodeVag(e.items[0]);
  fs.writeFileSync(path.join(outDir, 'sfx', e.name.replace(/!/g, '_') + '.wav'), wavFile(samples, SFX_RATE));
  sfx[e.name] = { file: 'sfx/' + e.name.replace(/!/g, '_') + '.wav', seconds: +(samples.length / SFX_RATE).toFixed(2) };
}
stats.sfx = Object.keys(sfx).length;

fs.mkdirSync(outDir, { recursive: true });
const header = { zones: wgeo.map((e, i) => ({ name: e.name, bounds: bounds[i] })), textures: texData.length, passes: {}, entities, gallery, crashAnims, camPaths, sprites, akuModel, procTiles, sfx };
// Quadro 0 de cada modelo vira uma passada completa; os demais quadros só têm posição e cor.
header.anims = {};
for (const [k, frames] of Object.entries(models)) passes['model:' + k] = frames[0];
const parts = [];
let offset = 0;
for (const [name, vs] of Object.entries(passes)) {
  const n = vs.length;
  const pos = new Float32Array(n * 3), col = new Uint8Array(n * 4), inf = new Int16Array(n * 8);
  vs.forEach((v, i) => {
    pos.set(v.p, i * 3); // os dados já usam y para cima
    col.set([...v.c, 255], i * 4);
    inf.set([v.uv[0], v.uv[1], ...v.f], i * 8);
  });
  header.passes[name] = { count: n, pos: offset, col: offset + pos.byteLength, info: offset + pos.byteLength + col.byteLength };
  for (const arr of [pos, col, inf]) { parts.push(Buffer.from(arr.buffer)); offset += arr.byteLength; }
}
for (const [k, frames] of Object.entries(models)) {
  header.anims[k] = frames.map(tris => {
    const pos = new Float32Array(tris.length * 3), col = new Uint8Array(tris.length * 4);
    tris.forEach((v, i) => { pos.set(v.p, i * 3); col.set([...v.c, 255], i * 4); });
    const r = { pos: offset, col: offset + pos.byteLength };
    for (const arr of [pos, col]) { parts.push(Buffer.from(arr.buffer)); offset += arr.byteLength; }
    return r;
  });
}
header.collision = collisionZones.map(z => {
  const r = { name: z.name, offset, length: z.item.length };
  const padded = Buffer.alloc((z.item.length + 3) & ~3);
  z.item.copy(padded);
  parts.push(padded); offset += padded.length;
  return r;
});
header.texOffset = offset;
parts.push(...texData);
fs.writeFileSync(path.join(outDir, 'level.bin'), Buffer.concat(parts));
fs.writeFileSync(path.join(outDir, 'level.json'), JSON.stringify(header));
console.log(JSON.stringify(stats), 'zonas', wgeo.length, 'texturas', texData.length,
  'opacos', passes.opaque.length / 3, 'transp', passes.trans.length / 3, 'céu', passes.sky.length / 3);
