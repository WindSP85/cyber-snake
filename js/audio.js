/* ============================================================
   NEON://SNAKE — audio engine (SPEC §5, §7)
   Pure Web Audio synthesis: no files, no CDN, offline-first.

   Signal chain:
     music layers -> musicBus (music volume, feature T21) --\
                                                             >-- masterGain -> compressor -> destination
     sfx voices   -> sfxBus (sfx volume, feature T21) ------/

   Mute is a master switch on top of both buses (SPEC §5, §21).

   Music (SPEC §26, feature T26): multi-track pattern player.
   A song is {bpm, order, sections}; a section is an array of bars,
   a bar is 16 steps (16th notes) of pad / bass / lead / drum
   material authored as MIDI notes in A minor. The lookahead
   scheduler (setInterval 25 ms, horizon 0.12 s) plans note on/off
   by note length; a mode switch lands on the next bar boundary.
   Hat swing, velocity accents and end-of-section fills keep the
   loop alive: menu "Protocol" 84 BPM, game "Surge" 100 BPM
   (sections A A B A), boss "Protocol Omega" 128 BPM (trill every
   2nd pass).

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

  /* ---------- score data (SPEC §26 — the score is sacred) ----------
     A bar is 16 steps (16th notes). Material is authored per bar:
       pad   — chords {s: step, c: [midi voices], l: length in steps,
               o: optional envelope/timbre overrides (stabs)}
       bass  — notes {s, n: midi, l: length, v?: velocity}
       lead  — notes, same shape as bass
       drums — per-instrument hit lists {s, v} (+f0/f1 sweep for
               toms; oh = open hat)
     A section is an array of bars; song.order cycles the sections
     forever. Everything is MIDI numbers in A minor. */

  function N(s, n, l, v) {
    const o = { s: s, n: n, l: l };
    if (v !== undefined) o.v = v;
    return o;
  }
  function H(s, v) { return { s: s, v: v === undefined ? 1 : v }; }
  function T(s, v, f0, f1) { return { s: s, v: v, f0: f0, f1: f1 }; }
  function C(s, c, l, o) {
    const e = { s: s, c: c, l: l };
    if (o) e.o = o;
    return e;
  }
  /* a run of notes on a fixed step grid */
  function RUN(s, gap, notes, l) {
    const out = [];
    for (let i = 0; i < notes.length; i++) out.push(N(s + i * gap, notes[i], l));
    return out;
  }
  /* repeat a note cell until `total` entries (a full 16th bar) */
  function SEQ(notes, total) {
    const out = [];
    while (out.length < total) out.push.apply(out, notes);
    out.length = total;
    return out;
  }
  function BAR(pad, bass, lead, drums) {
    return { pad: pad || null, bass: bass || null, lead: lead || null, drums: drums || null };
  }
  function DR(kick, snare, hat, oh, tom) {
    return { kick: kick || [], snare: snare || [], hat: hat || [], oh: oh || [], tom: tom || [] };
  }

  /* ----- MENU "Protocol" — 84 BPM, Am9 Fmaj7 Cmaj7 G6, 8 bars ----- */

  const M_AM9 = [57, 60, 64, 67, 71];   /* A3 C4 E4 G4 B4 */
  const M_FMAJ7 = [53, 57, 60, 64, 69]; /* F3 A3 C4 E4 A4 */
  const M_CMAJ7 = [55, 59, 60, 64, 67]; /* G3 B3 C4 E4 G4 */
  const M_G6 = [55, 59, 62, 64, 67];    /* G3 B3 D4 E4 G4 */

  /* pad: half notes; roots: whole notes (A2 F2 C3 G2) */
  function mPad(chord, tail) {
    return tail ? [C(0, chord, 8), C(8, chord, 8)] : [C(0, chord, 8)];
  }
  function mBass(root) { return [N(0, root, 16)]; }

  const MENU_BARS = [
    BAR(mPad(M_AM9, true), mBass(45), null, DR([H(0, 0.8)])),
    BAR(mPad(M_AM9, true), mBass(45), null, DR([H(0, 0.8)], null, [H(8, 0.07)])),
    BAR(mPad(M_FMAJ7, true), mBass(41), RUN(0, 4, [76, 74, 72, 74], 4), DR([H(0, 0.8)])),
    BAR(mPad(M_FMAJ7, true), mBass(41), RUN(0, 4, [72, 69, 67, 69], 4), DR([H(0, 0.8)], null, [H(8, 0.07)])),
    BAR(mPad(M_CMAJ7, true), mBass(48), RUN(0, 4, [67, 69, 71, 72], 4), DR([H(0, 0.8)])),
    BAR(mPad(M_CMAJ7, true), mBass(48), RUN(0, 4, [76, 74, 72, 74], 4), DR([H(0, 0.8)], null, [H(8, 0.07)])),
    BAR(mPad(M_G6, true), mBass(43), [N(0, 69, 4), N(4, 72, 4), N(8, 76, 8)], DR([H(0, 0.8)])),
    /* transition: the pad pauses the last half-bar, the lead holds
       A4-C5-E5 finale and the delay rings into the loop */
    BAR(mPad(M_G6, false), mBass(43), [N(0, 76, 12)], DR([H(0, 0.8)], null, [H(12, 0.05)]))
  ];

  /* ----- GAME "Surge" — 100 BPM, Am F C G; form A A B A ----- */

  const G_PAD = {
    am: [57, 60, 64],
    f: [53, 57, 60, 65],
    c: [55, 60, 64],
    g: [55, 59, 62]
  };
  /* eighth root-octave bass: R R O R R O R O (SPEC §26) */
  function gBass(r) { return RUN(0, 2, [r, r, r + 12, r, r, r + 12, r, r + 12], 2); }

  /* eighth hats with quarter accents + soft swung 16th ghosts */
  const G_HATS = [
    H(0, 0.18), H(2, 0.1), H(3, 0.05), H(4, 0.18), H(6, 0.1), H(7, 0.05),
    H(8, 0.18), H(10, 0.1), H(11, 0.05), H(12, 0.18), H(14, 0.1), H(15, 0.05)
  ];
  const G_DRUMS = DR([H(0), H(4), H(8), H(12)], [H(4, 0.9), H(12, 0.9)], G_HATS);
  /* end-of-section transition: 16th snare roll + open hat */
  const G_FILL = DR(
    [H(0), H(4)],
    [H(4, 0.9), H(12, 0.5), H(13, 0.6), H(14, 0.75), H(15, 0.95)],
    [H(0, 0.18), H(2, 0.1), H(6, 0.1), H(10, 0.1)],
    [H(8, 0.6)]
  );

  /* section A: the SPEC melody, one chord per bar */
  const GAME_SEC_A = { bars: [
    BAR([C(0, G_PAD.am, 16)], gBass(45), RUN(0, 2, [69, 72, 76, 81, 79, 76, 74, 76], 2), G_DRUMS),
    BAR([C(0, G_PAD.f, 16)], gBass(41), RUN(0, 2, [77, 76, 74, 72, 74, 76, 77, 76], 2), G_DRUMS),
    BAR([C(0, G_PAD.c, 16)], gBass(48), RUN(0, 2, [72, 76, 79, 76, 74, 72, 69, 72], 2), G_DRUMS),
    BAR([C(0, G_PAD.g, 16)], gBass(43), RUN(0, 2, [71, 74, 79, 74, 71, 69, 67, 69], 2), G_FILL)
  ] };

  /* section B: the melody an octave down + 16th arp runs in the
     last two bars (bars 7-8 of the A+B pair) */
  const GAME_SEC_B = { bars: [
    BAR([C(0, G_PAD.am, 16)], gBass(45), RUN(0, 2, [57, 60, 64, 69, 67, 64, 62, 64], 2), G_DRUMS),
    BAR([C(0, G_PAD.f, 16)], gBass(41), RUN(0, 2, [65, 64, 62, 60, 62, 64, 65, 64], 2), G_DRUMS),
    BAR([C(0, G_PAD.c, 16)], gBass(48), RUN(0, 1, [72, 74, 76, 79, 81, 79, 76, 74, 72, 74, 76, 79, 81, 79, 76, 74], 1), G_DRUMS),
    BAR([C(0, G_PAD.g, 16)], gBass(43), RUN(0, 1, [62, 64, 67, 69, 71, 74, 76, 79, 81, 79, 76, 74, 71, 69, 67, 64], 1), G_FILL)
  ] };

  /* ----- BOSS "Protocol Omega" — 128 BPM, Am G F E ----- */

  /* staccato fifth stabs on syncopes (root + 7 semitones) */
  function bStabs(root) {
    const fifth = [root + 12, root + 19];
    const o = { a: 0.006, r: 0.12, lvl: 0.09, cut: 1000 };
    return [C(3, fifth, 2, o), C(6, fifth, 2, o), C(11, fifth, 2, o), C(14, fifth, 2, o)];
  }
  function bBass(notes) { return RUN(0, 1, notes, 1); }

  /* 16th riffs; the E bar is chromatic (E F E D# E) */
  const B_RIFF_A = [45, 45, 57, 45, 48, 45, 57, 44]; /* A2 A2 A3 A2 C3 A2 A3 G#2 */
  const B_RIFF_G = [43, 43, 55, 43, 46, 43, 55, 42];
  const B_RIFF_F = [41, 41, 53, 41, 45, 41, 53, 40];
  const B_RIFF_E = [40, 41, 40, 39, 40];

  function bHats(until) {
    const h = [];
    for (let s = 0; s <= until; s++) {
      h.push(H(s, s % 4 === 0 ? 0.12 : (s % 2 === 0 ? 0.07 : 0.045)));
    }
    return h;
  }

  const B_DRUMS = DR(
    [H(0), H(4), H(8), H(12), H(14, 0.7)],
    [H(4, 0.9), H(12, 0.9)],
    bHats(15)
  );
  /* end-of-section: tom fill over steps 13-15 + open hat */
  const B_DRUMS_END = DR(
    [H(0), H(4), H(8)],
    [H(4, 0.9), H(12, 0.9)],
    bHats(11),
    [H(12, 0.5)],
    [T(13, 0.9, 240, 95), T(14, 0.95, 200, 80), T(15, 1, 165, 70)]
  );

  /* the threat motif A5 G5 F5 E5: 16ths, then 8ths */
  const B_MOTIF = [81, 79, 77, 76];
  const B_TRILL = [76, 77];

  const BOSS_SEC_A = { bars: [
    BAR(bStabs(45), bBass(SEQ(B_RIFF_A, 16)), RUN(0, 1, SEQ(B_MOTIF, 16), 1), B_DRUMS),
    BAR(bStabs(43), bBass(SEQ(B_RIFF_G, 16)), RUN(0, 2, SEQ(B_MOTIF, 2), 2), B_DRUMS),
    BAR(bStabs(41), bBass(SEQ(B_RIFF_F, 16)), RUN(0, 1, SEQ(B_MOTIF, 16), 1), B_DRUMS),
    BAR(bStabs(40), bBass(SEQ(B_RIFF_E, 16)),
      [N(0, 81, 2), N(2, 79, 2), N(4, 77, 2), N(6, 76, 2), N(8, 76, 8)], B_DRUMS_END)
  ] };

  /* every 2nd pass the lead answers with the E5-F5 trill */
  const BOSS_SEC_B = { bars: [
    BAR(bStabs(45), bBass(SEQ(B_RIFF_A, 16)), RUN(0, 1, SEQ(B_MOTIF, 16), 1), B_DRUMS),
    BAR(bStabs(43), bBass(SEQ(B_RIFF_G, 16)),
      RUN(0, 2, B_MOTIF, 2).concat(RUN(8, 1, SEQ(B_TRILL, 8), 1)), B_DRUMS),
    BAR(bStabs(41), bBass(SEQ(B_RIFF_F, 16)), RUN(0, 1, SEQ(B_MOTIF, 16), 1), B_DRUMS),
    BAR(bStabs(40), bBass(SEQ(B_RIFF_E, 16)),
      RUN(0, 1, SEQ(B_TRILL, 14), 1).concat([N(14, 76, 2)]), B_DRUMS_END)
  ] };

  const SONGS = {
    menu: {
      bpm: 84,
      swing: 0,
      order: [0],
      sections: [{ bars: MENU_BARS }],
      pad: { att: 0.9, rel: 1.5, lvl: 0.075, cut: 800, det: 6 },
      bass: { timbre: 'soft', vel: 0.5 },
      lead: { timbre: 'menu', vel: 0.22, delay: 0.28 }
    },
    game: {
      bpm: 100,
      swing: 0.008,             /* +8 ms on odd 16ths (hats) */
      order: [0, 0, 1, 0],      /* A A B A */
      sections: [GAME_SEC_A, GAME_SEC_B],
      pad: { att: 0.2, rel: 0.6, lvl: 0.08, cut: 850, det: 6 },
      bass: { timbre: 'clean', vel: 0.42 },
      lead: { timbre: 'game', vel: 0.22, delay: 0.22 }
    },
    boss: {
      bpm: 128,
      swing: 0,
      order: [0, 1],            /* straight pass, trill pass */
      sections: [BOSS_SEC_A, BOSS_SEC_B],
      pad: { att: 0.2, rel: 0.4, lvl: 0.08, cut: 900, det: 8 },
      bass: { timbre: 'dirty', vel: 0.85 },
      lead: { timbre: 'boss', vel: 0.24, delay: 0.26 }
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
  let snareGain = null;
  let hatGain = null;
  let ohGain = null;
  let tomGain = null;
  let leadGain = null;
  let leadDelay = null;      /* feedback delay for the lead (per song) */
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
  let song = null;           /* playing song object (SONGS[mode]) */
  let pendingSong = null;    /* mode key landing on the next bar boundary */
  let orderPos = 0;          /* index into song.order (section cycling) */
  let secBar = 0;            /* current bar within the section */
  let step = 0;              /* 0..15 within the bar */
  let nextStepTime = 0;
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

    /* T26 track mix: pad .35, bass .5, lead .45, drums as before */
    padGain = layerGain(0.35);
    bassGain = layerGain(0.5);
    kickGain = layerGain(0.8);
    snareGain = layerGain(0.5);
    hatGain = layerGain(0.5);
    ohGain = layerGain(0.4);
    tomGain = layerGain(0.6);
    leadGain = layerGain(0.45);

    /* lead feedback delay (0.35); the time itself is per song */
    leadDelay = ctx.createDelay(1);
    leadDelay.delayTime.value = 0.25;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    leadDelay.connect(fb);
    fb.connect(leadDelay);
    leadDelay.connect(wet);
    wet.connect(leadGain);

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

  /* Pad chord: 2 detuned saws per voice through one lowpass, slow
     attack + release tail. Staccato stabs override the envelope. */
  function schedPad(t, chord, dur, o) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = o.cut;
    filter.Q.value = 0.7;

    const env = ctx.createGain();
    const end = t + Math.max(0.08, dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(o.lvl, t + o.att);
    env.gain.setValueAtTime(o.lvl, end);
    env.gain.linearRampToValueAtTime(0.0001, end + o.rel);

    filter.connect(env);
    env.connect(padGain);

    const oscs = [];
    for (let v = 0; v < chord.length; v++) {
      for (let d = -1; d <= 1; d += 2) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = NOTE(chord[v]);
        osc.detune.value = d * o.det;
        osc.connect(filter);
        osc.start(t);
        osc.stop(end + o.rel + 0.05);
        oscs.push(osc);
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

  /* Bass note: timbre per song — 'soft' (sine+triangle, menu),
     'clean' (saw -> lowpass, game) or 'dirty' (saw -> waveshaper). */
  function schedBass(t, midi, dur, timbre, vel) {
    const end = t + Math.max(0.05, dur);
    const env = ctx.createGain();
    const sus = vel * 0.8;
    const susAt = t + Math.min(0.25, Math.max(0.03, dur / 3));
    const relAt = Math.max(susAt + 0.01, end - 0.02);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.012);
    env.gain.linearRampToValueAtTime(sus, susAt);
    env.gain.setValueAtTime(sus, relAt);
    env.gain.linearRampToValueAtTime(0.0001, end + 0.03);

    const stopAt = end + 0.05;
    if (timbre === 'soft') {
      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = NOTE(midi);
      const g1 = ctx.createGain();
      g1.gain.value = 0.65;
      o1.connect(g1);
      g1.connect(env);
      const o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = NOTE(midi);
      const g2 = ctx.createGain();
      g2.gain.value = 0.4;
      o2.connect(g2);
      g2.connect(env);
      env.connect(bassGain);
      o1.start(t); o1.stop(stopAt);
      o2.start(t); o2.stop(stopAt);
      reg(o1, [g1, env]);
      reg(o2, [g2]);
    } else {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = NOTE(midi);
      o.connect(env);
      env.connect(timbre === 'dirty' ? bassDirtyIn : bassCleanIn);
      o.start(t);
      o.stop(stopAt);
      reg(o, [env]);
    }
  }

  function schedKick(t, vel) {
    const v = vel === undefined ? 1 : vel;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.9 * v, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(env);
    env.connect(kickGain);
    o.start(t);
    o.stop(t + 0.3);
    reg(o, [env]);
  }

  /* clap-style snare: bandpassed noise + a short triangle body */
  function schedSnare(t, vel) {
    const v = vel === undefined ? 1 : vel;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    f.Q.value = 0.9;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.55 * v, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    s.connect(f);
    f.connect(env);
    env.connect(snareGain);
    s.start(t, Math.random() * 0.4);
    s.stop(t + 0.14);
    reg(s, [f, env]);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(230, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g);
    g.connect(snareGain);
    o.start(t);
    o.stop(t + 0.08);
    reg(o, [g]);
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

  /* open hat: the same noise, longer decay */
  function schedOh(t, vel) {
    const v = vel === undefined ? 1 : vel;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 5500;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.4 * v, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    s.connect(f);
    f.connect(env);
    env.connect(ohGain);
    s.start(t, Math.random() * 0.4);
    s.stop(t + 0.32);
    reg(s, [f, env]);
  }

  function schedTom(t, f0, f1, vel) {
    const v = vel === undefined ? 1 : vel;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.5 * v, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(env);
    env.connect(tomGain);
    o.start(t);
    o.stop(t + 0.22);
    reg(o, [env]);
  }

  /* Lead note: timbre per song — 'menu' (sine+triangle), 'game'
     (square + light saw unison), 'boss' (saw with a 5.5 Hz / 6-cent
     vibrato). Everything is sent dry + into the feedback delay. */
  function schedLead(t, midi, dur, timbre, vel) {
    const end = t + Math.max(0.06, dur);
    const att = timbre === 'menu' ? 0.02 : 0.008;
    const relAt = Math.max(t + att + 0.01, end - 0.03);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(vel, t + att);
    env.gain.setValueAtTime(vel, relAt);
    env.gain.linearRampToValueAtTime(0.0001, end + 0.05);
    env.connect(leadGain);   /* dry */
    env.connect(leadDelay);  /* into the feedback delay */

    const stopAt = end + 0.1;
    const oscs = [];
    const mixes = [];
    function addOsc(type, lvl, detune) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = NOTE(midi);
      if (detune) o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = lvl;
      o.connect(g);
      g.connect(env);
      o.start(t);
      o.stop(stopAt);
      oscs.push(o);
      mixes.push(g);
      return o;
    }

    let vibOsc = null;
    if (timbre === 'menu') {
      addOsc('sine', 0.6);
      addOsc('triangle', 0.3);
    } else if (timbre === 'game') {
      addOsc('square', 0.5);
      addOsc('sawtooth', 0.16, 7);
    } else {
      vibOsc = addOsc('sawtooth', 0.6);
    }

    for (let i = 1; i < oscs.length; i++) reg(oscs[i], [mixes[i]]);
    reg(oscs[0], [mixes[0], env]);

    if (vibOsc) {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 5.5;
      const depth = ctx.createGain();
      depth.gain.value = 6;   /* cents */
      lfo.connect(depth);
      depth.connect(vibOsc.detune);
      lfo.start(t);
      lfo.stop(stopAt);
      reg(lfo, [depth]);
    }
  }

  /* ---------- sequencer ---------- */

  /* merge a pad entry's overrides over the song defaults */
  function padOpts(o) {
    const d = song.pad;
    return {
      att: o && o.a !== undefined ? o.a : d.att,
      rel: o && o.r !== undefined ? o.r : d.rel,
      lvl: o && o.lvl !== undefined ? o.lvl : d.lvl,
      cut: o && o.cut !== undefined ? o.cut : d.cut,
      det: d.det
    };
  }

  /* downbeat accent: +20% on every quarter-note grid point */
  function accent(vel, st) {
    return st % 4 === 0 ? vel * 1.2 : vel;
  }

  function hitAt(list, st, fn) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].s === st) fn(list[i]);
    }
  }

  function scheduleStep(st, t, sd) {
    const bar = song.sections[song.order[orderPos]].bars[secBar];
    let i, e;

    if (bar.pad) {
      for (i = 0; i < bar.pad.length; i++) {
        e = bar.pad[i];
        if (e.s === st) {
          killPad(0.08);
          schedPad(t, e.c, e.l * sd - 0.04, padOpts(e.o));
        }
      }
    }

    if (bar.bass) {
      for (i = 0; i < bar.bass.length; i++) {
        e = bar.bass[i];
        if (e.s === st) {
          schedBass(t, e.n, e.l * sd, song.bass.timbre,
            accent(e.v !== undefined ? e.v : song.bass.vel, st));
        }
      }
    }

    if (bar.lead) {
      for (i = 0; i < bar.lead.length; i++) {
        e = bar.lead[i];
        if (e.s === st) {
          schedLead(t, e.n, e.l * sd, song.lead.timbre,
            accent(e.v !== undefined ? e.v : song.lead.vel, st));
        }
      }
    }

    if (bar.drums) {
      const d = bar.drums;
      const sw = st % 2 === 1 ? song.swing : 0; /* hat swing on odd 16ths */
      hitAt(d.kick, st, function (h) { schedKick(t, h.v); });
      hitAt(d.snare, st, function (h) { schedSnare(t, h.v); });
      hitAt(d.tom, st, function (h) { schedTom(t, h.f0, h.f1, h.v); });
      hitAt(d.oh, st, function (h) { schedOh(t + sw, h.v); });
      hitAt(d.hat, st, function (h) { schedHat(t + sw, h.v); });
    }
  }

  function advanceBar() {
    secBar++;
    if (secBar >= song.sections[song.order[orderPos]].bars.length) {
      secBar = 0;
      orderPos = (orderPos + 1) % song.order.length;
    }
    if (pendingSong) {
      const mode = pendingSong;
      pendingSong = null;
      applySong(mode); /* the new song starts exactly on the bar */
    }
  }

  function tick() {
    if (!ctx || !song) return;
    const sd = 15 / song.bpm; /* 60 / bpm / 4 = one 16th */
    while (nextStepTime < ctx.currentTime + HORIZON) {
      scheduleStep(step, nextStepTime, sd);
      nextStepTime += sd;
      step++;
      if (step === 16) {
        step = 0;
        advanceBar();
      }
    }
  }

  function applySong(mode) {
    song = SONGS[mode];
    orderPos = 0;
    secBar = 0;
    step = 0;
    killPad(0.2);
    try {
      leadDelay.delayTime.setTargetAtTime(song.lead.delay, ctx.currentTime, 0.05);
    } catch (e) { /* keep the previous delay time */ }
  }

  function stopSequencer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = 0;
    }
    song = null;
    pendingSong = null;
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
    },

    /* feature T23 (SPEC §22): duel countdown beep — one clean blip */
    duelCount: function (t) {
      const o = mkOsc('square', 620, t, t + 0.12);
      const g = mkGain(t, 0.2, 0.1);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
    },

    /* feature T23: duel start — two rising notes + a noise snap */
    duelGo: function (t) {
      [[55, 0, 0.1], [67, 0.1, 0.26]].forEach(function (n) {
        const tt = t + n[1];
        const o = mkOsc('square', NOTE(n[0]), tt, tt + n[2] + 0.05);
        const g = mkGain(tt, 0.22, n[2]);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
      const n2 = mkNoise(t + 0.1, t + 0.3);
      const f = mkFilter('highpass', 3000, t + 0.1);
      const ng = mkGain(t + 0.1, 0.12, 0.18);
      n2.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n2, [f, ng]);
    },

    /* feature T23: match victory fanfare — a 5-note major ladder,
       every note trailed by a soft octave-up shimmer */
    duelWin: function (t) {
      [60, 64, 67, 72, 76].forEach(function (m, i) {
        const tt = t + i * 0.11;
        const dur = i === 4 ? 0.6 : 0.16;
        const o = mkOsc('square', NOTE(m), tt, tt + dur + 0.05);
        const g = mkGain(tt, 0.2, dur);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
        const sh = mkOsc('sine', NOTE(m) * 2, tt, tt + dur + 0.2);
        const sg = mkGain(tt, 0.05, dur + 0.15, 0.04);
        sh.connect(sg); sg.connect(sfxBus); reg(sh, [sg]);
      });
    },

    /* feature T23: match defeat — two sinking saws + a sub drop */
    duelLose: function (t) {
      [[57, 0, 0.3], [50, 0.28, 0.6]].forEach(function (n) {
        const tt = t + n[1];
        const o = mkOsc('sawtooth', NOTE(n[0]), tt, tt + n[2] + 0.05);
        o.frequency.linearRampToValueAtTime(NOTE(n[0]) * 0.94, tt + n[2]);
        const g = mkGain(tt, 0.2, n[2]);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
      });
      const sub = mkOsc('sine', 110, t + 0.28, t + 0.95);
      sub.frequency.exponentialRampToValueAtTime(38, t + 0.9);
      const sg = mkGain(t + 0.28, 0.35, 0.62);
      sub.connect(sg); sg.connect(sfxBus); reg(sub, [sg]);
    },

    /* feature T23: body bite — a noise crunch + a falling zap */
    duelBite: function (t) {
      const n = mkNoise(t, t + 0.2);
      const f = mkFilter('bandpass', 2400, t, 1.6);
      f.frequency.exponentialRampToValueAtTime(300, t + 0.18);
      const ng = mkGain(t, 0.34, 0.18);
      n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
      const o = mkOsc('square', 900, t, t + 0.16);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.14);
      const g = mkGain(t, 0.22, 0.15);
      o.connect(g); g.connect(sfxBus); reg(o, [g]);
    },

    /* feature T23: the noose — three tightening ticks + a low thud */
    duelTrap: function (t) {
      [0, 0.12, 0.24].forEach(function (off, i) {
        const tt = t + off;
        const o = mkOsc('square', 300 + i * 190, tt, tt + 0.09);
        const g = mkGain(tt, 0.2, 0.08);
        o.connect(g); g.connect(sfxBus); reg(o, [g]);
        const n = mkNoise(tt, tt + 0.07);
        const f = mkFilter('bandpass', 900 + i * 700, tt, 2.4);
        const ng = mkGain(tt, 0.14, 0.06);
        n.connect(f); f.connect(ng); ng.connect(sfxBus); reg(n, [f, ng]);
      });
      const sub = mkOsc('sine', 130, t + 0.3, t + 0.75);
      sub.frequency.exponentialRampToValueAtTime(45, t + 0.7);
      const sg = mkGain(t + 0.3, 0.32, 0.4);
      sub.connect(sg); sg.connect(sfxBus); reg(sub, [sg]);
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

    /* 'menu' | 'game' | 'boss' | null (stop). While playing, the new
       song lands on the next bar boundary (the scheduler itself keeps
       running); a fresh start begins immediately. */
    music: function (mode) {
      if (!ctx) return; /* before ensure(): ignored */
      if (mode === null || mode === undefined || mode === '') {
        if (currentMode === null) return;
        currentMode = null;
        stopSequencer();
        return;
      }
      if (typeof mode !== 'string' || !SONGS[mode]) return; /* unknown: ignored */
      if (mode === currentMode) return;
      currentMode = mode;
      const now = ctx.currentTime;
      try { musicBus.gain.setTargetAtTime(musicVol, now, 0.05); } catch (e) { /* noop */ }
      if (timerId) {
        /* already running: swap the song on the next bar boundary */
        pendingSong = mode;
      } else {
        applySong(mode);
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
