# Crash Arena + jogo do Crash — plano de integração

> Versão 2. Mudanças: a plataforma terá **um único modo, o Solo**, e a estrutura do site foi reorganizada (seção 4).
>
> **Andamento (21/10/2026):** **fase 1 concluída.** A estrutura está em `site/`, `servidor/`, `ferramentas/` e `docs/`; os originais foram para `_origem/`. Como rodar: `LEIA-ME.md` na raiz.
> - Item 6: a página do jogo usa as fontes e cores da plataforma (tela de carregamento, barra da tela de START, ajuda). O `level.bin` baixa com barra de progresso e fica no cache do navegador (Cache API); nas próximas partidas só um HEAD confere se mudou.
> - Item 7: no celular, **arrastar na metade esquerda** desvia, **tocar na metade direita** pula (segurar pula mais alto) e o botão **GIRO** gira (fica cinza na recarga). A tela de START começa com um toque e tem o botão "← Lobby". Isso substitui o "deslizar/tocar" do texto abaixo: com a corrida analógica do jogo, dividir a tela evita pular sem querer ao desviar.
> - Extra: o jogo só encerra a partida que ele mesmo abriu (por id), para duas abas abertas não se atrapalharem.
> - Os direitos de imagem e marca (seção 2) ficam para depois, como combinado.
>
> **Fase 2 concluída (21/10/2026).** Servidor em Node sem dependências (`servidor/`: `serve.js`, `api.js`, `banco.js` com o SQLite do Node). Detalhes e rotas no `LEIA-ME.md`.
> - Contas: cadastro com data de nascimento (só 18+), login, visitante confirmando 18+, recuperação de senha com link de uso único (30 min). Ainda **sem envio de e-mail**: o link sai no console do servidor.
> - Segurança: senha com scrypt, sessão em cookie HttpOnly (o banco guarda só o hash do token), pedidos que mudam algo exigem `X-Arena: 1`, limite de tentativas de login.
> - Carteira como livro-razão (saldo = soma dos movimentos), com transação em toda operação que mexe no saldo.
> - Partidas criadas pelo servidor (semente, regras e entrada); o servidor calcula o valor recebido. Limite provisório de plausibilidade: no máximo 3 frutas por segundo de corrida, mais 10 (a verificação de verdade é a fase 3).
> - Regras do jogo no servidor; `/admin/configuracoes/` só para a conta de operador.
> - Testado: cadastro (e recusa de menor de 18), login, logout, recuperação de senha, depósito, saque sem saldo recusado, partida completa, cancelamento, pedido sem o cabeçalho de proteção recusado, operador salvando regras e jogador comum recusado, e duas partidas criadas ao mesmo tempo sem gastar o saldo duas vezes.
> - Pendente para produção: serviço de e-mail, HTTPS na frente do servidor, backup do banco.
>
> **Fase 3 concluída (21/10/2026).** O servidor refaz cada corrida e paga as frutas que ele confirma.
> - A simulação saiu de `jogar/index.html` para `site/js/jogo/mundo.js`, usado pelo jogo e pelo servidor (que agora tem `three` como dependência, `npm install`). Passo fixo de 1/60 s, sorteios só pela semente (os caranguejos extras do bloco inicial também), desvio arredondado para oitavos.
> - O jogo grava os comandos por passo e manda pedaços durante a corrida e a gravação inteira no fim; o servidor refaz numa thread separada. Substitui o limite provisório de 3 frutas por segundo da fase 2.
> - Testado: robô em Node em várias sementes (o replay bate em frutas, distância e passo da morte); corrida no navegador com controles de toque (18 frutas, distância 47 142, confirmadas pelo servidor); jogo dizendo ter pego 50 frutas (pagas as 5 de verdade, marcada `divergente`); gravação com mais passos que o tempo real (cortada, nada pago); página fechada no meio (refeita com o que tinha chegado).
> - Saíram do jogo, por não caberem na simulação compartilhada: o modo "fase" original (`?modo=fase`) e a corrida enquanto a câmera livre (F) está ligada.
> - Limite conhecido: em Firefox/Safari, diferenças mínimas de seno/cosseno podem fazer o replay divergir numa corrida longa (vale o do servidor).
>
> **Blindagem antifraude (21/10/2026).** Detalhes, ataques cobertos e riscos que sobram em [SEGURANCA.md](SEGURANCA.md). Resumo: gravação só cresce e nunca passa do tempo real; comandos impossíveis recusados; limites de pedidos por IP/usuário/conta; login sem vazar quais e-mails existem; CSP, bloqueio de iframe e three.js servido pelo próprio site; livro-razão imutável e sem saldo negativo (gatilhos no banco); pagamentos com sinais de robô ou acima de N× a entrada vão para análise do operador; registro de auditoria. Teste: `node ferramentas/testar-ataques.mjs`.

