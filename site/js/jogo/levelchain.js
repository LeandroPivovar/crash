// Fase infinita feita com a própria fase: trechos reais da trilha (cenário, colisão da octree, trilhos de
// câmera e entidades) são recortados como "modelos" e encadeados sem fim, um depois do outro, deslocados
// para que a saída de um trecho encoste na entrada do seguinte. A ordem dos trechos e as caixas variam.
import * as THREE from 'three';

const AHEAD = 26000;   // mantém trechos montados até essa distância à frente
const BEHIND = 6000;   // apaga os que ficaram para trás

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LevelChain {
  // opts: { scene, scale, collision (octree real), templates: [{ name, zA, zB, cxA, yA, cxB, yB, geoms: [Geometry],
  //         boxes: [{sub,x,y,z}], enemies: [{gool,path,id}], decor: [{x,y,z,key}], rails: [{r,i}] }],
  //         materials: [Material por geometria], start: {x, y, z}, addBox, removeBox, addEnemy, removeEnemy,
  //         makeDecoration(key), seed }
  constructor(opts) {
    Object.assign(this, opts);
    this.rand = mulberry32(opts.seed ?? 1);
    this.pieces = [];
    this.end = { ...opts.start };
    this.lastName = null;
    this.difficulty = 0;
  }

  pick(list) { return list[Math.floor(this.rand() * list.length)]; }

  update(playerZ, difficulty = 0) {
    this.difficulty = difficulty;
    while (this.end.z > playerZ - AHEAD) this.appendNext();
    while (this.pieces.length && this.pieces[0].zEnd > playerZ + BEHIND) this.dispose(this.pieces.shift());
  }

  // Sorteia entre os trechos dados, sem repetir o anterior se houver outra opção.
  pickTemplate(list) {
    const options = list.length > 1 ? list.filter(t => t.name !== this.lastName) : list;
    const t = this.pick(options.length ? options : list);
    this.lastName = t.name;
    return t;
  }

  // Próximo chunk. O número de buracos é sorteado entre pitsMin e pitsMax (configuração); como cada trecho
  // da fase real tem 0, 1 ou 2 buracos, o chunk junta quantos trechos forem precisos para somar esse
  // número (0 buraco = um trecho sem buraco). Inimigos e o grupo de frutas valem para o chunk inteiro.
  appendNext() {
    // só trechos que começam em chão firme
    const safe = this.templates.filter(t => t.safeStart !== false);
    const pMin = this.config?.pitsMin ?? 0, pMax = this.config?.pitsMax ?? 2;
    const target = pMin + Math.floor(this.rand() * (pMax - pMin + 1));
    const seq = [];
    if (target <= 0) {
      const zero = safe.filter(t => t.pits === 0);
      seq.push(this.pickTemplate(zero.length ? zero : safe));
    } else {
      const withPits = safe.filter(t => t.pits > 0);
      const fewest = Math.min(...withPits.map(t => t.pits));
      for (let rem = target; rem > 0;) {
        let cands = withPits.filter(t => t.pits <= rem);
        if (!cands.length) cands = withPits.filter(t => t.pits === fewest);
        const t = this.pickTemplate(cands);
        seq.push(t);
        rem -= t.pits;
      }
    }
    // inimigos (número fixo): espalhados ao acaso entre os trechos do chunk
    const want = this.config?.enemiesPerChunk ?? 'auto';
    const counts = seq.map(() => 0);
    if (want !== 'auto') for (let i = 0; i < want; i++) counts[Math.floor(this.rand() * seq.length)]++;
    const fruitAt = Math.floor(this.rand() * seq.length);
    const chunk = this.chunkCount = (this.chunkCount || 0) + 1;
    seq.forEach((t, i) => this.appendPiece(t, { wantEnemies: want === 'auto' ? 'auto' : counts[i], withFruit: i === fruitAt, chunk }));
  }

  // Um trecho-modelo, deslocado para a entrada encostar na saída atual.
  appendPiece(t, { wantEnemies = 'auto', withFruit = true, chunk = 0 } = {}) {
    // mapa plano: os trechos já vêm achatados (chão em y = 0), então não sobem nem descem
    const off = new THREE.Vector3(this.end.x - t.cxA, this.plano ? 0 : this.end.y - t.yA, this.end.z - t.zA);
    const piece = { t, off, chunk, zStart: t.zA + off.z, zEnd: t.zB + off.z, meshes: [], boxes: [], enemies: [], decor: [] };
    const s = this.scale;
    t.geoms.forEach((g, k) => {
      const m = new THREE.Mesh(g, this.materials[k]);
      m.position.copy(off).multiplyScalar(s);
      m.frustumCulled = true; // fora da tela não é desenhado (as geometrias são por trecho)
      if (k === 1 || g.userData?.transparente) m.renderOrder = 1; // semitransparentes por último
      this.scene.add(m);
      piece.meshes.push(m);
    });
    // caixas: mesmas posições da fase, mas o conteúdo varia e algumas somem
    for (const b of this.noBoxes ? [] : t.boxes) {
      let sub = b.sub;
      if ([2, 10, 17, 6, 20].includes(sub)) {
        if (this.rand() < 0.15) continue;
        sub = this.pick([2, 2, 2, 10, 10, 6]);
        if (this.rand() < 0.05) sub = this.rand() < 0.7 ? 9 : 8; // Aku Aku ou vida, raros
      }
      if (sub === 13 || sub === 7) continue; // contorno e "!" só fazem sentido juntos na fase original
      piece.boxes.push(this.addBox(sub, b.x + off.x, b.y + off.y, b.z + off.z));
    }
    // inimigos (configuração): número exato neste trecho; os da fase entram primeiro, o resto são caranguejos extras
    const fixed = wantEnemies !== 'auto';
    const realEnemies = fixed ? [...t.enemies].sort(() => this.rand() - 0.5).slice(0, wantEnemies) : t.enemies;
    // inimigos do trecho, nas mesmas trilhas (às vezes um a menos)
    for (const e of realEnemies) {
      if (!fixed && this.rand() < 0.15) continue;
      const path = e.path.map(p => [p[0] + off.x, p[1] + off.y, p[2] + off.z]);
      piece.enemies.push(this.addEnemy(e.gool, path, e.id * 7 + this.pieces.length));
    }
    // extras em pontos livres da trilha real do trecho: mais caixas e caranguejos conforme a dificuldade
    const free = [...(t.spots || [])];
    const extras = fixed ? 99 : Math.floor(2 + this.rand() * 3 + 4 * this.difficulty);
    for (let k = 0; k < extras && free.length; k++) {
      if (fixed && piece.enemies.length >= wantEnemies) break;
      const sp = free.splice(Math.floor(this.rand() * free.length), 1)[0];
      for (let j = free.length - 1; j >= 0; j--) if (Math.abs(free[j].z - sp.z) < 700) free.splice(j, 1); // espaça
      const side = (this.rand() * 2 - 1) * Math.min(350, sp.w / 2 - 300);
      const enemyNear = piece.enemies.some(e => Math.abs(e.pts[0].z - (sp.z + off.z)) < (fixed ? 1000 : 1500));
      if (!enemyNear && (fixed || this.rand() < 0.12 + 0.18 * this.difficulty)) {
        // caranguejo atravessando a trilha
        const half = Math.max(300, sp.w / 2 - 250), path = [];
        for (let q = 0; q <= 8; q++) path.push([sp.x - half + q * (2 * half) / 8 + off.x, sp.y + off.y, sp.z + off.z]);
        piece.enemies.push(this.addEnemy('Crab', path, 5000 + this.pieces.length * 31 + k));
      } else if (!this.noBoxes) {
        const sub = this.pick([2, 2, 2, 10, 6, 3]);
        piece.boxes.push(this.addBox(sub, sp.x + side + off.x, sp.y + off.y, sp.z + off.z));
        if (sub !== 3 && this.rand() < 0.25) piece.boxes.push(this.addBox(this.pick([2, 10]), sp.x + side + off.x, sp.y + 400 + off.y, sp.z + off.z));
      }
    }
    // número fixo ainda incompleto (trecho estreito, poucos pontos livres): segunda passada, mais junta
    if (fixed && piece.enemies.length < wantEnemies) {
      const all = [...(t.spots || [])].sort(() => this.rand() - 0.5);
      for (const sp of all) {
        if (piece.enemies.length >= wantEnemies) break;
        if (piece.enemies.some(e => Math.abs(e.pts[0].z - (sp.z + off.z)) < 500)) continue;
        const half = Math.max(300, sp.w / 2 - 250), path = [];
        for (let q = 0; q <= 8; q++) path.push([sp.x - half + q * (2 * half) / 8 + off.x, sp.y + off.y, sp.z + off.z]);
        piece.enemies.push(this.addEnemy('Crab', path, 7000 + this.pieces.length * 31 + piece.enemies.length));
      }
    }
    // um grupo de frutas por chunk (num dos trechos dele): em fila ao longo da trilha, numa faixa sorteada
    // (esquerda, centro ou direita), num ponto livre longe de buracos
    piece.fruit = [];
    const fSpots = free.length ? free : (t.spots || []);
    if (withFruit && this.addFruitGroup && fSpots.length) {
      const sp = fSpots[Math.floor(this.rand() * fSpots.length)];
      const lo = this.config?.fruitMin ?? 3, hi = this.config?.fruitMax ?? 5;
      const n = lo + Math.floor(this.rand() * (hi - lo + 1)); // tamanho sorteado entre o mínimo e o máximo
      const lane = this.pick([-1, 0, 1]) * Math.min(350, sp.w / 2 - 300);
      const pts = [];
      for (let q = 0; q < n; q++) {
        const z = sp.z + ((n - 1) / 2 - q) * 220;
        const g = t.groundAt ? t.groundAt(z) : null;
        // fila reta (mesmo x): dá para pegar todas sem desviar; a altura acompanha o chão
        pts.push({ x: sp.x + lane + off.x, y: (g ? g.y : sp.y) + off.y, z: z + off.z });
      }
      piece.fruit = this.addFruitGroup(pts);
    }
    for (const d of t.decor) {
      const m = this.makeDecoration(d.key);
      if (!m) continue;
      m.position.set((d.x + off.x) * s, (d.y + off.y) * s, (d.z + off.z) * s);
      m.rotation.y = d.rot || 0;
      this.scene.add(m);
      piece.decor.push(m);
    }
    this.pieces.push(piece);
    this.end = { x: t.cxB + off.x, y: t.yB + off.y, z: t.zB + off.z };
  }

  dispose(p) {
    for (const m of p.meshes) this.scene.remove(m);
    for (const m of p.decor) this.scene.remove(m);
    for (const b of p.boxes) this.removeBox(b);
    for (const e of p.enemies) this.removeEnemy(e);
    if (p.fruit && this.removeFruitGroup) this.removeFruitGroup(p.fruit);
  }

  pieceAt(z) { return this.pieces.find(p => z <= p.zStart && z > p.zEnd); }

  // Colisão: consulta a octree real no espaço do modelo e devolve as células deslocadas,
  // cortadas no intervalo do trecho (assim um trecho não invade o vizinho).
  cellsInBox(x0, y0, z0, x1, y1, z1, cb) {
    for (const p of this.pieces) {
      if (p.zEnd > z1 || p.zStart < z0) continue;
      const { t, off } = p;
      const tz0 = Math.max(z0 - off.z, t.zB), tz1 = Math.min(z1 - off.z, t.zA);
      if (tz0 > tz1) continue;
      this.collision.cellsInBox(x0 - off.x, y0 - off.y, tz0, x1 - off.x, y1 - off.y, tz1, (v, a, b, c, d, e, f) => {
        const cz0 = Math.max(c, t.zB), cz1 = Math.min(f, t.zA);
        if (cz0 >= cz1) return;
        cb(v, a + off.x, b + off.y, cz0 + off.z, d + off.x, e + off.y, cz1 + off.z);
      });
    }
  }
}
