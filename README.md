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

**The rule is said out loud, and shown while you work.** The stick is 1
tall; the hint names how many stick-heights the corner you are about to
pull is (`×1.8 the stick`), and while you drag, the sheet echoes how long
your ray currently is in rulers. Copying the ruler's own length — the
mistake the old hint invited, which scored 81 on item 1 and exactly 0 on
item 3 — is now visibly the wrong move.

Item 1 is a flat-topped box under a high sun. From item 2 the top is a
slope, so the four corners sit at four different heights and each ray has
its own length — the hint says so at the moment it changes, instead of
repeating item 1's line over a shape that no longer behaves like item 1.
Item 3 adds a low sun and a rotated form; a first-ever round keeps that
sun higher and runs 2 items instead of 3, so the first reported score
arrives in about a minute.

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
`100 · clamp(1 − meanErr/0.28, 0, 1)`, with a dead-zone forgiven first so
a construction as good as the hand allows reads 100 — plus the per-corner
errors, which drive the reveal's miss hops. A round is the mean of its
items.

**The dead zone is the hardware's, the ramp is yours.** `deadZone()` takes
0.012 diagonals as the pen standard, opens it with `ArtDaily.ease()` (×2
mouse or trackpad, ×1.5 finger) and floors it in *pixels* — 3px eased, 8px
on a coarse screen, converted through the view scale — because 0.012 of a
diagonal is ~1.7px on a desktop sheet and under 1px on a phone, i.e. below
every input device's own noise except a nib's. The 0.28 ramp is identical
on every device on purpose: what this drill measures is the proportional
rule, not steadiness, so widening the ramp would only pay people for not
running the rays.

**Targets and the small-sheet problem.** Corners are picked within
`max(1.05 grid units, ArtDaily.startRadius(24))` — 41px on a pen tablet,
which acquires these blind — a press up to 3× that away **snaps** to the
nearest one, a press with nothing in range says so instead of doing
nothing, and ties go to a corner whose ray is still unrun. A press alone
no longer plants a landing: the ray runs once the pointer has travelled
6px, so an exploratory tap is free. And a narrow canvas now gets a
*smaller ground patch* (8×5 units instead of 10×6) plus a taller sheet, so
the grid unit everything is measured in grows ~20% on a phone instead of
squeezing four 44px targets into a 40px box.

Run it: `python3 -m http.server 8080` in this folder — no build, no deps.

Part of [Art Daily](https://artdaily.sadeali.com/) · a
[SadeAli](https://sadeali.com/) experiment.
