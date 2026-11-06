// API do Crash Arena: contas, sessões, carteira (livro-razão), partidas com replay e regras do operador.
// Ainda sem dinheiro real: depósito e saque são simulados.
//
// Regra de ouro: o navegador não decide nada que valha moeda. Ele só manda COMANDOS (a gravação da corrida);
// o servidor cria a partida, sorteia a semente, refaz a corrida e calcula o pagamento. Ver docs/SEGURANCA.md.
//
// Proteções:
//  - senha com scrypt + sal; sessão por cookie HttpOnly/SameSite=Lax (o banco guarda só o sha256 do token);
//  - pedidos que mudam algo exigem JSON e o cabeçalho X-Arena: 1 (barra formulários de outros sites);
//  - limites de pedidos por IP, por usuário e por e-mail; tamanho máximo de corpo por rota;
//  - gravação só cresce (não dá para reescrever o passado) e nunca passa do tempo real;
//  - pagamento suspeito ou alto demais fica em análise até o operador decidir;
//  - livro-razão imutável e sem saldo negativo (gatilhos no banco), toda conta de saldo em transação;
//  - registro de auditoria dos eventos de segurança.
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const path = require('path'), fs = require('fs');
const { db, transacao } = require('./banco');
const replay = require('./replay');

const COOKIE = 'arena_sessao';
const SESSAO_DIAS = 30;
const LIMITE_MOVIMENTO = 10000 * 100;   // 10 000 moedas por depósito/saque
const ENTRADA_MIN = 100;                 // 1 moeda
const ENTRADA_MAX = 10000 * 100;         // 10 000 moedas por partida
const IDADE_MIN = 18;
const CORPO_PADRAO = 16 * 1024;          // bytes por pedido (rotas de gravação aceitam mais)
const CORPO_GRAVACAO = 1024 * 1024;
const DURACAO_MAX_MS = 2 * 3600e3;       // corrida mais longa aceita: 2 h
// Atrás de um proxy (nginx, Cloudflare...): ARENA_PROXY=1 faz confiar em X-Forwarded-For/Proto.
const ATRAS_DE_PROXY = process.env.ARENA_PROXY === '1';
// Contas novas (cadastro ou visitante) por IP por hora. ARENA_CONTAS_POR_HORA muda (os testes usam mais).
const CONTAS_POR_HORA = Number(process.env.ARENA_CONTAS_POR_HORA) || 5;
// Tentativas de login por IP a cada 10 min (ARENA_LOGINS_POR_IP; por conta são sempre 10 a cada 15 min).
const LOGINS_POR_IP = Number(process.env.ARENA_LOGINS_POR_IP) || 20;
const agora = () => Date.now();

// ---------- utilitários HTTP ----------
class Erro extends Error { constructor(status, msg, codigo) { super(msg); this.status = status; this.codigo = codigo; } }
function enviar(res, status, obj, extra = {}) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(corpo), ...extra });
  res.end(corpo);
}
function lerCorpo(req, max) {
  return new Promise((ok, falha) => {
    const declarado = Number(req.headers['content-length'] || 0);
    if (declarado > max) { falha(new Erro(413, 'Pedido grande demais.')); req.resume(); return; }
    let tam = 0; const partes = [];
    req.on('data', c => { tam += c.length; if (tam > max) { falha(new Erro(413, 'Pedido grande demais.')); req.destroy(); } else partes.push(c); });
    req.on('end', () => {
      if (!partes.length) return ok({});
      try {
        const v = JSON.parse(Buffer.concat(partes).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return falha(new Erro(400, 'JSON inválido.'));
        ok(v);
      } catch { falha(new Erro(400, 'JSON inválido.')); }
    });
    req.on('error', falha);
  });
}
const cookies = req => {
  const out = {};
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (i < 1) continue;
    try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch {}
  }
  return out;
};
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const ehHttps = req => req.socket.encrypted || (ATRAS_DE_PROXY && req.headers['x-forwarded-proto'] === 'https');
const ipDe = req => (ATRAS_DE_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

// ---------- admin local (testes) ----------
// Só com o servidor iniciado com --admin-local (ver serve.js) e só para pedidos do próprio computador: endereço
// de loopback, Host localhost e sem cabeçalhos de proxy. Aí as rotas de operador não pedem login.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const adminLocal = req => process.env.ARENA_ADMIN_LOCAL === '1' && !ATRAS_DE_PROXY
  && LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto']
  && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');

// ---------- auditoria ----------
function auditar(evento, { u = null, ip = null, detalhe = null } = {}) {
  try {
    db.prepare('INSERT INTO auditoria (quando, usuario_id, ip, evento, detalhe) VALUES (?, ?, ?, ?, ?)')
      .run(agora(), u ? u.id ?? u : null, ip, evento, detalhe == null ? null : typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe));
  } catch (e) { console.error('[auditoria]', e.message); }
}

// ---------- limites de pedidos (janela deslizante simples, em memória) ----------
const baldes = new Map();
function limitar(chave, max, janelaMs, msg = 'Muitos pedidos. Espere um pouco e tente de novo.') {
  const t = agora();
  let b = baldes.get(chave);
  if (!b || b.ate < t) { b = { n: 0, ate: t + janelaMs }; baldes.set(chave, b); }
  b.n++;
  if (b.n > max) {
    if (b.n === max + 1) auditar('limite_excedido', { detalhe: chave });
    throw new Erro(429, msg);
  }
}
setInterval(() => { const t = agora(); for (const [k, b] of baldes) if (b.ate < t) baldes.delete(k); }, 60e3).unref();

// ---------- senhas ----------
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64);
  return `scrypt$${sal.toString('hex')}$${h.toString('hex')}`;
}
const HASH_FALSO = hashSenha(crypto.randomBytes(16).toString('hex')); // para o login levar o mesmo tempo sem conta
function confereSenha(senha, guardado) {
  const [alg, salHex, hHex] = String(guardado || HASH_FALSO).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(String(senha).slice(0, 200), Buffer.from(salHex, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hHex, 'hex')) && !!guardado;
}
function senhaForte(s, min = 8) {
  s = String(s || '');
  if (s.length < min) return `A senha precisa ter pelo menos ${min} caracteres.`;
  if (s.length > 200) return 'Senha longa demais.';
  if (/^(.)\1*$/.test(s)) return 'Escolha uma senha menos óbvia.';
  return null;
}

// ---------- validação ----------
const texto = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
function idade(nascimento) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nascimento || '');
  if (!m) return NaN;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) return NaN;
  const hoje = new Date();
  let a = hoje.getUTCFullYear() - d.getUTCFullYear();
  if (hoje.getUTCMonth() < d.getUTCMonth() || (hoje.getUTCMonth() === d.getUTCMonth() && hoje.getUTCDate() < d.getUTCDate())) a--;
  return a;
}
const centavos = v => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Erro(400, 'Valor inválido.');
  return v;
};

// ---------- sessões ----------
// Sessão de operador dura menos (12 h) e tem que ter sido aberta com o segundo fator.
const SESSAO_OPERADOR_HORAS = 12;
function criarSessao(res, req, usuarioId, { doisFatores = false, operador = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const dur = operador ? SESSAO_OPERADOR_HORAS * 3600e3 : SESSAO_DIAS * 864e5;
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, criado, expira, dois_fatores) VALUES (?, ?, ?, ?, ?)').run(sha(token), usuarioId, agora(), agora() + dur, doisFatores ? 1 : 0);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(dur / 1000)}${ehHttps(req) ? '; Secure' : ''}`);
}
function usuarioDaSessao(req) {
  const t = cookies(req)[COOKIE];
  if (!t || t.length > 100) return null;
  const s = db.prepare('SELECT u.*, s.expira, s.dois_fatores, s.token_hash AS sessao FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?').get(sha(t));
  if (!s) return null;
  if (s.expira < agora()) { db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha(t)); return null; }
  return s;
}
const publico = u => ({
  id: u.id, nome: u.nome, email: u.email || '', visitante: !!u.visitante, operador: !!u.operador,
  ...(u.visitante ? {} : { doisFatoresAtivo: !!u.totp_ativo, sessaoComDoisFatores: !!u.dois_fatores }),
});

// ---------- segundo fator (app autenticador; obrigatório para o operador e para sacar) ----------
const totp = require('./totp');
const desafios = new Map(); // token do desafio (login com senha certa, esperando o código) → { uid, ate, tentativas }
function conferirSegundoFator(u, codigo) {
  // 1) código do app (cada intervalo de 30 s vale uma vez só)
  const intervalo = u.totp_segredo ? totp.conferir(u.totp_segredo, codigo) : null;
  if (intervalo !== null && intervalo > u.totp_ultimo) {
    db.prepare('UPDATE usuarios SET totp_ultimo = ? WHERE id = ?').run(intervalo, u.id);
    return 'app';
  }
  // 2) código de reserva (uso único)
  const c = String(codigo || '').replace(/[\s-]/g, '').toLowerCase();
  if (/^[a-z0-9]{10}$/.test(c)) {
    const lista = JSON.parse(u.codigos_reserva || '[]');
    const i = lista.indexOf(sha(c));
    if (i >= 0) {
      lista.splice(i, 1);
      db.prepare('UPDATE usuarios SET codigos_reserva = ? WHERE id = ?').run(JSON.stringify(lista), u.id);
      return 'reserva';
    }
  }
  return null;
}
const novosCodigosReserva = () => Array.from({ length: 8 }, () => crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(10, '7').slice(0, 10));

