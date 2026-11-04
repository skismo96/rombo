// Rombo — trasmissione e veicolo simulato (puro JS, usabile anche in Node).
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

export class Drivetrain {
  constructor(preset) {
    this.mode = 'comfort'; // 'comfort' | 'dynamic' | 'manual'
    this.setPreset(preset);
  }
  setPreset(p) {
    this.p = p; this.gear = 1; this.rpm = p.idle; this.shift = null; this.lastShift = -9; this.t = 0;
    this.freeRpm = p.idle; this.limiter = false; this.blip = 0; this.events = []; this.idlePh = 0;
  }
  rpmAt(v, g) { const p = this.p; return v / p.tyre * 60 * p.ratios[g - 1] * p.final; }
  torque(rpm) {
    const p = this.p, x = rpm / p.redline;
    let t = 1 - Math.pow((x - p.torquePeak) / p.torqueWidth, 2);
    if (p.torqueCurve) { // curva a punti (interpolazione lineare)
      const c = p.torqueCurve; t = c[c.length - 1][1];
      if (rpm <= c[0][0]) t = c[0][1];
      else for (let i = 1; i < c.length; i++) if (rpm <= c[i][0]) { t = lerp(c[i - 1][1], c[i][1], (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0])); break; }
      return p.torque * clamp(t, 0.3, 1) * (rpm > p.limiter ? 0 : 1);
    }
    return p.torque * clamp(t, 0.45, 1) * (rpm > p.limiter ? 0 : 1);
  }
  // accelerazione massima teorica nella marcia g alla velocità v (per stimare il carico dal GPS)
  maxAccel(v, g) {
    const p = this.p, rpm = Math.max(this.rpmAt(v, g), p.idle * 1.5);
    const F = this.torque(Math.min(rpm, p.redline)) * p.ratios[g - 1] * p.final * 0.9 / (p.tyre / TAU);
    return Math.max(0.8, F / p.mass);
  }
  shiftPoints(load) {
    const p = this.p, R = p.redline, I = p.idle;
    if (this.mode === 'dynamic') return { up: lerp(0.55 * R, 0.97 * R, clamp(load, 0, 1)), down: lerp(0.30 * R, 0.55 * R, load) };
    return { up: lerp(Math.max(I * 2.1, 0.27 * R), 0.70 * R, clamp(load, 0, 1)), down: lerp(I * 1.35, 0.30 * R, load) };
  }
  requestShift(dir) { // cambio manuale (+1/-1)
    const g = this.gear + dir;
    if (g < 1 || g > this.p.ratios.length) return false;
    this.startShift(g, this._v || 0, this._load || 0);
    return true;
  }
  startShift(g, v, load) {
    const up = g > this.gear;
    const fast = this.mode !== 'comfort';
    this.shift = { from: this.rpm, to: g, t: 0, dur: up ? (fast ? 0.11 : 0.28) : (fast ? 0.22 : 0.35), up, load };
    this.gear = g; this.lastShift = this.t;
    this.events.push({ type: up ? 'upshift' : 'downshift', load, mode: this.mode });
  }
  // input: v (m/s), throttle 0..1 (carico richiesto), neutral (folle / auto ferma)
  update(dt, { v, throttle, neutral = false }) {
    const p = this.p; this.t += dt; this._v = v; this._load = throttle;
    let load = throttle, rpm;
    this.limiter = false;
    if (neutral) {
      // motore libero: sale/scende con inerzia
      const tgt = p.idle + throttle * (p.limiter + 300 - p.idle);
      const rate = this.freeRpm < tgt ? (2500 + 9000 * throttle) * (9000 / p.redline) * 0.85 : 3200 + this.freeRpm * 0.35;
      this.freeRpm += clamp(tgt - this.freeRpm, -rate * dt, rate * dt);
      if (this.freeRpm >= p.limiter) { this.freeRpm = p.limiter - 250; this.limiter = true; load = 0; }
      rpm = this.freeRpm; this.shift = null;
      this.gearLabel = 'N';
    } else {
      // cambio automatico
      if (this.mode !== 'manual' && !this.shift && this.t - this.lastShift > 0.7) {
        const sp = this.shiftPoints(load), cur = this.rpmAt(v, this.gear);
        if (cur > sp.up && this.gear < p.ratios.length) this.startShift(this.gear + 1, v, load);
        else if (this.gear > 1 && cur < sp.down) this.startShift(this.gear - 1, v, load);
        else if (this.gear > 1 && load > 0.85 && this.rpmAt(v, this.gear - 1) < 0.82 * p.redline && cur < 0.55 * p.redline) this.startShift(this.gear - 1, v, load); // kickdown
      }
      if (this.mode === 'manual' && !this.shift && this.gear > 1 && this.rpmAt(v, this.gear) < p.idle * 1.1 && this.t - this.lastShift > 0.5) this.startShift(this.gear - 1, v, load);
      if (!this.shift && this.mode !== 'manual' && this.rpmAt(v, this.gear) > p.redline * 0.995 && this.gear < p.ratios.length) this.startShift(this.gear + 1, v, load);

      let raw = this.rpmAt(v, this.gear);
      // frizione / convertitore: slittamento in partenza
      if (this.gear === 1) {
        const slip = p.idle + throttle * 1700 * (this.mode === 'dynamic' ? 1.3 : 1);
        if (raw < slip) raw = lerp(slip, raw, clamp(raw / slip, 0, 1) ** 3);
      }
      raw = Math.max(raw, p.idle * (v < 0.5 ? 1 : 0.92));
      if (raw > p.limiter) { // limitatore (manuale o GPS oltre il possibile)
        this.limiter = true;
        raw = p.limiter - 120 - 120 * Math.abs(Math.sin(this.t * 40));
        load = 0;
      }
      if (this.shift) {
        const s = this.shift; s.t += dt;
        const k = clamp(s.t / s.dur, 0, 1), e = k * k * (3 - 2 * k);
        rpm = lerp(s.from, raw, e);
        if (s.up) load = k < 0.75 ? 0 : load * (k - 0.75) / 0.25; // taglio di coppia
        else { load = Math.max(load, 0.55 * Math.sin(Math.PI * k)); rpm = lerp(s.from, raw * 1.04, e); } // doppietta
        if (k >= 1) this.shift = null;
      } else rpm = raw;
      this.gearLabel = String(this.gear);
    }
    // minimo irregolare
    if (rpm < p.idle * 1.15) { this.idlePh += dt; rpm += Math.sin(this.idlePh * 2.1) * 12 + Math.sin(this.idlePh * 5.3) * 6; }
    if (!this.shift && !neutral) { // inerzia del motore: limita la velocità di variazione
      const up = 9000 * (9000 / p.redline) * 0.8, dn = 7000;
      rpm = this.rpm + clamp(rpm - this.rpm, -dn * dt, up * dt);
    }
    this.rpm = rpm;
    const ev = this.events; this.events = [];
    return { rpm, gear: this.gearLabel, load: clamp(load, 0, 1), throttle: clamp(load, 0, 1), limiter: this.limiter, shifting: !!this.shift, events: ev };
  }
}
const TAU = Math.PI * 2;

// Veicolo simulato: per provare senza GPS
export class SimVehicle {
  constructor(dtrain) { this.dt = dtrain; this.v = 0; }
  update(dt, throttle, brake, neutral, state) {
    const p = this.dt.p, m = p.mass, r = p.tyre / TAU;
    let F = 0;
    if (!neutral && !state.shifting) {
      const g = this.dt.gear, ratio = p.ratios[g - 1] * p.final;
      F = this.dt.torque(state.rpm) * throttle * ratio * 0.9 / r;
      if (throttle < 0.05 && this.v > 1) F -= (state.rpm / p.redline) * 60 * ratio / r; // freno motore
    }
    F -= 0.5 * 1.2 * 0.62 * this.v * this.v + (this.v > 0.05 ? 0.012 * m * 9.81 : 0);
    F -= brake * 9 * m;
    this.v = Math.max(0, this.v + F / m * dt);
    return this.v;
  }
}
