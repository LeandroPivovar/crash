// Crash controlável. Constantes tiradas do jogo (unidades do mundo e segundos; uma caixa mede 400).
// No jogo os valores são ×256 e são multiplicados por gamespeed/1024 por quadro (gamespeed = 34 a 30 qps),
// ou seja, valor/256 = unidades por segundo.
import * as THREE from 'three';

// Tabelas de movimento do motor em 0x80052C24 (aceleração, velocidade máxima, ?, desaceleração),
// escolhidas pelas flags do objeto; aplicadas em 0x8001F30C.
const MOVE = {
  ground: { accel: 2560000 / 256, max: 614400 / 256, decel: 2560000 / 256 },
  air: { accel: 1280000 / 256, max: 614400 / 256, decel: 640000 / 256 },
  spin: { accel: 1638400 / 256, max: 700000 / 256, decel: 102400 / 256 },
};
const DIAGONAL = 327 / 256;              // tabela de direções em 0x80052B64: diagonal anda 28% mais rápido
const GRAVITY = 4000 * 1024 / 256;      // motor, 0x8001FA60: vy -= 4000 × gamespeed por quadro
const TERMINAL = 3072000 / 256;         // velocidade máxima de queda
// GOOL do Crash (WillC), estados de pulo:
const JUMP_SPEED = 1075200 / 256;       // k[160]
const JUMP_HOLD = 1396224 / 256;        // k[161]: soma enquanto o botão segue apertado
const JUMP_HOLD_MIN = 512000 / 256;     // k[162]: abaixo dessa vy o pulo vira queda
// Pulos mais fáceis (não existem no jogo original):
//  - margem depois da borda: ainda pula até 0,1 s depois de sair do chão (caindo, sem ter pulado);
//  - pulo antecipado: apertar até 0,12 s antes de encostar no chão pula assim que encosta.
const MARGEM_BORDA = 0.1, PULO_GUARDADO = 0.12;
const BOUNCE_SPEED = 1295269 / 256;     // k[172]: quique (provável: ao cair em caixa/inimigo)
const ARROW_BOUNCE = 2048000 / 256;     // k[163]: impulso maior (provável: caixa de seta)
const RADIUS = 120;          // contato com inimigos
const TURN_RATE = 20;        // rad/s da virada do modelo (ajuste meu; o jogo aproxima o ângulo em 0x800243A0)
const BODY = 150;           // meia-largura do Crash (caixa de colisão do modelo: 300 × 665 × 300)
const SPIN_TIME = 0.45;
const SPIN_COOLDOWN = 10;    // segundos até poder girar de novo (regra pedida, não existe no jogo original)
const SPIN_RADIUS = 420;
const BOX = 400;
const FALL_DEATH = 2000;
const PIT_DROP = 250;      // com guia: caindo mais que isso abaixo da borda, dentro de buraco ou rocha = morte
const LOW_OBSTACLE = 1000; // com guia: obstáculo à frente com topo até isto acima dos pés segura o Crash (pula-se)
const LEDGE_TOL = 150;     // com guia: pousando até isto abaixo do topo da beirada, ainda sobe nela
const DOWN_SNAP = 130;     // desnível que ele desce andando sem sair do chão (ajuste meu, não do jogo)
// Colisão (motor):
const STEP = 62500 / 256;  // degrau: variável global em 0x800564BC (GP + 0xC0)
const HEIGHT = 0x29900 / 256;  // altura do corpo usada nas consultas (665)
const COLUMN = 1600 / 256;  // meia-largura da coluna de chão (±6,25)
const OBJ_FOOT = 19200 / 256;  // pegada para pisar em objetos (±75)
const GRID = 8;  // grade de paredes: (valor << 2) >> 13 = 8 unidades por célula