// ---------- carteira ----------
const saldo = uid => db.prepare('SELECT COALESCE(SUM(valor), 0) AS s FROM movimentos WHERE usuario_id = ?').get(uid).s;
const lancar = (uid, tipo, valor, descricao, partidaId = null) =>
  db.prepare('INSERT INTO movimentos (usuario_id, tipo, valor, descricao, partida_id, criado) VALUES (?, ?, ?, ?, ?, ?)').run(uid, tipo, valor, descricao, partidaId, agora());
const moedas = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- regras e partidas ----------
let cfg; // config.js do jogo (normalize, DEFAULTS), o mesmo que a página de regras usa
const regrasAtuais = () => {
  const r = db.prepare("SELECT valor FROM config WHERE chave = 'regras'").get();
  return cfg.normalize(r ? JSON.parse(r.valor) : null);
};
const valorPorFruta = (entrada, regras) => Math.round(entrada * regras.fruitPercent / 100);
// quanto as frutas valem na partida (com limiar de ganho, as frutas depois dele valem o do nível novo)
const valorFrutasDa = p => cfg.valorDasFrutas(p.entrada, cfg.normalize(JSON.parse(p.regras)), p.frutas || 0);
const partidaPublica = (p, { comSemente = true } = {}) => p && ({
  id: p.id, modo: p.modo, entrada: p.entrada, ...(comSemente ? { semente: p.semente } : {}), regras: JSON.parse(p.regras), estado: p.estado,
  criada: p.criada, comecou: p.comecou, encerrada: p.encerrada,
  frutas: p.frutas, distancia: p.distancia, tempoMs: p.tempo_ms, porFruta: p.por_fruta, recebido: p.recebido,
  resultado: p.recebido == null ? null : p.recebido - p.entrada,
  verificacao: p.verificacao || null, frutasInformadas: p.frutas_informadas ?? null,
  analise: p.analise || null, aPagar: p.analise === 'pendente' ? valorFrutasDa(p) : null,
});
const partidaAberta = uid => db.prepare("SELECT * FROM partidas WHERE usuario_id = ? AND estado IN ('criada','jogando') ORDER BY criada DESC LIMIT 1").get(uid);
const idValido = id => /^p_[A-Za-z0-9_-]{6,30}$/.test(id);
const minhaPartida = (uid, id) => {
  if (!idValido(id)) throw new Erro(404, 'Partida não encontrada.');
  const p = db.prepare('SELECT * FROM partidas WHERE id = ? AND usuario_id = ?').get(id, uid);
  if (!p) throw new Erro(404, 'Partida não encontrada.');
  return p;
};

// ---------- gravação ----------
// Um código por passo de 1/60 s, em pares [código, repetições]. Código: bits 0–4 = desvio (0..16 = −1..+1 em
// oitavos; 17..31 não existem no jogo), bit 5 pulo, bit 6 pulo segurado. O bit 7 (giro) saiu do jogo: recusado.
const PASSOS_POR_SEGUNDO = 60;
const MAX_PARES = 200000;
const FOLGA_PASSOS = 3 * PASSOS_POR_SEGUNDO; // 3 s de folga para rede e relógios
function validarRle(rle) {
  if (!Array.isArray(rle) || rle.length > MAX_PARES) throw new Erro(400, 'Gravação inválida.');
  for (const par of rle) {
    if (!Array.isArray(par) || par.length !== 2) throw new Erro(400, 'Gravação inválida.');
    const [c, n] = par;
    if (!Number.isInteger(c) || c < 0 || c > 127 || (c & 31) > 16) throw new Erro(400, 'Gravação inválida.');
    if (!Number.isInteger(n) || n < 1 || n > DURACAO_MAX_MS / 1000 * PASSOS_POR_SEGUNDO) throw new Erro(400, 'Gravação inválida.');
  }
  return rle;
}
const somaPassos = rle => rle.reduce((a, [, n]) => a + n, 0);
// passos que cabem no tempo real desde o START (mais a folga)
const passosPermitidos = p => Math.floor(((agora() - (p.comecou || agora())) / 1000) * PASSOS_POR_SEGUNDO * 1.02) + FOLGA_PASSOS;
// A gravação só cresce: o que já chegou não muda. O pedaço novo começa no índice `desde`; se for o último par
// guardado (ele pode ter crescido), tem que ter o mesmo código e pelo menos as mesmas repetições.
function juntarGravacao(atual, desde, pedaco) {
  if (!Number.isInteger(desde) || desde < Math.max(0, atual.length - 1) || desde > atual.length) return null;
  if (desde === atual.length - 1 && pedaco.length) {
    const [c0, n0] = atual[desde], [c1, n1] = pedaco[0];
    if (c0 !== c1 || n1 < n0) return null;
  }
  return atual.slice(0, desde).concat(pedaco);
}
// A gravação final tem que começar exatamente com o que já tinha chegado (o último par pode ter crescido).
function ehContinuacao(atual, final) {
  if (final.length < atual.length) return false;
  for (let i = 0; i < atual.length; i++) {
    const [c0, n0] = atual[i], [c1, n1] = final[i];
    if (c0 !== c1) return false;
    if (i < atual.length - 1 ? n1 !== n0 : n1 < n0) return false;
  }
  return true;
}
function cortarNoTempo(rle, max) {
  const out = [];
  let total = 0;
  for (const [c, n] of rle) {
    if (total >= max) break;
    const k = Math.min(n, max - total);
    out.push([c, k]);
    total += k;
  }
  return out;
}

// Sinais de robô na gravação. Arrastar o dedo muda o desvio quase todo passo, então contar "mudanças" pegaria
// gente de verdade; o que uma pessoa não consegue é (a) inverter o sentido do desvio ou apertar/soltar botões
// dezenas de vezes por segundo e (b) pular muitas vezes por segundo (o pulo grava 1 passo por aperto).
function sinaisDaGravacao(rle) {
  let passo = 0, prev = null, sentido = 0;
  const viradas = [], pulos = [];
  for (const [c, n] of rle) {
    if (prev !== null) {
      if ((c ^ prev) & 0x40) viradas.push(passo);                  // pulo segurado apertado/solto
      const dx = (c & 31) - (prev & 31);
      if (dx !== 0) {
        const s = Math.sign(dx);
        if (sentido !== 0 && s !== sentido) viradas.push(passo);     // desvio mudou de sentido
        sentido = s;
      }
    }
    if (c & 32) pulos.push(passo);
    prev = c;
    passo += n;
  }
  const maxPorSegundo = lista => {
    let j = 0, max = 0;
    for (let i = 0; i < lista.length; i++) { while (lista[i] - lista[j] >= PASSOS_POR_SEGUNDO) j++; max = Math.max(max, i - j + 1); }
    return max;
  };
  return { passos: passo, pares: rle.length, viradasPorSegundoMax: maxPorSegundo(viradas), pulosPorSegundoMax: maxPorSegundo(pulos) };
}
const LIMITE_VIRADAS_POR_SEGUNDO = 20, LIMITE_PULOS_POR_SEGUNDO = 6;

// ---------- replay e fechamento ----------
const replaysEmAndamento = new Map(); // id da partida → promessa (o mesmo replay não roda duas vezes ao mesmo tempo)
const MAX_FILA_REPLAY = 100;
async function refazerPartida(p) {
  if (replaysEmAndamento.has(p.id)) return replaysEmAndamento.get(p.id);
  if (replaysEmAndamento.size >= MAX_FILA_REPLAY) throw new Erro(503, 'Servidor ocupado. Tente de novo em instantes.');
  const rle = cortarNoTempo(JSON.parse(p.entradas || '[]'), passosPermitidos(p));
  const prom = replay.refazer({ regras: JSON.parse(p.regras), semente: p.semente, rle })
    .then(r => ({ ...r, sinais: sinaisDaGravacao(rle) }))
    .finally(() => replaysEmAndamento.delete(p.id));
  replaysEmAndamento.set(p.id, prom);
  return prom;
}

