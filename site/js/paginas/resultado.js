// Resultado: resumo da última partida encerrada (do servidor) e o saldo já atualizado.
import * as arena from '../arena.js';
import { cabecalho, quando, ocupado } from './comum.js';

await arena.exigirLogin('../');
await arena.resolverPartidaPendente().catch(() => null);
await cabecalho({});

const { partida: r, saldo } = await arena.ultimoResultado();
if (!r) location.replace('../lobby/');
else mostrar(r);

function mostrar(r) {
  const $ = id => document.getElementById(id);
  $('quando').textContent = `Partida de ${quando(r.encerrada)}`;
  $('r-entrada').textContent = arena.moedas(r.entrada);
  $('r-frutas').textContent = `${r.frutas} × ✦ ${arena.moedas(r.porFruta)}`;
  $('r-recebido').textContent = arena.moedas(r.recebido);
  $('r-distancia').textContent = `${Math.floor(r.distancia / 100).toLocaleString('pt-BR')} m`;
  $('r-saldo-final').className = 'saldo-final ' + (r.resultado > 0 ? 'gain' : r.resultado < 0 ? 'loss' : 'even');
  $('r-rotulo').textContent = r.resultado > 0 ? 'Lucro' : r.resultado < 0 ? 'Prejuízo' : 'Empate';
  $('r-diferenca').textContent = `${r.resultado > 0 ? '+ ' : r.resultado < 0 ? '− ' : ''}✦ ${arena.moedas(Math.abs(r.resultado))}`;
  $('r-carteira').textContent = arena.moedas(saldo);
  // o servidor refaz a corrida com os comandos gravados e paga as frutas que ele confirma
  const v = $('r-verificacao');
  const TEXTO = {
    confirmada: '✓ Corrida conferida pelo servidor: ele refez a corrida com os seus comandos e confirmou as frutas.',
    refeita: '✓ A página fechou antes do fim: o servidor refez a corrida com os comandos que recebeu até ali.',
    divergente: `O servidor refez a corrida e confirmou ${r.frutas} ${r.frutas === 1 ? 'fruta' : 'frutas'}` +
      (r.frutasInformadas != null ? ` (o jogo mostrou ${r.frutasInformadas}).` : '.') + ' Vale o resultado do servidor.',
    erro: 'Não foi possível conferir esta corrida; nenhuma fruta foi paga. Fale com o suporte.',
  };
  if (TEXTO[r.verificacao]) { v.textContent = TEXTO[r.verificacao]; v.hidden = false; }
  // pagamento alto ou com sinais de robô: fica em análise e só entra na carteira se o operador aprovar
  if (r.analise === 'pendente') {
    $('r-recebido').textContent = `${arena.moedas(0)} (em análise: ✦ ${arena.moedas(r.aPagar)})`;
    v.textContent = `Pagamento em análise: as ✦ ${arena.moedas(r.aPagar)} desta corrida entram na sua carteira depois da conferência da equipe.`;
    v.hidden = false;
  }

  // Jogar de novo com a mesma entrada (se houver saldo)
  const deNovo = $('de-novo');
  deNovo.innerHTML = `JOGAR DE NOVO · ✦ ${arena.moedas(r.entrada)} <b>➜</b>`;
  deNovo.addEventListener('click', () => ocupado(deNovo, async () => {
    try { await arena.iniciarPartida(r.entrada); location.href = '../jogar/'; }
    catch (err) { $('erro').textContent = err.message === 'Saldo insuficiente para essa entrada.' ? 'Saldo insuficiente para repetir essa entrada. Deposite na carteira ou escolha outro valor no lobby.' : err.message; }
  }));
}