// Mortes, como no GOOL do Crash (WillC). Passos em ticks de 1/30 s:
//   { sound: [...] }                       toca sons (nomes das entries ADIO)
//   { anim, a, b }                         quadros a..b da animação, 1 tick cada
//   { anim, hold, ticks, spin }            segura o quadro 'hold' por 'ticks', girando 'spin'/4096 de volta por tick
// Estado 23 (golpe de inimigo): arg0A + ds10A, WiK1V 0–5, gira 38 ticks (±369), WiK2V 0–19 e segura 10,
//   d1a0A, WiK3V 0–9 e segura 12, WiK4V 0–7, d1b0A, segura 21 → renasce (~4,2 s).
// Estado 22 (queda no buraco): fal0A, WiJSV 0–5, pose de queda WiJuV[15] enquanto cai → renasce (~1,5 s).
const DEATH_HIT = [
  { sound: ['arg0A', 'ds10A'] }, { anim: 'k1', a: 0, b: 5 }, { anim: 'k1', hold: 5, ticks: 38, spin: 369 },
  { anim: 'k2', a: 0, b: 19 }, { anim: 'k2', hold: 19, ticks: 10 }, { sound: ['d1a0A'] },
  { anim: 'k3', a: 0, b: 9 }, { anim: 'k3', hold: 9, ticks: 12 }, { anim: 'k4', a: 0, b: 7 },
  { sound: ['d1b0A'] }, { anim: 'k4', hold: 7, ticks: 21 },
];
const DEATH_FALL = [{ sound: ['fal0A'] }, { anim: 'fall', a: 0, b: 5 }, { anim: 'jump', hold: 15, ticks: 39 }];
const seqTicks = seq => seq.reduce((t, s) => t + (s.sound ? 0 : s.hold !== undefined ? s.ticks : Math.abs(s.b - s.a) + 1), 0);

// Regras de jogo que não vieram do código (comportamento conhecido do Crash 1, ajustável):
const HURT_INVULN = 1.5;     // invencível depois de perder a máscara ou renascer
const MULTI_HITS = 10;       // quiques que a caixa ripada aguenta (1 fruta cada)
const AKU_INVINCIBLE = 20;   // terceira máscara: invencível por esse tempo

export class Player {
  // opts: { collision, boxes, enemies, makeMesh(key) -> Mesh,
  //         anims: { idle, run, jump, spin }, spawn: [x, y, z], scale }
  constructor(opts) {
    Object.assign(this, opts);
    this.pos = new THREE.Vector3(...opts.spawn);
    this.vel = new THREE.Vector3();
    this.respawn = this.pos.clone();
    this.onGround = false;
    this.facing = Math.PI; // de costas para a câmera (olhando para -z)
    this.spinTimer = 0;
    this.animTime = 0;
    this.group = new THREE.Group();
    this.meshes = {};
    for (const [name, key] of Object.entries(opts.anims)) {
      const m = opts.makeMesh(key);
      m.visible = false;
      this.meshes[name] = { mesh: m, key, frames: m.userData.frames };
      this.group.add(m);
    }
    this.anim = null;
    this.setAnim('idle');
    this.sync();
  }

  setAnim(name) {
    if (this.anim === name) return;
    if (this.anim) this.meshes[this.anim].mesh.visible = false;
    this.anim = name;
    this.animTime = 0;
    this.idleSeq = [];
    this.idleT = 0;
    this.meshes[name].mesh.visible = true;
  }

  // Parado, como o estado 1 do WillC: segura o quadro 11 por 30 ticks, às vezes pisca (12/11) e,
  // a cada poucas voltas, faz o gesto inteiro (0–10, segurando o 5). Lista de [quadro, ticks].
  idleChunk() {
    const s = [[11, 30], [11, 1]];
    if (Math.random() < 0.25) s.push([12, 3], [11, 3], [12, 3], [11, 6]);
    if (Math.random() < 0.25) s.push([11, 30]);
    this.idleLoops = (this.idleLoops || 0) + 1;
    if (this.idleLoops > 3) {
      this.idleLoops = 0;
      s.push([0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 30], [6, 1], [7, 1], [8, 1]);
      if (Math.random() < 1 / 8) s.push([7, 1], [6, 1], [7, 1], [8, 1]);
      s.push([9, 1], [10, 1]);
    }
    return s;
  }