// Encerra com o resultado do replay (r) — dentro de transação; não faz nada se a partida já terminou.
// Pagamento suspeito (robô) ou acima de `analiseAcimaDe` × a entrada não é creditado: fica em análise.
function finalizar(id, r, tempoMs) {
  const p = db.prepare('SELECT * FROM partidas WHERE id = ?').get(id);
  if (!p || p.estado !== 'jogando') return p;
  const regras = cfg.normalize(JSON.parse(p.regras));
  const porFruta = valorPorFruta(p.entrada, regras);
  const f = r ? r.frutas : 0;
  const valor = cfg.valorDasFrutas(p.entrada, regras, f);
  const inf = p.frutas_informadas;
  const verificacao = !r ? 'erro' : inf == null ? 'refeita' : inf === f ? 'confirmada' : 'divergente';
  const motivos = [];
  if (r && r.sinais.viradasPorSegundoMax > LIMITE_VIRADAS_POR_SEGUNDO) motivos.push(`comandos rápidos demais (${r.sinais.viradasPorSegundoMax} viradas/s)`);
  if (r && r.sinais.pulosPorSegundoMax > LIMITE_PULOS_POR_SEGUNDO) motivos.push(`pulos rápidos demais (${r.sinais.pulosPorSegundoMax}/s)`);
  if (valor > p.entrada * regras.analiseAcimaDe) motivos.push(`pagamento acima de ${regras.analiseAcimaDe}× a entrada`);
  if (verificacao === 'divergente') motivos.push('o jogo informou outro número de frutas');
  const emAnalise = valor > 0 && motivos.length > 0;
  const recebido = emAnalise ? 0 : valor;
  const l = regras.limiar, passou = l && f > l.frutas;
  if (recebido > 0) lancar(p.usuario_id, 'premio', recebido, passou
    ? `Frutas · ${l.frutas} × ${moedas(porFruta)} + ${f - l.frutas} × ${moedas(valorPorFruta(p.entrada, l.depois))} (após o limiar)`
    : `Frutas · ${f} × ${moedas(porFruta)}`, p.id);
  db.prepare(`UPDATE partidas SET estado = 'encerrada', encerrada = ?, frutas = ?, distancia = ?, tempo_ms = ?, por_fruta = ?,
      recebido = ?, verificacao = ?, analise = ?, motivo_analise = ?, sinais = ? WHERE id = ?`)
    .run(agora(), f, r ? r.distancia : 0, Math.max(0, Math.min(DURACAO_MAX_MS, Math.round(Number(tempoMs) || 0))), porFruta, recebido, verificacao,
      emAnalise ? 'pendente' : null, motivos.join('; ') || null, r ? JSON.stringify(r.sinais) : null, p.id);
  if (emAnalise) auditar('partida_em_analise', { u: p.usuario_id, detalhe: { partida: p.id, frutas: f, valor, motivos } });
  else if (verificacao !== 'confirmada') auditar(`partida_${verificacao}`, { u: p.usuario_id, detalhe: { partida: p.id, informadas: inf, replay: f } });
  return db.prepare('SELECT * FROM partidas WHERE id = ?').get(p.id);
}
async function encerrarComReplay(p, tempoMs) {
  let r = null;
  try { r = await refazerPartida(p); } catch (e) {
    if (e instanceof Erro) throw e;
    console.error('[replay] falhou:', e.message);
  }
  return transacao(() => finalizar(p.id, r, tempoMs));
}
function cancelar(p) {
  lancar(p.usuario_id, 'estorno', p.entrada, 'Partida cancelada antes do início', p.id);
  db.prepare("UPDATE partidas SET estado = 'cancelada', encerrada = ? WHERE id = ?").run(agora(), p.id);
}
// Partida que ficou aberta (página fechada): antes do START é estornada; durante, o servidor refaz a corrida
// com a gravação que recebeu até ali.
async function resolverPendente(uid) {
  const p = partidaAberta(uid);
  if (!p) return null;
  if (p.estado === 'criada') { transacao(() => { const q = partidaAberta(uid); if (q && q.estado === 'criada') cancelar(q); }); return null; }
  return encerrarComReplay(p, agora() - (p.comecou || agora()));
}

// ---------- rotas ----------
const rotas = [];
const rota = (metodo, padrao, opcoes, fn) => rotas.push({ metodo, padrao: new RegExp(`^${padrao}$`), ...opcoes, fn });

