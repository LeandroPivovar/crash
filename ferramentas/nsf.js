// Leitura de arquivos NSF (Crash Bandicoot 1, PS1): chunks de 64 KB, alguns comprimidos (LZ, magic 0x1235).
const fs = require('fs');

const CHUNK = 0x10000;

function decompress(b, off) {
  const length = b.readInt32LE(off + 4);
  const skip = b.readInt32LE(off + 8);
  const out = Buffer.alloc(CHUNK);
  let pos = 0, i = off + 12;
  while (pos < length) {
    const prefix = b[i++];
    if (prefix & 0x80) {
      const value = b[i++];
      const seek = (((prefix & 0x7f) << 8) | value) >> 3;
      let span = value & 7;
      span = span === 7 ? 64 : span + 3;
      for (let k = 0; k < span; k++) out[pos + k] = out[pos - seek + k];
      pos += span;
    } else {
      b.copy(out, pos, i, i + prefix);
      i += prefix; pos += prefix;
    }
  }
  i += skip;
  b.copy(out, length, i, i + (CHUNK - length));
  i += CHUNK - length;
  return { data: out, end: i };
}

// Nome de entry: 5 caracteres de 6 bits codificados num inteiro de 32 bits.
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_!';
function eidName(e) {
  let s = '';
  for (let k = 0; k < 5; k++) s = ALPHA[(e >>> (1 + 6 * k)) & 63] + s;
  return s;
}

function readChunks(path) {
  const b = fs.readFileSync(path);
  const chunks = [];
  let off = 0;
  while (off < b.length) {
    const magic = b.readUInt16LE(off);
    let data, end;
    if (magic === 0x1235) ({ data, end } = decompress(b, off));
    else if (magic === 0x1234) { data = b.subarray(off, off + CHUNK); end = off + CHUNK; }
    else throw new Error(`magic desconhecido 0x${magic.toString(16)} em 0x${off.toString(16)}`);
    chunks.push({ fileOffset: off, compressed: magic === 0x1235, data });
    off = (end + 0x7ff) & ~0x7ff;
  }
  return chunks;
}

function parseChunk(c) {
  const d = c.data;
  const type = d.readUInt16LE(2);
  const chunk = { type, id: d.readUInt32LE(4), entries: [], data: d };
  if (type === 1) return chunk; // chunk de textura: os 64 KB inteiros são uma página de VRAM
  const n = d.readInt32LE(8);
  for (let e = 0; e < n; e++) {
    const s = d.readInt32LE(16 + 4 * e), t = d.readInt32LE(16 + 4 * (e + 1));
    const ent = d.subarray(s, t);
    const ic = ent.readInt32LE(12);
    const items = [];
    for (let k = 0; k < ic; k++) items.push(ent.subarray(ent.readInt32LE(16 + 4 * k), ent.readInt32LE(16 + 4 * (k + 1))));
    const eid = ent.readUInt32LE(4);
    chunk.entries.push({ eid, name: eidName(eid), type: ent.readInt32LE(8), items });
  }
  return chunk;
}

function load(path) {
  return readChunks(path).map(parseChunk);
}

module.exports = { load, eidName, CHUNK };
