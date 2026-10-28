# Visualizador de fases — Crash Bandicoot (PS1)

Etapa 1 do port: carrega o cenário de uma fase direto dos arquivos do disco e mostra no navegador (three.js).

## Rodar

```bash
node viewer/tools/export.js extraido/SCUS_949.00 extraido/S0/S0000009.NSF viewer/data
node viewer/tools/serve.js 8090
```

Abra http://localhost:8090. Controles: arrastar = olhar, WASD = andar, Q/E = descer/subir, Shift = rápido.

`S0000009.NSF` é N. Sanity Beach. Outras fases funcionam trocando o NSF.

## Arquivos

- `tools/nsf.js` — lê o NSF: chunks de 64 KB, descompressão LZ (magic `0x1235`), entries e itens.
- `tools/export.js` — converte o cenário (entries tipo 3, WGEO) em `data/level.bin` + `data/level.json`.
- `index.html` — renderiza; o shader de fragmento imita a leitura de textura do PS1 (4/8/15 bits, CLUT, semitransparência).

## Formato descoberto (WGEO)

Confirmado contra a função de desenho do jogo em `0x80035438` (`c1c/srczz/zz_35438.h`).

- Item 0 (cabeçalho): `x,y,z` do mundo, nº polígonos, nº vértices, nº structs, nº páginas, ?, 8 EIDs de chunks de textura, depois as structs.
- Vértice (8 bytes): RGB, depois `x = s16 & ~7`, `y = s16 & ~7`; `z` é montado de `byte3 | bits 1–2 de x << 8 | bits 0–2 de y << 10` (13 bits com sinal), × 8.
- Polígono (8 bytes): vértices em `b>>20`, `(b>>8)&0xFFF`, `a>>20`; struct em `(a>>8)&0xFFF`; página em `(a>>5)&7`; bits de textura animada em `a&0x1F` e `b&0x1E`.
- Struct com bit 31 = textura (2 palavras). Byte alto: bit 31 textura, bits 29–30 modo semitransparente (`11` = opaco), bits 24–27 CLUT x/16. Palavra 2: `>>22` índice na tabela de UVs (`0x80051774` no executável), `>>20&3` modo de cor, `>>18&3` segmento da página, `>>13&0x1F` deslocamento u, `>>6&0x7F` linha da CLUT, `&0x1F` deslocamento v.
- Posição no mundo = deslocamento do cabeçalho + vértice; o eixo y já aponta para cima.

## Entidades (ZDAT, tipo 7)

- Item 0 (cabeçalho): `0x204` nº de itens de cabeçalho, `0x208` nº de caminhos de câmera, `0x20C` nº de entidades.
- Item 1: `x, y, z, largura, altura, profundidade` da zona.
- Entidade: `+8` id, `+10` nº de pontos, `+12` rotação, `+18` tipo GOOL, `+19` subtipo, `+20` pontos (3 × s16).
- Posição no mundo = origem da zona + ponto × 4. Isso foi confirmado pelas pilhas de caixas, espaçadas 400 unidades.
- Tipo GOOL → objeto: palavra 0 do item 0 da entry GOOL (tipo 11). A palavra 1 traz a categoria (`0x100` jogador, `0x300` inimigo, `0x400` caixa/item, `0x500` objeto).
- Subtipos de caixa (do código GOOL de `BoxsC`): 0 TNT, 2 comum, 3 seta, 4 checkpoint, 5 ferro, 6 ripada, 7 "!", 8 vida extra, 9 Aku Aku, 10/17 "?", 13 contorno.

## Modelos (SVTX tipo 1 + TGEO tipo 2)

Confirmado contra a função de desenho em `0x8003460C` (`c1c/srczz/zz_3460c.h`).

