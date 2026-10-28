# Crash Arena

Plataforma web (modo Solo) + o jogo N. Sanity Beach infinito, num site só. Fases 1, 2 e 3 do [plano](docs/PLANO-INTEGRACAO.md): servidor com contas, carteira e partidas de verdade, e **o servidor refaz cada corrida** para confirmar as frutas. As moedas ainda são **simuladas** (nenhum dinheiro é movimentado).

## Rodar

Precisa do Node 22.5 ou mais novo (usa o SQLite que vem no Node). Uma vez, para o servidor poder refazer as corridas:

```
npm install
```

Depois:

```
node servidor/serve.js 8091
```

Abra http://localhost:8091. Precisa de internet só para a fonte (Google Fonts); o three.js vem do próprio site (`site/js/vendor/`).

**Conta de operador** (muda as regras do jogo e aprova pagamentos em análise): na primeira vez, o servidor cria `operador@arena.local` com uma senha aleatória e mostra no console (também em `servidor/dados/operador-inicial.txt`). Para escolher e-mail e senha (12 caracteres ou mais):

```
ARENA_ADMIN_EMAIL=voce@empresa.com ARENA_ADMIN_SENHA=uma-senha-bem-forte node servidor/serve.js 8091
```

No primeiro acesso à página de regras, o operador ativa a **verificação em duas etapas** (app autenticador no celular: Google Authenticator, Microsoft Authenticator, Authy…). É obrigatória para mudar regras e aprovar pagamentos; depois disso, o login do operador pede a senha e o código do app. Guarde os 8 códigos de reserva mostrados na ativação.

Outras variáveis: `PORT`, `ARENA_DB` (arquivo do banco; padrão `servidor/dados/arena.db`), `ARENA_TLS_CERT` + `ARENA_TLS_KEY` (HTTPS no próprio servidor) e `ARENA_HTTP_REDIRECIONAR` (porta HTTP que só redireciona), `ARENA_PROXY=1` (atrás de nginx/Cloudflare com HTTPS), `ARENA_CONTAS_POR_HORA` e `ARENA_LOGINS_POR_IP` (limites anti-abuso), `ARENA_ADMIN_RESETAR_2FA=1` (desliga o app do operador, se ele perdeu o celular).

**E-mail** (recuperação de senha): `ARENA_SMTP_URL=smtps://usuario:senha@smtp.provedor.com:465` (ou `smtp://...:587` com STARTTLS; sem TLS ele não envia), `ARENA_EMAIL_DE="Crash Arena <nao-responda@seu-dominio>"` e `ARENA_SITE_URL=https://seu-site` (obrigatório com SMTP; é o endereço que vai no link). Sem `ARENA_SMTP_URL`, o e-mail sai no console do servidor.

