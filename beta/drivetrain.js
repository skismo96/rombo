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
    this.freeRpm = p.idle; this.sl = 0; this.kick = 0; this.lastDir = 0; this.limiter = false; this.blip = 0; this.events = []; this.idlePh = 0;
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
    // comfort: cambiate dolci ma con il motore sempre "vivo" (mai sotto ~2000 giri in marcia costante)
    return { up: lerp(Math.max(I * 2.9, 0.37 * R), 0.72 * R, clamp(load, 0, 1)), down: lerp(Math.max(I * 1.9, 0.24 * R), 0.36 * R, load) };
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
    this.gear = g; this.lastShift = this.t; this.lastDir = up ? 1 : -1;
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
      // decisioni di cambiata su carico smussato + tempi minimi tra cambiate in direzioni opposte (niente "pendolamento")
      this.sl += (load - this.sl) * Math.min(1, dt / (load > this.sl ? 0.5 : 0.9));
      this.kick = load > 0.9 ? this.kick + dt : 0;
      if (this.mode !== 'manual' && !this.shift && this.t - this.lastShift > 0.7) {
        const sl = this.sl, sp = this.shiftPoints(sl), cur = this.rpmAt(v, this.gear), since = this.t - this.lastShift;
        const nextOk = this.gear < p.ratios.length && this.rpmAt(v, this.gear + 1) > this.shiftPoints(Math.max(sl, 0.5)).down + 150;
        if (cur > sp.up && nextOk && (this.lastDir !== -1 || since > 1.8)) this.startShift(this.gear + 1, v, sl);
        else if (this.gear > 1 && cur < sp.down && (this.lastDir !== 1 || since > 3 || cur < p.idle * 1.35)) this.startShift(this.gear - 1, v, sl);
        else if (this.gear > 1 && this.kick > 0.5 && (this.lastDir !== 1 || since > 2.5) && this.rpmAt(v, this.gear - 1) < 0.82 * p.redline && cur < 0.55 * p.redline) this.startShift(this.gear - 1, v, load); // kickdown
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

// Stima di velocità/accelerazione/carico dai fix GPS (≈1 Hz, rumorosi).
// Filtro alfa-beta sulla velocità, carico con soglia minima mentre si viaggia (così in marce alte e a velocità
// costante il motore resta "in tiro" e non va in rilascio per il rumore del GPS), rilascio con isteresi.
export class GpsTracker {
  constructor() { this.reset(); }
  reset() { this.v = 0; this.a = 0; this.t = null; this.rx = 0; this.ok = false; this.load = 0; this.lift = false; this.last = null; }
  // t = timestamp del fix (s), s = velocità misurata (m/s), now = orologio locale (s)
  fix(t, s, now) {
    s = Math.max(0, s || 0);
    if (!this.ok || this.t === null || t <= this.t || t - this.t > 5) { this.v = s; this.a = 0; }
    else {
      // guadagni alfa-beta smorzati criticamente, dipendenti dall'intervallo tra i fix (1 Hz o 10 Hz danno la stessa banda)
      const dt = t - this.t, vp = Math.max(0, this.v + this.a * dt), r = s - vp;
      const al = 1 - Math.exp(-dt / 0.9), be = Math.max(0, 2 * (2 - al) - 4 * Math.sqrt(1 - al));
      this.v = Math.max(0, vp + al * r);
      this.a = clamp(this.a + be * r / dt, -9, 9);
      if (this.v < 0.3 && s < 0.3) this.a *= 0.5;
    }
    this.t = t; this.rx = now; this.ok = true;
  }
  speedNow(now) { if (!this.ok) return 0; const dt = Math.min(1.2, now - this.rx); return Math.max(0, this.v + this.a * dt * 0.8); }
  // velocità continua per il motore: segue la stima con avanzamento dato dall'accelerazione (nessun gradino ai fix)
  smooth(dt, now) {
    if (!this.ok) { this.vs = 0; return 0; }
    if (this.vs === undefined) this.vs = this.v;
    const tgt = this.speedNow(now);
    const ff = Math.min(1.2, now - this.rx) < 1.2 ? this.a * 0.8 : 0;
    this.vs = Math.max(0, this.vs + ff * dt + (tgt - this.vs) * Math.min(1, dt / 0.45));
    return this.vs;
  }
  // carico richiesto 0..1 (usato come "farfalla") per la marcia corrente
  update(dt, v, dtr, sens = 1) {
    const g = Math.max(1, dtr.gear), coast = 0.25 + 0.0004 * v * v, aMax = dtr.maxAccel(v, g), a = this.a;
    let tgt = v < 0.4 && a < 0.2 ? 0 : clamp((a + coast) / aMax * sens, 0, 1);
    // isteresi rilascio: solo con decelerazione netta (rigenerazione/frenata), non per il rumore del GPS
    if (this.lift) { if (a > -0.45 || v < 1) this.lift = false; } else if (a < -1.0 && v > 3) this.lift = true;
    if (!this.lift && v > 2) tgt = Math.max(tgt, 0.22 + 0.08 * Math.min(1, v / 30)); // marcia costante = motore in leggero tiro
    const tau = tgt > this.load ? 0.35 : 0.7;
    this.load += (tgt - this.load) * Math.min(1, dt / tau);
    return this.lift ? 0 : this.load;
  }
}

// Dal GPS a un "pilota virtuale": il segnale GPS (filtrato, con predizione) diventa la velocità obiettivo di un
// veicolo simulato identico a quello di Simulazione; un regolatore calcola pedale e freno virtuali. Così giri,
// carico e cambiate si comportano come in Simulazione, senza gradini né tagli quando si supera una soglia.
export class GpsDriver {
  constructor(dtr) { this.dtr = dtr; this.tr = new GpsTracker(); this.sim = new SimVehicle(dtr); this.cruiseOn = true; this.reset(); }
  reset() {
    this.tr.reset(); this.sim.v = 0; this.pedal = 0; this.brake = 0; this.lift = false; this.last = null; this.lastT = null;
    this.acc = null; this.vT = 0; this.stats = { fixes: 0, used: 0, dup: 0, rejected: 0, nullSpeed: 0 };
    this.cruise = false; this.cruisePed = 0; this.cruiseV = 0; this.stableT = 0; this.liftT = 0;
  }
  // ts = timestamp del fix in ms, c = coords {speed, latitude, longitude, accuracy}, now = orologio locale (s)
  onPos(ts, c, now) {
    const t = ts / 1000; this.stats.fixes++;
    if (this.lastT !== null && t <= this.lastT + 0.02) { this.stats.dup++; return false; } // duplicato / fuori ordine
    const acc = (c.accuracy == null || isNaN(c.accuracy)) ? 999 : c.accuracy;
    let s = (c.speed == null || isNaN(c.speed) || c.speed < 0) ? null : c.speed; // alcuni browser danno -1 = non valida
    const pos = (c.latitude != null && c.longitude != null) ? { t, lat: c.latitude, lon: c.longitude, acc } : null;
    if (s === null) {
      this.stats.nullSpeed++;
      if (pos && this.last && acc < 30 && this.last.acc < 30 && t - this.last.t >= 0.8) {
        const R = 6371000, toR = Math.PI / 180, l = this.last;
        const dLat = (pos.lat - l.lat) * toR, dLon = (pos.lon - l.lon) * toR;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(l.lat * toR) * Math.cos(pos.lat * toR) * Math.sin(dLon / 2) ** 2;
        s = 2 * R * Math.asin(Math.sqrt(h)) / (t - l.t);
      }
      if (pos && (acc < 30 || !this.last)) if (!this.last || t - this.last.t >= 0.8) this.last = pos;
      if (s === null) { this.lastT = t; return false; }
    } else if (pos && acc < 30) this.last = pos;
    // plausibilità: velocità fuori scala, salti impossibili (picchi di imprecisione)
    const dtf = this.lastT === null ? 1 : t - this.lastT, pred = this.tr.ok ? Math.max(0, this.tr.v + this.tr.a * Math.min(dtf, 2)) : s;
    if (s < 0 || s > 95 || (this.tr.ok && dtf < 5 && Math.abs(s - pred) > 3 + 10 * dtf) || (acc > 50 && this.tr.ok && Math.abs(s - pred) > 2)) {
      this.stats.rejected++; this.lastT = t; return false;
    }
    this.acc = acc; this.lastT = t; this.stats.used++;
    this.tr.fix(t, s, now);
    return true;
  }
  // un passo del pilota virtuale; state = ultimo stato della trasmissione (rpm, shifting). Restituisce {v, throttle, brake, cruise}
  update(dt, now, state, sens = 1) {
    const tr = this.tr, dtr = this.dtr, p = dtr.p, m = p.mass, vs = this.sim.v;
    const fresh = tr.ok && now - tr.rx < 1.5;
    const vT = tr.ok ? tr.smooth(dt, now) : 0, aT = fresh ? tr.a * 0.8 : 0;
    this.vT = vT;
    const lead = vT + aT * 0.6; // predizione: compensa la latenza tipica del GPS
    const resist = (0.5 * 1.2 * 0.62 * vs * vs + (vs > 0.05 ? 0.012 * m * 9.81 : 0)) / m;
    const aCmd = clamp(aT + 0.9 * (lead - vs), -9, 9);
    const aMax = dtr.maxAccel(Math.max(vs, 0.5), Math.max(1, dtr.gear));
    let ped = (aCmd + resist) / aMax * sens;
    let brk = 0;
    if (lead < 0.3 && vs < 0.6) { ped = 0; brk = 1; this.cruise = false; this.stableT = 0; } // fermo
    else {
      // rilascio vero solo con decelerazione netta e prolungata (frenata/rigenerazione); le piccole variazioni
      // di velocità restano "gas parziale", così il suono non si spegne mai per il rumore o la latenza del GPS
      this.liftT = ped < 0 && aCmd < -1.0 ? (this.liftT || 0) + dt : 0;
      if (this.lift) { if (ped > 0.04 || aCmd > -0.5) this.lift = false; } else if (this.liftT > 0.4) this.lift = true;
      if (this.lift) { brk = clamp(-(aCmd + resist * 0.5) / 9, 0, 1) * (ped < -0.15 ? 1 : 0); ped = 0; this.cruise = false; this.stableT = 0; }
      else ped = clamp(ped, 0.03, 1);
    }

    // --- mantenimento crociera: se la velocità GPS è stabile per qualche secondo, blocca pedale/carico
    //     così il suono non "caccia" per i micro-rumori del GPS. Si sblocca con accel/freno reali.
    if (this.cruiseOn && !this.lift && brk < 0.05 && lead >= 4) {
      const stable = Math.abs(aT) < 0.35 && Math.abs(aCmd) < 0.55 && Math.abs(vT - vs) < 1.2;
      if (this.cruise) {
        // sblocca solo su intenito vero (accel/freno/cambio velocità), non sul rumore GPS
        const unlock = Math.abs(aT) > 0.85 || Math.abs(vT - this.cruiseV) > 2.2 || Math.abs(aCmd) > 1.8 || ped > this.cruisePed + 0.28 || ped < 0.02;
        if (unlock) { this.cruise = false; this.stableT = 0; }
        else {
          // pedale bloccato in modo morbido; velocità ancorata alla media crociera
          ped = this.cruisePed;
          const holdV = this.cruiseV;
          // aggiorna leggermente il riferimento se il GPS scorre di pochissimo (deriva)
          this.cruiseV += (vT - this.cruiseV) * Math.min(1, dt / 8);
        }
      } else if (stable) {
        this.stableT += dt;
        if (this.stableT > 2.4) {
          this.cruise = true;
          this.cruisePed = clamp(this.pedal, 0.08, 0.85);
          this.cruiseV = vT;
        }
      } else this.stableT = Math.max(0, this.stableT - dt * 1.5);
    } else { this.cruise = false; this.stableT = 0; }

    const tau = this.cruise ? 0.35 : (ped > this.pedal ? 0.12 : 0.2);
    this.pedal += (ped - this.pedal) * Math.min(1, dt / tau);
    this.brake = brk;
    let v = this.sim.update(dt, this.pedal, brk, false, state);
    // aggancio morbido alla velocità GPS: in crociera ancora più lento per evitare micro-caccia
    if (!(lead < 0.3 && vs < 0.6)) {
      const slaveTau = this.cruise ? 2.8 : 1.0;
      const target = this.cruise ? this.cruiseV : lead;
      v += (target - v) * Math.min(1, dt / slaveTau); this.sim.v = v = Math.max(0, v);
    }
    return { v, throttle: this.pedal, brake: brk, target: vT, cruise: this.cruise };
  }
}