- GOOL item 5: animações, 8 bytes cada (u16 ?, u16 nº de quadros, u32 EID da SVTX). A instrução `ANID n` / `ANIS seq=n` usa `n` como offset em palavras nessa lista.
- SVTX: um item por quadro. Cabeçalho de 56 bytes (nº de vértices, EID do TGEO, deslocamento x/y/z, caixa de colisão ×256…), depois vértices de 6 bytes `x, y, z, nx, ny, nz`. Posição local = `(byte + deslocamento − 128) × 4 × escala / 4096`.
- TGEO item 0: nº de polígonos, escala x/y/z, nº de palavras de struct, structs. Struct com textura = 3 palavras (cor + flags, EID do chunk de textura, palavra de textura igual à do cenário); sem textura = 1 palavra.
- TGEO item 1: polígonos de 8 bytes: offsets em bytes dos vértices A, B, C e índice da struct (bit 15 = sem iluminação).

## Animação no visualizador

Todos os quadros da animação escolhida são exportados (`anims` no JSON); o visualizador troca posições e cores a 30 quadros/s. Crash usa `WiI1V` (parado); os outros usam a 1ª animação do objeto. Caranguejos e tartarugas vão e voltam pelo caminho da entidade; tartarugas viram na direção do movimento, caranguejos andam de lado.

## Jogar

A página abre no modo de jogo: setas/WASD andam, Espaço pula, J (ou Ctrl) gira (com recarga de 10 s, regra nossa, não do jogo original; o placar mostra o tempo) e F alterna para a câmera livre. O placar no canto superior direito mostra caixas quebradas, inimigos derrotados e mortes desta partida, além do total da sessão (guardado no `sessionStorage` da aba; o botão "Zerar sessão" limpa).

Animações, como no WillC: a corrida (estado 39) toca WiWaV inteira e depois espelhada (`flip=1`), num ciclo de 20 quadros. O parado (estado 1) segura o quadro 11 de WiS1V por 30 ticks, às vezes pisca (12/11) e, de tempos em tempos, faz o gesto 0–10.

- `player.js`: física com as constantes do jogo (ver "Física do Crash"). Animações: `WiS1V` parado, `WiWaV` correndo, `WiJuV` pulando, `WiBlV` girando (`WiI1V`–`WiI3V` são o Crash deitado acordando, da introdução).
- Colisão (`collision.js`): octree do item 1 da ZDAT. Cabeçalho `x, y, z, w, h, d`; `0x1C` raiz; `0x1E–0x22` profundidade máxima por eixo. Os filhos são indexados com bits na ordem x, y, z (confirmado contra as posições das entidades). Folha 0 = vazio; tipo `(v >> 1) & 7` = 1 é chão, os outros tipos bloqueiam (paredes e limites).
- A colisão segue as regras do motor (detalhes em "Colisão do motor" abaixo). O Crash fica no topo das células, que pode ficar algumas dezenas de unidades acima ou abaixo da malha visual, como no jogo.
- Caixas: pular em cima quebra e quica, a seta quica alto, ferro e "!" são sólidos, o contorno é atravessável, o checkpoint vira ponto de renascer. Girar quebra caixas e derruba inimigos. Encostar num inimigo mata. Cair mais de 2.000 unidades abaixo do último chão também mata.
- A câmera segue os trilhos do jogo (abaixo). Se não houver trilho por perto, ela fica atrás e acima do Crash.

## Física do Crash (tirada do jogo)

Unidades: no jogo, velocidades e acelerações são ×256 e multiplicadas por `gamespeed / 1024` a cada quadro (`gamespeed` = 34 a 30 quadros/s, limitado a 102). Então valor ÷ 256 = unidades do mundo por segundo.

