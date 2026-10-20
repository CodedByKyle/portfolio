(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  clearTimeout(window.__boot);   // we are running; cancel the plain-page fallback
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The name and proposition come in as the paw starts to spread; frame() calls
  // reveal() off the grain's own clock. They carry what the page is about, so a
  // watchdog shows them anyway if the grain stalls, and anything that skips the
  // intro (no WebGL, a failed build, reduced motion) shows them at once.
  // Until the first frame, only visible time counts: a background tab runs no
  // frames, and the intro should still play when it comes to the front.
  const FIRST_FRAME_LIMIT = 2500;   // ms of visible time for the grain to start
  let shown = false, watchdog = 0;
  const watch = ms => { clearTimeout(watchdog); watchdog = setTimeout(reveal, ms); };
  const waitForFirstFrame = () => document.hidden ? clearTimeout(watchdog) : watch(FIRST_FRAME_LIMIT);
  function reveal() {
    if (shown) return;
    shown = true;
    clearTimeout(watchdog);
    document.removeEventListener('visibilitychange', waitForFirstFrame);
    root.classList.add('is-live');
  }
  document.addEventListener('visibilitychange', waitForFirstFrame);
  waitForFirstFrame();
  if (reduced) reveal();

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
  // The intro paw's size inside the shell, as a share of the print drawn below.
  const INNER = 0.8;
  // The inner orb's radius as a share of the screen's short side; the shell
  // round it is 0.31, so the orb has room inside it and grows into the paw.
  const ORB_R = 0.13;
  const VERT = `
    precision highp float;
    attribute vec2 aHome;
    attribute vec2 aOff;
    attribute vec4 aSeed;   // threshold, phase, angle, distance (the angle and distance also place the speck on the intro orb)
    attribute float aPaw;
    attribute vec4 aPawPos; // where this speck sits in the intro paw print; z is how near the outline, w the way out
    attribute vec3 aPawRelief; // its height off the print's plane (front pads above, back below) and the x, y of its surface normal
    attribute vec3 aBurst;  // the last click that threw this speck: when (on the uTime clock), how hard, and its hue
    uniform vec2 uRes;
    uniform float uDpr, uTime, uOrbIn, uGather, uSpread, uPawGain, uScroll, uPan, uDim, uPaw;
    varying float vAlpha, vGlow, vCore, vAmb;
    varying vec3 vColor;

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

    // Neon palette, cycling cyan, violet, pink as h goes from 0 to 1.
    vec3 neon(float h) {
      h = fract(h) * 3.0;
      vec3 cyan = vec3(0.25, 0.92, 1.0), violet = vec3(0.64, 0.4, 1.0), pink = vec3(1.0, 0.34, 0.78);
      if (h < 1.0) return mix(cyan, violet, smoothstep(0.0, 1.0, h));
      if (h < 2.0) return mix(violet, pink, smoothstep(1.0, 2.0, h));
      return mix(pink, cyan, smoothstep(2.0, 3.0, h));
    }

    const int K = 3;
    const float INNER = ${INNER.toFixed(2)};
    const float ORB_R = ${ORB_R.toFixed(2)};

    void main() {
      vec2 uv = aHome / uRes;
      float aspect = uRes.x / uRes.y;
      float x = uv.x * aspect;

      // Loose dust in the sky.
      float d = 0.012 * smoothstep(0.0, 0.35, uv.y);
      // How near this speck sits to the crest of the ridge in front, and the
      // neon hue there. Like d, only the nearest ridge over the speck counts.
      float crest = 0.0, hue = 0.0;
      // Depth for the dunes alone (the intro reads d, so these stay apart):
      // extra density for the ridge over the speck, how far down that ridge it
      // sits, which ridge it is, and how far up from the next crest in front.
      float body = 0.0, own = 0.0, gap = 1.0, layer = 1.0;

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
        float along = x * freq + kk * 13.7 + drift;
        float ridge = base + amp * (profile(along, morph) - 0.5) * 2.0;
        float below = uv.y - ridge;
        if (below > 0.0) {
          float light = 0.1 + 0.9 * smoothstep(0.25, 0.75, noise(x * 0.8 + kk * 5.1 - drift * 1.4 + uScroll * 0.5));
          float slope = 0.42 * exp(-below / 0.012) + 0.58 * exp(-below / mix(0.06, 0.15, fk));
          // Faint ripples running down the slope, like wind marks in sand.
          float wind = sin(below * 210.0 + noise(x * 2.3 + float(k) * 3.0) * 6.0 - uTime * 0.12);
          float ripple = 0.8 + 0.2 * wind;
          d = mix(0.55, 1.0, fk) * light * slope * mix(1.0, ripple, smoothstep(0.0, 0.03, below));
          // The ridge in front gains a body further down its slope, so the land
          // nearest has mass, falling away softly toward the bottom. The ridges
          // behind get a finer, firmer crest line instead, so they read as
          // layers rather than haze.
          float band = 0.5 + 0.5 * wind;
          body = 0.24 * fk * fk * fk * mix(0.45, 1.0, light) * exp(-below / mix(0.14, 0.32, fk))
               * mix(0.3, 1.0, band * band) * smoothstep(0.0, 0.05, below)
               + 0.45 * (1.0 - fk) * light * exp(-below / 0.008);
          own = below;
          layer = fk;
          gap = 1.0;
          // Bright stretches of crest carry neon, in patches that drift along the ridge.
          float pulse = smoothstep(0.3, 0.75, noise(along * 1.1 - uTime * 0.18 + kk * 4.0));
          crest = exp(-below / 0.014) * smoothstep(0.2, 0.7, light) * mix(0.35, 1.0, pulse);
          hue = along * 0.22 + kk * 0.31 - uTime * 0.05;
        } else gap = min(gap, -below);
      }

      // Keep the corner behind the name and proposition clear on the home screen.
      vec2 q = vec2(uv.x / mix(2.0, 0.9, smoothstep(0.7, 1.3, aspect)), (1.0 - uv.y) / 0.62);
      float corner = smoothstep(0.6, 1.1, length(q));
      float keep = mix(corner, 1.0, clamp(uScroll * 2.0, 0.0, 1.0)) * (1.0 - smoothstep(0.78, 1.0, uv.y) * 0.85);
      d *= keep;
      // The dunes once the intro has let go: far slopes recede a little behind
      // their crests, the extra density above comes in, and the trough just
      // behind a nearer crest falls into shadow so the layers separate. Only
      // the slope below a ridge's own crest is shaded, never the crest itself.
      float trough = 1.0 - 0.55 * (1.0 - smoothstep(0.0, 0.08, gap)) * smoothstep(0.02, 0.08, own);
      float dDune = (d * mix(mix(0.75, 1.0, layer), 1.0, crest) + body * keep) * trough;

      d = mix(d, aPaw, uPaw);
      dDune = mix(dDune, aPaw, uPaw);

      float twinkle = 0.82 + 0.18 * sin(uTime * (0.5 + aSeed.y * 1.6) + aSeed.y * 50.0), dimmer = mix(0.6, 1.0, fract(aSeed.y * 7.31));
      float a = smoothstep(aSeed.x, aSeed.x + 0.08, d);
      a *= twinkle;
      a *= dimmer;
      float aDune = smoothstep(aSeed.x, aSeed.x + 0.08, dDune) * twinkle * dimmer;

      // Intro, part one: two spheres of dots, one inside the other, both there
      // from the first frame. The inner orb breathes, turning on a tilted axis
      // with luminous contours flowing over it; round it a larger, sparser shell
      // turns the other way and breathes more gently, its near face held back to
      // a veil so the orb shows through. The inner orb's specks then pour into a
      // paw print in its place while the shell keeps its size, until both let go
      // together. Once they have, this block is skipped.
      float lag = aSeed.y, orbA = a, orbGlow = 0.0, shell = 0.0, fill = 0.0;
      vec2 orbP = aPawPos.xy;
      vec3 orbCol = vec3(1.0);
      if (uSpread < 1.0) {
        float unit = min(uRes.x, uRes.y), t = uTime;
        // A spot on the sphere from the speck's seeds: the scatter distance, once
        // a plain random number again, picks the latitude. The contours are
        // worked out on the sphere itself, so they turn with it.
        float lat = clamp((aSeed.w / max(uRes.x, uRes.y) - 0.08) / 0.55, 0.0, 1.0);
        float cz = lat * 2.0 - 1.0;
        vec3 n = vec3(sqrt(1.0 - cz * cz) * vec2(cos(aSeed.z), sin(aSeed.z)), cz);
        // The inner orb shows its own share of specks, enough for about 0.6 per
        // pixel of a disc of radius 0.2 whatever the screen, plus the ones the
        // paw will need, so none of those pop in on the way. Part of that share
        // is the shell instead; spread over the larger sphere it is far
        // thinner. The rest make the inner orb and flow into the paw; only the
        // specks the print leaves unlit fade, and those do so gradually on the
        // way in.
        float count = clamp(uRes.x * uRes.y / 3.0, 30000.0, 340000.0);
        float share = min(0.5, 0.6 * 3.14159 * 0.04 * unit * unit / count);
        float pick = fract(lat * 613.7);
        shell = step(pick, 0.4 * share);
        fill = step(pick, share) - shell;
        float on = max(a, step(pick, share));
        float flow = sin(9.0 * (n.y + 0.22 * sin(3.0 * n.x + t * 0.9) + 0.16 * sin(4.0 * n.z - t * 1.3)) - t * 2.2);
        float band = pow(0.5 + 0.5 * flow, 3.0);
        // The orb breathes about once every 1.5s, with slow ripples running over
        // the surface, and swells up from a little smaller as it fades in. The
        // shell breathes at half the pace and a third of the depth, and holds
        // its size from the start.
        float breath = sin(t * mix(4.2, 2.1, shell));
        float ripple = sin(dot(n, vec3(4.0, 2.5, -3.0)) + t * 3.1) * sin(dot(n, vec3(-2.0, 3.5, 2.5)) - t * 2.4);
        float swell = mix((1.0 + 0.045 * breath + 0.05 * ripple + 0.02 * band) * (0.75 + 0.25 * sqrt(uOrbIn)),
                          1.0 + 0.015 * breath + 0.012 * ripple, shell);
        float r = unit * mix(ORB_R, 0.31, shell) * swell;
        float spin = mix(t * 0.55, 1.7 - t * 0.24, shell);
        vec2 lean = mix(vec2(0.92, 0.39), vec2(0.8, -0.6), shell);
        vec3 w = n;
        w.xz = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * w.xz;
        w.yz = mat2(lean.x, lean.y, -lean.y, lean.x) * w.yz;
        orbP = uRes * vec2(0.5, 0.45) + w.xy * r / (1.0 - 0.22 * w.z);
        // The far side is dim, the rim and contours bright, and the whole orb
        // pulses with its breath, its colour drifting through the neon palette.
        // It is drawn at full strength, so it undoes the paw's density gain.
        // The shell's near face, in front of the orb and later the paw, is held
        // back to a veil, leaving its rim and far side to show depth.
        float facing = 0.5 + 0.5 * w.z, rim = pow(1.0 - abs(w.z), 3.0);
        float veil = shell * smoothstep(0.0, 0.5, w.z) * (1.0 - rim);
        // The orb packs the specks sized for a disc of 0.2 into a smaller one,
        // so each is turned down and fewer of them glow, keeping it from
        // burning out into a solid ball.
        float dense = mix(0.55, 1.0, shell);
        orbA = on * uOrbIn * dense * mix(0.2, 1.0, facing) * (0.3 + 1.1 * band + 0.6 * rim) * (0.8 + 0.3 * breath) * (1.0 - 0.7 * veil) / max(uPawGain, 0.05);
        orbCol = neon(0.12 * t + 0.3 * n.y + 0.25 * band + 0.06 * breath + 0.2 * shell);
        orbCol = clamp(mix(vec3(dot(orbCol, vec3(0.3, 0.5, 0.2))), orbCol, 1.3), 0.0, 1.0);
        orbCol = mix(orbCol, vec3(1.0), 0.35 * band * facing);
        orbGlow = on * band * smoothstep(0.35, 0.85, facing) * step(fract(aSeed.x * 53.0 + 0.37), mix(0.3, 0.5, shell)) * (1.0 - veil);
        // The top of the orb lets go first, so the paw pours out of it.
        lag = mix(aSeed.y, 0.5 + 0.5 * w.y, 0.65);
      }
      // The paw itself is in low relief: each pad is a shallow plate, flat on
      // top and bevelled toward its own outline, with a thin shell behind, so
      // it reads as a print with some depth rather than a set of cushions. It
      // is drawn at INNER of the print's size so it fits inside the shell. It
      // turns and tilts a little and breathes in time with the orb, lit from
      // the front upper left with a light behind catching its edges. Once it
      // has spread out the print is flat again and none of this runs.
      vec2 pawP = aPawPos.xy;
      float shade = 1.0, rim = 0.0, backLit = 0.0, side = 0.0, thin = 1.0, stray = 0.0;
      if (uSpread < 1.0) {
        float unit = min(uRes.x, uRes.y), t = uTime, breath = sin(t * 4.2);
        vec2 mid = uRes * vec2(0.5, 0.45);
        // Not every speck that lands in the print stays lit. A fixed, smooth
        // field over the print, so it turns with it, keeps most specks in a few
        // denser patches and only a few in the soft gaps between, and the
        // outline holds on to more of them so the shape still reads. Specks
        // near their cut-off are dimmed rather than dropped, so there is no edge.
        // Deeper into each pad the share falls away, so the middles, the heel's
        // most of all, are left as a light scatter inside a stronger edge. The
        // depth is nudged by noise, and the edge's hold varies along it, so
        // neither the hollow nor the outline comes out as an even line.
        vec2 pc = (aPawPos.xy - mid) / unit;
        float clump = 0.75 * noise2(pc * 6.0 + 3.7) + 0.25 * noise2(pc * 15.0 + 21.3);
        float depth = 1.0 - smoothstep(0.04, 0.6, aPawPos.z + 0.3 * (noise2(pc * 11.0 + 7.1) - 0.5));
        float hold = 0.85 * aPawPos.z * (0.55 + 0.6 * noise2(pc * 8.0 + 31.9));
        float keepShare = max(mix(0.25, 1.0, smoothstep(0.36, 0.64, clump)) * mix(1.0, 0.18, depth), hold);
        thin = 1.0 - smoothstep(keepShare - 0.08, keepShare + 0.08, fract(aSeed.z * 61.7));
        // About one outline speck in eleven comes loose while the paw is held
        // (see below). Only the lit ones show, so the paw keeps its density.
        stray = step(fract(aSeed.x * 17.31 + aSeed.y * 3.7), 0.09) * smoothstep(0.25, 0.6, aPawPos.z);
        vec3 v = vec3(aPawPos.xy - mid, aPawRelief.x * (1.0 + 0.08 * breath)) * INNER;
        vec3 nn = vec3(aPawRelief.yz, sign(aPawRelief.x) * sqrt(max(0.0, 1.0 - dot(aPawRelief.yz, aPawRelief.yz))));
        float yaw = 0.3 * sin(t * 0.55 + 0.6), pitch = 0.26 + 0.05 * sin(t * 0.8);
        mat2 turn = mat2(cos(yaw), sin(yaw), -sin(yaw), cos(yaw)), tilt = mat2(cos(pitch), sin(pitch), -sin(pitch), cos(pitch));
        v.xz = turn * v.xz; nn.xz = turn * nn.xz;
        v.yz = tilt * v.yz; nn.yz = tilt * nn.yz;
        pawP = mid + v.xy * (1.0 + 0.015 * breath) / (1.0 - 0.3 * v.z / unit);
        float key = max(dot(nn, vec3(-0.6, -0.55, 0.58)), 0.0);
        float shine = pow(max(dot(nn, vec3(-0.33, -0.3, 0.9)), 0.0), 10.0);
        backLit = max(dot(nn, vec3(0.55, -0.4, -0.73)), 0.0);
        rim = 1.0 - abs(nn.z);
        side = nn.x;
        shade = (0.35 + 1.1 * key + 0.3 * shine + 0.45 * backLit + 0.3 * rim) * mix(0.55, 1.0, 0.5 + 0.5 * nn.z) * (0.92 + 0.08 * breath);
      }
      // The shell specks never leave the orb.
      float g = clamp(uGather * 1.6 - lag * 0.6, 0.0, 1.0) * (1.0 - shell);
      g = g * g * (3.0 - 2.0 * g);
      vec2 path = pawP - orbP;
      vec2 from = mix(orbP, pawP, g) + vec2(-path.y, path.x) * sin(3.14159 * g) * 0.25;
      // Part two: the paw and the orb let go and each speck swings out to its
      // own place, leaving the intro's lighting behind as it goes.
      float s = clamp(uSpread * 1.5 - fract(aSeed.y * 13.7) * 0.5, 0.0, 1.0);
      s = s * s * (3.0 - 2.0 * s);
      a = mix(mix(orbA, aDune, s), mix(max(a, fill) * shade * thin, aDune, s), g);
      vec2 way = aHome - from;
      vec2 swing = vec2(-way.y, way.x) * sin(3.14159 * s) * mix(0.08, 0.26, fract(aSeed.x * 37.0));
      // While the paw is held, its outline breathes. Neighbouring specks ride
      // the same slow field, so the edge swells and drifts as one soft shape
      // instead of each speck twitching alone, and the motion thins out toward
      // the middle. It fades in as each speck lands and out as it lets go.
      float live = pow(g, 4.0) * (1.0 - s);
      float soft = aPawPos.z * live * g * g;
      vec2 p = mix(from, aHome, s) + swing + aOff;
      // Once the paw has let go every speck's share is zero, so skip the noise.
      if (uSpread < 1.0 && live > 0.0) {
        float unit = min(uRes.x, uRes.y);
        vec2 q = aPawPos.xy / unit * 7.0;
        float t = uTime * 0.3;
        vec2 outward = vec2(cos(aPawPos.w), sin(aPawPos.w));
        // In and out along the outline, a different amount at each stretch of
        // it, so the paw never grows or shrinks as a whole.
        float breath = noise2(q * 0.5 + vec2(-t * 1.3, t * 1.3 + 23.0)) - 0.5;
        vec2 flow = vec2(noise2(q + vec2(t, 3.0)), noise2(q + vec2(11.0, -t))) - 0.5;
        p += (outward * breath + flow * 0.6) * soft * unit * 0.008;
        a *= 1.0 - 0.14 * soft * noise2(q * 1.4 + vec2(t * 1.2 + 41.0, 7.0));
        // The pads are alive too: a slow current runs through the print, so
        // patches of neighbouring specks drift together and a soft wave rolls
        // across from toe to heel, and each speck sways a little on its own
        // slow beat. All of it is smooth in time, so nothing flickers.
        vec2 cur = vec2(noise2(q * 1.3 + vec2(uTime * 0.7, 51.0)), noise2(q * 1.3 + vec2(87.0, -uTime * 0.6))) - 0.5;
        float wave = sin(dot(q, vec2(0.5, 0.9)) * 2.2 - uTime * 2.6);
        vec2 sway = vec2(sin(uTime * mix(1.4, 2.6, aSeed.y) + aSeed.z * 5.0), cos(uTime * mix(1.2, 2.3, fract(aSeed.y * 5.3)) + aSeed.z * 3.0));
        p += (cur * 1.6 + outward * wave * 0.25 + sway * 0.2) * live * unit * 0.012;
        // The loose outline specks (stray, above): each drifts out from the
        // edge on its own slow loop, wanders a little to the side, then settles
        // back, so a handful are always out and none goes far. They fade a
        // little while out, and when the paw lets go they just go home.
        if (stray > 0.0) {
          float ph = fract(aSeed.z * 2.71) * 6.2832;
          float loose = pow(0.5 - 0.5 * cos(uTime * mix(1.5, 2.8, fract(aSeed.x * 7.7)) + ph), 1.5);
          vec2 wander = vec2(-outward.y, outward.x) * sin(uTime * mix(0.9, 1.7, fract(aSeed.y * 9.1)) + ph * 1.3);
          p += (outward * mix(0.025, 0.06, fract(aSeed.x * 3.3)) * loose + wander * 0.018 * loose) * stray * live * unit;
          a *= 1.0 - 0.35 * loose * stray * live;
        }
      }

      // Colour. It only comes in once the paw has let go, and stays out of the
      // easter egg. A click tints the specks it threw, lighting a share of the
      // dark ones too so it shows in the sky, then fades back to the idle look.
      float fade = (1.0 - uPaw) * s;
      float tint = clamp(crest * 1.5, 0.0, 1.0) * keep * fade;
      float age = uTime - aBurst.x;
      float hit = aBurst.y * (1.0 - smoothstep(0.0, 2.6, age)) * fade;
      a = max(a, hit * (1.0 - smoothstep(0.08, 0.2, aSeed.x)) * mix(0.4, 1.0, keep));
      // The crest neon runs deeper than the click colours: the hue slides a
      // little down the slope and the palette is pushed away from grey.
      vec3 rich = neon(hue + 0.2 * (1.0 - crest));
      rich = clamp(mix(vec3(dot(rich, vec3(0.3, 0.5, 0.2))), rich, 1.3), 0.0, 1.0);
      vec3 col = mix(vec3(0.93), rich, tint);
      col = mix(col, neon(aBurst.z + age * 0.08), hit);
      // The intro paw carries its own neon: one gradient across the print, cyan
      // at the top left through violet to pink at the heel, set by where each
      // speck lands. Only parts of the print take it: a fixed, smooth mask picks
      // a few broad patches, and even there some specks stay white, so the paw
      // reads as white with patches of colour rather than coloured noise. The
      // outline is richer than the middle and a share of the coloured outline
      // specks glow. Each speck hands over to the dune colours as it lets go.
      float intro = (1.0 - s) * (1.0 - uPaw) * (1.0 - shell);
      float pawTint = 0.0, pawGlow = 0.0;
      if (intro > 0.0) {
        vec2 c = (aPawPos.xy - uRes * vec2(0.5, 0.45)) / (0.5 * min(uRes.x, uRes.y));
        float ph = clamp(0.33 + 0.75 * (c.x * 0.45 + c.y * 0.8) + 0.04 * sin(uTime * 0.7 + c.x * 3.0), 0.0, 0.66);
        vec3 pawCol = neon(ph);
        pawCol = clamp(mix(vec3(dot(pawCol, vec3(0.3, 0.5, 0.2))), pawCol, 1.35), 0.0, 1.0);
        float spot = smoothstep(0.45, 0.62, 0.5 + 0.25 * sin(10.0 * c.x + 5.0 * c.y + 4.0) + 0.25 * sin(-6.0 * c.x + 9.0 * c.y + 4.5));
        float accent = spot * step(fract(aSeed.z * 7.13), 0.8);
        pawTint = intro * accent * mix(0.8, 1.0, aPawPos.z) * mix(0.6, 1.0, g);
        col = mix(col, pawCol, pawTint);
        pawGlow = intro * accent * g * smoothstep(0.3, 0.7, aPawPos.z) * step(fract(aSeed.x * 53.0), 0.4);
        // Where the relief turns away, a share of the specks pick up soft neon
        // from the light behind, the hue drifting with the side it faces.
        float edge = intro * step(fract(aSeed.z * 3.71), 0.45) * clamp(smoothstep(0.12, 0.45, rim) + 0.6 * backLit, 0.0, 1.0);
        col = mix(col, neon(ph + 0.12 * side + 0.1), 0.75 * edge);
        pawTint = max(pawTint, 0.6 * edge);
        pawGlow = max(pawGlow, edge * g * step(fract(aSeed.x * 29.0), 0.35));
      }
      // The orb's colours hand over to the paw's as each speck leaves it, and
      // the shell's to the dunes' as it lets go.
      float orb = (1.0 - g) * (1.0 - s * shell);
      col = mix(col, orbCol, orb);
      orbGlow *= orb;
      float glow = max(max(tint, hit), max(pawGlow * 0.8, orbGlow)) * step(0.02, a);
      // How much of the glow is the idle crest, the paw or the orb rather than a click.
      float amb = (tint + pawGlow + orbGlow) / (tint + pawGlow + orbGlow + hit + 0.0001);

      // Scrolling dims the land; the crest neon dims less, so it still reads.
      // Neon reads darker than white, so the coloured paw specks are lifted a little.
      vAlpha = a * mix(uPawGain, 1.0, s) * mix(uDim, sqrt(uDim), tint * amb) * (1.0 + 0.3 * pawTint);
      vColor = col;
      vec2 clip = p / uRes * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      // A glowing speck draws a larger point: its own speck in the middle, a halo round it.
      float size = max(1.0, uDpr * mix(0.7, 1.3, fract(aSeed.x * 91.7)));
      float grow = uDpr * mix(3.0, 3.6, amb) * glow;
      gl_PointSize = size + grow;
      vCore = size / (size + grow);
      vGlow = glow;
      vAmb = amb;
    }`;

  const FRAG = `
    precision mediump float;
    varying float vAlpha, vGlow, vCore, vAmb;
    varying vec3 vColor;
    void main() {
      if (vGlow <= 0.0) { gl_FragColor = vec4(vColor, vAlpha); return; }
      float r = length(gl_PointCoord - 0.5) * 2.0;
      // Crest specks keep more colour in the core and throw a brighter, fuller halo than click specks.
      if (r < vCore) gl_FragColor = vec4(mix(vColor, vec3(1.0), mix(0.25, 0.12, vAmb) * vGlow), vAlpha);
      else gl_FragColor = vec4(vColor, vAlpha * vGlow * mix(0.55, 0.9, vAmb) * pow(max(1.0 - r, 0.0), mix(1.5, 1.2, vAmb)));
    }`;

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
    ['uRes', 'uDpr', 'uTime', 'uOrbIn', 'uGather', 'uSpread', 'uPawGain', 'uScroll', 'uPan', 'uDim', 'uPaw'].forEach(n => U[n] = gl.getUniformLocation(prog, n));
    const attr = (name, size) => {
      const buf = gl.createBuffer(), loc = gl.getAttribLocation(prog, name);
      return { buf, loc, size };
    };
    const A = { home: attr('aHome', 2), off: attr('aOff', 2), seed: attr('aSeed', 4), paw: attr('aPaw', 1), pawPos: attr('aPawPos', 4), relief: attr('aPawRelief', 3), burst: attr('aBurst', 3) };
    const upload = (a, data, usage) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    };

    let W = 0, H = 0, dpr = 1, N = 0;
    let home, off, vel, live, liveCount = 0, hits;
    // The specks in motion, packed into the front of `moving` (live[i] marks
    // them), so the spring never has to walk the resting ones. Resting specks
    // sit at home, so a grid of home spots finds the ones the pointer reaches.
    const CELL = 16, SWEEP = 0.4;
    let moving, listed = true, cols = 0, rows = 0, cellStart, cellItems;
    let clock = 12;   // the shader's uTime as of the last frame
    // Whether the intro paw is still to come or under way, so it needs its relief.
    let intro = !reduced;

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
      const toes = [[14, 26, 6, 8, -20], [26, 14, 6.5, 9, -8], [40, 14, 6.5, 9, 8], [52, 26, 6, 8, 20]];
      toes.forEach(([x, y, rx, ry, r]) => {
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
      const gain = Math.min(1, WANT * (weight / (s * s)) * INNER * INNER / (LIT * N));
      return { mask, pos, gain, relief: intro ? relief() : null };

      // The intro paw's relief. Each pad is a low plate: a speck's height
      // follows a circle's profile over the outer part of the way in to that
      // pad's deepest point and is flat beyond it, and stays a fraction of the
      // pad's width, so the print keeps its outline instead of puffing up into
      // beans and a dome. A third of the specks make a thinner shell behind.
      // The normal leans out along the way out of the paw, mostly on the bevel
      // and only a little across the flat top, so the light still moves on it.
      function relief() {
        const ox = w / 2 - size / 2, oy = h * 0.45 - size / 2;
        const toe = (x, y) => {
          const ux = (x + 0.5 - ox) / k, uy = (y + 0.5 - oy) / k;
          for (let t = 0; t < toes.length; t++) {
            const [cx, cy, rx, ry, r] = toes[t], c = Math.cos(r * Math.PI / 180), sn = Math.sin(r * Math.PI / 180);
            const lx = (ux - cx) * c + (uy - cy) * sn, ly = (uy - cy) * c - (ux - cx) * sn;
            if ((lx / (rx + 1.5)) ** 2 + (ly / (ry + 1.5)) ** 2 <= 1) return t;
          }
          return toes.length;   // the main pad
        };
        const deepest = new Float32Array(toes.length + 1);
        for (const p of inside) { const t = toe(p % w, p / w | 0); deepest[t] = Math.max(deepest[t], dist[p]); }
        const out = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
          const x = Math.min(w - 1, pos[i * 4] * s | 0), y = Math.min(h - 1, pos[i * 4 + 1] * s | 0), p = y * w + x;
          const deep = deepest[toe(x, y)];
          if (!dist[p] || !deep) continue;
          const u = Math.min(1, Math.max(0, (dist[p] - Math.random()) / deep));
          const top = Math.min(1, u * 1.6), lift = Math.sqrt(top * (2 - top)), back = Math.random() < 0.33, f = back ? 0.14 : 0.36;
          const lean = (0.65 * (1 - top) + 0.15 * (1 - u)) * (back ? 0.5 : 1);
          out[i * 3] = (back ? -f : f) * (deep / s) * lift;
          out[i * 3 + 1] = lean * Math.cos(pos[i * 4 + 3]);
          out[i * 3 + 2] = lean * Math.sin(pos[i * 4 + 3]);
        }
        return out;
      }
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
      moving = new Int32Array(N);
      liveCount = 0; listed = true;
      const seed = new Float32Array(N * 4), far = Math.max(W, H);
      for (let i = 0; i < N; i++) {
        home[i * 2] = Math.random() * W;
        home[i * 2 + 1] = Math.random() * H;
        seed[i * 4] = Math.random();
        seed[i * 4 + 1] = Math.random();
        seed[i * 4 + 2] = Math.random() * Math.PI * 2;
        seed[i * 4 + 3] = (0.08 + Math.random() * 0.55) * far;
      }
      cols = Math.ceil(W / CELL); rows = Math.ceil(H / CELL);
      cellStart = new Int32Array(cols * rows + 1);
      cellItems = new Int32Array(N);
      const cellOf = new Int32Array(N);
      for (let i = 0; i < N; i++) {
        let cx = home[i * 2] / CELL | 0, cy = home[i * 2 + 1] / CELL | 0;
        if (cx >= cols) cx = cols - 1;   // float rounding can land a speck on the far edge
        if (cy >= rows) cy = rows - 1;
        cellStart[(cellOf[i] = cy * cols + cx) + 1]++;
      }
      for (let c = 0; c < cols * rows; c++) cellStart[c + 1] += cellStart[c];
      const fill = cellStart.slice(0, -1);
      for (let i = 0; i < N; i++) cellItems[fill[cellOf[i]]++] = i;
      upload(A.home, home, gl.STATIC_DRAW);
      upload(A.seed, seed, gl.STATIC_DRAW);
      const paw = pawData();
      upload(A.paw, paw.mask, gl.STATIC_DRAW);
      upload(A.pawPos, paw.pos, gl.STATIC_DRAW);
      if (paw.relief) upload(A.relief, paw.relief, gl.STATIC_DRAW);
      gl.uniform1f(U.uPawGain, paw.gain);
      upload(A.off, off, gl.DYNAMIC_DRAW);
      hits = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) hits[i * 3] = -1e4;
      upload(A.burst, hits, gl.DYNAMIC_DRAW);
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
      // Once a good share of specks is moving, one pass over all of them in
      // memory order is cheaper than hopping around the list. That pass only
      // keeps live[] current; the list is rebuilt from it when next needed.
      if (liveCount > N * SWEEP) {
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
        liveCount = count; listed = false;
        return true;
      }
      if (!listed) {
        let count = 0;
        for (let i = 0; i < N; i++) if (live[i]) moving[count++] = i;
        listed = true;
      }
      if (pushing) {
        // Resting specks within reach join the moving list. Cells wholly out
        // of reach, with a pixel to spare, are never opened.
        const reach2 = (R + 1) * (R + 1);
        const x0 = Math.max(0, Math.floor((mx - R) / CELL) - 1), x1 = Math.min(cols - 1, Math.floor((mx + R) / CELL) + 1);
        const y0 = Math.max(0, Math.floor((my - R) / CELL) - 1), y1 = Math.min(rows - 1, Math.floor((my + R) / CELL) + 1);
        for (let cy = y0; cy <= y1; cy++) {
          const ey = Math.max(cy * CELL - my, 0, my - (cy + 1) * CELL);
          for (let cx = x0; cx <= x1; cx++) {
            const ex = Math.max(cx * CELL - mx, 0, mx - (cx + 1) * CELL);
            if (ex * ex + ey * ey > reach2) continue;
            const c = cy * cols + cx;
            for (let k = cellStart[c], end = cellStart[c + 1]; k < end; k++) {
              const i = cellItems[k];
              if (live[i]) continue;
              const j = i * 2, dx = home[j] + off[j] - mx, dy = home[j + 1] + off[j + 1] - my;
              if (dx * dx + dy * dy < R2) { live[i] = 1; moving[liveCount++] = i; }
            }
          }
        }
      }
      // Walk the moving specks, keeping the list in order as settled ones drop out.
      let count = 0;
      for (let k = 0; k < liveCount; k++) {
        const i = moving[k], j = i * 2;
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
        vx = (vx - ox * spring) * damp;
        vy = (vy - oy * spring) * damp;
        ox += vx * dt; oy += vy * dt;
        if (!hit && ox * ox + oy * oy < 0.04 && vx * vx + vy * vy < 0.0004) {
          ox = oy = vx = vy = 0; live[i] = 0;
        } else moving[count++] = i;
        off[j] = ox; off[j + 1] = oy; vel[j] = vx; vel[j + 1] = vy;
      }
      liveCount = count;
      return true;
    }

    // A click throws every speck inside a blob straight out from the pointer.
    // Each one gets just enough speed to coast to the edge, so they pile up
    // there as a ring and leave the middle empty; the spring then refills it.
    // Every click draws a fresh blob: a few smooth lobes plus a slight stretch,
    // scaled to about the area of a circle of radius R.
    const SEG = 256;
    const shape = new Float32Array(SEG + 2);
    function burst(x, y) {
      if (reduced || !N) return;
      const R = Math.max(120, Math.min(220, Math.min(W, H) * 0.24));
      const COAST = 9;   // px travelled per px/frame of launch speed, given the damping
      const lobes = 2 + (Math.random() * 3 | 0);
      const waves = [[1, 0.08], [2, 0.16], [lobes, 0.2], [lobes + 2, 0.06]]
        .map(([n, amp]) => [n, amp * (0.4 + Math.random() * 0.6), Math.random() * Math.PI * 2]);
      let sq = 0;
      for (let k = 0; k < SEG; k++) {
        const t = k / SEG * Math.PI * 2 - Math.PI;
        let r = 1;
        for (const [n, amp, ph] of waves) r += amp * Math.cos(n * t + ph);
        shape[k] = r; sq += r * r;
      }
      const scale = R / Math.sqrt(sq / SEG);
      let reach = 0;
      for (let k = 0; k < SEG; k++) reach = Math.max(reach, shape[k] = Math.min(shape[k] * scale, R * 1.5));
      shape[SEG] = shape[0]; shape[SEG + 1] = shape[1];
      const reach2 = reach * reach, perTurn = SEG / (Math.PI * 2);
      const hue = Math.random(), turn = Math.random() * Math.PI * 2;
      let lo = N, hi = -1;
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        const dx = home[j] + off[j] - x, dy = home[j + 1] + off[j + 1] - y, d2 = dx * dx + dy * dy;
        if (d2 >= reach2) continue;
        const ang = Math.atan2(dy, dx), u = (ang + Math.PI) * perTurn, k = u | 0;
        const edge = shape[k] + (shape[k + 1] - shape[k]) * (u - k);
        const d = Math.sqrt(d2) + 0.001;
        if (d >= edge) continue;
        const v = (edge - d) / COAST * (0.85 + Math.random() * 0.3);
        vel[j] += dx / d * v; vel[j + 1] += dy / d * v;
        if (!live[i]) { live[i] = 1; moving[liveCount++] = i; }
        const b = i * 3, f = d / edge;
        hits[b] = clock;
        hits[b + 1] = 1 - 0.3 * f;
        hits[b + 2] = hue + 0.3 * Math.cos(ang - turn) + 0.15 * f;
        if (i < lo) lo = i;
        hi = i;
      }
      if (hi >= lo) {
        gl.bindBuffer(gl.ARRAY_BUFFER, A.burst.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, lo * 12, hits.subarray(lo * 3, hi * 3 + 3));
      }
    }

    const ORB = 1.0, GATHER = 1.3, HOLD = 1.1, SPREAD = 2.0;
    // Once the clock runs, the text is due at ORB + GATHER + HOLD. The watchdog
    // only covers frames stopping before then, so it can never beat the paw.
    const INTRO_LIMIT = (ORB + GATHER + HOLD) * 1000 + 1500;
    let t0 = 0, last = 0, scrollS = 0, pan = 0, paw = 0, pawTarget = 0;
    const clamp = (v, m) => Math.max(-m, Math.min(m, v));
    function frame(now) {
      if (!N) {
        try { build(); } catch (err) { console.warn(err); canvas.remove(); reveal(); return; }
        if (!N) return requestAnimationFrame(frame);
      }
      // First real frame: start the clock. Hidden time no longer pauses the
      // watchdog, since the clock below is wall time too.
      if (!t0) {
        t0 = last = now;
        if (!shown) { document.removeEventListener('visibilitychange', waitForFirstFrame); watch(INTRO_LIMIT); }
      }
      const t = (now - t0) / 1000;
      // The paw has gathered and held: bring the name in as it spreads.
      if (!shown && t >= ORB + GATHER + HOLD) reveal();
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
      clock = reduced ? 12 : t + 12;
      gl.uniform1f(U.uTime, clock);
      // Intro timeline, in seconds: the orb and the shell round it fade in and
      // breathe, the orb pours into the paw inside the shell, both hold, then
      // spread out. Keep its fade current
      // throughout the shell's lifetime, including after a paused frame.
      if (t < ORB + GATHER + HOLD + SPREAD) gl.uniform1f(U.uOrbIn, Math.min(t / 0.4, 1));
      gl.uniform1f(U.uGather, reduced ? 1 : Math.min(Math.max((t - ORB) / GATHER, 0), 1));
      gl.uniform1f(U.uSpread, reduced ? 1 : Math.min(Math.max((t - ORB - GATHER - HOLD) / SPREAD, 0), 1));
      // Once the paw has spread, the shader no longer reads its relief: drop
      // the buffer and feed the attribute a constant instead.
      if (intro && t >= ORB + GATHER + HOLD + SPREAD) endIntro();
      gl.uniform1f(U.uScroll, scrollS);
      gl.uniform1f(U.uPan, reduced ? 0 : pan);
      gl.uniform1f(U.uDim, dim);
      gl.uniform1f(U.uPaw, paw);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, N);
      requestAnimationFrame(frame);
    }

    function endIntro() {
      intro = false;
      gl.disableVertexAttribArray(A.relief.loc);
      gl.vertexAttrib3f(A.relief.loc, 0, 0, 0);
      gl.deleteBuffer(A.relief.buf);
    }
    if (!intro) endIntro();

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
          live.fill(1);
          for (let i = 0; i < N; i++) moving[i] = i;
          liveCount = N; listed = true;
        }
        clearTimeout(this._t);
        this._t = setTimeout(() => { pawTarget = 0; }, 3600);
      }
    };
  }
  let grain = null;
  try { grain = createGrain(); } catch (err) { console.warn(err); }
  if (!grain) reveal();   // no grain, so nothing to wait for

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

    // The project nearest the middle of the screen is the one in focus. A project
    // with its case study open stays in focus for as long as it spans the middle,
    // so the text being read is never the dimmed one.
    let best = null, bestDist = Infinity;
    projects.forEach(p => {
      const r = p.getBoundingClientRect();
      const mid = r.top + Math.min(r.height, vh * 0.7) / 2;
      const reading = p.querySelector('details[open]') && r.top < vh * 0.48 && r.bottom > vh * 0.48;
      const dist = reading ? -1 : Math.abs(mid - vh * 0.48);
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

  /* ---------- Case studies ---------- */
  // Opening or closing a case study changes the page height, so recheck focus.
  $$('details').forEach(d => d.addEventListener('toggle', queueScroll));
  // The button at the end of a long case study closes it and returns to its summary.
  $$('.case__close').forEach(btn => btn.addEventListener('click', () => {
    const details = btn.closest('details'), summary = $('summary', details);
    details.open = false;
    summary.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    summary.focus({ preventScroll: true });
  }));

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
  // A dot sits exactly on the pointer. A faint neon ring trails it with two
  // glowing orbs circling on opposite sides. Over anything clickable, or
  // whatever the keyboard has just focused, that same ring wraps the
  // element's outline instead and the orbs carry on round it, so there is
  // only ever one pair on screen.
  const dot = $('#cursorDot'), ring = $('#cursorRing'), label = $('#cursorLabel');
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    root.classList.add('has-cursor');
    const svg = $('svg', ring), path = $('#cursorShape'), [orbA, orbB] = $$('.cursor__orb', ring);
    const lb = $('#lightbox'), lbVid = $('video', lb);
    const TARGETS = 'a, button, summary, [data-cursor]';
    const FREE = 34, PRESSED = 26, SHOWN = { visibilityProperty: true };
    let mx = 0, my = 0, rx = 0, ry = 0, placed = false, inside = false, pressed = false;
    // over: what the pointer is on. focused: what the keyboard focused. byKey:
    // the keyboard moved last, so the focused element owns the ring.
    let over = null, focused = null, byKey = false;
    let lock = null, pad = 0, rad = 0, shown = false, snap = true, recheckUntil = 0;
    // The ring's box (centre, size, corner radius), what was last drawn, and
    // where the first orb is as a share of the way round.
    let cx = 0, cy = 0, w = FREE, h = FREE, r = FREE / 2, dw = 0, dh = 0, dr = -1, len = 1, phase = 0;
    let last = performance.now();

    // Each orb trails a short comet tail along the outline: a row of soft dots
    // packed close enough to overlap into one smooth streak, each a little
    // smaller and fainter than the one before, shading from cyan through
    // violet to pink. The two tails share one set of blends, one per step.
    // With reduced motion the orbs stay put, so there are no tails.
    const TRAIL = reduced ? 0 : 28, NS = 'http://www.w3.org/2000/svg';
    const tailA = [], tailB = [], defs = $('defs', svg), tails = document.createElementNS(NS, 'g');
    const tint = t => t < 0.5
      ? [64 + 99 * t * 2, 235 - 133 * t * 2, 255]
      : [163 + 92 * (t * 2 - 1), 102 - 15 * (t * 2 - 1), 255 - 56 * (t * 2 - 1)];
    for (let i = 0; i < TRAIL; i++) {
      const t = (i + 1) / TRAIL, fade = Math.pow(1 - t, 1.5);
      const c = `rgb(${tint(t).map(Math.round)})`, grad = document.createElementNS(NS, 'radialGradient');
      grad.id = `cursorTrail${i}`;
      grad.innerHTML = `<stop offset="0" stop-color="${c}"/><stop offset=".45" stop-color="${c}" stop-opacity=".5"/><stop offset="1" stop-color="${c}" stop-opacity="0"/>`;
      defs.appendChild(grad);
      for (const tail of [tailA, tailB]) {
        const dotEl = document.createElementNS(NS, 'circle');
        dotEl.setAttribute('r', (1.2 + 3.3 * Math.pow(1 - t, 0.8)).toFixed(2));
        dotEl.setAttribute('fill', `url(#${grad.id})`);
        dotEl.setAttribute('fill-opacity', (0.75 * fade).toFixed(3));
        // Fainter steps go underneath, so the bright head stays on top.
        tails.insertBefore(dotEl, tails.firstChild);
        tail.push(dotEl);
      }
    }
    tails.setAttribute('class', 'cursor__trail');
    svg.insertBefore(tails, orbA);

    // The ring never wraps the lightbox backdrop or its video, nor anything
    // behind the lightbox while it is open.
    const frameable = el => !!el && el !== lb && el !== lbVid && (!lb.classList.contains('is-open') || lb.contains(el));
    function hoverFrom(el) {
      const target = el && el.closest(TARGETS);
      over = frameable(target) ? target : null;
      // Over the video, its own controls and the system pointer take over.
      root.classList.toggle('cursor-native', !!el && el === lbVid);
      const text = target && target.dataset.cursor;
      root.classList.toggle('cursor-labelled', !!text);
      if (text && label.textContent !== text) label.textContent = text;
    }
    // Things can move or vanish under a still pointer (scrolling, the lightbox,
    // a case study opening), so look again at what is under it for a moment.
    const recheck = () => { recheckUntil = performance.now() + 450; };
    // The point a share s of the way round the outline as drawn, clockwise
    // from the left end of its top edge, where SVG starts a rounded rect.
    // The second half of the lap is the first half mirrored through the centre.
    function along(s) {
      if (s >= 0.5) { const [x, y] = along(s - 0.5); return [dw - x, dh - y]; }
      const sx = dw - 2 * dr, sy = dh - 2 * dr, q = Math.PI * dr / 2;
      let d = s * len;
      if (d <= sx) return [dr + d, 0];
      d -= sx;
      if (dr > 0 && d <= q) return [dw - dr + dr * Math.sin(d / dr), dr - dr * Math.cos(d / dr)];
      d -= q;
      if (d <= sy) return [dw, dr + d];
      const a = dr > 0 ? Math.min(d - sy, q) / dr : 0;
      return [dw - dr + dr * Math.cos(a), dh - dr + dr * Math.sin(a)];
    }

    addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') { inside = false; root.classList.remove('cursor-on'); return; }
      mx = e.clientX; my = e.clientY;
      if (!placed) { rx = mx; ry = my; placed = true; }
      inside = true; byKey = false;
      if (pressed && !e.buttons) pressed = false;
      root.classList.add('cursor-on');
      dot.style.transform = `translate(${mx}px, ${my}px)`;
      hoverFrom(e.target);
    }, { passive: true });
    const away = () => {
      inside = pressed = false; over = null;
      root.classList.remove('cursor-on', 'cursor-labelled', 'cursor-native');
    };
    document.addEventListener('mouseleave', away);
    addEventListener('blur', away);
    addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') pressed = true; });
    addEventListener('pointerup', () => { pressed = false; });
    addEventListener('pointercancel', () => { pressed = false; });
    addEventListener('scroll', recheck, { passive: true });
    addEventListener('resize', recheck);
    addEventListener('click', recheck);
    addEventListener('keydown', recheck);
    document.addEventListener('toggle', recheck, true);

    // Keyboard focus moves the ring there without the mouse. A mouse click
    // focuses things too, but does not match :focus-visible, so it is ignored.
    document.addEventListener('focusin', e => {
      const el = e.target;
      focused = el.matches(TARGETS) && el.matches(':focus-visible') && frameable(el) ? el : null;
      if (focused) byKey = true;
    });
    document.addEventListener('focusout', e => { if (e.target === focused) focused = null; });

    (function follow() {
      const now = performance.now();
      const dt = Math.min((now - last) / 16.667, 3) || 1;
      last = now;
      if (inside && !byKey && now < recheckUntil) hoverFrom(document.elementFromPoint(mx, my));

      let want = byKey && focused ? focused : inside ? over : null, b = null;
      if (want) {
        b = want.getBoundingClientRect();
        if (!want.isConnected || (!b.width && !b.height) || (want.checkVisibility && !want.checkVisibility(SHOWN))) {
          // Gone or hidden: let go, and look again at what the pointer is on.
          if (want === focused) focused = null;
          if (want === over) { over = null; recheck(); }
          want = b = null;
        }
      }
      if (want !== lock) {
        if (lock) lock.classList.remove('is-cursor-target');
        lock = want;
        root.classList.toggle('cursor-locked', !!lock);
        if (lock) {
          lock.classList.add('is-cursor-target');
          // The hero buttons draw their own edge, so the ring sits on it.
          // Anything else gets a little room, rounded like the element.
          pad = lock.matches('.home__actions a') ? 1 : 6;
          rad = (parseFloat(getComputedStyle(lock).borderTopLeftRadius) || 2) + pad;
        }
      }

      // Where the ring should be: round the locked element, else on the pointer.
      let tx = mx, ty = my, tw = pressed ? PRESSED : FREE, th = tw, tr = tw / 2;
      if (lock) {
        const p = pressed ? pad - 2 : pad;
        tx = b.left + b.width / 2; ty = b.top + b.height / 2;
        tw = b.width + p * 2; th = b.height + p * 2;
        tr = Math.min(rad - pad + p, tw / 2, th / 2);
      }

      const show = !!lock || inside;
      if (show !== shown) { shown = show; root.classList.toggle('cursor-ring-on', show); }
      if (!show) snap = true;
      else {
        // Appearing: start in place rather than flying in from the last spot.
        // Reduced motion: always go straight there.
        const kp = snap || reduced ? 1 : 1 - Math.pow(lock ? 0.7 : 0.83, dt);
        const ks = snap || reduced ? 1 : 1 - Math.pow(0.7, dt);
        snap = false;
        cx += (tx - cx) * kp; cy += (ty - cy) * kp;
        w += (tw - w) * ks; h += (th - h) * ks; r += (tr - r) * ks;
        r = Math.min(r, w / 2, h / 2);
        if (Math.abs(w - dw) > 0.05 || Math.abs(h - dh) > 0.05 || Math.abs(r - dr) > 0.05) {
          dw = w; dh = h; dr = r;
          svg.setAttribute('width', w); svg.setAttribute('height', h);
          path.setAttribute('width', w); path.setAttribute('height', h); path.setAttribute('rx', r);
          // Perimeter of the rounded rectangle.
          len = 2 * (w + h) - (8 - 2 * Math.PI) * r;
        }
        ring.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px)`;
        // One lap takes longer round bigger things, within limits. The phase is
        // a share of the way round, so it carries on unbroken as the ring
        // changes shape. With reduced motion the orbs stay put.
        if (!reduced) phase = (phase + dt * 0.016667 / Math.min(Math.max(len / 170, 1.8), 4.5)) % 1;
        // The outline is the same turned half round, so the second orb, half a
        // lap on, is the first one mirrored through the centre.
        const [ox, oy] = along(phase);
        orbA.setAttribute('cx', ox); orbA.setAttribute('cy', oy);
        orbB.setAttribute('cx', dw - ox); orbB.setAttribute('cy', dh - oy);
        // The tails run back along the outline as drawn, so they bend round
        // corners with it. They are a little longer round bigger things,
        // within limits, and the second is the first mirrored like its orb.
        const gap = Math.min(Math.max(len * 0.1, 22), 70) / TRAIL / len;
        for (let i = 0; i < TRAIL; i++) {
          const [x, y] = along(((phase - (i + 1) * gap) % 1 + 1) % 1);
          tailA[i].setAttribute('cx', x); tailA[i].setAttribute('cy', y);
          tailB[i].setAttribute('cx', dw - x); tailB[i].setAttribute('cy', dh - y);
        }
      }

      rx += (mx - rx) * 0.17; ry += (my - ry) * 0.17;
      if (reduced) { rx = mx; ry = my; }
      label.style.transform = `translate(${rx}px, ${ry}px)`;
      requestAnimationFrame(follow);
    })();
  }

  /* ---------- Screenshots: click to view full size ---------- */
  const box = $('#lightbox'), boxImg = $('img', box), boxVid = $('video', box), boxCap = $('p', box);
  let group = [], at = 0, opener = null, pageY = 0;
  // Stop the clip and drop its source, so nothing keeps playing or loading unseen.
  function stopVideo() {
    if (!boxVid.hasAttribute('src')) return;
    boxVid.pause();
    boxVid.removeAttribute('src');
    boxVid.load();
  }
  function showShot(i) {
    at = (i + group.length) % group.length;
    const img = $('img', group[at]), video = group[at].dataset.video;
    // Screenshots are captured at 2x, so half the pixel width is true size.
    const width = img.naturalWidth ? img.naturalWidth / 2 + 'px' : '';
    stopVideo();
    boxImg.hidden = !!video;
    boxVid.hidden = !video;
    if (video) {
      boxVid.poster = img.currentSrc || img.src;
      boxVid.src = video;
      boxVid.setAttribute('aria-label', img.alt);
      boxVid.style.width = width;
      boxVid.style.aspectRatio = `${img.getAttribute('width')} / ${img.getAttribute('height')}`;
      // Focus the player so its controls work from the keyboard.
      boxVid.focus({ preventScroll: true });
      // Start by itself, silently. If the browser refuses, or motion is turned
      // down, the poster and the player's own controls are still there.
      boxVid.muted = true;
      if (!calm.matches) boxVid.play().catch(() => {});
    } else {
      boxImg.src = img.currentSrc || img.src;
      boxImg.alt = img.alt;
      boxImg.style.width = width;
    }
    boxCap.textContent = img.alt + (group.length > 1 ? `  (${at + 1} of ${group.length})` : '');
    box.scrollTop = 0;
  }
  function closeShot() {
    if (!box.classList.contains('is-open')) return;
    stopVideo();
    box.classList.remove('is-open');
    root.classList.remove('is-locked');
    // Taking the scroll lock off can put the page back at the top in some
    // browsers, so return to where it was, without the smooth scroll.
    if (scrollY !== pageY) scrollTo({ top: pageY, behavior: 'instant' });
    syncClips();
    if (opener) opener.focus({ preventScroll: true });
  }
  $$('.shot').forEach(btn => btn.addEventListener('click', () => {
    opener = btn;
    pageY = scrollY;
    group = $$('.shot', btn.closest('.shots'));
    box.classList.add('is-open');
    root.classList.add('is-locked');
    syncClips();
    showShot(group.indexOf(btn));
  }));
  // A click on the player is for its controls, not for closing.
  box.addEventListener('click', e => { if (e.target !== boxVid) closeShot(); });
  addEventListener('keydown', e => {
    if (!box.classList.contains('is-open')) return;
    if (e.key === 'Escape') closeShot();
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (e.composedPath().includes(boxVid) || document.activeElement === boxVid) return;
      e.preventDefault();
      showShot(at + (e.key === 'ArrowRight' ? 1 : -1));
    }
  });

  /* ---------- Screenshots: clips play by themselves in the row ---------- */
  // A shot with a clip loops it, muted, over its still image while it is on
  // screen. The still stays underneath, so it is what shows until the clip is
  // really playing, and whenever it cannot or should not play.
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const clips = $$('.shot[data-video]').map(btn => ({ btn, video: null, seen: false }));
  function playClip(clip) {
    if (!clip.video) {
      // Made on first use, so the clip is only fetched once it is wanted.
      const v = clip.video = document.createElement('video');
      v.muted = v.defaultMuted = v.loop = v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.disablePictureInPicture = true;
      v.preload = 'none';
      v.tabIndex = -1;
      v.setAttribute('aria-hidden', 'true');   // the still's alt text already describes it
      v.addEventListener('playing', () => clip.btn.classList.add('is-playing'));
      v.addEventListener('error', () => clip.btn.classList.remove('is-playing'));
      v.src = clip.btn.dataset.video;
      clip.btn.append(v);
    }
    if (!clip.video.paused) return;
    const started = clip.video.play();
    // Refused (autoplay blocked, low power mode): leave the still showing.
    if (started) started.catch(() => { if (clip.video.paused) clip.btn.classList.remove('is-playing'); });
  }
  function syncClips() {
    const hold = calm.matches || document.hidden || box.classList.contains('is-open');
    clips.forEach(clip => {
      if (!hold && clip.seen) return playClip(clip);
      if (clip.video) clip.video.pause();
      // With motion turned down, go back to the still, not a frozen frame.
      if (calm.matches) clip.btn.classList.remove('is-playing');
    });
  }
  if (clips.length) {
    const clipIO = new IntersectionObserver(entries => {
      entries.forEach(e => { clips.find(clip => clip.btn === e.target).seen = e.isIntersecting && e.intersectionRatio >= 0.25; });
      syncClips();
    }, { threshold: 0.25 });
    clips.forEach(clip => clipIO.observe(clip.btn));
    document.addEventListener('visibilitychange', syncClips);
    calm.addEventListener('change', () => {
      if (calm.matches) boxVid.pause();
      syncClips();
    });
  }

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
