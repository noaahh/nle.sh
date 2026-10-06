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
  let invalidate = () => {};

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
    invalidate();
  };

  const hide = () => {
    hair.style.display = 'none';
    out.style.display = 'none';
    cursor = -1;
    invalidate();
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
  pre.addEventListener('scroll', () => { if (cursor >= 0) show(cursor); });
  addEventListener('resize', () => { charW = 0; });
  const canvas = wrap.parentNode.querySelector('.terrain');
  const colX = (c) => { if (!charW) measure(); return (c + 0.5) * charW; };
  // pointing at the map drives the profile the same way pointing at the profile does
  const pick = (col) => {
    if (replay) endReplay();
    if (!charW) measure();
    if (col < 0) hide(); else show(col);
  };
  const init = async () => {
    if (!canvas || !wrap.dataset.dem) { startReplay(); return; }
    let dem = wrap.dataset.dem.split(','), route = JSON.parse(wrap.dataset.route);
    const figure = wrap.parentNode;
    canvas.dataset.source = 'Terrarium';
    if (figure.dataset.terrainSrc) {
      try {
        const response = await fetch(figure.dataset.terrainSrc, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Terrain data: ${response.status}`);
        const data = await response.json();
        const [w, h, lo, hi, cell] = data.dem;
        if (![w, h, lo, hi, cell, ...data.route].every(Number.isFinite)
          || w < 2 || h < 2 || hi <= lo || cell <= 0 || data.dem[6] !== 'u16'
          || atob(data.dem[5]).length !== w * h * 2 || data.route.length !== W * 8) {
          throw new Error('Invalid terrain data');
        }
        dem = data.dem; route = data.route;
        canvas.dataset.source = data.source;
        const credit = document.createElement('a');
        credit.className = 'terrain-source';
        credit.href = 'https://www.swisstopo.admin.ch/en/height-model-swissalti3d';
        credit.textContent = '©swisstopo';
        figure.querySelector('figcaption').insertBefore(credit, figure.querySelector('.terrain-hint'));
      } catch (error) {
        // The embedded original keeps the figure usable offline or if fetching fails.
        console.warn('Using embedded terrain:', error.message);
      }
    }
    invalidate = terrain(canvas, dem, route, pre, colX, () => cursor, pick, startReplay);
    canvas.dataset.ready = 'true';
  };
  init();
});

// the country around the route as a dotted heightfield, tinted by altitude
// and hill-shaded, fading out with distance from the track (red). it rises
// from flat when scrolled into view. Dragging freely turns the relief;
// unfolding flattens the same geometry into a north-up contour map.
// Pointing near the track drives the profile in either representation.
// data-dem is gw,gh,lo,hi,cell_m,base64 of one byte per cell (north row
// first); an optional seventh field 'u16' selects little-endian 16-bit heights.
// data-route is gx,gy pairs, four per art column.
// tools/profile.py --terrain generates both.
function terrain(canvas, dem, route, pre, colX, getCursor, pick, reveal) {
  const [gw, gh, lo, hi, cellM] = dem.slice(0, 5).map(Number);
  const raw = atob(dem[5]);
  const fine = dem[6] === 'u16';
  const EX = 1.6; // vertical exaggeration
  const H = new Float32Array(gw * gh);
  for (let k = 0; k < H.length; k++) {
    const height = fine ? (raw.charCodeAt(k * 2) | raw.charCodeAt(k * 2 + 1) << 8) / 65535 : raw.charCodeAt(k) / 255;
    H[k] = height * (hi - lo) / cellM * EX;
  }
  const at = (x, y) => {
    x = Math.max(0, Math.min(gw - 1.001, x));
    y = Math.max(0, Math.min(gh - 1.001, y));
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, k = j * gw + i;
    return (H[k] * (1 - fx) + H[k + 1] * fx) * (1 - fy) + (H[k + gw] * (1 - fx) + H[k + gw + 1] * fx) * fy;
  };

  // distance from every cell to the track, for the fade
  const R0 = fine ? 400 / cellM : 4, R1 = fine ? 2400 / cellM : 24;
  const dist = new Float32Array(gw * gh);
  const squared = new Float64Array(gw * gh).fill(R1 * R1);
  // Cells farther than R1 are invisible. Visit each route point's local
  // neighbourhood instead of comparing every cell with the whole route.
  for (let k = 0; k < route.length; k += 2) {
    const x = route[k], y = route[k + 1];
    const left = Math.max(0, Math.ceil(x - R1)), right = Math.min(gw - 1, Math.floor(x + R1));
    const top = Math.max(0, Math.ceil(y - R1)), bottom = Math.min(gh - 1, Math.floor(y + R1));
    for (let j = top; j <= bottom; j++) {
      for (let i = left; i <= right; i++) {
        const g = j * gw + i, d = (x - i) ** 2 + (y - j) ** 2;
        if (d < squared[g]) squared[g] = d;
      }
    }
  }
  // Keep the world-space dot spacing comparable across source resolutions.
  const subdivisions = fine ? cellM / 25 : 4;
  const samples = (i, n) => Math.max(0,
    Math.min(Math.floor((n - 1) * subdivisions), Math.ceil((i + 0.5) * subdivisions) - 1)
    - Math.max(0, Math.ceil((i - 0.5) * subdivisions)) + 1);
  let count = 0;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const g = j * gw + i;
      dist[g] = Math.sqrt(squared[g]);
      if (dist[g] < R1) count += samples(i, gw) * samples(j, gh);
    }
  }

  // world: x east, y up, z south (toward the viewer), centred on the track.
  // per point: x, y, z, unit normal, fade, altitude byte
  const W = route.length / 8, rx0 = route[2], rx1 = route[(W - 1) * 8 + 2];
  let oz = 0;
  for (let k = 1; k < route.length; k += 2) oz += route[k] / (route.length / 2);
  const ox = (rx0 + rx1) / 2, mid = (hi - lo) / cellM * EX / 2;
  const PT = new Float32Array(count * 8), st = 1 / subdivisions;
  let offset = 0;
  for (let row = 0; row <= (gh - 1) * subdivisions; row++) {
    const y = row * st;
    for (let column = 0; column <= (gw - 1) * subdivisions; column++) {
      const x = column * st;
      const f = Math.min(1, 1 - (dist[Math.round(y) * gw + Math.round(x)] - R0) / (R1 - R0));
      if (f <= 0) continue;
      const h = at(x, y);
      const nx = at(x - 0.5, y) - at(x + 0.5, y), nz = at(x, y - 0.5) - at(x, y + 0.5);
      const n = Math.sqrt(nx * nx + 1 + nz * nz);
      PT[offset++] = x - ox; PT[offset++] = h - mid; PT[offset++] = y - oz;
      PT[offset++] = nx / n; PT[offset++] = 1 / n; PT[offset++] = nz / n;
      PT[offset++] = f * f * (3 - 2 * f); PT[offset++] = Math.round(h / (2 * mid) * 255);
    }
  }
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
  // A row's convex hull fits the figure at any rotation without scanning every dot.
  const boundsPoints = [];
  for (let start = 0; start < PT.length;) {
    let end = start + 8;
    while (end < PT.length && PT[end + 2] === PT[start + 2]) end += 8;
    const upper = [], lower = [];
    const turn = (a, b, c) => (PT[b] - PT[a]) * (PT[c + 1] - PT[a + 1])
      - (PT[b + 1] - PT[a + 1]) * (PT[c] - PT[a]);
    for (let k = start; k < end; k += 8) {
      if (PT[k + 6] < 0.3) continue;
      while (upper.length > 1 && turn(upper.at(-2), upper.at(-1), k) >= 0) upper.pop();
      while (lower.length > 1 && turn(lower.at(-2), lower.at(-1), k) <= 0) lower.pop();
      upper.push(k); lower.push(k);
    }
    boundsPoints.push(...upper, ...lower);
    start = end;
  }
  // Marching squares, generated once. Eight paths group major/minor contours
  // and edge fade, so a frame needs only eight strokes, not one per segment.
  const contours = Array.from({ length: 8 }, () => []);
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const d = dist[j * gw + i], fade = Math.max(0, Math.min(1, (R1 - d) / (R1 - R0)));
      if (fade < 0.12) continue;
      const heights = [H[j * gw + i], H[j * gw + i + 1], H[(j + 1) * gw + i + 1], H[(j + 1) * gw + i]];
      const bottom = Math.min(...heights) * cellM / EX + lo;
      const top = Math.max(...heights) * cellM / EX + lo;
      for (let metres = Math.ceil(bottom / 100) * 100; metres < top; metres += 100) {
        const h = (metres - lo) / cellM * EX;
        const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]], edges = [];
        for (let a = 0; a < 4; a++) {
          const b = (a + 1) % 4;
          if ((heights[a] >= h) === (heights[b] >= h)) continue;
          const f = (h - heights[a]) / (heights[b] - heights[a]);
          edges.push([corners[a][0] + (corners[b][0] - corners[a][0]) * f - ox,
            corners[a][1] + (corners[b][1] - corners[a][1]) * f - oz]);
        }
        // Resolve saddle cells consistently using the height at the cell centre.
        if (edges.length === 4 && ((heights.reduce((a, b) => a + b) / 4 >= h) === (heights[0] >= h))) {
          edges.push(edges.shift());
        }
        const group = (metres % 500 === 0 ? 4 : 0) + Math.min(3, Math.floor(fade * 4));
        for (let e = 0; e + 1 < edges.length; e += 2) {
          contours[group].push(...edges[e], ...edges[e + 1], h - mid);
        }
      }
    }
  }
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let still = motion.matches;
  let ctx, img, pixels, pixelX, pixelY, dpr, cw, ch, s, cx, cy0, gx, gy, zbuf, win, red, ink;
  const colors = new Uint32Array(256);
  const alpha = new Uint8ClampedArray(4), alphaWord = new Uint32Array(alpha.buffer);

  // altitude tints between the CSS stops, one rgb triple per altitude byte
  const hex = (v) => v.trim().match(/\w\w/g).map((c) => parseInt(c, 16));
  const tints = () => {
    const cs = getComputedStyle(document.body);
    const stops = [[1300, '--forest'], [1700, '--meadow'], [2250, '--rock'], [2650, '--summit']]
      .map(([m, v]) => [m, hex(cs.getPropertyValue(v))]);
    const bytes = new Uint8Array(colors.buffer);
    for (let b = 0; b < 256; b++) {
      const m = lo + b / 255 * (hi - lo);
      let i = 0;
      while (i < stops.length - 2 && m > stops[i + 1][0]) i++;
      const t = Math.max(0, Math.min(1, (m - stops[i][0]) / (stops[i + 1][0] - stops[i][0])));
      for (let c = 0; c < 3; c++) bytes[b * 4 + c] = stops[i][1][c] + (stops[i + 1][1][c] - stops[i][1][c]) * t;
    }
    red = cs.getPropertyValue('--red');
    ink = cs.getPropertyValue('--faint');
  };

  const size = () => {
    cw = canvas.clientWidth;
    // A stable canvas prevents layout shifts while the relief unfolds.
    ch = Math.round(Math.max(260, Math.min(460, cw * 0.64)));
    dpr = devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.height = ch + 'px';
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    img = ctx.createImageData(canvas.width, canvas.height);
    pixels = new Uint32Array(img.data.buffer);
    gx = Math.ceil(cw / P);
    gy = Math.ceil(ch / P);
    zbuf = new Float32Array(gx * gy);
    win = new Int32Array(gx * gy);
    pixelX = Uint32Array.from({ length: gx }, (_, c) => Math.round(c * P * dpr));
    pixelY = Uint32Array.from({ length: gy }, (_, r) => Math.round(r * P * dpr) * img.width);
  };

  // view state. each value eases toward a target with a damped spring
  const spring = (v) => ({ v, to: v, vel: 0 });
  const step = (a, k = 0.06, damp = 0.78) => {
    if (still) { a.v = a.to; a.vel = 0; return false; }
    a.vel = (a.vel + (a.to - a.v) * k) * damp;
    a.v += a.vel;
    // Below a small fraction of a pixel, settle exactly so the loop can sleep.
    if (Math.abs(a.to - a.v) < 0.00001 && Math.abs(a.vel) < 0.00001) { a.v = a.to; a.vel = 0; }
    return a.v !== a.to || a.vel !== 0;
  };
  const yaw = spring(0), pitch = spring(PITCH), az = spring(-2.45), el = spring(0.8), calm = spring(1);
  const unfold = spring(0), zoom = spring(1), panX = spring(0), panY = spring(0);
  let drag = null, pinch = null;
  const pointers = new Map();
  let visible = false, t0 = null, frame = null;
  const wake = () => {
    if (visible && !document.hidden && frame === null) frame = requestAnimationFrame(loop);
  };
  const sleep = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  const draw = (sway, rise) => {
    const map = Math.max(0, Math.min(1, unfold.v));
    const Y = (sway * calm.v + Math.atan2(Math.sin(yaw.v), Math.cos(yaw.v))) * (1 - map);
    const angle = pitch.v * (1 - map) + Math.PI / 2 * map;
    const cy = Math.cos(Y), sy = Math.sin(Y), cp = Math.cos(angle), sp = Math.sin(angle);
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const k of boundsPoints) {
      const x = PT[k] * cy + PT[k + 2] * sy;
      const y = PT[k + 1] * (1 - map) * cp - (-PT[k] * sy + PT[k + 2] * cy) * sp;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    s = Math.min((cw - 32) / (right - left), (ch - 32) / (bottom - top)) * zoom.v;
    cx = cw / 2 - (left + right) * s / 2 + panX.v * cw;
    cy0 = ch / 2 + (top + bottom) * s / 2 + panY.v * ch;
    rise *= 1 - map;
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
    const width = gx | 0, height = gy | 0, depth = zbuf, winner = win;
    const xx = cy * s / P, xz = sy * s / P, x0 = cx / P;
    const yx = -sy * sp * s / P, yy = -rise * cp * s / P, yz = cy * sp * s / P, y0 = cy0 / P;
    const zx = -sy * cp, zy = rise * sp, zz = cy * cp;
    // Keep the dense point pass local. The route below also needs the exact
    // projected coordinates, but terrain points only need a cell and depth.
    for (let k = 0; k < PT.length; k += 8) {
      const X = PT[k], Yw = PT[k + 1], Z = PT[k + 2];
      const c = Math.floor(x0 + X * xx + Z * xz) | 0;
      const r = Math.floor(y0 + X * yx + Yw * yy + Z * yz) | 0;
      if (c < 0 || r < 0 || c >= width || r >= height) continue;
      const g = (r * width + c) | 0, z = X * zx + Yw * zy + Z * zz;
      if (z > depth[g]) { depth[g] = z; winner[g] = k; }
    }
    // dots straight into a pixel buffer: each one needs its own colour
    const iw = img.width, ds = Math.max(1, Math.round(1.5 * dpr));
    pixels.fill(0);
    for (let g = 0; g < zbuf.length; g++) {
      if (zbuf[g] === -Infinity) continue;
      const k = win[g], c = g % gx, r = (g - c) / gx, fade = PT[k + 6];
      if (fade < BAYER[(r % 4) * 4 + (c % 4)]) continue; // ordered dither thins the fade
      const lit = Math.max(0, PT[k + 3] * L[0] + PT[k + 4] * L[1] + PT[k + 5] * L[2]);
      // Byte views retain native endianness and Uint8Clamped alpha rounding.
      alpha[3] = (lit > 0.75 ? 0.3 : lit > 0.45 ? 0.6 : 0.9) * (0.5 + 0.5 * fade) * (1 - 0.82 * map) * 255;
      const rgba = colors[PT[k + 7]] | alphaWord[0];
      const offset = pixelY[r] + pixelX[c];
      for (let yy = 0, row = offset; yy < ds; yy++, row += iw) {
        for (let xx = 0; xx < ds; xx++) pixels[row + xx] = rgba;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (map > 0.01) {
      ctx.strokeStyle = ink;
      for (let group = 0; group < contours.length; group++) {
        const segments = contours[group];
        ctx.globalAlpha = map * map * (group >= 4 ? 0.7 : 0.38) * ((group % 4 + 1) / 4);
        ctx.lineWidth = group >= 4 ? 0.85 : 0.55;
        ctx.beginPath();
        for (let k = 0; k < segments.length; k += 5) {
          const ax = segments[k], ay = segments[k + 1], bx = segments[k + 2], by = segments[k + 3], h = segments[k + 4];
          const cell = proj((ax + bx) / 2, h, (ay + by) / 2);
          if (cell < 0 || pz + 0.6 < zbuf[cell]) continue;
          proj(ax, h, ay); ctx.moveTo(px, py);
          proj(bx, h, by); ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
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

  // Direct manipulation only: drag to turn, tap to unfold, pinch to zoom.
  // The camera stays where it was left; lighting stays fixed to the landscape.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const engage = () => { calm.to = 0; wake(); };
  const hint = canvas.parentNode.querySelector('.terrain-hint');
  const updateHint = () => {
    const tap = matchMedia('(pointer: coarse)').matches ? 'tap' : 'click';
    if (hint) hint.textContent = unfold.to ? `drag to move · ${tap} to lift` : `drag to turn · ${tap} to unfold`;
    canvas.dataset.view = unfold.to ? 'map' : 'relief';
    canvas.setAttribute('aria-label', `${unfold.to ? 'Contour map' : 'Interactive relief'} of the walk from Schynige Platte to First. Press Enter to ${unfold.to ? 'lift the relief' : 'unfold the map'}. Arrow keys turn or move the view, shift and arrow keys move it, plus and minus zoom, and Home resets it.`);
  };
  const toggle = () => {
    unfold.to = unfold.to ? 0 : 1;
    updateHint(); engage();
  };
  const reset = () => {
    yaw.to = 0; pitch.to = PITCH; zoom.to = 1;
    panX.to = panY.to = unfold.to = 0;
    updateHint(); engage();
  };
  const pan = (x, y) => {
    panX.to = clamp(panX.to + x, -0.65, 0.65);
    panY.to = clamp(panY.to + y, -0.65, 0.65);
  };
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [x, y]);
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const next = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
      if (pinch && pinch.distance > 0) {
        zoom.to = clamp(zoom.to * next.distance / pinch.distance, 0.7, 2.5);
        pan((next.x - pinch.x) / cw, (next.y - pinch.y) / ch);
      }
      pinch = next; drag.moved = true;
      engage(); pick(-1); return;
    }
    if (drag && pointers.has(e.pointerId)) {
      drag.moved ||= Math.hypot(x - drag.startX, y - drag.startY) > 4;
      if (drag.moved) {
        if (e.shiftKey || unfold.to === 1) pan((x - drag.x) / cw, (y - drag.y) / ch);
        else {
          yaw.to += (x - drag.x) * 0.009;
          pitch.to = clamp(pitch.to + (y - drag.y) * 0.007, 0.15, Math.PI / 2);
        }
        engage(); pick(-1);
      }
      drag.x = x; drag.y = y;
      return;
    }
    let best = -1, bd = 24 * 24;
    cols.forEach(([px, py], c) => {
      const dd = (px - x) ** 2 + (py - y) ** 2;
      if (dd < bd) { bd = dd; best = c; }
    });
    pick(best);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [x, y] = local(e);
    pointers.set(e.pointerId, [x, y]);
    if (!drag) drag = { x, y, startX: x, startY: y, moved: false };
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
      drag.moved = true;
    }
    canvas.setPointerCapture(e.pointerId);
  });
  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (!pointers.size) {
      if (drag && !drag.moved && e.type === 'pointerup') toggle();
      drag = pinch = null;
    } else {
      const [x, y] = [...pointers.values()][0];
      drag = { x, y, startX: x, startY: y, moved: true };
      pinch = null;
    }
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    wake();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', release);
  canvas.addEventListener('pointerleave', () => {
    if (drag !== null) return;
    pick(-1);
  });
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') toggle();
    else if (e.key === 'Home' || e.key.toLowerCase() === 'r') reset();
    else if (e.key === '+' || e.key === '=') { zoom.to = clamp(zoom.to * 1.2, 0.7, 2.5); engage(); }
    else if (e.key === '-') { zoom.to = clamp(zoom.to / 1.2, 0.7, 2.5); engage(); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const x = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const y = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (e.shiftKey || unfold.to === 1) pan(x * 0.05, y * 0.05);
      else { yaw.to += x * 0.15; pitch.to = clamp(pitch.to + y * 0.1, 0.15, Math.PI / 2); }
      engage();
    } else return;
    e.preventDefault();
  });
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom.to = clamp(zoom.to * Math.exp(-e.deltaY * 0.005), 0.7, 2.5);
    engage();
  }, { passive: false });

  updateHint();
  size();
  tints();
  addEventListener('resize', () => { size(); wake(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { tints(); wake(); });
  motion.addEventListener('change', () => { still = motion.matches; wake(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) sleep(); else wake(); });
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && t0 === null) { t0 = performance.now(); reveal(); }
    if (visible) wake(); else sleep();
  }, { threshold: 0.05 }).observe(canvas);
  const loop = (t) => {
    frame = null;
    if (!visible || document.hidden) return;
    let moving = step(yaw);
    moving = step(pitch) || moving;
    moving = step(az) || moving;
    moving = step(el) || moving;
    moving = step(calm, 0.02, 0.9) || moving;
    moving = step(unfold, 0.018, 0.82) || moving;
    moving = step(zoom) || moving;
    moving = step(panX) || moving;
    moving = step(panY) || moving;
    const p = still ? 1 : Math.min(1, (t - t0) / RISE);
    draw(still ? 0 : SWAY * Math.sin((t - t0) / 18000 * 2 * Math.PI), 1 - (1 - p) ** 3);
    if (moving || (!still && (p < 1 || calm.v !== 0))) wake();
  };
  return wake;
}