| | valor no jogo | unidades/s | onde |
|---|---|---|---|
| Pulo | 1075200 | 4200 | WillC `k[160]` |
| Segurar o pulo | +1396224/s enquanto vy ≥ 512000 | +5454/s², até vy < 2000 | WillC `k[161]`, `k[162]` (`PAD` + `SPD`) |
| Gravidade | 4000 × gamespeed por quadro | 16000/s² | motor, `0x8001FA60` |
| Queda máxima | 3072000 | 12000 | motor |
| Chão: aceleração / máx / freio | 2560000 / 614400 / 2560000 | 10000 / 2400 / 10000 | tabela `0x80052C34` |
| Ar | 1280000 / 614400 / 640000 | 5000 / 2400 / 2500 | tabela `0x80052C44` |
| Giro | 1638400 / 700000 / 102400 | 6400 / 2734 / 400 | tabela `0x80052C54` |
| Diagonal | 327/256 | ×1,28 | tabela de direções `0x80052B64` |
| Quique (provável: caixa/inimigo) | 1295269 | 5060 | WillC `k[172]` |
| Impulso maior (provável: caixa de seta) | 2048000 | 8000 | WillC `k[163]` |

Campos do objeto GOOL (struct do c1c): posição `0x80`, velocidade `0xA4/0xA8/0xAC`, subtipo `0xD4`, animação `0x108`, `speed` `0x124`. `SPD a, b` = `b + a × gamespeed / 1024`. Pulo testado: toque ≈ 480 unidades (1,2 caixa), segurando ≈ 720 (1,8 caixa).

Ainda aproximado: a curva (o campo "30"/"15" das tabelas, provavelmente velocidade de giro) não é usada; o Crash vira na hora. A colisão e as reações das caixas não vêm do jogo.

## Regras de jogo

- **Frutas Wumpa:** sprite de 14 quadros do FruiC. Animações de tipo 2 no item 5 do GOOL: `u16 2, u16 quadros, u32 página de textura`, e depois `(cor/flags, palavra de textura)` por quadro, com os cantos tirados da tabela de UVs. Caixa comum dá 1 fruta, "?" dá de 1 a 5, a ripada dá 1 por quique e quebra no 10º. A cada 100 frutas ganha uma vida.
- **Vidas:** começa com 4. A caixa de vida dá +1; cada morte tira 1; com 0 aparece "Fim de jogo".
- **Aku Aku** (modelo WD10V do DoctC): cada caixa dá uma máscara. Um golpe de inimigo tira uma máscara e deixa o Crash invencível por 1,5 s. Com 3 máscaras ele fica invencível por 20 s e depois volta para 2. Buracos matam mesmo com máscara, e morrer tira a máscara.
- **Morte:** o Crash some por 1,2 s e renasce no último checkpoint, piscando.
- **Fim da fase:** chegar perto da saída (WarpC) mostra tempo, caixas, frutas, inimigos e mortes, com o botão "Jogar de novo".

Esses números (frutas por caixa, vidas iniciais, tempos) seguem o comportamento conhecido do Crash 1 e são ajustáveis no topo de `player.js` e em `index.html`. Não foram lidos do código GOOL das caixas.

## Modo infinito

Ligado por padrão; desmarque "modo infinito" no painel (ou abra com `?modo=fase`) para jogar a fase normal.

- **Abertura real:** a fase original vai do início da praia até z = 101100, logo depois das duas caixas empilhadas e antes da primeira escada das ruínas (zona a4_9Z). Dali em diante o resto da fase é escondido: corte em `clipZ` no shader, colisão da octree ignorada e entidades desligadas.
- **Continuação feita da própria fase** (`levelchain.js`): a trilha real foi medida ao longo de z (centro, largura e altura do chão; é quase uma reta em −z) e cortada em 4 trechos-modelo, em pontos estreitos de ~1 550–1 700 de largura para as emendas casarem:

  | Trecho | z | Conteúdo |
  |---|---|---|
  | descida | 124 500 → 119 000 | selva descendo; buraco a 1 900 do início |
  | baixada | 119 000 → 113 000 | trilha baixa; buraco a 3 100 do início |
  | subida | 113 000 → 105 000 | morro da selva e os dois buracos antes das ruínas |
  | ruinas | 105 000 → 101 300 | chegada às ruínas, sem buraco |

  Buracos da trilha real (z): 122 600–122 100, 115 900–115 200, 108 300–107 600 e 106 300–105 200. O ponto de troca (z 101 300) fica no chão plano logo antes do primeiro degrau da escada, que começa em z 101 200.

  Cada trecho leva o cenário, a colisão da octree (consultada no espaço do modelo e cortada nas pontas), os trilhos de câmera e as entidades originais. As cópias vêm em ordem sorteada, sem repetir o trecho anterior, e são deslocadas em x/y/z para a entrada de uma encostar na saída da outra. Ficam montadas até ~26 000 unidades à frente e são apagadas 6 000 para trás.
