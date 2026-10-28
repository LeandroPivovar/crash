# Crash Arena — segurança e antifraude

Resumo honesto: **nenhum jogo que roda no navegador é 100% à prova de fraude.** O que o Crash Arena garante hoje é que **o navegador não decide nada que valha moeda**: ele só manda os comandos do jogador, e o servidor decide o resto. O que ainda dá para fazer (seção 3) exige um robô jogando de verdade, e para isso existem detecção, limites e análise manual.

Teste automático: `node ferramentas/testar-ataques.mjs` sobe um servidor descartável e tenta cerca de 40 ataques (lista na seção 2). Precisa terminar com "0 falharam".

## 1. Quem decide o quê

| O quê | Quem decide | Como |
|---|---|---|
| Saldo | Servidor | Soma dos lançamentos do livro-razão; o navegador só mostra |
| Entrada da partida | Servidor | Confere o saldo dentro de transação e lança a saída |
| Percurso (semente) e regras | Servidor | Sorteia e guarda na criação da partida; o navegador não escolhe |
| Frutas pegas | Servidor | Refaz a corrida com a mesma simulação do jogo, a partir dos comandos gravados |
| Pagamento | Servidor | Frutas do replay × valor por fruta das regras da partida |
| Começo da corrida | Servidor | Marca a hora do START; a gravação não pode ter mais passos que o tempo real |

O que o navegador manda e o servidor **ignora para pagar**: número de frutas, distância e tempo (ficam só para comparação e auditoria).

## 2. Ataques cobertos

**Pela API (script, console do navegador, ferramenta de interceptação):**
- Inventar frutas, distância ou pagamento: não existe rota que aceite isso; o pagamento vem do replay.
- Gravação com comandos impossíveis (desvio além do que o jogo gera, repetições absurdas): recusada.
- "Acelerar o tempo" (mandar minutos de comandos em segundos): recusado durante a corrida e cortado no fim.
- Reescrever o passado (jogar, ver o que acontece e trocar comandos antigos): a gravação só cresce; a final tem que continuar exatamente a que já chegou, senão vale a que já tinha chegado (e fica registrado).
- Mexer na partida de outra pessoa ou em ids inventados: 404.
- Valores quebrados, negativos, em texto, gigantes: recusados (só inteiros em centavos, com limites).
- Gastar o mesmo saldo duas vezes com pedidos simultâneos: transações com trava de escrita; e, no banco, um gatilho impede qualquer lançamento que deixe o saldo negativo.
- Duas partidas abertas ao mesmo tempo: só uma por jogador.
- Rotas de operador: só a conta de operador; tentativas ficam registradas.

**Pelo navegador de outra pessoa:**
- Pedido forjado por outro site (CSRF): exige JSON, o cabeçalho `X-Arena: 1` e `Origin` igual ao site; cookie `SameSite=Lax`.
- Script injetado (XSS): textos de usuário sempre escapados; `Content-Security-Policy` só deixa rodar scripts do próprio site e os embutidos conhecidos (pelo hash); o three.js agora vem do próprio site (sem depender de CDN).
- Site dentro de iframe para enganar cliques (clickjacking): `X-Frame-Options: DENY` e `frame-ancestors 'none'`.
- Roubo de sessão por script: cookie `HttpOnly` (e `Secure` em HTTPS); o banco guarda só o hash do token.
- Sessão roubada tomando a conta: trocar e-mail ou senha exige a senha atual; trocar a senha derruba as outras sessões.

**Operador (quem muda regras e aprova pagamentos):**
- Verificação em duas etapas **obrigatória**: código de 6 dígitos de app autenticador (TOTP, padrão RFC 6238; Google Authenticator, Microsoft Authenticator, Authy…). Sem o app ativo, nenhuma ação de operador funciona; o próprio site guia a ativação na página de regras.
- A senha certa só abre um "desafio" de 5 minutos (até 5 códigos errados); a sessão só nasce com o código. Cada código vale uma vez (não dá para reaproveitar um código visto por cima do ombro).
- 8 códigos de reserva de uso único, mostrados uma vez na ativação, para o caso de perder o celular.
- Sessão de operador dura 12 h (a de jogador, 30 dias).
- Perdeu o celular e os códigos: quem tem acesso ao servidor reinicia com `ARENA_ADMIN_RESETAR_2FA=1` e o operador cadastra o app de novo (fica registrado).

**Jogadores: verificação em duas etapas e saque:**
- Qualquer conta (não visitante) ativa o app autenticador em **Minha conta** (senha → chave → código → 8 códigos de reserva). Com o app ativo, o login pede o código depois da senha.
- **Sacar exige o app ativo e o código em cada saque.** Quem descobrir a senha ou roubar a sessão não tira as moedas. Cada código vale uma vez (dois saques seguidos esperam o próximo código, até 30 s). Até 10 códigos por 15 min.
- Desligar o app pede a senha e um código.

**Contas:**
- Força bruta: limite por IP (20 em 10 min) e por conta (10 em 15 min).
- Descobrir quais e-mails têm conta: login leva o mesmo tempo com ou sem conta; recuperação de senha responde sempre igual.
- Criar contas em massa: 5 cadastros e 5 visitantes por IP por hora.
- Senha fraca: mínimo 8 (12 para o operador), sem repetição de um caractere só.
- Link de recuperação: aleatório, 30 min, uso único, invalida os outros e derruba as sessões. Vai por e-mail (SMTP com TLS obrigatório); o endereço do link vem de `ARENA_SITE_URL`, nunca do cabeçalho `Host` do pedido (quem forjasse o Host faria o e-mail levar a vítima para outro site com o token dela).
- Menores de 18: data de nascimento no cadastro; visitante precisa confirmar 18+ e não pode sacar.

