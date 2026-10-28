// Baixa um arquivo grande (o level.bin, 22 MB) mostrando o progresso, e guarda no cache do navegador
// (Cache API) para as próximas partidas abrirem na hora. O cache é conferido com um HEAD: se o arquivo
// no servidor mudou (tamanho ou data), baixa de novo.
const CACHE = 'crash-arena-dados-v1';

async function abrirCache() {
  try { return await caches.open(CACHE); } catch { return null; } // sem Cache API (http fora de localhost etc.)
}

// Tamanho real do arquivo: o servidor manda X-Tamanho (com compressão no caminho, Content-Length não vem).
const tamanho = h => h.get('x-tamanho') || h.get('content-length') || '';
function mesmaVersao(a, b) {
  const ok = h => tamanho(h) + '|' + (h.get('last-modified') || '');
  return ok(a.headers) === ok(b.headers);
}

// onProgress(fração 0..1, bytes recebidos, total)
export async function baixarComProgresso(url, onProgress = () => {}) {
  const cache = await abrirCache();
  if (cache) {
    const salvo = await cache.match(url);
    if (salvo) {
      let valido = true;
      try {
        const h = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (h.ok) valido = mesmaVersao(h, salvo);
      } catch { /* sem rede: usa o que tem */ }
      if (valido) { onProgress(1, 0, 0); return salvo.arrayBuffer(); }
    }
  }

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Não foi possível baixar ${url} (${res.status}).`);
  const total = Number(tamanho(res.headers)) || 0;
  let buf;
  if (res.body && total) {
    buf = new Uint8Array(total);
    const leitor = res.body.getReader();
    let recebido = 0;
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (recebido + value.length > buf.length) { // servidor mandou mais que o anunciado
        const maior = new Uint8Array(recebido + value.length); maior.set(buf.subarray(0, recebido)); buf = maior;
      }
      buf.set(value, recebido);
      recebido += value.length;
      onProgress(Math.min(1, recebido / total), recebido, total);
    }
    buf = buf.subarray(0, recebido);
  } else {
    buf = new Uint8Array(await res.arrayBuffer());
    onProgress(1, buf.length, buf.length);
  }
  if (cache) {
    try {
      const headers = { 'content-type': 'application/octet-stream', 'content-length': String(buf.length), 'x-tamanho': String(buf.length) };
      const lm = res.headers.get('last-modified');
      if (lm) headers['last-modified'] = lm;
      await cache.put(url, new Response(buf, { headers }));
    } catch { /* cache cheio ou indisponível: segue sem */ }
  }
  return buf.buffer.byteLength === buf.length ? buf.buffer : buf.slice().buffer;
}