- **Começo seguro:** cada trecho é verificado ao carregar (largura > 0 e sem degrau maior que 300 entre amostras nos primeiros 1 500). Um trecho que falhe fica fora do sorteio e gera aviso no console. Hoje os quatro passam.
- **Emendas sem borda:**
  - a altura de alinhamento é o chão medido 100 para dentro de cada lado da emenda (dá degrau 0 em todas);
  - cada trecho inclui inteiros os triângulos que cruzam o corte, então os vizinhos se sobrepõem um pouco;
  - uma "saia" escura de terra, que segue a altura do chão ao longo da largura, fecha as frestas laterais.
- **Sem caixas:** no modo infinito não há caixas, nem as da fase nem as dos trechos (`noBoxes`). As caixas originais ficam escondidas. Os inimigos originais às vezes faltam numa cópia, e entram caranguejos extras em pontos livres da trilha (chão firme, longe dos buracos e de outros inimigos), mais numerosos com a dificuldade.
- **Os buracos são os da fase original**, então não mudam de tamanho. A variação vem da ordem dos trechos e dos inimigos.
- **Guia (sem colisão com cenário):** no modo infinito o Crash não colide com paredes, árvores nem teto; os modelos continuam visíveis. Ele fica preso a um corredor que segue a trilha medida (centro e largura em cada z, com folga de 150 da borda; nos buracos vale a largura dos vizinhos). Não há puxão automático para o centro. Chão, degraus, buracos e inimigos continuam valendo.
- **Buraco mata na hora:**
  - no ar, ele só pousa em chão abaixo de onde os pés estavam, quando já caiu mais de 120 abaixo da borda; assim não "sobe" a parede do buraco;
  - caindo mais de 250 abaixo da borda, dentro de um buraco da trilha ou dentro da rocha, morre imediatamente (~0,4 s depois de passar da borda).
- **Velocidade:** sobe aos poucos com a distância percorrida desde o início, de 0,9× até 1,6× em 120 000 unidades. Os inimigos acompanham. A 0,9× o maior buraco (1 100) ainda se pula com folga.
- **Morte:** renasce no começo do trecho em que estava.
- **Câmera:** os trilhos do jogo do trecho original, deslocados junto com a cópia.
- **Pontos:** distância (1 a cada 100 unidades) + 10 por fruta + 50 por caixa + 100 por inimigo. O recorde fica no `localStorage`.
- Todas essas regras são nossas, não do jogo original.

## Inimigos (enemies.js, lido do GOOL)

Progresso no caminho: 256 por segmento. `TRI` é a onda triangular de vai e volta; `PRS` suaviza em seno nas pontas.

- **Caranguejo (CrabC):** o estado 1 anda com `TRI` + `PRS` a 1024/s (4 pontos/s, ~400 unidades/s em média, freando nas pontas) e toca Cr19V (19 quadros). Evento 0 (cair em cima) leva ao estado 2: troca para Cr29V, gira 682/4096 e encolhe 409/4096 por tick até sumir, e o Crash quica. Evento 4 (giro) leva ao estado 3: sai voando para longe do Crash a 4000/s, +1200/s por tick até 16000, encolhendo 136/4096 por tick.
- **Tartaruga (TurtC):** o estado 2 anda com `TRI` a passo fixo de 74 por tick, sem suavizar (~900 unidades/s), 100 acima do caminho, virando no máximo 227/4096 por tick; ciclo de 16 quadros de Tu19V. Evento 0 leva ao estado 3: vira de costas (Tu29V 0–9, Tu59V 0–21), espera 105 ticks, se sacode (±170 e ±341) e desvira (Tu59V 21→0, Tu39V 7→0). Virada ela não machuca, e pular nela faz o Crash quicar com `k[43]=1295269` e reinicia a espera. Evento 4 leva ao estado 4 (sai voando, igual ao caranguejo).
- Mapa evento → estado: item 3 do GOOL, antes de `cabeçalho[0x10]`. Que o evento 0 é "caiu em cima" e o 4 é "giro" foi deduzido pelo efeito dos estados.
- A fase inicial do vai-e-vem de cada inimigo varia pelo id (o jogo calcula a partir da entidade, ainda não decifrado).

