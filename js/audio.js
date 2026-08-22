/* ============================================================
   NEON://SNAKE — audio engine (SPEC §5, §7)
   Pure Web Audio synthesis: no files, no CDN, offline-first.

   Signal chain:
     music layers -> musicBus (music volume, feature T21) --\
                                                             >-- masterGain -> compressor -> destination
     sfx voices   -> sfxBus (sfx volume, feature T21) ------/

   Mute is a master switch on top of both buses (SPEC §5, §21).

   Music: 16-step lookahead sequencer (setInterval 25 ms,
   horizon 0.12 s), A-minor / pentatonic, layered per mode
   ('menu' 84 BPM, 'game' 100 BPM, 'boss' 128 BPM).

   Every public call before ensure() is silently ignored;
   no exceptions ever escape this module.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- constants ---------- */

  const TICK_MS = 25;      /* scheduler interval */
  const HORIZON = 0.12;    /* scheduling horizon, seconds */
  const MASTER_VOL = 0.85;
  /* feature T21: per-bus volume defaults (0..1), persisted as
     cs_mvol / cs_svol; music's 0.5 keeps it -6 dB under the SFX */
  const DEFAULT_MUSIC_VOL = 0.5;
  const DEFAULT_SFX_VOL = 0.8;

  /* midi -> Hz */
  const NOTE = function (midi) { return 440 * Math.pow(2, (midi - 69) / 12); };

  /* Chord loop: Am -> F -> C -> G.
     Pad voicings in the octave 2-3 band; bass roots follow the
     SPEC line A1/A1/C2/G1 (F is played over its consonant third
     A1 to keep the low band tight and literal). */
  const PROG = [
    { pad: [45, 48, 52], bass: 33 },  /* Am: A2 C3 E3, bass A1 */
    { pad: [41, 45, 48], bass: 33 },  /* F:  F2 A2 C3, bass A1 */
    { pad: [48, 52, 55], bass: 36 },  /* C:  C3 E3 G3, bass C2 */
    { pad: [43, 47, 50], bass: 31 }   /* G:  G2 B2 D3, bass G1 */
  ];

  /* A-minor pentatonic run, up and down */
  const ARP_SEQ = [57, 60, 62, 64, 67, 69, 67, 64, 62, 60];

  /* Boss tom fill: [start Hz, end Hz] for steps 13/14/15 */
  const TOM_FILL = [[240, 95], [200, 80], [165, 70]];

  /* 16-step bass patterns: 'R' = chord root, 'O' = root + octave */
  const BASS_GAME = ['R', 0, 'R', 0, 'R', 0, 'R', 'R', 'O', 0, 'R', 0, 'R', 0, 'R', 0];
  const BASS_BOSS = ['R', 0, 'R', 'R', 0, 'R', 0, 'R', 'O', 0, 'O', 'O', 0, 'R', 0, 'R'];

  const MODES = {
    menu: {
      bpm: 84,
      padEvery: 2,                   /* chord change every 2 bars */
      bass: null,
      kick: false,
      hat: null,
      tom: false,
      arpMask: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      arpOct: 0,
      arpVel: 0.1,
      arpDur: 0.5                    /* let it ring into the delay */
    },
    game: {
      bpm: 100,
      padEvery: 2,
      bass: BASS_GAME,
      kick: true,
      hat: 'eighth',
      tom: false,
      arpMask: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      arpOct: 0,
      arpVel: 0.12,
      arpDur: 0                      /* 0 = derive from tempo (1/8) */
    },
    boss: {
      bpm: 128,
      padEvery: 1,                   /* chords every bar: faster, meaner */
      bass: BASS_BOSS,
      kick: true,
      hat: '16th',
      tom: true,
      arpMask: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      arpOct: 1,                     /* arp one octave up */
      arpVel: 0.13,
      arpDur: 0                      /* tight 1/16 */
    }
  };

  /* ---------- state ---------- */

  let ctx = null;            /* AudioContext, created on first ensure() */
  let masterGain = null;
  let sfxBus = null;
  let musicBus = null;
  let padGain = null;
  let bassGain = null;
  let kickGain = null;
  let hatGain = null;
  let tomGain = null;
  let arpGain = null;
  let arpDelay = null;       /* 0.23 s feedback delay for the arp */
  let bassCleanIn = null;    /* lowpass input (menu/game bass) */
  let bassDirtyIn = null;    /* waveshaper input (boss bass) */
  let noiseBuf = null;       /* shared white-noise buffer */

  let muted = readMuted();
  /* feature T21: per-bus volumes (0..1); applied at buildGraph() time
     when the values were set before ensure(), live otherwise */
  let musicVol = readVol('cs_mvol', DEFAULT_MUSIC_VOL);
  let sfxVol = readVol('cs_svol', DEFAULT_SFX_VOL);

  let currentMode = null;    /* 'menu' | 'game' | 'boss' | null */
  let timerId = 0;           /* scheduler interval handle */
  let step = 0;              /* 0..15 */
  let bar = 0;               /* increments on step wrap */
  let nextStepTime = 0;
  let arpIdx = 0;
  let padKey = '';           /* identity of the currently sounding pad */
  let activePad = null;      /* { oscs, env } of the ringing pad chord */

  /* ---------- storage ---------- */

  function readMuted() {
    try {
      const raw = window.localStorage.getItem('cs_muted');
      return raw === '1' || raw === 'true';
    } catch (e) {
      return false;
    }
  }

  /* feature T21: a persisted 0..1 volume with a fallback default */
  function readVol(storageKey, fallback) {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null || raw === undefined) return fallback;
      const v = parseFloat(raw);
      if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
    } catch (e) {
      /* storage unavailable: keep the default */
    }
    return fallback;
  }

  function clampVol(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  /* ---------- graph ---------- */

  function layerGain(v) {
    const g = ctx.createGain();
    g.gain.value = v;
    g.connect(musicBus);
    return g;
  }

  function makeDistortionCurve() {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = 2.8;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
  }

  function buildGraph() {
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : MASTER_VOL;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 15;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    masterGain.connect(comp);
    comp.connect(ctx.destination);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = sfxVol; // feature T21
    sfxBus.connect(masterGain);

    musicBus = ctx.createGain();
    musicBus.gain.value = musicVol; // feature T21
    musicBus.connect(masterGain);

    padGain = layerGain(0.4);
    bassGain = layerGain(0.55);
    kickGain = layerGain(0.8);
    hatGain = layerGain(0.5);
    tomGain = layerGain(0.6);
    arpGain = layerGain(0.45);

    /* arp feedback delay: 0.23 s, feedback 0.35 */
    arpDelay = ctx.createDelay(1);
    arpDelay.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    arpDelay.connect(fb);
    fb.connect(arpDelay);
    arpDelay.connect(wet);
    wet.connect(arpGain);

    /* bass: clean lowpass chain + distorted (boss) chain */
    bassCleanIn = ctx.createBiquadFilter();
    bassCleanIn.type = 'lowpass';
    bassCleanIn.frequency.value = 320;
    bassCleanIn.Q.value = 0.8;
    bassCleanIn.connect(bassGain);

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve();
    shaper.oversample = '2x';
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 40;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 950;
    shaper.connect(hp);
    hp.connect(lp);
    lp.connect(bassGain);
    bassDirtyIn = shaper;

    /* shared white-noise buffer (1 s) for hats and SFX */
    const len = Math.floor(ctx.sampleRate);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  /* ---------- voice helpers ---------- */

  /* Disconnect a one-shot chain once its source has finished. */
  function reg(src, nodes) {
    src.onended = function () {
      try { src.disconnect(); } catch (e) { /* already gone */ }
      if (nodes) {
        for (let i = 0; i < nodes.length; i++) {
          try { nodes[i].disconnect(); } catch (e) { /* already gone */ }
        }
      }
    };
  }

  /* Pad: 2 detuned saws per chord voice through one lowpass. */
  function schedPad(t, chord, dur) {
    const boss = currentMode === 'boss';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = boss ? 1500 : 800;
    filter.Q.value = boss ? 1 : 0.7;

    const env = ctx.createGain();
    const level = boss ? 0.085 : 0.075;
    const attack = boss ? 0.1 : 1.4;
    const release = boss ? 0.4 : 1.6;
    const end = t + dur;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(level, t + attack);
    env.gain.setValueAtTime(level, end);
    env.gain.linearRampToValueAtTime(0.0001, end + release);

    filter.connect(env);
    env.connect(padGain);

    const oscs = [];
    const detune = boss ? 12 : 6;
    for (let v = 0; v < chord.length; v++) {
      for (let d = -1; d <= 1; d += 2) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = NOTE(chord[v]);
        o.detune.value = d * detune;
        o.connect(filter);
        o.start(t);
        o.stop(end + release + 0.05);
        oscs.push(o);
      }
    }
    oscs[0].onended = function () {
      try { env.disconnect(); } catch (e) { /* already gone */ }
      try { filter.disconnect(); } catch (e) { /* already gone */ }
    };
    activePad = { oscs: oscs, env: env };
  }

  /* Fade out and stop the ringing pad chord (mode switch / stop). */
  function killPad(fade) {
    if (!activePad) return;
    const p = activePad;
    activePad = null;
    const now = ctx.currentTime;
    try {
      p.env.gain.cancelScheduledValues(now);
      p.env.gain.setValueAtTime(Math.max(p.env.gain.value, 0.0001), now);
      p.env.gain.linearRampToValueAtTime(0.0001, now + fade);
    } catch (e) { /* keep going */ }
    for (let i = 0; i < p.oscs.length; i++) {
      try { p.oscs[i].stop(now + fade + 0.03); } catch (e) { /* stop already set */ }
    }
  }

  function schedBass(t, midi, dur, dirty) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = NOTE(midi);
    const env = ctx.createGain();
    const peak = dirty ? 0.85 : 0.42;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(env);
    env.connect(dirty ? bassDirtyIn : bassCleanIn);
    o.start(t);
    o.stop(t + dur + 0.03);
    reg(o, [env]);
  }

  function schedKick(t) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.9, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(env);
    env.connect(kickGain);
    o.start(t);
    o.stop(t + 0.3);
    reg(o, [env]);
  }

  function schedHat(t, vel) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(vel, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    s.connect(f);
    f.connect(env);
    env.connect(hatGain);
    s.start(t, Math.random() * 0.4);
    s.stop(t + 0.06);
    reg(s, [f, env]);
  }

  function schedTom(t, f0, f1) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(env);
    env.connect(tomGain);
    o.start(t);
    o.stop(t + 0.22);
    reg(o, [env]);
  }

  function schedArp(t, midi, vel, dur) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = NOTE(midi);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(env);
    env.connect(arpGain);   /* dry */
    env.connect(arpDelay);  /* into the feedback delay */
    o.start(t);
    o.stop(t + dur + 0.05);
    reg(o, [env]);
  }

  /* ---------- sequencer ---------- */

  function scheduleStep(stepIdx, t, cfg, sd) {
    const slot = Math.floor(bar / cfg.padEvery) % PROG.length;

    /* pad: retrigger on chord boundaries (step 0 of each chord) */
    if (stepIdx === 0) {
      const key = currentMode + ':' + Math.floor(bar / cfg.padEvery);
      if (key !== padKey) {
        padKey = key;
        killPad(0.15);
        schedPad(t, PROG[slot].pad, cfg.padEvery * 16 * sd - 0.05);
      }
    }

    /* bass line */
    if (cfg.bass) {
      const hit = cfg.bass[stepIdx];
      if (hit) {
        const root = PROG[slot].bass;
        const midi = hit === 'O' ? root + 12 : root;
        const dur = currentMode === 'boss' ? sd * 0.9 : sd * 1.6;
        schedBass(t, midi, dur, currentMode === 'boss');
      }
    }

    /* drums */
    if (cfg.kick && stepIdx % 4 === 0) schedKick(t);
    if (cfg.hat === 'eighth') {
      if (stepIdx % 2 === 0) schedHat(t, stepIdx % 4 === 0 ? 0.2 : 0.12);
    } else if (cfg.hat === '16th') {
      schedHat(t, stepIdx % 2 === 0 ? 0.15 : 0.08);
    }
    if (cfg.tom && stepIdx >= 13) {
      const tf = TOM_FILL[stepIdx - 13];
      schedTom(t, tf[0], tf[1]);
    }

    /* arp through the delay */
    if (cfg.arpMask[stepIdx]) {
      const midi = ARP_SEQ[arpIdx % ARP_SEQ.length] + cfg.arpOct * 12;
      arpIdx++;
      const dur = cfg.arpDur > 0 ? cfg.arpDur : sd * 1.8;
      schedArp(t, midi, cfg.arpVel, dur);
    }
  }

  function tick() {
    if (!ctx || !currentMode) return;
    const cfg = MODES[currentMode];
    if (!cfg) return;
    const sd = 15 / cfg.bpm; /* 60 / bpm / 4 = one 16th note */
    while (nextStepTime < ctx.currentTime + HORIZON) {
      scheduleStep(step, nextStepTime, cfg, sd);
      nextStepTime += sd;
      step = (step + 1) % 16;
      if (step === 0) bar++;
    }
  }

  function stopSequencer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = 0;
    }
    killPad(0.35);
    if (ctx && musicBus) {
      try { musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.06); } catch (e) { /* noop */ }
    }
  }

  /* ---------- sfx primitites ---------- */

  function mkOsc(type, freq, t, stopAt) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.start(t);
    o.stop(stopAt);
    return o;
  }

  function mkGain(t, peak, dur, attack) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + (attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    return g;
  }

  function mkNoise(t, stopAt) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.start(t, Math.random() * 0.4);
    s.stop(stopAt);
    return s;
  }

  function mkFilter(type, freq, t, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.Q.value = q || 1;
    return f;
  }

  /* ---------- sfx voices ---------- */

  const SFX = {
    /* short blip up */
    eat: function (t) {
      const o = mkOsc('square', 500, t, t + 0.14);
      o.frequency.linearRampToValueAtTime(1000, t + 0.07);
      const g = mkGain(t, 0.22, 0.12);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
    },

    /* chord chime */
    bonus: function (t) {
      [81, 84, 88].forEach(function (m, i) {
        const tt = t + i * 0.045;
        const o = mkOsc('triangle', NOTE(m), tt, tt + 0.6);
        const g = mkGain(tt, 0.2, 0.55);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
    },

    /* saw down-sweep + noise crash */
    die: function (t) {
      const o = mkOsc('sawtooth', 400, t, t + 0.65);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.55);
      const g = mkGain(t, 0.4, 0.6);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
      const n = mkNoise(t, t + 0.55);
      const f = mkFilter('lowpass', 3000, t);
      f.frequency.exponentialRampToValueAtTime(180, t + 0.5);
      const ng = mkGain(t, 0.3, 0.5);
      n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
    },

    /* 4-note arpeggio up */
    levelup: function (t) {
      [69, 72, 76, 81].forEach(function (m, i) {
        const tt = t + i * 0.07;
        const dur = i === 3 ? 0.35 : 0.14;
        const o = mkOsc('square', NOTE(m), tt, tt + dur + 0.05);
        const g = mkGain(tt, 0.16, dur);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
    },

    /* two-tone alarm */
    warn: function (t) {
      const o = mkOsc('square', 660, t, t + 0.52);
      o.frequency.setValueAtTime(495, t + 0.12);
      o.frequency.setValueAtTime(660, t + 0.24);
      o.frequency.setValueAtTime(495, t + 0.36);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.01);
      g.gain.setValueAtTime(0.16, t + 0.46);
      g.gain.linearRampToValueAtTime(0.0001, t + 0.52);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
    },

    /* rising ratchet beep, 0.9 s */
    laser_charge: function (t) {
      const o = mkOsc('square', 380, t, t + 0.95);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      const SEG = 9;
      for (let i = 0; i < SEG; i++) {
        const tt = t + i * 0.1;
        const f = 380 * Math.pow(1.19, i);
        o.frequency.setValueAtTime(f, tt);
        o.frequency.linearRampToValueAtTime(f * 1.06, tt + 0.1);
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.linearRampToValueAtTime(i === SEG - 1 ? 0.22 : 0.15, tt + 0.015);
        g.gain.linearRampToValueAtTime(0.06, tt + 0.095);
      }
      g.gain.setValueAtTime(0.06, t + 0.9);
      g.gain.linearRampToValueAtTime(0.0001, t + 0.95);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
    },

    /* harsh beam: saw + highpassed noise, 0.5 s */
    laser_fire: function (t) {
      const o = mkOsc('sawtooth', 120, t, t + 0.55);
      o.frequency.linearRampToValueAtTime(85, t + 0.5);
      const g = mkGain(t, 0.32, 0.5);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
      const n = mkNoise(t, t + 0.55);
      const f = mkFilter('highpass', 900, t);
      const ng = mkGain(t, 0.3, 0.5);
      n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
    },

    /* impact */
    hit: function (t) {
      const o = mkOsc('sine', 200, t, t + 0.2);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.15);
      const g = mkGain(t, 0.45, 0.18);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
      const n = mkNoise(t, t + 0.12);
      const f = mkFilter('bandpass', 800, t);
      const ng = mkGain(t, 0.25, 0.1);
      n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
    },

    /* major fanfare + noise explosion */
    boss_die: function (t) {
      [69, 73, 76].forEach(function (m, i) {
        const tt = t + i * 0.13;
        const dur = i === 2 ? 0.32 : 0.15;
        const o1 = mkOsc('sawtooth', NOTE(m), tt, tt + dur + 0.05);
        const g1 = mkGain(tt, 0.2, dur);
        o1.connect(g1); g1.connect(sfxBus); reg(o1, [g1]);
        const o2 = mkOsc('square', NOTE(m) / 2, tt, tt + dur + 0.05);
        const g2 = mkGain(tt, 0.1, dur);
        o2.connect(g2); g2.connect(sfxBus); reg(o2, [g2]);
      });
      const te = t + 0.42;
      const n = mkNoise(te, te + 0.85);
      const f = mkFilter('lowpass', 5000, te);
      f.frequency.exponentialRampToValueAtTime(150, te + 0.8);
      const ng = mkGain(te, 0.4, 0.8);
      n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
      const sub = mkOsc('sine', 110, te, te + 0.55);
      sub.frequency.exponentialRampToValueAtTime(35, te + 0.5);
      const sg = mkGain(te, 0.4, 0.5);
      sub.connect(sg); sg.connect(sfxBus); reg(sub, [sg]);
    },

    /* UI tick */
    click: function (t) {
      const o = mkOsc('square', 950, t, t + 0.05);
      const g = mkGain(t, 0.1, 0.04);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
    },

    /* two descending notes */
    pause: function (t) {
      [[69, 0, 0.12], [64, 0.11, 0.18]].forEach(function (n) {
        const tt = t + n[1];
        const o = mkOsc('triangle', NOTE(n[0]), tt, tt + n[2] + 0.05);
        const g = mkGain(tt, 0.16, n[2]);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
    },

    /* opening sweep up */
    start: function (t) {
      const o = mkOsc('sawtooth', 110, t, t + 0.5);
      o.frequency.exponentialRampToValueAtTime(440, t + 0.35);
      const f = mkFilter('lowpass', 200, t, 2);
      f.frequency.exponentialRampToValueAtTime(2600, t + 0.4);
      const g = mkGain(t, 0.25, 0.45, 0.01);
      o.connect(f); f.connect(g); g.connect(sfxBus); reg(o, [f, g]);
    },

    /* feature T8: fast major 2-note blip arpeggio */
    pickup: function (t) {
      [[76, 0], [83, 0.07]].forEach(function (n) {
        const tt = t + n[1];
        const dur = n[1] === 0 ? 0.1 : 0.18;
        const o = mkOsc('square', NOTE(n[0]), tt, tt + dur + 0.04);
        const g = mkGain(tt, 0.18, dur);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
    },

    /* feature T8: low minor growl + descending bubbles */
    pickupBad: function (t) {
      const o = mkOsc('sawtooth', 110, t, t + 0.5);
      o.frequency.setValueAtTime(82, t + 0.2);
      o.frequency.setValueAtTime(98, t + 0.3);
      o.frequency.setValueAtTime(70, t + 0.4);
      const f = mkFilter('lowpass', 900, t, 4);
      const g = mkGain(t, 0.3, 0.45, 0.015);
      o.connect(f); f.connect(g); g.connect(sfxBus); reg(o, [f, g]);
      [[0.1, 160, 90], [0.24, 120, 60], [0.34, 95, 45]].forEach(function (b) {
        const tt = t + b[0];
        const ob = mkOsc('sine', b[1], tt, tt + 0.13);
        ob.frequency.exponentialRampToValueAtTime(b[2], tt + 0.11);
        const gb = mkGain(tt, 0.22, 0.12);
        ob.connect(gb); gb.connect(sfxBus); reg(ob, [gb]);
      });
    },

    /* feature T8: warm C-E-G chime */
    life: function (t) {
      [60, 64, 67].forEach(function (m, i) {
        const tt = t + i * 0.09;
        const o = mkOsc('triangle', NOTE(m), tt, tt + 0.72);
        const g = mkGain(tt, 0.2, 0.66);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
    },

    /* feature T8: reboot — power-down sweep, then rise + noise wash */
    respawn: function (t) {
      const o = mkOsc('sawtooth', 600, t, t + 0.72);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.3);
      o.frequency.exponentialRampToValueAtTime(880, t + 0.66);
      const f = mkFilter('lowpass', 2200, t, 2);
      const g = mkGain(t, 0.26, 0.68, 0.01);
      o.connect(f); f.connect(g); g.connect(sfxBus); reg(o, [f, g]);
      const n = mkNoise(t, t + 0.42);
      const nf = mkFilter('lowpass', 3000, t);
      nf.frequency.exponentialRampToValueAtTime(200, t + 0.38);
      const ng = mkGain(t, 0.22, 0.38);
      n.connect(nf); nf.connect(ng); ng.connect(sfxBus); reg(n, [nf, ng]);
    },

    /* feature T9: sharp short laser shot (hunter turret / sys admin) */
    shoot: function (t) {
      const o = mkOsc('sawtooth', 1500, t, t + 0.12);
      o.frequency.exponentialRampToValueAtTime(280, t + 0.1);
      const f = mkFilter('highpass', 420, t);
      const g = mkGain(t, 0.26, 0.11);
      o.connect(f); f.connect(g); g.connect(sfxBus); reg(o, [f, g]);
      const n = mkNoise(t, t + 0.07);
      const nf = mkFilter('bandpass', 3200, t, 2);
      const ng = mkGain(t, 0.14, 0.06);
      n.connect(nf); nf.connect(ng); ng.connect(sfxBus); reg(n, [nf, ng]);
    },

    /* feature T9: icy descending whistle + crystal crackle */
    freeze: function (t) {
      const o = mkOsc('sine', 1900, t, t + 0.55);
      o.frequency.exponentialRampToValueAtTime(240, t + 0.5);
      const g = mkGain(t, 0.24, 0.5, 0.012);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
      const o2 = mkOsc('triangle', 2600, t, t + 0.5);
      o2.frequency.exponentialRampToValueAtTime(500, t + 0.48);
      const g2 = mkGain(t, 0.06, 0.46, 0.012);
      o2.connect(g2); g2.connect(sfxBus); reg(o2, [g2]);
      /* the crackle: a few tight highpassed noise ticks */
      [0.05, 0.13, 0.23, 0.34, 0.45].forEach(function (off) {
        const tt = t + off;
        const n = mkNoise(tt, tt + 0.045);
        const f = mkFilter('highpass', 4200, tt);
        const ng = mkGain(tt, 0.16, 0.04);
        n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
      });
    },

    /* feature T9: low gulp — sine drop with vibrato (the devourer) */
    gulp: function (t) {
      const o = mkOsc('sine', 210, t, t + 0.34);
      o.frequency.exponentialRampToValueAtTime(52, t + 0.3);
      const lfo = mkOsc('sine', 27, t, t + 0.34);
      const depth = ctx.createGain();
      depth.gain.value = 24;
      lfo.connect(depth); depth.connect(o.frequency);
      const g = mkGain(t, 0.42, 0.32, 0.014);
      o.connect(g); g.connect(sfxBus);
      reg(o, [g]); reg(lfo, [depth]);
    },

    /* feature T9: electric cut — saw + noise zap, 0.15 s */
    cut: function (t) {
      const o = mkOsc('sawtooth', 2600, t, t + 0.15);
      o.frequency.exponentialRampToValueAtTime(380, t + 0.13);
      const g = mkGain(t, 0.3, 0.14);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
      const n = mkNoise(t, t + 0.15);
      const f = mkFilter('highpass', 1900, t);
      const ng = mkGain(t, 0.26, 0.13);
      n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
    },

    /* feature T9: drone buzz — square with an LFO, 0.4 s */
    drone: function (t) {
      const o = mkOsc('square', 130, t, t + 0.4);
      const lfo = mkOsc('sine', 17, t, t + 0.4);
      const depth = ctx.createGain();
      depth.gain.value = 42;
      lfo.connect(depth); depth.connect(o.frequency);
      const f = mkFilter('lowpass', 1300, t, 2);
      const g = mkGain(t, 0.15, 0.38, 0.02);
      o.connect(f); f.connect(g); g.connect(sfxBus);
      reg(o, [f, g]); reg(lfo, [depth]);
    },

    /* feature T11: slot machine — 3 fast random-pitch slot blips */
    mystery: function (t) {
      for (let i = 0; i < 3; i++) {
        const tt = t + i * 0.07;
        const midi = 62 + Math.floor(Math.random() * 9) + i * 2;
        const o = mkOsc('square', NOTE(midi), tt, tt + 0.08);
        const g = mkGain(tt, 0.2, 0.07);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      }
    },

    /* feature T11: two-tone alarm sliding down (reversed controls) */
    reverse: function (t) {
      [[720, 0, 0.16], [520, 0.15, 0.3]].forEach(function (n) {
        const tt = t + n[1];
        const o = mkOsc('square', n[0], tt, tt + n[2] + 0.05);
        o.frequency.linearRampToValueAtTime(n[0] * 0.72, tt + n[2]);
        const g = mkGain(tt, 0.19, n[2]);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
    },

    /* feature T11: 5 rising short coin blips (the tail bank payout) */
    bank: function (t) {
      for (let i = 0; i < 5; i++) {
        const tt = t + i * 0.055;
        const midi = 72 + i * 2; // coin ladder up
        const o = mkOsc('square', NOTE(midi), tt, tt + 0.1);
        const g = mkGain(tt, 0.16, 0.09);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
        const o2 = mkOsc('sine', NOTE(midi) * 2, tt, tt + 0.08);
        const g2 = mkGain(tt, 0.06, 0.07);
        o2.connect(g2); g2.connect(sfxBus); reg(o2, [g2]);
      }
    },

    /* feature T11: tearing electric discharge (the split) */
    split: function (t) {
      const o = mkOsc('sawtooth', 1800, t, t + 0.45);
      o.frequency.exponentialRampToValueAtTime(120, t + 0.4);
      const f = mkFilter('bandpass', 2400, t, 3);
      f.frequency.exponentialRampToValueAtTime(300, t + 0.42);
      const g = mkGain(t, 0.32, 0.42, 0.01);
      o.connect(f); f.connect(g); g.connect(sfxBus); reg(o, [f, g]);
      [0.03, 0.12, 0.22, 0.33].forEach(function (off) {
        const tt = t + off;
        const n = mkNoise(tt, tt + 0.06);
        const nf = mkFilter('highpass', 2600, tt);
        const ng = mkGain(tt, 0.18, 0.05);
        n.connect(nf); nf.connect(ng); ng.connect(sfxBus); reg(n, [nf, ng]);
      });
    },

    /* feature T16: achievement fanfare — a solemn C5-E5-G5 triangle
       arpeggio up, each note trailed by a soft octave-up shimmer */
    ach: function (t) {
      [72, 76, 79].forEach(function (m, i) {
        const tt = t + i * 0.12;
        const dur = i === 2 ? 0.5 : 0.2;
        const o = mkOsc('triangle', NOTE(m), tt, tt + dur + 0.05);
        const g = mkGain(tt, 0.24, dur);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
        const sh = mkOsc('sine', NOTE(m) * 2, tt, tt + dur + 0.3);
        const sg = mkGain(tt, 0.05, dur + 0.25, 0.05);
        sh.connect(sg); sg.connect(sfxBus); reg(sh, [sg]);
      });
    }
  };

  /* ---------- public API (SPEC §7) ---------- */

  CS.Audio = {
    /* Create/resume AudioContext on a user gesture; idempotent. */
    ensure: function () {
      try {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return; /* no Web Audio: silent no-op */
          ctx = new AC();
          buildGraph();
        }
        if (ctx.state === 'suspended' && ctx.resume) {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(function () { /* gesture too early */ });
        }
      } catch (e) {
        ctx = null;
      }
    },

    /* 'menu' | 'game' | 'boss' | null (stop). Switching modes is
       instant: the sequencer keeps running, layers and tempo change. */
    music: function (mode) {
      if (!ctx) return; /* before ensure(): ignored */
      if (mode === null || mode === undefined || mode === '') {
        if (currentMode === null) return;
        currentMode = null;
        stopSequencer();
        return;
      }
      if (typeof mode !== 'string' || !MODES[mode]) return; /* unknown: ignored */
      if (mode === currentMode) return;
      currentMode = mode;

      killPad(0.25);
      step = 0;
      bar = 0;
      arpIdx = 0;
      padKey = '';
      const now = ctx.currentTime;
      try { musicBus.gain.setTargetAtTime(musicVol, now, 0.05); } catch (e) { /* noop */ }
      if (timerId) {
        /* already running: land the new mode on the next step */
        nextStepTime = Math.max(nextStepTime, now + 0.03);
      } else {
        nextStepTime = now + 0.06;
        timerId = setInterval(tick, TICK_MS);
      }
    },

    /* Play an SFX by name; unknown names are silently ignored. */
    sfx: function (name) {
      if (!ctx || typeof name !== 'string') return;
      const fn = SFX[name];
      if (!fn) return;
      try {
        fn(ctx.currentTime + 0.01);
      } catch (e) { /* never throw */ }
    },

    /* Mute ramps masterGain to 0; the context keeps running and
       everything keeps being scheduled, just silently. */
    setMuted: function (value) {
      muted = !!value;
      try {
        window.localStorage.setItem('cs_muted', muted ? '1' : '0');
      } catch (e) { /* storage unavailable */ }
      if (ctx && masterGain) {
        try {
          masterGain.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, ctx.currentTime, 0.02);
        } catch (e) { /* noop */ }
      }
    },

    getMuted: function () {
      return muted;
    },

    /* feature T21 (SPEC §21): separate music volume, 0..1. The value
       is remembered even before ensure() and lands on musicBus when
       the context exists; music stopped by music(null) stays silent —
       the bus is re-ramped by the next music() call. Mute stays a
       master switch on top of this. */
    setMusicVol: function (v) {
      musicVol = clampVol(v);
      try {
        window.localStorage.setItem('cs_mvol', String(musicVol));
      } catch (e) { /* storage unavailable */ }
      if (ctx && musicBus && currentMode) {
        try {
          musicBus.gain.setTargetAtTime(musicVol, ctx.currentTime, 0.02);
        } catch (e) { /* noop */ }
      }
    },

    getMusicVol: function () {
      return musicVol;
    },

    /* feature T21 (SPEC §21): separate SFX volume, 0..1 — sfxBus. */
    setSfxVol: function (v) {
      sfxVol = clampVol(v);
      try {
        window.localStorage.setItem('cs_svol', String(sfxVol));
      } catch (e) { /* storage unavailable */ }
      if (ctx && sfxBus) {
        try {
          sfxBus.gain.setTargetAtTime(sfxVol, ctx.currentTime, 0.02);
        } catch (e) { /* noop */ }
      }
    },

    getSfxVol: function () {
      return sfxVol;
    }
  };
})();