  idleFrame(dt) {
    this.idleT += dt * 30; // ticks de 1/30 s
    while (true) {
      if (!this.idleSeq.length) this.idleSeq = this.idleChunk();
      const [f, ticks] = this.idleSeq[0];
      if (this.idleT < ticks) return f;
      this.idleT -= ticks;
      this.idleSeq.shift();
    }
  }

  // Chão, como o motor faz (0x8002C8EC). y = pés na posição nova, prevY = pés no quadro anterior.
  // Retorna { y, kind }: 'object' (caixa), 'ground' (célula de tipo ≥ 1, o Crash sobe até o topo) ou
  // 'stop' (só células de tipo 0: a queda para, sem subir); ou null. death = tocou célula de tipo 3.
  groundAt(x, y, z, prevY = y) {
    const reach = y + STEP + Math.max(0, prevY - y); // também pega o chão atravessado neste quadro
    // 1) objetos (0x8002C660): o topo mais alto ao alcance, pegada ±75
    let obj = -Infinity;
    for (const b of this.boxes) {
      if (!b.alive || b.kind === 'ghost') continue;
      const top = b.y + BOX;
      if (Math.abs(x - b.x) < BOX / 2 + OBJ_FOOT && Math.abs(z - b.z) < BOX / 2 + OBJ_FOOT &&
        top >= y && top <= reach && top > obj) obj = top;
    }
    // 2) octree (0x80038AC4): média dos topos das células numa coluna de ±6 unidades, dos pés à cabeça,
    //    cujo topo está ao alcance; separada entre tipo 0 e os demais. Tipos 3 e 4 não contam.
    let sumT = 0, nT = 0, sumP = 0, nP = 0, death = false;
    this.collision.cellsInBox(x - COLUMN, y, z - COLUMN, x + COLUMN, y + HEIGHT, z + COLUMN, (v, x0, y0, z0, x1, top) => {
      const t = (v & 0xe) >> 1;
      if (t === 3) { death = true; return; }  // fundo dos buracos (evento 0x900; provável morte)
      if (t === 4 || top > reach) return;
      if (t === 0) { sumP += top; nP++; } else { sumT += top; nT++; }
    });
    if (obj > -Infinity) return { y: obj, kind: 'object', death };
    if (nT) return { y: sumT / nT, kind: 'ground', death };
    if (nP) return { y: sumP / nP, kind: 'stop', death };
    return death ? { y: -Infinity, kind: null, death } : null;
  }

  // Parede no ponto (x, z) para o corpo com os pés em y (regras de 0x8003864C):
  // tipo 1 bloqueia se o topo passa do degrau (pés + 244); tipos 0 e 2 bloqueiam acima de pés + 50
  // (exceto sub 1–38); tipos 3 e 4 nunca. O jogo trata o Crash como um ponto numa grade de 8 unidades.
  wallAt(x, y, z) {
    let hit = false;
    this.collision.cellsInBox(x, y + 50, z, x, y + HEIGHT, z, (v, x0, y0, z0, x1, top) => {
      if (hit) return;
      const t = (v & 0xe) >> 1, sub = (v & 0x3f0) >> 4;
      if (t === 3 || t === 4) return;
      if (t === 1) { if (top > y + STEP && y0 < y + HEIGHT) hit = true; return; }
      if (sub > 0 && sub < 39) return;
      if (top > y + 50 && y0 < y + HEIGHT) hit = true;
    });
    return hit;
  }

  // Com guia: há bloco sólido (tipo 1 ou 2) na faixa do corpo acima do degrau, no ponto (x, z)?
  // maxTop limita a altura do topo que conta (Infinity = qualquer).
  solidAbove(x, y, z, maxTop = Infinity) {
    let hit = false;
    this.collision.cellsInBox(x, y + STEP + 20, z, x, y + HEIGHT, z, (v, x0, y0, z0, x1, top) => {
      if (hit) return;
      const t = (v & 0xe) >> 1;
      if ((t === 1 || t === 2) && top > y + STEP + 20 && top <= y + maxTop) hit = true;
    });
    return hit;
  }