// conta
// Confirmação de e-mail: desligada por padrão (o cadastro já entra). ARENA_CONFIRMAR_EMAIL=1 volta a exigir o link.
const CONFIRMAR_EMAIL = process.env.ARENA_CONFIRMAR_EMAIL === '1';
rota('POST', '/api/cadastro', {}, ({ corpo, res, req, ip }) => {
  limitar(`cadastro:${ip}`, CONTAS_POR_HORA, 60 * 60e3, 'Muitas contas criadas daqui. Tente mais tarde.');
  const nome = texto(corpo.nome, 30), email = texto(corpo.email, 120).toLowerCase(), senha = String(corpo.senha || '');
  if (!nome) throw new Erro(400, 'Escolha um nome de jogador.');
  if (!emailValido(email)) throw new Erro(400, 'Informe um e-mail válido.');
  const ruim = senhaForte(senha);
  if (ruim) throw new Erro(400, ruim);
  const a = idade(corpo.nascimento);
  if (!(a >= 0 && a < 130)) throw new Erro(400, 'Informe sua data de nascimento.');
  if (a < IDADE_MIN) { auditar('cadastro_menor', { ip }); throw new Erro(403, 'O Crash Arena é só para maiores de 18 anos.'); }
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new Erro(409, 'Já existe uma conta com esse e-mail.');
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, nascimento, criado, email_confirmado) VALUES (?, ?, ?, ?, ?, ?)').run(nome, email, hashSenha(senha), corpo.nascimento, agora(), CONFIRMAR_EMAIL ? 0 : 1);
  auditar('cadastro', { u: Number(r.lastInsertRowid), ip });
  if (CONFIRMAR_EMAIL) {
    // a conta só entra depois de confirmar o e-mail (link enviado agora)
    enviarConfirmacao(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(r.lastInsertRowid), req);
    return { confirmar: true, email };
  }
  criarSessao(res, req, Number(r.lastInsertRowid));
  return { usuario: publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(r.lastInsertRowid)) };
});
rota('POST', '/api/login', {}, ({ corpo, res, req, ip }) => {
  const email = texto(corpo.email, 120).toLowerCase();
  limitar(`login-ip:${ip}`, LOGINS_POR_IP, 10 * 60e3, 'Muitas tentativas. Espere alguns minutos e tente de novo.');
  limitar(`login-conta:${email}`, 10, 15 * 60e3, 'Muitas tentativas nesta conta. Espere 15 minutos.');
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  // confere mesmo sem conta (com um hash falso), para o tempo de resposta não revelar quais e-mails existem
  const ok = confereSenha(String(corpo.senha || ''), u?.senha_hash);
  if (!u || !ok) { auditar('login_falhou', { u: u?.id, ip, detalhe: email }); throw new Erro(401, 'E-mail ou senha incorretos.'); }
  baldes.delete(`login-conta:${email}`);
  if (CONFIRMAR_EMAIL && !u.email_confirmado) throw new Erro(403, 'Confirme seu e-mail para entrar. Procure o link que enviamos (veja também o spam).', 'confirmar_email');
  // conta com app autenticador: a senha certa só abre um desafio; a sessão vem depois do código
  if (u.totp_ativo) {
    const desafio = crypto.randomBytes(24).toString('base64url');
    desafios.set(desafio, { uid: u.id, ate: agora() + 5 * 60e3, tentativas: 0 });
    auditar('login_senha_ok_esperando_codigo', { u, ip });
    return { precisa2fa: true, desafio };
  }
  criarSessao(res, req, u.id, { operador: !!u.operador });
  auditar(u.operador ? 'login_operador' : 'login', { u, ip });
  return { usuario: publico(u) };
});
// Segundo passo do login: código do app (ou de reserva).
rota('POST', '/api/login/2fa', {}, ({ corpo, res, req, ip }) => {
  limitar(`login2fa:${ip}`, 20, 10 * 60e3, 'Muitas tentativas. Espere alguns minutos.');
  const d = desafios.get(String(corpo.desafio || ''));
  if (!d || d.ate < agora()) throw new Erro(401, 'O tempo para digitar o código acabou. Entre de novo.');
  if (++d.tentativas > 5) { desafios.delete(corpo.desafio); throw new Erro(401, 'Muitos códigos errados. Entre de novo.'); }
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(d.uid);
  const tipo = u && conferirSegundoFator(u, corpo.codigo);
  if (!tipo) { auditar('codigo_2fa_errado', { u: d.uid, ip }); throw new Erro(401, 'Código incorreto.'); }
  desafios.delete(corpo.desafio);
  criarSessao(res, req, u.id, { doisFatores: true, operador: !!u.operador });
  const ev = u.operador ? 'login_operador' : 'login';
  auditar(tipo === 'reserva' ? `${ev}_codigo_reserva` : ev, { u, ip });
  return { usuario: publico({ ...u, dois_fatores: 1 }), restamCodigosReserva: JSON.parse(db.prepare('SELECT codigos_reserva FROM usuarios WHERE id = ?').get(u.id).codigos_reserva).length };
});
setInterval(() => { const t = agora(); for (const [k, d] of desafios) if (d.ate < t) desafios.delete(k); }, 60e3).unref();
// Jogador anônimo (visitante): conta sem e-mail nem senha, confirmando 18+. Joga com moedas simuladas, mas
// não saca nem ativa o app autenticador (essas rotas recusam visitante).
rota('POST', '/api/visitante', {}, ({ corpo, res, req, ip }) => {
  // a tela de entrada não oferece mais visitante; sem ARENA_VISITANTES=1 a rota fica fechada (antes dava para criar
  // contas anônimas direto pela API mesmo sem o botão)
  if (process.env.ARENA_VISITANTES !== '1') throw new Erro(404, 'Rota não encontrada.');
  limitar(`visitante:${ip}`, CONTAS_POR_HORA, 60 * 60e3, 'Muitas contas de visitante criadas daqui. Tente mais tarde.');
  if (corpo.maior18 !== true) throw new Erro(400, 'Confirme que você tem 18 anos ou mais.');
  const r = db.prepare('INSERT INTO usuarios (nome, visitante, criado) VALUES (?, 1, ?)').run('Visitante', agora());
  criarSessao(res, req, Number(r.lastInsertRowid));
  auditar('visitante', { u: Number(r.lastInsertRowid), ip });
  return { usuario: publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(r.lastInsertRowid)) };
});
rota('POST', '/api/sair', {}, ({ req, res }) => {
  const t = cookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  return { ok: true };
});
rota('GET', '/api/eu', {}, ({ u }) => (u ? { usuario: publico(u), saldo: saldo(u.id) } : { usuario: null }));
rota('PATCH', '/api/eu', { login: true }, ({ u, corpo, ip, req }) => {
  limitar(`perfil:${u.id}`, 10, 10 * 60e3);
  const nome = texto(corpo.nome, 30), email = texto(corpo.email, 120).toLowerCase();
  if (!nome) throw new Erro(400, 'O nome não pode ficar vazio.');
  if (u.visitante) {
    db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(nome, u.id);
    return { usuario: publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id)) };
  }
  if (!emailValido(email)) throw new Erro(400, 'Informe um e-mail válido.');
  // trocar e-mail ou senha exige a senha atual (quem pegar a sessão não toma a conta)
  const sensivel = email !== u.email || corpo.novaSenha;
  if (sensivel && !confereSenha(String(corpo.senhaAtual || ''), u.senha_hash)) {
    auditar('perfil_senha_errada', { u, ip });
    throw new Erro(401, email !== u.email ? 'Para trocar o e-mail, informe a senha atual.' : 'A senha atual não confere.');
  }
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ? AND id <> ?').get(email, u.id)) throw new Erro(409, 'Esse e-mail já está em uso.');
  transacao(() => {
    if (corpo.novaSenha) {
      const ruim = senhaForte(corpo.novaSenha);
      if (ruim) throw new Erro(400, ruim);
      db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(String(corpo.novaSenha)), u.id);
      // derruba as outras sessões
      db.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash <> ?').run(u.id, sha(cookies(req)[COOKIE] || ''));
    }
    db.prepare('UPDATE usuarios SET nome = ?, email = ? WHERE id = ?').run(nome, email, u.id);
    if (email !== u.email && CONFIRMAR_EMAIL) db.prepare('UPDATE usuarios SET email_confirmado = 0 WHERE id = ?').run(u.id);
  });
  if (email !== u.email && CONFIRMAR_EMAIL) enviarConfirmacao(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id), req);
  if (sensivel) auditar('perfil_alterado', { u, ip, detalhe: { email: email !== u.email, senha: !!corpo.novaSenha } });
  return { usuario: publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id)) };
});
// Recuperação de senha: link de uso único (30 min), enviado por e-mail (servidor/email.js; sem SMTP configurado,
// sai no console). A resposta é sempre a mesma e o envio não é esperado, para não revelar quais e-mails têm conta.
// O endereço do link vem de ARENA_SITE_URL (obrigatório com SMTP), nunca do cabeçalho Host do pedido: quem
// forjar o Host não consegue mandar ao jogador um link apontando para outro site.
const correio = require('./email');
const SITE_URL = (process.env.ARENA_SITE_URL || '').replace(/\/+$/, '');
if (correio.configurado() && !/^https:\/\//.test(SITE_URL)) { console.error('Com ARENA_SMTP_URL, defina ARENA_SITE_URL=https://seu-site'); process.exit(1); }
// Confirmação de e-mail: link de uso único (24 h) para o e-mail cadastrado.
function enviarConfirmacao(u, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO confirmacoes (token_hash, usuario_id, email, expira) VALUES (?, ?, ?, ?)').run(sha(token), u.id, u.email, agora() + 24 * 3600e3);
  const link = `${SITE_URL || `http://${req.headers.host}`}/confirmar/?token=${token}`;
  correio.enviar({
    para: u.email, assunto: 'Crash Arena: confirme seu e-mail',
    texto: `Olá, ${u.nome}.\n\nFalta pouco! Confirme seu e-mail para entrar no Crash Arena:\n\n${link}\n\n` +
      'O link vale por 24 horas. Se você não criou esta conta, ignore este e-mail.\n',
    html: correio.modelo({ titulo: 'Confirme seu e-mail', nome: u.nome, texto: 'Falta pouco! Confirme seu e-mail para entrar no Crash Arena.', botao: 'CONFIRMAR E-MAIL', link, rodape: 'O link vale por 24 horas. Se você não criou esta conta, ignore este e-mail.' }),
  }).catch(e => { console.error('[e-mail] falhou:', e.message); auditar('confirmacao_email_falhou', { u, detalhe: e.message.slice(0, 200) }); });
}
rota('POST', '/api/confirmar', {}, ({ corpo, res, req, ip }) => {
  limitar(`confirmar:${ip}`, 20, 15 * 60e3);
  const c = db.prepare('SELECT * FROM confirmacoes WHERE token_hash = ?').get(sha(String(corpo.token || '').slice(0, 100)));
  const u = c && db.prepare('SELECT * FROM usuarios WHERE id = ?').get(c.usuario_id);
  if (!c || c.usado || c.expira < agora() || !u || u.email !== c.email) throw new Erro(400, 'Link inválido ou vencido. Entre com seu e-mail e senha para receber um novo.');
  transacao(() => {
    db.prepare('UPDATE usuarios SET email_confirmado = 1 WHERE id = ?').run(u.id);
    db.prepare('UPDATE confirmacoes SET usado = 1 WHERE usuario_id = ?').run(u.id);
  });
  auditar('email_confirmado', { u, ip });
  // conta com app autenticador ou operador: confirma, mas a sessão vem pelo login normal (com o código)
  if (u.totp_ativo || u.operador) return { ok: true, entrar: true };
  criarSessao(res, req, u.id);
  return { ok: true, usuario: publico({ ...u, email_confirmado: 1 }) };
});
// Reenviar o link: pede a senha (assim ninguém enche a caixa de outra pessoa) e responde sempre igual.
rota('POST', '/api/confirmar/reenviar', {}, ({ corpo, req, ip }) => {
  const email = texto(corpo.email, 120).toLowerCase();
  limitar(`reenviar-ip:${ip}`, 5, 15 * 60e3);
  limitar(`reenviar-conta:${email}`, 3, 60 * 60e3, 'Já enviamos alguns links. Espere um pouco e veja a caixa de spam.');
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  const ok = confereSenha(String(corpo.senha || ''), u?.senha_hash);
  if (u && ok && !u.email_confirmado) enviarConfirmacao(u, req);
  return { ok: true, mensagem: 'Se o e-mail e a senha estiverem certos, enviamos um novo link de confirmação.' };
});
rota('POST', '/api/recuperar', {}, ({ corpo, req, ip }) => {
  const email = texto(corpo.email, 120).toLowerCase();
  limitar(`recuperar-ip:${ip}`, 5, 15 * 60e3);
  limitar(`recuperar-conta:${email}`, 3, 60 * 60e3);
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (u) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO recuperacoes (token_hash, usuario_id, expira) VALUES (?, ?, ?)').run(sha(token), u.id, agora() + 30 * 60e3);
    const link = `${SITE_URL || `http://${req.headers.host}`}/redefinir/?token=${token}`;
    correio.enviar({
      para: u.email, assunto: 'Crash Arena: criar uma nova senha',
      texto: `Olá, ${u.nome}.\n\nAlguém (provavelmente você) pediu para criar uma nova senha no Crash Arena. ` +
        `Abra o link abaixo em até 30 minutos:\n\n${link}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.\n`,
      html: correio.modelo({ titulo: 'Crie uma nova senha', nome: u.nome, texto: 'Alguém (provavelmente você) pediu para criar uma nova senha no Crash Arena.', botao: 'CRIAR NOVA SENHA', link, rodape: 'O link vale por 30 minutos e uma vez só. Se não foi você, ignore este e-mail: sua senha continua a mesma.' }),
    }).catch(e => { console.error('[e-mail] falhou:', e.message); auditar('recuperacao_email_falhou', { u, detalhe: e.message.slice(0, 200) }); });
    auditar('recuperacao_pedida', { u, ip });
  }
  return { ok: true, mensagem: 'Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha.' };
});
rota('POST', '/api/redefinir', {}, ({ corpo, res, req, ip }) => {
  limitar(`redefinir:${ip}`, 10, 15 * 60e3);
  const r = db.prepare('SELECT * FROM recuperacoes WHERE token_hash = ?').get(sha(String(corpo.token || '').slice(0, 100)));
  if (!r || r.usado || r.expira < agora()) throw new Erro(400, 'Link inválido ou vencido. Peça um novo.');
  const ruim = senhaForte(corpo.senha);
  if (ruim) throw new Erro(400, ruim);
  transacao(() => {
    db.prepare('UPDATE usuarios SET senha_hash = ?, email_confirmado = 1 WHERE id = ?').run(hashSenha(String(corpo.senha)), r.usuario_id);
    db.prepare('UPDATE recuperacoes SET usado = 1 WHERE usuario_id = ?').run(r.usuario_id); // vale para todos os links pendentes
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(r.usuario_id);                // derruba sessões antigas
  });
  criarSessao(res, req, r.usuario_id);
  auditar('senha_redefinida', { u: r.usuario_id, ip });
  return { ok: true };
});

