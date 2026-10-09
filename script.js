(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  clearTimeout(window.__boot);   // we are running; cancel the plain-page fallback
  // The name normally waits for the grain's first frame. Never let it wait long.
  setTimeout(() => root.classList.add('is-live'), 5000);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Shared pointer state: the grain and the cursor both read it.
  const ptr = { x: 0, y: 0, lx: 0, ly: 0, vx: 0, vy: 0, t: -1e9, seen: false };
  addEventListener('pointermove', e => {
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = performance.now();
    if (!ptr.seen) { ptr.lx = ptr.x; ptr.ly = ptr.y; ptr.seen = true; }
  }, { passive: true });

  /* =====================================================================
     Grain
     A fixed scatter of specks. Each speck has a random threshold and is lit
     when the landscape's density at its position is above that threshold,
     so the form is drawn by which specks are on. Density runs on the GPU;
     the cursor pushing specks around is a small spring simulation here.
     ===================================================================== */
  const VERT = `
    precision highp float;
    attribute vec2 aHome;
    attribute vec2 aOff;
    attribute vec4 aSeed;   // threshold, phase, scatter angle, scatter distance
    attribute float aPaw;
    attribute vec4 aPawPos; // where this speck sits in the intro paw print; z is how near the outline, w the way out
    uniform vec2 uRes;
    uniform float uDpr, uTime, uGather, uSpread, uPawGain, uScroll, uPan, uDim, uPaw;
    varying float vAlpha;

    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    float noise(float x) {
      float i = floor(x), f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(hash(i), hash(i + 1.0), f);
    }
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float noise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
                 mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    // Ridge profile. x runs along the ridge; m is a second axis the page scroll
    // moves through, so the same ridge reshapes itself instead of just sliding.
    float profile(float x, float m) {
      return noise2(vec2(x, m)) * 0.62 + noise2(vec2(x * 2.13 + 17.0, m + 5.0)) * 0.27 + noise2(vec2(x * 4.7 + 41.0, m + 11.0)) * 0.11;
    }

    const int K = 3;

    void main() {
      vec2 uv = aHome / uRes;
      float aspect = uRes.x / uRes.y;
      float x = uv.x * aspect;

      // Loose dust in the sky.
      float d = 0.012 * smoothstep(0.0, 0.35, uv.y);

      // Ridges, far to near. Each has a hard bright crest and a soft slope
      // that falls into shadow before the next crest starts.
      for (int k = 0; k < K; k++) {
        float fk = float(k) / float(K - 1);
        float drift = uTime * mix(0.005, 0.013, fk) + uPan * mix(0.04, 0.2, fk);
        // Scrolling reshapes the land: each ridge morphs, the slope of the whole
        // scene swings over, and the ridges grow, shrink and change spacing.
        // Every scroll term is zero at the top, so they only kick in once you scroll.
        float kk = float(k);
        float morph = uScroll * mix(0.4, 0.6, fk) + kk * 7.3;
        float tilt = 0.22 * cos(uScroll * 0.7);
        float base = mix(0.25, 0.52, fk) + (uv.x - 0.5) * tilt
                   - uScroll * mix(0.01, 0.035, fk)
                   + 0.06 * sin(uScroll * 0.8) * sin(kk * 2.4 + 1.0);
        float amp = mix(0.06, 0.15, fk) * (1.0 + 0.4 * sin(uScroll * 0.9) * cos(kk * 2.0));
        float freq = mix(2.1, 1.0, fk);
        float ridge = base + amp * (profile(x * freq + kk * 13.7 + drift, morph) - 0.5) * 2.0;
        float below = uv.y - ridge;
        if (below > 0.0) {
          float light = 0.1 + 0.9 * smoothstep(0.25, 0.75, noise(x * 0.8 + kk * 5.1 - drift * 1.4 + uScroll * 0.5));
          float slope = 0.42 * exp(-below / 0.012) + 0.58 * exp(-below / mix(0.06, 0.15, fk));
          // Faint ripples running down the slope, like wind marks in sand.
          float ripple = 0.8 + 0.2 * sin(below * 210.0 + noise(x * 2.3 + float(k) * 3.0) * 6.0 - uTime * 0.12);
          d = mix(0.55, 1.0, fk) * light * slope * mix(1.0, ripple, smoothstep(0.0, 0.03, below));
        }
      }

      // Keep the corner behind the name clear on the home screen.
      vec2 q = vec2(uv.x / mix(2.0, 0.9, smoothstep(0.7, 1.3, aspect)), (1.0 - uv.y) / 0.5);
      float corner = smoothstep(0.6, 1.1, length(q));
      d *= mix(corner, 1.0, clamp(uScroll * 2.0, 0.0, 1.0));
      d *= 1.0 - smoothstep(0.78, 1.0, uv.y) * 0.85;

      d = mix(d, aPaw, uPaw);

      float a = smoothstep(aSeed.x, aSeed.x + 0.08, d);
      a *= 0.82 + 0.18 * sin(uTime * (0.5 + aSeed.y * 1.6) + aSeed.y * 50.0);
      a *= mix(0.6, 1.0, fract(aSeed.y * 7.31));

      // Intro, part one: every speck flies in and lands inside a paw print.
      float g = clamp(uGather * 1.6 - aSeed.y * 0.6, 0.0, 1.0);
      g = 1.0 - pow(1.0 - g, 3.0);
      float ang = aSeed.z + (1.0 - g) * 1.6;
      vec2 from = aPawPos.xy + vec2(cos(ang), sin(ang)) * aSeed.w * (1.0 - g);
      // Part two: the paw lets go and each speck swings out to its own place.
      float s = clamp(uSpread * 1.5 - fract(aSeed.y * 13.7) * 0.5, 0.0, 1.0);
      s = s * s * (3.0 - 2.0 * s);
      vec2 way = aHome - aPawPos.xy;
      vec2 swing = vec2(-way.y, way.x) * sin(3.14159 * s) * mix(0.08, 0.26, fract(aSeed.x * 37.0));
      // While the paw is held, its outline breathes. Neighbouring specks ride
      // the same slow field, so the edge swells and drifts as one soft shape
      // instead of each speck twitching alone, and the motion thins out toward
      // the middle. It fades in as each speck lands and out as it lets go.
      float soft = aPawPos.z * pow(g, 6.0) * (1.0 - s);
      vec2 p = mix(from, aHome, s) + swing + aOff;
      // Once the paw has let go every speck's share is zero, so skip the noise.
      if (uSpread < 1.0 && soft > 0.0) {
        float unit = min(uRes.x, uRes.y);
        vec2 q = aPawPos.xy / unit * 7.0;
        float t = uTime * 0.3;
        // In and out along the outline, a different amount at each stretch of
        // it, so the paw never grows or shrinks as a whole.
        float breath = noise2(q * 0.5 + vec2(-t * 1.3, t * 1.3 + 23.0)) - 0.5;
        vec2 flow = vec2(noise2(q + vec2(t, 3.0)), noise2(q + vec2(11.0, -t))) - 0.5;
        p += (vec2(cos(aPawPos.w), sin(aPawPos.w)) * breath + flow * 0.6) * soft * unit * 0.005;
        a *= 1.0 - 0.14 * soft * noise2(q * 1.4 + vec2(t * 1.2 + 41.0, 7.0));
      }

      vAlpha = a * g * mix(uPawGain, 1.0, s) * uDim;
      vec2 clip = p / uRes * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      gl_PointSize = max(1.0, uDpr * mix(0.7, 1.3, fract(aSeed.x * 91.7)));
    }`;

  const FRAG = `
    precision mediump float;
    varying float vAlpha;
    void main() { gl_FragColor = vec4(vec3(0.93), vAlpha); }`;

  function createGrain() {
    const canvas = $('#grain');
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) { canvas.remove(); return null; }

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    try {
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (err) { console.warn(err); canvas.remove(); return null; }
    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(10 / 255, 10 / 255, 10 / 255, 1);

    const U = {};
    ['uRes', 'uDpr', 'uTime', 'uGather', 'uSpread', 'uPawGain', 'uScroll', 'uPan', 'uDim', 'uPaw'].forEach(n => U[n] = gl.getUniformLocation(prog, n));
    const attr = (name, size) => {
      const buf = gl.createBuffer(), loc = gl.getAttribLocation(prog, name);
      return { buf, loc, size };
    };
    const A = { home: attr('aHome', 2), off: attr('aOff', 2), seed: attr('aSeed', 4), paw: attr('aPaw', 1), pawPos: attr('aPawPos', 4) };
    const upload = (a, data, usage) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    };

    let W = 0, H = 0, dpr = 1, N = 0;
    let home, off, vel, live, liveCount = 0;

    // One paw drawing feeds two things: a per-speck brightness mask (the easter
    // egg lights specks where they already are) and a per-speck landing spot
    // inside the paw (the intro moves specks there, then releases them).
    function pawData() {
      const s = 0.5, w = Math.ceil(W * s), h = Math.ceil(H * s);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const size = Math.min(W, H) * 0.5 * s, k = size / 64;
      ctx.translate(w / 2 - size / 2, h * 0.45 - size / 2);
      ctx.scale(k, k);
      const g = ctx.createLinearGradient(0, 4, 0, 58);
      g.addColorStop(0, 'rgba(255,255,255,.98)');
      g.addColorStop(1, 'rgba(255,255,255,.5)');
      ctx.fillStyle = g;
      [[14, 26, 6, 8, -20], [26, 14, 6.5, 9, -8], [40, 14, 6.5, 9, 8], [52, 26, 6, 8, 20]].forEach(([x, y, rx, ry, r]) => {
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, r * Math.PI / 180, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fill(new Path2D('M32 30C22 30 14 40 14 48c0 7 6 10 11 8 4-1.5 10-1.5 14 0 5 2 11-1 11-8 0-8-8-18-18-18z'));
      const px = ctx.getImageData(0, 0, w, h).data;

      const mask = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = Math.min(w - 1, home[i * 2] * s | 0), y = Math.min(h - 1, home[i * 2 + 1] * s | 0);
        mask[i] = px[(y * w + x) * 4 + 3] / 255;
      }

      const inside = [];
      let weight = 0;
      for (let p = 0; p < w * h; p++) {
        const a = px[p * 4 + 3];
        if (a > 8) { inside.push(p); weight += a / 255; }
      }
      // How far each pixel of the paw is from its outline, in two sweeps over
      // the drawing: down-right, then back up-left, each passing on the nearest
      // distance found so far.
      const dist = new Float32Array(w * h), D = Math.SQRT2;
      for (const p of inside) dist[p] = 1e9;
      for (let y = 1; y < h; y++) for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (dist[p]) dist[p] = Math.min(dist[p], dist[p - 1] + 1, dist[p - w] + 1, dist[p - w - 1] + D, dist[p - w + 1] + D);
      }
      for (let y = h - 2; y >= 0; y--) for (let x = w - 2; x > 0; x--) {
        const p = y * w + x;
        if (dist[p]) dist[p] = Math.min(dist[p], dist[p + 1] + 1, dist[p + w] + 1, dist[p + w + 1] + D, dist[p + w - 1] + D);
      }
      // x, y, how close the spot is to the outline (1 on the edge, easing to 0
      // well inside, a little uneven from speck to speck so no band shows), and
      // the direction that leads straight out of the paw.
      const pos = new Float32Array(N * 4);
      const reach = Math.max(4, k * 10);
      const at = (x, y) => dist[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
      for (let i = 0; i < N; i++) {
        if (!inside.length) { pos[i * 4] = home[i * 2]; pos[i * 4 + 1] = home[i * 2 + 1]; continue; }
        let p;
        do { p = inside[Math.random() * inside.length | 0]; } while (Math.random() * 255 > px[p * 4 + 3]);
        const x = p % w, y = p / w | 0;
        const near = Math.max(0, 1 - dist[p] / reach);
        pos[i * 4] = (x + Math.random()) / s;
        pos[i * 4 + 1] = (y + Math.random()) / s;
        pos[i * 4 + 2] = near * near * (0.65 + 0.35 * Math.random());
        pos[i * 4 + 3] = Math.atan2(at(x, y - 2) - at(x, y + 2), at(x - 2, y) - at(x + 2, y));
      }
      // Only the specks lit in the landscape show up, roughly LIT of them. Turn
      // them down if that many would pack the paw into a solid white shape.
      const LIT = 0.12, WANT = 0.8;   // share of specks lit; specks per px wanted
      const gain = Math.min(1, WANT * (weight / (s * s)) / (LIT * N));
      return { mask, pos, gain };
    }

    function build() {
      W = innerWidth; H = innerHeight;
      if (!W || !H) return;   // tab opened in the background; frame() retries
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      N = Math.max(30000, Math.min(340000, Math.round(W * H / 3)));
      home = new Float32Array(N * 2);
      off = new Float32Array(N * 2);
      vel = new Float32Array(N * 2);
      live = new Uint8Array(N);
      liveCount = 0;
      const seed = new Float32Array(N * 4), far = Math.max(W, H);
      for (let i = 0; i < N; i++) {
        home[i * 2] = Math.random() * W;
        home[i * 2 + 1] = Math.random() * H;
        seed[i * 4] = Math.random();
        seed[i * 4 + 1] = Math.random();
        seed[i * 4 + 2] = Math.random() * Math.PI * 2;
        seed[i * 4 + 3] = (0.08 + Math.random() * 0.55) * far;
      }
      upload(A.home, home, gl.STATIC_DRAW);
      upload(A.seed, seed, gl.STATIC_DRAW);
      const paw = pawData();
      upload(A.paw, paw.mask, gl.STATIC_DRAW);
      upload(A.pawPos, paw.pos, gl.STATIC_DRAW);
      gl.uniform1f(U.uPawGain, paw.gain);
      upload(A.off, off, gl.DYNAMIC_DRAW);
      gl.uniform2f(U.uRes, W, H);
      gl.uniform1f(U.uDpr, dpr);
    }

    // Specks near a moving pointer get shoved; a weak spring walks them home.
    function simulate(dt) {
      const pushing = ptr.seen && performance.now() - ptr.t < 140;
      if (!pushing && liveCount === 0) return false;
      const R = 120, R2 = R * R;
      const speed = Math.min(Math.hypot(ptr.vx, ptr.vy) / 16, 1.8);
      const mx = ptr.x, my = ptr.y, mvx = ptr.vx, mvy = ptr.vy;
      const damp = Math.pow(0.9, dt), spring = 0.0016 * dt;
      let count = 0;
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        let ox = off[j], oy = off[j + 1], vx = vel[j], vy = vel[j + 1], hit = false;
        if (pushing) {
          const dx = home[j] + ox - mx, dy = home[j + 1] + oy - my, d2 = dx * dx + dy * dy;
          if (d2 < R2) {
            const d = Math.sqrt(d2) + 0.001, f = 1 - d / R, push = f * f * (0.18 + speed * 1.3) * dt;
            vx += dx / d * push + mvx * f * 0.03 * dt;
            vy += dy / d * push + mvy * f * 0.03 * dt;
            hit = true;
          }
        }
        if (!hit && !live[i]) continue;
        vx = (vx - ox * spring) * damp;
        vy = (vy - oy * spring) * damp;
        ox += vx * dt; oy += vy * dt;
        if (!hit && ox * ox + oy * oy < 0.04 && vx * vx + vy * vy < 0.0004) {
          ox = oy = vx = vy = 0; live[i] = 0;
        } else { live[i] = 1; count++; }
        off[j] = ox; off[j + 1] = oy; vel[j] = vx; vel[j + 1] = vy;
      }
      liveCount = count;
      return true;
    }

    // A click throws every speck inside a circle straight out from the pointer.
    // Each one gets just enough speed to coast to the edge, so they pile up
    // there as a ring and leave the middle empty; the spring then refills it.
    function burst(x, y) {
      if (reduced || !N) return;
      const R = Math.max(120, Math.min(220, Math.min(W, H) * 0.24)), R2 = R * R;
      const COAST = 9;   // px travelled per px/frame of launch speed, given the damping
      let woke = 0;
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        const dx = home[j] + off[j] - x, dy = home[j + 1] + off[j + 1] - y, d2 = dx * dx + dy * dy;
        if (d2 >= R2) continue;
        const d = Math.sqrt(d2) + 0.001;
        const v = (R - d) / COAST * (0.85 + Math.random() * 0.3);
        vel[j] += dx / d * v; vel[j + 1] += dy / d * v;
        if (!live[i]) { live[i] = 1; woke++; }
      }
      liveCount += woke;
    }

    const GATHER = 1.3, HOLD = 0.6, SPREAD = 2.0;
    let t0 = 0, last = 0, scrollS = 0, pan = 0, paw = 0, pawTarget = 0;
    const clamp = (v, m) => Math.max(-m, Math.min(m, v));
    function frame(now) {
      if (!N) {
        try { build(); } catch (err) { console.warn(err); canvas.remove(); root.classList.add('is-live'); return; }
        if (!N) return requestAnimationFrame(frame);
      }
      // First real frame: start the clock and let the name follow the grain.
      if (!t0) { t0 = last = now; root.classList.add('is-live'); }
      const t = (now - t0) / 1000;
      // dt in 60fps frames, so motion is the same on 60Hz and 120Hz screens.
      const dt = Math.min((now - last) / 16.667, 3) || 1;
      last = now;
      const ease = k => 1 - Math.pow(1 - k, dt);
      ptr.vx = clamp((ptr.x - ptr.lx) / dt, 60); ptr.vy = clamp((ptr.y - ptr.ly) / dt, 60);
      ptr.lx = ptr.x; ptr.ly = ptr.y;

      scrollS += (scrollY / H - scrollS) * ease(0.1);
      if (ptr.seen) pan += ((ptr.x / W - 0.5) - pan) * ease(0.03);
      paw += (pawTarget - paw) * ease(0.045);
      const past = Math.min(Math.max((scrollS - 0.15) / 0.75, 0), 1);
      const dim = Math.max(1 - 0.68 * past * past * (3 - 2 * past), paw * 0.95);

      if (!reduced && simulate(dt)) {
        gl.bindBuffer(gl.ARRAY_BUFFER, A.off.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, off);
      }
      gl.uniform1f(U.uTime, reduced ? 12 : t + 12);
      // Intro timeline, in seconds: gather into the paw, hold, spread out.
      gl.uniform1f(U.uGather, reduced ? 1 : Math.min(t / GATHER, 1));
      gl.uniform1f(U.uSpread, reduced ? 1 : Math.min(Math.max((t - GATHER - HOLD) / SPREAD, 0), 1));
      gl.uniform1f(U.uScroll, scrollS);
      gl.uniform1f(U.uPan, reduced ? 0 : pan);
      gl.uniform1f(U.uDim, dim);
      gl.uniform1f(U.uPaw, paw);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, N);
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

    let resizeTimer;
    addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // Phone address bars resize the viewport constantly; ignore those.
        if (innerWidth !== W || Math.abs(innerHeight - H) > 160) build();
      }, 200);
    });

    return {
      burst,
      // Easter egg: the specks regroup into a paw print, then let go.
      paw() {
        pawTarget = 1;
        if (!reduced) {
          for (let j = 0; j < N * 2; j++) vel[j] += (Math.random() - 0.5) * 5;
          live.fill(1); liveCount = N;
        }
        clearTimeout(this._t);
        this._t = setTimeout(() => { pawTarget = 0; }, 3600);
      }
    };
  }
  let grain = null;
  try { grain = createGrain(); } catch (err) { console.warn(err); }
  if (!grain) root.classList.add('is-live');   // no grain, so nothing to wait for

  // Mouse click anywhere: blow the specks out of a circle around the pointer.
  addEventListener('pointerdown', e => {
    if (grain && e.pointerType !== 'touch' && e.button === 0) grain.burst(e.clientX, e.clientY);
  });

  /* ---------- Top bar + current section ---------- */
  const bar = $('#bar'), home = $('.home');
  const sections = $$('[data-section]');
  const navLinks = $$('[data-nav]');
  const projects = $$('.project');
  let ticking = false;

  function onScroll() {
    ticking = false;
    const vh = innerHeight;
    bar.classList.toggle('is-on', home.getBoundingClientRect().bottom < vh * 0.55);

    let current = null;
    sections.forEach(s => { if (s.getBoundingClientRect().top < vh * 0.45) current = s.dataset.section; });
    if (scrollY >= document.documentElement.scrollHeight - vh - 4) current = sections[sections.length - 1].dataset.section;
    navLinks.forEach(a => a.classList.toggle('is-current', a.dataset.nav === current));

    // The project nearest the middle of the screen is the one in focus.
    let best = null, bestDist = Infinity;
    projects.forEach(p => {
      const r = p.getBoundingClientRect();
      const mid = r.top + Math.min(r.height, vh * 0.7) / 2;
      const dist = Math.abs(mid - vh * 0.48);
      if (dist < bestDist) { bestDist = dist; best = p; }
    });
    projects.forEach(p => p.classList.toggle('is-focus', p === best));
  }
  const queueScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } };
  addEventListener('scroll', queueScroll, { passive: true });
  addEventListener('resize', queueScroll);
  onScroll();

  /* ---------- Scroll reveal ---------- */
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-seen');
      io.unobserve(e.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  $$('[data-reveal]').forEach(el => io.observe(el));

  /* ---------- Toast ---------- */
  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2200);
  }

  /* ---------- Cursor ---------- */
  const dot = $('#cursorDot'), ring = $('#cursorRing'), label = $('#cursorLabel');
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    root.classList.add('has-cursor');
    let rx = 0, ry = 0, placed = false;

    addEventListener('mousemove', e => {
      if (!placed) { rx = e.clientX; ry = e.clientY; placed = true; }
      root.classList.add('cursor-on');
      dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      const target = e.target.closest('a, button, [data-cursor]');
      // The ring fills over links and buttons, but not over screenshots, where
      // an inverted disc would hide what you are looking at.
      root.classList.toggle('cursor-hover', !!target && target.matches('a, button') && !target.classList.contains('shot'));
      const text = target && target.dataset.cursor;
      root.classList.toggle('cursor-labelled', !!text);
      if (text) label.textContent = text;
    });
    document.addEventListener('mouseleave', () => root.classList.remove('cursor-on'));
    addEventListener('mousedown', () => root.classList.add('cursor-down'));
    addEventListener('mouseup', () => root.classList.remove('cursor-down'));

    (function follow() {
      rx += (ptr.x - rx) * 0.17; ry += (ptr.y - ry) * 0.17;
      ring.style.transform = `translate(${rx}px, ${ry}px)`;
      label.style.transform = `translate(${rx}px, ${ry}px)`;
      requestAnimationFrame(follow);
    })();
  }

  /* ---------- Screenshots: click to view full size ---------- */
  const box = $('#lightbox'), boxImg = $('img', box), boxCap = $('p', box);
  let group = [], at = 0, opener = null;
  function showShot(i) {
    at = (i + group.length) % group.length;
    const img = $('img', group[at]);
    boxImg.src = img.currentSrc || img.src;
    boxImg.alt = img.alt;
    // Screenshots are captured at 2x, so half the pixel width is true size.
    boxImg.style.width = img.naturalWidth ? img.naturalWidth / 2 + 'px' : '';
    boxCap.textContent = img.alt + (group.length > 1 ? `  (${at + 1} of ${group.length})` : '');
    box.scrollTop = 0;
  }
  function closeShot() {
    if (!box.classList.contains('is-open')) return;
    box.classList.remove('is-open');
    root.classList.remove('is-locked');
    if (opener) opener.focus({ preventScroll: true });
  }
  $$('.shot').forEach(btn => btn.addEventListener('click', () => {
    opener = btn;
    group = $$('.shot', btn.closest('.shots'));
    showShot(group.indexOf(btn));
    box.classList.add('is-open');
    root.classList.add('is-locked');
  }));
  box.addEventListener('click', closeShot);
  addEventListener('keydown', e => {
    if (!box.classList.contains('is-open')) return;
    if (e.key === 'Escape') closeShot();
    if (e.key === 'ArrowRight') showShot(at + 1);
    if (e.key === 'ArrowLeft') showShot(at - 1);
  });

  /* ---------- Copy email ---------- */
  const copyBtn = $('#copyEmail');
  copyBtn.addEventListener('click', async () => {
    const email = copyBtn.dataset.email;
    try {
      await navigator.clipboard.writeText(email);
      copyBtn.dataset.cursor = label.textContent = 'Copied';
      toast('Email copied');
      setTimeout(() => { copyBtn.dataset.cursor = 'Copy'; if (copyBtn.matches(':hover')) label.textContent = 'Copy'; }, 1600);
    } catch {
      location.href = 'mailto:' + email;
    }
  });

  /* ---------- Easter eggs ---------- */
  const replies = { woof: 'woof', bark: 'woof', fetch: 'good fetch', sit: 'good sit', paw: 'good dog', treat: 'treats are in the other pocket' };
  function goodDog(msg) {
    if (grain) grain.paw();
    toast(msg);
  }
  // 1. Type a word a dog would know.
  let typed = '';
  addEventListener('keydown', e => {
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    typed = (typed + e.key.toLowerCase()).slice(-8);
    for (const word in replies) {
      if (typed.endsWith(word)) { typed = ''; goodDog(replies[word]); break; }
    }
  });
  // 2. The faint paw in the footer.
  $('#footerPaw').addEventListener('click', () => goodDog('woof'));
  // 3. For whoever opens the console.
  console.log('%c  / \\__\n (    @\\___\n /         O\n/   (_____/\n/_____/   U', 'font-family:monospace;line-height:1.2');
  console.log('%cGood nose. Try typing "fetch" on the page.', 'font-family:monospace');
})();