O que existe hoje na pasta `crash/`:

- `plataforma/` — conteúdo de `Crash-Arena-Frontend.zip` (front-end estático da plataforma).
- `jogo/` — o jogo que criamos (pasta `viewer` do projeto em `Downloads/Crash Bandicoot (USA)`). Para rodar: `node jogo/tools/serve.js 8090` e abrir http://localhost:8090.

## 1. O que é cada parte

### Plataforma (Crash Arena)

Protótipo **só de front-end**: HTML, CSS e JavaScript puro, sem servidor, banco de dados ou build. O próprio LEIA-ME diz que não há autenticação real, multiplayer nem pagamentos.

| Tela | O que faz hoje |
|---|---|
| Login / Criar conta / Visitante | Formulário que só guarda nome e e-mail na memória da página. |
| Lobby | Três modos multiplayer (Corrida da ilha 4 jogadores, Duelo 1 contra 1, Corrida turbo 3 jogadores) e uma fila "Buscar partida" de demonstração. **Sai tudo isso e fica só o Solo.** |
| Carteira | Depositar (Pix ou cartão) e sacar, **simulados**. R$ 1 = 1 moeda. O saldo existe só enquanto a página está aberta. |
| Minha conta | Edita nome, e-mail e senha só na sessão. |

Tudo fica em um único `app.js` (cerca de 30 linhas longas), que monta cada tela com `render(view)` e um `<dialog>` para a fila e o pagamento. O `style.css` acumula várias camadas de regras para o fundo do lobby. A última vence e usa `lobby-mode-4.jpg`, e há referências a imagens que não estão no zip (`lobby-four.jpg`, `lobby-two.jpg`, `lobby-three.jpg`).

### Jogo (N. Sanity Beach infinito)

Endless runner no navegador (three.js), **para um jogador**, montado com dados lidos do disco original de Crash Bandicoot 1:

- Começo real da fase, seguido de trechos reais sorteados sem fim (`levelchain.js`, com semente).
- Física, colisão e animações tiradas do código do jogo.
- Uma vida só. Inimigos, buracos e grupos de frutas.
- **Fluxo de dinheiro dentro do jogo:** tela "Quanto você vai colocar?" → START → cada fruta devolve X % do valor → ao morrer, um resumo mostra depositado, frutas, recebido e lucro/prejuízo.
- `/configuracoes`: inimigos, frutas, buracos, % por fruta, velocidade. Tudo fica no `localStorage`.
- Peso: cerca de 33 MB, dos quais `data/level.bin` tem 22 MB.

## 2. Pontos que precisam de decisão antes de tudo

1. **Direitos de imagem e marca (bloqueante para uso comercial).** O jogo usa modelos, texturas, sons e música extraídos do disco original, e a plataforma usa o nome "Crash" e os personagens Crash, Coco, Cortex e Tiny. Tudo isso pertence à Activision (marca e personagens) e à Sony (jogo original). Para lançar comercialmente há dois caminhos:
   - obter licença dos donos, ou
   - trocar por arte, personagens, sons e nome próprios.

   Se for trocar, o motor do jogo (física, trechos encadeados, regras) pode continuar. Saem os dados do disco: `level.bin`, `sfx` e a música.
2. **Dinheiro real (bloqueante para cobrar ou pagar).** Entrada em dinheiro, ganho conforme o desempenho e saque formam um jogo com aposta. No Brasil isso é regulado: a Lei 14.790/2023 e as portarias da Secretaria de Prêmios e Apostas (Ministério da Fazenda) exigem, entre outras coisas:
   - autorização para operar;
   - verificação de identidade e idade mínima de 18 anos;
   - regras de jogo responsável;
   - prevenção à lavagem de dinheiro.

   Antes de qualquer real de verdade, é preciso um parecer jurídico. Até lá, mantenha tudo como **moedas simuladas**, como a plataforma já faz.
3. **Justiça do resultado.** Hoje o jogo roda inteiro no navegador. Qualquer pessoa pode mudar o próprio saldo ou o número de frutas pelo console. Se o resultado valer moedas ou dinheiro, quem decide o resultado tem de ser o servidor (fase 3).

## 3. O modo Solo

É o único modo da plataforma: o jogo como ele é hoje, ligado à carteira.

