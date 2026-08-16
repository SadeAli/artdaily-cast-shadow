/* ============================================================
   game.js — Cast Shadow. A form on a gridded ground plane, a
   directional sun (parallel rays, no finite disc to aim at), and a
   gnomon stick whose true shadow is always drawn — the given, your
   ruler. The player runs one light ray per top corner, dragging
   from the corner down to where it lands; "done" scores against the
   exact projection and reveals it in amber. From item 2 the top is
   a tilted plane, so the four corners sit at four different heights
   and each ray has its own length. One consistent oblique view
   transform for everything; scoring math is pure (ground units in,
   0–100 out) and lives up top.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'cast-shadow';
  var ITEMS_PER_ROUND = 3;
  var DEG = Math.PI / 180;
  /* Visible ground patch, in grid units. A narrow sheet gets a SMALLER
     patch, not smaller everything: 10×6 units across a 330px phone canvas
     put the whole form inside 35px with four corners to pick between. */
  var PATCH_WIDE = { gx: 10, gz: 6 }, PATCH_NARROW = { gx: 8, gz: 5 };
  var GNOMON_H = 0.9;    /* height of the given stick */
  var MONO = 'ui-monospace, Menlo, Consolas, monospace';
  var DEAD_ZONE = 0.012; /* forgiven first, as a fraction of the diagonal */
  var DEAD_CAP = 0.12;   /* …but never more than this much of the ramp */
  var SLOP_PX = 3;       /* pixel floor under it, eased per mode */
  var SLOP_COARSE_PX = 8;

  /* ================= pure projection & scoring =================
     Directional light: azimuth az° in the ground plane (0 = +x,
     CCW) and altitude alt° above the horizon. A point at height h
     drops its shadow away from the sun by h / tan(alt) — the
     spec's S = P − L·(P.h / L.h) written out in ground coords. */

  /* Unit vector pointing AT the sun — the real 3D light direction
     that both the shading and the reveal rays are built from. */
  function sunVector(azDeg, altDeg) {
    var a = azDeg * DEG, al = altDeg * DEG, ca = Math.cos(al);
    return { x: Math.cos(a) * ca, y: Math.sin(al), z: Math.sin(a) * ca };
  }

  function shadowOffset(azDeg, altDeg, h) {
    var run = h / Math.tan(altDeg * DEG);
    return { x: -Math.cos(azDeg * DEG) * run, z: -Math.sin(azDeg * DEG) * run };
  }

  function projectCorner(fx, fz, h, azDeg, altDeg) {
    var o = shadowOffset(azDeg, altDeg, h);
    return { x: fx + o.x, z: fz + o.z };
  }

  /* The top is a real plane: height h0 at (cx,cz), sloping gx per
     unit of ground x and gz per unit of ground z. Level 1 is flat
     (gx = gz = 0) — a plain box; after that it is a wedge, so the
     four corners genuinely differ instead of sharing one offset. */
  function topHeight(top, x, z) {
    return top.h0 + top.gx * (x - top.cx) + top.gz * (z - top.cz);
  }

  /* Outward unit normal of that top plane — the actual surface the
     light meets, not a stand-in for one. */
  function topNormal(top) {
    var l = Math.sqrt(1 + top.gx * top.gx + top.gz * top.gz);
    return { x: -top.gx / l, y: 1 / l, z: -top.gz / l };
  }

  /* Outward unit normal of the vertical wall on footprint edge a→b.
     The footprint runs CCW, so (dz, 0, −dx) points away from the
     solid. */
  function wallNormal(a, b) {
    var ex = b.x - a.x, ez = b.z - a.z, l = Math.hypot(ex, ez) || 1;
    return { x: ez / l, y: 0, z: -ex / l };
  }

  /* Real lambert: surface normal · light direction, both unit 3D. */
  function lambert(n, L) {
    var d = n.x * L.x + n.y * L.y + n.z * L.z;
    return d < 0 ? 0 : (d > 1 ? 1 : d);
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

  /* The dead zone — what is forgiven before the ramp starts — for the
     hand in play, as a fraction of the shadow's diagonal. 0.012 of a
     diagonal is ~1.7px on a 690px sheet and under 1px on a phone, i.e.
     below the input device's own noise on every device except a nib, so
     it gets a pixel floor: 3px eased per mode, 8px on a coarse screen,
     converted into ground units through the view scale. Pure — pxPerUnit
     and ease are injected. The 0.28 ramp itself is untouched, on every
     device: this drill's difficulty is the proportional rule, not
     steadiness, so widening the ramp would only pay people for not
     running the rays. */
  function deadZone(diag, pxPerUnit, ease, coarse) {
    var px = Math.max(ease(SLOP_PX), coarse ? SLOP_COARSE_PX : 0);
    var rel = ease(DEAD_ZONE);
    if (pxPerUnit > 0 && diag > 0) rel = Math.max(rel, (px / pxPerUnit) / diag);
    return Math.min(rel, DEAD_CAP);
  }

  /* Mean handle→truth distance, normalized by the true shadow's
     bounding diagonal: 100·clamp(1 − meanErr/0.28, 0, 1), with the dead
     zone forgiven first so a construction as good as the hand allows can
     genuinely reach 100. Also returns the per-corner errors, so the
     reveal can point at the one that went wrong. */
  function itemScore(handles, truths, diag, dead) {
    var errs = [], i, sum = 0, d = diag || 1;
    if (!truths.length || handles.length !== truths.length) {
      return { score: 0, errs: errs };
    }
    for (i = 0; i < truths.length; i++) {
      errs.push(Math.hypot(handles[i].x - truths[i].x, handles[i].z - truths[i].z) / d);
      sum += errs[i];
    }
    var mean = sum / truths.length;
    if (!isFinite(mean)) return { score: 0, errs: errs };
    var meanErr = Math.max(0, mean - (dead > 0 ? dead : DEAD_ZONE));
    return { score: 100 * Math.max(0, Math.min(1, 1 - meanErr / 0.28)), errs: errs };
  }

  /* THE REVEAL HAS TO NAME THE RULE. The item line read "72/100 — amber is
     the true shadow, the dotted hops show your miss": a number and a
     colour key. This drill is ONE rule — a corner twice as tall throws its
     shadow twice as far, along the way the ruler already runs — and the
     reveal never said whether the player had it, on the round where that
     is the only thing worth knowing. Two questions in the order they
     matter: did the rays run the ruler's WAY, and then did they run far
     enough? Pure: ground-unit points in, one sentence out — and an empty
     string, never a guess, whenever the geometry cannot answer honestly. */
  var BEARING_OK = 0.94;   /* mean cos of ray-vs-truth bearing ≈ 20° */
  function ruleNote(handles, foot, truths) {
    var n = truths ? truths.length : 0, i, mine = 0, real = 0, align = 0, pairs = 0;
    var mx, mz, tx, tz, ml, tl, r;
    if (!n || !handles || !foot || handles.length !== n || foot.length !== n) return '';
    for (i = 0; i < n; i++) {
      mx = handles[i].x - foot[i].x; mz = handles[i].z - foot[i].z;
      tx = truths[i].x - foot[i].x; tz = truths[i].z - foot[i].z;
      ml = Math.hypot(mx, mz); tl = Math.hypot(tx, tz);
      if (!isFinite(ml) || !isFinite(tl)) return '';
      mine += ml; real += tl;
      if (ml > 1e-6 && tl > 1e-6) { align += (mx * tx + mz * tz) / (ml * tl); pairs++; }
    }
    if (!(real > 1e-9) || !isFinite(mine)) return '';
    if (pairs && align / pairs < BEARING_OK) {
      return 'the rays did not run the ruler’s way — take the direction off the stick’s shadow first, then the length.';
    }
    r = mine / real;
    if (!isFinite(r)) return '';
    if (r < 0.85) return 'direction good, reach short — the taller the corner, the further past one ruler its shadow goes.';
    if (r > 1.18) return 'direction good, reach long — a corner only outruns the ruler by as much as it is taller than the stick.';
    return 'that is the rule: direction off the ruler, length off the corner’s height.';
  }

  function worstCorner(errs) {
    var k = 0, i;
    for (i = 1; i < errs.length; i++) if (errs[i] > errs[k]) k = i;
    return k;
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
     footprint ∪ (landed or true) landings. */
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

  /* ---- theme-aware inks (re-read on every repaint) ----
     accent is the wash amber (fills, haloes); line is the same amber at
     graphite weight, for the strokes that carry meaning — the wash is
     only 1.8:1 on the paper card, the line clears AA in both themes. */
  /* The ONLY thing that moves any of these is the data-theme attribute
     (see css/style.css), so reading them once per theme gives the same
     answer as reading them once per repaint — minus a forced style
     recalculation on every pointermove of every ray pulled. An empty read
     (stylesheet not parsed yet) is never cached, so a cold boot still
     corrects itself on the next frame. */
  var inkCache = null, inkTheme = '';
  function inks() {
    var t = ArtDaily.theme();
    if (inkCache && inkTheme === t) return inkCache;
    var cs = getComputedStyle(document.documentElement);
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--sunny').trim();
    var c = {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: accent,
      line: cs.getPropertyValue('--game-line').trim() || accent,
    };
    if (c.ink && c.card) { inkCache = c; inkTheme = t; }
    return c;
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0, view = null;
  var patch = PATCH_WIDE;   /* the patch the NEXT item will be built on */
  var COARSE = (function () {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  })();

  function ease(v) { return ArtDaily.ease(v); }
  function patchFor(w) { return w < 520 ? PATCH_NARROW : PATCH_WIDE; }
  /* the patch the drawing must obey: an item keeps the one it was built
     on, so rotating a phone mid-item can never push a landing off-sheet */
  function activePatch() { return (item && item.patch) ? item.patch : patch; }

  /* Assigning canvas.width BLANKS the sheet, so it is only assigned when
     something really moved: a phone fires `resize` on every pixel of
     address-bar slide, at an unchanged width, and each one used to
     reallocate the backing store, rebuild the view and drop the drag in
     flight — mid-pull, on the one gesture the whole drill is made of. */
  var fitDpr = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    /* a taller sheet on a phone: the form, its shadow and the ruler all
       need room the 0.62 ratio does not give at 330px */
    var h = Math.round(w * (w < 520 ? 0.72 : 0.62));
    var dpr = window.devicePixelRatio || 1;
    if (w === W && h === H && dpr === fitDpr) return false;
    W = w; H = h; fitDpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    patch = patchFor(W);
    makeView();
    return true;
  }

  /* One oblique ground-plane view for everything: ground x runs
     right, ground z recedes up-right, height goes straight up. The scale
     is whatever makes the active patch fill the sheet — so a narrow patch
     on a phone buys back the grid units the form is measured in. */
  function makeView() {
    var p = activePatch();
    var wUnits = 0.8 + p.gx + 0.42 * p.gz + 0.7;  /* origin + runs + margin */
    var hUnits = 1.1 + 0.52 * p.gz + 2.6;         /* baseline + depth + form */
    var s = Math.min(W / wUnits, H / hUnits);
    view = {
      s: s,
      ox: 0.8 * s, oy: H - 1.1 * s,
      exx: s, exy: 0,
      ezx: 0.42 * s, ezy: -0.52 * s,
      eyy: -0.88 * s,
    };
  }

  /* Pick radius follows the view instead of being 30px everywhere:
     ~1 grid unit at any size, floored so touch targets stay ≥44px, and
     never smaller than the zone this input mode needs — a screenless pen
     tablet acquires these corners blind, which is the hardest thing it
     does. */
  function hitRadius() {
    return Math.max(clamp(1.05 * view.s, 22, 34), ArtDaily.startRadius(24));
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
  function inGround(p, m, pp) {
    var q = pp || activePatch();
    return p.x >= m && p.x <= q.gx - m && p.z >= m && p.z <= q.gz - m;
  }

  /* ==================== item generation ==================== */
  /* Ramp: item 1 high sun / short shadow / square-on flat box; item
     3 low sun / long shadow / rotated wedge whose four top corners
     sit at four different heights. Resampling (raising the sun a
     notch per retry) keeps every true landing on the sheet. */

  var ALT_LO = [50, 34, 20], ALT_HI = [62, 42, 26], THETA = [34, 26, 14];
  var SLOPE = [0, 0.34, 0.5];

  function genItem(level) {
    var p = patch, gxMax = p.gx, gzMax = p.gz;
    var sunLeft = Math.random() < 0.5;
    var rot = level === 0 ? 0 : (level === 1 ? rand(-14, 14) : rand(24, 66) * (Math.random() < 0.5 ? 1 : -1));
    var hx = rand(0.62, 0.88), hz = rand(0.62, 0.88);
    var sm = SLOPE[level], sa = Math.random() * Math.PI * 2;
    /* raising the base with the slope keeps every corner well above
       the ground, so the top stays one honest plane */
    var h0 = rand(1.0, 1.35) + sm * 0.85;
    var gx = Math.cos(sa) * sm, gz = Math.sin(sa) * sm;
    /* a first-ever round keeps the sun off the floor on the last item:
       ALT_LO[2] = 20° triples the run, which is exactly where a copied
       ruler goes to zero, and meeting that on your first visit is how a
       round ends on a number nobody wants to repeat */
    var lo = ALT_LO[level], hi = ALT_HI[level];
    if (FIRST_VISIT && round <= 1 && level === 2) { lo = 28; hi = 34; }
    var tries, alt, az, cx, cz, foot, truths, hs, top, gn, ok, i, sgn, a0, go, cand;
    for (tries = 0; tries < 40; tries++) {
      alt = Math.min(64, rand(lo, hi) + tries * 1.4);
      az = (sunLeft ? 180 : 0) + rand(-THETA[level], THETA[level]);
      cx = sunLeft ? rand(0.20, 0.30) * gxMax : rand(0.70, 0.80) * gxMax;
      cz = rand(0.38, 0.55) * gzMax;
      foot = boxFootprint(cx, cz, hx, hz, rot);
      top = { h0: h0, gx: gx, gz: gz, cx: cx, cz: cz };
      hs = [];
      truths = [];
      ok = true;
      for (i = 0; i < 4; i++) {
        hs.push(Math.max(0.35, topHeight(top, foot[i].x, foot[i].z)));
        truths.push(projectCorner(foot[i].x, foot[i].z, hs[i], az, alt));
        if (!inGround(truths[i], 0.45, p)) ok = false;
      }
      gn = null;
      if (ok) {
        a0 = az * DEG;
        go = shadowOffset(az, alt, GNOMON_H);
        for (sgn = 1; sgn >= -1; sgn -= 2) {
          cand = { x: cx - Math.sin(a0) * 1.9 * sgn, z: cz + Math.cos(a0) * 1.9 * sgn };
          if (inGround(cand, 0.5, p) && inGround({ x: cand.x + go.x, z: cand.z + go.z }, 0.4, p)) { gn = cand; break; }
        }
        if (!gn) ok = false;
      }
      if (ok || tries === 39) break;
    }
    if (!gn) gn = { x: clamp(cx + (sunLeft ? 2 : -2), 0.6, gxMax - 0.6), z: 1.0 };
    return {
      patch: p,
      az: az, alt: alt, top: top, hs: hs,
      foot: foot, truths: truths,
      diag: boundingDiag(foot.concat(truths)),
      gnomon: gn,
      handles: foot.map(function (p) { return { x: p.x, z: p.z }; }),
      landed: [false, false, false, false],
      errs: null,
    };
  }

  /* ==================== round state ==================== */

  var round = 0, itemIdx = 0, itemScores = [], item = null, reported = false;
  var lastNote = '';   /* the rule verdict of the item just scored */
  var phase = 'idle'; /* 'idle' (pre-boot) | 'place' | 'reveal' | 'done' */
  var selIdx = -1;
  var dragId = null, dragIdx = -1, grabDX = 0, grabDY = 0;
  var dragType = '', lastPenAt = 0;
  /* a press on a corner PICKS it; the ray is only run once the pointer has
     actually travelled, so an exploratory tap on a screenless tablet does
     not plant a landing you then have to find and drag back */
  var pending = false, pressAt = null;
  var MIN_DRAG = 6;

  /* First-ever visit: two items, not three. Three items × four rays is
     2–3 minutes before a single reported number. */
  var FIRST_VISIT = ArtDaily.best() === null;
  var itemsThisRound = ITEMS_PER_ROUND;

  /* build an item on the current patch, then rescale the view to it */
  function newItem(level) {
    item = genItem(level);
    makeView();
    return item;
  }

  function countLanded() {
    var n = 0, i;
    for (i = 0; i < 4; i++) if (item.landed[i]) n++;
    return n;
  }

  function firstUnlanded() {
    var i;
    for (i = 0; i < 4; i++) if (!item.landed[i]) return i + 1;
    return 0;
  }

  /* how many stick-heights tall a corner is — the whole lesson, as a
     number the player can count */
  function heightRatio(i) { return item.hs[i] / GNOMON_H; }
  function ratioText(r) { return '×' + (Math.round(r * 10) / 10).toFixed(1); }

  /* The hint teaches the given first, then the RULE, then the verb. The
     rule — the shadow reaches as many times further as the corner is
     times taller — was the one thing the drill never said out loud, which
     is why copying the ruler's length felt like the intended move. */
  function placeHint() {
    var head = 'item ' + (itemIdx + 1) + ' of ' + itemsThisRound + ' — ';
    var n = countLanded();
    var i = firstUnlanded() - 1;
    if (n === 0) {
      /* The cold-open line, tightened. It used to open on "its shadow is
         your ruler: IT shows which way…", where "it" could be the stick,
         the shadow or the ruler, and then quote the same ratio twice in
         one sentence ("about ×1.4 the stick, so its shadow reaches about
         ×1.4 as far") — 285 characters, the longest first screen of the
         six drills, on the one screen a beginner reads cold. Every FACT
         is still here: the given, the rule, the verb, in that order. */
      return head + 'the stick is 1 tall and its shadow is your ruler: one stick-height, ' +
        'pointing the way every shadow here runs. corner ' + (i + 1) + ' is ' +
        ratioText(heightRatio(i)) + ' the stick, so its shadow is ' +
        ratioText(heightRatio(i)) + ' the ruler, same direction. ' +
        'drag corner ' + (i + 1) + ' down to where it lands.';
    }
    if (n < 4) {
      return head + n + ' of 4 rays run — corner ' + (i + 1) + ' is ' +
        ratioText(heightRatio(i)) + ' the stick. pull its ray next.';
    }
    return head + 'all four landed. drag any landing to fine-tune, then press done.';
  }

  /* The glyph on the primary button is DECORATION. Written straight into
     textContent, a screen reader announced the drill's main control as
     "done check mark" and then "next rightwards arrow" — the markup wraps
     every other glyph in this drill (the ↻ on "new round") in aria-hidden
     for exactly that reason, and the button a beginner presses first was
     the one that did not. Same shape the sibling drills use. */
  function setDoneLabel(txt, sym) {
    btnDone.textContent = sym ? txt + ' ' : txt;
    if (!sym) return;
    var s = document.createElement('span');
    s.setAttribute('aria-hidden', 'true');
    s.textContent = sym;
    btnDone.appendChild(s);
  }

  /* Done stays locked until every ray is run: nothing to score before
     that, and a stray tap can no longer end the item early. */
  function syncDone() {
    if (phase !== 'place') return;
    var n = countLanded();
    btnDone.disabled = n < 4;
    if (n < 4) setDoneLabel('run all 4 rays', '');
    else setDoneLabel('done', '✓');
  }

  function newRound() {
    round += 1;
    itemIdx = 0;
    itemScores = [];
    selIdx = -1;
    lastNote = '';   /* nothing from the last round may leak into this one */
    cancelDrag();
    reported = false;
    itemsThisRound = (FIRST_VISIT && round === 1) ? 2 : ITEMS_PER_ROUND;
    newItem(0);
    phase = 'place';
    btnDone.hidden = false;
    syncDone();
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = placeHint();
    draw();
  }

  function scoreList() {
    var out = [], i;
    for (i = 0; i < itemScores.length; i++) out.push(Math.round(itemScores[i]));
    return out.join(' · ');
  }

  function finishRound() {
    phase = 'done';
    btnDone.hidden = true;
    if (reported) return;
    reported = true;
    var res = ArtDaily.report(roundScore(itemScores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — items ' + scoreList() + '. ' +
      (lastNote ? lastNote + ' ' : '') + 'press “new round” to go again.';
    /* A first-ever round has no previous best, so isNewBest is
       trivially true and "new best!" celebrates nothing — on the one
       round where the number most needs saying what it IS. The SDK
       marks that round with isFirst; an older vendored SDK simply
       leaves it undefined and the old wording stands. */
    showToast(res.isFirst
      ? 'first score ' + res.score + ' / 100 — your mark to beat'
      : (res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  /* ==================== painting ====================
     A trackpad or a pen hands over positions faster than the screen shows
     them. Repainting synchronously inside every pointermove redrew the
     entire scene — ground grid, box, gnomon, both shadows, every ray and
     the ruler echo — three or four times over for one frame anybody saw.
     draw() now only ASKS for the next frame; paint() runs once, right
     before the browser composites, off the freshest position there is. */
  var rafId = 0;
  function draw() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; paint(); });
  }
  /* for paths that must not show a blank frame — a resize has already
     cleared the sheet, so it repaints on the spot */
  function paintNow() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    paint();
  }

  function paint() {
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
    drawPlayerRays(c);
    if (phase !== 'place') { drawTruthRays(c); drawMisses(c); }
    drawCorners(c);
    drawLightCue(c);
    if (phase === 'place') drawRulerEcho(c);
  }

  /* While a ray is being pulled, say how long it is IN RULERS. The whole
     lesson is that the run scales with height, and without this the
     player is eyeballing a ratio off an oblique projection — which is
     what made copying the stick's own length feel like the intended
     move. With it, the drill is measure-and-place. */
  function drawRulerEcho(c) {
    if (selIdx < 0 || !item.landed[selIdx]) return;
    var ruler = GNOMON_H / Math.tan(item.alt * DEG);
    if (!(ruler > 1e-6)) return;
    var f = item.foot[selIdx], h = item.handles[selIdx];
    var run = Math.hypot(h.x - f.x, h.z - f.z) / ruler;
    var s = toScreen(h.x, h.z, 0);
    inkText(c, ratioText(run) + ' the ruler', clamp(s.x, 52, W - 52),
      clamp(s.y + 22, 12, H - 12), 'center', 'middle', 11);
  }

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
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

  /* Graphite on a paper-coloured halo: legible over the grid, the
     shadow washes and the form, in both themes. */
  function inkText(c, txt, x, y, align, base, size) {
    ctx.save();
    ctx.font = '700 ' + size + 'px ' + MONO;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = c.card;
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = c.ink;
    ctx.fillText(txt, x, y);
    ctx.restore();
  }

  function drawGrid(c) {
    var i, a, b, p = activePatch();
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    for (i = 0; i <= p.gx; i++) {
      a = toScreen(i, 0, 0); b = toScreen(i, p.gz, 0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (i = 0; i <= p.gz; i++) {
      a = toScreen(0, i, 0); b = toScreen(p.gx, i, 0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* Only landed corners shape the player's shadow, so before the
     first ray there is nothing but the footprint on the ground. */
  function landedPts() {
    var pts = item.foot.slice(), i;
    for (i = 0; i < 4; i++) if (item.landed[i]) pts.push(item.handles[i]);
    return pts;
  }

  function drawPlayerShadow(c) {
    groundPoly(convexHull(landedPts()));
    ctx.fillStyle = c.ink;
    ctx.globalAlpha = 0.16;
    ctx.fill();
    ctx.globalAlpha = 0.62;   /* AA on the paper card; the wash is not */
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /* The wash says "sunlight"; the outline is the answer, so it is drawn
     in the graphite-weight amber at full alpha (AA in both themes). */
  function drawTruth(c) {
    groundPoly(convexHull(item.foot.concat(item.truths)));
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.26;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }

  /* Side faces are back-face culled by screen winding; every face is
     then shaded by a real lambert — its own outward normal against
     the real 3D light vector, including the tilted top. Values
     invert between the themes on purpose: graphite on paper, chalk
     in the night studio. */
  function drawBox(c, dark) {
    var f = item.foot, fs = [], ts = [], i, j, quad, s;
    var L = sunVector(item.az, item.alt);
    for (i = 0; i < 4; i++) {
      fs.push(toScreen(f[i].x, f[i].z, 0));
      ts.push(toScreen(f[i].x, f[i].z, item.hs[i]));
    }
    for (i = 0; i < 4; i++) {
      j = (i + 1) % 4;
      quad = [fs[i], fs[j], ts[j], ts[i]];
      s = (quad[0].x * quad[1].y - quad[1].x * quad[0].y) +
          (quad[1].x * quad[2].y - quad[2].x * quad[1].y) +
          (quad[2].x * quad[3].y - quad[3].x * quad[2].y) +
          (quad[3].x * quad[0].y - quad[0].x * quad[3].y);
      if (s >= 0) continue; /* facing away from the viewer */
      paintFace(quad, c, 0.18 + 0.82 * lambert(wallNormal(f[i], f[j]), L), dark);
    }
    paintFace(ts, c, 0.18 + 0.82 * lambert(topNormal(item.top), L), dark);
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
    inkText(c, 'your ruler', (a.x + b.x) / 2, Math.max(b.y, a.y) + 5, 'center', 'top', 10);
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
    /* The very first hint is built on two nouns — "the stick is 1 tall
       and its shadow is your ruler" — and only one of them existed on
       the sheet. Without this the reader has to work out which mark the
       sentence means before the sentence can teach anything, and the
       unit every ratio in the drill is quoted in ("×1.4 the stick") is
       the one that was unlabelled. */
    inkText(c, 'stick · 1 tall', clamp(t.x, 44, W - 44),
      clamp(t.y - 7, 12, H - 6), 'center', 'bottom', 10);
  }

  /* Screen direction toward the sun — the same linear map applied
     to the 3D light vector, so every ray drawn stays truly parallel. */
  function sunScreenDir() {
    var L = sunVector(item.az, item.alt);
    var sx = L.x * view.exx + L.z * view.ezx;
    var sy = L.x * view.exy + L.z * view.ezy + L.y * view.eyy;
    var l = Math.hypot(sx, sy) || 1;
    return { x: sx / l, y: sy / l };
  }

  function frameExit(p, d, inset) {
    var t = Infinity;
    if (d.x > 1e-6) t = Math.min(t, (W - inset - p.x) / d.x);
    if (d.x < -1e-6) t = Math.min(t, (inset - p.x) / d.x);
    if (d.y > 1e-6) t = Math.min(t, (H - inset - p.y) / d.y);
    if (d.y < -1e-6) t = Math.min(t, (inset - p.y) / d.y);
    if (!isFinite(t) || t < 0) t = 0;
    return { x: p.x + d.x * t, y: p.y + d.y * t };
  }

  function arrowHead(x, y, dx, dy, r) {
    var a = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(a - 0.4) * r, y - Math.sin(a - 0.4) * r);
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(a + 0.4) * r, y - Math.sin(a + 0.4) * r);
    ctx.stroke();
  }

  /* The sun is at infinity, so there is no disc to aim rays at — a
     band of parallel arrows entering the sheet says "this direction,
     everywhere", which is exactly what the reveal then draws.
     Graphite core over an amber wash, so the cue reads as sunlight and
     still clears AA in both themes: the wash is decoration (1.5:1 on
     paper, 4.1:1 on the night sheet), the graphite core carries the
     contrast — 10:1 on the card, 11:1 on the night sheet. */
  function drawLightCue(c) {
    var d = sunScreenDir(), i, k, sx, sy, ex, ey;
    var cxg = 0, czg = 0;
    for (i = 0; i < 4; i++) { cxg += item.foot[i].x / 4; czg += item.foot[i].z / 4; }
    var anchor = frameExit(toScreen(cxg, czg, topHeight(item.top, cxg, czg)), d, 30);
    var nx = -d.y, ny = d.x, len = 32;
    ctx.save();
    ctx.lineCap = 'round';
    for (k = -1; k <= 1; k++) {
      sx = anchor.x + nx * k * 12;
      sy = anchor.y + ny * k * 12;
      ex = sx - d.x * len;
      ey = sy - d.y * len;
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 6;
      line(sx, sy, ex, ey);
      ctx.strokeStyle = c.ink;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.8;
      line(sx, sy, ex, ey);
      arrowHead(ex, ey, -d.x, -d.y, 7);
    }
    ctx.restore();
    inkText(c, 'sun · parallel rays',
      clamp(anchor.x + nx * 30, 78, W - 78), clamp(anchor.y + ny * 30, 8, H - 8),
      'center', 'middle', 10);
  }

  /* The construction the player actually made: corner → landing.
     It stays up through the reveal, faded, so your ray and the true
     one can be read against each other. */
  function drawPlayerRays(c) {
    var i, t, s;
    ctx.save();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 4]);
    /* faded through the reveal so the amber reads on top — but not below
       AA, because your own construction is what you are comparing */
    ctx.globalAlpha = phase === 'place' ? 0.6 : 0.56;
    for (i = 0; i < 4; i++) {
      if (!item.landed[i]) continue;
      t = toScreen(item.foot[i].x, item.foot[i].z, item.hs[i]);
      s = toScreen(item.handles[i].x, item.handles[i].z, 0);
      line(t.x, t.y, s.x, s.y);
    }
    ctx.restore();
  }

  /* One true ray per corner: from the landing up to the top corner, and
     a stub from the corner onward toward the sun. Both in the
     graphite-weight amber — they are the answer, so they carry AA. */
  function drawTruthRays(c) {
    var d = sunScreenDir(), i, t, s;
    ctx.save();
    ctx.lineWidth = 1.6;
    for (i = 0; i < 4; i++) {
      t = toScreen(item.foot[i].x, item.foot[i].z, item.hs[i]);
      s = toScreen(item.truths[i].x, item.truths[i].z, 0);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = c.line;
      ctx.globalAlpha = 1;
      line(s.x, s.y, t.x, t.y);
      ctx.globalAlpha = 0.9;   /* the stub says "and onward to the sun" */
      line(t.x, t.y, t.x + d.x * 66, t.y + d.y * 66);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      /* landing dot: wash amber inside a graphite rim, so the dot reads
         as sunlight and its edge still clears AA on the paper sheet */
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = c.ink;
      ctx.stroke();
      ctx.lineWidth = 1.6;
    }
    ctx.restore();
  }

  /* Yours → true, per corner, with the worst one called out. */
  function drawMisses(c) {
    if (!item.errs) return;
    var i, a, b, k = worstCorner(item.errs);
    ctx.save();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([2, 3]);
    ctx.globalAlpha = 0.75;
    for (i = 0; i < 4; i++) {
      a = toScreen(item.handles[i].x, item.handles[i].z, 0);
      b = toScreen(item.truths[i].x, item.truths[i].z, 0);
      line(a.x, a.y, b.x, b.y);
    }
    ctx.restore();
    a = toScreen(item.handles[k].x, item.handles[k].z, 0);
    if (item.errs[k] > 0.02) {
      inkText(c, 'corner ' + (k + 1) + ' drifted most',
        clamp(a.x, 80, W - 80), clamp(a.y + 16, 10, H - 10), 'center', 'top', 10);
    }
  }

  /* Numbered corners: the grip you pull a ray from, and the landing
     it made. The numbers show the one-to-one pairing the score uses
     and make the 1–4 keyboard picks discoverable. */
  function drawCorners(c) {
    var i, tp, gp, revealing = phase !== 'place';
    for (i = 0; i < 4; i++) {
      tp = toScreen(item.foot[i].x, item.foot[i].z, item.hs[i]);
      if (!revealing) {
        ctx.beginPath();
        ctx.arc(tp.x, tp.y, item.landed[i] ? 4 : 7, 0, Math.PI * 2);
        ctx.fillStyle = item.landed[i] ? c.ink : c.card;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = c.ink;
        ctx.stroke();
      }
      inkText(c, String(i + 1), tp.x, tp.y - 12, 'center', 'bottom', 11);
      if (!item.landed[i] && !revealing) continue;

      gp = toScreen(item.handles[i].x, item.handles[i].z, 0);
      ctx.beginPath();
      ctx.arc(gp.x, gp.y, 9, 0, Math.PI * 2);
      /* in the reveal amber means TRUE and graphite means yours, so
         the two dot sets never have to be told apart by radius */
      ctx.fillStyle = revealing ? c.ink : c.accent;
      ctx.globalAlpha = revealing ? 1 : 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = revealing ? c.card : c.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = revealing ? c.card : c.ink;
      ctx.beginPath();
      ctx.arc(gp.x, gp.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
      if (!revealing) inkText(c, String(i + 1), gp.x + 12, gp.y, 'left', 'middle', 10);
      if (i === selIdx && phase === 'place') {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(gp.x, gp.y, 14, 0, Math.PI * 2);
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

  /* The grab offset is kept, so a regrab never teleports a landing
     you spent time placing out from under your finger. */
  function moveHandle(p) {
    var g = toGround(p.x + grabDX, p.y + grabDY);
    item.handles[dragIdx] = {
      x: clamp(g.x, 0.2, activePatch().gx - 0.2),
      z: clamp(g.z, 0.15, activePatch().gz - 0.15),
    };
  }

  /* Palm rejection: a pen press takes the sheet off a touch mid-drag, and
     a touch press is ignored for a moment after any pen. pointerId
     guarding alone only rejects the SECOND contact, and on a tablet the
     palm is usually the first. */
  function palmBlocked(ev) {
    return ev.pointerType === 'touch' && lastPenAt && (Date.now() - lastPenAt) < 1200;
  }

  /* Nearest corner or landing to a press, within `reach`. */
  function pickAt(p, reach) {
    var best = reach, bi = -1, kind = null, i, s, d;
    /* landings you already made come first — those are what you tune */
    for (i = 0; i < 4; i++) {
      if (!item.landed[i]) continue;
      s = toScreen(item.handles[i].x, item.handles[i].z, 0);
      d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < best) { best = d; bi = i; kind = 'move'; }
    }
    /* then the top corners: pressing one picks (and then runs) its ray.
       Ties go to a corner whose ray is still unrun — that is the one you
       are far more likely to have meant. */
    for (i = 0; i < 4; i++) {
      s = toScreen(item.foot[i].x, item.foot[i].z, item.hs[i]);
      d = Math.hypot(p.x - s.x, p.y - s.y) - (item.landed[i] ? 0 : 6);
      if (d < best) { best = d; bi = i; kind = 'ray'; }
    }
    return bi < 0 ? null : { i: bi, kind: kind };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!item || phase !== 'place') return;
    if (ev.pointerType === 'pen') lastPenAt = Date.now();
    if (palmBlocked(ev)) return;
    if (dragId !== null) {
      if (!(ev.pointerType === 'pen' && dragType === 'touch')) return;
      cancelDrag();
    }
    ev.preventDefault();
    canvas.focus();
    var p = pointerPos(ev), s;
    /* snap: a press up to 3× the reach still takes the nearest corner,
       because a screenless tablet cannot see its own hand and a silent
       miss there reads as "the page is frozen" */
    var hit = pickAt(p, hitRadius()) || pickAt(p, 3 * hitRadius());
    if (!hit) {
      hint.textContent = 'nothing there to pull — press one of the numbered top corners ' +
        '(near enough counts) and drag down to where its shadow lands.';
      return;
    }
    dragId = ev.pointerId;
    dragType = ev.pointerType;
    dragIdx = hit.i;
    selIdx = hit.i;
    pressAt = p;
    pending = (hit.kind === 'ray');
    if (hit.kind === 'move') {
      s = toScreen(item.handles[hit.i].x, item.handles[hit.i].z, 0);
      grabDX = s.x - p.x;
      grabDY = s.y - p.y;
    } else {
      grabDX = 0;
      grabDY = 0;
    }
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    syncDone();
    hint.textContent = pending
      ? 'corner ' + (hit.i + 1) + ' picked — it is ' + ratioText(heightRatio(hit.i)) +
        ' the stick. keep dragging, down to where its shadow lands.'
      : placeHint();
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (dragId === null || ev.pointerId !== dragId) return;
    ev.preventDefault();
    var p = pointerPos(ev);
    if (pending) {
      /* a tap is not a ray: the landing is only planted once the pointer
         has travelled far enough to be a deliberate pull */
      if (Math.hypot(p.x - pressAt.x, p.y - pressAt.y) < MIN_DRAG) return;
      pending = false;
      item.landed[dragIdx] = true;
      syncDone();
    }
    moveHandle(p);
    draw();
  });

  /* Enter can score the item while a finger is still down (the canvas
     has focus the moment you press it), so the phase may already be
     'reveal' by the time the pointer lifts — never overwrite the
     reveal's score line with the placing hint. */
  function endDrag(ev) {
    if (dragId === null || ev.pointerId !== dragId) return;
    try { canvas.releasePointerCapture(dragId); } catch (e) {}
    var wasPending = pending, i = dragIdx;
    dragId = null;
    dragType = '';
    dragIdx = -1;
    pending = false;
    if (phase === 'place') {
      syncDone();
      /* a press that never travelled was a look, not a ray: say which
         corner is now picked instead of planting a landing on it */
      hint.textContent = wasPending && i >= 0 && !item.landed[i]
        ? 'corner ' + (i + 1) + ' is picked (' + ratioText(heightRatio(i)) + ' the stick) — ' +
          'drag from it, or use the arrow keys, to run its ray.'
        : placeHint();
    }
    draw();
  }

  /* Drop any in-flight drag: its grab offset was measured against the
     old view, so carrying it across a relayout would teleport a landing. */
  function cancelDrag() {
    if (dragId === null) return;
    try { canvas.releasePointerCapture(dragId); } catch (e) {}
    dragId = null;
    dragType = '';
    dragIdx = -1;
    pending = false;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  /* a pointerup lost outside the canvas used to freeze the sheet, because
     pointerdown returns early while one is in flight */
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  /* keyboard fallback: 1–4 picks a corner, arrows run/nudge its
     landing along the ground grid, enter presses done/next */
  canvas.addEventListener('keydown', function (ev) {
    if (!item) return;
    if (ev.key === 'Enter') {
      /* never a dead end: done, then next, then a fresh round */
      if (phase === 'done') newRound();
      else if (!btnDone.hidden && !btnDone.disabled) btnDone.click();
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
    item.landed[selIdx] = true;   /* the first nudge runs that ray */
    h = item.handles[selIdx];
    if (ev.key === 'ArrowLeft') h.x -= step;
    else if (ev.key === 'ArrowRight') h.x += step;
    else if (ev.key === 'ArrowUp') h.z += step;
    else h.z -= step;
    h.x = clamp(h.x, 0.2, activePatch().gx - 0.2);
    h.z = clamp(h.z, 0.15, activePatch().gz - 0.15);
    syncDone();
    hint.textContent = placeHint();
    draw();
    ev.preventDefault();
  });

  /* ==================== done / next / round flow ==================== */

  btnDone.addEventListener('click', function () {
    if (!item || btnDone.disabled) return;
    if (phase === 'place') {
      var n = 0, i;
      for (i = 0; i < 4; i++) if (item.landed[i]) n++;
      if (n < 4) return;
      var r = itemScore(item.handles, item.truths, item.diag,
        deadZone(item.diag, view.s, ease, COARSE));
      item.errs = r.errs;
      itemScores.push(r.score);
      lastNote = ruleNote(item.handles, item.foot, item.truths);
      phase = 'reveal';
      draw();
      if (itemIdx === itemsThisRound - 1) {
        finishRound();
      } else {
        btnDone.disabled = false;
        setDoneLabel('next', '→');
        hint.textContent = 'item ' + (itemIdx + 1) + ': ' + Math.round(r.score) +
          '/100 — ' + (lastNote ? lastNote + ' ' : '') +
          'amber is the true shadow, the dotted hops show your miss. press next.';
      }
      return;
    }
    if (phase === 'reveal') {
      itemIdx += 1;
      selIdx = -1;
      cancelDrag();   /* a pointer held across the reveal must not
                         drag the fresh item's landing by an old offset */
      newItem(itemIdx);
      phase = 'place';
      syncDone();
      /* the rule quietly changes here — say so, instead of repeating
         item 1's hint over a shape that no longer behaves like item 1 */
      hint.textContent = (itemIdx === 1 ? 'the top is a slope now, so the four corners are ' +
        'four different heights — each ray is its own length. ' : '') + placeHint();
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
  /* "new round" arms first when it would throw away a live round — a
     second press within the window confirms, otherwise it snaps back.
     An unfinished round is never reported, so a mis-tap here used to
     bin every item scored so far without a word. (The five sibling
     drills all guard this button; this one did not.) */
  var btnRound = document.getElementById('btnRound');
  var roundArmTimer = null, roundArmed = false;
  function disarmRoundBtn() {
    roundArmed = false;
    clearTimeout(roundArmTimer);
    btnRound.innerHTML = 'new round <span aria-hidden="true">↻</span>';
  }
  btnRound.addEventListener('click', function () {
    if (itemScores.length && phase !== 'done' && !roundArmed) {
      roundArmed = true;
      btnRound.textContent = 'discard round?';
      roundArmTimer = setTimeout(disarmRoundBtn, 2600);
      return;
    }
    disarmRoundBtn();
    newRound();
  });

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(function () { inkCache = null; paintNow(); });
  /* the hardware can change mid-session (a laptop user plugs in a
     tablet): the pick radius and the dead zone follow it */
  ArtDaily.onInput(draw);
  /* Handles live in ground units, so a relayout costs nothing but the
     grab offset of a drag that is still in flight — which is why a resize
     that moved nothing must not take that drag away. */
  var resizeRaf = 0;
  window.addEventListener('resize', function () {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () {
      resizeRaf = 0;
      var before = W;
      if (!fitCanvas()) return;
      if (before) cancelDrag();
      paintNow();   /* fitCanvas already blanked the sheet — no empty frame */
    });
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
