// Rombo — AudioWorkletProcessor: esegue il sintetizzatore nel thread audio.
import { EngineSynth } from './engine-core.js';
import { PRESETS } from './presets.js';

class RomboEngine extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const id = (opts && opts.processorOptions && opts.processorOptions.preset) || 'i6tt';
    this.syn = new EngineSynth(sampleRate, PRESETS[id], (Math.random() * 1e9) | 0);
    // statistiche leggere (per i test): blocchi elaborati, tempo di calcolo, campioni non validi
    this.blocks = 0; this.busy = 0; this.maxMs = 0; this.t0 = Date.now(); this.nan = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'params') this.syn.set(m.p);
      else if (m.type === 'preset') this.syn.setPreset(PRESETS[m.id]);
      else if (m.type === 'crack') this.syn.shiftCrack(m.s || 1);
      else if (m.type === 'loops') this.syn.setLoops(m.loops || []);
      else if (m.type === 'stats') this.port.postMessage({ type: 'stats', blocks: this.blocks, busyMs: this.busy, maxMs: this.maxMs, wallMs: Date.now() - this.t0, frames: this.blocks * 128, nan: this.nan });
    };
  }
  process(inputs, outputs) {
    const o = outputs[0];
    if (!o || !o[0]) return true;
    const t0 = Date.now();
    this.syn.process(o[0], o[1] || o[0], o[0].length);
    const el = Date.now() - t0; this.busy += el; if (el > this.maxMs) this.maxMs = el; this.blocks++;
    if (!(Math.abs(o[0][0]) <= 4)) { this.nan++; o[0].fill(0); if (o[1]) o[1].fill(0); }
    return true;
  }
}
registerProcessor('rombo-engine', RomboEngine);
