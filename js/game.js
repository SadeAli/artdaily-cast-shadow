/* ============================================================
   game.js — Cast Shadow. A box on a gridded ground plane, a sun
   pinned at the frame edge, and a gnomon stick whose true shadow
   is always drawn (the given). The player drags the box's four
   projected top-corner handles to build its cast shadow; "done"
   scores against the exact projection and reveals it in amber.
   One consistent oblique view transform for everything; scoring
   math is pure (ground units in, 0–100 out) and lives up top.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'cast-shadow';
  var ITEMS_PER_ROUND = 3;
  var DEG = Math.PI / 180;
  var GX = 10, GZ = 6;   /* visible ground patch, in grid units */
  var GNOMON_H = 0.9;    /* height of the given stick */
  var HANDLE_HIT = 30;   /* px pick radius → a 60px hit disc */

  /* ================= pure projection & scoring =================
     Directional light: azimuth az° in the ground plane (0 = +x,
     CCW) and altitude alt° above the horizon. A point at height h
     drops its shadow away from the sun by h / tan(alt) — the
     spec's S = P − L·(P.h / L.h) written out in ground coords. */

  function shadowOffset(azDeg, altDeg, h) {
    var run = h / Math.tan(altDeg * DEG);
    return { x: -Math.cos(azDeg * DEG) * run, z: -Math.sin(azDeg * DEG) * run };
  }

  function projectCorner(fx, fz, h, azDeg, altDeg) {
    var o = shadowOffset(azDeg, altDeg, h);
    return { x: fx + o.x, z: fz + o.z };
  }

  function boundingDiag(pts) {
    if (!pts.length) return 0;
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, i;
    for (i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].z < minZ) minZ = pts[i].z;
      if (pts[i].z > maxZ) maxZ = pts[i].z;
    }
    return Math.hypot(maxX - minX, maxZ - minZ);
  }

  /* Mean handle→truth distance, normalized by the true shadow's
     bounding diagonal: 100·clamp(1 − meanErr/0.28, 0, 1). A tiny
     dead-zone (0.012 diagonals ≈ a couple of px) is forgiven first
     so a pixel-perfect drag can genuinely reach 100. */
  function itemScore(handles, truths, diag) {
    if (!truths.length || !handles.length) return 0;
    var sum = 0, i;
    for (i = 0; i < truths.length; i++) {
      sum += Math.hypot(handles[i].x - truths[i].x, handles[i].z - truths[i].z);
    }
    var meanErr = Math.max(0, (sum / truths.length) / (diag || 1) - 0.012);
    return 100 * Math.max(0, Math.min(1, 1 - meanErr / 0.28));
  }

  function roundScore(scores) {
    var sum = 0, i;
    for (i = 0; i < scores.length; i++) sum += scores[i];
    return scores.length ? sum / scores.length : 0;
  }

  /* CCW footprint of a box centred on (cx,cz), half-sizes hx/hz,
     rotated rotDeg about its centre. */
  function boxFootprint(cx, cz, hx, hz, rotDeg) {
    var cs = Math.cos(rotDeg * DEG), sn = Math.sin(rotDeg * DEG);
    var signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]], pts = [], i, dx, dz;
    for (i = 0; i < 4; i++) {
      dx = signs[i][0] * hx;
      dz = signs[i][1] * hz;
      pts.push({ x: cx + dx * cs - dz * sn, z: cz + dx * sn + dz * cs });
    }
    return pts;
  }

  /* Andrew monotone chain — the drawn shadow region is the hull of
     footprint ∪ (dragged or true) landings. */
  function convexHull(pts) {
    var p = pts.slice().sort(function (a, b) { return a.x - b.x || a.z - b.z; });
    if (p.length < 3) return p;
    function cross(o, a, b) { return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x); }
    var lower = [], upper = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /* ==================== chrome & canvas ==================== */

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnDone = document.getElementById('btnDone');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    return {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--sunny').trim(),
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0, view = null;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    makeView();
  }

  /* One oblique ground-plane view for everything: ground x runs
     right, ground z recedes up-right, height goes straight up. */
  function makeView() {
    var s = W / 14;
    view = {
      ox: 0.8 * s, oy: H - 1.1 * s,
      exx: s, exy: 0,
      ezx: 0.42 * s, ezy: -0.52 * s,
      eyy: -0.88 * s,
    };
  }

  function toScreen(gx, gz, h) {
    return {
      x: view.ox + gx * view.exx + gz * view.ezx,
      y: view.oy + gx * view.exy + gz * view.ezy + (h || 0) * view.eyy,
    };
  }

  /* Invert the ground-plane 2×2 so drags land in ground coords
     (handle positions survive resizes and stay view-independent). */
  function toGround(px, py) {
    var a = view.exx, b = view.ezx, c = view.exy, d = view.ezy;
    var det = a * d - b * c;
    var dx = px - view.ox, dy = py - view.oy;
    return { x: (d * dx - b * dy) / det, z: (a * dy - c * dx) / det };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function inGround(p, m) { return p.x >= m && p.x <= GX - m && p.z >= m && p.z <= GZ - m; }

  /* ==================== item generation ==================== */
  /* Ramp: item 1 high sun / short shadow / square-on box; item 3
     low sun / long shadow / rotated box. Resampling (raising the
     sun a notch per retry) keeps every true landing on the sheet. */

  var ALT_LO = [50, 34, 20], ALT_HI = [62, 42, 26], THETA = [34, 26, 14];

  function genItem(level) {
    var sunLeft = Math.random() < 0.5;
    var rot = level === 0 ? 0 : (level === 1 ? rand(-14, 14) : rand(24, 66) * (Math.random() < 0.5 ? 1 : -1));
    var hx = rand(0.62, 0.88), hz = rand(0.62, 0.88);
    var bh = rand(1.05, 1.5);
    var tries, alt, az, cx, cz, foot, truths, gn, ok, i, sgn, a0, go, cand;
    for (tries = 0; tries < 40; tries++) {
      alt = Math.min(64, rand(ALT_LO[level], ALT_HI[level]) + tries * 1.4);
      az = (sunLeft ? 180 : 0) + rand(-THETA[level], THETA[level]);
      cx = sunLeft ? rand(2.0, 3.0) : rand(GX - 3.0, GX - 2.0);
      cz = rand(2.3, 3.3);
      foot = boxFootprint(cx, cz, hx, hz, rot);
      truths = [];
      ok = true;
      for (i = 0; i < 4; i++) {
        truths.push(projectCorner(foot[i].x, foot[i].z, bh, az, alt));
        if (!inGround(truths[i], 0.45)) ok = false;
      }
      gn = null;
      if (ok) {
        a0 = az * DEG;
        go = shadowOffset(az, alt, GNOMON_H);
        for (sgn = 1; sgn >= -1; sgn -= 2) {
          cand = { x: cx - Math.sin(a0) * 1.9 * sgn, z: cz + Math.cos(a0) * 1.9 * sgn };
          if (inGround(cand, 0.5) && inGround({ x: cand.x + go.x, z: cand.z + go.z }, 0.4)) { gn = cand; break; }
        }
        if (!gn) ok = false;
      }
      if (ok || tries === 39) break;
    }
    if (!gn) gn = { x: clamp(cx + (sunLeft ? 2 : -2), 0.6, GX - 0.6), z: 1.0 };
    return {
      az: az, alt: alt, bh: bh,
      foot: foot, truths: truths,
      diag: boundingDiag(foot.concat(truths)),
      gnomon: gn,
      handles: foot.map(function (p) { return { x: p.x, z: p.z }; }),
    };
  }

  /* ==================== round state ==================== */

  var round = 0, itemIdx = 0, itemScores = [], item = null;
  var phase = 'idle'; /* 'place' | 'reveal' | 'done' */
  var selIdx = -1;
  var dragId = null, dragIdx = -1;

  function placeHint() {
    return 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND +
      ' — drag the shadow corners into place, then press done.';
  }

  function newRound() {
    round += 1;
    itemIdx = 0;
    itemScores = [];
    selIdx = -1;
    dragId = null;
    dragIdx = -1;
    item = genItem(0);
    phase = 'place';
    btnDone.hidden = false;
    btnDone.textContent = 'done ✓';
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = placeHint();
    draw();
  }

  function finishRound() {
    var res = ArtDaily.report(roundScore(itemScores));
    phase = 'done';
    btnDone.hidden = true;
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'item 3: ' + Math.round(itemScores[2]) +
      ' — round done. press “new round” to go again.';
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  /* ==================== painting ==================== */

  function draw() {
    var c = inks();
    var dark = ArtDaily.theme() === 'dark';
    ctx.clearRect(0, 0, W, H);
    if (!item) return;
    drawGrid(c);
    if (phase !== 'place') drawTruth(c);
    drawGnomonShadow(c);
    drawPlayerShadow(c);
    drawBox(c, dark);
    drawGnomon(c);
    if (phase !== 'place') drawRays(c);
    drawHandles(c);
    drawSun(c);
  }

  function polyPath(pts) {
    var i;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  function groundPoly(pts) {
    polyPath(pts.map(function (p) { return toScreen(p.x, p.z, 0); }));
  }

  function drawGrid(c) {
    var i, a, b;
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    for (i = 0; i <= GX; i++) {
      a = toScreen(i, 0, 0); b = toScreen(i, GZ, 0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (i = 0; i <= GZ; i++) {
      a = toScreen(0, i, 0); b = toScreen(GX, i, 0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawPlayerShadow(c) {
    var i, a, b;
    groundPoly(convexHull(item.foot.concat(item.handles)));
    ctx.fillStyle = c.ink;
    ctx.globalAlpha = 0.16;
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    /* drag trails: footprint corner → its handle */
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    for (i = 0; i < 4; i++) {
      a = toScreen(item.foot[i].x, item.foot[i].z, 0);
      b = toScreen(item.handles[i].x, item.handles[i].z, 0);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawTruth(c) {
    groundPoly(convexHull(item.foot.concat(item.truths)));
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.26;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* Side faces are back-face culled by screen winding; shading is a
     flat lambert vs the sun's azimuth. Values invert between the
     themes on purpose: graphite on paper, chalk in night studio. */
  function drawBox(c, dark) {
    var f = item.foot, fs = [], ts = [], i, j, quad, s, ex, ez, len, lit, b;
    var sunX = Math.cos(item.az * DEG), sunZ = Math.sin(item.az * DEG);
    for (i = 0; i < 4; i++) {
      fs.push(toScreen(f[i].x, f[i].z, 0));
      ts.push(toScreen(f[i].x, f[i].z, item.bh));
    }
    for (i = 0; i < 4; i++) {
      j = (i + 1) % 4;
      quad = [fs[i], fs[j], ts[j], ts[i]];
      s = (quad[0].x * quad[1].y - quad[1].x * quad[0].y) +
          (quad[1].x * quad[2].y - quad[2].x * quad[1].y) +
          (quad[2].x * quad[3].y - quad[3].x * quad[2].y) +
          (quad[3].x * quad[0].y - quad[0].x * quad[3].y);
      if (s >= 0) continue; /* facing away from the viewer */
      ex = f[j].x - f[i].x; ez = f[j].z - f[i].z;
      len = Math.hypot(ex, ez) || 1;
      lit = (ez / len) * sunX + (-ex / len) * sunZ; /* outward · sun */
      b = clamp(0.5 + 0.48 * lit, 0, 1);
      paintFace(quad, c, b, dark);
    }
    paintFace(ts, c, 0.55 + 0.45 * Math.sin(item.alt * DEG), dark);
  }

  function paintFace(pts, c, brightness, dark) {
    polyPath(pts);
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.card;
    ctx.fill();
    ctx.fillStyle = c.ink;
    ctx.globalAlpha = dark ? (0.10 + 0.40 * brightness) : (0.05 + 0.34 * (1 - brightness));
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawGnomonShadow(c) {
    var g = item.gnomon;
    var o = shadowOffset(item.az, item.alt, GNOMON_H);
    var a = toScreen(g.x, g.z, 0), b = toScreen(g.x + o.x, g.z + o.z, 0);
    ctx.strokeStyle = c.ink;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  function drawGnomon(c) {
    var g = item.gnomon;
    var a = toScreen(g.x, g.z, 0), t = toScreen(g.x, g.z, GNOMON_H);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Screen direction toward the sun — the same linear map applied
     to the 3D light vector, so reveal rays stay truly parallel. */
  function sunScreenDir() {
    var a = item.az * DEG, al = item.alt * DEG;
    var dx = Math.cos(a) * Math.cos(al), dz = Math.sin(a) * Math.cos(al), dy = Math.sin(al);
    var sx = dx * view.exx + dz * view.ezx;
    var sy = dx * view.exy + dz * view.ezy + dy * view.eyy;
    var l = Math.hypot(sx, sy) || 1;
    return { x: sx / l, y: sy / l };
  }

  function sunPos() {
    var cxg = 0, czg = 0, i, p, d, inset = 30, t = Infinity;
    for (i = 0; i < 4; i++) { cxg += item.foot[i].x / 4; czg += item.foot[i].z / 4; }
    p = toScreen(cxg, czg, item.bh);
    d = sunScreenDir();
    if (d.x > 1e-6) t = Math.min(t, (W - inset - p.x) / d.x);
    if (d.x < -1e-6) t = Math.min(t, (inset - p.x) / d.x);
    if (d.y > 1e-6) t = Math.min(t, (H - inset - p.y) / d.y);
    if (d.y < -1e-6) t = Math.min(t, (inset - p.y) / d.y);
    if (!isFinite(t) || t < 0) t = 0;
    return { x: p.x + d.x * t, y: p.y + d.y * t };
  }

  function drawSun(c) {
    var s = sunPos(), i, a;
    ctx.strokeStyle = c.accent;
    ctx.fillStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    for (i = 0; i < 8; i++) {
      a = i * Math.PI / 4;
      ctx.moveTo(s.x + Math.cos(a) * 11, s.y + Math.sin(a) * 11);
      ctx.lineTo(s.x + Math.cos(a) * 16, s.y + Math.sin(a) * 16);
    }
    ctx.stroke();
  }

  /* One ray per corner: from the landing up to the top corner, and
     a fainter stub from the corner back toward the sun. */
  function drawRays(c) {
    var d = sunScreenDir(), i, t, s;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    for (i = 0; i < 4; i++) {
      t = toScreen(item.foot[i].x, item.foot[i].z, item.bh);
      s = toScreen(item.truths[i].x, item.truths[i].z, 0);
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + d.x * 66, t.y + d.y * 66);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawHandles(c) {
    var i, p;
    for (i = 0; i < 4; i++) {
      p = toScreen(item.handles[i].x, item.handles[i].z, 0);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = c.accent;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = c.ink;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
      if (i === selIdx && phase === 'place') {
        ctx.strokeStyle = c.accent;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  /* ==================== input ==================== */

  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function moveHandle(p) {
    var g = toGround(p.x, p.y);
    item.handles[dragIdx] = {
      x: clamp(g.x, 0.2, GX - 0.2),
      z: clamp(g.z, 0.15, GZ - 0.15),
    };
    draw();
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!item || phase !== 'place' || dragId !== null) return;
    ev.preventDefault();
    var p = pointerPos(ev), best = HANDLE_HIT, bi = -1, i, s, d;
    for (i = 0; i < 4; i++) {
      s = toScreen(item.handles[i].x, item.handles[i].z, 0);
      d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < best) { best = d; bi = i; }
    }
    if (bi < 0) return;
    dragId = ev.pointerId;
    dragIdx = bi;
    selIdx = bi;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    moveHandle(p);
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (dragId === null || ev.pointerId !== dragId) return;
    ev.preventDefault();
    moveHandle(pointerPos(ev));
  });

  function endDrag(ev) {
    if (dragId === null || ev.pointerId !== dragId) return;
    dragId = null;
    dragIdx = -1;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* keyboard fallback: 1–4 picks a handle, arrows nudge it along
     the ground grid, enter presses done/next */
  canvas.addEventListener('keydown', function (ev) {
    if (!item) return;
    if (ev.key === 'Enter') {
      if (!btnDone.hidden) btnDone.click();
      ev.preventDefault();
      return;
    }
    if (phase !== 'place') return;
    var step = ev.shiftKey ? 0.3 : 0.08, h;
    if (ev.key >= '1' && ev.key <= '4') {
      selIdx = Number(ev.key) - 1;
      draw();
      ev.preventDefault();
      return;
    }
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    if (selIdx < 0) selIdx = 0;
    h = item.handles[selIdx];
    if (ev.key === 'ArrowLeft') h.x -= step;
    else if (ev.key === 'ArrowRight') h.x += step;
    else if (ev.key === 'ArrowUp') h.z += step;
    else h.z -= step;
    h.x = clamp(h.x, 0.2, GX - 0.2);
    h.z = clamp(h.z, 0.15, GZ - 0.15);
    draw();
    ev.preventDefault();
  });

  /* ==================== done / next / round flow ==================== */

  btnDone.addEventListener('click', function () {
    if (!item) return;
    if (phase === 'place') {
      var sc = itemScore(item.handles, item.truths, item.diag);
      itemScores.push(sc);
      phase = 'reveal';
      draw();
      if (itemIdx === ITEMS_PER_ROUND - 1) {
        finishRound();
      } else {
        btnDone.textContent = 'next →';
        hint.textContent = 'item ' + (itemIdx + 1) + ': ' + Math.round(sc) +
          ' — amber is the true shadow. press next.';
      }
      return;
    }
    if (phase === 'reveal') {
      itemIdx += 1;
      selIdx = -1;
      item = genItem(itemIdx);
      phase = 'place';
      btnDone.textContent = 'done ✓';
      hint.textContent = placeHint();
      draw();
    }
  });

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () { fitCanvas(); draw(); });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
