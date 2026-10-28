// Servidor do Crash Arena: API em /api/* (api.js, banco SQLite em dados/) e o site estático de site/.
//   node servidor/serve.js [porta]      (padrão 8091)
// Variáveis: PORT, ARENA_DB (arquivo do banco), ARENA_ADMIN_EMAIL + ARENA_ADMIN_SENHA (conta de operador),
// ARENA_PROXY=1 (atrás de nginx/Cloudflare: confia em X-Forwarded-For/Proto).
// Pasta sem barra no fim (/lobby) redireciona para /lobby/, para os caminhos relativos das páginas funcionarem.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const api = require('./api');

const root = path.join(__dirname, '..', 'site');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};
const port = Number(process.env.PORT) || Number(process.argv[2]) || 8091;
// ARENA_HOST=127.0.0.1 atrás de proxy (nginx): o servidor não fica acessível direto pela internet
const host = process.env.ARENA_HOST || undefined;
const HTTPS = req => req.socket.encrypted || (process.env.ARENA_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');

// Content-Security-Policy: só scripts do próprio site, mais os <script> embutidos de cada página, autorizados
// pelo hash do conteúdo (se alguém injetar um script, ele não roda). Sem iframes de fora, sem plugins.
const hashesDaPagina = new Map(); // arquivo → { mtime, hashes }
function scriptsEmbutidos(file, data, mtime) {
  const c = hashesDaPagina.get(file);
  if (c && c.mtime === mtime) return c.hashes;
  const hashes = [];
  for (const m of data.toString('utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  hashesDaPagina.set(file, { mtime, hashes });
  return hashes;
}
function politica(hashes) {
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function estatico(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = path.normalize(decodeURIComponent(url)).replace(/^[\/\\]+/, ''); } catch { res.writeHead(400); return res.end(); }
  // nada de arquivos ocultos nem de configuração do Node
  if (rel.split(/[\/\\]/).some(p => p.startsWith('.')) || /(^|[\/\\])package(-lock)?\.json$/.test(rel)) { res.writeHead(404); return res.end(); }
  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  let stat = null;
  try { stat = fs.statSync(file); } catch {}
  if (stat && stat.isDirectory()) {
    if (!url.endsWith('/')) {
      res.writeHead(301, { Location: url + '/' + req.url.slice(url.length) });
      return res.end();
    }
    file = path.join(file, 'index.html');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('não encontrado'); }
    const mtime = (stat && !stat.isDirectory() ? stat : fs.statSync(file)).mtime;
    const ext = path.extname(file);
    const cab = {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'X-Tamanho': data.length, // tamanho real: com compressão (nginx) o Content-Length some, e o jogo usa este para o progresso e o cache
      'Last-Modified': mtime.toUTCString(),
    };
    // páginas e código: o navegador sempre confere (senão um jogador fica com a versão velha depois de uma
    // atualização — e o replay do servidor precisa do mesmo código do jogo)
    if (['.html', '.js', '.css', '.json', '.mjs'].includes(ext)) cab['Cache-Control'] = 'no-cache';
    if (ext === '.html') cab['Content-Security-Policy'] = politica(scriptsEmbutidos(file, data, mtime.getTime()));
    // arquivo grande já comprimido ao lado (level.bin.gz, feito na instalação): manda ele, se o navegador aceita
    let corpo = data;
    if (/gzip/i.test(req.headers['accept-encoding'] || '')) {
      try {
        const gz = fs.statSync(file + '.gz');
        if (gz.mtimeMs >= mtime.getTime()) { corpo = fs.readFileSync(file + '.gz'); cab['Content-Encoding'] = 'gzip'; cab['Content-Length'] = corpo.length; }
      } catch { /* sem versão comprimida */ }
    }
    cab['Vary'] = 'Accept-Encoding';
    res.writeHead(200, cab);
    res.end(req.method === 'HEAD' ? undefined : corpo);
  });
}

// HTTPS próprio: ARENA_TLS_CERT e ARENA_TLS_KEY (arquivos PEM do certificado e da chave). Com eles, o site roda
// em HTTPS na porta escolhida e, se ARENA_HTTP_REDIRECIONAR for uma porta (ex.: 80), ela só redireciona para o
// HTTPS. Sem eles, roda em HTTP (para desenvolvimento, ou atrás de um proxy com HTTPS e ARENA_PROXY=1).
const certificado = process.env.ARENA_TLS_CERT && process.env.ARENA_TLS_KEY
  ? { cert: fs.readFileSync(process.env.ARENA_TLS_CERT), key: fs.readFileSync(process.env.ARENA_TLS_KEY), minVersion: 'TLSv1.2' }
  : null;

api.iniciar().then(() => {
  const atender = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');                      // ninguém põe o site dentro de outro (clickjacking)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (HTTPS(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const url = req.url.split('?')[0];
    if (await api.atender(req, res, url)) return;
    estatico(req, res, url);
  };
  if (certificado) {
    require('https').createServer(certificado, atender).listen(port, host, () => console.log(`Crash Arena em https://localhost:${port}`));
    const redir = Number(process.env.ARENA_HTTP_REDIRECIONAR);
    if (redir) {
      http.createServer((req, res) => {
        const host = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
        res.writeHead(301, { Location: `https://${host}${port === 443 ? '' : ':' + port}${req.url}` });
        res.end();
      }).listen(redir, () => console.log(`HTTP na porta ${redir} redireciona para o HTTPS`));
    }
  } else {
    http.createServer(atender).listen(port, host, () => console.log(`Crash Arena em http://localhost:${port}`));
  }
});
