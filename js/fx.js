/* ============================================================
   NEON://SNAKE — FX layer (SPEC §7)
   Neon particles, screen shake, band glitch, fullscreen flash.

   CS.FX.draw() runs on top of the scene in logical canvas pixels —
   GRID_W*CELL x GRID_H*CELL (game.js scales the context for
   devicePixelRatio and reports the live size via setSize, T13).
   Screen shake translates the whole canvas element via CSS:
   the entire scene trembles while the context transform set
   by game.js stays intact; without a DOM (headless) it is a
   silent no-op. Every method is safe on empty/invalid state.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- tuning ---------- */

  let width = 900;                  // logical canvas size, px (T13: setSize)
  let height = 600;

  const DEFAULT_COUNT = 10;         // burst() particle fallback
  const MAX_PARTICLES = 600;        // hard cap against unbounded growth
  const SPEED_MIN = 60;             // burst speed range, px/s
  const SPEED_MAX = 260;
  const LIFE_MIN = 0.4;             // particle lifetime range, s
  const LIFE_MAX = 0.9;
  const SPEED_DAMP = 2.6;           // exponential velocity damping, 1/s
  const SIZE_MIN = 1.6;             // particle radius, px
  const SIZE_MAX = 3.4;

  const SHAKE_TAU = 0.115;          // decay constant: settles in ~0.4 s
  const SHAKE_FLOOR = 0.15;         // below this the shake is over, px
  const SHAKE_CAP = 24;             // max shake amplitude, px

  const BANDS_MIN = 6;              // glitch horizontal bands per frame
  const BANDS_MAX = 10;
  const BAND_H_MIN = 3;             // band height, px
  const BAND_H_MAX = 18;
  const BAND_SHIFT = 16;            // max band horizontal shift, px
  const GLITCH_CAP = 3;             // max glitch duration, s

  const FLASH_ALPHA = 0.5;          // flash peak opacity
  const FLASH_DEFAULT = 0.2;        // fallback flash duration, s
  const FLASH_CAP = 2;              // max flash duration, s

  /* ---------- PERF: baked glow sprites ----------
     shadowBlur in a per-particle loop is the single most expensive
     thing on weak phones. Every glow is therefore baked ONCE into a
     tiny offscreen canvas and blitted with drawImage:
     - particle sprites ('p|color|r'): the exact dot the inline
       arc+shadowBlur used to draw, core radius quantized to 1 px;
     - glow sprites ('g|color|blur'): a soft halo blob for anything
       pulsing behind a shape (food, pickups, boss shots) — the pulse
     is done by stretching the blit, never by re-blurring.
     One LRU map, capped at 64 entries. */

  const SPRITE_MAX = 64;            // LRU cap on baked sprites
  const P_GLOW = 6;                 // particle halo strength (the old inline blur)
  const P_PAD = 9;                  // particle halo reach beyond the core, px
  const G_CORE = 0.4;               // glow blob core disk : blur ratio
  const G_REACH = 2.0;              // glow blob radius : blur ratio

  const spriteCache = new Map();    // key -> canvas (insertion order = LRU)

  function cacheGet(key) {
    const cv = spriteCache.get(key);
    if (cv !== undefined) {         // refresh the LRU recency
      spriteCache.delete(key);
      spriteCache.set(key, cv);
    }
    return cv;
  }

  function cachePut(key, cv) {
    if (spriteCache.has(key)) spriteCache.delete(key);
    spriteCache.set(key, cv);
    if (spriteCache.size > SPRITE_MAX) {
      spriteCache.delete(spriteCache.keys().next().value);
    }
    return cv;
  }

  function mkCanvas(w, h) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    return cv;
  }

  /* one baked glowing dot: a core of radius r (quantized to 1 px)
     plus the same 6 px halo the inline shadowBlur used to draw */
  function particleSprite(color, r) {
    const rq = Math.max(1, Math.round(r));
    const key = 'p|' + color + '|' + rq;
    let cv = cacheGet(key);
    if (cv !== undefined) return cv;
    const R = rq + P_PAD;
    cv = mkCanvas(R * 2, R * 2);
    if (!cv) return null;
    const c = cv.getContext('2d');
    if (!c) return null;
    c.shadowColor = color;
    c.shadowBlur = P_GLOW;
    c.fillStyle = color;
    c.beginPath();
    c.arc(R, R, rq, 0, Math.PI * 2);
    c.fill();
    return cachePut(key, cv);
  }

  /* one baked halo blob: what shadowBlur casts around a compact
     shape. The caller draws its crisp vector shape on top and pulls
     the glow wider/narrower via the blit size — no per-frame blur. */
  function glowSprite(color, blur) {
    const b = Math.max(2, Math.round(blur));
    const key = 'g|' + color + '|' + b;
    let cv = cacheGet(key);
    if (cv !== undefined) return cv;
    const R = Math.ceil(b * G_REACH);
    cv = mkCanvas(R * 2, R * 2);
    if (!cv) return null;
    const c = cv.getContext('2d');
    if (!c) return null;
    c.shadowColor = color;
    c.shadowBlur = b;
    c.fillStyle = color;
    c.beginPath();
    c.arc(R, R, Math.max(1, b * G_CORE), 0, Math.PI * 2);
    c.fill();
    return cachePut(key, cv);
  }

  /* ---------- state ---------- */

  let particles = [];               // {x,y,vx,vy,life,maxLife,size,color,streak}
  let shakePower = 0;               // current amplitude, px
  let glitchLeft = 0;               // glitch time remaining, s
  let glitchTotal = 0;              // glitch initial duration (intensity ref)
  let flashLeft = 0;                // flash time remaining, s
  let flashTotal = 0;
  let flashColor = '#ffffff';
  let shakeX = 0;                   // last shake offset written to the canvas
  let shakeY = 0;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* Screen shake = CSS translate of the whole canvas element. The
     style is written only when the offset actually changes. */
  function applyShake(dx, dy) {
    if (dx === shakeX && dy === shakeY) return;
    shakeX = dx;
    shakeY = dy;
    if (typeof document === 'undefined' || !document.getElementById) return;
    const el = document.getElementById('game-canvas');
    if (!el || !el.style) return;
    el.style.transform = (dx === 0 && dy === 0)
      ? ''
      : 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px)';
  }

  /* ---------- draw parts ---------- */

  function drawFlash(g) {
    if (flashLeft <= 0) return;
    const k = clamp01(flashLeft / (flashTotal || 1));
    g.save();
    g.globalAlpha = FLASH_ALPHA * k * k;   // fast fade towards the end
    g.fillStyle = flashColor;
    g.fillRect(0, 0, width, height);
    g.restore();
  }

  function drawParticles(g) {
    if (!particles.length) return;
    g.save();
    g.globalCompositeOperation = 'lighter';  // additive neon blending
    g.lineCap = 'round';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const k = clamp01(p.life / p.maxLife);
      g.globalAlpha = k;
      if (p.streak) {
        // moving spark: a short dash along its own velocity
        // (streaks are cheap — no glow on purpose)
        g.shadowBlur = 0;
        g.strokeStyle = p.color;
        g.lineWidth = p.size * 0.8;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05);
        g.stroke();
      } else {
        // glowing dot, shrinking as it dies — PERF: the dot+halo is
        // baked once per color+size and blitted (no shadowBlur here)
        const spr = particleSprite(p.color, p.size * (0.4 + 0.6 * k));
        if (spr) {
          g.drawImage(spr, p.x - spr.width / 2, p.y - spr.height / 2);
        } else {
          // no offscreen canvases (canvasless env): the original glow
          g.shadowColor = p.color;
          g.shadowBlur = 6;
          g.fillStyle = p.color;
          g.beginPath();
          g.arc(p.x, p.y, p.size * (0.4 + 0.6 * k), 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    g.restore();
  }

  /* RGB-split feel without pixel copying: translucent magenta/cyan
     bands shifted sideways + random vertical tear strokes. The
     intensity follows the remaining time and fades out by the end. */
  function drawGlitch(g) {
    if (glitchLeft <= 0) return;
    const inten = clamp01(glitchLeft / (glitchTotal || 1));
    g.save();
    const bands = BANDS_MIN + Math.floor(Math.random() * (BANDS_MAX - BANDS_MIN + 1));
    for (let i = 0; i < bands; i++) {
      const bh = BAND_H_MIN + Math.random() * (BAND_H_MAX - BAND_H_MIN);
      const by = Math.random() * (height - bh);
      const shift = (Math.random() * 2 - 1) * BAND_SHIFT * inten;
      g.globalAlpha = 0.05 + 0.11 * Math.random() * inten;
      g.fillStyle = '#00f0ff';
      g.fillRect(shift, by, width, bh);
      g.fillStyle = '#ff2bd6';
      g.fillRect(-shift, by, width, bh);
    }
    const strokes = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < strokes; i++) {
      g.globalAlpha = 0.1 + 0.3 * Math.random() * inten;
      g.fillStyle = Math.random() < 0.5 ? '#00f0ff' : '#ff2bd6';
      g.fillRect(
        Math.random() * width,
        Math.random() * height,
        1 + Math.random() * 1.5,
        8 + Math.random() * 40
      );
    }
    g.restore();
  }

  /* ---------- public API (SPEC §7) ---------- */

  CS.FX = {
    /* Feature T13: the arena size follows the live grid — game.js
       calls this on boot and on every grid change. */
    setSize: function (w, h) {
      const w2 = Math.round(Number(w));
      const h2 = Math.round(Number(h));
      if (isFinite(w2) && w2 > 0) width = w2;
      if (isFinite(h2) && h2 > 0) height = h2;
    },

    /* Advance every live effect. Dead particles are compacted
       in place: no leaks, no reallocations for the survivors. */
    update: function (dt) {
      let d = Number(dt);
      if (!isFinite(d) || d < 0) d = 0;

      if (particles.length) {
        const damp = Math.exp(-SPEED_DAMP * d);
        let alive = 0;
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          p.life -= d;
          if (p.life <= 0) continue;
          p.vx *= damp;
          p.vy *= damp;
          p.x += p.vx * d;
          p.y += p.vy * d;
          particles[alive++] = p;
        }
        particles.length = alive;
      }

      if (shakePower > 0) {
        shakePower *= Math.exp(-d / SHAKE_TAU);
        if (shakePower < SHAKE_FLOOR) shakePower = 0;
      }
      if (glitchLeft > 0) glitchLeft -= d;
      if (flashLeft > 0) flashLeft -= d;
    },

    /* Overlay pass on top of the scene: flash veil, particles,
       then glitch (the freshest corruption sits above everything). */
    draw: function (g) {
      if (!g) return;
      if (shakePower > 0) {
        const a = Math.random() * Math.PI * 2;
        const amp = shakePower * (0.4 + Math.random() * 0.6);
        applyShake(Math.cos(a) * amp, Math.sin(a) * amp);
      } else {
        applyShake(0, 0);
      }
      drawFlash(g);
      drawParticles(g);
      drawGlitch(g);
    },

    /* PERF: soft halo behind a shape, baked once per color+blur and
       stretched over w x h centered at (cx, cy). Pulsing = passing a
       wider/narrower rect — the shadowBlur stays out of the hot path
       (game.js food/pickups, bosses.js shots, duel.js packets). */
    drawGlow: function (g, cx, cy, w, h, color, blur) {
      if (!g) return;
      const spr = glowSprite(color, blur);
      if (!spr) return;
      g.drawImage(spr, cx - w / 2, cy - h / 2, w, h);
    },

    /* QA: how many baked sprites are alive right now (LRU <= 64) */
    spriteCacheSize: function () {
      return spriteCache.size;
    },

    /* Particle burst at pixel coordinates; n defaults to 10.
       The oldest particles are dropped when the cap is reached. */
    burst: function (px, py, color, n) {
      let count = (n === undefined || n === null) ? DEFAULT_COUNT : Math.floor(Number(n));
      if (!isFinite(count) || count <= 0) return;
      if (particles.length + count > MAX_PARTICLES) {
        particles.splice(0, particles.length + count - MAX_PARTICLES);
      }
      const col = (typeof color === 'string' && color) ? color : '#00f0ff';
      const x0 = isFinite(px) ? px : width / 2;
      const y0 = isFinite(py) ? py : height / 2;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
        const life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
        particles.push({
          x: x0,
          y: y0,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: life,
          maxLife: life,
          size: SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN),
          color: col,
          streak: Math.random() < 0.35
        });
      }
    },

    /* Kick the screen shake; only a stronger hit overrides the
       amplitude currently in flight. Decays in ~0.4 s. */
    shake: function (power) {
      const p = Number(power);
      if (!isFinite(p) || p <= 0) return;
      if (p > shakePower) shakePower = Math.min(p, SHAKE_CAP);
    },

    /* Band glitch for the next `sec` seconds; a longer request
       restarts the intensity ramp, a shorter one is ignored. */
    glitch: function (sec) {
      const t = Number(sec);
      if (!isFinite(t) || t <= 0) return;
      const capped = Math.min(t, GLITCH_CAP);
      if (capped > glitchLeft) {
        glitchLeft = capped;
        glitchTotal = capped;
      }
    },

    /* Fullscreen color veil with a fast fade over `sec` seconds. */
    flash: function (color, sec) {
      const t = Number(sec);
      const dur = (isFinite(t) && t > 0) ? Math.min(t, FLASH_CAP) : FLASH_DEFAULT;
      flashColor = (typeof color === 'string' && color) ? color : '#ffffff';
      flashLeft = dur;
      flashTotal = dur;
    }
  };
})();
