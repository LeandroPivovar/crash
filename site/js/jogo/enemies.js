// Caranguejo (CrabC) e tartaruga (TurtC), seguindo o código GOOL de cada um.
// Desmontagem: node viewer/tools/disgool.js extraido/S0/S0000009.NSF CrabC 0   (idem TurtC)
//
// Progresso no caminho: 256 por segmento (entre dois pontos), como obj[0x114] no jogo.
// TRI = onda triangular (vai e volta); PRS = suavização em seno nas pontas; 1 tick = 1/30 s.
import * as THREE from 'three';

const TICK = 1 / 30;
const TAU = Math.PI * 2, ANG = TAU / 4096;

// CrabC estado 1 (trans 0x2B): progresso += gamespeed por quadro = 1024/s, com TRI + PRS.
const CRAB_RATE = 1024;
// TurtC estado 2 (trans 0x63): TRI com passo fixo obj[0x16C] = 74 por tick (sem gamespeed), sem PRS;
// a posição fica 100 unidades acima do caminho; vira no máximo 227/4096 de volta por tick.
const TURTLE_STEP = 74, TURTLE_LIFT = 100, TURTLE_TURN = 227 * ANG;
// Esmagado (CrabC estado 2): escala cai ~409/4096 por tick e gira 682/4096 por tick até < 163.
const SQUASH_SHRINK = 409 / 4096, SQUASH_SPIN = 682 * ANG, SQUASH_END = 163 / 4096;
// Chutado pelo giro (CrabC estado 3 / TurtC estado 4): sai a 1024000 (4000/s), +307200 (1200/s) por tick
// até 4096000 (16000/s); escala −136/4096 por tick; gira.
const FLY_SPEED = 4000, FLY_ACCEL = 1200, FLY_MAX = 16000, FLY_SHRINK = 136 / 4096, FLY_SPIN = 8 * 256 * ANG;
// Tartaruga virada (TurtC estado 3): rolar de costas, esperar e se sacudir, desvirar.
// Cada passo: [animação, quadro inicial, quadro final, ticks por quadro, giro y por passo]
const FLIP_DOWN = [['Tu29V', 0, 9, 1], ['Tu59V', 0, 21, 1]];
const FLIP_HOLD = [['Tu59V', 21, 21, 105]]; // 60 + 45 ticks
const FLIP_WIGGLE = [[24, 170], [24, -170], [12, 170], [12, -170], [6, 341], [6, -341]];
const FLIP_UP = [['Tu59V', 21, 0, 1], ['Tu39V', 7, 0, 1]];

export class Enemy {
  // opts: { entity, mesh, scale, animatedGeometry(key), animFrames(key), onKill(enemy, how) }
  constructor(opts) {
    Object.assign(this, opts);
    const e = opts.entity;
    this.kind = e.gool === 'Crab' ? 'crab' : 'turtle';
    this.pts = e.path.map(p => new THREE.Vector3(...p));
    this.limit = (this.pts.length - 1) * 256;
    // fase inicial do vai-e-vem: o jogo a tira da entidade; aqui varia pelo id (aproximação)
    this.t = this.limit > 0 ? (e.id * 977) % (2 * this.limit) : 0;
    this.startT = this.t;
    this.state = 'walk';
    this.active = true;
    this.animT = 0;
    this.geoms = {};
    this.heading = 0;
    this.pos = this.pts[0].clone();
    this.setAnim(this.kind === 'crab' ? 'Cr19V' : 'Tu19V');
  }

  setAnim(key) {
    if (this.animKey === key) return;
    this.animKey = key;
    this.mesh.geometry = this.geoms[key] || (this.geoms[key] = this.animatedGeometry(key));
    this.lastFrame = -1;
  }

  setFrame(f) {
    const frames = this.animFrames(this.animKey);
    f = Math.max(0, Math.min(frames.length - 1, f));
    if (f === this.lastFrame) return;
    this.mesh.geometry.setAttribute('position', frames[f].pos);
    this.mesh.geometry.setAttribute('vcol', frames[f].col);
    this.lastFrame = f;
  }

  // Ponto no caminho para um progresso (256 por segmento) e a direção do segmento.
  pathAt(p, out, dir) {
    if (this.pts.length < 2) { out.copy(this.pts[0]); return; }
    const s = Math.min(this.pts.length - 2, Math.max(0, Math.floor(p / 256)));
    const k = Math.min(1, Math.max(0, p / 256 - s));
    out.lerpVectors(this.pts[s], this.pts[s + 1], k);
    if (dir) dir.subVectors(this.pts[s + 1], this.pts[s]);
  }

  // ---- interações com o Crash ----
  harmful() { return this.active && this.state === 'walk'; }

  // Crash caiu em cima (evento 0). Retorna true se ele deve quicar.
  onStomp() {
    if (!this.active) return false;
    if (this.kind === 'crab') {
      if (this.state !== 'walk') return false;
      this.state = 'squash'; this.squash = 1; this.setAnim('Cr29V'); this.setFrame(0);
      this.onKill?.(this, 'pulo');
      return true;
    }
    if (this.state === 'walk') { this.startFlip(); return true; }
    if (this.state === 'flipped') { this.flipHoldAgain(); return true; } // trampolim: k[43] = 1295269
    return false;
  }