  // Movimento de (x, z) até o destino, em passos de 8 unidades (o tamanho da grade do jogo).
  blocked(x, y, z, fromX, fromZ) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x - fromX, z - fromZ) / GRID));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      if (this.wallAt(fromX + (x - fromX) * k, y, fromZ + (z - fromZ) * k)) return true;
    }
    // Caixas: bloqueia entrar nelas, mas sempre deixa sair (antes ele podia ficar preso encostado)
    for (const b of this.boxes) {
      const now = this.boxPenetration(b, x, y, z);
      if (now > 0 && now > this.boxPenetration(b, fromX, y, fromZ) - 0.01) return true;
    }
    return false;
  }

  // Quanto o corpo do Crash (±150, altura 665) entra na caixa na horizontal; 0 = não encosta.
  // Em cima da caixa (pés no topo) não conta.
  boxPenetration(b, x, y, z) {
    if (!b.alive || b.kind === 'ghost') return 0;
    if (y >= b.y + BOX - 1 || y + HEIGHT <= b.y) return 0;
    const px = BOX / 2 + BODY - Math.abs(x - b.x), pz = BOX / 2 + BODY - Math.abs(z - b.z);
    return px > 0 && pz > 0 ? Math.min(px, pz) : 0;
  }

  // Os pés estão dentro de uma célula sólida (chão/rocha que passa acima deles)?
  insideSolid() {
    let inside = false;
    this.collision.cellsInBox(this.pos.x, this.pos.y + 20, this.pos.z, this.pos.x, this.pos.y + 60, this.pos.z, (v, x0, y0, z0, x1, top) => {
      const t = (v & 0xe) >> 1;
      if ((t === 1 || t === 2) && y0 < this.pos.y + 20 && top > this.pos.y + 60) inside = true;
    });
    return inside;
  }

  // Empurra para fora de caixas em que ele ficou dentro (ex.: caiu rente à borda).
  pushOutOfBoxes() {
    for (const b of this.boxes) {
      if (!this.boxPenetration(b, this.pos.x, this.pos.y, this.pos.z)) continue;
      const dx = this.pos.x - b.x, dz = this.pos.z - b.z;
      const px = BOX / 2 + BODY - Math.abs(dx), pz = BOX / 2 + BODY - Math.abs(dz);
      if (px < pz) this.pos.x += Math.sign(dx || 1) * px;
      else this.pos.z += Math.sign(dz || 1) * pz;
    }
  }

  jump(vy) {
    this.vel.y = vy;
    this.onGround = false;
    this.jumpHold = false;
    this.setAnim('jump');
    this.animTime = 0;
  }

  killEnemy(e, how) {
    e.alive = false;
    e.mesh.visible = false;
    this.onKill?.(e, how);
  }

  breakBox(b) {
    b.alive = false;
    b.mesh.visible = false;
    if (b.kind === 'checkpoint') this.respawn.set(b.x, b.y + 20, b.z);
    this.onBreak?.(b);
  }

  // Encostou num inimigo: a máscara do Aku Aku absorve o golpe; sem máscara, morre.
  hurt() {
    if (this.invuln > 0 || this.deadTimer > 0) return;
    if (this.mask >= 3) return;                    // invencível (3 máscaras)
    if (this.mask > 0) {
      this.mask--;
      this.invuln = HURT_INVULN;
      this.onMask?.(this.mask, 'perdeu');
      return;
    }
    this.die('hit');
  }

  addMask() {
    this.mask = Math.min(3, (this.mask || 0) + 1);
    if (this.mask === 3) this.akuTimer = AKU_INVINCIBLE;
    this.onMask?.(this.mask, 'ganhou');
  }

  // Morte com a animação e os sons do jogo, depois renasce no último checkpoint sem máscara.
  // kind: 'hit' (inimigo, estado 23) ou 'fall' (buraco/queda, estado 22).
  die(kind = 'fall') {
    if (this.deadTimer > 0) return;
    const seq = kind === 'hit' ? DEATH_HIT : DEATH_FALL;
    this.deathKind = kind;
    this.deathSeq = seq.map(s => ({ ...s }));
    this.deathT = 0;
    this.deadTimer = seqTicks(seq) / 30;
    this.vel.x = this.vel.z = 0;
    if (kind === 'hit') this.vel.y = 0;
    this.speed = 0;
    this.mask = 0;
    this.akuTimer = 0;
    this.spinTimer = 0;
    this.onDie?.(kind);
  }

  // Avança a sequência de morte; durante a queda o Crash continua caindo (sem chão).
  updateDeath(dt) {
    if (this.deathKind === 'fall') {
      this.vel.y = Math.max(-TERMINAL, this.vel.y - GRAVITY * dt);
      this.pos.y += this.vel.y * dt;
    }
    this.deathT += dt * 30;
    while (this.deathSeq.length) {
      const s = this.deathSeq[0];
      if (s.sound) { for (const n of s.sound) this.onSound?.(n); this.deathSeq.shift(); continue; }
      const len = s.hold !== undefined ? s.ticks : Math.abs(s.b - s.a) + 1;
      this.setAnim(s.anim);
      if (s.hold !== undefined) {
        this.forcedFrame = s.hold;
        if (s.spin) this.facing = this.drawFacing = (this.drawFacing ?? this.facing) + s.spin / 4096 * Math.PI * 2 * dt * 30;
      } else {
        this.forcedFrame = s.a + Math.sign(s.b - s.a) * Math.min(Math.abs(s.b - s.a), Math.floor(this.deathT));
      }
      if (this.deathT < len) return;
      this.deathT -= len;
      this.deathSeq.shift();
    }
  }

  respawnNow() {
    this.deadTimer = 0;
    this.deathSeq = null;
    this.forcedFrame = undefined;
    this.group.visible = true;
    this.invuln = HURT_INVULN;
    this.pos.copy(this.respawn);
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this.drawY = undefined;
    this.lastGroundY = this.respawn.y;
    this.onRespawn?.();
  }

  update(dt, input) {
    dt = Math.min(dt, 3 / 30); // o jogo limita gamespeed a 102 (3 quadros)
    if (this.frozen) return this.sync(dt);
    if (this.deadTimer > 0) {
      if (this.deathSeq) this.updateDeath(dt);
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) this.respawnNow();
      return this.sync(dt);
    }
    this.invuln = Math.max(0, (this.invuln || 0) - dt);
    if (this.akuTimer > 0) {
      this.akuTimer -= dt;
      if (this.akuTimer <= 0) { this.mask = 2; this.onMask?.(2, 'acabou'); }
    }
    const wasOnGround = this.onGround;
    // Como no motor: uma velocidade escalar (speed) que acelera até o máximo com o direcional
    // apertado e freia sem ele; a direção vem do direcional.
    const table = this.spinTimer > 0 ? MOVE.spin : this.onGround ? MOVE.ground : MOVE.air;
    const held = input.x !== 0 || input.z !== 0;
    if (held) {
      // speedMul: multiplicador do modo loop (1 = velocidade do jogo)
      const max = table.max * (input.x !== 0 && input.z !== 0 ? DIAGONAL : 1) * (this.speedMul || 1);
      this.speed = Math.min(max, (this.speed || 0) + table.accel * dt);
      this.facing = Math.atan2(input.x, input.z);
    } else {
      this.speed = Math.max(0, (this.speed || 0) - table.decel * dt);
    }
    this.vel.x = Math.sin(this.facing) * this.speed;
    this.vel.z = Math.cos(this.facing) * this.speed;

    if (this.onGround) this.margemBorda = MARGEM_BORDA;
    else this.margemBorda = Math.max(0, (this.margemBorda || 0) - dt);
    if (input.jump) this.puloGuardado = PULO_GUARDADO;
    else this.puloGuardado = Math.max(0, (this.puloGuardado || 0) - dt);
    const podePular = this.onGround || (this.margemBorda > 0 && this.vel.y <= 0);
    if (this.puloGuardado > 0 && podePular) { // estado 3: SNDA → jmp0A
      this.jump(JUMP_SPEED); this.jumpHold = true; this.onSound?.('jmp0A');
      this.puloGuardado = 0; this.margemBorda = 0;
    }
    this.spinCooldown = Math.max(0, (this.spinCooldown || 0) - dt);
    if (input.spin && this.spinTimer <= 0 && this.spinCooldown <= 0) {
      this.spinTimer = SPIN_TIME;
      this.spinCooldown = SPIN_COOLDOWN;
      this.setAnim('spin');
      this.onSound?.('spn0A');
    }
    // segurar o pulo deixa subir mais, até a vy cair abaixo de 2000
    if (this.jumpHold) {
      if (this.vel.y < JUMP_HOLD_MIN) this.jumpHold = false;
      else if (input.jumpHeld) this.vel.y += JUMP_HOLD * dt;
    }
    this.vel.y = Math.max(-TERMINAL, this.vel.y - GRAVITY * dt);

    const guide = this.guide?.(this.pos.z);
    if (guide) {
      // Com guia: sem teto e sem travar em paredes, árvores ou rochas pela frente. Mas:
      //  - para o lado, não entra em bloco sólido mais alto que o degrau (pilastras e rocha na beira da
      //    trilha); desliza ao longo dele;
      //  - para a frente, só obstáculos baixos (topo até LOW_OBSTACLE acima dos pés) seguram o Crash:
      //    dá para pulá-los. Coisas altas na frente continuam atravessáveis, para nunca travar.
      // Se ele já está dentro de um bloco, pode sair.
      const nx = this.pos.x + this.vel.x * dt;
      if (!this.solidAbove(nx, this.pos.y, this.pos.z) || this.solidAbove(this.pos.x, this.pos.y, this.pos.z)) this.pos.x = nx;
      else this.vel.x = 0;
      const nz = this.pos.z + this.vel.z * dt;
      if (!this.solidAbove(this.pos.x, this.pos.y, nz, LOW_OBSTACLE) || this.solidAbove(this.pos.x, this.pos.y, this.pos.z, LOW_OBSTACLE)) this.pos.z = nz;
      else this.vel.z = 0;
      const g2 = this.guide(this.pos.z) || guide;
      this.pos.x = Math.max(g2.cx - g2.half, Math.min(g2.cx + g2.half, this.pos.x));
    } else {
      // movimento horizontal, um eixo por vez (desliza nas paredes)
      for (const a of ['x', 'z']) {
        const next = this.pos.clone();
        next[a] += this.vel[a] * dt;
        if (!this.blocked(next.x, this.pos.y, next.z, this.pos.x, this.pos.z)) this.pos[a] = next[a];
        else this.vel[a] = 0;
      }
    }

    // vertical
    const prevY = this.pos.y;
    this.pos.y += this.vel.y * dt;
    if (this.vel.y > 0 && !guide) {
      // teto: célula sólida na altura da cabeça (aproximação de 0x8002CD9C); com guia não há teto
      let ceiling = false;
      this.collision.cellsInBox(this.pos.x, prevY + HEIGHT, this.pos.z, this.pos.x, this.pos.y + HEIGHT, this.pos.z, v => {
        const t = (v & 0xe) >> 1;
        if (t !== 3 && t !== 4) ceiling = true;
      });
      if (ceiling) { this.pos.y = prevY; this.vel.y = 0; this.jumpHold = false; }
      for (const b of this.boxes) { // cabeçada por baixo
        if (!b.alive || b.kind === 'ghost') continue;
        if (Math.abs(this.pos.x - b.x) < BOX / 2 && Math.abs(this.pos.z - b.z) < BOX / 2 && prevY + HEIGHT <= b.y + 5 && this.pos.y + HEIGHT > b.y) {
          this.pos.y = b.y - HEIGHT; this.vel.y = 0;
          if (b.kind === 'break' || b.kind === 'checkpoint') this.breakBox(b);
        }
      }
    }
    // chão (0x8002C8EC): só ao descer ou parado
    const g = this.groundAt(this.pos.x, this.pos.y, this.pos.z, prevY);
    if (g && g.death) { this.die(); return this.sync(); }
    let landed = false, snapped = false, gr = g;
    // No ar, com guia, só pousa em chão que esteja abaixo de onde os pés estavam: sem paredes, o alcance de
    // degrau do motor deixaria o Crash "subir" pela parede de um buraco.
    // (só quando já caiu abaixo da borda de onde saiu; ao renascer ou num pulinho em ladeira ele pousa normal)
    // (com folga de LEDGE_TOL: pousar um pouco baixo na beirada do outro lado ainda conta, senão ele afundava no chão)
    const climbing = guide && !wasOnGround && g && g.y > prevY + 10 && g.y - this.pos.y > LEDGE_TOL &&
      this.pos.y < (this.lastGroundY ?? this.pos.y) - 120;
    if (g && g.kind && this.vel.y <= 0 && !climbing) {
      if (g.kind === 'stop') { this.pos.y = prevY; landed = true; } // tipo 0: volta à altura anterior, sem subir
      else if (this.pos.y + STEP >= g.y) { this.pos.y = g.y; landed = true; }
    }
    // Descendo um desnível pequeno andando: gruda no chão em vez de "voar" um ou dois quadros.
    if (!landed && wasOnGround && this.vel.y <= 0) {
      const g2 = this.groundAt(this.pos.x, this.pos.y - DOWN_SNAP, this.pos.z, prevY);
      if (g2 && (g2.kind === 'ground' || g2.kind === 'object') && g2.y <= this.pos.y + 1 && g2.y >= this.pos.y - DOWN_SNAP) {
        this.pos.y = g2.y; landed = snapped = true; gr = g2;
      }
    }
    if (landed) {
      const box = !snapped && gr.kind === 'object' && this.boxes.find(b => b.alive && b.kind !== 'ghost' && Math.abs(b.y + BOX - gr.y) < 1 &&
        Math.abs(this.pos.x - b.x) < BOX / 2 + OBJ_FOOT && Math.abs(this.pos.z - b.z) < BOX / 2 + OBJ_FOOT);
      if (box && box.kind === 'arrow') this.jump(ARROW_BOUNCE);
      else if (box && box.loot === 'multi' && prevY > gr.y + 1 && (box.hits = (box.hits || 0) + 1) < MULTI_HITS) {
        this.onBoxBounce?.(box); this.jump(BOUNCE_SPEED);    // ripada: uma fruta por quique, quebra no último
      } else if (box && (box.kind === 'break' || box.kind === 'checkpoint') && prevY > gr.y + 1) {
        this.breakBox(box); this.jump(BOUNCE_SPEED);
      } else { this.vel.y = 0; this.onGround = true; }
    } else this.onGround = false;

    // Caiu no buraco: morre na hora (com guia). Vale quando, no ar e descendo, está mais de 250 abaixo da
    // borda de onde saiu e dentro de um buraco da trilha, ou dentro da rocha (parede do buraco).
    if (guide && !this.onGround && this.vel.y <= 0 && (this.lastGroundY ?? this.pos.y) - this.pos.y > PIT_DROP) {
      const g3 = this.guide(this.pos.z);
      if ((g3 && g3.pit) || this.insideSolid()) { this.die(); return this.sync(dt); }
    }

    this.pushOutOfBoxes();

    // giro: quebra caixas e derruba inimigos por perto
    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      for (const b of this.boxes) {
        if (b.alive && b.kind === 'break' && Math.hypot(b.x - this.pos.x, b.z - this.pos.z) < SPIN_RADIUS && Math.abs(b.y - this.pos.y) < 400) this.breakBox(b);
      }
    }
    // Inimigos (enemies.js): giro = evento 4, cair em cima = evento 0; encostar só machuca se o
    // inimigo estiver perigoso (ex.: tartaruga virada não machuca e serve de trampolim).
    for (const e of this.enemies) {
      if (!e.active) continue;
      const p = e.mesh.position, s = this.scale;
      const dist = Math.hypot(p.x / s - this.pos.x, p.z / s - this.pos.z), dy = p.y / s - this.pos.y;
      if (Math.abs(dy) > 400) continue;
      if (this.spinTimer > 0 && dist < SPIN_RADIUS) { e.onSpin(this.pos); continue; }
      if (dist < RADIUS + 180) {
        if (this.vel.y < 0 && dy < -150) { if (e.onStomp()) this.jump(BOUNCE_SPEED); }
        else if (e.harmful()) this.hurt();
      }
    }

    // caiu num buraco ou fora das zonas: morre ao despencar bem abaixo do último chão firme
    if (this.onGround) this.lastGroundY = this.pos.y;
    if (this.pos.y < (this.lastGroundY ?? this.respawn.y) - FALL_DEATH) this.die();

    // animação: o pulo só aparece num pulo de verdade ou depois de um tempo no ar
    this.airTime = this.onGround ? 0 : (this.airTime || 0) + dt;
    if (this.spinTimer > 0) this.setAnim('spin');
    else if (!this.onGround && (this.vel.y > 0 || this.airTime > 0.15 || this.anim === 'jump')) this.setAnim('jump');
    else if ((this.speed || 0) > 200) this.setAnim('run'); // velocidade pretendida: contra parede continua correndo
    else if (this.onGround) this.setAnim('idle');
    this.animTime += dt;
    this.sync(dt);
  }

  sync(dt = 0) {
    const m = this.meshes[this.anim];
    const n = m.frames;
    let f = Math.floor(this.animTime * 30 + 1e-6), mirror = false; // 1e-6: evita repetir/pular quadro por arredondamento
    if (this.deadTimer > 0 && this.forcedFrame !== undefined) f = Math.min(n - 1, this.forcedFrame); // sequência de morte
    else if (this.anim === 'jump') f = Math.min(f, n - 1);     // pulo toca uma vez
    else if (this.anim === 'idle') f = this.idleFrame(dt);
    else if (this.anim === 'run') {                             // estado 39: WiWaV normal, depois espelhada
      f %= 2 * n;
      mirror = f >= n;
      // passos: o estado 39 toca fs10A no fim da 1ª metade e fs00A no fim da 2ª (quadro 9)
      if (f !== this.lastRunFrame && (f === n - 1 || f === 2 * n - 1)) this.onSound?.(f === n - 1 ? 'fs10A' : 'fs00A');
      this.lastRunFrame = f;
      f %= n;
    } else f %= n;
    m.mesh.userData.setFrame(f);
    m.mesh.scale.x = mirror ? -1 : 1;
    // o modelo vira em direção ao movimento rapidamente, mas não de uma vez
    if (this.drawFacing === undefined) this.drawFacing = this.facing;
    let d = this.facing - this.drawFacing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.drawFacing += Math.sign(d) * Math.min(Math.abs(d), TURN_RATE * dt);
    // A altura física anda em degraus do tamanho das células (~50); o desenho suaviza no chão.
    if (this.drawY === undefined || !this.onGround || Math.abs(this.pos.y - this.drawY) > 300) this.drawY = this.pos.y;
    else this.drawY += (this.pos.y - this.drawY) * (1 - Math.exp(-dt * 18));
    this.group.position.set(this.pos.x, this.drawY, this.pos.z).multiplyScalar(this.scale);
    this.group.rotation.y = this.drawFacing;
    // pisca enquanto está invencível depois de um golpe ou de renascer
    this.blink = (this.blink || 0) + dt;
    this.group.visible = this.deadTimer > 0 || !(this.invuln > 0 && Math.floor(this.blink * 15) % 2);
  }
}
