// Envio de e-mail por SMTP (sem dependências). Configure com ARENA_SMTP_URL:
//   smtps://usuario:senha@smtp.exemplo.com:465     (TLS direto)
//   smtp://usuario:senha@smtp.exemplo.com:587      (STARTTLS, obrigatório: sem TLS não envia a senha)
// e ARENA_EMAIL_DE="Crash Arena <nao-responda@exemplo.com>". Usuário e senha com caracteres especiais vão
// codificados na URL (encodeURIComponent). Sem ARENA_SMTP_URL, o e-mail sai no console do servidor.
const net = require('net'), tls = require('tls'), crypto = require('crypto');

const configurado = () => !!process.env.ARENA_SMTP_URL;

function conversa(socketInicial, host) {
  let sock = socketInicial, buf = '', esperando = null;
  const aoDados = d => {
    buf += d.toString('utf8');
    // resposta completa: última linha "NNN texto" (sem hífen depois do código)
    const linhas = buf.split('\r\n');
    for (let i = 0; i < linhas.length - 1; i++) {
      if (/^\d{3} /.test(linhas[i]) && esperando) {
        const resposta = linhas.slice(0, i + 1).join('\n');
        buf = linhas.slice(i + 1).join('\r\n');
        const e = esperando; esperando = null;
        e(resposta);
        return;
      }
    }
  };
  const ligar = s => { s.on('data', aoDados); };
  ligar(sock);
  const ler = () => new Promise((ok, falha) => {
    const t = setTimeout(() => falha(new Error('SMTP sem resposta')), 15000);
    esperando = r => { clearTimeout(t); ok(r); };
    sock.once('error', falha);
    if (buf) aoDados('');
  });
  const cmd = async (linha, codigoEsperado) => {
    if (linha != null) sock.write(linha + '\r\n');
    const r = await ler();
    if (!r.startsWith(String(codigoEsperado))) throw new Error(`SMTP recusou (${linha ? linha.split(' ')[0] : 'conexão'}): ${r.slice(0, 200)}`);
    return r;
  };
  const tlsAgora = () => new Promise((ok, falha) => {
    sock.removeListener('data', aoDados);
    const s = tls.connect({ socket: sock, servername: host }, () => { sock = s; ligar(s); ok(); });
    s.once('error', falha);
  });
  return { cmd, tlsAgora, fim: () => sock.end(), seguro: () => sock instanceof tls.TLSSocket };
}

const cabecalho = t => /^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t).toString('base64')}?=`;

const b64 = t => Buffer.from(t, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
async function enviarSmtp({ para, assunto, texto, html }) {
  const u = new URL(process.env.ARENA_SMTP_URL);
  const direto = u.protocol === 'smtps:';
  const host = u.hostname, porta = Number(u.port) || (direto ? 465 : 587);
  const de = process.env.ARENA_EMAIL_DE || `Crash Arena <${decodeURIComponent(u.username)}>`;
  const enderecoDe = (/<([^>]+)>/.exec(de) || [, de])[1];
  if (/[\r\n<>]/.test(para)) throw new Error('destinatário inválido');
  const sock = await new Promise((ok, falha) => {
    const s = direto ? tls.connect({ host, port: porta, servername: host }, () => ok(s)) : net.connect({ host, port: porta }, () => ok(s));
    s.setTimeout(30000, () => s.destroy(new Error('SMTP: tempo esgotado')));
    s.once('error', falha);
  });
  const c = conversa(sock, host);
  try {
    await c.cmd(null, 220);
    let ehlo = await c.cmd('EHLO crash-arena', 250);
    if (!direto) {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('o servidor SMTP não oferece STARTTLS');
      await c.cmd('STARTTLS', 220);
      await c.tlsAgora();
      ehlo = await c.cmd('EHLO crash-arena', 250);
    }
    if (!c.seguro()) throw new Error('conexão SMTP sem TLS');
    if (u.username) {
      const cred = Buffer.from(`\0${decodeURIComponent(u.username)}\0${decodeURIComponent(u.password)}`).toString('base64');
      await c.cmd(`AUTH PLAIN ${cred}`, 235);
    }
    await c.cmd(`MAIL FROM:<${enderecoDe}>`, 250);
    await c.cmd(`RCPT TO:<${para}>`, 250);
    await c.cmd('DATA', 354);
    // texto puro sempre; com html, as duas versões (o programa de e-mail escolhe)
    const fronteira = 'arena-' + crypto.randomBytes(12).toString('hex');
    const corpo = html
      ? [`Content-Type: multipart/alternative; boundary="${fronteira}"`, '',
        `--${fronteira}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(texto),
        `--${fronteira}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html),
        `--${fronteira}--`]
      : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(texto)];
    const msg = [
      `From: ${de}`, `To: <${para}>`, `Subject: ${cabecalho(assunto)}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${enderecoDe.split('@')[1] || 'crash-arena'}>`,
      'MIME-Version: 1.0', ...corpo, '.',
    ].join('\r\n');
    await c.cmd(msg, 250);
    await c.cmd('QUIT', 221).catch(() => {});
  } finally { c.fim(); }
}

// Envia; sem SMTP configurado, escreve no console (desenvolvimento).
async function enviar({ para, assunto, texto, html }) {
  if (!configurado()) { console.log(`[e-mail para ${para}] ${assunto}\n${texto}`); return; }
  await enviarSmtp({ para, assunto, texto, html });
}

// Modelo HTML dos e-mails (tabelas e estilos embutidos: é o que os programas de e-mail entendem).
const escHtml = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function modelo({ titulo, nome, texto, botao, link, rodape }) {
  const L = escHtml(link);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(titulo)}</title></head>
<body style="margin:0;padding:0;background:#120a24;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#120a24"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="width:560px;max-width:100%;background:#1d1236;border:1px solid #3a2a63;border-radius:16px">
<tr><td style="padding:22px 32px;border-bottom:3px solid #ff8a1f;font-size:22px;font-weight:900;letter-spacing:1px;color:#ffffff">CRASH <span style="color:#ff8a1f">ARENA</span></td></tr>
<tr><td style="padding:30px 32px;color:#e8e2f5;font-size:15px;line-height:23px">
<h1 style="margin:0 0 16px;font-size:24px;line-height:30px;color:#ffffff">${escHtml(titulo)}</h1>
<p style="margin:0 0 12px">Olá, <b>${escHtml(nome)}</b>!</p>
<p style="margin:0 0 24px">${escHtml(texto)}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:10px;background:#ff8a1f">
<a href="${L}" target="_blank" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#1d1236;text-decoration:none;border-radius:10px">${escHtml(botao)}</a></td></tr></table>
<p style="margin:24px 0 6px;font-size:12px;color:#a99cc7">Se o botão não funcionar, copie este endereço no navegador:</p>
<p style="margin:0 0 20px;font-size:12px;word-break:break-all"><a href="${L}" style="color:#ffb066">${L}</a></p>
<p style="margin:0;font-size:12px;color:#a99cc7">${escHtml(rodape)}</p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #3a2a63;font-size:11px;color:#7d6fa3">Crash Arena · arenacrash.com · E-mail automático, não responda.</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { enviar, configurado, modelo };