Limites ajustáveis por variável de ambiente (os testes usam valores maiores): `ARENA_CONTAS_POR_HORA` (padrão 5) e `ARENA_LOGINS_POR_IP` (padrão 20). Atrás de proxy/HTTPS: `ARENA_PROXY=1`.

**Servidor:**
- Excesso de pedidos: 600 por minuto por IP na API, e limites por ação (partidas, progresso, carteira).
- Pedidos grandes: 16 KB nas rotas comuns, 1 MB só nas de gravação.
- Replay sobrecarregado: um por partida de cada vez, fila máxima de 100, thread separada com tempo limite.
- Partidas esquecidas: fechadas pelo servidor depois de 2 h.
- Arquivos internos: `package.json`, arquivos ocultos e caminhos com `..` não são servidos.

**Livro-razão:** lançamentos não podem ser alterados nem apagados (gatilhos no banco); correção é um lançamento contrário.

## 3. O que ainda é possível (e o que fazer)

1. **Robô jogando em tempo real.** O jogo é determinístico e a semente vai para o navegador (ele precisa dela para montar o percurso). Um programa pode ler o estado do jogo e "jogar perfeitamente", mandando comandos válidos no ritmo certo; o replay vai confirmar. Hoje isso é contido por:
   - **sinais de robô** na gravação: mais de 20 "viradas" por segundo (inverter o sentido do desvio ou apertar/soltar botão) ou mais de 6 pulos por segundo, impossíveis para uma pessoa → pagamento vai para análise. Arrastar o dedo suavemente não conta, para não pegar quem joga no celular;
   - **limite de pagamento** (`analiseAcimaDe`, padrão 5× a entrada) → acima disso vai para análise;
   - **registro de auditoria** e a tela de análise do operador.
   
   Para fechar de vez seria preciso a **simulação ao vivo no servidor**: o servidor roda a corrida em tempo real e só manda ao navegador o que está na tela, sem revelar a semente. É uma mudança grande de arquitetura (e de custo de servidor).
2. **Moedas de graça.** O depósito ainda é simulado: qualquer conta cria moedas. Na fase 4, o depósito só pode existir pela confirmação do provedor de pagamento (webhook assinado), nunca por pedido do navegador.
3. **Várias contas da mesma pessoa.** Limites por IP ajudam pouco (troca de IP é fácil). Resolve com verificação de identidade (KYC) na fase 4, antes de qualquer saque real.
4. **Navegadores diferentes.** Firefox e Safari podem divergir do servidor em corridas longas (seção "Limite conhecido" no LEIA-ME). Hoje a divergência com pagamento vai para análise.
5. **Limites em memória.** Os contadores de tentativas ficam na memória do processo; com mais de um servidor, precisam ir para um armazenamento compartilhado (Redis, por exemplo).

## 4. HTTPS

Duas formas (escolha uma):
- **No próprio servidor:** `ARENA_TLS_CERT=/caminho/cert.pem ARENA_TLS_KEY=/caminho/chave.pem PORT=443 ARENA_HTTP_REDIRECIONAR=80 node servidor/serve.js`. A porta 80 só redireciona para o HTTPS. O certificado pode ser do Let's Encrypt (gratuito).
- **Atrás de um proxy** (nginx, Caddy, Cloudflare) que cuida do HTTPS: rode em HTTP numa porta interna com `ARENA_PROXY=1`, para o servidor confiar no IP e no protocolo que o proxy informa. Sem `ARENA_PROXY=1` ele ignora esses cabeçalhos (assim ninguém falsifica o IP para escapar dos limites).

Em HTTPS o servidor manda `Strict-Transport-Security` (o navegador passa a recusar HTTP no site) e o cookie de sessão sai com `Secure`.

## 5. Backups

O servidor faz uma cópia do banco ao subir e a cada 6 h (`VACUUM INTO`: cópia consistente, sem parar o site) em `servidor/dados/backups/`, e guarda as 28 mais novas (7 dias). Ajustes: `ARENA_BACKUP_HORAS` (0 desliga), `ARENA_BACKUP_MANTER`, `ARENA_BACKUP_PASTA`. Cópia na hora: `node servidor/backup.js`.

Restaurar: pare o servidor, troque `servidor/dados/arena.db` pela cópia, apague `arena.db-wal` e `arena.db-shm` e suba de novo.

Uma cópia no mesmo disco não protege de disco queimado ou servidor invadido: copie a pasta para fora.

## 6. Antes de dinheiro real

- HTTPS (seção 4).
- Configurar o e-mail (`ARENA_SMTP_URL`, `ARENA_EMAIL_DE`, `ARENA_SITE_URL`) com um provedor que assine os e-mails (SPF/DKIM), senão caem no spam.
- Copiar os backups (`servidor/dados/backups/`) para fora do servidor todo dia (outro disco ou nuvem) e testar uma restauração.
- Saque com prazo de conferência e limites diários; KYC.
- Auditoria externa (teste de invasão) por uma empresa especializada.
- LGPD: o livro-razão é imutável; para apagar uma conta, anonimize os dados pessoais (nome, e-mail, nascimento) e mantenha os lançamentos.
