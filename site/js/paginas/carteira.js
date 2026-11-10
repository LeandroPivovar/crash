// Carteira: saldo, depósito por Pix (valores fixos e promoções de 1ª vez), saque por Pix (CPF ou telefone,
// aprovado pela equipe) e o histórico de movimentos. Tudo decidido no servidor.
import * as arena from '../arena.js';
import { cabecalho, atualizarSaldoTopo, toast, quando, comSinal, esc, ocupado } from './comum.js';

const u = await arena.exigirLogin('../');
await arena.resolverPartidaPendente().catch(() => null);
await cabecalho({ ativo: 'carteira' });

const $ = id => document.getElementById(id);
const brl = c => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(c / 100);
const real = c => `R$ ${(c / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`;
let acao = 'deposito', chaveTipo = 'cpf', valorDeposito = null, pendente = null, carteira = null;
let consulta = null; // timer da tela do Pix esperando pagamento
const erro = $('erro');

const NOMES = { deposito: 'Depósito', saque: 'Saque', entrada: 'Entrada', premio: 'Frutas', estorno: 'Estorno' };
const ESTADO_SAQUE = { pendente: 'Aguardando aprovação', processando: 'Enviando Pix…', aprovado: 'Pago', recusado: 'Recusado · valor devolvido', falhou: 'Não concluído · valor devolvido' };
const promoDe = v => carteira?.promocoes?.find(p => p.deposito === v) || null;

async function render() {
  carteira = await arena.carteira();
  const c = carteira;
  $('saldo').textContent = arena.moedas(c.saldo);
  atualizarSaldoTopo(c.saldo);
  // valores de depósito, com o selo das promoções que a conta ainda pode usar
  $('valores').innerHTML = c.valoresDeposito.map(v => {
    const p = promoDe(v);
    return `<button type="button" data-v="${v}" class="${p ? 'bonus' : ''} ${v === valorDeposito ? 'selected' : ''}">${real(v)}${p ? `<em>FICA COM ${real(p.total)}</em>` : ''}</button>`;
  }).join('');
  $('promos').innerHTML = c.promocoes.map(p => `<p class="bonus-aviso">🎁 <b>Promoção:</b> deposite ${real(p.deposito)} e fique com ${real(p.total)} em moedas. Vale 1 vez por conta.</p>`).join('');
  $('nota-pix').textContent = c.pixReal ? 'Pagamento por Pix: o saldo entra assim que o banco confirmar.' : 'Modo de teste: o depósito entra na hora, sem dinheiro de verdade.';
  // regra do saque: jogar antes o que entrou por depósito
  const r = c.rodada;
  $('rodada').hidden = !(r.depositado > 0);
  $('rodada').className = 'rodada' + (r.falta > 0 ? ' falta' : ' ok');
  $('rodada').innerHTML = r.falta > 0
    ? `🔒 Para sacar, jogue antes o valor que entrou na carteira: faltam <b>${real(r.falta)}</b> em partidas (jogado ${real(r.jogado)} de ${real(r.depositado)}).`
    : '✓ Saque liberado: você já jogou o valor depositado.';
  $('movimentos').innerHTML = c.movimentos.length
    ? c.movimentos.map(m => `<li><span>${m.carteira === 'treino' ? '🎮 ' : ''}${NOMES[m.tipo] || esc(m.tipo)}<small>${esc(m.descricao)} · ${quando(m.quando)}</small></span>${comSinal(m.valor)}</li>`).join('')
    : '<li class="vazio">Nenhum movimento ainda.</li>';
  const saques = c.saques || [];
  $('saques-box').hidden = !saques.length;
  $('saques').innerHTML = saques.map(s => `<li><span>${ESTADO_SAQUE[s.estado] || esc(s.estado)}<small>Pix ${s.chaveTipo === 'telefone' ? 'telefone' : s.chaveTipo === 'cpf' ? 'CPF' : ''}${s.chaveFinal ? ` final ${esc(s.chaveFinal)}` : ''} · pedido em ${quando(s.criado)}${s.decidido ? ` · decidido em ${quando(s.decidido)}` : ''}${s.motivo ? ` · ${esc(s.motivo)}` : ''}</small></span><b class="${['recusado', 'falhou'].includes(s.estado) ? '' : 'loss'}">${brl(s.valor)}</b></li>`).join('');
  renderBotoes();
}
function renderBotoes() {
  $('bloco-deposito').hidden = acao !== 'deposito';
  $('bloco-saque').hidden = acao !== 'saque';
  $('enviar').textContent = acao === 'saque' ? 'SOLICITAR SAQUE ↗' : valorDeposito ? `GERAR PIX DE ${real(valorDeposito)} ➜` : 'ESCOLHA O VALOR';
  $('enviar').disabled = acao === 'deposito' ? !valorDeposito : !!(carteira && carteira.rodada.falta > 0);
}

