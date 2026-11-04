// Rombo — logica dell'app: audio, sorgenti velocità (GPS / simulazione), cambio, interfaccia.
import { PRESETS, PRESET_ORDER, SAMPLE_SETS } from './presets.js';
import { Drivetrain, SimVehicle, GpsTracker } from './drivetrain.js';
import { EngineSynth } from './engine-core.js';

const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------------- impostazioni persistenti
const DEF = { v: 3, preset: 'i6tt', mode: 'comfort', valve: false, volume: 0.8, source: 'sim', thr: 1, sens: 1, hybrid: false, media: false, route: false, width: 0.6, bass: 0, treble: 0, safe: false };
const S = Object.assign({}, DEF, JSON.parse(localStorage.getItem('rombo') || '{}'));
if ((S.v !== 2 && S.v !== 3) || !PRESETS[S.preset]) S.preset = 'i6tt'; // nuovo motore predefinito
if (S.v !== 3) { S.v = 3; S.media = false; S.route = false; } // v3: elemento media disattivato di default (volume auto)
const save = () => localStorage.setItem('rombo', JSON.stringify(S));

// ---------------- stato
const dtr = new Drivetrain(PRESETS[S.preset]); dtr.mode = S.mode;
const sim = new SimVehicle(dtr);
let ctx = null, node = null, spSynth = null, running = false, startT = 0, wakeLock = null, msDest = null;
let gas = false, brake = false, neutral = false, kbGas = false, kbBrake = false;
let state = { rpm: 0, gear: 'N', load: 0, throttle: 0, limiter: false, shifting: false, events: [] };
let speed = 0; // m/s mostrata

// ---------------- audio
function post(msg) {
  if (node) node.port.postMessage(msg);
  else if (spSynth) {
    if (msg.type === 'params') spSynth.set(msg.p);
    else if (msg.type === 'preset') spSynth.setPreset(PRESETS[msg.id]);
    else if (msg.type === 'crack') spSynth.shiftCrack(msg.s);
    else if (msg.type === 'loops') spSynth.setLoops(msg.loops);
  }
}

// ---------------- registro errori a schermo (per fare uno screenshot in auto)
const logLines = [];
function log(msg, err = false) {
  const t = new Date().toLocaleTimeString('it-IT');
  logLines.push((err ? '⚠ ' : '') + t + ' ' + msg); if (logLines.length > 60) logLines.shift();
  const el = document.getElementById('logBox'); if (el) el.textContent = logLines.join('\n');
  if (err) { const d = document.getElementById('logPanel'); if (d) d.open = true; }
  try { (err ? console.warn : console.log)('[rombo] ' + msg); } catch (_) {}
}
window.addEventListener('error', (e) => log('Errore: ' + e.message + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''), true));
window.addEventListener('unhandledrejection', (e) => log('Promessa rifiutata: ' + (e.reason && e.reason.message || e.reason), true));
log('Rombo avviato · ' + navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));

async function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio non disponibile');
  // un solo AudioContext per tutta la sessione, con le opzioni predefinite del dispositivo (frequenza, latenza)
  ctx = new AC();
  log('AudioContext: ' + ctx.sampleRate + ' Hz, uscite max ' + (ctx.destination.maxChannelCount || '?') + ', stato ' + ctx.state);
  ctx.onstatechange = () => log('AudioContext → ' + ctx.state);
  let out;
  try {
    if (!ctx.audioWorklet) throw new Error('no worklet');
    await ctx.audioWorklet.addModule('engine-worklet.js');
    node = new AudioWorkletNode(ctx, 'rombo-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { preset: S.preset } });
    node.onprocessorerror = (ev) => log('Errore nel processore audio: ' + (ev.message || 'sconosciuto'), true);
    out = node;
  } catch (e) {
    log('AudioWorklet non disponibile, uso ScriptProcessor: ' + e.message, true);
    spSynth = new EngineSynth(ctx.sampleRate, PRESETS[S.preset], (Math.random() * 1e9) | 0);
    const sp = ctx.createScriptProcessor(1024, 0, 2);
    sp.onaudioprocess = (ev) => { const b = ev.outputBuffer; spSynth.process(b.getChannelData(0), b.getChannelData(1), b.length); };
    out = sp; window.__sp = sp;
  }
  // Grafo minimo e conservativo: motore (stereo generato DENTRO il worklet) → uscita. Nessuna modifica alla
  // configurazione dei canali di ctx.destination, nessun nodo nativo aggiuntivo. Il volume dell'app è solo interno.
  window.__out = out;
  connectOutput();
  post({ type: 'params', p: { width: S.width, bass: S.bass, treble: S.treble, lite: S.safe } });
  if (ctx.state !== 'running') await ctx.resume();
  if (S.hybrid && !S.safe) await loadLoops().catch((e) => log('Campioni non caricati: ' + e.message, true));
}

