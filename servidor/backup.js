// Cópias do banco (SQLite "VACUUM INTO": cópia consistente, feita com o servidor rodando).
// Automático: ao subir e a cada ARENA_BACKUP_HORAS (padrão 6); guarda as ARENA_BACKUP_MANTER mais novas
// (padrão 28 = 7 dias). Pasta: servidor/dados/backups (ou ARENA_BACKUP_PASTA). Guarde também uma cópia FORA
// deste computador (outro disco, nuvem).
//   node servidor/backup.js            faz uma cópia agora
// Restaurar: pare o servidor, troque dados/arena.db pela cópia (e apague arena.db-wal e arena.db-shm), suba de novo.
const fs = require('fs'), path = require('path');

function pasta(arquivoDb) {
  return process.env.ARENA_BACKUP_PASTA || path.join(path.dirname(arquivoDb), 'backups');
}
function fazerBackup(db, arquivoDb) {
  const dir = pasta(arquivoDb);
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const nome = `arena-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
  const destino = path.join(dir, nome);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  // limpa as antigas
  const manter = Math.max(1, Number(process.env.ARENA_BACKUP_MANTER) || 28);
  const copias = fs.readdirSync(dir).filter(f => /^arena-\d{8}-\d{6}\.db$/.test(f)).sort();
  for (const f of copias.slice(0, Math.max(0, copias.length - manter))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  return destino;
}
function agendar(db, arquivoDb) {
  const horas = Number(process.env.ARENA_BACKUP_HORAS);
  if (horas === 0) return; // ARENA_BACKUP_HORAS=0 desliga
  const rodar = () => {
    try { console.log(`[backup] ${fazerBackup(db, arquivoDb)}`); }
    catch (e) { console.error('[backup] falhou:', e.message); }
  };
  rodar();
  setInterval(rodar, (horas > 0 ? horas : 6) * 3600e3).unref();
}

module.exports = { fazerBackup, agendar };

if (require.main === module) {
  const { db, arquivo } = require('./banco');
  console.log(`Cópia feita: ${fazerBackup(db, arquivo)}`);
}
