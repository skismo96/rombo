// Rombo — AudioWorkletProcessor: esegue il sintetizzatore nel thread audio.
import { EngineSynth } from './engine-core.js';
import { PRESETS } from './presets.js';

class RomboEngine extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const id = (opts && opts.processorOptions && opts.processorOptions.preset) || 'i6tt';
    this.syn = new EngineSynth(sampleRate, PRESETS[id], (Math.random() * 1e9) | 0);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'params') this.syn.set(m.p);
      else if (m.type === 'preset') this.syn.setPreset(PRESETS[m.id]);
      else if (m.type === 'crack') this.syn.shiftCrack(m.s || 1);
      else if (m.type === 'loops') this.syn.setLoops(m.loops || []);
    };
  }
  process(inputs, outputs) {
    const o = outputs[0];
    if (!o || !o[0]) return true;
    this.syn.process(o[0], o[1] || o[0], o[0].length);
    return true;
  }
}
registerProcessor('rombo-engine', RomboEngine);