// carteira
// Bônus de boas-vindas: depositar exatamente R$ 5 dá mais R$ 10 de bônus (R$ 15 no total), uma vez por conta.
const BONUS = { deposito: 500, extra: 1000 };
const bonusDisponivel = uid => {
  const r = db.prepare('SELECT visitante, bonus_deposito FROM usuarios WHERE id = ?').get(uid);
  return !!r && !r.visitante && !r.bonus_deposito;
};
rota('GET', '/api/carteira', { login: true }, ({ u }) => ({
  saldo: saldo(u.id),
  bonus: bonusDisponivel(u.id) ? BONUS : null,
  movimentos: db.prepare('SELECT tipo, valor, descricao, partida_id AS partida, criado AS quando FROM movimentos WHERE usuario_id = ? ORDER BY id DESC LIMIT 200').all(u.id),
}));
rota('POST', '/api/carteira/deposito', { login: true }, ({ u, corpo }) => {
  limitar(`carteira:${u.id}`, 20, 60e3);
  return transacao(() => {
    const v = centavos(corpo.valor);
    if (v < 100 || v > LIMITE_MOVIMENTO) throw new Erro(400, 'Informe um valor entre R$ 1 e R$ 10.000.');
    lancar(u.id, 'deposito', v, `Depósito simulado (${corpo.metodo === 'card' ? 'cartão' : 'Pix'})`);
    // bônus: marca a conta e credita na mesma transação; o UPDATE só muda a linha se o bônus ainda não foi usado,
    // então dois depósitos ao mesmo tempo não ganham duas vezes
    let bonus = 0;
    if (v === BONUS.deposito && !u.visitante && db.prepare('UPDATE usuarios SET bonus_deposito = 1 WHERE id = ? AND bonus_deposito = 0').run(u.id).changes === 1) {
      bonus = BONUS.extra;
      lancar(u.id, 'deposito', bonus, 'Bônus de boas-vindas · depositou R$ 5, ganhou + R$ 10');
      auditar('bonus_deposito', { u, detalhe: { valor: bonus } });
    }
    return { saldo: saldo(u.id), bonus };
  });
});
// Sacar exige o app autenticador ativo e o código dele (ou de reserva) em cada saque: quem roubar a senha
// ou a sessão não tira o dinheiro.
rota('POST', '/api/carteira/saque', { login: true }, ({ u, corpo, ip }) => {
  limitar(`carteira:${u.id}`, 20, 60e3);
  if (u.visitante) throw new Erro(403, 'Visitantes não podem sacar. Crie uma conta para sacar.');
  if (!u.totp_ativo) throw new Erro(403, 'Para sacar, ative a verificação em duas etapas em Minha conta.', 'configurar_2fa');
  if (!corpo.codigo) throw new Erro(401, 'Digite o código do app autenticador.', 'precisa_codigo');
  limitar(`saque-codigo:${u.id}`, 10, 15 * 60e3, 'Muitas tentativas de código. Espere 15 minutos.');
  if (!conferirSegundoFator(u, corpo.codigo)) {
    // cada código do app vale uma vez: dois saques seguidos precisam esperar o próximo (até 30 s)
    if (totp.conferir(u.totp_segredo, corpo.codigo) !== null) throw new Erro(401, 'Esse código já foi usado. Espere o próximo código do app (até 30 s).', 'precisa_codigo');
    auditar('saque_codigo_errado', { u, ip });
    throw new Erro(401, 'Código incorreto.', 'precisa_codigo');
  }
  return transacao(() => {
    const v = centavos(corpo.valor);
    if (v < 100 || v > LIMITE_MOVIMENTO) throw new Erro(400, 'Informe um valor entre R$ 1 e R$ 10.000.');
    if (v > saldo(u.id)) throw new Erro(400, 'Moedas insuficientes para esse saque.');
    lancar(u.id, 'saque', -v, 'Saque simulado');
    auditar('saque', { u, ip, detalhe: { valor: v } });
    return { saldo: saldo(u.id) };
  });
});

// partidas
rota('GET', '/api/partida', { login: true }, ({ u }) => ({ partida: partidaPublica(partidaAberta(u.id)) }));
rota('POST', '/api/partida/resolver', { login: true }, async ({ u }) => {
  limitar(`resolver:${u.id}`, 30, 60e3);
  return { encerrada: partidaPublica(await resolverPendente(u.id)) };
});
rota('GET', '/api/partidas', { login: true }, ({ u }) => ({
  partidas: db.prepare("SELECT * FROM partidas WHERE usuario_id = ? AND estado = 'encerrada' ORDER BY encerrada DESC LIMIT 50").all(u.id).map(p => partidaPublica(p)),
}));
rota('GET', '/api/resultado', { login: true }, ({ u }) => ({
  partida: partidaPublica(db.prepare("SELECT * FROM partidas WHERE usuario_id = ? AND estado = 'encerrada' ORDER BY encerrada DESC LIMIT 1").get(u.id)),
  saldo: saldo(u.id),
}));
rota('POST', '/api/partidas', { login: true }, async ({ u, corpo }) => {
  limitar(`nova-partida:${u.id}`, 20, 60e3, 'Muitas partidas seguidas. Espere um pouco.');
  await resolverPendente(u.id);
  return transacao(() => {
    if (partidaAberta(u.id)) throw new Erro(409, 'Você já tem uma partida aberta.');
    const entrada = centavos(corpo.entrada);
    if (entrada < ENTRADA_MIN) throw new Erro(400, 'A entrada mínima é 1 moeda.');
    if (entrada > ENTRADA_MAX) throw new Erro(400, 'A entrada máxima é 10.000 moedas.');
    if (entrada > saldo(u.id)) throw new Erro(400, 'Saldo insuficiente para essa entrada.');
    const id = 'p_' + crypto.randomBytes(12).toString('base64url');
    const semente = crypto.randomInt(0, 2 ** 31);
    // fluxo de partidas: a N-ª partida do jogador (sem contar as canceladas antes do START) usa a dificuldade da
    // posição N do fluxo; depois da última, recomeça. As regras ficam congeladas na partida (o replay usa estas).
    const feitas = db.prepare("SELECT COUNT(*) AS n FROM partidas WHERE usuario_id = ? AND estado <> 'cancelada'").get(u.id).n;
    const posicao = feitas % cfg.FLUXO_TAM;
    const regras = { ...cfg.regrasNoFluxo(regrasAtuais(), posicao), fluxoPosicao: posicao + 1 };
    db.prepare("INSERT INTO partidas (id, usuario_id, entrada, semente, regras, estado, criada) VALUES (?, ?, ?, ?, ?, 'criada', ?)")
      .run(id, u.id, entrada, semente, JSON.stringify(regras), agora());
    lancar(u.id, 'entrada', -entrada, 'Entrada · Desafio solo', id);
    return { partida: partidaPublica(db.prepare('SELECT * FROM partidas WHERE id = ?').get(id)), saldo: saldo(u.id) };
  });
});
rota('POST', '/api/partidas/([\\w-]+)/comecar', { login: true }, ({ u, m }) => {
  limitar(`partida-acao:${u.id}`, 30, 60e3);
  return transacao(() => {
    const p = minhaPartida(u.id, m[1]);
    if (p.estado === 'criada') db.prepare("UPDATE partidas SET estado = 'jogando', comecou = ? WHERE id = ?").run(agora(), p.id);
    else if (p.estado !== 'jogando') throw new Erro(409, 'Essa partida já terminou.');
    return { partida: partidaPublica(db.prepare('SELECT * FROM partidas WHERE id = ?').get(p.id)) };
  });
});
// Pedaço novo da gravação. Só acrescenta (não reescreve o que já chegou) e não pode passar do tempo real.
// Responde quantos pares estão guardados, para o jogo saber de onde continuar.
rota('POST', '/api/partidas/([\\w-]+)/progresso', { login: true, corpoMax: CORPO_GRAVACAO }, ({ u, m, corpo }) => {
  limitar(`progresso:${u.id}`, 120, 60e3);
  let adiantada = null;
  const r = transacao(() => {
    const p = minhaPartida(u.id, m[1]);
    if (p.estado !== 'jogando') return { ok: false };
    const atual = JSON.parse(p.entradas || '[]');
    const novo = juntarGravacao(atual, corpo.desde, validarRle(corpo.rle || []));
    if (!novo) return { ok: false, pares: atual.length }; // fora de ordem: o jogo continua de onde o servidor está
    if (novo.length > MAX_PARES) throw new Erro(400, 'Gravação grande demais.');
    const passos = somaPassos(novo);
    if (passos > passosPermitidos(p)) {
      adiantada = { partida: p.id, passos, permitido: passosPermitidos(p) };
      return null; // nada é gravado; o registro e a recusa vêm fora da transação
    }
    const informadas = Number.isInteger(corpo.frutas) && corpo.frutas >= 0 ? Math.min(corpo.frutas, 1e6) : 0;
    db.prepare('UPDATE partidas SET entradas = ?, passos = ?, frutas = MAX(frutas, ?), distancia = MAX(distancia, ?), versao = ? WHERE id = ?')
      .run(JSON.stringify(novo), passos, informadas, Math.max(0, Math.min(1e9, Math.round(Number(corpo.distancia) || 0))), Number.isInteger(corpo.versao) ? corpo.versao : null, p.id);
    return { ok: true, pares: novo.length };
  });
  if (adiantada) {
    auditar('gravacao_adiantada', { u, detalhe: adiantada });
    throw new Erro(400, 'Gravação adiantada em relação ao tempo real.');
  }
  return r;
});
rota('POST', '/api/partidas/([\\w-]+)/cancelar', { login: true }, ({ u, m }) => {
  limitar(`partida-acao:${u.id}`, 30, 60e3);
  return transacao(() => {
    const p = minhaPartida(u.id, m[1]);
    if (p.estado !== 'criada') throw new Erro(409, 'Só dá para cancelar antes de começar.');
    cancelar(p);
    return { saldo: saldo(u.id) };
  });
});
// Fim: guarda a gravação inteira (que tem que continuar a que já chegou), refaz a corrida e paga as frutas
// que o replay confirma (ou deixa em análise).
rota('POST', '/api/partidas/([\\w-]+)/encerrar', { login: true, corpoMax: CORPO_GRAVACAO }, async ({ u, m, corpo }) => {
  limitar(`partida-acao:${u.id}`, 30, 60e3);
  let p = minhaPartida(u.id, m[1]);
  if (p.estado === 'encerrada') return { partida: partidaPublica(p), saldo: saldo(u.id), repetido: true };
  if (p.estado !== 'jogando') throw new Erro(409, 'Essa partida não está em andamento.');
  const rle = validarRle(corpo.rle || []);
  const informadas = Number.isInteger(corpo.frutas) && corpo.frutas >= 0 ? Math.min(corpo.frutas, 1e6) : null;
  transacao(() => {
    const q = minhaPartida(u.id, m[1]);
    if (q.estado !== 'jogando') return;
    const atual = JSON.parse(q.entradas || '[]');
    let usar = atual;
    if (ehContinuacao(atual, rle)) usar = cortarNoTempo(rle, passosPermitidos(q));
    else auditar('gravacao_reescrita', { u, detalhe: { partida: q.id } }); // tentou trocar o passado: vale o que já tinha chegado
    db.prepare('UPDATE partidas SET entradas = ?, passos = ?, frutas_informadas = ?, versao = ? WHERE id = ?')
      .run(JSON.stringify(usar), somaPassos(usar), informadas, Number.isInteger(corpo.versao) ? corpo.versao : null, q.id);
  });
  p = minhaPartida(u.id, m[1]);
  const fim = p.estado === 'jogando' ? await encerrarComReplay(p, corpo.tempoMs) : p;
  return { partida: partidaPublica(fim), saldo: saldo(u.id) };
});

