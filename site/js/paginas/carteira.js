// Carteira: saldo, depósito e saque simulados, e o histórico de movimentos (tudo no servidor).
import * as arena from '../arena.js';
import { cabecalho, atualizarSaldoTopo, toast, quando, comSinal, esc, ocupado } from './comum.js';

const u = await arena.exigirLogin('../');
await arena.resolverPartidaPendente().catch(() => null);
await cabecalho({ ativo: 'carteira' });

const $ = id => document.getElementById(id);
const brl = c => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(c / 100);
let acao = 'deposito', metodo = 'pix', pendente = 0;
const erro = $('erro');

const NOMES = { deposito: 'Depósito', saque: 'Saque', entrada: 'Entrada', premio: 'Frutas', estorno: 'Estorno' };
async function render() {
  const c = await arena.carteira();
  $('saldo').textContent = arena.moedas(c.saldo);
  atualizarSaldoTopo(c.saldo);
  $('movimentos').innerHTML = c.movimentos.length
    ? c.movimentos.map(m => `<li><span>${NOMES[m.tipo] || esc(m.tipo)}<small>${esc(m.descricao)} · ${quando(m.quando)}</small></span>${comSinal(m.valor)}</li>`).join('')
    : '<li class="vazio">Nenhum movimento ainda.</li>';
}
function renderBotoes() {
  $('metodos').hidden = acao !== 'deposito';
  $('enviar').textContent = acao === 'saque' ? 'SIMULAR SAQUE ↗' : metodo === 'pix' ? 'CONTINUAR COM PIX ➜' : 'CONTINUAR COM CARTÃO ➜';
}

document.querySelectorAll('[data-acao]').forEach(b => b.addEventListener('click', () => {
  acao = b.dataset.acao;
  document.querySelectorAll('[data-acao]').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-selected', x === b); });
  erro.textContent = '';
  renderBotoes();
}));
document.querySelectorAll('[data-metodo]').forEach(b => b.addEventListener('click', () => {
  metodo = b.dataset.metodo;
  document.querySelectorAll('[data-metodo]').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-pressed', x === b); });
  renderBotoes();
}));
$('rapidos').addEventListener('click', e => {
  const b = e.target.closest('[data-v]');
  if (b) { $('valor').value = b.dataset.v; erro.textContent = ''; }
});

$('form').addEventListener('submit', e => {
  e.preventDefault();
  const v = arena.paraCentavos($('valor').value);
  if (!(v >= 100) || v > arena.LIMITE_MOVIMENTO) { erro.textContent = 'Informe um valor entre R$ 1 e R$ 10.000.'; $('valor').focus(); return; }
  erro.textContent = '';
  if (acao === 'saque') {
    if (u.visitante) { erro.textContent = 'Visitantes não podem sacar. Crie uma conta para sacar.'; return; }
    // cada saque pede o código do app autenticador
    pendente = v;
    $('saque-valor').textContent = brl(v);
    $('saque-com-2fa').hidden = !u.doisFatoresAtivo;
    $('saque-sem-2fa').hidden = !!u.doisFatoresAtivo;
    $('saque-erro').textContent = ''; $('saque-codigo').value = '';
    $('dlg-saque').showModal();
    if (u.doisFatoresAtivo) $('saque-codigo').focus();
    return;
  }
  pendente = v;
  const pix = metodo === 'pix';
  $('dlg-badge').textContent = `CARTEIRA · ${pix ? 'PIX' : 'CARTÃO'}`;
  $('dlg-titulo').textContent = pix ? 'Depósito via Pix' : 'Depósito com cartão';
  $('dlg-valor').textContent = brl(v);
  $('dlg-moedas').textContent = `✦ ${arena.moedas(v)} moedas`;
  $('confirmar').showModal();
});
document.querySelectorAll('[data-fechar-saque]').forEach(b => b.addEventListener('click', () => $('dlg-saque').close()));
$('saque-codigo').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('saque-ok').click(); } });
$('saque-ok').addEventListener('click', e => ocupado(e.currentTarget, async () => {
  const codigo = $('saque-codigo').value.trim();
  if (!codigo) { $('saque-erro').textContent = 'Digite o código do app.'; return; }
  try {
    await arena.sacar(pendente, codigo);
    pendente = 0;
    $('dlg-saque').close();
    toast('Saque simulado concluído. Nenhum dinheiro foi movimentado.');
    await render();
  } catch (err) {
    if (err.codigo === 'precisa_codigo') { $('saque-erro').textContent = err.message; $('saque-codigo').select(); }
    else { $('dlg-saque').close(); erro.textContent = err.message; }
  }
}));
document.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', () => $('confirmar').close()));
$('dlg-ok').addEventListener('click', e => ocupado(e.currentTarget, async () => {
  try {
    if (pendente > 0) await arena.depositar(pendente, metodo);
    pendente = 0;
    $('confirmar').close();
    toast('Depósito simulado concluído.');
    await render();
  } catch (err) { $('confirmar').close(); erro.textContent = err.message; }
}));

renderBotoes();
await render();
