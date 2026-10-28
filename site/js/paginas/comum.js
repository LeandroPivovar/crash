// Partes comuns das páginas da plataforma: cabeçalho com saldo, aviso (toast) e utilitários.
import * as arena from '../arena.js';

export const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// raiz: caminho relativo até site/ ('../' nas páginas de uma pasta). ativo: 'lobby' | 'carteira' | 'conta'
export async function cabecalho({ raiz = '../', ativo = '' } = {}) {
  const el = document.getElementById('topo');
  const { usuario: u, saldo = 0 } = await arena.sessao();
  const link = (pag, txt) => `<a href="${raiz}${pag}/" class="${ativo === pag ? 'ativo' : ''}" ${ativo === pag ? 'aria-current="page"' : ''}>${txt}</a>`;
  const iniciais = u ? esc(u.nome.trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase() || 'P1') : 'P1';
  el.innerHTML = `
    <a class="brand" href="${raiz}lobby/" aria-label="Crash Arena — lobby"><img src="${raiz}img/plataforma/logo-horizontal.svg" alt="Crash Arena"></a>
    <nav>${link('lobby', 'Lobby')}${link('carteira', 'Carteira')}${link('conta', 'Minha conta')}${u?.operador ? link('admin/configuracoes', 'Regras') : ''}</nav>
    <div class="top-right">
      <span class="coin" aria-hidden="true">✦</span><b id="saldo-topo" title="Saldo em moedas">${arena.moedas(saldo)}</b>
      <a class="avatar" href="${raiz}conta/" aria-label="Minha conta">${iniciais}</a>
    </div>`;
}
export function atualizarSaldoTopo(saldo) {
  const b = document.getElementById('saldo-topo');
  if (b) b.textContent = arena.moedas(saldo);
}

export function toast(texto) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = texto;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3500);
}

const data = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const quando = t => data.format(new Date(t));

// Valor com sinal e cor: +12,50 / −3,00
export const comSinal = c => `<b class="${c > 0 ? 'gain' : c < 0 ? 'loss' : ''}">${c > 0 ? '+' : c < 0 ? '−' : ''}${arena.moedas(Math.abs(c))}</b>`;

// Botão "ocupado" enquanto o pedido vai ao servidor
export async function ocupado(botao, fn) {
  botao.disabled = true;
  try { return await fn(); } finally { botao.disabled = false; }
}
