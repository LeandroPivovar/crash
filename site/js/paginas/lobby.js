// Lobby do modo Solo: escolhe o valor de entrada; o servidor cria a partida (desconta a entrada) e o jogo abre.
import * as arena from '../arena.js';
import { cabecalho, atualizarSaldoTopo, toast, quando, comSinal, ocupado } from './comum.js';

const eu = await arena.exigirLogin('../');
// conta nova: antes da primeira partida de verdade, o tutorial (curto, sem dinheiro)
if (eu.tutorialPendente) { location.replace('../jogar/?tutorial=1'); await new Promise(() => {}); }
// partida que ficou aberta (página do jogo fechada): o servidor estorna ou encerra antes do lobby
const pendente = await arena.resolverPartidaPendente().catch(() => null);
await cabecalho({ ativo: 'lobby' });
if (pendente) toast(`A partida anterior foi encerrada com ${pendente.frutas} frutas.`);

const $ = id => document.getElementById(id);
const input = $('entrada'), erro = $('erro');

const s0 = await arena.sessao(true);
const saldos = { real: s0.saldo, treino: s0.saldoTreino || 0 };
// Valendo (saldo real) ou Treino (depósito simulado): começa no treino se só tiver saldo de treino
let carteira = saldos.real < 100 && saldos.treino >= 50 ? 'treino' : 'real';
const minimo = () => (carteira === 'treino' ? 50 : 100);
function mostrarSaldo() {
  const saldo = saldos[carteira];
  $('saldo').textContent = arena.moedas(saldo);
  $('rotulo-saldo').textContent = carteira === 'treino' ? 'Saldo de treino' : 'Seu saldo';
  $('nota-carteira').hidden = carteira !== 'treino';
  $('ir-carteira').hidden = saldo >= minimo();
  $('ir-carteira').textContent = carteira === 'treino' ? 'Simular depósito na carteira' : 'Depositar moedas na carteira';
  document.querySelectorAll('[data-carteira]').forEach(b => { b.classList.toggle('selected', b.dataset.carteira === carteira); b.setAttribute('aria-selected', b.dataset.carteira === carteira); });
  atualizarSaldoTopo(saldos.real);
}
document.querySelectorAll('[data-carteira]').forEach(b => b.addEventListener('click', () => { carteira = b.dataset.carteira; erro.textContent = ''; mostrarSaldo(); }));
mostrarSaldo();

const hist = await arena.historicoPartidas();
input.value = arena.moedas(hist[0] ? hist[0].entrada : 1000); // último valor usado (ou 10)
// sugestão acima do saldo da carteira escolhida: sugere o que dá para jogar
const ajustarSugestao = () => { const sd = saldos[carteira]; if (sd >= minimo() && arena.paraCentavos(input.value) > sd) input.value = arena.moedas(sd); };
ajustarSugestao();
document.querySelectorAll('[data-carteira]').forEach(b => b.addEventListener('click', ajustarSugestao));

$('rapidos').addEventListener('click', e => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  input.value = arena.moedas(Number(b.dataset.v) * 100);
  erro.textContent = '';
});
input.addEventListener('input', () => { erro.textContent = ''; });

$('form-entrada').addEventListener('submit', e => {
  e.preventDefault();
  const entrada = arena.paraCentavos(input.value);
  const saldo = saldos[carteira];
  if (!(entrada >= minimo())) { erro.textContent = carteira === 'treino' ? 'A entrada mínima no treino é 0,50 moeda.' : 'A entrada mínima é 1 moeda.'; input.focus(); return; }
  if (entrada > saldo) { erro.textContent = `Saldo${carteira === 'treino' ? ' de treino' : ''} insuficiente: você tem ✦ ${arena.moedas(saldo)}.`; $('ir-carteira').hidden = false; input.focus(); return; }
  ocupado($('jogar'), async () => {
    try {
      await arena.iniciarPartida(entrada, carteira);
      location.href = '../jogar/';
    } catch (err) { erro.textContent = err.message; }
  });
});

$('historico').innerHTML = hist.length
  ? hist.slice(0, 10).map(p => `<li><span>${p.carteira === 'treino' ? 'Treino · ' : ''}Entrada ✦ ${arena.moedas(p.entrada)} · ${p.frutas} ${p.frutas === 1 ? 'fruta' : 'frutas'}<small>${quando(p.encerrada)}</small></span>${p.analise === 'pendente' ? '<b>em análise</b>' : comSinal(p.resultado)}</li>`).join('')
  : '<li class="vazio">Nenhuma partida ainda. Escolha um valor e clique em Jogar.</li>';
