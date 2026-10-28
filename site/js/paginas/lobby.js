// Lobby do modo Solo: escolhe o valor de entrada; o servidor cria a partida (desconta a entrada) e o jogo abre.
import * as arena from '../arena.js';
import { cabecalho, atualizarSaldoTopo, toast, quando, comSinal, ocupado } from './comum.js';

await arena.exigirLogin('../');
// partida que ficou aberta (página do jogo fechada): o servidor estorna ou encerra antes do lobby
const pendente = await arena.resolverPartidaPendente().catch(() => null);
await cabecalho({ ativo: 'lobby' });
if (pendente) toast(`A partida anterior foi encerrada com ${pendente.frutas} frutas.`);

const $ = id => document.getElementById(id);
const input = $('entrada'), erro = $('erro');

let saldo = (await arena.sessao(true)).saldo;
function mostrarSaldo() {
  $('saldo').textContent = arena.moedas(saldo);
  $('ir-carteira').hidden = saldo >= 100;
  atualizarSaldoTopo(saldo);
}
mostrarSaldo();

const hist = await arena.historicoPartidas();
input.value = arena.moedas(hist[0] ? hist[0].entrada : 1000); // último valor usado (ou 10)

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
  if (!(entrada >= 100)) { erro.textContent = 'A entrada mínima é 1 moeda.'; input.focus(); return; }
  if (entrada > saldo) { erro.textContent = `Saldo insuficiente: você tem ✦ ${arena.moedas(saldo)}.`; $('ir-carteira').hidden = false; input.focus(); return; }
  ocupado($('jogar'), async () => {
    try {
      await arena.iniciarPartida(entrada);
      location.href = '../jogar/';
    } catch (err) { erro.textContent = err.message; }
  });
});

$('historico').innerHTML = hist.length
  ? hist.slice(0, 10).map(p => `<li><span>Entrada ✦ ${arena.moedas(p.entrada)} · ${p.frutas} ${p.frutas === 1 ? 'fruta' : 'frutas'}<small>${quando(p.encerrada)}</small></span>${p.analise === 'pendente' ? '<b>em análise</b>' : comSinal(p.resultado)}</li>`).join('')
  : '<li class="vazio">Nenhuma partida ainda. Escolha um valor e clique em Jogar.</li>';