document.querySelectorAll('[data-acao]').forEach(b => b.addEventListener('click', () => {
  acao = b.dataset.acao;
  document.querySelectorAll('[data-acao]').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-selected', x === b); });
  erro.textContent = '';
  renderBotoes();
}));
$('valores').addEventListener('click', e => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  valorDeposito = Number(b.dataset.v);
  document.querySelectorAll('#valores [data-v]').forEach(x => x.classList.toggle('selected', x === b));
  erro.textContent = '';
  renderBotoes();
});
// chave Pix do saque: CPF (11 dígitos) ou celular com DDD; com telefone, pede também o CPF do titular
const mascaraCpf = d => d.slice(0, 11).replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
const mascaraTel = d => d.slice(0, 11).replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
document.querySelectorAll('[data-chave]').forEach(b => b.addEventListener('click', () => {
  chaveTipo = b.dataset.chave;
  document.querySelectorAll('[data-chave]').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-checked', x === b); });
  $('chave').value = '';
  $('chave').placeholder = chaveTipo === 'cpf' ? '000.000.000-00' : '(11) 91234-5678';
  $('chave-icone').textContent = chaveTipo === 'cpf' ? '#' : '☎';
  $('titular').hidden = chaveTipo !== 'telefone';
}));
$('chave').addEventListener('input', e => { const d = e.target.value.replace(/\D/g, ''); e.target.value = chaveTipo === 'cpf' ? mascaraCpf(d) : mascaraTel(d); });
$('documento').addEventListener('input', e => { e.target.value = mascaraCpf(e.target.value.replace(/\D/g, '')); });

$('form').addEventListener('submit', e => {
  e.preventDefault();
  erro.textContent = '';
  if (acao === 'deposito') return ocupado($('enviar'), depositar);
  const v = arena.paraCentavos($('valor').value);
  if (!(v >= 100) || v > arena.LIMITE_MOVIMENTO) { erro.textContent = 'Informe um valor entre R$ 1 e R$ 10.000.'; $('valor').focus(); return; }
  if (u.visitante) { erro.textContent = 'Visitantes não podem sacar. Crie uma conta para sacar.'; return; }
  if (carteira?.rodada.falta > 0) { erro.textContent = `Para sacar, jogue antes mais ${real(carteira.rodada.falta)} em partidas.`; return; }
  const chave = $('chave').value.replace(/\D/g, ''), documento = $('documento').value.replace(/\D/g, '');
  if (chaveTipo === 'cpf' && chave.length !== 11) { erro.textContent = 'Informe o CPF da chave Pix (11 números).'; $('chave').focus(); return; }
  if (chaveTipo === 'telefone' && chave.length !== 11) { erro.textContent = 'Informe o celular com DDD (11 números).'; $('chave').focus(); return; }
  if (chaveTipo === 'telefone' && documento.length !== 11) { erro.textContent = 'Informe o CPF do titular da chave.'; $('documento').focus(); return; }
  pendente = { valor: v, chaveTipo, chave, documento };
  $('saque-valor').textContent = brl(v);
  $('saque-destino').textContent = `Pix ${chaveTipo === 'cpf' ? 'CPF' : 'telefone'} ${$('chave').value}`;
  $('saque-erro').textContent = '';
  $('dlg-saque').showModal();
  $('saque-ok').focus();
});

// ---------- depósito por Pix ----------
function imagemQr(q) {
  if (!q) return '';
  if (/^data:image\//.test(q)) return q;
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(q)) return 'data:image/png;base64,' + q.replace(/\s/g, '');
  return ''; // endereço externo: o site não carrega imagens de fora (fica só o copia e cola)
}
function mostrarPago(d) {
  clearInterval(consulta); consulta = null;
  $('dlg-pix').hidden = true; $('dlg-pago').hidden = false;
  $('dlg-titulo').textContent = 'Depósito confirmado';
  toast(d.bonus ? `Depósito confirmado + bônus de ${brl(d.bonus)}! 🎁` : 'Depósito confirmado!');
  render();
}
async function depositar() {
  const v = valorDeposito;
  try {
    const r = await arena.depositar(v);
    const d = r.deposito, p = promoDe(v);
    $('dlg-valor').textContent = brl(v);
    $('dlg-moedas').textContent = p ? `✦ ${arena.moedas(p.total)} moedas (${real(v)} + ${real(p.bonus)} de bônus)` : `✦ ${arena.moedas(v)} moedas`;
    $('dlg-titulo').textContent = 'Pague com Pix';
    $('dlg-pix').hidden = d.estado !== 'pendente'; $('dlg-pago').hidden = true;
    $('confirmar').showModal();
    if (d.estado === 'pago') { mostrarPago(d); return; }
    const qr = imagemQr(d.pixQr);
    $('dlg-qr').hidden = !qr; if (qr) $('dlg-qr').src = qr;
    $('dlg-copia').value = d.pixCopiaCola || '';
    clearInterval(consulta);
    consulta = setInterval(async () => {
      if (!$('confirmar').open) { clearInterval(consulta); consulta = null; return; }
      try {
        const s = (await arena.consultarDeposito(d.id)).deposito;
        if (s.estado === 'pago') mostrarPago(s);
        else if (s.estado !== 'pendente') { clearInterval(consulta); $('dlg-espera').textContent = 'Este Pix venceu ou falhou. Feche e gere outro.'; }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 5000);
  } catch (err) { erro.textContent = err.message; }
}
$('dlg-copiar').addEventListener('click', async () => {
  const t = $('dlg-copia');
  try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand('copy'); }
  toast('Código Pix copiado. Cole no app do seu banco.');
});
document.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', () => { $('confirmar').close(); render(); }));

// ---------- saque ----------
document.querySelectorAll('[data-fechar-saque]').forEach(b => b.addEventListener('click', () => $('dlg-saque').close()));
$('saque-ok').addEventListener('click', e => ocupado(e.currentTarget, async () => {
  try {
    await arena.sacar(pendente.valor, undefined, pendente);
    pendente = null;
    $('dlg-saque').close();
    $('valor').value = '';
    toast('Saque solicitado! O valor fica reservado até a aprovação da equipe.');
    await render();
  } catch (err) {
    $('saque-erro').textContent = err.message;
  }
}));

await render();