  // Giro do Crash (evento 4): sai voando para longe.
  onSpin(from) {
    if (!this.active || this.state === 'fly' || this.state === 'squash') return;
    this.state = 'fly';
    this.flySpeed = FLY_SPEED;
    this.flyDir = new THREE.Vector3(this.pos.x - from.x, 0, this.pos.z - from.z);
    if (this.flyDir.lengthSq() < 1) this.flyDir.set(0, 0, -1);
    this.flyDir.normalize();
    this.flyScale = 1;
    this.onKill?.(this, 'giro');
  }

  // ---- tartaruga virada ----
  startFlip() {
    this.state = 'flipped';
    this.seq = [...FLIP_DOWN.map(s => ({ anim: s })), ...this.holdSteps()];
    this.seqT = 0;
  }
  holdSteps() {
    return [...FLIP_HOLD.map(s => ({ anim: s })), ...FLIP_WIGGLE.map(([ticks, rot]) => ({ hold: ticks, rot })),
      ...FLIP_UP.map(s => ({ anim: s, up: true }))];
  }
  flipHoldAgain() {
    // pular de novo reinicia a espera (obj[0x164] = agora) sem repetir a cambalhota
    this.seq = this.holdSteps();
    this.seqT = 0;
  }
  updateFlip(dt) {
    this.seqT += dt / TICK;
    while (this.seq.length) {
      const s = this.seq[0];
      let len;
      if (s.anim) {
        const [key, a, b, per] = s.anim;
        len = (Math.abs(b - a) + 1) * per;
        this.setAnim(key);
        if (this.seqT < len) { this.setFrame(a + Math.sign(b - a) * Math.floor(this.seqT / per)); return; }
      } else {
        len = s.hold;
        if (!s.applied) { this.heading += s.rot * ANG; s.applied = true; }
        if (this.seqT < len) return;
      }
      this.seqT -= len;
      this.seq.shift();
    }
    this.state = 'walk';
    this.setAnim('Tu19V');
  }

  update(dt) {
    if (!this.active) return;
    const m = this.mesh;
    this.animT += dt;
    if (this.state === 'walk') {
      if (this.kind === 'crab') {
        this.t = (this.t + CRAB_RATE * dt) % (2 * this.limit || 1);
        const lin = this.t < this.limit ? this.t : 2 * this.limit - this.t;
        const p = this.limit * (1 - Math.cos(Math.PI * lin / this.limit)) / 2; // PRS
        this.pathAt(p, this.pos);
        this.setFrame(Math.floor(this.animT * 30) % 19);
      } else {
        this.t = (this.t + TURTLE_STEP * dt / TICK) % (2 * this.limit || 1);
        const forward = this.t < this.limit;
        const dir = new THREE.Vector3();
        this.pathAt(forward ? this.t : 2 * this.limit - this.t, this.pos, dir);
        if (!forward) dir.negate();
        const want = Math.atan2(dir.x, dir.z);
        let d = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
        this.heading += Math.sign(d) * Math.min(Math.abs(d), TURTLE_TURN * dt / TICK);
        this.setFrame(Math.floor(this.animT * 30) % 16); // ciclo 10..15, 0..9 do estado 2
      }
    } else if (this.state === 'flipped') {
      this.updateFlip(dt);
    } else if (this.state === 'squash') {
      this.squash -= SQUASH_SHRINK * dt / TICK;
      this.heading += SQUASH_SPIN * dt / TICK;
      if (this.squash < SQUASH_END) this.die();
    } else if (this.state === 'fly') {
      this.flySpeed = Math.min(FLY_MAX, this.flySpeed + FLY_ACCEL * dt / TICK);
      this.pos.addScaledVector(this.flyDir, this.flySpeed * dt);
      this.flyScale -= FLY_SHRINK * dt / TICK;
      this.heading += FLY_SPIN * dt / TICK;
      if (this.flyScale <= 0) this.die();
    }
    const s = this.scale;
    const lift = this.kind === 'turtle' && this.state !== 'fly' ? TURTLE_LIFT : 0;
    m.position.set(this.pos.x * s, (this.pos.y + lift) * s, this.pos.z * s);
    m.rotation.y = this.kind === 'crab' ? this.heading : this.heading;
    const sc = this.state === 'squash' ? Math.max(0.01, this.squash) : this.state === 'fly' ? Math.max(0.01, this.flyScale) : 1;
    m.scale.setScalar(sc);
  }

  die() {
    this.active = false;
    this.state = 'dead';
    this.mesh.visible = false;
  }

  // Volta ao estado inicial (modo loop).
  reset() {
    this.active = true;
    this.state = 'walk';
    this.t = this.startT;
    this.heading = 0;
    this.mesh.visible = true;
    this.mesh.scale.setScalar(1);
    this.setAnim(this.kind === 'crab' ? 'Cr19V' : 'Tu19V');
  }
}
