// Entrar: login, criar conta (com data de nascimento e confirmação de 18+; só entra depois de confirmar
// o e-mail) ou recuperar senha.
import * as arena from '../arena.js';
import { ocupado } from './comum.js';

if ((await arena.sessao()).usuario) location.replace('lobby/');

const $ = id => document.getElementById(id);
const erro = $('erro'), aviso = $('aviso');
let modo = 'entrar';

const TEXTOS = {
  entrar: ['Entre na arena.', 'Seu lugar na largada está reservado.', 'ENTRAR NO LOBBY <b>➜</b>'],
  criar: ['Crie sua conta.', 'Escolha seu nome e venha para a disputa.', 'CRIAR CONTA <b>➜</b>'],
  recuperar: ['Recuperar senha.', 'Informe o e-mail da sua conta. Vamos enviar um link para criar uma nova senha.', 'ENVIAR LINK <b>➜</b>'],
  codigo: ['Verificação em duas etapas.', 'Abra o app autenticador no celular e digite o código de 6 dígitos do Crash Arena.', 'CONFIRMAR <b>✓</b>'],
};
let desafio = null; // login com senha certa, esperando o código do app
function trocarModo(m) {
  modo = m;
  document.querySelectorAll('[data-modo]').forEach(b => {
    const on = b.dataset.modo === m;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-selected', on);
  });
  $('abas').hidden = m === 'recuperar' || m === 'codigo';
  document.querySelectorAll('[data-so]').forEach(el => { el.hidden = !el.dataset.so.split(' ').includes(m); });
  const [t, s, b] = TEXTOS[m];
  $('titulo').textContent = t; $('subtitulo').textContent = s; $('enviar').innerHTML = b;
  $('senha').autocomplete = m === 'criar' ? 'new-password' : 'current-password';
  erro.textContent = ''; aviso.hidden = true; $('reenviar').hidden = true;
}
const avisar = t => { aviso.textContent = t; aviso.hidden = false; };
document.querySelectorAll('[data-modo]').forEach(b => b.addEventListener('click', () => trocarModo(b.dataset.modo)));
$('esqueci').addEventListener('click', () => trocarModo('recuperar'));
$('voltar-login').addEventListener('click', () => trocarModo('entrar'));

document.querySelector('.eye').addEventListener('click', e => {
  const i = $('senha');
  i.type = i.type === 'password' ? 'text' : 'password';
  e.currentTarget.setAttribute('aria-label', i.type === 'password' ? 'Mostrar senha' : 'Ocultar senha');
});

const falhar = (msg, campo) => { erro.textContent = msg; if (campo) $(campo).focus(); };

$('auth').addEventListener('submit', e => {
  e.preventDefault();
  erro.textContent = '';
  const email = $('email').value.trim(), senha = $('senha').value;
  if (modo === 'codigo') {
    const codigo = $('codigo').value.trim();
    if (!codigo) return falhar('Digite o código do app.', 'codigo');
    return ocupado($('enviar'), async () => {
      try { const r = await arena.entrarComCodigo(desafio, codigo); location.href = r.usuario?.operador ? 'admin/configuracoes/' : 'lobby/'; }
      catch (err) {
        falhar(err.message, 'codigo');
        if (/acabou|Entre de novo/.test(err.message)) { desafio = null; $('codigo').value = ''; trocarModo('entrar'); falhar(err.message); }
      }
    });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) return falhar('Informe um e-mail válido.', 'email');
  ocupado($('enviar'), async () => {
    try {
      if (modo === 'recuperar') {
        const r = await arena.recuperarSenha(email);
        aviso.textContent = r.mensagem; aviso.hidden = false;
        return;
      }
      if (senha.length < 8) return falhar('A senha precisa ter pelo menos 8 caracteres.', 'senha');
      if (modo === 'criar') {
        if (!$('nome').value.trim()) return falhar('Escolha um nome de jogador.', 'nome');
        if ($('confirmar').value !== senha) return falhar('As senhas precisam ser iguais.', 'confirmar');
        if (!$('nascimento').value) return falhar('Informe sua data de nascimento.', 'nascimento');
        if (!$('maior18').checked) return falhar('Confirme que você tem 18 anos ou mais.', 'maior18');
        await arena.cadastrar({ nome: $('nome').value, email, senha, nascimento: $('nascimento').value });
        // a conta só entra depois de confirmar o e-mail
        trocarModo('entrar');
        $('email').value = email; $('senha').value = '';
        avisar(`Conta criada! Enviamos um link de confirmação para ${email}. Abra o e-mail (veja também o spam) e clique no link para entrar.`);
        return;
      } else {
        let r;
        try { r = await arena.entrar({ email, senha }); }
        catch (err) {
          if (err.codigo !== 'confirmar_email') throw err;
          avisar(err.message);
          $('reenviar').hidden = false;
          return;
        }
        if (r.precisa2fa) { // conta com app autenticador: falta o código
          desafio = r.desafio;
          $('senha').value = '';
          trocarModo('codigo');
          $('codigo').focus();
          return;
        }
        if (r.usuario?.operador) { location.href = 'admin/configuracoes/'; return; }
      }
      location.href = 'lobby/';
    } catch (err) { falhar(err.message); }
  });
});

$('reenviar').addEventListener('click', e => ocupado(e.currentTarget, async () => {
  erro.textContent = '';
  try { const r = await arena.reenviarConfirmacao($('email').value.trim(), $('senha').value); avisar(r.mensagem); $('reenviar').hidden = true; }
  catch (err) { falhar(err.message); }
}));