// Ativar o app autenticador (obrigatório para o operador antes de qualquer ação e para o jogador sacar).
// 1) iniciar: confirma a senha, gera o segredo (ainda inativo) e devolve o link otpauth:// para o app;
// 2) confirmar: digita o código do app; ativa e devolve 8 códigos de reserva (mostrados uma vez).
// As mesmas funções atendem /api/admin/2fa/* (página do operador) e /api/conta/2fa/* (jogador).
// Operador: além da senha, cadastrar o app exige o código de ativação que só existe no servidor
// (dados/codigo-ativacao-operador.txt, legível só pelo serviço). Assim, quem descobrir a senha do operador antes
// de ele ativar o app não consegue cadastrar o próprio celular e tomar a conta.
let codigoAtivacaoHash = null;
function prepararCodigoAtivacao() {
  const arq = path.join(path.dirname(require('./banco').arquivo), 'codigo-ativacao-operador.txt');
  if (!db.prepare('SELECT 1 FROM usuarios WHERE operador = 1 AND totp_ativo = 0').get()) {
    codigoAtivacaoHash = null;
    try { fs.unlinkSync(arq); } catch {}
    return;
  }
  const codigo = crypto.randomBytes(6).toString('hex').toUpperCase(); // novo a cada vez que o servidor sobe
  codigoAtivacaoHash = sha(codigo);
  try { fs.writeFileSync(arq, `${codigo}\n`, { mode: 0o600 }); } catch (e) { console.error('[2fa] não gravou o código de ativação:', e.message); }
  console.log(`Operador sem app autenticador: código de ativação em ${arq}`);
}
const confereCodigoAtivacao = c => {
  if (!codigoAtivacaoHash) return false;
  const a = Buffer.from(sha(String(c || '').trim().toUpperCase())), b = Buffer.from(codigoAtivacaoHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function iniciar2fa({ u, corpo, ip }) {
  if (u.visitante) throw new Erro(403, 'Crie uma conta para ativar a verificação em duas etapas.');
  limitar(`2fa-config:${u.id}`, 10, 15 * 60e3);
  if (u.totp_ativo) throw new Erro(409, 'O app autenticador já está ativo nesta conta.');
  if (!confereSenha(String(corpo.senha || ''), u.senha_hash)) { auditar('2fa_senha_errada', { u, ip }); throw new Erro(401, 'Senha incorreta.'); }
  if (u.operador && !confereCodigoAtivacao(corpo.codigoAtivacao)) {
    auditar('2fa_codigo_ativacao_errado', { u, ip });
    throw new Erro(403, 'Código de ativação incorreto. Ele fica no servidor, no arquivo dados/codigo-ativacao-operador.txt.', 'codigo_ativacao');
  }
  const segredo = totp.novoSegredo();
  db.prepare('UPDATE usuarios SET totp_segredo = ?, totp_ativo = 0 WHERE id = ?').run(segredo, u.id);
  return { segredo, uri: totp.uri(segredo, u.email || `conta-${u.id}`) };
}
function confirmar2fa({ u, corpo, ip }) {
  if (u.visitante) throw new Erro(403, 'Crie uma conta para ativar a verificação em duas etapas.');
  limitar(`2fa-config:${u.id}`, 10, 15 * 60e3);
  if (u.totp_ativo) throw new Erro(409, 'O app autenticador já está ativo nesta conta.');
  if (!u.totp_segredo) throw new Erro(400, 'Comece pela etapa 1.');
  const intervalo = totp.conferir(u.totp_segredo, corpo.codigo);
  if (intervalo === null) throw new Erro(400, 'Código incorreto. Confira se o relógio do celular está certo.');
  const codigos = novosCodigosReserva();
  transacao(() => {
    db.prepare('UPDATE usuarios SET totp_ativo = 1, totp_ultimo = ?, codigos_reserva = ? WHERE id = ?').run(intervalo, JSON.stringify(codigos.map(sha)), u.id);
    db.prepare('UPDATE sessoes SET dois_fatores = 1 WHERE token_hash = ?').run(u.sessao);
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash <> ?').run(u.id, u.sessao); // outras sessões saem
  });
  auditar('2fa_ativado', { u, ip });
  if (u.operador) prepararCodigoAtivacao(); // ativou: o código deixa de valer (e o arquivo some)
  return { ok: true, codigosReserva: codigos };
}
rota('POST', '/api/admin/2fa/iniciar', { operador: true, configurar2fa: true }, iniciar2fa);
rota('POST', '/api/admin/2fa/confirmar', { operador: true, configurar2fa: true }, confirmar2fa);
rota('POST', '/api/conta/2fa/iniciar', { login: true }, iniciar2fa);
rota('POST', '/api/conta/2fa/confirmar', { login: true }, confirmar2fa);
// Desligar (só jogador; o operador não pode ficar sem): senha + código do app ou de reserva.
rota('POST', '/api/conta/2fa/desativar', { login: true }, ({ u, corpo, ip }) => {
  if (u.operador) throw new Erro(403, 'A conta de operador não pode desligar a verificação em duas etapas.');
  if (!u.totp_ativo) throw new Erro(409, 'A verificação em duas etapas não está ativa.');
  limitar(`2fa-config:${u.id}`, 10, 15 * 60e3);
  if (!confereSenha(String(corpo.senha || ''), u.senha_hash)) { auditar('2fa_senha_errada', { u, ip }); throw new Erro(401, 'Senha incorreta.'); }
  if (!conferirSegundoFator(u, corpo.codigo)) { auditar('codigo_2fa_errado', { u, ip }); throw new Erro(401, 'Código incorreto.'); }
  db.prepare("UPDATE usuarios SET totp_ativo = 0, totp_segredo = NULL, codigos_reserva = '[]' WHERE id = ?").run(u.id);
  auditar('2fa_desativado', { u, ip });
  return { ok: true };
});

rota('GET', '/api/admin/local', {}, ({ req }) => ({ local: adminLocal(req) }));
// regras (o jogo lê as da partida; o operador edita as atuais)
rota('GET', '/api/regras', {}, () => ({ regras: regrasAtuais() }));
rota('PUT', '/api/admin/regras', { operador: true }, ({ corpo, u, ip }) => {
  const antes = regrasAtuais();
  // o limiar resolvido (frutas, regras do nível novo) é calculado na criação de cada partida, nunca vem de fora
  const r = cfg.normalize(corpo.regras && typeof corpo.regras === 'object' ? { ...corpo.regras, limiar: null } : {});
  db.prepare("INSERT INTO config (chave, valor) VALUES ('regras', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(JSON.stringify(r));
  auditar('regras_alteradas', { u, ip, detalhe: { antes, depois: r } });
  return { regras: r };
});
// análise de pagamentos (operador)
rota('GET', '/api/admin/analises', { operador: true }, () => ({
  partidas: db.prepare(`SELECT p.*, us.nome AS jogador, us.email AS email FROM partidas p JOIN usuarios us ON us.id = p.usuario_id
      WHERE p.analise = 'pendente' ORDER BY p.encerrada LIMIT 200`).all()
    .map(p => ({ ...partidaPublica(p, { comSemente: false }), jogador: p.jogador, email: p.email || '', motivo: p.motivo_analise, sinais: p.sinais ? JSON.parse(p.sinais) : null })),
}));
rota('POST', '/api/admin/analises/([\\w-]+)', { operador: true }, ({ m, corpo, u, ip }) => transacao(() => {
  if (!idValido(m[1])) throw new Erro(404, 'Partida não encontrada.');
  const p = db.prepare('SELECT * FROM partidas WHERE id = ?').get(m[1]);
  if (!p || p.analise !== 'pendente') throw new Erro(409, 'Essa partida não está em análise.');
  const aprovar = corpo.decisao === 'aprovar';
  if (!aprovar && corpo.decisao !== 'recusar') throw new Erro(400, 'Decisão inválida.');
  const valor = valorFrutasDa(p);
  if (aprovar && valor > 0) lancar(p.usuario_id, 'premio', valor, `Frutas (após análise) · ${p.frutas} × ${moedas(p.por_fruta)}`, p.id);
  db.prepare('UPDATE partidas SET analise = ?, recebido = ? WHERE id = ?').run(aprovar ? 'aprovada' : 'recusada', aprovar ? valor : 0, p.id);
  auditar(aprovar ? 'analise_aprovada' : 'analise_recusada', { u, ip, detalhe: { partida: p.id, valor } });
  return { ok: true };
}));
// ---------- usuários (operador: suporte) ----------
// Somas por jogador vindas do livro-razão. "resultado" = o que o jogador ganhou ou perdeu jogando
// (entradas + frutas + estornos); o lucro da casa com ele é o contrário.
const SOMAS_USUARIO = `
  COALESCE((SELECT SUM(valor) FROM movimentos m WHERE m.usuario_id = u.id), 0) AS saldo,
  COALESCE((SELECT SUM(valor) FROM movimentos m WHERE m.usuario_id = u.id AND m.tipo = 'deposito' AND m.descricao NOT LIKE 'Bônus%'), 0) AS depositado,
  COALESCE((SELECT SUM(valor) FROM movimentos m WHERE m.usuario_id = u.id AND m.tipo = 'deposito' AND m.descricao LIKE 'Bônus%'), 0) AS bonus,
  COALESCE((SELECT -SUM(valor) FROM movimentos m WHERE m.usuario_id = u.id AND m.tipo = 'saque'), 0) AS sacado,
  COALESCE((SELECT SUM(valor) FROM movimentos m WHERE m.usuario_id = u.id AND m.tipo IN ('entrada','premio','estorno')), 0) AS resultado,
  (SELECT COUNT(*) FROM partidas p WHERE p.usuario_id = u.id AND p.estado <> 'cancelada') AS partidas,
  (SELECT MAX(criada) FROM partidas p WHERE p.usuario_id = u.id) AS ultima_partida`;
const ORDENS_USUARIO = {
  recentes: 'u.id DESC', antigos: 'u.id ASC', saldo: 'saldo DESC, u.id DESC', resultado: 'resultado DESC, u.id DESC',
  prejuizo: 'resultado ASC, u.id DESC', partidas: 'partidas DESC, u.id DESC', ativos: 'ultima_partida DESC, u.id DESC',
};
const consulta = req => new URL(req.url, 'http://x').searchParams;
const cicloDe = (feitas, regras) => {
  const pos = feitas % cfg.FLUXO_TAM, dif = regras.fluxo[pos];
  return {
    tamanho: cfg.FLUXO_TAM, partidasContadas: feitas, volta: Math.floor(feitas / cfg.FLUXO_TAM) + 1,
    proxima: pos + 1, dificuldade: dif, nivel: dif === null ? 'Padrão (regras gerais)' : `${cfg.nomeDaDificuldade(dif).nome} · ${dif}`,
  };
};
const usuarioResumo = r => ({
  id: r.id, nome: r.nome, email: r.email || '', visitante: !!r.visitante, operador: !!r.operador, criado: r.criado,
  doisFatores: !!r.totp_ativo, bonusUsado: !!r.bonus_deposito,
  saldo: r.saldo, depositado: r.depositado, bonus: r.bonus, sacado: r.sacado, resultado: r.resultado, lucroCasa: -r.resultado,
  partidas: r.partidas, ultimaPartida: r.ultima_partida, cicloProxima: (r.partidas % cfg.FLUXO_TAM) + 1,
});
rota('GET', '/api/admin/usuarios', { operador: true }, ({ req }) => {
  const q = consulta(req);
  const busca = String(q.get('q') || '').trim().slice(0, 120);
  const por = Math.min(100, Math.max(5, Number(q.get('por')) || 20));
  const pagina = Math.max(1, Math.floor(Number(q.get('pagina')) || 1));
  const ordem = ORDENS_USUARIO[q.get('ordem')] || ORDENS_USUARIO.recentes;
  const like = `%${busca.replace(/[\\%_]/g, c => '\\' + c)}%`;
  const idBusca = /^#?\d+$/.test(busca) ? Number(busca.replace('#', '')) : -1;
  const onde = "(? = '' OR u.nome LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.id = ?)";
  const args = [busca, like, like, idBusca];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM usuarios u WHERE ${onde}`).get(...args).n;
  const linhas = db.prepare(`SELECT u.*, ${SOMAS_USUARIO} FROM usuarios u WHERE ${onde} ORDER BY ${ordem} LIMIT ? OFFSET ?`).all(...args, por, (pagina - 1) * por);
  const geral = db.prepare(`SELECT COUNT(*) AS contas,
      COALESCE((SELECT SUM(valor) FROM movimentos WHERE tipo IN ('entrada','premio','estorno')), 0) AS resultado,
      COALESCE((SELECT SUM(valor) FROM movimentos), 0) AS saldos FROM usuarios`).get();
  return {
    total, pagina, por, paginas: Math.max(1, Math.ceil(total / por)),
    usuarios: linhas.map(usuarioResumo),
    geral: { contas: geral.contas, lucroCasa: -geral.resultado, saldos: geral.saldos },
  };
});
const alvoUsuario = id => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(id));
  if (!u) throw new Erro(404, 'Usuário não encontrado.');
  return u;
};
function detalheUsuario(id) {
  alvoUsuario(id);
  const r = db.prepare(`SELECT u.*, ${SOMAS_USUARIO} FROM usuarios u WHERE u.id = ?`).get(Number(id));
  const partidas = db.prepare('SELECT * FROM partidas WHERE usuario_id = ? ORDER BY criada DESC LIMIT 5000').all(r.id).map(p => {
    const pp = partidaPublica(p, { comSemente: false });
    const { fluxoPosicao = null, dificuldade = null, fruitPercent = null } = pp.regras || {};
    delete pp.regras;
    return { ...pp, fluxoPosicao, dificuldade, fruitPercent, motivoAnalise: p.motivo_analise || null };
  });
  const fechadas = partidas.filter(p => p.estado === 'encerrada');
  const comResultado = fechadas.filter(p => p.resultado !== null);
  const est = {
    encerradas: fechadas.length, canceladas: partidas.filter(p => p.estado === 'cancelada').length,
    abertas: partidas.filter(p => p.estado === 'criada' || p.estado === 'jogando').length,
    ganhou: comResultado.filter(p => p.resultado > 0).length, empatou: comResultado.filter(p => p.resultado === 0).length,
    perdeu: comResultado.filter(p => p.resultado < 0).length, emAnalise: partidas.filter(p => p.analise === 'pendente').length,
    apostado: fechadas.reduce((s, p) => s + p.entrada, 0), recebido: comResultado.reduce((s, p) => s + p.recebido, 0),
    frutas: fechadas.reduce((s, p) => s + (p.frutas || 0), 0),
    melhor: comResultado.length ? Math.max(...comResultado.map(p => p.resultado)) : 0,
    pior: comResultado.length ? Math.min(...comResultado.map(p => p.resultado)) : 0,
    maiorDistancia: fechadas.reduce((mx, p) => Math.max(mx, p.distancia || 0), 0),
  };
  return {
    usuario: {
      ...usuarioResumo(r), nascimento: r.nascimento || '', emailConfirmado: !!r.email_confirmado,
      sessoesAtivas: db.prepare('SELECT COUNT(*) AS n FROM sessoes WHERE usuario_id = ? AND expira > ?').get(r.id, agora()).n,
      codigosReserva: JSON.parse(r.codigos_reserva || '[]').length,
    },
    estatisticas: est,
    ciclo: cicloDe(r.partidas, regrasAtuais()),
    partidas,
    movimentos: db.prepare('SELECT tipo, valor, descricao, partida_id AS partida, criado AS quando FROM movimentos WHERE usuario_id = ? ORDER BY id DESC LIMIT 2000').all(r.id),
    eventos: db.prepare('SELECT quando, ip, evento, detalhe FROM auditoria WHERE usuario_id = ? ORDER BY id DESC LIMIT 200').all(r.id),
  };
}
rota('GET', '/api/admin/usuarios/(\\d{1,12})', { operador: true }, ({ m }) => detalheUsuario(m[1]));
// Suporte: o operador corrige os dados de um jogador. Contas de operador não mudam por aqui (elas são
// configuradas no servidor), e o operador nunca vê a senha: só define uma nova.
rota('PATCH', '/api/admin/usuarios/(\\d{1,12})', { operador: true }, ({ m, corpo, u, ip }) => {
  limitar(`admin-usuario:${u.id}`, 60, 60e3);
  const alvo = alvoUsuario(m[1]);
  if (alvo.operador) throw new Erro(403, 'Contas de operador não são alteradas por aqui.');
  const mudou = [];
  transacao(() => {
    if (corpo.nome !== undefined) {
      const nome = texto(corpo.nome, 30);
      if (!nome) throw new Erro(400, 'O nome não pode ficar vazio.');
      if (nome !== alvo.nome) { db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(nome, alvo.id); mudou.push('nome'); }
    }
    if (corpo.email !== undefined && !alvo.visitante) {
      const email = texto(corpo.email, 120).toLowerCase();
      if (!emailValido(email)) throw new Erro(400, 'Informe um e-mail válido.');
      if (email !== alvo.email) {
        if (db.prepare('SELECT 1 FROM usuarios WHERE email = ? AND id <> ?').get(email, alvo.id)) throw new Erro(409, 'Esse e-mail já está em uso.');
        db.prepare('UPDATE usuarios SET email = ? WHERE id = ?').run(email, alvo.id); mudou.push('email');
      }
    }
    if (corpo.nascimento && !alvo.visitante && corpo.nascimento !== alvo.nascimento) {
      const a = idade(corpo.nascimento);
      if (!(a >= 0 && a < 130)) throw new Erro(400, 'Data de nascimento inválida.');
      db.prepare('UPDATE usuarios SET nascimento = ? WHERE id = ?').run(corpo.nascimento, alvo.id); mudou.push('nascimento');
    }
    if (typeof corpo.emailConfirmado === 'boolean' && !alvo.visitante && corpo.emailConfirmado !== !!alvo.email_confirmado) {
      db.prepare('UPDATE usuarios SET email_confirmado = ? WHERE id = ?').run(corpo.emailConfirmado ? 1 : 0, alvo.id); mudou.push('email_confirmado');
    }
    if (corpo.novaSenha) {
      if (alvo.visitante) throw new Erro(400, 'Visitante não tem senha.');
      const ruim = senhaForte(String(corpo.novaSenha));
      if (ruim) throw new Erro(400, ruim);
      db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(String(corpo.novaSenha)), alvo.id);
      db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(alvo.id); // quem estava logado entra com a senha nova
      mudou.push('senha');
    }
    if (corpo.desativar2fa === true && alvo.totp_ativo) {
      db.prepare("UPDATE usuarios SET totp_ativo = 0, totp_segredo = NULL, codigos_reserva = '[]' WHERE id = ?").run(alvo.id);
      mudou.push('2fa_desativado');
    }
    if (corpo.encerrarSessoes === true) {
      db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(alvo.id); mudou.push('sessoes_encerradas');
    }
  });
  if (mudou.length) {
    auditar('usuario_alterado_pelo_operador', { u, ip, detalhe: { usuario: alvo.id, campos: mudou } });
    auditar('conta_alterada_pelo_suporte', { u: alvo.id, ip, detalhe: { campos: mudou, operador: u.id } });
  }
  return { mudou, ...detalheUsuario(alvo.id) };
});
rota('GET', '/api/admin/auditoria', { operador: true }, () => ({
  eventos: db.prepare('SELECT a.*, us.nome AS nome FROM auditoria a LEFT JOIN usuarios us ON us.id = a.usuario_id ORDER BY a.id DESC LIMIT 300').all(),
}));

// Conta de operador: ARENA_ADMIN_EMAIL + ARENA_ADMIN_SENHA (12+ caracteres) criam/atualizam; sem elas, se não
// houver nenhum operador, cria um com senha aleatória e mostra no console (e em dados/operador-inicial.txt).
function prepararOperador() {
  const email = (process.env.ARENA_ADMIN_EMAIL || '').trim().toLowerCase(), senha = process.env.ARENA_ADMIN_SENHA || '';
  // Perdeu o celular e os códigos de reserva: ARENA_ADMIN_RESETAR_2FA=1 desliga o app do operador (precisa de
  // acesso ao servidor); no próximo login ele cadastra o app de novo.
  if (process.env.ARENA_ADMIN_RESETAR_2FA === '1') {
    const alvo = email ? db.prepare('SELECT id FROM usuarios WHERE email = ? AND operador = 1').all(email) : db.prepare('SELECT id FROM usuarios WHERE operador = 1').all();
    for (const { id } of alvo) {
      db.prepare("UPDATE usuarios SET totp_ativo = 0, totp_segredo = NULL, codigos_reserva = '[]' WHERE id = ?").run(id);
      db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
      auditar('2fa_resetado_pelo_servidor', { u: id });
    }
    console.log(`App autenticador desligado para ${alvo.length} operador(es). Tire ARENA_ADMIN_RESETAR_2FA e reinicie.`);
  }
  if (email && senha) {
    const ruim = senhaForte(senha, 12);
    if (ruim) { console.error(`ARENA_ADMIN_SENHA recusada: ${ruim} (mínimo 12 para o operador)`); process.exit(1); }
    const u = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
    if (u) db.prepare('UPDATE usuarios SET operador = 1, senha_hash = ? WHERE id = ?').run(hashSenha(senha), u.id);
    else db.prepare('INSERT INTO usuarios (nome, email, senha_hash, operador, criado) VALUES (?, ?, ?, 1, ?)').run('Operador', email, hashSenha(senha), agora());
    console.log(`Operador: ${email}`);
    return;
  }
  if (db.prepare('SELECT 1 FROM usuarios WHERE operador = 1').get()) return;
  const s = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO usuarios (nome, email, senha_hash, operador, criado) VALUES (?, ?, ?, 1, ?)').run('Operador', 'operador@arena.local', hashSenha(s), agora());
  const msg = `Conta de operador criada: operador@arena.local / ${s}`;
  console.log(msg + '  (troque definindo ARENA_ADMIN_EMAIL e ARENA_ADMIN_SENHA)');
  try { fs.writeFileSync(path.join(path.dirname(require('./banco').arquivo), 'operador-inicial.txt'), msg + '\n', { mode: 0o600 }); } catch {}
}

async function iniciar() {
  cfg = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'jogo', 'config.js')).href);
  prepararOperador();
  prepararCodigoAtivacao();
  replay.iniciar(); // a thread de replay já carrega o nível ao subir o servidor
  require('./backup').agendar(db, require('./banco').arquivo);
}

// Atende /api/*; devolve false se a rota não for da API.
async function atender(req, res, url) {
  if (!url.startsWith('/api/')) return false;
  const metodo = req.method;
  const ip = ipDe(req);
  try {
    limitar(`api:${ip}`, 600, 60e3);
    const achada = rotas.find(r => r.metodo === metodo && r.padrao.test(url));
    if (!achada) {
      const outra = rotas.some(r => r.padrao.test(url));
      throw new Erro(outra ? 405 : 404, outra ? 'Método não permitido.' : 'Rota não encontrada.');
    }
    if (metodo !== 'GET') {
      if (req.headers['x-arena'] !== '1') throw new Erro(403, 'Pedido recusado.');
      if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Erro(415, 'Envie JSON.');
      // pedido de outro site: o navegador manda Origin; tem que ser este mesmo
      const origem = req.headers.origin;
      if (origem && origem !== `${ehHttps(req) ? 'https' : 'http'}://${req.headers.host}`) throw new Erro(403, 'Pedido recusado.');
    }
    const corpo = metodo === 'GET' ? {} : await lerCorpo(req, achada.corpoMax || CORPO_PADRAO);
    let u = usuarioDaSessao(req);
    // admin local (testes no computador): rotas de operador sem login, como o primeiro operador do banco
    if (achada.operador && !achada.configurar2fa && adminLocal(req)) {
      const op = db.prepare('SELECT * FROM usuarios WHERE operador = 1 ORDER BY id LIMIT 1').get();
      if (op) u = { ...op, totp_ativo: 1, dois_fatores: 1, sessao: null };
    }
    if ((achada.login || achada.operador) && !u) throw new Erro(401, 'Entre na sua conta.');
    if (achada.operador && !u.operador) { auditar('acesso_negado_operador', { u, ip, detalhe: url }); throw new Erro(403, 'Só o operador pode fazer isso.'); }
    // ações de operador exigem o app autenticador ativo e a sessão aberta com o código
    if (achada.operador && !achada.configurar2fa) {
      if (!u.totp_ativo) throw new Erro(403, 'Ative a verificação em duas etapas (app autenticador) para usar as funções de operador.', 'configurar_2fa');
      if (!u.dois_fatores) throw new Erro(403, 'Saia e entre de novo com o código do app autenticador.', 'precisa_2fa');
    }
    const r = await achada.fn({ req, res, corpo, u, m: url.match(achada.padrao), ip });
    enviar(res, 200, r);
  } catch (e) {
    if (e instanceof Erro) enviar(res, e.status, { erro: e.message, ...(e.codigo ? { codigo: e.codigo } : {}) });
    else if (/saldo negativo/.test(e && e.message)) { auditar('trava_saldo_negativo', { ip, detalhe: url }); enviar(res, 400, { erro: 'Saldo insuficiente.' }); }
    else { console.error(e); enviar(res, 500, { erro: 'Erro no servidor.' }); }
  }
  return true;
}

// Partidas abandonadas há mais de 2 h (DURACAO_MAX_MS) são fechadas pelo servidor.
setInterval(async () => {
  const velhas = db.prepare("SELECT * FROM partidas WHERE estado IN ('criada','jogando') AND criada < ?").all(agora() - DURACAO_MAX_MS);
  for (const p of velhas) {
    try {
      if (p.estado === 'criada') transacao(() => { const q = db.prepare('SELECT * FROM partidas WHERE id = ?').get(p.id); if (q.estado === 'criada') cancelar(q); });
      else await encerrarComReplay(p, DURACAO_MAX_MS);
    } catch (e) { console.error('[limpeza]', e.message); }
  }
}, 5 * 60e3).unref();

module.exports = { iniciar, atender };