- O jogador escolhe no **lobby** o valor de entrada (em moedas), sempre menor ou igual ao saldo da carteira.
- A entrada sai da carteira quando a corrida começa.
- Cada fruta devolve **X % da entrada** (X definido pelo operador; hoje o padrão é 5 %, ou seja, 20 frutas para recuperar a entrada).
- Ao morrer (uma vida só), o valor recebido entra na carteira e aparece o resumo: entrada, frutas, recebido e lucro/prejuízo.
- As regras do percurso (velocidade, buracos, inimigos, frutas) são as de `/configuracoes`, definidas pelo operador e iguais para todos os jogadores.

### Fluxo do jogador

```
Entrar (login ou visitante)
  → Lobby: valor de entrada + [Jogar]
  → plataforma desconta a entrada e cria a partida (id, semente, regras)
  → /jogar: START (espaço) → corrida → morte
  → jogo devolve o resultado (frutas, distância, tempo, recebido)
  → /resultado: resumo + carteira atualizada → [Jogar de novo] ou [Lobby]
```

A tela "Quanto você vai colocar?" sai do jogo: o valor vem do lobby. O resumo de fim de jogo também sai do jogo e vai para a página `/resultado` da plataforma. O jogo só mostra a imagem de partida encerrada e leva o jogador para lá.

## 4. Nova estrutura do site

### Endereços

| Endereço | Página | Quem acessa |
|---|---|---|
| `/` | Entrar: login, criar conta, visitante (a tela de login atual) | todos |
| `/lobby/` | Lobby do Solo: saldo, valor de entrada, botão Jogar, últimas partidas | jogador logado |
| `/jogar/` | O jogo, já com a entrada, a semente e as regras da partida | jogador com partida aberta |
| `/resultado/` | Resumo da partida e saldo atualizado | jogador, ao fim da partida |
| `/carteira/` | Saldo, depositar, sacar e histórico de movimentos | jogador logado |
| `/conta/` | Perfil | jogador logado |
| `/admin/configuracoes/` | As configurações do jogo (hoje `/configuracoes`) | só o operador |

Hoje a plataforma é uma página só que troca o conteúdo com `render(view)`. A proposta separa cada tela em uma página própria, com endereço próprio. Assim o botão Voltar do navegador funciona, dá para ir direto ao jogo e voltar dele, e cada página carrega só o que precisa: o jogo, com 33 MB, só carrega em `/jogar/`.

### Pastas

```
crash/
├── site/                         ← tudo o que é publicado (raiz do servidor)
│   ├── index.html                Entrar
│   ├── lobby/index.html
│   ├── jogar/index.html          o jogo (index.html atual do jogo)
│   ├── resultado/index.html
│   ├── carteira/index.html
│   ├── conta/index.html
│   ├── admin/configuracoes/index.html
│   ├── css/
│   │   ├── base.css              cores, fontes, botões, cabeçalho (vem do style.css, limpo)
│   │   └── paginas.css           regras de cada tela (vem do style.css + lobby.css)
│   ├── js/
│   │   ├── arena.js              sessão, carteira, histórico e partida (estado compartilhado)
│   │   ├── paginas/              um arquivo por tela (entrar.js, lobby.js, carteira.js, conta.js, resultado.js)
│   │   └── jogo/                 código do jogo: player.js, levelchain.js, collision.js, enemies.js, config.js
│   ├── img/
│   │   ├── plataforma/           artes da plataforma (só as usadas)
│   │   └── jogo/                 placa SALDO, números, START, partida encerrada
│   ├── audio/                    música e efeitos do jogo (hoje jogo/assets/music e jogo/data/sfx)
│   └── data/                     level.bin e level.json
├── servidor/
│   └── serve.js                  servidor estático (hoje jogo/tools/serve.js); na fase 2, a API
├── ferramentas/                  não publicadas: export.js, disgool.js, nsf.js (geram data/ a partir do disco)
└── docs/
    ├── PLANO-INTEGRACAO.md
    └── jogo-formato.md           notas técnicas do jogo (hoje jogo/README.md)
```

Pontos da mudança:

- **`site/` é a única pasta publicada.** As ferramentas que leem o disco e a documentação ficam de fora.
- **`js/arena.js` é o único lugar com estado:** sessão do jogador, carteira, partida aberta e resultado. As páginas e o jogo leem e gravam por ele, e na fase 2 ele passa a chamar o servidor sem que as páginas mudem.
- **CSS limpo:** juntar `style.css` e `lobby.css` em `base.css` e `paginas.css`, apagando as camadas repetidas de fundo do lobby e os estilos dos modos que saem (cartões de modo, fila de busca, `racers-2/3/4`, `mode-0/1/2`).
- **Imagens que saem com o fim dos modos multiplayer:** `lobby-two-players.png`, `lobby-two-v2.png`, `lobby-three-v2.png`, `lobby-four-v2.png`, `lobby-clean-four.png`, `lobby-left-racers.png`, `lobby-racers.png`, `lobby-race-new.png`, `lobby-mode-2.jpg`, `lobby-mode-3.jpg`, `lobby-mode-4.jpg`, `race-map.png` e os `character-*.png`. Fica uma arte de fundo para o lobby do Solo, escolhida entre elas. Isso tira cerca de 30 MB do site.
- **Referências quebradas a remover:** `lobby-four.jpg`, `lobby-two.jpg`, `lobby-three.jpg`.