function connectOutput() {
  const out = window.__out; if (!out) return;
  try { out.disconnect(); } catch (_) {}
  const el = $('#mediaEl');
  // NB: non si imposta MAI volume/muted di un elemento <audio>: in Tesla è legato al volume generale dell'auto
  if (S.route && !S.safe) {
    msDest = msDest || ctx.createMediaStreamDestination();
    out.connect(msDest); el.srcObject = msDest.stream; el.play().catch((e) => log('Riproduzione media: ' + e.message, true));
    log('Uscita: tramite elemento media');
  } else {
    out.connect(ctx.destination);
    if (el.srcObject) { el.pause(); el.srcObject = null; }
    if (S.media && !S.safe) setupSilentMedia();
  }
}

let loopsLoaded = null;
async function loadLoops() {
  const set = SAMPLE_SETS[S.preset];
  if (!set || !ctx) { post({ type: 'loops', loops: [] }); return; }
  if (loopsLoaded && loopsLoaded.id === S.preset) { post({ type: 'loops', loops: loopsLoaded.loops }); return; }
  const loops = [];
  for (const s of set) {
    const buf = await (await fetch(s.url)).arrayBuffer();
    const ab = await ctx.decodeAudioData(buf);
    loops.push({ rpm: s.rpm, data: ab.getChannelData(0).slice() });
  }
  loopsLoaded = { id: S.preset, loops };
  post({ type: 'loops', loops });
}

// elemento audio silenzioso: rende la pagina una "sorgente media" e riceve i tasti del volante
function silentWavUrl() {
  const sr = 8000, n = sr, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
let silentUrl = null;
function setupSilentMedia() {
  const el = $('#mediaEl');
  if (!S.media || S.safe) { if (!el.srcObject) el.pause(); return; }
  // file WAV di silenzio digitale: nessuna necessità di abbassarne il volume (mai toccare el.volume/el.muted)
  if (!el.srcObject) { silentUrl = silentUrl || silentWavUrl(); if (el.src !== silentUrl) el.src = silentUrl; el.loop = true; }
  el.play().catch((e) => log('Media Session: ' + e.message, true));
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Rombo', artist: PRESETS[S.preset].name, album: 'Motore virtuale' });
      const up = () => { shiftUp(); el.play().catch(() => {}); };
      const down = () => { shiftDown(); el.play().catch(() => {}); };
      for (const [a, f] of [['nexttrack', up], ['play', up], ['pause', up], ['previoustrack', down], ['seekforward', up], ['seekbackward', down]]) {
        try { navigator.mediaSession.setActionHandler(a, f); } catch (_) {}
      }
      navigator.mediaSession.playbackState = 'playing';
    } catch (e) { console.warn(e); }
  }
}