## Colisão do motor

Lida em `c1c/srczz`. Folha da octree: tipo `t = (v & 0xE) >> 1`, sub `= (v & 0x3F0) >> 4`. Nesta fase: t0 (valor 1) = limites/paredes invisíveis; t1 sub 50–58 = chão andável (o sub é o tipo de piso); t2 (valor 5) = blocos sólidos; t3 = fundo dos buracos (só no fundo das zonas).

- `0x800294B0`: junta as folhas das zonas vizinhas numa caixa ±300 (x/z), −267…+932 (y) em volta do Crash; `0x80037D50` percorre a octree.
- Chão, `0x80038AC4` + `0x8002C8EC`: coluna de ±6,25 em x/z, dos pés à cabeça (+665). Entram as células com topo ≤ pés + 244 (+ o que caiu no quadro). Tipos 3/4 ficam de fora e passam pelo callback `0x8002C3B8` (t3 dispara o evento 0x900). Resultado = **média dos topos**, separada entre tipo 0 e os demais. Tipo ≥1 coloca o Crash no topo; só tipo 0 faz a queda parar na altura anterior.
- Objetos, `0x8002C660`: caixas e plataformas têm prioridade; pegada ±75, topo até pés + 244.
- Degrau: 62500 (244 unidades), global em `0x800564BC`.
- Paredes, `0x8002DF50` → `0x8003864C`: t1 bloqueia quando o topo passa de pés + 244; t0/t2 quando passa de pés + 50 (sub 1–38 não bloqueia); t3/t4 nunca. As células são desenhadas numa grade de 8 unidades em volta do Crash (como ponto, sem raio), e `0x8002E3F8` procura a célula livre mais próxima em espiral (tabela `0x80052A34`).

Aproximações em `player.js`: as paredes são testadas ponto a ponto, em passos de 8 unidades ao longo do movimento, em vez da grade com busca em espiral. O teto é uma checagem simples na altura da cabeça (`0x8002CD9C` não foi lido). Tocar t3 mata (provável, pelo evento 0x900).

## Trilhos de câmera (ZDAT, itens `0x204 … 0x204 + 0x208 − 1`)

- Cabeçalho de 50 bytes: `+0` EID da slst, `+4` zona-mãe, `+8` nº de ligações, `+12` até 4 ligações de 4 bytes (relação, índice da zona vizinha, índice do caminho, objetivo), `+28/+29` entrada/saída, `+30` nº de pontos, `+32` modo, `+34` distância média entre pontos, `+36` zoom (distância câmera–Crash), `+44` direção da fase (3 × s16, 4096 = 1).
- Pontos a partir de `+50`, 12 bytes: posição `x, y, z` (relativa à origem da zona, unidades do mundo) e rotação `x, y, z` (4096 = 360°).
- O visualizador escolhe o ponto que fica `zoom` unidades atrás do Crash na direção da fase e usa a posição e a rotação desse ponto. A regra de escolha é minha; a do jogo ainda não foi lida.
- Teste: com o Crash posto sobre as caixas e inimigos da fase, ele aparece na tela em 51 de 60 posições.

## GOOL

