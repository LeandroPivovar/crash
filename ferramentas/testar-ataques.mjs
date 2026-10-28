// Teste de ataques ao Crash Arena: sobe um servidor descartável (banco temporário) e tenta fraudar a
// plataforma pela API, do jeito que alguém faria com o console do navegador ou um script.
//   node ferramentas/testar-ataques.mjs
// Cada linha mostra o ataque e se foi barrado (OK) ou não (FALHOU). No fim, o total.
import { spawn, execFileSync } from 'child_process';
import http from 'http';
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
function cliente() {
  let cookie = '';
  const c = async (m, rota, corpo, cab = {}) => {
    const h = { ...(m === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Arena': '1' }), ...(cookie ? { cookie } : {}), ...cab };
    const r = await fetch(base + rota, { method: m, headers: h, body: m === 'GET' ? undefined : typeof corpo === 'string' ? corpo : JSON.stringify(corpo || {}), redirect: 'manual' });
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
const novaConta = async (nome = 'Jogador') => {
  const c = cliente();
  const email = `${nome.toLowerCase()}${Date.now()}${Math.random().toString(36).slice(2, 6)}@x.com`;
  await c('POST', '/api/cadastro', { nome, email, senha: 'senha-boa-123', nascimento: '1990-05-05' });
  await c('POST', '/api/confirmar', { token: await linkDoEmail(email) });
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
  const cad = await novo('POST', '/api/cadastro', { nome: 'Novo', email: emailNovo, senha: 'senha-boa-123', nascimento: '1990-01-01' });
  conferir('cadastro não abre sessão antes de confirmar o e-mail', cad.j?.confirmar === true && (await novo('GET', '/api/eu')).j.usuario === null);
  const semConf = await novo('POST', '/api/login', { email: emailNovo, senha: 'senha-boa-123' });
  conferir('login com e-mail não confirmado', semConf.s === 403 && semConf.j.codigo === 'confirmar_email');
  conferir('link de confirmação inventado', (await novo('POST', '/api/confirmar', { token: 'A'.repeat(43) })).s === 400);
  const tokNovo = await linkDoEmail(emailNovo);
  conferir('link de confirmação certo entra', (await novo('POST', '/api/confirmar', { token: tokNovo })).s === 200 && (await novo('GET', '/api/eu')).j.usuario?.email === emailNovo);
  conferir('link de confirmação não vale duas vezes', (await cliente()('POST', '/api/confirmar', { token: tokNovo })).s === 400);
  conferir('visitante sem confirmar 18+', (await cliente()('POST', '/api/visitante', {})).s === 400);
  const vis = cliente(); await vis('POST', '/api/visitante', { maior18: true }); await vis('POST', '/api/carteira/deposito', { valor: 5000 });
  conferir('visitante tentando sacar', (await vis('POST', '/api/carteira/saque', { valor: 1000, codigo: '123456' })).s === 403);
  conferir('visitante tentando ativar o app autenticador', (await vis('POST', '/api/conta/2fa/iniciar', { senha: 'x' })).s === 403);
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
  conferir('depósito com valor em texto', (await a('POST', '/api/carteira/deposito', { valor: '5000' })).s === 400);
  conferir('depósito quebrado (0,5 centavo)', (await a('POST', '/api/carteira/deposito', { valor: 10.5 })).s === 400);
  conferir('depósito negativo', (await a('POST', '/api/carteira/deposito', { valor: -100000 })).s === 400);
  conferir('depósito acima do limite', (await a('POST', '/api/carteira/deposito', { valor: 1e12 })).s === 400);
  await a('POST', '/api/carteira/deposito', { valor: 5000 });
  const semApp2 = await a('POST', '/api/carteira/saque', { valor: 1000 });
  conferir('saque sem o app autenticador ativo', semApp2.s === 403 && semApp2.j.codigo === 'configurar_2fa');
  conferir('ativar o app do jogador exige a senha', (await a('POST', '/api/conta/2fa/iniciar', { senha: 'errada-errada' })).s === 401);
  const appA = await ativar2fa(a);
  conferir('jogador ativa o app (8 códigos de reserva)', appA.reserva?.length === 8);
  conferir('saque sem código', (await a('POST', '/api/carteira/saque', { valor: 1000 })).s === 401);
  conferir('saque com código errado', (await a('POST', '/api/carteira/saque', { valor: 1000, codigo: '999999' })).s === 401 || codigoDoApp(appA.segredo) === '999999');
  conferir('saque com o código já usado na ativação', (await a('POST', '/api/carteira/saque', { valor: 1000, codigo: codigoDoApp(appA.segredo) })).s === 401);
  conferir('saque maior que o saldo', (await a('POST', '/api/carteira/saque', { valor: 6000, codigo: appA.reserva[7] })).s === 400);
  // 7 saques ao mesmo tempo, cada um com um código de reserva diferente (o 8º foi gasto acima)
  const tentativas = await Promise.all(appA.reserva.slice(0, 7).map(codigo => a('POST', '/api/carteira/saque', { valor: 1000, codigo })));
  const saldoA = (await a('GET', '/api/eu')).j.saldo;
  conferir('7 saques de 10 ao mesmo tempo com saldo 50', saldoA === 0 && tentativas.filter(r => r.s === 200).length === 5, `saldo final ${saldoA}`);
  await a('POST', '/api/carteira/deposito', { valor: 3000 });
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
  const { segredo } = (await op('POST', '/api/admin/2fa/iniciar', { senha: OP.senha })).j;
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
  const c = await novaConta('Caio'); await c('POST', '/api/carteira/deposito', { valor: 100000 });
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

  // pagamento alto: operador baixa o limite de análise para 0,1× → vai para análise e só paga se aprovar
  await op('PUT', '/api/admin/regras', { regras: { analiseAcimaDe: 1, fruitPercent: 60 } });
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
  conferir('pagamento acima do limite fica em análise (não credita)', fimE.analise === 'pendente' && saldoDepois === saldoAntes, `a pagar ${fimE.aPagar}`);
  const lista = (await op('GET', '/api/admin/analises')).j.partidas;
  conferir('operador vê o pagamento em análise', lista.some(p => p.id === pe.id));
  conferir('jogador tentando aprovar o próprio pagamento', (await c('POST', `/api/admin/analises/${pe.id}`, { decisao: 'aprovar' })).s === 403);
  await op('POST', `/api/admin/analises/${pe.id}`, { decisao: 'aprovar' });
  const saldoAprov = (await c('GET', '/api/eu')).j.saldo;
  conferir('aprovação credita uma vez só', saldoAprov === saldoAntes + fimE.aPagar && (await op('POST', `/api/admin/analises/${pe.id}`, { decisao: 'aprovar' })).s === 409);
  await op('PUT', '/api/admin/regras', { regras: {} });

  // robô "nervoso": joga bem, mas balança o desvio para lá e para cá a cada passo (impossível para uma pessoa).
  // Ele pega frutas de verdade; o pagamento tem que ir para análise em vez de entrar na carteira.
  let pf, gf;
  for (let k = 0; k < 8; k++) {
    pf = (await c('POST', '/api/partidas', { entrada: 2000 })).j.partida;
    gf = jogarComRobo(pf.semente, 40, true);
    if (gf.frutas > 0) break;
    await c('POST', `/api/partidas/${pf.id}/cancelar`);
  }
  await c('POST', `/api/partidas/${pf.id}/comecar`);
  await dormir(Math.max(0, passosDe(gf.rle) / 60 * 1000 - 2500));
  const saldoAntesF = (await c('GET', '/api/eu')).j.saldo;
  const fimF = (await c('POST', `/api/partidas/${pf.id}/encerrar`, { rle: gf.rle, frutas: gf.frutas })).j.partida;
  const saldoDepoisF = (await c('GET', '/api/eu')).j.saldo;
  const sinais = (await op('GET', '/api/admin/auditoria')).j.eventos;
  const motivoF = (await op('GET', '/api/admin/analises')).j.partidas.find(p => p.id === pf.id)?.motivo || '';
  conferir('robô que inverte o desvio 60×/s vai para análise', gf.frutas > 0 && fimF.analise === 'pendente' && saldoDepoisF === saldoAntesF && /comandos rápidos/.test(motivoF),
    `${gf.frutas} frutas, análise=${fimF.analise}, motivo: ${motivoF}`);

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