### Como as páginas conversam (fase 1, sem servidor)

Tudo fica na mesma origem, então `arena.js` guarda o estado no navegador:

- `localStorage['arena-carteira']`: saldo e histórico de movimentos (entrada, prêmio, depósito, saque).
- `sessionStorage['arena-partida']`, criada pelo lobby ao clicar em Jogar:
  ```json
  { "id": "p_123", "entrada": 20, "semente": 918273,
    "regras": { "fruitPercent": 5, "speedStart": 0.9, "speedGain": 0.058, "speedMax": 1.6,
                "pitsMin": 0, "pitsMax": 2, "enemiesPerChunk": "auto", "fruitMin": 3, "fruitMax": 5 } }
  ```
- `sessionStorage['arena-resultado']`, gravada pelo jogo ao fim: `{ id, frutas, distancia, tempoMs, recebido }`. O jogo então leva para `/resultado/`.
- `/jogar/` sem partida aberta volta para `/lobby/`. Recarregar a página do jogo no meio da corrida encerra a partida com o que foi coletado até ali (a entrada já saiu da carteira).

## 5. Fases

### Fase 1 — Site único com o Solo (moedas simuladas, sem servidor)

1. Criar a estrutura da seção 4, movendo os arquivos atuais para lá e ajustando caminhos (o jogo carrega `data/`, `img/jogo/` e `audio/` dos novos lugares).
2. `arena.js`: sessão, carteira persistente com histórico, partida e resultado.
3. Páginas da plataforma: Entrar, Lobby do Solo, Carteira (com histórico), Conta, Resultado. Tirar os modos multiplayer, a fila de busca e o CSS e imagens deles.
4. Jogo: ler a partida (entrada, semente, regras), sem a tela "Quanto você vai colocar?" e sem o resumo próprio; gravar o resultado e ir para `/resultado/`. O `LevelChain` já aceita semente; falta passar a da partida.
5. `/admin/configuracoes/`: mesma página de hoje, no novo endereço.
6. Visual: unificar fontes e cores (a plataforma usa roxo/laranja com Barlow Condensed e Inter; o jogo usa madeira/dourado). Tela de carregamento com progresso para os 22 MB do `level.bin`, e cache dele depois da primeira vez.
7. Celular: controles de toque no jogo (deslizar para os lados, tocar para pular, botão de giro).

### Fase 2 — Servidor (contas, carteira e partidas de verdade, ainda sem dinheiro real)

- Autenticação real: cadastro, login, recuperação de senha e verificação de idade.
- Carteira como livro-razão: cada movimento é um lançamento e o saldo é a soma. Nada de saldo solto editável.
- Partidas: o servidor cria a partida, sorteia a semente, guarda as regras e desconta a entrada.
- `/admin/configuracoes/` com login de operador; as regras passam a sair do servidor.
- `arena.js` troca o `localStorage` por chamadas à API, sem mudar as páginas.

### Fase 3 — Resultado à prova de trapaça

- O jogo grava os comandos do jogador por quadro (esquerda, direita, pulo, giro) e envia no fim, com a semente.
- O servidor refaz a corrida com o mesmo código de física (`player.js`, `levelchain.js`, `collision.js` rodam em Node) e calcula frutas e distância ele mesmo; o resultado do navegador não vale.
- Para isso o jogo precisa de passo fixo de 1/30 s (hoje usa o tempo real entre quadros) e de tudo que afeta o resultado vindo da semente. Os caranguejos extras do bloco inicial ainda usam `Math.random`. Frutas voadoras, tom dos sons e a animação parada também usam, mas não afetam o resultado.

### Fase 4 — Dinheiro real (só com o jurídico resolvido)

- Provedor de Pix/cartão autorizado, verificação de identidade (KYC), limites de depósito e de perda, autoexclusão e relatórios exigidos pelo regulador.
- Revisar os textos de "simulação" e de lucro/prejuízo conforme a orientação jurídica.

## 6. Próximo passo sugerido

**Fase 1, itens 1 a 4:** montar a nova estrutura, criar `arena.js` e ligar Lobby → Jogo → Resultado → Carteira com moedas simuladas. É o menor passo que mostra a plataforma e o jogo funcionando juntos no modo Solo, e não depende das decisões da seção 2.
