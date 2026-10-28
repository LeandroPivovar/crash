// Cliente do Crash Arena (fase 2): todas as páginas e o jogo falam com o servidor só por aqui.
// Sessão por cookie (o navegador manda sozinho). Valores em CENTAVOS de moeda (R$ 1 = 1 moeda = 100).
import { normalize } from './jogo/config.js';

// ---------- formatação ----------
const numero = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const moedas = c => numero.format(c / 100);              // 1250 → "12,50"
export const paraCentavos = v => {                                // "12,5" / "1.234,56" → centavos (ou NaN)
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return s && Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

// ---------- chamada à API ----------
export class ErroApi extends Error { constructor(status, msg, codigo) { super(msg); this.status = status; this.codigo = codigo; } }
async function api(metodo, rota, corpo, { manter = false } = {}) {
  let res;
  try {
    res = await fetch('/api' + rota, {
      method: metodo,
      credentials: 'same-origin',
      keepalive: manter, // deixa o pedido terminar mesmo se a página estiver fechando
      headers: metodo === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Arena': '1' },
      body: metodo === 'GET' ? undefined : JSON.stringify(corpo || {}),
    });
  } catch { throw new ErroApi(0, 'Sem conexão com o servidor. Tente de novo.'); }
  let dados = {};
  try { dados = await res.json(); } catch {}
  if (!res.ok) throw new ErroApi(res.status, dados.erro || `Erro ${res.status}.`, dados.codigo);
  return dados;
}

// ---------- sessão ----------
let eu = null; // cache da página: { usuario, saldo }
export async function sessao(forcar = false) {
  if (!eu || forcar) eu = await api('GET', '/eu');
  return eu;
}
export const usuario = async () => (await sessao()).usuario;
export async function cadastrar({ nome, email, senha, nascimento }) { eu = null; return api('POST', '/cadastro', { nome, email, senha, nascimento }); }
// Pode responder { precisa2fa: true, desafio } (conta com app autenticador): aí vem entrarComCodigo.
export async function entrar({ email, senha }) { eu = null; return api('POST', '/login', { email, senha }); }
export async function entrarComCodigo(desafio, codigo) { eu = null; return api('POST', '/login/2fa', { desafio, codigo }); }
// confirmação do e-mail (o cadastro responde { confirmar: true, email } e não entra até confirmar)
export async function confirmarEmail(token) { eu = null; return api('POST', '/confirmar', { token }); }
export const reenviarConfirmacao = (email, senha) => api('POST', '/confirmar/reenviar', { email, senha });
export async function entrarVisitante() { eu = null; return api('POST', '/visitante', { maior18: true }); }
export async function sair() { eu = null; return api('POST', '/sair'); }
export async function atualizarUsuario(dados) { const r = await api('PATCH', '/eu', dados); eu = null; return r.usuario; }
export const recuperarSenha = email => api('POST', '/recuperar', { email });
export const redefinirSenha = (token, senha) => api('POST', '/redefinir', { token, senha });
// Página que exige login: sem sessão, volta para a entrada (raiz = caminho até site/).
export async function exigirLogin(raiz = '../') {
  const s = await sessao();
  if (!s.usuario) { location.replace(raiz); await new Promise(() => {}); }
  return s.usuario;
}

// ---------- carteira ----------
export const LIMITE_MOVIMENTO = 10000 * 100;
export const carteira = () => api('GET', '/carteira');                     // { saldo, movimentos }
export const depositar = (valor, metodo) => api('POST', '/carteira/deposito', { valor, metodo });
export const sacar = (valor, codigo) => api('POST', '/carteira/saque', { valor, codigo });

// ---------- regras ----------
export const regras = async () => normalize((await api('GET', '/regras')).regras);
export const regrasDaPartida = p => normalize(p.regras);
export const valorPorFruta = (entrada, r) => Math.round(entrada * r.fruitPercent / 100);

// ---------- partida ----------
// estado: criada (entrada paga, tela START) → jogando → encerrada | cancelada
export const partidaAberta = async () => (await api('GET', '/partida')).partida;
export const iniciarPartida = async entrada => (await api('POST', '/partidas', { entrada })).partida;
export const comecarPartida = id => api('POST', `/partidas/${id}/comecar`);
export const cancelarPartida = id => api('POST', `/partidas/${id}/cancelar`, {}, { manter: true });
// Fim da corrida: manda a gravação inteira dos comandos (rle) — o servidor refaz a corrida e decide as
// frutas; `frutas` e `distancia` daqui são só o que o jogo mostrou.
export const encerrarPartida = (id, { frutas, distancia = 0, tempoMs = 0, rle = [], passos = 0, versao }) =>
  api('POST', `/partidas/${id}/encerrar`, { frutas, distancia: Math.round(distancia), tempoMs: Math.round(tempoMs), rle, passos, versao }, { manter: true });
// Progresso parcial: pedaço novo da gravação a partir do par `desde` (o servidor responde quantos pares tem).
export const progresso = (id, { frutas, distancia, desde, rle, versao }) =>
  api('POST', `/partidas/${id}/progresso`, { frutas, distancia: Math.round(distancia), desde, rle, versao }, { manter: true });
export async function resolverPartidaPendente() { return (await api('POST', '/partida/resolver')).encerrada; }
export async function ultimoResultado() { return api('GET', '/resultado'); }              // { partida, saldo }
export async function historicoPartidas() { return (await api('GET', '/partidas')).partidas; }

// ---------- operador ----------
export const salvarRegras = async r => normalize((await api('PUT', '/admin/regras', { regras: r })).regras);
export const analisesPendentes = () => api('GET', '/admin/analises');
export const decidirAnalise = (id, decisao) => api('POST', `/admin/analises/${id}`, { decisao });
export const auditoria = () => api('GET', '/admin/auditoria');
export const iniciar2fa = senha => api('POST', '/admin/2fa/iniciar', { senha });
export const confirmar2fa = codigo => api('POST', '/admin/2fa/confirmar', { codigo });
// jogador (Minha conta): o app é obrigatório para sacar
export const iniciar2faConta = senha => api('POST', '/conta/2fa/iniciar', { senha });
export const confirmar2faConta = codigo => api('POST', '/conta/2fa/confirmar', { codigo });
export const desativar2faConta = (senha, codigo) => api('POST', '/conta/2fa/desativar', { senha, codigo });
