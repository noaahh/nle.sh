// each .profile carries its data as attributes: altitude and heart rate
// per art column, total distance in km. tools/profile.py generates them.
document.querySelectorAll('.profile').forEach((wrap) => {
  const prof = JSON.parse(wrap.dataset.prof);
  const bpm = wrap.dataset.bpm ? JSON.parse(wrap.dataset.bpm) : null;
  const KM = parseFloat(wrap.dataset.km);
  const W = prof.length;
  const pre = wrap.querySelector('pre');
  const hair = wrap.querySelector('.hairline');
  const out = wrap.querySelector('.readout');
  let charW = 0;
  let replay = null;
  let cursor = -1; // art column the hairline is on, mirrored onto the terrain

  const measure = () => {
    const s = document.createElement('span');
    s.textContent = '0'.repeat(W);
    s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    pre.appendChild(s);
    charW = s.getBoundingClientRect().width / W;
    s.remove();
  };

  const show = (col) => {
    hair.style.left = ((col + 0.5) * charW - pre.scrollLeft) + 'px';
    hair.style.display = 'block';
    out.textContent = ((col + 0.5) / W * KM).toFixed(1) + ' km · ' + prof[col] + ' m'
      + (bpm ? ' · ' + bpm[col] + ' bpm' : '');
    out.style.display = 'block';
    cursor = col;
  };

  const hide = () => {
    hair.style.display = 'none';
    out.style.display = 'none';
    cursor = -1;
  };

  const endReplay = () => {
    if (replay) cancelAnimationFrame(replay);
    replay = null;
    pre.style.clipPath = '';
    hide();
  };

  // replay the recording once: the pen sweeps, the curve draws in behind it
  const startReplay = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    measure();
    const D = 2800;
    const artW = W * charW;
    const t0 = performance.now();
    pre.style.clipPath = 'inset(0 100% 0 0)';
    const tick = (t) => {
      if (!replay) return;
      const p = Math.min(1, (t - t0) / D);
      const x = p * artW;
      pre.style.clipPath = 'inset(0 ' + Math.max(0, pre.clientWidth - x) + 'px 0 0)';
      show(Math.min(W - 1, Math.floor(x / charW)));
      if (p < 1) replay = requestAnimationFrame(tick);
      else endReplay();
    };
    replay = requestAnimationFrame(tick);
  };

  const move = (e) => {
    if (replay) endReplay();
    if (!charW) measure();
    const left = pre.getBoundingClientRect().left - pre.scrollLeft;
    show(Math.max(0, Math.min(W - 1, Math.floor((e.clientX - left) / charW))));
  };

  pre.addEventListener('pointermove', move);
  pre.addEventListener('pointerdown', move);
  pre.addEventListener('pointerleave', () => { if (!replay) hide(); });
  addEventListener('resize', () => { charW = 0; });
  const canvas = wrap.parentNode.querySelector('.terrain');
  const colX = (c) => { if (!charW) measure(); return (c + 0.5) * charW; };
  // pointing at the map drives the profile the same way pointing at the profile does
  const pick = (col) => {
    if (replay) endReplay();
    if (!charW) measure();
    if (col < 0) hide(); else show(col);
  };
  if (canvas && wrap.dataset.dem) terrain(canvas, wrap.dataset.dem.split(','),
    JSON.parse(wrap.dataset.route), pre, colX, () => cursor, pick, startReplay);
  else startReplay();
});

