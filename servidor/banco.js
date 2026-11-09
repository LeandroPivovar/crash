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
  // bônus de boas-vindas (depositar R$ 5 e ganhar + R$ 10) já usado: 1 vez por conta
  'ALTER TABLE usuarios ADD COLUMN bonus_deposito INTEGER NOT NULL DEFAULT 0',
  // link de indicação pelo qual a conta foi criada (tabela indicacoes)
  'ALTER TABLE usuarios ADD COLUMN indicacao_id INTEGER',
]) { try { db.exec(sql); } catch { /* coluna já existe */ } }
// Pedidos de saque: o valor já saiu do saldo (lançamento 'saque'); recusado ou falha no envio = lançamento
// 'estorno' devolve. processando = aprovado e enviado ao gateway, esperando a confirmação do Pix.
const SAQUES_SQL = `CREATE TABLE saques (
  id          INTEGER PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
  valor       INTEGER NOT NULL CHECK (valor > 0),
  estado      TEXT NOT NULL CHECK (estado IN ('pendente','processando','aprovado','recusado','falhou')),
  criado      INTEGER NOT NULL,
  decidido    INTEGER,
  operador_id INTEGER,
  motivo      TEXT,
  chave_tipo  TEXT,                     -- cpf | telefone
  chave       TEXT,                     -- só dígitos (telefone com DDD, sem +55)
  documento   TEXT,                     -- CPF do titular da chave
  gateway_id  TEXT                      -- id do saque na CajuPay (envio automático)
)`;
const saquesAtual = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'saques'").get();
if (!saquesAtual) db.exec(SAQUES_SQL);
else if (!saquesAtual.sql.includes('processando')) {
  // versão anterior (sem chave Pix nem os estados novos): recria a tabela com os mesmos pedidos
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE saques RENAME TO saques_antigo');
    db.exec(SAQUES_SQL);
    db.exec('INSERT INTO saques (id, usuario_id, valor, estado, criado, decidido, operador_id, motivo) SELECT id, usuario_id, valor, estado, criado, decidido, operador_id, motivo FROM saques_antigo');
    db.exec('DROP TABLE saques_antigo');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
db.exec(`
CREATE INDEX IF NOT EXISTS saques_estado ON saques(estado, criado);
CREATE INDEX IF NOT EXISTS saques_usuario ON saques(usuario_id, id);
-- Depósitos por Pix (CajuPay): o saldo só entra quando o pagamento é confirmado (webhook ou consulta).
CREATE TABLE IF NOT EXISTS depositos (
  id          INTEGER PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
  valor       INTEGER NOT NULL CHECK (valor > 0),
  estado      TEXT NOT NULL CHECK (estado IN ('pendente','pago','expirado','falhou')),
  gateway     TEXT NOT NULL,            -- cajupay | simulado
  gateway_id  TEXT UNIQUE,              -- payment_id da CajuPay
  pix_copia_cola TEXT,
  pix_qr      TEXT,
  criado      INTEGER NOT NULL,
  pago        INTEGER,
  bonus       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS depositos_usuario ON depositos(usuario_id, id);
CREATE INDEX IF NOT EXISTS depositos_estado ON depositos(estado, criado);
-- Links de indicação (operador): quem se cadastra por /?ref=CODIGO fica ligado ao link. A comissão é
-- calculada sobre os indicados: % dos saques pagos (tipo saque) ou % das perdas na plataforma (tipo perdas).
CREATE TABLE IF NOT EXISTS indicacoes (
  id          INTEGER PRIMARY KEY,
  codigo      TEXT NOT NULL UNIQUE,
  nome        TEXT NOT NULL,            -- de quem é o link (parceiro, influenciador…)
  tipo        TEXT NOT NULL CHECK (tipo IN ('saque','perdas')),
  porcentagem REAL NOT NULL CHECK (porcentagem > 0 AND porcentagem <= 100),
  ativo       INTEGER NOT NULL DEFAULT 1,
  cliques     INTEGER NOT NULL DEFAULT 0,
  criado      INTEGER NOT NULL,
  operador_id INTEGER
);
CREATE INDEX IF NOT EXISTS usuarios_indicacao ON usuarios(indicacao_id);
-- Promoções de depósito já usadas (cada uma vale 1 vez por conta): valor do depósito que deu o bônus.
CREATE TABLE IF NOT EXISTS bonus_usados (
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
  deposito    INTEGER NOT NULL,
  criado      INTEGER NOT NULL,
  PRIMARY KEY (usuario_id, deposito)
);
INSERT OR IGNORE INTO bonus_usados (usuario_id, deposito, criado) SELECT id, 500, criado FROM usuarios WHERE bonus_deposito = 1;
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
