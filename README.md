# Cast Shadow — Art Daily

Construct the shadow the light demands. A form sits on a ground grid, the
sun is directional (at infinity — a band of parallel arrows at the frame
edge, no disc to converge rays on), and a little gnomon stick nearby always
casts its *true* shadow. That stick is the given: your ruler for direction
and for how far one stick-height of shadow runs.

**Run one ray per corner.** Press a numbered top corner, pull the stroke
down to where you think its shadow lands, release. Four rays, then done —
and the exact shadow inks itself over yours in amber, with a dotted hop
from each of your landings to its true one and the worst corner called
out. The rays you drew stay on the sheet: that *is* the construction.

Item 1 is a flat-topped box under a high sun. From item 2 the top is a
tilted plane, so the four corners sit at four different heights and each
ray has its own length — four drags that encode four facts, not one
translation repeated. Item 3 adds a low sun and a rotated form.

## Real 3D underneath

`sunVector()` builds the true unit light direction from azimuth and
altitude; `shadowOffset()` is that ray marched to the ground, so
`projectCorner()` is the exact planar projection `S = P − L·(P.h / L.h)`.
The top is a real plane (`topHeight()`), and every face — the tilted top
included — is shaded by a real lambert of its own outward normal
(`topNormal()`, `wallNormal()`) against that light vector. `sunScreenDir()`
pushes the same 3D vector through the same oblique view map, so the drawn
rays are genuinely parallel.

## Scoring

Pure functions at the top of `js/game.js`, no canvas or DOM in sight. Per
item, `itemScore()` returns the mean distance between each landing and its
true one, normalized by the true shadow's bounding diagonal —
`100 · clamp(1 − meanErr/0.28, 0, 1)`, with a small dead-zone forgiven
first so a pixel-perfect construction reads 100 — plus the per-corner
errors, which drive the reveal's miss hops. A round is the mean of 3 items.

Run it: `python3 -m http.server 8080` in this folder — no build, no deps.

Part of [Art Daily](https://artdaily.sadeali.com/) · a
[SadeAli](https://sadeali.com/) experiment.
