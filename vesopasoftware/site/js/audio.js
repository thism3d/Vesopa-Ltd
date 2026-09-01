/* The room tone.
 *
 * Synthesised in the browser rather than shipped as a file. A loop long enough
 * not to be noticed is a megabyte or two of MP3, it seams audibly wherever it
 * wraps, and it plays the same thirty seconds regardless of where the visitor
 * is on the page. This is a few oscillators and a noise bed: about 4KB of
 * code, no download, no loop point, and it can follow the scroll — the filter
 * opens as the page walks from night into day, so the sound brightens with the
 * picture.
 *
 * Nothing here makes a sound until someone asks for it. Browsers block audio
 * before a gesture, and quite right too: a site that plays music at you
 * unbidden is a site people close.
 *
 * Tuning is D minor — D2 / A2 / F3 / A3. Low, wide, unresolved, no melody.
 * The moment a drone implies a tune it starts competing with reading.
 */

const NOTES = [73.42, 110.0, 174.61, 220.0];   // D2  A2  F3  A3

export function createAudio() {
  let ctx = null;
  let master = null;
  let filter = null;
  let voices = [];
  let noiseSrc = null;
  let on = false;
  let target = 0.16;          // resting master gain — deliberately quiet

  /** Build the graph. Called once, on the gesture that enables sound. */
  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // One filter across everything, so scroll moves the whole bed together.
    filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 320;
    filter.Q.value = 0.7;
    filter.connect(master);

    // A little bus compression stops the detuned voices summing into peaks.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 4;
    comp.connect(filter);

    for (const hz of NOTES) {
      // Two oscillators per note, detuned a few cents apart. The beating
      // between them is what stops a synth drone sounding like a test tone.
      for (const cents of [-4, 5]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = hz;
        osc.detune.value = cents;

        const g = ctx.createGain();
        // Roll the higher notes back; low notes carry a drone, high ones
        // sit on top of it and get shrill fast.
        g.gain.value = hz < 150 ? 0.30 : 0.13;

        // Slow independent swell per voice, so the chord breathes instead of
        // sitting still. Prime-ish periods keep them from lining up.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.03 + Math.random() * 0.05;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = hz < 150 ? 0.10 : 0.06;
        lfo.connect(lfoGain).connect(g.gain);

        osc.connect(g).connect(comp);
        osc.start();
        lfo.start();
        voices.push(osc, lfo);
      }
    }

    // Air: two seconds of noise on a loop, filtered hard. Gives the drone a
    // room to sit in — without it the chord sounds like it is in a vacuum.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < len; i++) {
      // Brown noise: closer to airflow than white, which reads as hiss.
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      d[i] = lastOut * 3.2;
    }
    // Taper the last 50ms into the first so the two-second loop has no click.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[len - fade + i] * (1 - k);
    }

    noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = buf;
    noiseSrc.loop = true;
    const nGain = ctx.createGain();
    nGain.gain.value = 0.05;
    noiseSrc.connect(nGain).connect(comp);
    noiseSrc.start();

    return true;
  }

  /** A short percussive blip. Used for page events, kept almost subliminal. */
  function blip(hz, dur = 0.09, gain = 0.05, type = "sine") {
    if (!ctx || !on) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, t);
    // Exponential ramps only; a linear ramp to zero clicks, and
    // exponentialRampToValueAtTime refuses a target of exactly 0.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  return {
    get enabled() { return on; },
    get available() { return Boolean(window.AudioContext || window.webkitAudioContext); },

    /** Must be called from inside a real user gesture. */
    async enable() {
      if (on) return true;
      if (!ctx && !build()) return false;
      // Safari starts the context suspended even when built in a gesture.
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      on = true;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      // Four seconds is slow enough that nobody perceives it starting.
      master.gain.linearRampToValueAtTime(target, ctx.currentTime + 4);
      return true;
    },

    disable() {
      if (!ctx || !on) return;
      on = false;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    },

    toggle() { return on ? (this.disable(), false) : (this.enable(), true); },

    /** 0 at the top of the page, 1 at the bottom. Opens the filter. */
    scroll(k) {
      if (!ctx || !on) return;
      const hz = 300 + Math.pow(Math.min(1, Math.max(0, k)), 1.4) * 1500;
      filter.frequency.setTargetAtTime(hz, ctx.currentTime, 0.6);
    },

    /** A screenshot changed. */
    tick() { blip(880, 0.07, 0.028, "triangle"); },
    /** Something arrived — a section, a store badge coming into view. */
    chime() { blip(587.33, 0.5, 0.035); blip(880, 0.6, 0.022); },
  };
}
