// Desmontador simples de bytecode GOOL (Crash 1), portado de c1c/src/disgool.c.
// Uso como script: node disgool.js <arquivo.NSF> <GOOL, ex. BoxsC> [subtipo...]
const nsf = require('./nsf.js');

const NAMES = [
  'ADD', 'SUB', 'MULT', 'DIV', 'CEQ', 'ANDL', 'ORL', 'ANDB', 'ORB', 'SLT', 'SLE', 'SGT', 'SGE', 'MOD', 'XOR', 'TST',
  'RND', 'MOVE', 'NOTL', 'TRI', 'LEA', 'SHA', 'PSHV', 'NOTB', 'MOVC', 'ABS', 'PAD', 'SPD', 'MSC', 'PRS', 'SSAW', 'GLBR',
  'GLBW', 'ANGD', 'APCH', 'CVMR', 'CVMW', 'ROT', 'PSHP', 'ANID',
];
const HI = ['DBG', 'UNK', 'CFL', 'ANIS', 'ANIF', 'VECA', 'JAL', 'EVNT', 'RSTT', 'RSTF', 'CHLD', 'NTRY', 'SNDA', 'SNDB', 'VECB', 'EVNB', 'EVNU', 'CHLF'];
const CFL = [['BRA', 'BNEZ', 'BEQZ', 'BRAC'], ['CST', 'CSNZ', 'CSEZ', 'CSTC'], ['RET', 'RTNZ', 'RTEZ', 'RETC'], ['SCND', 'SCNZ', 'SCEZ', 'CCND']];

function ref(r, pool) {
  r &= 0xfff;
  if (r === 0xe1f) return 'pop';
  if ((r & 0xe00) === 0xe00) return `obj[0x${((r & 0x1ff) * 4 + 0x60).toString(16)}]`;
  if (!(r & 0x800)) {
    const i = r & 0x3ff;
    // sem o bit 0x400: constante do item2 desta entry; com ele: constante da entry externa (não carregada aqui)
    if (r & 0x400) return `ext[${i}]`;
    return pool && i < pool.length ? `k[${i}]=${pool[i]}` : `k[${i}]`;
  }
  if (!(r & 0x400)) {
    if (!(r & 0x200)) { const v = r & 0xff; return v ? `${(r & 0x100) ? -(0x100 - v) : v}*256` : '0'; }
    if (!(r & 0x100)) { const v = r & 0x7f; return v ? `${(r & 0x80) ? -(0x80 - v) : v}/16` : '0'; }
    if (!(r & 0x80)) { const o = r & 0x3f; return `fp[${(r & 0x40) ? -(0x40 - o) : o}]`; }
    if (r === 0xbe0) return '0';
    if (r === 0xbf0) return 'pop,pop';
    return '?';
  }
  return `link${(r & 0x1c0) >> 6}[0x${(0x60 + (r & 0x3f) * 4).toString(16)}]`;
}

function dis(ins, pool) {
  const op = ins >>> 24, A = (ins >> 12) & 0xfff, B = ins & 0xfff;
  if (op < NAMES.length) {
    const n = NAMES[op];
    if (n === 'ANID') return `ANID ${ref(A, pool)} -> ${ref(B, pool)}`;
    if (n === 'MSC' || n === 'PAD') return `${n} 0x${(ins & 0xffffff).toString(16)}`;
    return `${n} ${ref(A, pool)}, ${ref(B, pool)}`;
  }
  if (op >= 0x80 && op - 0x80 < HI.length) {
    const n = HI[op - 0x80];
    if (n === 'CFL') {
      const os = (ins >> 22) & 3, cond = (ins >> 20) & 3, ri = (ins >> 14) & 0x3f, im = ins & 0x3fff;
      return `${CFL[os][cond]} reg${ri} -> ${os === 0 ? 'pc' + ((ins & 0x200) ? '-' : '+') + (ins & 0x1ff) : os === 1 ? 'state ' + im : ''}`;
    }
    if (n === 'ANIS') return `ANIS frame=${ins & 0x7f} seq=${(ins >> 7) & 0x1ff} wait=${(ins >> 16) & 0x3f} flip=${(ins >> 22) & 3}`;
    if (n === 'ANIF') return `ANIF frame=${ref(ins & 0xfff, pool)} wait=${(ins >> 16) & 0x3f}`;
    return `${n} 0x${(ins & 0xffffff).toString(16)}`;
  }
  return `??? 0x${ins.toString(16)}`;
}

// Estrutura de uma entry GOOL: item0 cabeçalho, item1 código, item2 constantes, item3 mapa de estados,
// item4 descritores de estado (16 bytes), item5 animações.
function load(path, name) {
  let g;
  for (const c of nsf.load(path)) for (const e of c.entries) if (e.name === name && !g) g = e;
  const code = [], pool = [];
  for (let i = 0; i < g.items[1].length / 4; i++) code.push(g.items[1].readUInt32LE(4 * i));
  for (let i = 0; i < g.items[2].length / 4; i++) pool.push(g.items[2].readInt32LE(4 * i));
  const stateMap = [];
  for (let i = 0; i < g.items[3].length / 2; i++) stateMap.push(g.items[3].readUInt16LE(2 * i));
  const states = [];
  for (let i = 0; i < g.items[4].length / 16; i++) {
    const s = g.items[4];
    states.push({ flags: s.readUInt32LE(16 * i), trans: s.readUInt16LE(16 * i + 12), code: s.readUInt16LE(16 * i + 14), event: s.readUInt16LE(16 * i + 10) });
  }
  const subtypeBase = g.items[0].readUInt32LE(0x10);
  return { entry: g, code, pool, stateMap, states, stateFor: sub => stateMap[subtypeBase + sub] };
}

module.exports = { load, dis };

if (require.main === module) {
  const [path, name, ...subs] = process.argv.slice(2);
  const g = load(path, name);
  const list = n => {
    if (n === 0x3fff) return;
    for (let pc = n; pc < g.code.length && pc < n + 40; pc++) console.log(`    ${pc.toString(16).padStart(4)}: ${dis(g.code[pc], g.pool)}`);
  };
  for (const s of subs.map(Number)) {
    const st = g.stateFor(s);
    console.log(`subtipo ${s} -> estado ${st}`);
    if (st === 255 || !g.states[st]) continue;
    console.log('  trans:'); list(g.states[st].trans);
    console.log('  code:'); list(g.states[st].code);
  }
}
