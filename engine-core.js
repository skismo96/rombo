// Rombo — motore di sintesi (DSP puro, nessuna dipendenza dal DOM).
// Usato da AudioWorklet, dal fallback ScriptProcessor e dagli script di rendering offline (Node).
//
// Modello: ogni scoppio genera un impulso di pressione (forma "blowdown" + depressione + rumore turbolento)
// sagomato in gradi albero, ritardato dal collettore primario del suo cilindro, sommato nel collettore della
// propria bancata, poi propagato in due guide d'onda (collettore + tubo) con riflessioni e perdite, silenziatore
// (valvola aperta/chiusa), risonanze di scarico, aspirazione, meccanica, turbo, scoppiettii in rilascio.

const FLUT_G = (typeof process !== 'undefined' && process.env && process.env.FLUT_G) ? +process.env.FLUT_G : 1;
const TAU = Math.PI * 2;

class RNG {
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0 || 1; }
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296; }
  bi() { return this.next() * 2 - 1; }
  gauss() { return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732; }
}

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, sr, gainDb = 0) {
    const w = TAU * Math.min(Math.max(f, 5), sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'hp': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'peak': b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
      case 'lowshelf': {
        const sq = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
        a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; break;
      }
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class Delay {
  constructor(n) { this.n = n; this.buf = new Float32Array(n); this.w = 0; }
  read(d) { // d campioni fa (>=1), frazionario
    let r = this.w - d; if (r < 0) r += this.n;
    const i = r | 0, f = r - i, j = i + 1 >= this.n ? 0 : i + 1;
    return this.buf[i] + (this.buf[j] - this.buf[i]) * f;
  }
  write(x) { this.buf[this.w] = x; if (++this.w >= this.n) this.w = 0; }
}

// Guida d'onda semplificata: tubo con riflessione all'estremità (aperta => coefficiente negativo) e perdite in alta.
class Pipe {
  constructor(sr, maxSec) { this.sr = sr; this.d = new Delay(Math.ceil(sr * maxSec) + 8); this.D = 64; this.r = -0.4; this.lp = 0; this.k = 0.5; }
  setLoss(fc) { this.k = 1 - Math.exp(-TAU * fc / this.sr); }
  tick(x) {
    const v = this.d.read(this.D);
    this.lp += this.k * (v - this.lp);
    const y = x + this.r * this.lp;
    this.d.write(y);
    return y;
  }
}

const MAXP = 128;

export class SampleLayer {
  // loops: [{rpm, data: Float32Array}] (mono, stessa sr del motore)
  constructor(sr) { this.sr = sr; this.loops = []; this.lp = new Biquad(); this.lpF = -1; }
  setLoops(loops) { this.loops = loops.slice().sort((a, b) => a.rpm - b.rpm).map(l => ({ rpm: l.rpm, data: l.data, pos: 0 })); }
  get ok() { return this.loops.length > 0; }
  coverage(rpm) { // 1 dentro l'intervallo coperto, svanisce sopra 1.25x l'ultimo campione
    if (!this.ok) return 0;
    const top = this.loops[this.loops.length - 1].rpm;
    if (rpm <= top * 1.05) return 1;
    return Math.max(0, 1 - (rpm - top * 1.05) / (top * 0.35));
  }
  tick(rpm, load) {
    const L = this.loops, n = L.length;
    let i = 0; while (i < n - 1 && L[i + 1].rpm < rpm) i++;
    let a = L[i], b = L[Math.min(i + 1, n - 1)], w = 0;
    if (a !== b && rpm > a.rpm) w = Math.min(1, Math.log(rpm / a.rpm) / Math.log(b.rpm / a.rpm));
    const ga = Math.cos(w * Math.PI / 2), gb = Math.sin(w * Math.PI / 2);
    let out = 0;
    for (const [l, g] of [[a, ga], [b, gb]]) {
      if (g < 1e-4 && l !== a) { continue; }
      const rate = Math.min(2.2, Math.max(0.5, rpm / l.rpm));
      const d = l.data, N = d.length;
      const p = l.pos, i0 = p | 0, f = p - i0;
      // Hermite cubica
      const xm1 = d[(i0 - 1 + N) % N], x0 = d[i0 % N], x1 = d[(i0 + 1) % N], x2 = d[(i0 + 2) % N];
      const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      out += g * (((c3 * f + c2) * f + c1) * f + x0);
      l.pos = p + rate; if (l.pos >= N) l.pos -= N;
    }
    // avanza anche gli altri loop per mantenerli in fase "plausibile"
    for (const l of L) if (l !== a && l !== b) { l.pos += rpm / l.rpm; if (l.pos >= l.data.length) l.pos -= l.data.length; }
    return out * (0.55 + 0.6 * load);
  }
}

export class EngineSynth {
  constructor(sr, preset, seed = 1234) {
    this.sr = sr;
    this.rng = new RNG(seed);
    // stato di controllo (target dal thread principale) e valori smussati
    this.tRpm = 800; this.tLoad = 0; this.tThr = 0; this.tValve = 0; this.tVol = 0.8;
    this.rpm = 800; this.load = 0; this.thr = 0; this.valve = 0; this.vol = 0.8;
    this.on = true; this.limiter = false; this.warm = 1; this.hybrid = 0; this.engineGain = 0; this.tEngineGain = 1;
    this.phase = 0; this.next = 0; this.cycle = 0;
    // pool impulsi
    this.pT = new Float32Array(MAXP); this.pDur = new Float32Array(MAXP); this.pAmp = new Float32Array(MAXP);
    this.pN = new Float32Array(MAXP); this.pBank = new Uint8Array(MAXP); this.pKind = new Uint8Array(MAXP); this.pLen = new Float32Array(MAXP);
    this.active = new Int16Array(MAXP); this.nActive = 0; this.free = []; for (let i = MAXP - 1; i >= 0; i--) this.free.push(i);
    this.liftTime = 99; this.prevThr = 0; this.boost = 0; this.bov = 0; this.bovPh = 0; this.flutter = 0; this.flutPh = 0; this.b1 = 0; this.b2 = 0; this.spool2 = 0; this.turboPh2 = 0; this.flutEnv = 0; this.surge = 0; this.thrPeak = 0;
    this.heat = 0.5; this.whPh = 0; this.turboPh = 0; this.intakeEnv = 0; this.limCount = 0;
    this.limGain = 1; this.dc1x = 0; this.dc1y = 0; this.dc2x = 0; this.dc2y = 0;
    this.samples = new SampleLayer(sr);
    this.blockCount = 0;
    this.setPreset(preset);
  }

  setPreset(p) {
    const sr = this.sr;
    this.p = p;
    const nb = 1 + Math.max(...p.bank);
    this.nb = nb;
    this.leakC = [new Biquad(), new Biquad()]; this.leakO = [new Biquad(), new Biquad()];
    this.header = []; this.pipe = []; this.turbF = []; this.mufC1 = []; this.mufC2 = []; this.mufO = [];
    for (let b = 0; b < 2; b++) {
      this.header.push(new Pipe(sr, 0.02)); this.pipe.push(new Pipe(sr, 0.06));
      this.turbF.push(new Biquad()); this.mufC1.push(new Biquad()); this.mufC2.push(new Biquad()); this.mufO.push(new Biquad());
    }
    this.form = p.formants.map(() => new Biquad());
    this.howl = (p.howl || []).map(() => new Biquad());
    this.b1 = this.b2 = this.boost = this.spool2 = 0;
    this.intBP = new Biquad(); this.intRes = new Biquad(); this.mechHP = new Biquad().set('hp', 2500, 0.7, sr);
    this.floorBP = new Biquad(); this.blkBP = new Biquad().set('bp', p.blockF || 1600, 0.9, sr); this.blkBP2 = new Biquad().set('bp', (p.blockF || 1600) * 2.3, 1.2, sr); this.popLP = new Biquad().set('lp', p.popTone * 0.9, 0.6, sr);
    // corpo dello scoppio: risonanza bassa/medio-bassa del terminale (tonfo pieno, non fruscio)
    this.popBody = new Biquad().set('bp', p.popBody || Math.min(320, Math.max(120, p.popTone * 0.12)), 2.2, sr);
    this.popBody2 = new Biquad().set('bp', (p.popBody || Math.min(320, Math.max(120, p.popTone * 0.12))) * 2.6, 3, sr);
    this.popBP = new Biquad().set('bp', p.popTone, 0.9, sr);
    this.turbBP = new Biquad(); this.bovBP = new Biquad(); this.flutLP = new Biquad().set('lp', 1100, 0.7, sr); this.flutBP = new Biquad().set('bp', 2200, 1.2, sr);
    // "tonfo" di pressione di ogni colpo del compressore in pompaggio
    this.flutBody = new Biquad().set('bp', (p.turbo && p.turbo.flutBody) || 105, 3.5, sr);
    this.lowShelf = new Biquad().set('lowshelf', 90, 0.7, sr, 3);
    this.hpOut = new Biquad().set('hp', 22, 0.7, sr);
    this.lpOut = new Biquad().set('lp', 9000, 0.7, sr); this.lpOutR = new Biquad().set('lp', 9000, 0.7, sr);
    this.hpOutR = new Biquad().set('hp', 22, 0.7, sr); this.lowShelfR = new Biquad().set('lowshelf', 90, 0.7, sr, 3);
    this.runnerS = p.runner.map(l => l / 520 * sr);
    this.cylGain = p.cylVar.slice();
    this.jit = new Float32Array(p.cyl);
    this.next = 0; this.phase = 0;
    this.nActive = 0; this.free = []; for (let i = MAXP - 1; i >= 0; i--) this.free.push(i);
    this.updateFilters();
  }

  setLoops(loops) { this.samples.setLoops(loops); }

  set(params) {
    if (params.rpm !== undefined) this.tRpm = params.rpm;
    if (params.load !== undefined) this.tLoad = params.load;
    if (params.throttle !== undefined) this.tThr = params.throttle;
    if (params.valve !== undefined) this.tValve = params.valve ? 1 : 0;
    if (params.volume !== undefined) this.tVol = params.volume;
    if (params.limiter !== undefined) this.limiter = params.limiter;
    if (params.warm !== undefined) this.warm = params.warm;
    if (params.hybrid !== undefined) this.hybrid = params.hybrid;
    if (params.on !== undefined) this.tEngineGain = params.on ? 1 : 0;
  }

  // evento: cambiata in Dynamic sotto carico => taglio accensione con "schiocco"
  shiftCrack(strength = 1) {
    if (this.warm < 0.3) return;
    const n = 1 + (this.rng.next() * 2.5 | 0);
    for (let k = 0; k < n; k++) this.spawnPop(this.rng.next() * 0.05 * this.sr, (0.6 + 0.6 * this.rng.next()) * strength);
  }

  updateFilters() {
    const p = this.p, sr = this.sr, rpm = this.rpm;
    const c = 470 + 190 * this.heat; // velocità del suono nei gas caldi
    for (let b = 0; b < 2; b++) {
      const lenVar = b === 1 ? 1.07 : 1; // bancate leggermente diverse
      this.header[b].D = Math.max(2, 2 * p.header.len * lenVar / c * sr); this.header[b].r = p.header.refl; this.header[b].setLoss(3500);
      this.pipe[b].D = Math.max(2, 2 * p.pipe.len * lenVar / c * sr); this.pipe[b].r = p.pipe.refl; this.pipe[b].setLoss(1400 + 1200 * this.valve);
      this.turbF[b].set('bp', 700 + rpm * 0.18, 0.8, sr);
      const cl = p.muffler.closedLP * (0.85 + 0.35 * this.load);
      this.mufC1[b].set('lp', cl, 0.75, sr); this.mufC2[b].set('lp', cl * 1.6, 0.6, sr);
      this.mufO[b].set('lp', p.muffler.openLP * (0.8 + 0.4 * this.load), 0.7, sr);
      this.leakC[b].set('bp', 1800 + 600 * this.load, 0.5, sr); this.leakO[b].set('bp', 2600 + 900 * this.load, 0.5, sr);
    }
    p.formants.forEach((f, i) => this.form[i].set('bp', f.f * (1 + 0.04 * this.heat), f.q, sr));
    if (p.howl) { const f0 = Math.max(rpm, 300) / 60; p.howl.forEach((h, i) => this.howl[i].set('bp', Math.min(f0 * h.order * (1 + 0.01 * i), sr * 0.42), h.q, sr)); }
    this.intBP.set('bp', p.intake.f + rpm * 0.10, p.intake.q, sr);
    this.intRes.set('bp', p.intake.f * 0.6 + rpm * 0.025, 4, sr);
    this.floorBP.set('bp', 600 + rpm * 0.25, 0.6, sr);
    if (p.turbo) {
      this.turbBP.set('bp', 1800 + 3500 * this.boost, 1.2, sr);
      this.bovBP.set('bp', 1400 + 2600 * this.bov, 1.3, sr);
    }
  }

  alloc() { return this.free.length ? this.free.pop() : -1; }
  spawn(kind, t, dur, amp, nAmp, bank, len) {
    const i = this.alloc(); if (i < 0) return;
    this.pKind[i] = kind; this.pT[i] = t; /* età corrente in campioni (negativa = ritardata) */ this.pDur[i] = Math.max(1, dur); this.pAmp[i] = amp; this.pN[i] = nAmp; this.pBank[i] = bank; this.pLen[i] = len;
    this.active[this.nActive++] = i;
  }
  spawnPop(delay, strength) {
    const sr = this.sr, bank = this.nb > 1 ? (this.rng.next() < 0.5 ? 0 : 1) : 0;
    // uno (a volte due) scoppi distinti: fronte morbido di qualche ms, coda breve, poco rumore
    const micro = this.rng.next() < 0.3 ? 2 : 1;
    let t = delay;
    for (let k = 0; k < micro; k++) {
      const a = strength * (k === 0 ? 1 : 0.45 + 0.3 * this.rng.next()) * 1.1;
      this.spawn(1, -t, sr * (0.0025 + 0.0035 * this.rng.next()), a, a * 0.10, bank, 2.2);
      t += sr * (0.014 + 0.03 * this.rng.next());
    }
  }

  fire(idx, frac) {
    const p = this.p, sr = this.sr, rpm = this.rpm, L = this.load;
    const idleF = Math.max(0, 1 - (rpm - p.idle) / (p.idle * 0.8));
    const overrun = this.thr < 0.04 && rpm > p.idle * 1.25;
    let comb;
    if (overrun) { // solo pompaggio, iniezione tagliata; "borbottio" = combustioni parziali irregolari
      comb = 0.10 + 0.04 * this.rng.next();
      if (p.burble && this.rng.next() < 0.35 * p.burble) comb += (0.15 + 0.25 * this.rng.next()) * p.burble;
    }
    else comb = 0.24 + 0.76 * Math.pow(L, 0.8);
    // variabilità ciclo-ciclo (più forte al minimo, "lope" per camme spinte)
    const varAmt = 0.035 + (0.05 + 0.25 * p.lope) * idleF + 0.05 * (1 - L);
    comb *= this.cylGain[idx] * (1 + varAmt * this.rng.gauss() * 0.6);
    if (this.limiter && !overrun) { // taglio a pacchetti del limitatore
      this.limCount++;
      if ((this.limCount % 3) !== 0) comb *= 0.08;
    }
    const degS = sr * 60 / (rpm * 360); // campioni per grado
    let dur = p.pulseDeg * degS * (1.25 - 0.4 * L);
    dur = Math.max(dur, sr * 0.0011); dur = Math.min(dur, sr * 0.02);
    const nAmp = comb * (0.2 + 0.45 * L) * p.noise * (p.turbo ? 1 - 0.5 * p.turbo.damp : 1);
    const bank = p.bank[idx];
    const rd = this.runnerS[idx];
    this.spawn(0, frac - rd, dur, comb, nAmp, bank, 2);
    this.spawn(0, frac - 3 * rd, dur * 1.3, -0.25 * comb, 0, bank, 2); // riflessione nel primario
    this.intakeEnv += 0.6 + 0.6 * this.thr;
    // rumore di combustione irradiato dal blocco (strutturale, 1-5 kHz)
    if (!overrun) this.spawn(3, frac - 2, sr * (0.0025 + 0.004 * this.rng.next()), comb * p.block * (0.35 + 0.65 * L), 0, 0, 1);
    // valvole/punterie
    this.spawn(2, frac - 90 * degS * (0.5 + this.rng.next() * 0.2), sr * 0.0004, p.mech * (0.25 + rpm / p.redline) * (0.7 + 0.6 * this.rng.next()), 0, 0, 1);
    // scoppiettii in rilascio
    if (overrun && this.warm > 0.4 && rpm > 1800) {
      const win = 1.2 + 2.2 * this.valve;
      if (this.liftTime < win) {
        const fade = 1 - this.liftTime / win;
        const pr = p.pops * (0.25 + 0.75 * this.valve) * fade * Math.min(1, (rpm - 1800) / 2500) * 0.55;
        if (this.rng.next() < pr) this.spawnPop(frac + rd + this.rng.next() * 30 * degS, 0.5 + 0.8 * this.rng.next());
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  process(outL, outR, n) {
    const p = this.p, sr = this.sr, dt = n / sr;
    // aggiornamenti a blocco
    this.liftTime += dt;
    // durante il limitatore la farfalla "effettiva" va a pacchetti: per i trigger usiamo il valore trattenuto
    this.thrHold = this.limiter ? Math.max(this.tThr, (this.thrHold || 0) - dt * 2) : this.tThr;
    const thrE = this.thrHold;
    if (thrE < 0.08 && this.prevThr >= 0.25) {
      this.liftTime = 0;
      const fk = p.turbo && p.turbo.surge ? Math.min(1, 0.3 + this.boost * 1.3) : this.boost;
      if (p.turbo && this.boost > (p.turbo.surge ? 0.15 : 0.35)) {
        if (p.turbo.bov === 'valve') this.bov = Math.min(1, this.boost * 1.1);
        else if (p.turbo.bov === 'both') { this.bov = Math.min(1, this.boost * 1.15); this.flutter = fk; }
        else this.flutter = fk;
      }
    }
    // sollevamento parziale (anche in folle tra una sgasata e l'altra): il compressore "chiacchiera"
    this.thrPeak = Math.max(thrE, this.thrPeak - dt * 1.5);
    if (p.turbo && p.turbo.surge && thrE >= 0.08 && this.thrPeak - thrE > 0.25 && this.boost > 0.15 && this.liftTime > 0.05) {
      this.flutter = Math.max(this.flutter, Math.min(1, (0.25 + this.boost * 1.3) * (this.thrPeak - thrE) * 1.6) * p.turbo.surge); this.thrPeak = thrE;
    }
    // pompaggio leggero a gas parziale mentre la pressione sale
    if (p.turbo && p.turbo.surge) {
      const part = thrE > 0.12 && thrE < 0.8 ? Math.sin(Math.PI * (thrE - 0.12) / 0.68) : 0;
      const tgtS = p.turbo.surge * 0.45 * part * Math.min(1, this.boost * 2.2) * Math.min(1, Math.max(0, (this.rpm - p.turbo.spoolStart) / 1200));
      this.surge += (tgtS - this.surge) * Math.min(1, dt / 0.25);
    }
    this.prevThr = thrE;
    const heatT = 0.3 + 0.7 * this.load * Math.min(1, this.rpm / p.redline + 0.3);
    this.heat += (heatT - this.heat) * Math.min(1, dt / 4);
    if (p.turbo) {
      const span = Math.max(1, p.turbo.spoolFull - p.turbo.spoolStart);
      const tgt = Math.min(1, Math.max(0, (this.rpm - p.turbo.spoolStart) / span)) * Math.min(1, this.load * 1.15) * (this.thr > 0.05 ? 1 : 0);
      if (p.turbo.seq) { // biturbo sequenziale: il secondo turbo entra dopo il primo
        const s = p.turbo.seq, on = Math.min(1, this.load * 1.15) * (this.thr > 0.05 ? 1 : 0);
        const t2 = Math.min(1, Math.max(0, (this.rpm - s.start) / (s.full - s.start))) * on;
        const b2o = this.b2;
        this.b1 += (tgt - this.b1) * Math.min(1, dt / (tgt > this.b1 ? 0.5 : 0.16));
        this.b2 += (t2 - this.b2) * Math.min(1, dt / (t2 > this.b2 ? 0.42 : 0.2));
        const rate = Math.max(0, (this.b2 - b2o) / dt); // velocità di avvio del secondo turbo
        this.spool2 += (Math.min(1, rate * 0.9) - this.spool2) * Math.min(1, dt / 0.12);
        this.boost = (1 - s.mix) * this.b1 + s.mix * this.b2;
      } else {
        const tau = tgt > this.boost ? 0.55 : 0.18;
        this.boost += (tgt - this.boost) * Math.min(1, dt / tau);
      }
    }
    if (++this.blockCount % 2 === 0) this.updateFilters();

    const aR = 1 - Math.exp(-1 / (sr * 0.012)), aL = 1 - Math.exp(-1 / (sr * 0.03)), aV = 1 - Math.exp(-1 / (sr * 0.15)), aG = 1 - Math.exp(-1 / (sr * 0.05));
    const rng = this.rng, nb = this.nb;
    const bovDec = Math.exp(-1 / (sr * 0.32)), flDec = Math.exp(-1 / (sr * (p.turbo && p.turbo.flutDecay || 0.45))), flutDec = Math.exp(-1 / (sr * 0.016)), intDec = Math.exp(-1 / (sr * 0.006));
    const width = p.width, crossover = p.crossover;
    const bus = [0, 0], turb = [0, 0];
    const gainAll = p.gain * 0.55;
    const formG = p.formants.map(f => f.g);
    const howlG = p.howl ? p.howl.map(h => h.g) : null;

    for (let s = 0; s < n; s++) {
      this.rpm += (this.tRpm - this.rpm) * aR;
      this.load += (this.tLoad - this.load) * aL;
      this.thr += (this.tThr - this.thr) * aL;
      this.valve += (this.tValve - this.valve) * aV;
      this.vol += (this.tVol - this.vol) * aG;
      this.engineGain += (this.tEngineGain - this.engineGain) * aG;
      const rpm = this.rpm;

      // --- albero motore e scoppi
      const dp = rpm * 6 / sr; // gradi per campione
      this.phase += dp;
      let guard = 0;
      while (guard++ < 16) {
        const ang = p.fire[this.next] + this.jit[this.next];
        if (this.phase < ang) break;
        const frac = (this.phase - ang) / dp;
        if (this.engineGain > 0.01) this.fire(this.next, frac);
        // jitter di fase per il prossimo ciclo (più ampio al minimo)
        const idleF = Math.max(0, 1 - (rpm - p.idle) / (p.idle * 0.8));
        this.jit[this.next] = Math.abs(rng.gauss()) * (0.4 + 3.5 * idleF * (0.3 + p.lope));
        this.next++;
        if (this.next >= p.cyl) { this.next = 0; this.phase -= 720; }
      }

      // --- somma impulsi
      bus[0] = bus[1] = 0; turb[0] = turb[1] = 0;
      let popBus = 0, mech = 0, pulseSum = 0, blk = 0;
      for (let k = 0; k < this.nActive; k++) {
        const i = this.active[k];
        let t = this.pT[i];
        if (t < 0) { this.pT[i] = t + 1; continue; }
        const u = t / this.pDur[i];
        const kind = this.pKind[i];
        if (u >= this.pLen[i]) { // fine impulso
          this.free.push(i); this.active[k] = this.active[--this.nActive]; k--; continue;
        }
        let v;
        if (kind === 2) { mech += this.pAmp[i] * rng.bi() * Math.exp(-5 * u); }
        else if (kind === 3) { blk += this.pAmp[i] * rng.bi() * (1 - u) * (1 - u); }
        else {
          // fronte ripido (apertura valvola, flusso critico) + coda esponenziale + depressione (scavenging)
          if (u < 1) { const q = u * (kind === 1 ? 3.2 : 7); v = q * Math.exp(1 - q) - 0.06 * u; } // scoppi: fronte più morbido
          else if (u < 2) v = -0.30 * Math.sin(Math.PI * (u - 1));
          else v = 0;
          const nz = this.pN[i] * rng.bi() * Math.exp(kind === 1 ? -4 * u : -3 * u);
          if (kind === 0) { bus[this.pBank[i]] += this.pAmp[i] * v; turb[this.pBank[i]] += nz; pulseSum += this.pAmp[i] * v; }
          else popBus += this.pAmp[i] * v + nz;
        }
        this.pT[i] = t + 1;
      }

      // --- scarico per bancata
      let exL = 0, exR = 0, exMono = 0;
      let h0 = 0, h1 = 0;
      for (let b = 0; b < nb; b++) {
        const x = bus[b] + this.turbF[b].tick(turb[b]) * 2.4;
        const h = this.header[b].tick(x);
        if (b === 0) h0 = h; else h1 = h;
      }
      if (nb > 1 && crossover > 0) { const a = h0, c = h1; h0 = a * (1 - crossover) + c * crossover; h1 = c * (1 - crossover) + a * crossover; }
      for (let b = 0; b < nb; b++) {
        const h = (b === 0 ? h0 : h1) + popBus * 0.6;
        const m = this.pipe[b].tick(h);
        const closed = (this.mufC2[b].tick(this.mufC1[b].tick(m)) + this.leakC[b].tick(m) * 0.3) * p.muffler.closedGain;
        const open = (this.mufO[b].tick(m) + this.leakO[b].tick(m) * 0.40) * p.muffler.openGain;
        const e = closed * (1 - this.valve) + open * this.valve;
        exMono += e;
        if (nb > 1) { if (b === 0) { exL += e * (0.5 + width / 2); exR += e * (0.5 - width / 2); } else { exR += e * (0.5 + width / 2); exL += e * (0.5 - width / 2); } }
      }
      if (nb === 1) { exL = exR = exMono; } else exMono *= 0.5;
      let fsum = 0;
      for (let f = 0; f < this.form.length; f++) fsum += this.form[f].tick(exMono) * formG[f];
      if (howlG) { const hk = 0.55 + 0.45 * this.load + 0.4 * this.valve; for (let f = 0; f < this.howl.length; f++) fsum += this.howl[f].tick(exMono) * howlG[f] * hk; }

      // scoppiettii: parte che esce direttamente dal terminale
      const pop = (this.popBody.tick(popBus) * 2.2 + this.popBody2.tick(popBus) * 0.6) * (0.55 + 0.45 * this.valve)
        + this.popLP.tick(popBus) * (0.15 + 0.3 * this.valve) + this.popBP.tick(popBus) * 0.05;

      // --- aspirazione
      this.intakeEnv *= intDec;
      const rpmN = rpm / p.redline;
      const thrK = Math.pow(this.thr, 1.4);
      let intake = this.intBP.tick(rng.bi() * (0.25 + this.intakeEnv)) * p.intake.gain * thrK * (0.3 + rpmN) * 1.4;
      intake += this.intRes.tick(pulseSum) * p.intake.gain * (0.15 + thrK) * 0.9;

      // --- meccanica: punterie + sibilo distribuzione + rumore rotante
      this.whPh += TAU * rpm / 60 * p.whineOrder / sr; if (this.whPh > TAU) this.whPh -= TAU;
      let mechOut = this.mechHP.tick(mech) + Math.sin(this.whPh) * 0.004 * rpmN + this.floorBP.tick(rng.bi()) * 0.025 * rpmN * rpmN * (1 + this.load);
      mechOut += this.blkBP.tick(blk) + this.blkBP2.tick(blk) * 0.6;

      // --- turbo
      let turbo = 0;
      if (p.turbo) {
        const b = this.boost;
        this.turboPh += TAU * (2600 + 6200 * b + 40 * rng.bi()) / sr; if (this.turboPh > TAU) this.turboPh -= TAU;
        turbo += Math.sin(this.turboPh) * p.turbo.whistle * b * b * (0.4 + 0.6 * this.thr);
        turbo += this.turbBP.tick(rng.bi()) * 0.03 * b * this.thr;
        if (p.turbo.seq) { // secondo turbo: fischio più acuto, ben udibile mentre prende giri (3500-4000)
          const b2 = this.b2, sp = this.spool2;
          this.turboPh2 += TAU * (3000 + 4300 * b2 + 800 * sp + 30 * rng.bi()) / sr; if (this.turboPh2 > TAU) this.turboPh2 -= TAU;
          turbo += Math.sin(this.turboPh2) * p.turbo.whistle2 * (0.35 * b2 * b2 + 1.6 * sp) * (0.4 + 0.6 * this.thr);
          turbo += Math.sin(this.turboPh2 * 2.01) * p.turbo.whistle2 * 0.25 * sp;
        }
        if (this.bov > 0.002) { turbo += this.bovBP.tick(rng.bi()) * 0.22 * this.bov; this.bov *= bovDec; }
        const fl = Math.max(this.flutter, this.surge);
        if (fl > 0.002 || this.flutEnv > 0.001) {
          // treno di colpi d'aria a 13-25 Hz ("tu-tu-tu"): ogni colpo = soffio + tonfo di pressione
          const rLo = p.turbo.flutRate ? p.turbo.flutRate[0] : 13, rHi = p.turbo.flutRate ? p.turbo.flutRate[1] : 24;
          this.flutPh += (rLo + (rHi - rLo) * fl) * (1 + 0.08 * rng.bi()) / sr;
          let kick = 0;
          if (this.flutPh >= 1 && fl > 0.002) { this.flutPh -= 1; this.flutEnv = fl * (0.7 + 0.6 * rng.next()); kick = this.flutEnv; }
          else if (this.flutPh >= 1) this.flutPh -= 1;
          const env = this.flutEnv; this.flutEnv *= flutDec;
          const nz = rng.bi();
          const fg = FLUT_G * (p.turbo.flutGain || 1);
          turbo += (this.flutLP.tick(nz) * 0.8 + this.flutBP.tick(nz) * 0.12) * env * fg;
          turbo += this.flutBody.tick(env * (1 + 0.3 * nz) + kick * 4) * 2.5 * fg;
          this.flutter *= this.flutter < 0.06 ? flDec * flDec * flDec : flDec;
        }
      }

      // --- campioni (strato ibrido)
      let smp = 0, hy = 0;
      if (this.hybrid > 0 && this.samples.ok) {
        hy = this.hybrid * this.samples.coverage(rpm);
        if (hy > 0.001) smp = this.samples.tick(rpm, this.load) * 0.9;
      }

      const eg = this.engineGain * gainAll;
      const synthEx = (1 - hy * 0.85);
      let L = ((exL + fsum) * synthEx + pop + intake + mechOut + turbo) * eg + smp * hy * eg;
      let R = ((exR + fsum) * synthEx + pop + intake * 0.9 + mechOut * 0.9 + turbo) * eg + smp * hy * eg;

      // --- uscita: EQ abitacolo, saturazione morbida, limitatore
      L = this.lowShelf.tick(this.hpOut.tick(L)); R = this.lowShelfR.tick(this.hpOutR.tick(R));
      L = this.lpOut.tick(L); R = this.lpOutR.tick(R);
      const d = p.drive;
      L = Math.tanh(L * d) / d * 1.1; R = Math.tanh(R * d) / d * 1.1;
      L *= this.vol; R *= this.vol;
      const pk = Math.max(Math.abs(L), Math.abs(R)) * this.limGain;
      if (pk > 0.9) this.limGain *= 0.9 / pk; else this.limGain += (1 - this.limGain) * 0.00008;
      outL[s] = L * this.limGain; outR[s] = R * this.limGain;
    }
  }
}

export { RNG };
