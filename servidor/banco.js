// Banco de dados do Crash Arena (SQLite embutido no Node 22.5+, sem dependências).
// Arquivo: servidor/dados/arena.db (ou ARENA_DB).
//
// Carteira = livro-razão: o saldo é sempre a SOMA dos movimentos do jogador; não existe coluna de saldo
// editável. Valores em centavos de moeda (inteiros).
const path = require('path'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const arquivo = process.env.ARENA_DB || path.join(__dirname, 'dados', 'arena.db');
fs.mkdirSync(path.dirname(arquivo), { recursive: true });
const db = new DatabaseSync(arquivo);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS usuarios (
  id          INTEGER PRIMARY KEY,
  nome        TEXT NOT NULL,
  email       TEXT UNIQUE,              -- NULL para visitantes
  senha_hash  TEXT,                     -- scrypt; NULL para visitantes
  nascimento  TEXT,                     -- AAAA-MM-DD (verificação de idade no cadastro)
  visitante   INTEGER NOT NULL DEFAULT 0,
  operador    INTEGER NOT NULL DEFAULT 0,
  criado      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash  TEXT PRIMARY KEY,         -- sha256 do token do cookie (o token em si não fica no banco)
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado      INTEGER NOT NULL,
  expira      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recuperacoes (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira      INTEGER NOT NULL,
  usado       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS movimentos (
  id          INTEGER PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('deposito','saque','entrada','premio','estorno')),
  valor       INTEGER NOT NULL,         -- positivo entra, negativo sai
  descricao   TEXT NOT NULL,
  partida_id  TEXT,
  criado      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS movimentos_usuario ON movimentos(usuario_id, id);
CREATE TABLE IF NOT EXISTS partidas (
  id          TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
  modo        TEXT NOT NULL DEFAULT 'solo',
  entrada     INTEGER NOT NULL,
  semente     INTEGER NOT NULL,
  regras      TEXT NOT NULL,            -- JSON das regras no momento da partida
  estado      TEXT NOT NULL CHECK (estado IN ('criada','jogando','encerrada','cancelada')),
  criada      INTEGER NOT NULL,
  comecou     INTEGER,
  encerrada   INTEGER,
  frutas      INTEGER NOT NULL DEFAULT 0,
  distancia   INTEGER NOT NULL DEFAULT 0,
  tempo_ms    INTEGER NOT NULL DEFAULT 0,
  por_fruta   INTEGER,
  recebido    INTEGER
);
CREATE INDEX IF NOT EXISTS partidas_usuario ON partidas(usuario_id, criada);
CREATE TABLE IF NOT EXISTS config (
  chave       TEXT PRIMARY KEY,
  valor       TEXT NOT NULL
);
`);

// Fase 3: gravação dos comandos e verificação por replay (colunas novas; bancos antigos ganham as colunas).
for (const sql of [
  "ALTER TABLE partidas ADD COLUMN entradas TEXT NOT NULL DEFAULT '[]'",  // gravação [[código, repetições], ...]
  'ALTER TABLE partidas ADD COLUMN passos INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE partidas ADD COLUMN frutas_informadas INTEGER',            // o que o jogo disse ter pego
  'ALTER TABLE partidas ADD COLUMN verificacao TEXT',                      // confirmada | divergente | refeita | erro
  'ALTER TABLE partidas ADD COLUMN versao INTEGER',
  // Blindagem: pagamento que parece robô ou é grande demais fica em análise até o operador decidir.
  'ALTER TABLE partidas ADD COLUMN analise TEXT',                         // NULL | pendente | aprovada | recusada
  'ALTER TABLE partidas ADD COLUMN motivo_analise TEXT',
  'ALTER TABLE partidas ADD COLUMN sinais TEXT',                           // JSON: medidas da gravação (ritmo dos comandos etc.)
  // Verificação em duas etapas (TOTP, app autenticador) — obrigatória para o operador.
  'ALTER TABLE usuarios ADD COLUMN totp_segredo TEXT',                     // base32
  'ALTER TABLE usuarios ADD COLUMN totp_ativo INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE usuarios ADD COLUMN totp_ultimo INTEGER NOT NULL DEFAULT 0', // último intervalo usado (o mesmo código não vale duas vezes)
  "ALTER TABLE usuarios ADD COLUMN codigos_reserva TEXT NOT NULL DEFAULT '[]'", // sha256 dos códigos de uso único
  'ALTER TABLE sessoes ADD COLUMN dois_fatores INTEGER NOT NULL DEFAULT 0',  // sessão aberta com o segundo fator
  // Confirmação do e-mail: contas que já existiam contam como confirmadas; o cadastro grava 0.
  'ALTER TABLE usuarios ADD COLUMN email_confirmado INTEGER NOT NULL DEFAULT 1',
]) { try { db.exec(sql); } catch { /* coluna já existe */ } }
db.exec(`
CREATE TABLE IF NOT EXISTS confirmacoes (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,            -- o e-mail que o link confirma (se a pessoa trocar de e-mail, o link antigo não vale)
  expira      INTEGER NOT NULL,
  usado       INTEGER NOT NULL DEFAULT 0
);
`);

db.exec(`
-- Registro de segurança: logins, cadastros, mudanças de regra, análises, bloqueios por excesso de pedidos.
CREATE TABLE IF NOT EXISTS auditoria (
  id          INTEGER PRIMARY KEY,
  quando      INTEGER NOT NULL,
  usuario_id  INTEGER,
  ip          TEXT,
  evento      TEXT NOT NULL,
  detalhe     TEXT
);
CREATE INDEX IF NOT EXISTS auditoria_quando ON auditoria(quando);

-- O livro-razão não muda nem some: só entram lançamentos novos (correção = lançamento contrário).
CREATE TRIGGER IF NOT EXISTS movimentos_sem_update BEFORE UPDATE ON movimentos
BEGIN SELECT RAISE(ABORT, 'movimentos são imutáveis'); END;
CREATE TRIGGER IF NOT EXISTS movimentos_sem_delete BEFORE DELETE ON movimentos
BEGIN SELECT RAISE(ABORT, 'movimentos são imutáveis'); END;
-- E nenhum lançamento pode deixar o saldo negativo (segunda trava, além da conferência no código).
CREATE TRIGGER IF NOT EXISTS movimentos_saldo_nao_negativo AFTER INSERT ON movimentos
WHEN (SELECT COALESCE(SUM(valor), 0) FROM movimentos WHERE usuario_id = NEW.usuario_id) < 0
BEGIN SELECT RAISE(ABORT, 'saldo negativo'); END;
`);

// Executa fn numa transação (BEGIN IMMEDIATE: trava a escrita, então dois pedidos ao mesmo tempo não
// gastam o mesmo saldo duas vezes).
function transacao(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

module.exports = { db, transacao, arquivo };