`tools/disgool.js` desmonta o bytecode (portado de `c1c/src/disgool.c`): `node viewer/tools/disgool.js extraido/S0/S0000009.NSF BoxsC 2 13`. O subtipo escolhe o estado inicial: `item3[cabeçalho[0x10] + subtipo]`.

## Morte e sons

- Morte por inimigo (WillC estado 23): `WiK1V` → `WiK2V` (com giro) → `WiK3V` → `WiK4V`, cerca de 4,2 s. Sons: `arg0A` + `ds10A`, depois `d1a0A` e `d1b0A`.
- Queda no buraco (estado 22): `WiJSV`, depois a pose de queda (`WiJuV` quadro 15). Som: `fal0A`. A câmera fica parada e só acompanha o Crash com o olhar.
- Também tocam: pulo `jmp0A`, giro `spn0A`, passos `fs00A`/`fs10A`.
- `tools/export.js` decodifica os 41 ADIO (VAG ADPCM do PS1) para `data/sfx/*.wav`. A taxa de 11 025 Hz é uma suposição (`SFX_RATE`). O áudio só começa depois da primeira tecla ou clique, por regra do navegador.
- Frutas na trilha (fase infinita): um grupo por trecho, 3 ou 5 frutas em fila reta, na esquerda, no centro ou na direita (sorteado), num ponto livre longe de buracos. O Crash pega ao encostar (som `frt0A`); cada 100 frutas viram uma vida.
- Placa SCORE (modo infinito): `assets/hud/score-board.png` com os pontos em números de `assets/hud/digits.png` (grade 3×3 de 1 a 9, recortada no navegador). A grade não tem 0; ele é desenhado no mesmo estilo. Em telas com menos de 1150 px a placa fica embaixo.
- Antes do START, uma tela pede um valor em reais (a partir de R$ 1,00). O saldo começa em zero e cada fruta devolve `fruitPercent` % do valor (placa SALDO R$ com centavos). No fim, um modal mostra depositado, frutas, recebido e lucro/prejuízo.
- Tela inicial `assets/hud/start.png`: o jogo fica parado até a barra de espaço. Fim de jogo `assets/hud/game-over.png` (uma vida só); depois dele, só recarregando a página. Pontos = 10 por fruta. Música: `assets/music/` (lista `MUSIC`).
- `/configuracoes` (`configuracoes/index.html` + `config.js`, salvo no localStorage `crash1-config`): valor de cada fruta em % do depósito (padrão 5%, mostra quantas frutas empatam); velocidade inicial (0,9×), acréscimo a cada 100 m (0,058) e máxima (1,6×); inimigos por chunk (automático ou número exato), inimigos no bloco inicial (padrão 0), tamanho mínimo/máximo dos grupos de frutas (padrão 3–5), mínimo e máximo de buracos por chunk (padrão 0–2, até 99). O número é sorteado na faixa e o chunk junta trechos reais até somá-lo (ruínas 0, descida 1, baixada 1, subida 2); inimigos e o grupo de frutas valem para o chunk inteiro.
- Guia (`player.js`): sem teto e sem travar em paredes/árvores pela frente, mas para o lado o Crash não entra em bloco mais alto que o degrau, e para a frente obstáculos baixos (topo até `LOW_OBSTACLE` = 1000 acima dos pés, como a fileira de pilastras deitadas em z 120 400) seguram até ele pular. Pouso até `LEDGE_TOL` = 150 abaixo da beirada de um buraco ainda sobe nela (antes ele afundava no chão).
- Primeiro trecho: é o começo real da fase até z 113 000 (`LOOP_END_Z`), com só 2 buracos e sem inimigos; depois vêm os trechos sorteados.
- Junções dos chunks: um portal de pedra (`gateGeometry`) cobre o céu entre as peças.

## Ainda não feito

Frutas Wumpa e vidas, física real do Crash (GOOL WillC), velocidade real das patrulhas (estimada; no jogo vem do GOOL), animações por estado (andar/atacar/morrer), texturas animadas (usa só o quadro 0), cor do céu/névoa da zona, lógica GOOL (interpretador).