**Backup:** automático ao subir e a cada 6 h em `servidor/dados/backups/` (guarda 7 dias). `ARENA_BACKUP_HORAS`, `ARENA_BACKUP_MANTER`, `ARENA_BACKUP_PASTA`; cópia na hora com `node servidor/backup.js`. Como restaurar: [docs/SEGURANCA.md](docs/SEGURANCA.md#5-backups).

**Segurança:** ver [docs/SEGURANCA.md](docs/SEGURANCA.md). Teste automático de ataques (sobe um servidor descartável e tenta ~50 fraudes):

```
node ferramentas/testar-ataques.mjs
```

## Fluxo

Entrar (login, criar conta com data de nascimento, ou visitante confirmando 18+; com o app autenticador ativo, o login pede o código) → **Carteira**: depósito/saque simulados (sacar exige a verificação em duas etapas, ativada em **Minha conta**, e o código do app a cada saque) → **Lobby**: valor de entrada + Jogar (o servidor cria a partida e desconta a entrada) → **Jogar**: START (Esc devolve a entrada) → morte → **Resultado**: entrada, frutas, recebido, lucro/prejuízo e saldo.

Regras do jogo (só operador): http://localhost:8091/admin/configuracoes/ — o link "Regras" aparece no menu para o operador.

Esqueci minha senha: o link vai por e-mail (ver **E-mail** acima); sem SMTP configurado, sai no **console do servidor** (`[e-mail para ...]`). Vale 30 minutos e uma vez só.

## Como o servidor confere a corrida (fase 3)

- A corrida é simulada em `site/js/jogo/mundo.js`, o **mesmo arquivo** no navegador e no servidor. Passo fixo de 1/60 s; tudo que é sorteado vem da semente da partida (criada pelo servidor); o desvio para os lados é arredondado para oitavos.
- **Mapa plano:** ao carregar, `prepararNivel` mede a altura do chão da trilha original numa grade (a cada 25 ao longo e 100 para os lados) e tudo o que tem altura (colisão, cenário, inimigos, frutas, câmera) é achatado por ela: o chão fica em y = 0 do começo ao fim. Os buracos continuam buracos; obstáculos altos e curtos continuam obstáculos. A medida fica pronta em `site/data/plano.json` (gerado por `node ferramentas/gerar-plano.mjs`, que confere que dá o mesmo resultado do cálculo): o navegador e o servidor carregam em vez de calcular. **Rode de novo se mudar a fase ou a regra de medida em `mundo.js`.**
- O jogo grava um código por passo (desvio, pulo, pulo segurado) em pares `[código, repetições]` e manda pedaços ao servidor a cada ~2 s e a cada fruta. No fim, manda a gravação inteira.
- O servidor refaz a corrida numa thread separada (`servidor/replay-worker.mjs`, ~20–250 ms por corrida) e **paga as frutas que o replay confirma**. O número que o jogo mostrou fica guardado só para comparação.
- Verificação gravada na partida e mostrada no resultado: `confirmada` (o jogo e o servidor bateram), `divergente` (vale o do servidor), `refeita` (a página fechou; refez com o que chegou), `erro` (não deu para refazer; nada pago).
- Não dá para "acelerar o tempo": a gravação não pode ter mais passos do que o tempo real desde o START (+5 s); o excesso é cortado.
- Teste: `node ferramentas/testar-replay.mjs [semente] [segundos]` — um robô joga e a corrida é refeita; tem que sair `"igual": true`.
- Limite conhecido: Chrome, Edge e o Node usam o mesmo motor (V8), então o replay bate exatamente. Em Firefox e Safari, funções como seno e cosseno podem diferir na última casa decimal e, numa corrida longa, o replay pode sair um pouco diferente (aí vale o do servidor, marcado como `divergente`).

## Controles

| | Teclado | Celular / tablet |
|---|---|---|
| Começar | Espaço | Tocar na tela |
| Voltar ao lobby (antes de começar) | Esc | Botão "← Lobby" |
| Desviar | A / D ou ← / → | Arrastar para a esquerda / direita (qualquer parte da tela) |
| Pular (segurar = mais alto) | Espaço | Arrastar para cima (dedo na tela = mais alto) |

O `level.bin` (22 MB) fica no cache do navegador depois da primeira partida (Cache API, `crash-arena-dados-v1`).

## Pastas

| Pasta | O que tem |
|---|---|
| `site/` | Tudo o que é publicado. Uma pasta por página (`lobby/`, `jogar/`, `resultado/`, `carteira/`, `conta/`, `redefinir/`, `admin/configuracoes/`), mais `css/`, `js/`, `img/`, `audio/` e `data/`. |
| `site/js/arena.js` | Cliente da API: as páginas e o jogo só falam com o servidor por aqui. |
| `site/js/paginas/` | Um arquivo por tela da plataforma, mais `comum.js` (cabeçalho, aviso, formatos). |
| `site/js/jogo/` | Código do jogo. `mundo.js` é a simulação da corrida, compartilhada com o servidor; o resto é física, colisão, trechos, inimigos, configuração e carregamento. |
| `servidor/` | `serve.js` (site + API), `api.js` (rotas), `banco.js` (SQLite), `backup.js`, `email.js` (SMTP), `totp.js` (app autenticador), `replay.js` + `replay-worker.mjs` (refazem as corridas). O banco fica em `servidor/dados/` (não versionar). |
| `ferramentas/` | Não publicadas: geram `site/data/` a partir do disco original (`export.js`, `disgool.js`, `nsf.js`) e testam o replay (`testar-replay.mjs`). |
| `docs/` | Plano de integração e notas técnicas do jogo. |
| `_origem/` | Os originais, intocados: o zip da plataforma e o jogo como estava. Pode apagar quando não precisar mais. |

## API (resumo)

Todas em `/api`, JSON. Pedidos que mudam algo exigem o cabeçalho `X-Arena: 1`. Sessão por cookie `arena_sessao` (HttpOnly, SameSite=Lax, 30 dias). Valores em centavos de moeda.

| Rota | O que faz |
|---|---|
| `POST /cadastro` `{nome, email, senha, nascimento}` | Cria conta (18+, senha com 8+ caracteres) e entra |
| `POST /login` `{email, senha}` → `POST /login/2fa` `{desafio, codigo}` · `POST /visitante` `{maior18:true}` · `POST /sair` | Sessão; com app autenticador, o login devolve um desafio e a sessão sai com o código |
| `POST /conta/2fa/iniciar` `{senha}` · `/confirmar` `{codigo}` · `/desativar` `{senha, codigo}` | App autenticador do jogador (operador: `/admin/2fa/*`) |
| `GET /eu` · `PATCH /eu` `{nome, email, novaSenha?, senhaAtual?}` | Perfil e saldo |
| `POST /recuperar` `{email}` · `POST /redefinir` `{token, senha}` | Recuperação de senha |
| `GET /carteira` · `POST /carteira/deposito` `{valor, metodo}` · `POST /carteira/saque` `{valor, codigo}` | Livro-razão: o saldo é a soma dos movimentos |
| `POST /partidas` `{entrada}` | Cria a partida (semente e regras do servidor) e desconta a entrada |
| `GET /partida` · `POST /partida/resolver` | Partida aberta; resolve uma que ficou pendente (estorna ou encerra com o progresso) |
| `POST /partidas/:id/comecar` · `/progresso` `{desde, rle, frutas, distancia}` · `/cancelar` · `/encerrar` `{rle, frutas, distancia, tempoMs}` | Ciclo da partida; a gravação (`rle`) vai junto e o servidor refaz a corrida para pagar |
| `GET /partidas` · `GET /resultado` | Histórico e última partida |
| `GET /regras` · `PUT /admin/regras` `{regras}` (operador) | Regras do jogo |
