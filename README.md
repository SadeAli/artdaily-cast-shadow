# Cast Shadow — Art Daily

Construct the shadow the light demands. A box sits on a ground grid; a sun
is pinned at the frame edge and a little gnomon stick nearby always casts
its *true* shadow — that's the given. Drag the four handles (the box's top
corners, projected to the ground) to where the shadow must fall, press
done, and the exact shadow inks itself over yours, one light ray per
corner. Trains perspective and values: a cast shadow is a projection, not
a smudge.

Scoring (pure functions in `js/game.js`): per item, the mean distance
between each handle and its true projected corner, normalized by the true
shadow's bounding diagonal — `100 · clamp(1 − meanErr/0.28, 0, 1)`.
A round is the mean of 3 items, ramping from high sun to a low sun with a
rotated box.

Run it: `python3 -m http.server 8080` in this folder — no build, no deps.

Part of [Art Daily](https://artdaily.sadeali.com/) · a
[SadeAli](https://sadeali.com/) experiment.
