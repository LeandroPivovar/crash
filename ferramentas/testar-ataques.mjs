// Teste de ataques ao Crash Arena: sobe um servidor descartável (banco temporário) e tenta fraudar a
// plataforma pela API, do jeito que alguém faria com o console do navegador ou um script.
//   node ferramentas/testar-ataques.mjs
// Cada linha mostra o ataque e se foi barrado (OK) ou não (FALHOU). No fim, o total.
import { spawn, execFileSync } from 'child_process';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'module';
const totp = createRequire(import.meta.url)('../servidor/totp.js');

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const porta = 8197, base = `http://localhost:${porta}`;
const dbArq = path.join(os.tmpdir(), `arena-ataques-${Date.now()}.db`);
const OP = { email: 'op@teste.local', senha: 'senha-do-operador-123' };
// (o operador do teste ativa o app autenticador no meio do teste; os códigos são calculados com servidor/totp.js)
const srv = spawn(process.execPath, [path.join(raiz, 'servidor', 'serve.js'), String(porta)], {
  env: { ...process.env, ARENA_DB: dbArq, ARENA_ADMIN_EMAIL: OP.email, ARENA_ADMIN_SENHA: OP.senha, ARENA_CONTAS_POR_HORA: '100', ARENA_LOGINS_POR_IP: '200',
    ARENA_BACKUP_HORAS: '0', ARENA_SITE_URL: 'https://arena.exemplo', ARENA_SMTP_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logSrv = '';
srv.stdout.on('data', d => { logSrv += d; });
srv.stderr.on('data', d => { logSrv += d; });
const dormir = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 100 && !logSrv.includes('Crash Arena em'); i++) await dormir(100);

let ok = 0, falhou = 0;
const conferir = (nome, cond, extra = '') => { cond ? ok++ : falhou++; console.log(`${cond ? 'OK     ' : 'FALHOU '} ${nome}${extra ? ' — ' + extra : ''}`); };

// cliente com cookie próprio
function cliente(url = base) {
  let cookie = '';
  const c = async (m, rota, corpo, cab = {}) => {
    const h = { ...(m === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Arena': '1' }), ...(cookie ? { cookie } : {}), ...cab };
    const r = await fetch(url + rota, { method: m, headers: h, body: m === 'GET' ? undefined : typeof corpo === 'string' ? corpo : JSON.stringify(corpo || {}), redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j, h: r.headers };
  };
  c.cookie = v => (v === undefined ? cookie : (cookie = v));
  return c;
}
// sem SMTP no teste, os e-mails saem no console do servidor: pega o último link de confirmação de um e-mail
async function linkDoEmail(email, pagina = 'confirmar') {
  for (let i = 0; i < 30; i++) {
    const partes = logSrv.split(`[e-mail para ${email}]`);
    const m = partes.length > 1 && partes[partes.length - 1].match(new RegExp(`/${pagina}/\\?token=([\\w-]+)`));
    if (m) return m[1];
    await dormir(50);
  }
  return null;
}
const novaConta = async (nome = 'Jogador', url = base) => {
  const c = cliente(url);
  const email = `${nome.toLowerCase()}${Date.now()}${Math.random().toString(36).slice(2, 6)}@x.com`;
  const r = await c('POST', '/api/cadastro', { nome, email, senha: 'senha-boa-123', nascimento: '1990-05-05' });
  // com confirmação de e-mail ligada no servidor (ARENA_CONFIRMAR_EMAIL=1), entra pelo link
  if (r.j?.confirmar) await c('POST', '/api/confirmar', { token: await linkDoEmail(email) });
  return c;
};
// robô que joga com a semente da partida (mesma simulação do jogo) e grava os comandos
function jogarComRobo(semente, segundos = 60, nervoso = false) {
  const arq = path.join(os.tmpdir(), `gravacao-${Date.now()}.json`);
  execFileSync(process.execPath, [path.join(raiz, 'ferramentas', 'testar-replay.mjs'), String(semente), String(segundos), arq, ...(nervoso ? ['nervoso'] : [])], { stdio: 'pipe' });
  const g = JSON.parse(fs.readFileSync(arq, 'utf8')); fs.unlinkSync(arq);
  return g;
}
// ativa o app autenticador de um jogador (senha das contas de teste) e devolve o segredo e os códigos de reserva
const codigoDoApp = segredo => totp.codigoNoIntervalo(segredo, Math.floor(Date.now() / 30000));
async function ativar2fa(c) {
  const { segredo } = (await c('POST', '/api/conta/2fa/iniciar', { senha: 'senha-boa-123' })).j;
  const r = (await c('POST', '/api/conta/2fa/confirmar', { codigo: codigoDoApp(segredo) })).j;
  return { segredo, reserva: r.codigosReserva };
}
const passosDe = rle => rle.reduce((a, [, n]) => a + n, 0);
// Atalhos de teste direto no banco (o depósito real agora é só R$ 5/10/25/50 e passa pelo Pix):
// creditar = um depósito já pago; jogou = partidas jogadas que empataram (entrada e frutas do mesmo valor).
const CPF_OK = '52998224725';
const bancoDe = arq => { const d = new DatabaseSync(arq); d.exec('PRAGMA busy_timeout = 5000'); return d; };
const dbTeste = bancoDe(dbArq);
const idDe = async c => (await c('GET', '/api/eu')).j.usuario.id;
async function creditar(c, valor, dbx = dbTeste) {
  dbx.prepare("INSERT INTO movimentos (usuario_id, tipo, valor, descricao, criado) VALUES (?, 'deposito', ?, 'Depósito (teste)', ?)").run(await idDe(c), valor, Date.now());
}
async function jogou(c, valor, dbx = dbTeste) {
  const id = await idDe(c), t = Date.now();
  dbx.prepare("INSERT INTO movimentos (usuario_id, tipo, valor, descricao, criado) VALUES (?, 'premio', ?, 'Frutas (teste)', ?)").run(id, valor, t);
  dbx.prepare("INSERT INTO movimentos (usuario_id, tipo, valor, descricao, criado) VALUES (?, 'entrada', ?, 'Entrada (teste)', ?)").run(id, -valor, t);
}

try {
  console.log('--- pedidos forjados (CSRF) e formato');
  const a = await novaConta('Ana');
  conferir('POST sem o cabeçalho X-Arena', (await a('POST', '/api/carteira/deposito', { valor: 100000 }, { 'X-Arena': '' })).s === 403);
  conferir('POST vindo de outro site (Origin)', (await a('POST', '/api/carteira/deposito', { valor: 100000 }, { Origin: 'https://site-malicioso.com' })).s === 403);
  conferir('POST que não é JSON', (await a('POST', '/api/carteira/deposito', 'valor=100000', { 'Content-Type': 'application/x-www-form-urlencoded' })).s === 415);
  conferir('corpo gigante (20 KB) numa rota comum', (await a('POST', '/api/cadastro', { nome: 'x'.repeat(20000) })).s === 413);
  conferir('JSON que não é objeto', (await a('POST', '/api/carteira/deposito', '[1,2,3]')).s === 400);

  console.log('--- contas e login');
  const v = cliente();
  conferir('cadastro de menor de 18', (await v('POST', '/api/cadastro', { nome: 'Kid', email: `kid${Date.now()}@x.com`, senha: 'senha-boa-123', nascimento: '2015-01-01' })).s === 403);
  conferir('senha fraca', (await v('POST', '/api/cadastro', { nome: 'Fraco', email: `fr${Date.now()}@x.com`, senha: 'aaaaaaaa', nascimento: '1990-01-01' })).s === 400);
  const emailNovo = `novo${Date.now()}@x.com`, novo = cliente();
  const dadosNovo = { nome: 'Novo', email: emailNovo, senha: 'senha-boa-123' };
  conferir('cadastro sem data exige confirmação de 18+', (await novo('POST', '/api/cadastro', dadosNovo)).s === 400);
  const cad = await novo('POST', '/api/cadastro', { ...dadosNovo, maior18: true });
  // confirmação de e-mail desligada (padrão): o cadastro já entra; os links de confirmação inventados continuam inválidos
  conferir('cadastro entra direto (sem confirmação de e-mail)', !cad.j?.confirmar && (await novo('GET', '/api/eu')).j.usuario?.email === emailNovo);
  conferir('link de confirmação inventado', (await novo('POST', '/api/confirmar', { token: 'A'.repeat(43) })).s === 400);
  conferir('criar conta anônima direto pela API (sem o botão de visitante)', (await cliente()('POST', '/api/visitante', { maior18: true })).s === 404);
  conferir('cookie de sessão inventado', (await cliente()('GET', '/api/eu', undefined, { cookie: 'arena_sessao=' + 'A'.repeat(43) })).j.usuario === null);
  const alvo = await novaConta('Alvo'); const emailAlvo = (await alvo('GET', '/api/eu')).j.usuario.email;
  const atac = cliente();
  let ultimo = 0;
  for (let i = 0; i < 12; i++) ultimo = (await atac('POST', '/api/login', { email: emailAlvo, senha: 'chute' + i })).s;
  conferir('força bruta na senha de uma conta (12 tentativas)', ultimo === 429, `última resposta ${ultimo}`);
  const tempo = async email => { const t = performance.now(); await cliente()('POST', '/api/login', { email, senha: 'x-errada-123' }); return performance.now() - t; };
  // alternando as duas medidas e usando a mediana: um pico de carga da máquina não decide o resultado
  const outro = await novaConta('Tempo'); const emailT = (await outro('GET', '/api/eu')).j.usuario.email;
  const tExiste = [], tNao = [];
  for (let i = 0; i < 8; i++) { tNao.push(await tempo(`naoexiste${i}${Date.now()}@x.com`)); tExiste.push(await tempo(emailT)); }
  const mediana = l => [...l].sort((a, b) => a - b)[l.length >> 1];
  conferir('tempo do login não revela se o e-mail existe', Math.abs(mediana(tExiste) - mediana(tNao)) < 40, `${Math.round(mediana(tExiste))} ms × ${Math.round(mediana(tNao))} ms`);
  // ladrão com a senha do jogador: com o app ativo, a senha sozinha não abre a sessão
  const vit = await novaConta('Vitima'); const emailVit = (await vit('GET', '/api/eu')).j.usuario.email;
  const appV = await ativar2fa(vit);
  const ladrao = cliente(); const lp = (await ladrao('POST', '/api/login', { email: emailVit, senha: 'senha-boa-123' })).j;
  conferir('senha certa de jogador com app não abre sessão sozinha', lp.precisa2fa === true && (await ladrao('GET', '/api/eu')).j.usuario === null);
  conferir('desligar o app sem o código', (await vit('POST', '/api/conta/2fa/desativar', { senha: 'senha-boa-123', codigo: '' })).s === 401);
  conferir('desligar o app com código mas sem a senha', (await vit('POST', '/api/conta/2fa/desativar', { senha: 'x', codigo: appV.reserva[0] })).s === 401);
  // link de recuperação: o endereço vem de ARENA_SITE_URL, não do cabeçalho Host (que um atacante pode forjar)
  await new Promise(ok => { const r = http.request({ host: 'localhost', port: porta, path: '/api/recuperar', method: 'POST',
    headers: { Host: 'site-do-ladrao.com', 'Content-Type': 'application/json', 'X-Arena': '1' } }, res => { res.resume(); res.on('end', ok); }); r.end(JSON.stringify({ email: emailVit })); });
  await dormir(300);
  const linkRec = (logSrv.match(/https?:\/\/\S+\/redefinir\/\?token=\S+/g) || []).pop() || '';
  conferir('link de recuperação ignora Host forjado', linkRec.startsWith('https://arena.exemplo/redefinir/') && !logSrv.includes('site-do-ladrao'), linkRec.slice(0, 45) + '…');
  conferir('trocar e-mail sem a senha atual', (await a('PATCH', '/api/eu', { nome: 'Ana', email: `roubado${Date.now()}@x.com` })).s === 401);

  console.log('--- dinheiro');
  const a0 = await novaConta('Validacao');
  conferir('depósito com valor em texto', (await a0('POST', '/api/carteira/deposito', { valor: '5000' })).s === 400);
  conferir('depósito quebrado (0,5 centavo)', (await a0('POST', '/api/carteira/deposito', { valor: 10.5 })).s === 400);
  conferir('depósito negativo', (await a0('POST', '/api/carteira/deposito', { valor: -100000 })).s === 400);
  conferir('depósito acima do limite', (await a0('POST', '/api/carteira/deposito', { valor: 1e12 })).s === 400);
  conferir('depósito fora dos valores (R$ 20)', (await a0('POST', '/api/carteira/deposito', { valor: 2000 })).s === 400);
  await a('POST', '/api/carteira/deposito', { valor: 5000 });
  const PIX = { chaveTipo: 'cpf', chave: CPF_OK };
  conferir('ativar o app do jogador exige a senha', (await a('POST', '/api/conta/2fa/iniciar', { senha: 'errada-errada' })).s === 401);
  const semJogar = await a('POST', '/api/carteira/saque', { valor: 1000, ...PIX });
  conferir('saque bloqueado antes de jogar o valor depositado', semJogar.s === 403 && semJogar.j.codigo === 'rodada' && (await a('GET', '/api/carteira')).j.rodada.falta === 5000);
  await jogou(a, 4000);
  conferir('jogou só parte: continua bloqueado', (await a('POST', '/api/carteira/saque', { valor: 1000, ...PIX })).j?.codigo === 'rodada');
  await jogou(a, 1000);
  conferir('chave Pix: CPF inválido', (await a('POST', '/api/carteira/saque', { valor: 1000, chaveTipo: 'cpf', chave: '12345678900' })).s === 400);
  conferir('chave Pix: telefone sem CPF do titular', (await a('POST', '/api/carteira/saque', { valor: 1000, chaveTipo: 'telefone', chave: '11912345678' })).s === 400);
  conferir('chave Pix: tipo desconhecido (e-mail)', (await a('POST', '/api/carteira/saque', { valor: 1000, chaveTipo: 'email', chave: 'x@x.com' })).s === 400);
  conferir('saque maior que o saldo', (await a('POST', '/api/carteira/saque', { valor: 6000, ...PIX })).s === 400);
  const tentativas = await Promise.all(Array.from({ length: 6 }, (_, k) => a('POST', '/api/carteira/saque', { valor: 1000, ...(k % 2 ? { chaveTipo: 'telefone', chave: '(11) 91234-5678', documento: CPF_OK } : PIX) })));
  const saldoA = (await a('GET', '/api/eu')).j.saldo;
  conferir('6 saques sem 2FA de 10 ao mesmo tempo com saldo 50', saldoA === 0 && tentativas.filter(r => r.s === 200).length === 5, `saldo final ${saldoA}`);
  await creditar(a, 3000);
  const duplas = await Promise.all(Array.from({ length: 5 }, () => a('POST', '/api/partidas', { entrada: 3000 })));
  const saldoB = (await a('GET', '/api/eu')).j.saldo;
  conferir('5 partidas ao mesmo tempo com saldo para 1', saldoB === 0 && duplas.filter(r => r.s === 200).length >= 1, `saldo ${saldoB}`);
  await a('POST', '/api/partida/resolver');

  console.log('--- partida de outra pessoa');
  const b = await novaConta('Bia'); await b('POST', '/api/carteira/deposito', { valor: 5000 });
  const pb = (await b('POST', '/api/partidas', { entrada: 1000 })).j.partida;
  conferir('encerrar a partida de outro jogador', (await a('POST', `/api/partidas/${pb.id}/encerrar`, { rle: [], frutas: 99 })).s === 404);
  conferir('id de partida malformado', (await a('POST', `/api/partidas/p_'%20OR%201=1/encerrar`, { rle: [] })).s === 404);
  conferir('entrada maior que o saldo', (await b('POST', '/api/partidas', { entrada: 999999 })).s === 400);
  await b('POST', `/api/partidas/${pb.id}/cancelar`);

  console.log('--- gravação da corrida');
  const pc = (await b('POST', '/api/partidas', { entrada: 1000 })).j.partida;
  await b('POST', `/api/partidas/${pc.id}/comecar`);
  conferir('código de desvio que o jogo não gera (x > 1)', (await b('POST', `/api/partidas/${pc.id}/progresso`, { desde: 0, rle: [[31, 10]] })).s === 400);
  conferir('giro (saiu do jogo) mandado pela API', (await b('POST', `/api/partidas/${pc.id}/progresso`, { desde: 0, rle: [[8 | 128, 10]] })).s === 400);
  conferir('gravação adiantada (10 min de comandos em 1 s)', (await b('POST', `/api/partidas/${pc.id}/progresso`, { desde: 0, rle: [[8, 36000]] })).s === 400);
  await b('POST', `/api/partidas/${pc.id}/progresso`, { desde: 0, rle: [[8, 30], [9, 5]] });
  const reescrita = await b('POST', `/api/partidas/${pc.id}/progresso`, { desde: 0, rle: [[16, 30]] });
  conferir('reescrever o começo da gravação', reescrita.j && reescrita.j.ok === false);
  const encolher = await b('POST', `/api/partidas/${pc.id}/progresso`, { desde: 1, rle: [[9, 2]] });
  conferir('diminuir o último trecho já enviado', encolher.j && encolher.j.ok === false);
  const fimC = (await b('POST', `/api/partidas/${pc.id}/encerrar`, { rle: [[0, 10]], frutas: 500 })).j.partida;
  conferir('encerrar com gravação diferente da enviada + dizer 500 frutas', fimC.frutas === 0 && fimC.recebido === 0, `pagou ${fimC.recebido}, frutas ${fimC.frutas}`);

  console.log('--- corridas de verdade (robô jogando em tempo real)');
  const op = cliente();
  conferir('jogador comum chamando rota de operador', (await b('PUT', '/api/admin/regras', { regras: { fruitPercent: 1000 } })).s === 403);
  console.log('--- operador: verificação em duas etapas');
  await op('POST', '/api/login', OP);
  const semApp = await op('PUT', '/api/admin/regras', { regras: {} });
  conferir('operador sem app autenticador não muda regras', semApp.s === 403 && semApp.j.codigo === 'configurar_2fa');
  conferir('ativar o app exige a senha', (await op('POST', '/api/admin/2fa/iniciar', { senha: 'errada-errada' })).s === 401);
  // quem só sabe a senha não cadastra o próprio celular: falta o código que fica no servidor
  const semCodigo = await op('POST', '/api/admin/2fa/iniciar', { senha: OP.senha });
  conferir('senha certa do operador sem o código de ativação do servidor', semCodigo.s === 403 && semCodigo.j.codigo === 'codigo_ativacao');
  conferir('código de ativação chutado', (await op('POST', '/api/admin/2fa/iniciar', { senha: OP.senha, codigoAtivacao: 'ABCDEF123456' })).s === 403);
  const arqAtivacao = path.join(path.dirname(dbArq), 'codigo-ativacao-operador.txt');
  const codigoAtivacao = fs.readFileSync(arqAtivacao, 'utf8').trim();
  const { segredo } = (await op('POST', '/api/admin/2fa/iniciar', { senha: OP.senha, codigoAtivacao })).j;
  conferir('código errado não ativa o app', (await op('POST', '/api/admin/2fa/confirmar', { codigo: '000000' })).s === 400 || totp.codigoNoIntervalo(segredo, Math.floor(Date.now() / 30000)) === '000000');
  const ativado = (await op('POST', '/api/admin/2fa/confirmar', { codigo: totp.codigoNoIntervalo(segredo, Math.floor(Date.now() / 30000)) })).j;
  const reserva = ativado.codigosReserva;
  conferir('app ativado com 8 códigos de reserva', ativado.ok === true && reserva.length === 8);
  await op('POST', '/api/sair');
  const passo1 = (await op('POST', '/api/login', OP)).j;
  conferir('senha certa do operador não abre sessão sozinha', passo1.precisa2fa === true && !passo1.usuario && (await op('GET', '/api/eu')).j.usuario === null);
  conferir('código errado no login', (await op('POST', '/api/login/2fa', { desafio: passo1.desafio, codigo: '123456' })).s === 401
    || totp.codigoNoIntervalo(segredo, Math.floor(Date.now() / 30000)) === '123456');
  // espera virar o intervalo de 30 s, para o código da ativação não ser reaproveitado aqui
  while (Math.floor(Date.now() / 30000) === Math.floor((Date.now() - 1000) / 30000) && Date.now() % 30000 > 2000) await dormir(500);
  await dormir(1500);
  const codigoAgora = totp.codigoNoIntervalo(segredo, Math.floor(Date.now() / 30000));
  conferir('código certo abre a sessão de operador', (await op('POST', '/api/login/2fa', { desafio: passo1.desafio, codigo: codigoAgora })).s === 200);
  const opOutro = cliente();
  const d2 = (await opOutro('POST', '/api/login', OP)).j.desafio;
  conferir('o mesmo código não vale duas vezes', (await opOutro('POST', '/api/login/2fa', { desafio: d2, codigo: codigoAgora })).s === 401);
  conferir('código de reserva entra uma vez', (await opOutro('POST', '/api/login/2fa', { desafio: d2, codigo: reserva[0] })).s === 200);
  const terceiro = cliente(); const d3 = (await terceiro('POST', '/api/login', OP)).j.desafio;
  conferir('código de reserva usado não vale de novo', (await terceiro('POST', '/api/login/2fa', { desafio: d3, codigo: reserva[0] })).s === 401);
  const c = await novaConta('Caio'); await creditar(c, 100000);
  // honesta: tenta sementes até o robô pegar frutas
  let pd, g;
  for (let k = 0; k < 6; k++) {
    pd = (await c('POST', '/api/partidas', { entrada: 2000 })).j.partida;
    g = jogarComRobo(pd.semente, 40);
    if (g.frutas > 0) break;
    await c('POST', `/api/partidas/${pd.id}/cancelar`);
  }
  await c('POST', `/api/partidas/${pd.id}/comecar`);
  // manda a gravação aos poucos, no ritmo do tempo real, como o jogo
  const total = passosDe(g.rle); let enviados = 0, desde = 0, parcial = [];
  const t0 = Date.now();
  while (enviados < total) {
    await dormir(1000);
    const pode = Math.floor((Date.now() - t0) / 1000 * 60);
    parcial = []; let soma = 0;
    for (const [cc, n] of g.rle) { if (soma >= pode) break; const k = Math.min(n, pode - soma); parcial.push([cc, k]); soma += k; }
    const r = await c('POST', `/api/partidas/${pd.id}/progresso`, { desde, rle: parcial.slice(desde), frutas: 0 });
    if (r.j && Number.isInteger(r.j.pares)) desde = Math.max(0, r.j.pares - 1);
    enviados = soma;
  }
  const fimD = (await c('POST', `/api/partidas/${pd.id}/encerrar`, { rle: g.rle, frutas: g.frutas })).j.partida;
  conferir('corrida honesta é paga pelo que o servidor refez', fimD.verificacao === 'confirmada' && fimD.frutas === g.frutas && fimD.recebido === g.frutas * fimD.porFruta,
    `${g.frutas} frutas, recebeu ${fimD.recebido}, verificação ${fimD.verificacao}, análise ${fimD.analise}`);

  // regras com campos a mais e valores fora da faixa: o servidor só guarda os campos conhecidos, dentro dos limites
  const injetadas = (await op('PUT', '/api/admin/regras', { regras: { dificuldade: 999, operador: 1, saldo: 1e9, fruitPercent: -5, enemiesPerChunk: 500, speedMax: 'x' } })).j.regras;
  conferir('regras com campos a mais e valores absurdos', injetadas.dificuldade === 100 && !('operador' in injetadas) && !('saldo' in injetadas) && injetadas.fruitPercent >= 0.01 && injetadas.enemiesPerChunk <= 8,
    `dificuldade ${injetadas.dificuldade}, inimigos ${injetadas.enemiesPerChunk}, fruta ${injetadas.fruitPercent}%`);
  conferir('código de ativação some depois de ativar', !fs.existsSync(arqAtivacao));

  console.log('--- promoções de depósito (R$ 5 → R$ 15 e R$ 25 → R$ 100, 1 vez cada por conta)');
  const bo = await novaConta('Bonus');
  const promos0 = (await bo('GET', '/api/carteira')).j.promocoes;
  conferir('conta nova vê as duas promoções', promos0.length === 2 && promos0.find(p => p.deposito === 500)?.total === 1500 && promos0.find(p => p.deposito === 2500)?.total === 10000);
  const d10 = (await bo('POST', '/api/carteira/deposito', { valor: 1000 })).j;
  conferir('depósito de R$ 10 não ganha bônus', d10.bonus === 0 && d10.saldo === 1000);
  const d5 = (await bo('POST', '/api/carteira/deposito', { valor: 500 })).j;
  conferir('depósito de R$ 5 fica com R$ 15', d5.bonus === 1000 && d5.saldo === 1000 + 1500, `saldo ${d5.saldo}`);
  const d5b = (await bo('POST', '/api/carteira/deposito', { valor: 500 })).j;
  conferir('segundo depósito de R$ 5 não ganha de novo', d5b.bonus === 0 && d5b.saldo === 3000);
  const promos1 = (await bo('GET', '/api/carteira')).j.promocoes;
  conferir('promoção usada some da carteira', promos1.length === 1 && promos1[0].deposito === 2500);
  const d25 = (await bo('POST', '/api/carteira/deposito', { valor: 2500 })).j;
  conferir('depósito de R$ 25 fica com R$ 100', d25.bonus === 7500 && d25.saldo === 3000 + 10000, `saldo ${d25.saldo}`);
  const d25b = (await bo('POST', '/api/carteira/deposito', { valor: 2500 })).j;
  conferir('segundo depósito de R$ 25 não ganha de novo', d25b.bonus === 0 && d25b.saldo === 15500 && (await bo('GET', '/api/carteira')).j.promocoes.length === 0);
  const rbo = (await bo('GET', '/api/carteira')).j.rodada;
  conferir('para sacar, precisa jogar o depositado com o bônus', rbo.depositado === 15500 && rbo.falta === 15500);
  const bc = await novaConta('BonusCorrida');
  const varios = await Promise.all(Array.from({ length: 8 }, () => bc('POST', '/api/carteira/deposito', { valor: 500 })));
  const ganhos = varios.filter(r => r.j?.bonus === 1000).length;
  conferir('8 depósitos de R$ 5 ao mesmo tempo: só 1 bônus', ganhos === 1 && (await bc('GET', '/api/carteira')).j.saldo === 8 * 500 + 1000, `${ganhos} bônus`);

  console.log('--- treino desativado');
  const tr = await novaConta('Treino');
  conferir('rota de depósito simulado removida', (await tr('POST', '/api/carteira/simular', { valor: 1000 })).s === 404);
  const trId = await idDe(tr);
  dbTeste.prepare("INSERT INTO movimentos (usuario_id, tipo, valor, descricao, criado, carteira) VALUES (?, 'deposito', 1000, 'Depósito antigo de treino', ?, 'treino')").run(trId, Date.now());
  conferir('nova partida de treino é recusada mesmo com saldo antigo', (await tr('POST', '/api/partidas', { entrada: 500, carteira: 'treino' })).s === 400);
  conferir('saldo antigo de treino não financia partida real', (await tr('POST', '/api/partidas', { entrada: 100 })).s === 400);
  const crt = (await tr('GET', '/api/carteira')).j;
  conferir('saldo antigo de treino continua separado', crt.saldo === 0 && crt.saldoTreino === 1000 && crt.rodada.depositado === 0);
  const opTr = (await op('GET', `/api/admin/usuarios/${trId}`)).j.usuario;
  conferir('admin: lucro e saldo contam só dinheiro real', opTr.saldo === 0 && opTr.resultado === 0 && opTr.depositado === 0 && opTr.partidas === 0);

  console.log('--- usuários no admin (suporte)');
  conferir('jogador comum listando usuários', (await bo('GET', '/api/admin/usuarios')).s === 403);
  conferir('jogador comum alterando outro jogador', (await bo('PATCH', '/api/admin/usuarios/1', { novaSenha: 'tomei-sua-conta-1' })).s === 403);
  conferir('sem login listando usuários', (await cliente()('GET', '/api/admin/usuarios')).s === 401);
  const euBo = (await bo('GET', '/api/eu')).j.usuario;
  const achou = (await op('GET', `/api/admin/usuarios?q=${encodeURIComponent(euBo.email)}`)).j;
  conferir('operador busca por e-mail', achou.total === 1 && achou.usuarios[0].id === euBo.id && achou.usuarios[0].saldo === 15500 && achou.usuarios[0].bonus === 8500);
  const curinga = (await op('GET', `/api/admin/usuarios?q=${encodeURIComponent("%' OR 1=1 --")}`)).j;
  conferir('busca com curinga/SQL não lista todo mundo', curinga.total === 0, `${curinga.total} achados`);
  const pag = (await op('GET', '/api/admin/usuarios?por=5&pagina=2&ordem=x;DROP')).j;
  conferir('paginação e ordem inválida', pag.usuarios.length <= 5 && pag.pagina === 2 && pag.total > 5);
  const detBo = (await op('GET', `/api/admin/usuarios/${euBo.id}`)).j;
  conferir('detalhe traz ciclo, resumo e histórico', detBo.ciclo?.proxima === 1 && detBo.usuario.depositado === 7000 && detBo.movimentos.length === 7 && Array.isArray(detBo.partidas)
    && !JSON.stringify(detBo).includes('senha_hash') && !JSON.stringify(detBo).includes('totp_segredo'));
  const idOp = (await op('GET', '/api/eu')).j.usuario.id;
  conferir('operador não altera conta de operador por aqui', (await op('PATCH', `/api/admin/usuarios/${idOp}`, { novaSenha: 'outra-senha-123' })).s === 403);
  const novoEmail = `suporte${Date.now()}@x.com`;
  const alt = await op('PATCH', `/api/admin/usuarios/${euBo.id}`, { email: novoEmail, novaSenha: 'nova-senha-suporte-1' });
  conferir('suporte troca e-mail e senha', alt.s === 200 && alt.j.mudou.includes('email') && alt.j.mudou.includes('senha'));
  conferir('senha nova derruba a sessão do jogador', (await bo('GET', '/api/carteira')).s === 401);
  conferir('jogador entra com a senha nova', (await cliente()('POST', '/api/login', { email: novoEmail, senha: 'nova-senha-suporte-1' })).s === 200);
  conferir('suporte não aceita senha fraca nem e-mail repetido', (await op('PATCH', `/api/admin/usuarios/${euBo.id}`, { novaSenha: '123' })).s === 400
    && (await op('PATCH', `/api/admin/usuarios/${euBo.id}`, { email: (await bc('GET', '/api/eu')).j.usuario.email })).s === 409);

  console.log('--- links de indicação');
  conferir('jogador não cria nem vê links', (await bc('POST', '/api/admin/indicacoes', { nome: 'Eu', porcentagem: 50, tipo: 'saque' })).s === 403
    && (await bc('GET', '/api/admin/indicacoes')).s === 403 && (await cliente()('GET', '/api/admin/indicacoes')).s === 401);
  conferir('link com porcentagem inválida', (await op('POST', '/api/admin/indicacoes', { nome: 'X', porcentagem: 0, tipo: 'saque' })).s === 400
    && (await op('POST', '/api/admin/indicacoes', { nome: 'X', porcentagem: 101, tipo: 'saque' })).s === 400);
  conferir('link com tipo ou código inválido', (await op('POST', '/api/admin/indicacoes', { nome: 'X', porcentagem: 5, tipo: 'deposito' })).s === 400
    && (await op('POST', '/api/admin/indicacoes', { nome: 'X', porcentagem: 5, tipo: 'saque', codigo: "a'; DROP" })).s === 400);
  const codP = `parc${Date.now() % 100000}`;
  const lP = (await op('POST', '/api/admin/indicacoes', { nome: 'Parceiro Perdas', codigo: codP, porcentagem: '10', tipo: 'perdas' })).j.indicacao;
  const lS = (await op('POST', '/api/admin/indicacoes', { nome: 'Zé dos Saques', porcentagem: 20, tipo: 'saque' })).j.indicacao;
  conferir('cria links (código escolhido e gerado)', lP?.codigo === codP && lP.link.endsWith(`/?ref=${codP}`) && /^ze-dos-saques-[0-9a-f]{4}$/.test(lS?.codigo || ''), lS?.codigo);
  conferir('código repetido', (await op('POST', '/api/admin/indicacoes', { nome: 'Outro', codigo: codP, porcentagem: 5, tipo: 'saque' })).s === 409);
  await cliente()('POST', '/api/indicacao/visita', { ref: codP }); await cliente()('POST', '/api/indicacao/visita', { ref: codP });
  const cadRef = async (nome, ref) => { const c = cliente(); await c('POST', '/api/cadastro', { nome, email: `${nome.toLowerCase()}${Date.now()}@x.com`, senha: 'senha-boa-123', nascimento: '1990-05-05', ref }); return c; };
  const ind1 = await cadRef('Indicado', codP.toUpperCase());
  await cadRef('Fantasma', 'nao-existe');
  const ind1Id = await idDe(ind1);
  const linkado = dbTeste.prepare('SELECT indicacao_id FROM usuarios WHERE id = ?').get(ind1Id).indicacao_id;
  conferir('cadastro pelo link fica ligado; código inexistente não', linkado === lP.id && dbTeste.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE nome = 'Fantasma' AND indicacao_id IS NOT NULL").get().n === 0);
  // indicado deposita R$ 25 (fica com R$ 100) e perde R$ 40: lucro 40 − bônus 75 → base 0
  await ind1('POST', '/api/carteira/deposito', { valor: 2500 });
  const perdeu = async (c, v) => dbTeste.prepare("INSERT INTO movimentos (usuario_id, tipo, valor, descricao, criado) VALUES (?, 'entrada', ?, 'Entrada (teste)', ?)").run(await idDe(c), -v, Date.now());
  await perdeu(ind1, 4000);
  let rP = (await op('GET', `/api/admin/indicacoes/${lP.id}`)).j;
  conferir('perdas menores que o bônus: comissão zero', rP.indicacao.resumo.lucroCasa === 4000 && rP.indicacao.resumo.base === 0 && rP.indicacao.resumo.comissao === 0 && rP.indicacao.resumo.cliques === 1,
    `cliques ${rP.indicacao.resumo.cliques}, base ${rP.indicacao.resumo.base}`);
  await perdeu(ind1, 6000);
  rP = (await op('GET', `/api/admin/indicacoes/${lP.id}`)).j;
  conferir('comissão sobre perdas: 10% × (100 − 75 de bônus) = R$ 2,50', rP.indicacao.resumo.base === 2500 && rP.indicacao.resumo.comissao === 250 && rP.usuarios.length === 1 && rP.usuarios[0].id === ind1Id
    && !JSON.stringify(rP).includes('senha_hash'));
  const ind2 = await cadRef('Sacador', lS.codigo);
  await creditar(ind2, 5000);
  dbTeste.prepare("INSERT INTO saques (usuario_id, valor, estado, criado) VALUES (?, 2000, 'aprovado', ?)").run(await idDe(ind2), Date.now());
  dbTeste.prepare("INSERT INTO saques (usuario_id, valor, estado, criado) VALUES (?, 1000, 'pendente', ?)").run(await idDe(ind2), Date.now());
  const rS = (await op('GET', `/api/admin/indicacoes/${lS.id}`)).j.indicacao.resumo;
  conferir('comissão sobre saques: 20% dos saques pagos (pendente não conta)', rS.sacado === 2000 && rS.saquePendente === 1000 && rS.comissao === 400);
  const busca = (await op('GET', `/api/admin/indicacoes?q=${encodeURIComponent('%')}`)).j;
  const pagIdx = (await op('GET', '/api/admin/indicacoes?tipo=saque&por=5')).j;
  conferir('busca e filtro da lista de links', busca.total === 0 && pagIdx.indicacoes.every(l => l.tipo === 'saque') && pagIdx.indicacoes.some(l => l.id === lS.id));
  await op('PATCH', `/api/admin/indicacoes/${lS.id}`, { ativo: false });
  const ind3 = await cadRef('Tarde', lS.codigo);
  conferir('link desativado não liga cadastros novos', dbTeste.prepare('SELECT indicacao_id FROM usuarios WHERE id = ?').get(await idDe(ind3)).indicacao_id === null);

  console.log('--- fluxo de partidas');
  // posição 1 = muito fácil (0), posição 2 = impossível (100), o resto = regras gerais
  await op('PUT', '/api/admin/regras', { regras: { fluxo: [0, 100] } });
  const fx = await novaConta('Fluxo'); await creditar(fx, 100000);
  const p1 = (await fx('POST', '/api/partidas', { entrada: 1000 })).j.partida;
  conferir('1ª partida usa a dificuldade da posição 1', p1.regras.fluxoPosicao === 1 && p1.regras.fruitPercent === 10 && p1.regras.speedGain === 0.02 && p1.regras.dificuldade === 0, `posição ${p1.regras.fluxoPosicao}, fruta ${p1.regras.fruitPercent}%, aceleração ${p1.regras.speedGain}`);
  await fx('POST', `/api/partidas/${p1.id}/cancelar`);
  const p1b = (await fx('POST', '/api/partidas', { entrada: 1000 })).j.partida;
  conferir('partida cancelada antes do START não avança o fluxo', p1b.regras.fluxoPosicao === 1);
  await fx('POST', `/api/partidas/${p1b.id}/comecar`);
  await fx('POST', `/api/partidas/${p1b.id}/encerrar`, { rle: [[8, 30]], frutas: 0 });
  const p2 = (await fx('POST', '/api/partidas', { entrada: 1000 })).j.partida;
  conferir('2ª partida usa a dificuldade da posição 2', p2.regras.fluxoPosicao === 2 && p2.regras.fruitPercent === 1.25 && p2.regras.speedGain === 0.2, `posição ${p2.regras.fluxoPosicao}, fruta ${p2.regras.fruitPercent}%, aceleração ${p2.regras.speedGain}`);
  await fx('POST', `/api/partidas/${p2.id}/cancelar`);
  conferir('jogador não muda o próprio fluxo', (await fx('PUT', '/api/admin/regras', { regras: { fluxo: [0, 0, 0] } })).s === 403);

  console.log('--- limiar de ganho (a dificuldade sobe no meio da partida)');
  // em todas as posições: ao ganhar 0,1× a entrada (2 frutas a 5%), sobe para "Impossível"
  const comLimiar = (await op('PUT', '/api/admin/regras', { regras: { fluxoLimiar: Array(10).fill(0.1), fluxoDepois: Array(10).fill(100), limiar: { ganho: 0.1, frutas: 1, dificuldade: 0, depois: { fruitPercent: 1000 } } } })).j.regras;
  conferir('limiar resolvido não pode vir do operador', comLimiar.limiar === null && comLimiar.fluxoLimiar[0] === 0.1);
  const lm = await novaConta('Limiar'); await creditar(lm, 100000);
  let pl, gl;
  process.env.ARENA_LIMIAR = '0.1'; // o robô joga com as mesmas regras da partida
  for (let k = 0; k < 6; k++) {
    pl = (await lm('POST', '/api/partidas', { entrada: 2000 })).j.partida;
    gl = jogarComRobo(pl.semente, 40);
    if (gl.frutas > 2) break;
    await lm('POST', `/api/partidas/${pl.id}/cancelar`);
  }
  delete process.env.ARENA_LIMIAR;
  conferir('partida guarda o limiar (2 frutas → Impossível)', pl.regras.limiar?.frutas === 2 && pl.regras.limiar.dificuldade === 100 && pl.regras.limiar.depois.fruitPercent === 1.25);
  await lm('POST', `/api/partidas/${pl.id}/comecar`);
  await dormir(Math.max(0, passosDe(gl.rle) / 60 * 1000 - 2500));
  const fimL = (await lm('POST', `/api/partidas/${pl.id}/encerrar`, { rle: gl.rle, frutas: gl.frutas })).j.partida;
  const esperado = 2 * 100 + (fimL.frutas - 2) * 25; // 2 frutas a 5% de 2000 + o resto a 1,25%
  conferir('pagamento: frutas depois do limiar valem o do nível novo', fimL.verificacao === 'confirmada' && fimL.frutas > 2 && fimL.recebido === esperado,
    `${fimL.frutas} frutas, recebeu ${fimL.recebido}, esperado ${esperado}, ${fimL.verificacao}`);
  await op('PUT', '/api/admin/regras', { regras: {} });

  console.log('--- admin local (só para testes no computador)');
  conferir('admin local desligado sem a opção', (await cliente()('GET', '/api/admin/local')).j.local === false && (await cliente()('PUT', '/api/admin/regras', { regras: {} })).s === 401);
  // com a opção, mas configurado como produção (atrás do proxy): o servidor nem sobe
  const recusa = await new Promise(ok => {
    const p = spawn(process.execPath, [path.join(raiz, 'servidor', 'serve.js'), '8199', '--admin-local'], { env: { ...process.env, ARENA_DB: dbArq + '-local', ARENA_PROXY: '1' }, stdio: 'ignore' });
    const t = setTimeout(() => { p.kill(); ok('subiu'); }, 8000);
    p.on('exit', c => { clearTimeout(t); ok(c); });
  });
  conferir('--admin-local recusado em configuração de produção', recusa === 1, `saída ${recusa}`);
  // com a opção num servidor de teste: só localhost sem proxy entra
  const loc = spawn(process.execPath, [path.join(raiz, 'servidor', 'serve.js'), '8199', '--admin-local'], { env: { ...process.env, ARENA_DB: dbArq + '-local', ARENA_BACKUP_HORAS: '0', ARENA_SMTP_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logLoc = ''; loc.stdout.on('data', d => { logLoc += d; });
  for (let i = 0; i < 100 && !logLoc.includes('Crash Arena em'); i++) await dormir(100);
  const pedir = (cab = {}) => new Promise(ok => {
    const r = http.request({ host: '127.0.0.1', port: 8199, path: '/api/admin/regras', method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Arena': '1', ...cab } }, res => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    r.end(JSON.stringify({ regras: { fluxo: [50] } }));
  });
  conferir('admin local: localhost entra sem login', (await pedir({ Host: 'localhost:8199' })) === 200);
  conferir('admin local: Host de fora (forjado) não entra', (await pedir({ Host: 'arenacrash.com' })) === 401);
  conferir('admin local: pedido vindo de proxy não entra', (await pedir({ Host: 'localhost:8199', 'X-Forwarded-For': '8.8.8.8' })) === 401);
  loc.kill(); await dormir(300);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbArq + '-local' + s); } catch {} }

  console.log('--- operador sem autenticador por configuração');
  const dbSem2fa = dbArq + '-sem2fa';
  const sem2faSrv = spawn(process.execPath, [path.join(raiz, 'servidor', 'serve.js'), '8199'], {
    env: { ...process.env, ARENA_DB: dbSem2fa, ARENA_BACKUP_HORAS: '0', ARENA_SMTP_URL: '',
      ARENA_ADMIN_EMAIL: OP.email, ARENA_ADMIN_SENHA: OP.senha, ARENA_ADMIN_2FA: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logSem2fa = '';
  sem2faSrv.stdout.on('data', d => { logSem2fa += d; });
  for (let i = 0; i < 100 && !logSem2fa.includes('Crash Arena em'); i++) await dormir(100);
  const baseSem2fa = 'http://localhost:8199';
  const adminSem2fa = cliente(baseSem2fa);
  const entradaSem2fa = await adminSem2fa('POST', '/api/login', OP);
  conferir('operador entra com senha e recebe acesso sem autenticador', entradaSem2fa.s === 200 && entradaSem2fa.j.usuario?.acessoOperador === true);
  conferir('operador usa a API administrativa sem autenticador', (await adminSem2fa('GET', '/api/admin/saques')).s === 200);
  conferir('sem sessão continua sem acesso administrativo', (await cliente(baseSem2fa)('GET', '/api/admin/saques')).s === 401);
  const jogadorSem2fa = await novaConta('Sem2fa', baseSem2fa);
  conferir('jogador continua sem acesso administrativo', (await jogadorSem2fa('GET', '/api/admin/saques')).s === 403);
  const bancoSem2fa = bancoDe(dbSem2fa);
  bancoSem2fa.prepare('UPDATE usuarios SET totp_ativo = 1, totp_segredo = ? WHERE email = ?').run(totp.novoSegredo(), OP.email);
  await adminSem2fa('POST', '/api/sair');
  const reentradaSem2fa = await adminSem2fa('POST', '/api/login', OP);
  conferir('autenticador antigo do operador não bloqueia o login quando desligado', reentradaSem2fa.s === 200 && reentradaSem2fa.j.usuario?.acessoOperador === true && !reentradaSem2fa.j.precisa2fa);
  bancoSem2fa.close();
  sem2faSrv.kill(); await dormir(300);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbSem2fa + s); } catch {} }

  console.log('--- Pix real (CajuPay de mentira, aqui no computador)');
  // um "CajuPay" falso na porta 8195 e um Arena ligado nele (porta 8196, admin local para aprovar saques)
  const fake = { pagamentos: new Map(), pagos: new Set(), saques: [], pedidos: [] };
  const fakeSrv = http.createServer((req, res) => {
    let corpo = ''; req.on('data', d => { corpo += d; });
    req.on('end', () => {
      fake.pedidos.push({ metodo: req.method, url: req.url, chave: req.headers['x-api-key'], segredo: req.headers['x-api-secret'], idem: req.headers['idempotency-key'], corpo });
      const j = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers['x-api-secret'] !== 'gsk_teste') return j(401, { error: 'unauthorized' });
      if (req.method === 'POST' && req.url === '/api/payments/pix') {
        const b = JSON.parse(corpo), id = `pay_${fake.pagamentos.size + 1}`;
        fake.pagamentos.set(id, b.amount_cents);
        return j(201, { payment_id: id, pix_copy_paste: `00020126PIXTESTE${id}`, pix_qr_code: '', status: 'pending' });
      }
      const m = /^\/api\/payments\/(pay_\d+)$/.exec(req.url);
      if (req.method === 'GET' && m) return j(200, { payment_id: m[1], amount_cents: fake.pagamentos.get(m[1]), status: fake.pagos.has(m[1]) ? 'paid' : 'pending' });
      if (req.method === 'POST' && req.url === '/api/payouts') { fake.saques.push(JSON.parse(corpo)); return j(201, { payout_id: `po_${fake.saques.length}`, status: 'processing' }); }
      j(404, { error: 'not_found' });
    });
  }).listen(8195);
  const dbPix = dbArq + '-pix';
  const pixSrv = spawn(process.execPath, [path.join(raiz, 'servidor', 'serve.js'), '8196', '--admin-local'], {
    env: { ...process.env, ARENA_DB: dbPix, ARENA_BACKUP_HORAS: '0', ARENA_SMTP_URL: '', ARENA_SITE_URL: '', ARENA_CONTAS_POR_HORA: '100',
      ARENA_ADMIN_EMAIL: 'op2@teste.local', ARENA_ADMIN_SENHA: 'senha-do-operador-123',
      CAJUPAY_BASE_URL: 'http://127.0.0.1:8195', CAJUPAY_API_KEY: 'gpk_teste', CAJUPAY_API_SECRET: 'gsk_teste',
      CAJUPAY_WEBHOOK_SECRET: 'cwhsec_teste', CAJUPAY_SAQUE_AUTOMATICO: '1', CAJUPAY_REFERENCIA_PREFIXO: 'crashgo-teste' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logPix = ''; pixSrv.stdout.on('data', d => { logPix += d; }); pixSrv.stderr.on('data', d => { logPix += d; });
  for (let i = 0; i < 100 && !logPix.includes('Crash Arena em'); i++) await dormir(100);
  const basePix = 'http://localhost:8196';
  const assinar = (corpo, segredo = 'cwhsec_teste', ts = Math.floor(Date.now() / 1000)) =>
    `t=${ts},v1=${crypto.createHmac('sha256', segredo).update(`${ts}.${corpo}`).digest('hex')}`;
  const webhook = async (evento, assinatura) => {
    const corpo = JSON.stringify(evento);
    const r = await fetch(basePix + '/api/webhooks/cajupay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CajuPay-Signature': assinatura ?? assinar(corpo) }, body: corpo });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const px = await novaConta('Pix', basePix);
  const dp = (await px('POST', '/api/carteira/deposito', { valor: 2500 })).j;
  conferir('depósito gera Pix (copia e cola) e o saldo ainda não entra', dp.deposito?.estado === 'pendente' && /PIXTESTE/.test(dp.deposito.pixCopiaCola) && (await px('GET', '/api/eu')).j.saldo === 0);
  const pedPix = fake.pedidos.find(p => p.url === '/api/payments/pix');
  conferir('chamada à CajuPay com chaves e Idempotency-Key, sem o segredo no site', pedPix?.chave === 'gpk_teste' && /^crashgo-teste-deposito-\d+$/.test(pedPix.idem || '') && !JSON.stringify(dp).includes('gsk_teste'));
  const idPay = [...fake.pagamentos.keys()][0];
  const pago = valor => ({ id: 'evt1', type: 'pix.payment.paid', data: { object: { cajupay_payment_id: idPay, amount_cents: valor, status: 'paid' } } });
  conferir('webhook sem assinatura é recusado', (await webhook(pago(2500), '')).s === 401);
  conferir('webhook com segredo errado é recusado', (await webhook(pago(2500), assinar(JSON.stringify(pago(2500)), 'cwhsec_falso'))).s === 401);
  conferir('webhook velho (mais de 5 min) é recusado', (await webhook(pago(2500), assinar(JSON.stringify(pago(2500)), 'cwhsec_teste', Math.floor(Date.now() / 1000) - 900))).s === 401);
  const divergente = await webhook(pago(100));
  conferir('Pix pago com valor diferente não credita', divergente.j?.resultado === 'valor_divergente' && (await px('GET', '/api/eu')).j.saldo === 0);
  const w1 = await webhook(pago(2500)), w2 = await webhook(pago(2500));
  conferir('Pix pago credita depósito + promoção (R$ 25 → R$ 100) uma vez só', w1.j?.resultado === 'creditado' && w2.j?.resultado === 'ja_creditado' && (await px('GET', '/api/eu')).j.saldo === 10000);
  // webhook perdido: a tela do QR pergunta e o servidor confere na CajuPay
  const dp2 = (await px('POST', '/api/carteira/deposito', { valor: 1000 })).j.deposito;
  fake.pagos.add([...fake.pagamentos.keys()][1]);
  const consultado = (await px('GET', `/api/carteira/deposito/${dp2.id}`)).j;
  conferir('sem webhook, a consulta à CajuPay credita o Pix pago', consultado.deposito?.estado === 'pago' && consultado.saldo === 11000);
  conferir('outro jogador não vê o Pix de ninguém', (await (await novaConta('Curioso', basePix))('GET', `/api/carteira/deposito/${dp2.id}`)).s === 404);
  // saque com envio automático: aprovar manda o Pix; se o banco recusar, o valor volta
  await ativar2fa(px);
  await jogou(px, 11000, bancoDe(dbPix));
  const pedSaque = await px('POST', '/api/carteira/saque', { valor: 3000, chaveTipo: 'telefone', chave: '(21) 99876-5432', documento: CPF_OK });
  conferir('saque por telefone pedido (valor reservado)', pedSaque.s === 200 && pedSaque.j.saldo === 8000 && pedSaque.j.saque.chaveFinal === '5432');
  const opPix = cliente(basePix);
  const listaPix = (await opPix('GET', '/api/admin/saques?estado=pendente')).j;
  const sqPix = listaPix.saques.find(x => x.id === pedSaque.j.saque.id);
  conferir('operador vê a chave Pix completa', listaPix.envioAutomatico === true && sqPix?.chave === '(21) 99876-5432' && sqPix.documento === '529.982.247-25');
  const apPix = await opPix('POST', `/api/admin/saques/${sqPix.id}`, { decisao: 'aprovar' });
  const envio = fake.saques[0] || {};
  conferir('aprovar envia o Pix pela CajuPay (telefone +55 e CPF do titular)', apPix.s === 200 && apPix.j.saque.estado === 'processando' && envio.pix_key === '+5521998765432' && envio.pix_key_type === 'phone' && envio.key_owner_document === CPF_OK && envio.amount_cents === 3000);
  const falha = { id: 'evt2', type: 'payout.failed', data: { object: { external_ref: `crashgo-teste-saque-${sqPix.id}`, status: 'failed', last_error: 'chave inexistente' } } };
  const outroSite = await webhook({ ...falha, data: { object: { ...falha.data.object, external_ref: `saque-${sqPix.id}` } } });
  conferir('webhook de outra instalação não altera o saque', outroSite.j?.resultado === 'saque_desconhecido' && (await px('GET', '/api/carteira')).j.saques.find(s => s.id === sqPix.id)?.estado === 'processando');
  const f1 = await webhook(falha), f2 = await webhook(falha);
  conferir('saque recusado pelo banco devolve o valor uma vez só', f1.j?.resultado === 'saque_devolvido' && f2.j?.resultado === 'ja_tratado' && (await px('GET', '/api/eu')).j.saldo === 11000);
  const ped2 = await px('POST', '/api/carteira/saque', { valor: 2000, chaveTipo: 'cpf', chave: CPF_OK });
  await opPix('POST', `/api/admin/saques/${ped2.j.saque.id}`, { decisao: 'aprovar' });
  const okW = await webhook({ id: 'evt3', type: 'payout.paid', data: { object: { external_ref: `crashgo-teste-saque-${ped2.j.saque.id}`, status: 'paid' } } });
  const meusPx = (await px('GET', '/api/carteira')).j.saques;
  conferir('saque pago pelo banco fica como pago', okW.j?.resultado === 'saque_pago' && meusPx.find(x => x.id === ped2.j.saque.id)?.estado === 'aprovado' && (await px('GET', '/api/eu')).j.saldo === 9000);
  pixSrv.kill(); fakeSrv.close(); await dormir(300);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPix + s); } catch {} }

  console.log('--- saques (pedido, aprovação e recusa)');
  // o jogador "a" pediu 5 saques de 10 (lá em cima): o valor saiu do saldo e eles esperam o operador
  const pend = (await op('GET', '/api/admin/saques?estado=pendente&por=100')).j;
  const meus = pend.saques.filter(x => x.valor === 1000 && x.estado === 'pendente');
  conferir('saques pedidos ficam pendentes para o operador', meus.length >= 5 && pend.resumo.pendente.quantidade >= 5);
  const [sq1, sq2, sq3] = meus;
  conferir('jogador não aprova o próprio saque', (await a('POST', `/api/admin/saques/${sq1.id}`, { decisao: 'aprovar' })).s === 403
    && (await cliente()('GET', '/api/admin/saques')).s === 401);
  const donoA = sq1.usuario.id;
  const saldoAntesSaque = (await op('GET', `/api/admin/usuarios/${donoA}`)).j.usuario.saldo;
  const ap = await op('POST', `/api/admin/saques/${sq1.id}`, { decisao: 'aprovar' });
  conferir('aprovar dá baixa sem mexer no saldo', ap.s === 200 && ap.j.saque.estado === 'aprovado' && (await op('GET', `/api/admin/usuarios/${donoA}`)).j.usuario.saldo === saldoAntesSaque);
  const rec = await op('POST', `/api/admin/saques/${sq2.id}`, { decisao: 'recusar', motivo: 'dados bancários errados' });
  conferir('recusar devolve o valor ao saldo', rec.s === 200 && (await op('GET', `/api/admin/usuarios/${donoA}`)).j.usuario.saldo === saldoAntesSaque + 1000);
  conferir('saque já decidido não muda de novo', (await op('POST', `/api/admin/saques/${sq2.id}`, { decisao: 'recusar' })).s === 409
    && (await op('POST', `/api/admin/saques/${sq1.id}`, { decisao: 'recusar' })).s === 409);
  const corrida = await Promise.all(Array.from({ length: 6 }, () => op('POST', `/api/admin/saques/${sq3.id}`, { decisao: 'recusar' })));
  conferir('6 recusas ao mesmo tempo devolvem uma vez só', corrida.filter(r => r.s === 200).length === 1 && (await op('GET', `/api/admin/usuarios/${donoA}`)).j.usuario.saldo === saldoAntesSaque + 2000);
  const cartA = (await a('GET', '/api/carteira')).j;
  conferir('jogador vê o estado dos saques na carteira', cartA.saques.some(x => x.id === sq1.id && x.estado === 'aprovado') && cartA.saques.some(x => x.id === sq2.id && x.estado === 'recusado' && x.motivo === 'dados bancários errados'));
  conferir('decisão inválida', (await op('POST', `/api/admin/saques/${meus[3].id}`, { decisao: 'pagar-em-dobro' })).s === 400);

  console.log('--- pagamento sem análise');
  // pagamento alto (60% por fruta) entra direto: o controle do dinheiro que sai é a aprovação do saque
  await op('PUT', '/api/admin/regras', { regras: { fruitPercent: 60 } });
  let pe, ge;
  for (let k = 0; k < 6; k++) {
    pe = (await c('POST', '/api/partidas', { entrada: 2000 })).j.partida;
    ge = jogarComRobo(pe.semente, 40);
    if (ge.frutas >= 2) break;
    await c('POST', `/api/partidas/${pe.id}/cancelar`);
  }
  await c('POST', `/api/partidas/${pe.id}/comecar`);
  await dormir(Math.max(0, passosDe(ge.rle) / 60 * 1000 - 2500));
  const saldoAntes = (await c('GET', '/api/eu')).j.saldo;
  const fimE = (await c('POST', `/api/partidas/${pe.id}/encerrar`, { rle: ge.rle, frutas: ge.frutas })).j.partida;
  const saldoDepois = (await c('GET', '/api/eu')).j.saldo;
  conferir('pagamento alto entra direto na carteira', fimE.analise === null && fimE.recebido > 0 && saldoDepois === saldoAntes + fimE.recebido, `recebeu ${fimE.recebido}`);
  conferir('rotas antigas de análise não existem mais', (await op('GET', '/api/admin/analises')).s === 404);
  await op('PUT', '/api/admin/regras', { regras: {} });

  // robô "nervoso": balança o desvio a cada passo (impossível para uma pessoa). Recebe o que o replay confirmou,
  // mas a partida fica marcada e vai para o registro de segurança.
  let pf, gf;
  for (let k = 0; k < 8; k++) {
    pf = (await c('POST', '/api/partidas', { entrada: 2000 })).j.partida;
    gf = jogarComRobo(pf.semente, 40, true);
    if (gf.frutas > 0) break;
    await c('POST', `/api/partidas/${pf.id}/cancelar`);
  }
  await c('POST', `/api/partidas/${pf.id}/comecar`);
  await dormir(Math.max(0, passosDe(gf.rle) / 60 * 1000 - 2500));
  await c('POST', `/api/partidas/${pf.id}/encerrar`, { rle: gf.rle, frutas: gf.frutas });
  const sinais = (await op('GET', '/api/admin/auditoria')).j.eventos;
  const marcado = sinais.find(ev => ev.evento === 'partida_suspeita' && String(ev.detalhe).includes(pf.id));
  conferir('robô que inverte o desvio 60×/s fica marcado no registro', gf.frutas > 0 && !!marcado && /comandos rápidos/.test(marcado.detalhe), `${gf.frutas} frutas`);

  console.log('--- banco de dados');
  const db = new DatabaseSync(dbArq);
  let travou = false; try { db.exec('UPDATE movimentos SET valor = 99999999'); } catch { travou = true; }
  conferir('alterar lançamento direto no banco', travou);
  travou = false; try { db.exec('DELETE FROM movimentos'); } catch { travou = true; }
  conferir('apagar lançamentos direto no banco', travou);
  const uid = db.prepare('SELECT id FROM usuarios WHERE operador = 0 LIMIT 1').get().id;
  travou = false; try { db.prepare("INSERT INTO movimentos (usuario_id, tipo, valor, descricao, criado) VALUES (?, 'saque', -999999999, 'x', 0)").run(uid); } catch { travou = true; }
  conferir('lançamento que deixa saldo negativo', travou);
  db.close();

  console.log('--- arquivos e cabeçalhos');
  const html = await fetch(base + '/lobby/');
  conferir('página com CSP e bloqueio de iframe', !!html.headers.get('content-security-policy') && html.headers.get('x-frame-options') === 'DENY');
  conferir('package.json não é servido', (await fetch(base + '/package.json')).status === 404);
  conferir('arquivo oculto não é servido', (await fetch(base + '/.gitignore')).status === 404);
  conferir('subir pastas na URL (../servidor/api.js)', [403, 404].includes((await fetch(base + '/..%2fservidor%2fapi.js')).status));
  conferir('registro de auditoria tem os eventos', sinais.some(e => e.evento === 'login_falhou') && sinais.some(e => e.evento === 'gravacao_adiantada'),
    [...new Set(sinais.map(e => e.evento))].join(', '));
} catch (e) {
  falhou++;
  console.error('ERRO NO TESTE:', e);
} finally {
  console.log(`\n${ok} barrados, ${falhou} falharam`);
  srv.kill();
  await dormir(300);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbArq + s); } catch {} }
  process.exit(falhou ? 1 : 0);
}
