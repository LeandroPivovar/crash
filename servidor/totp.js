// Códigos de 6 dígitos de app autenticador (TOTP, RFC 6238: HMAC-SHA1, intervalos de 30 s).
// Compatível com Google Authenticator, Microsoft Authenticator, Authy, 1Password etc.
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, valor = 0, out = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { out += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
  return out;
}
function deBase32(txt) {
  let bits = 0, valor = 0;
  const out = [];
  for (const ch of txt.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = ALFABETO.indexOf(ch);
    if (i < 0) throw new Error('base32 inválido');
    valor = (valor << 5) | i; bits += 5;
    if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const novoSegredo = () => base32(crypto.randomBytes(20)); // 160 bits
const PASSO = 30;
function codigoNoIntervalo(segredo, intervalo) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(intervalo));
  const h = crypto.createHmac('sha1', deBase32(segredo)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// Confere o código aceitando 1 intervalo de diferença (relógio do celular adiantado/atrasado).
// Devolve o intervalo usado (para não aceitar o mesmo código de novo) ou null.
function conferir(segredo, codigo, agoraMs = Date.now()) {
  const c = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const atual = Math.floor(agoraMs / 1000 / PASSO);
  for (const d of [0, -1, 1]) {
    const esperado = codigoNoIntervalo(segredo, atual + d);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(c))) return atual + d;
  }
  return null;
}
const uri = (segredo, conta, emissor = 'Crash Arena') =>
  `otpauth://totp/${encodeURIComponent(emissor)}:${encodeURIComponent(conta)}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=6&period=${PASSO}`;

module.exports = { novoSegredo, conferir, uri, codigoNoIntervalo, PASSO };
