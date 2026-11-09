// Gateway CajuPay (Pix): cobrança de depósito, consulta de status, saque (payout) e webhook assinado.
// Docs: https://cajupay.com.br/docs
//
// Variáveis (só no servidor, em /opt/arena/arena.env — nunca no site nem no GitHub):
//   CAJUPAY_API_KEY      chave pública (gpk_...)
//   CAJUPAY_API_SECRET   segredo (gsk_...)
//   CAJUPAY_WEBHOOK_SECRET  segredo de assinatura do webhook (cwhsec_...). Sem ele, o servidor cadastra o webhook
//                        sozinho ao subir e guarda o segredo em cajupay-webhook-secret.txt, na pasta do banco.
//   CAJUPAY_SAQUE_AUTOMATICO=1  aprovar um saque no admin manda o Pix pela CajuPay (precisa de KYC aprovado
//                        e escopo payouts.write). Sem isso, aprovar só dá baixa (o operador paga por fora).
// Sem CAJUPAY_API_KEY/SECRET o site continua no modo simulado (depósito entra na hora, sem dinheiro de verdade).
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const BASE = (process.env.CAJUPAY_BASE_URL || 'https://api.cajupay.com.br').replace(/\/+$/, '');
const CHAVE = process.env.CAJUPAY_API_KEY || '', SEGREDO = process.env.CAJUPAY_API_SECRET || '';
// junto do banco (em produção /opt/arena/dados, a única pasta em que o serviço pode escrever)
const arqSegredoWebhook = path.join(path.dirname(require('./banco').arquivo), 'cajupay-webhook-secret.txt');

const configurado = () => !!(CHAVE && SEGREDO);
const saqueAutomatico = () => configurado() && process.env.CAJUPAY_SAQUE_AUTOMATICO === '1';

class ErroGateway extends Error {
  constructor(status, corpo) {
    const msg = typeof corpo === 'object' && corpo ? (corpo.user_message || corpo.error || corpo.message || JSON.stringify(corpo)) : String(corpo || '');
    super(`CajuPay ${status}: ${String(msg).slice(0, 300)}`);
    this.status = status; this.corpo = corpo;
  }
}

async function chamar(metodo, rota, corpo, { idempotencia } = {}) {
  if (!configurado()) throw new Error('CajuPay não configurada.');
  const cab = { 'X-API-Key': CHAVE, 'X-API-Secret': SEGREDO, Accept: 'application/json' };
  if (corpo) cab['Content-Type'] = 'application/json';
  if (idempotencia) cab['Idempotency-Key'] = String(idempotencia).slice(0, 200);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(BASE + rota, { method: metodo, headers: cab, body: corpo ? JSON.stringify(corpo) : undefined, signal: ctrl.signal });
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* erro em texto simples */ }
    if (!r.ok) throw new ErroGateway(r.status, json || texto);
    return json;
  } finally { clearTimeout(t); }
}

// Cobrança Pix de um depósito. idempotencia = id do depósito (repetir não cria outra cobrança).
const criarPix = ({ valor, depositoId, usuario, urlCheckout }) => chamar('POST', '/api/payments/pix', {
  amount_cents: valor, currency: 'BRL',
  description: `Depósito Crash Arena #${depositoId}`,
  product_ref: `deposito-${depositoId}`, customer_ref: `usuario-${usuario.id}`,
  ...(urlCheckout ? { partner_checkout_url: urlCheckout } : {}),
  consumer: { name: usuario.nome, ...(usuario.email ? { email: usuario.email } : {}) },
  metadata: { deposito_id: String(depositoId), usuario_id: String(usuario.id) },
}, { idempotencia: `deposito-${depositoId}` });

const consultarPagamento = id => chamar('GET', `/api/payments/${encodeURIComponent(id)}`);

// Saque Pix para a chave do jogador (CPF ou telefone). idempotencia = id do saque.
const enviarSaque = ({ saqueId, valor, chaveTipo, chave, documentoTitular }) => chamar('POST', '/api/payouts', {
  amount_cents: valor, currency: 'BRL', wallet_kind: 'main', external_ref: `saque-${saqueId}`,
  destination: { method: 'dict' },
  pix_key: chaveTipo === 'telefone' ? `+55${chave}` : chave,
  pix_key_type: chaveTipo === 'telefone' ? 'phone' : 'cpf',
  ...(chaveTipo === 'telefone' && documentoTitular ? { key_owner_document: documentoTitular } : {}),
}, { idempotencia: `saque-${saqueId}` });

// ---------- webhook ----------
function segredoWebhook() {
  if (process.env.CAJUPAY_WEBHOOK_SECRET) return process.env.CAJUPAY_WEBHOOK_SECRET;
  try { return fs.readFileSync(arqSegredoWebhook, 'utf8').trim(); } catch { return ''; }
}
// Confere X-CajuPay-Signature (t=<unix>,v1=<hex>) = HMAC_SHA256(segredo, t + "." + corpo cru); recusa com mais de 5 min.
function conferirAssinatura(cabecalho, corpoCru) {
  const segredo = segredoWebhook();
  if (!segredo) return false;
  const partes = Object.fromEntries(String(cabecalho || '').split(',').map(p => p.trim().split('=')).filter(p => p.length === 2));
  const ts = partes.t, sig = partes.v1 || '';
  if (!/^\d{1,12}$/.test(ts || '') || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const esperado = crypto.createHmac('sha256', segredo).update(`${ts}.${corpoCru.toString('utf8')}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig.toLowerCase(), 'hex'), Buffer.from(esperado, 'hex'));
}
// Cadastra (ou confirma) o webhook na CajuPay ao subir; guarda o segredo devolvido (só vem na 1ª vez).
async function registrarWebhook(url) {
  if (!configurado() || !/^https:\/\//.test(url)) return { ok: false, motivo: 'sem chaves ou sem https' };
  const corpo = { url, description: 'Crash Arena', event_types: ['pix.payment.*', 'payout.*'] };
  let r = await chamar('POST', '/api/webhooks/endpoints/register', corpo);
  if (!r?.signing_secret && !segredoWebhook()) r = await chamar('POST', '/api/webhooks/endpoints/register', { ...corpo, rotate_if_exists: true });
  if (r?.signing_secret) fs.writeFileSync(arqSegredoWebhook, r.signing_secret + '\n', { mode: 0o600 });
  return { ok: !!segredoWebhook() };
}

module.exports = { configurado, saqueAutomatico, criarPix, consultarPagamento, enviarSaque, conferirAssinatura, registrarWebhook, segredoWebhook, ErroGateway };
