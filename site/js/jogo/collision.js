// Colisão do Crash 1: cada zona tem uma octree (item1 da entry ZDAT).
// Cabeçalho: x, y, z, largura, altura, profundidade (int32); 0x1C nó raiz; 0x1E/0x20/0x22 profundidade máxima x/y/z.
// Nó: offset (u16 par) para 2, 4 ou 8 filhos, conforme quais eixos ainda se dividem nessa profundidade.
// Folha: 0 = vazio; valor ímpar = sólido (o valor codifica o tipo de superfície).

export class Collision {
  constructor(list, bin) {
    this.zones = list.map(z => {
      const v = new DataView(bin, z.offset, z.length);
      return {
        name: z.name, view: v,
        x: v.getInt32(0, true), y: v.getInt32(4, true), z: v.getInt32(8, true),
        w: v.getInt32(12, true), h: v.getInt32(16, true), d: v.getInt32(20, true),
        root: v.getUint16(0x1c, true),
        depth: [v.getUint16(0x1e, true), v.getUint16(0x20, true), v.getUint16(0x22, true)],
      };
    });
    // Ordem dos eixos nos bits do índice do filho (do bit mais alto para o mais baixo).
    this.order = [0, 1, 2];
  }

  zoneAt(x, y, z) {
    for (const zn of this.zones)
      if (x >= zn.x && x < zn.x + zn.w && y >= zn.y && y < zn.y + zn.h && z >= zn.z && z < zn.z + zn.d) return zn;
    return null;
  }

  // Valor da folha no ponto (unidades do jogo); 0 se vazio ou fora das zonas.
  leafAt(x, y, z) {
    const zn = this.zoneAt(x, y, z);
    if (!zn) return 0;
    const p = [x - zn.x, y - zn.y, z - zn.z];
    const lo = [0, 0, 0], size = [zn.w, zn.h, zn.d];
    let node = zn.root, level = 0;
    while (node !== 0 && !(node & 1)) {
      let idx = 0;
      for (const a of this.order) {
        if (level >= zn.depth[a]) continue;
        size[a] /= 2;
        const hi = p[a] >= lo[a] + size[a];
        if (hi) lo[a] += size[a];
        idx = (idx << 1) | (hi ? 1 : 0);
      }
      node = zn.view.getUint16(node + 2 * idx, true);
      level++;
    }
    return node;
  }

  // Folhas não vazias de todas as zonas que tocam a caixa [x0,x1]×[y0,y1]×[z0,z1]
  // (como 0x80037D50, chamada por 0x800294B0). cb(valor, x0, y0, z0, x1, y1, z1) com os limites da célula.
  cellsInBox(x0, y0, z0, x1, y1, z1, cb) {
    for (const zn of this.zones) {
      if (x1 < zn.x || x0 > zn.x + zn.w || y1 < zn.y || y0 > zn.y + zn.h || z1 < zn.z || z0 > zn.z + zn.d) continue;
      const walk = (node, level, lx, ly, lz, sx, sy, sz) => {
        const ax = zn.x + lx, ay = zn.y + ly, az = zn.z + lz;
        if (ax > x1 || ax + sx < x0 || ay > y1 || ay + sy < y0 || az > z1 || az + sz < z0) return;
        if (node === 0) return;
        if (node & 1) { cb(node, ax, ay, az, ax + sx, ay + sy, az + sz); return; }
        const dx = level < zn.depth[0], dy = level < zn.depth[1], dz = level < zn.depth[2];
        const hx = dx ? sx / 2 : sx, hy = dy ? sy / 2 : sy, hz = dz ? sz / 2 : sz;
        let i = 0;
        for (let bx = 0; bx <= (dx ? 1 : 0); bx++)
          for (let by = 0; by <= (dy ? 1 : 0); by++)
            for (let bz = 0; bz <= (dz ? 1 : 0); bz++)
              walk(zn.view.getUint16(node + 2 * i++, true), level + 1, lx + bx * hx, ly + by * hy, lz + bz * hz, hx, hy, hz);
      };
      walk(zn.root, 0, 0, 0, 0, zn.w, zn.h, zn.d);
    }
  }

  // Percorre as folhas sólidas de uma zona: cb(valor, x, y, z, w, h, d) em unidades do jogo.
  forEachSolid(zn, cb) {
    const walk = (node, level, lo, size) => {
      if (node === 0) return;
      if (node & 1) { cb(node, zn.x + lo[0], zn.y + lo[1], zn.z + lo[2], size[0], size[1], size[2]); return; }
      const axes = this.order.filter(a => level < zn.depth[a]);
      const half = size.map((s, a) => (axes.includes(a) ? s / 2 : s));
      for (let i = 0; i < 1 << axes.length; i++) {
        const l = lo.slice();
        axes.forEach((a, k) => { if ((i >> (axes.length - 1 - k)) & 1) l[a] += half[a]; });
        walk(zn.view.getUint16(node + 2 * i, true), level + 1, l, half);
      }
    };
    walk(zn.root, 0, [0, 0, 0], [zn.w, zn.h, zn.d]);
  }
}