// the country around the route as a dotted heightfield, tinted by altitude
// and hill-shaded, fading out with distance from the track (red). it rises
// from flat when scrolled into view and sways slowly; the pointer tilts it
// and moves the sun, dragging spins it, and pointing near the track drives
// the profile. at rest the track sits right above the profile's columns.
// data-dem is gw,gh,lo,hi,cell_m,base64 of one byte per cell (north row
// first); data-route is gx,gy pairs, four per art column.
// tools/profile.py --terrain generates both.
function terrain(canvas, dem, route, pre, colX, getCursor, pick, reveal) {
  const [gw, gh, lo, hi, cellM] = dem.slice(0, 5).map(Number);
  const raw = atob(dem[5]);
  const EX = 1.6; // vertical exaggeration
  const H = new Float32Array(gw * gh);
  for (let k = 0; k < H.length; k++) H[k] = raw.charCodeAt(k) / 255 * (hi - lo) / cellM * EX;
  const at = (x, y) => {
    x = Math.max(0, Math.min(gw - 1.001, x));
    y = Math.max(0, Math.min(gh - 1.001, y));
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, k = j * gw + i;
    return (H[k] * (1 - fx) + H[k + 1] * fx) * (1 - fy) + (H[k + gw] * (1 - fx) + H[k + gw + 1] * fx) * fy;
  };

  // distance from every cell to the track, for the fade
  const R0 = 4, R1 = 24, dist = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let d = Infinity;
      for (let k = 0; k < route.length; k += 2) d = Math.min(d, (route[k] - i) ** 2 + (route[k + 1] - j) ** 2);
      dist[j * gw + i] = Math.sqrt(d);
    }
  }

  // world: x east, y up, z south (toward the viewer), centred on the track.
  // per point: x, y, z, unit normal, fade, altitude byte
  const W = route.length / 8, rx0 = route[2], rx1 = route[(W - 1) * 8 + 2];
  let oz = 0;
  for (let k = 1; k < route.length; k += 2) oz += route[k] / (route.length / 2);
  const ox = (rx0 + rx1) / 2, mid = (hi - lo) / cellM * EX / 2;
  const pts = [], st = 0.25;
  for (let y = 0; y <= gh - 1; y += st) {
    for (let x = 0; x <= gw - 1; x += st) {
      const f = Math.min(1, 1 - (dist[Math.round(y) * gw + Math.round(x)] - R0) / (R1 - R0));
      if (f <= 0) continue;
      const h = at(x, y);
      const nx = at(x - 0.5, y) - at(x + 0.5, y), nz = at(x, y - 0.5) - at(x, y + 0.5), n = Math.hypot(nx, 1, nz);
      pts.push(x - ox, h - mid, y - oz, nx / n, 1 / n, nz / n, f * f * (3 - 2 * f), Math.round(h / (2 * mid) * 255));
    }
  }
  const PT = new Float32Array(pts);
  const cols = []; // screen-space anchor per art column, for picking
  const trk = [];
  for (let k = 0; k + 3 < route.length; k += 2) {
    for (let f = 0; f < 1; f += 0.25) {
      const x = route[k] + (route[k + 2] - route[k]) * f, y = route[k + 1] + (route[k + 3] - route[k + 1]) * f;
      trk.push(x - ox, at(x, y) - mid + 0.3, y - oz);
    }
  }

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const PITCH = 0.75, SWAY = 0.3, RISE = 2800, P = 2;
  const YAW_MAX = 0.5, TILT = 0.15; // how far the pointer and drag may turn it
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ctx, img, dpr, cw, ch, s, cx, cy0, gx, gy, zbuf, win, lut, red;

  // altitude tints between the CSS stops, one rgb triple per altitude byte
  const hex = (v) => v.trim().match(/\w\w/g).map((c) => parseInt(c, 16));
  const tints = () => {
    const cs = getComputedStyle(document.body);
    const stops = [[1300, '--forest'], [1700, '--meadow'], [2250, '--rock'], [2650, '--summit']]
      .map(([m, v]) => [m, hex(cs.getPropertyValue(v))]);
    lut = new Uint8Array(256 * 3);
    for (let b = 0; b < 256; b++) {
      const m = lo + b / 255 * (hi - lo);
      let i = 0;
      while (i < stops.length - 2 && m > stops[i + 1][0]) i++;
      const t = Math.max(0, Math.min(1, (m - stops[i][0]) / (stops[i + 1][0] - stops[i][0])));
      for (let c = 0; c < 3; c++) lut[b * 3 + c] = stops[i][1][c] + (stops[i + 1][1][c] - stops[i][1][c]) * t;
    }
    red = cs.getPropertyValue('--red');
  };

  const size = () => {
    cw = canvas.clientWidth;
    // scale so the track's first and last columns land over the profile's,
    // unless that overflows (narrow screens): then just fit the width
    s = (colX(W - 1) - colX(0)) / (rx1 - rx0);
    cx = pre.getBoundingClientRect().left - canvas.getBoundingClientRect().left + (colX(0) + colX(W - 1)) / 2;
    const fit = cw / (rx1 - rx0 + 1.2 * R1);
    if (s > fit) { s = fit; cx = cw / 2; }
    // fit the top to every view it can reach, the bottom only to the
    // resting sway: a hard drag may clip the faint fringe, not the peaks
    let top = Infinity, bot = -Infinity;
    for (const yaw of [-YAW_MAX, -SWAY, 0, SWAY, YAW_MAX]) {
      for (const pitch of [PITCH - TILT, PITCH, PITCH + TILT]) {
        const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
        const rest = pitch === PITCH && Math.abs(yaw) <= SWAY;
        for (let k = 0; k < PT.length; k += 8) {
          if (PT[k + 6] < 0.3) continue;
          const v = PT[k + 1] * cp - (-PT[k] * sy + PT[k + 2] * cy) * sp;
          bot = Math.max(bot, v); // highest on screen
          if (rest) top = Math.min(top, v); // lowest on screen
        }
      }
    }
    ch = Math.ceil((bot - top) * s) + 8;
    cy0 = bot * s + 4;
    dpr = devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.height = ch + 'px';
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    img = ctx.createImageData(canvas.width, canvas.height);
    gx = Math.ceil(cw / P);
    gy = Math.ceil(ch / P);
    zbuf = new Float32Array(gx * gy);
    win = new Int32Array(gx * gy);
    tints();
  };

  // view state. each value eases toward a target with a damped spring
  const spring = (v) => ({ v, to: v, vel: 0 });
  const step = (a, k = 0.06, damp = 0.78) => { a.vel = (a.vel + (a.to - a.v) * k) * damp; a.v += a.vel; };
  const yaw = spring(0), pitch = spring(PITCH), az = spring(-2.45), el = spring(0.8), calm = spring(1);
  let drag = null, spin = 0, spun = 0, hover = 0; // spun: rotation added by dragging

  const draw = (sway, rise) => {
    const Y = sway * calm.v + yaw.v;
    const cy = Math.cos(Y), sy = Math.sin(Y), cp = Math.cos(pitch.v), sp = Math.sin(pitch.v);
    const L = [Math.cos(el.v) * Math.cos(az.v), Math.sin(el.v), Math.cos(el.v) * Math.sin(az.v)];
    let px = 0, py = 0, pz = 0;
    const proj = (X, Yw, Z) => {
      Yw *= rise;
      const x1 = X * cy + Z * sy, z1 = -X * sy + Z * cy;
      px = cx + x1 * s;
      py = cy0 - (Yw * cp - z1 * sp) * s;
      pz = Yw * sp + z1 * cp;
      const c = Math.floor(px / P), r = Math.floor(py / P);
      return c < 0 || r < 0 || c >= gx || r >= gy ? -1 : r * gx + c;
    };
    zbuf.fill(-Infinity);
    for (let k = 0; k < PT.length; k += 8) {
      const g = proj(PT[k], PT[k + 1], PT[k + 2]);
      if (g >= 0 && pz > zbuf[g]) { zbuf[g] = pz; win[g] = k; }
    }
    // dots straight into a pixel buffer: each one needs its own colour
    const d = img.data, iw = img.width, ds = Math.max(1, Math.round(1.5 * dpr));
    d.fill(0);
    for (let g = 0; g < zbuf.length; g++) {
      if (zbuf[g] === -Infinity) continue;
      const k = win[g], c = g % gx, r = (g - c) / gx, fade = PT[k + 6];
      if (fade < BAYER[(r % 4) * 4 + (c % 4)]) continue; // ordered dither thins the fade
      const lit = Math.max(0, PT[k + 3] * L[0] + PT[k + 4] * L[1] + PT[k + 5] * L[2]);
      const a = (lit > 0.75 ? 0.3 : lit > 0.45 ? 0.6 : 0.9) * (0.5 + 0.5 * fade) * 255;
      const t = PT[k + 7] * 3, x0 = Math.round(c * P * dpr), y0 = Math.round(r * P * dpr);
      for (let yy = y0; yy < y0 + ds; yy++) {
        for (let xx = x0, o = (yy * iw + x0) * 4; xx < x0 + ds; xx++, o += 4) {
          d[o] = lut[t]; d[o + 1] = lut[t + 1]; d[o + 2] = lut[t + 2]; d[o + 3] = a;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = red;
    for (let k = 0; k < trk.length; k += 3) {
      if (proj(trk[k], trk[k + 1], trk[k + 2]) >= 0) ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
      if (k / 3 % 16 === 8) cols[(k / 3 - 8) / 16] = [px, py]; // route point 4c + 2
    }
    const col = getCursor();
    if (col >= 0 && cols[col]) {
      const [mx, my] = cols[col];
      ctx.fillRect(mx - 2.5, my - 2.5, 5, 5);
      // connector down to the profile's hairline
      const hx = pre.getBoundingClientRect().left - canvas.getBoundingClientRect().left + colX(col) - pre.scrollLeft;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(mx, my + 4);
      ctx.lineTo(hx, ch);
      ctx.strokeStyle = red;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };

  // pointer: hovering tilts the view toward the pointer and swings the sun
  // across the northern sky; near the track it scrubs the profile
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e), u = x / cw - 0.5, v = y / ch - 0.5;
    if (drag !== null) {
      spin = (x - drag) * 0.006;
      drag = x;
      spun += spin;
    } else if (e.pointerType === 'mouse') {
      hover = u * 0.35;
      pitch.to = PITCH + v * 2 * TILT;
    }
    az.to = -Math.PI + (u + 0.5) * Math.PI;
    el.to = 0.45 + (0.5 - v) * 0.7;
    calm.to = 0;
    let best = -1, bd = 24 * 24;
    cols.forEach(([px, py], c) => {
      const dd = (px - x) ** 2 + (py - y) ** 2;
      if (dd < bd) { bd = dd; best = c; }
    });
    pick(best);
  });
  canvas.addEventListener('pointerdown', (e) => {
    drag = local(e)[0];
    spin = 0;
    canvas.setPointerCapture(e.pointerId);
  });
  const release = () => {
    if (drag === null) return;
    drag = null; // spin carries on in the loop and decays
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => {
    if (drag !== null) return;
    hover = 0;
    pitch.to = PITCH;
    az.to = -2.45;
    el.to = 0.8;
    calm.to = 1;
    pick(-1);
  });

  size();
  addEventListener('resize', size);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', tints);
  let visible = false, t0 = null;
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && t0 === null) { t0 = performance.now(); reveal(); }
  }, { threshold: 0.4 }).observe(canvas);
  const loop = (t) => {
    if (visible) {
      if (drag === null) { spun = (spun + spin) * 0.985; spin *= 0.92; }
      spun = Math.max(-YAW_MAX, Math.min(YAW_MAX, spun));
      yaw.to = hover + spun;
      for (const a of [yaw, pitch, az, el]) step(a);
      step(calm, 0.02, 0.9);
      const p = still ? 1 : Math.min(1, (t - t0) / RISE);
      draw(still ? 0 : SWAY * Math.sin((t - t0) / 18000 * 2 * Math.PI), 1 - (1 - p) ** 3);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
