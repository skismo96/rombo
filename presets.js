// Rombo — preset motori (parametri originali, nessun marchio).
// Angoli di scoppio in gradi albero (ciclo 0..720), ordinati; bank = collettore/linea di scarico.
// runner = lunghezza del collettore primario del cilindro (m); ratios = rapporti cambio; final = coppia conica;
// tyre = circonferenza di rotolamento (m).

export const PRESETS = {
  i6tt: {
    id: 'i6tt', block: 0.40, blockF: 1650, name: '6 in linea Biturbo', short: '6TT',
    cyl: 6,
    // 3.0 6 cilindri in linea biturbo sequenziale. Ordine 1-5-3-6-2-4, scoppi ogni 120° (regolare).
    // Collettore diviso: cil. 1-2-3 -> ramo anteriore (0), 4-5-6 -> ramo posteriore (1).
    // Gli elementi sono in ordine di scoppio: 1,5,3,6,2,4.
    fire: [0, 120, 240, 360, 480, 600],
    bank: [0, 1, 0, 1, 0, 1],
    runner: [0.46, 0.40, 0.38, 0.47, 0.40, 0.38],
    cylVar: [1.0, 0.99, 1.01, 0.995, 1.005, 0.99],
    idle: 800, redline: 6800, limiter: 6900,
    // cambio manuale 6 marce tipo V160, coppia 3.133, pneumatici 255/40R17 (circonferenza di rotolamento ~1.97 m)
    ratios: [3.827, 2.36, 1.685, 1.312, 1.0, 0.793], final: 3.133, tyre: 1.97,
    torque: 440, torquePeak: 0.6, torqueWidth: 0.55, mass: 1570,
    // coppia relativa con il "buco" della transizione sequenziale intorno a 4000 giri
    torqueCurve: [[800, 0.42], [1800, 0.58], [2800, 0.86], [3500, 0.93], [3900, 0.86], [4300, 1.0], [5200, 0.98], [6000, 0.9], [6800, 0.78]],
    turbo: { spoolStart: 1600, spoolFull: 3000, seq: { start: 3300, full: 4300, mix: 0.45 }, whistle: 0.032, whistle2: 0.07, bov: 'both', damp: 0.45 },
    pulseDeg: 68, noise: 0.40, lope: 0.06,
    header: { len: 0.45, refl: -0.30 }, pipe: { len: 3.3, refl: -0.46 }, crossover: 0.45,
    muffler: { closedLP: 720, openLP: 2700, closedGain: 0.8, openGain: 1.25 },
    formants: [{ f: 140, q: 1.5, g: 0.50 }, { f: 470, q: 2.2, g: 0.30 }, { f: 1450, q: 3, g: 0.12 }],
    // risonanze che seguono gli ordini del motore: l'"ululato" pulito del 6 in linea (ordini 3, 6, 9, 12)
    howl: [{ order: 3, q: 4, g: 0.22 }, { order: 6, q: 6, g: 0.30 }, { order: 9, q: 7, g: 0.20 }, { order: 12, q: 8, g: 0.09 }],
    intake: { gain: 0.11, f: 300, q: 1.5 },
    mech: 0.035, whineOrder: 28, pops: 0.35, popTone: 1700, drive: 1.5, gain: 1.3, width: 0.2,
  },
  i4t: {
    id: 'i4t', block: 0.47, blockF: 1500, name: '4 cilindri Turbo', short: '4T',
    cyl: 4,
    fire: [0, 180, 360, 540],
    bank: [0, 0, 0, 0],
    runner: [0.42, 0.50, 0.50, 0.42],
    cylVar: [1.0, 0.94, 1.04, 0.97],
    idle: 850, redline: 6800, limiter: 6900,
    ratios: [3.46, 2.05, 1.48, 1.16, 0.97, 0.83, 0.69], final: 3.65, tyre: 2.02,
    torque: 400, torquePeak: 0.45, torqueWidth: 0.45, mass: 1500,
    turbo: { spoolStart: 1800, spoolFull: 3400, whistle: 0.020, bov: 'valve', damp: 0.55 },
    pulseDeg: 80, noise: 0.55, lope: 0.15,
    header: { len: 0.55, refl: -0.35 }, pipe: { len: 2.7, refl: -0.42 }, crossover: 0,
    muffler: { closedLP: 650, openLP: 1700, closedGain: 0.75, openGain: 1.15 },
    formants: [{ f: 105, q: 1.4, g: 0.55 }, { f: 380, q: 2.5, g: 0.25 }, { f: 1250, q: 3, g: 0.08 }],
    intake: { gain: 0.10, f: 260, q: 1.4 },
    mech: 0.035, whineOrder: 26, pops: 0.30, popTone: 1800, drive: 1.4, gain: 1.0, width: 0.25,
  },
  i5: {
    id: 'i5', block: 0.52, blockF: 1700, name: '5 cilindri', short: '5C',
    cyl: 5,
    fire: [0, 144, 288, 432, 576],
    bank: [0, 0, 0, 0, 0],
    // collettore 5-in-1 con primari di lunghezza diversa: dà il tipico "ululato" irregolare
    runner: [0.38, 0.47, 0.58, 0.66, 0.52],
    cylVar: [1.0, 0.91, 1.07, 0.95, 1.03],
    idle: 820, redline: 7000, limiter: 7100,
    ratios: [3.56, 2.19, 1.41, 1.00, 0.83, 0.68, 0.55], final: 4.10, tyre: 2.05,
    torque: 480, torquePeak: 0.5, torqueWidth: 0.5, mass: 1550,
    turbo: { spoolStart: 2200, spoolFull: 3800, whistle: 0.028, bov: 'flutter', damp: 0.35 },
    pulseDeg: 74, noise: 0.5, lope: 0.25,
    header: { len: 0.70, refl: -0.40 }, pipe: { len: 2.9, refl: -0.48 }, crossover: 0,
    muffler: { closedLP: 800, openLP: 2300, closedGain: 0.8, openGain: 1.2 },
    formants: [{ f: 150, q: 1.6, g: 0.55 }, { f: 520, q: 2.2, g: 0.35 }, { f: 1600, q: 3, g: 0.10 }],
    intake: { gain: 0.14, f: 330, q: 1.6 },
    mech: 0.04, whineOrder: 30, pops: 0.40, popTone: 2000, drive: 1.6, gain: 0.95, width: 0.3,
  },
  f6: {
    id: 'f6', block: 0.24, blockF: 2200, name: '6 Boxer aspirato', short: 'B6',
    cyl: 6,
    fire: [0, 120, 240, 360, 480, 600],
    // ordine 1-6-2-4-3-5: bancate alternate
    bank: [0, 1, 0, 1, 0, 1],
    runner: [0.48, 0.48, 0.52, 0.52, 0.46, 0.46],
    cylVar: [1.0, 0.97, 1.03, 0.98, 1.02, 0.99],
    idle: 900, redline: 9000, limiter: 9100,
    ratios: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], final: 4.19, tyre: 2.06,
    torque: 470, torquePeak: 0.72, torqueWidth: 0.55, mass: 1450,
    turbo: null,
    pulseDeg: 62, noise: 0.25, lope: 0.1,
    header: { len: 0.50, refl: -0.30 }, pipe: { len: 1.9, refl: -0.40 }, crossover: 0.35,
    muffler: { closedLP: 1100, openLP: 3600, closedGain: 0.8, openGain: 1.25 },
    formants: [{ f: 210, q: 1.5, g: 0.45 }, { f: 860, q: 2.5, g: 0.30 }, { f: 2400, q: 3.5, g: 0.10 }],
    intake: { gain: 0.32, f: 520, q: 1.8 },
    mech: 0.055, whineOrder: 34, pops: 0.25, popTone: 2600, drive: 1.5, gain: 1.75, width: 0.45,
  },
  v8: {
    id: 'v8', block: 0.34, blockF: 1200, name: 'V8 albero a croce', short: 'V8',
    cyl: 8,
    // ordine 1-8-4-3-6-5-7-2, spaziatura 90°; le bancate ricevono impulsi irregolari (borbottio)
    fire: [0, 90, 180, 270, 360, 450, 540, 630],
    bank: [0, 1, 1, 0, 1, 0, 0, 1],
    runner: [0.62, 0.70, 0.55, 0.66, 0.60, 0.72, 0.58, 0.64],
    cylVar: [1.0, 0.93, 1.06, 0.97, 1.04, 0.92, 1.05, 0.98],
    idle: 700, redline: 6800, limiter: 6900,
    ratios: [4.03, 2.36, 1.53, 1.15, 0.85, 0.67], final: 3.42, tyre: 2.10,
    torque: 620, torquePeak: 0.6, torqueWidth: 0.6, mass: 1700,
    turbo: null,
    pulseDeg: 88, noise: 0.35, lope: 0.55,
    header: { len: 0.80, refl: -0.38 }, pipe: { len: 3.3, refl: -0.50 }, crossover: 0.18,
    muffler: { closedLP: 520, openLP: 1500, closedGain: 0.85, openGain: 1.3 },
    formants: [{ f: 72, q: 1.3, g: 0.6 }, { f: 240, q: 2.0, g: 0.35 }, { f: 900, q: 2.8, g: 0.10 }],
    intake: { gain: 0.16, f: 220, q: 1.4 },
    mech: 0.04, whineOrder: 22, pops: 0.55, popTone: 1400, drive: 1.7, gain: 1.9, width: 0.55,
  },
};

export const PRESET_ORDER = ['i6tt', 'i4t', 'i5', 'f6', 'v8'];

// Campioni CC0 opzionali (strato ibrido) — vedi CREDITS.md
export const SAMPLE_SETS = {
  i4t: [
    { rpm: 837, url: 'assets/loops/cc0_i4_idle_837.wav' },
    { rpm: 1476, url: 'assets/loops/cc0_i4_low_1476.wav' },
    { rpm: 2010, url: 'assets/loops/cc0_i4_med_2010.wav' },
    { rpm: 2550, url: 'assets/loops/cc0_i4_high_2550.wav' },
  ],
};