async function requestWake() {
  try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (_) {}
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') { requestWake(); if (ctx) ctx.resume(); } });

async function toggleEngine() {
  const btn = $('#startBtn');
  if (!running) {
    btn.disabled = true;
    try { if (!ctx) await startAudio(); else await ctx.resume(); }
    catch (e) {
      log('Avvio audio fallito: ' + (e && e.message || e), true);
      try { if (ctx) ctx.close(); } catch (_) {} ctx = null; node = null; spSynth = null; window.__out = null;
      btn.disabled = false; return;
    }
    running = true; startT = performance.now() / 1000; btn.disabled = false;
    post({ type: 'params', p: { on: true } });
    btn.textContent = 'SPEGNI MOTORE'; btn.classList.add('on');
    requestWake();
    if (S.source === 'gps') gps.start();
    if (S.media && !S.route && !S.safe) setupSilentMedia();
  } else {
    running = false; post({ type: 'params', p: { on: false } });
    btn.textContent = 'AVVIA MOTORE'; btn.classList.remove('on');
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
}

// ---------------- GPS
const gps = {
  id: null, v: 0, a: 0, t: 0, last: null, acc: null, ok: false, err: '', tr: new GpsTracker(),
  start() {
    if (this.id !== null || !('geolocation' in navigator)) { if (!('geolocation' in navigator)) this.err = 'GPS non disponibile'; return; }
    this.id = navigator.geolocation.watchPosition((p) => this.onPos(p), (e) => { this.err = e.message || 'errore GPS'; this.ok = false; },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  },
  stop() { if (this.id !== null) navigator.geolocation.clearWatch(this.id); this.id = null; this.ok = false; this.tr.reset(); },
  onPos(p) {
    const t = p.timestamp / 1000, c = p.coords;
    let s = c.speed;
    if ((s === null || isNaN(s)) && this.last) { // velocità dalle posizioni
      const R = 6371000, toR = Math.PI / 180, l = this.last.coords;
      const dLat = (c.latitude - l.latitude) * toR, dLon = (c.longitude - l.longitude) * toR;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(l.latitude * toR) * Math.cos(c.latitude * toR) * Math.sin(dLon / 2) ** 2;
      const dt = t - this.last.timestamp / 1000; s = dt > 0 ? 2 * R * Math.asin(Math.sqrt(h)) / dt : 0;
    }
    s = Math.max(0, s || 0);
    this.tr.fix(t, s, performance.now() / 1000);
    this.v = this.tr.v; this.a = this.tr.a;
    this.t = t; this.last = p; this.acc = c.accuracy; this.ok = true; this.err = ''; this.rx = performance.now() / 1000;
  },
};

// ---------------- cambio manuale
function shiftUp() {
  if (!running) return;
  if (S.mode !== 'manual') setMode('manual');
  dtr.requestShift(1);
}
function shiftDown() { if (!running) return; if (S.mode !== 'manual') setMode('manual'); dtr.requestShift(-1); }

// ---------------- ciclo di controllo (50 Hz)
let lastT = performance.now() / 1000, gpsLoad = 0;
function tick() {
  const now = performance.now() / 1000, dt = Math.min(0.1, now - lastT); lastT = now;
  const p = PRESETS[S.preset];
  let throttle = 0, v = 0, neu = neutral;
  if (S.source === 'sim') {
    throttle = (gas || kbGas) ? S.thr : 0;
    v = sim.update(dt, throttle, (brake || kbBrake) ? 1 : 0, neutral, state);
  } else {
    // velocità continua tra i fix (niente giri "a scalini") e carico stimato con soglia minima e isteresi
    v = gps.tr.smooth(dt, now);
    throttle = gpsLoad = gps.tr.update(dt, v, dtr, S.sens);
    neu = false;
  }
  speed = v;
  if (running) {
    state = dtr.update(dt, { v, throttle, neutral: neu });
    // avviamento
    const st = now - startT;
    let rpm = state.rpm, load = state.load, thr = state.throttle;
    if (st < 0.65) { rpm = 180 + 120 * Math.sin(st * 40) ** 2; load = 0.04; thr = 0.05; }
    else if (st < 2.4 && rpm < p.idle * 1.8) { const k = (st - 0.65) / 1.75; rpm = Math.max(rpm, p.idle * (1 + 0.7 * Math.exp(-k * 4) * Math.min(1, k * 8))); thr = Math.max(thr, 0.15 * (1 - k)); load = Math.max(load, 0.2 * (1 - k)); }
    state.rpm = rpm;
    const warm = clamp(0.3 + st / 60, 0, 1);
    for (const e of state.events) if (e.type === 'upshift' && S.mode !== 'comfort' && e.load > 0.6) post({ type: 'crack', s: 0.8 });
    post({ type: 'params', p: { rpm, load, throttle: thr, limiter: state.limiter, valve: S.valve, volume: S.volume, warm, hybrid: S.hybrid ? 0.75 : 0 } });
    $('#warmStatus').textContent = warm >= 1 ? 'motore caldo' : `in temperatura ${Math.round(warm * 100)}%`;
  } else { state = { rpm: 0, gear: '–', load: 0 }; }
  const src = $('#srcStatus');
  if (S.source === 'gps') src.textContent = gps.ok ? `GPS ±${Math.round(gps.acc || 0)} m · ${(gps.tr.a).toFixed(1)} m/s² · carico ${Math.round(gpsLoad * 100)}%` : (gps.err || 'GPS: in attesa del segnale…');
  else src.textContent = 'Simulazione';
}
setInterval(tick, 20); // 50 Hz: i parametri vengono poi smussati campione per campione nel worklet

// ---------------- contagiri
const cv = $('#gauge'), g2 = cv.getContext('2d');
function draw() {
  const p = PRESETS[S.preset], W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = W * 0.44;
  g2.clearRect(0, 0, W, H);
  const maxR = Math.ceil((p.redline + 500) / 1000) * 1000;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ang = (r) => a0 + (a1 - a0) * clamp(r / maxR, 0, 1);
  g2.lineCap = 'butt';
  g2.lineWidth = W * 0.035; g2.strokeStyle = '#1c2229'; g2.beginPath(); g2.arc(cx, cy, R, a0, a1); g2.stroke();
  g2.strokeStyle = '#7a1d0a'; g2.beginPath(); g2.arc(cx, cy, R, ang(p.redline), a1); g2.stroke();
  const rpm = state.rpm || 0;
  const grad = g2.createLinearGradient(0, H, W, 0); grad.addColorStop(0, '#ff8a3d'); grad.addColorStop(1, '#ff3b1f');
  g2.strokeStyle = rpm > p.redline * 0.97 ? '#ff2020' : grad; g2.beginPath(); g2.arc(cx, cy, R, a0, ang(rpm)); g2.stroke();
  g2.fillStyle = '#8b95a3'; g2.font = `${W * 0.04}px system-ui`; g2.textAlign = 'center'; g2.textBaseline = 'middle';
  for (let r = 0; r <= maxR; r += 1000) {
    const a = ang(r), c = Math.cos(a), s = Math.sin(a);
    g2.strokeStyle = r >= p.redline ? '#ff3b1f' : '#56606c'; g2.lineWidth = 4;
    g2.beginPath(); g2.moveTo(cx + c * (R - W * 0.03), cy + s * (R - W * 0.03)); g2.lineTo(cx + c * (R - W * 0.065), cy + s * (R - W * 0.065)); g2.stroke();
    g2.fillText(String(r / 1000), cx + c * (R - W * 0.11), cy + s * (R - W * 0.11));
  }
  g2.fillStyle = '#e8ecf1'; g2.font = `800 ${W * 0.26}px system-ui`;
  const modeL = S.mode === 'manual' ? 'M' : (S.mode === 'dynamic' ? 'S' : 'D');
  g2.fillText(String(state.gear ?? '–'), cx, cy - H * 0.03);
  g2.font = `600 ${W * 0.045}px system-ui`; g2.fillStyle = '#ff5a1f'; g2.fillText(modeL + (state.limiter ? '  LIMITATORE' : ''), cx, cy - H * 0.19);
  g2.fillStyle = '#e8ecf1'; g2.font = `700 ${W * 0.085}px system-ui`; g2.fillText(`${Math.round(speed * 3.6)}`, cx, cy + H * 0.17);
  g2.fillStyle = '#8b95a3'; g2.font = `${W * 0.035}px system-ui`; g2.fillText('km/h', cx, cy + H * 0.235);
  g2.fillText(`${Math.round(rpm)} giri/min · ${PRESETS[S.preset].name}`, cx, cy + H * 0.33);
  // barra carico
  const bw = W * 0.36, bx = cx - bw / 2, by = cy + H * 0.385;
  g2.fillStyle = '#1c2229'; g2.fillRect(bx, by, bw, H * 0.015);
  g2.fillStyle = '#36c46b'; g2.fillRect(bx, by, bw * clamp(state.load || 0, 0, 1), H * 0.015);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ---------------- UI
function setPreset(id) {
  S.preset = id; save();
  const wasOn = running;
  post({ type: 'params', p: { on: false } });
  setTimeout(() => {
    dtr.setPreset(PRESETS[id]); post({ type: 'preset', id });
    if (S.hybrid) loadLoops(); else post({ type: 'loops', loops: [] });
    if (wasOn) { post({ type: 'params', p: { on: true } }); startT = performance.now() / 1000 - 0.7; }
    if ('mediaSession' in navigator && navigator.mediaSession.metadata) navigator.mediaSession.metadata.artist = PRESETS[id].name;
  }, 140);
  renderSeg();
}
function setMode(m) { S.mode = m; dtr.mode = m; save(); renderSeg(); }
function setSource(s) {
  S.source = s; save(); renderSeg();
  if (s === 'gps' && running) gps.start(); if (s === 'sim') gps.stop();
  sim.v = 0;
}
function renderSeg() {
  const ps = $('#presetSeg');
  if (!ps.children.length) for (const id of PRESET_ORDER) { const b = document.createElement('button'); b.dataset.v = id; b.textContent = PRESETS[id].name; b.onclick = () => setPreset(id); ps.appendChild(b); }
  for (const b of ps.children) b.classList.toggle('sel', b.dataset.v === S.preset);
  for (const b of $('#modeSeg').children) b.classList.toggle('sel', b.dataset.v === S.mode);
  for (const b of $('#srcSeg').children) b.classList.toggle('sel', b.dataset.v === S.source);
  $('#simPanel').classList.toggle('hidden', S.source !== 'sim');
  $('#shiftRow').classList.toggle('dim', S.mode !== 'manual');
  const vb = $('#valveBtn'); vb.classList.toggle('on', S.valve); vb.querySelector('b').textContent = S.valve ? 'APERTA' : 'CHIUSA';
  const nb = $('#neutralBtn'); nb.classList.toggle('on', neutral); nb.querySelector('b').textContent = neutral ? 'SÌ' : 'NO';
  $('#thrVal').textContent = Math.round(S.thr * 100) + '%'; $('#sensVal').textContent = S.sens.toFixed(1) + '×';
}
for (const b of $('#modeSeg').children) b.onclick = () => setMode(b.dataset.v);
for (const b of $('#srcSeg').children) b.onclick = () => setSource(b.dataset.v);
$('#startBtn').onclick = toggleEngine;
$('#valveBtn').onclick = () => { S.valve = !S.valve; save(); renderSeg(); };
$('#neutralBtn').onclick = () => { neutral = !neutral; renderSeg(); };
$('#upBtn').onclick = shiftUp; $('#downBtn').onclick = shiftDown;
const wid = $('#width'), bas = $('#bass'), tre = $('#treble');
const toneUI = () => { $('#widthVal').textContent = Math.round(S.width * 100) + '%'; $('#bassVal').textContent = (S.bass > 0 ? '+' : '') + S.bass + ' dB'; $('#trebleVal').textContent = (S.treble > 0 ? '+' : '') + S.treble + ' dB'; };
wid.value = S.width; bas.value = S.bass; tre.value = S.treble; toneUI();
wid.oninput = () => { S.width = +wid.value; save(); toneUI(); post({ type: 'params', p: { width: S.width } }); };
bas.oninput = () => { S.bass = +bas.value; save(); toneUI(); post({ type: 'params', p: { bass: S.bass } }); };
tre.oninput = () => { S.treble = +tre.value; save(); toneUI(); post({ type: 'params', p: { treble: S.treble } }); };
const vol = $('#vol'); vol.value = S.volume; vol.oninput = () => { S.volume = +vol.value; save(); };
const thr = $('#thr'); thr.value = S.thr; thr.oninput = () => { S.thr = +thr.value; save(); renderSeg(); };
const sens = $('#sens'); sens.value = S.sens; sens.oninput = () => { S.sens = +sens.value; save(); renderSeg(); };
const hy = $('#hybridChk'); hy.checked = S.hybrid; hy.onchange = async () => { S.hybrid = hy.checked; save(); if (ctx) { if (S.hybrid) await loadLoops(); else post({ type: 'loops', loops: [] }); } };
const mc = $('#mediaChk'); mc.checked = S.media; mc.onchange = () => { S.media = mc.checked; save(); if (ctx) setupSilentMedia(); };
const sc = $('#safeChk'); sc.checked = S.safe;
sc.onchange = () => { S.safe = sc.checked; save(); log('Modalità sicura: ' + (S.safe ? 'attiva' : 'disattiva'));
  if (ctx) { post({ type: 'params', p: { lite: S.safe } }); connectOutput(); if (S.safe) { const el = $('#mediaEl'); if (!el.srcObject) el.pause(); } } };
const rc = $('#routeChk'); rc.checked = S.route; rc.onchange = () => { S.route = rc.checked; save(); if (ctx) connectOutput(); };
function holdBtn(el, set) {
  const on = (e) => { e.preventDefault(); set(true); el.classList.add('pressed'); };
  const off = () => { set(false); el.classList.remove('pressed'); };
  el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointerleave', off); el.addEventListener('pointercancel', off);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
holdBtn($('#gasBtn'), (v) => { gas = v; }); holdBtn($('#brakeBtn'), (v) => { brake = v; });
window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (['ArrowUp', 'Enter', 'MediaTrackNext', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'PageUp', '+'].includes(k)) { if (!e.repeat) shiftUp(); e.preventDefault(); }
  else if (['ArrowDown', 'MediaTrackPrevious', 'PageDown', '-'].includes(k)) { if (!e.repeat) shiftDown(); e.preventDefault(); }
  else if (k === 'w' || k === 'W') kbGas = true;
  else if (k === 's' || k === 'S') kbBrake = true;
});
window.addEventListener('keyup', (e) => { if (e.key === 'w' || e.key === 'W') kbGas = false; if (e.key === 's' || e.key === 'S') kbBrake = false; });
renderSeg();

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));

// hook per i test automatici
window.__rombo = { S, dtr, logLines, get state() { return state; }, get ctx() { return ctx; }, get node() { return node; }, gps };
