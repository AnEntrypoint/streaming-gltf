---
key: mem-bbebf0ad291b8ca1-910
ns: default
created: 1779818622717
updated: 1779818622717
---

gltf-progressive perf sweep (commit 6300c41=reapply of ea4533a): renderer.sortObjects=false + info.autoReset=false+manual reset, scene.matrixAutoUpdate=false, HUD/chart throttled to ~10Hz (innerHTML every 6th frame), Int8-normalized normals in lod-worker extractGeometry (1B/comp, normalized:true preserved). All witnessed glError 0, correct shading. MEASUREMENT LESSON: ad-hoc gm-browser FPS samples at ~9s are MID-LOAD (assets still streaming 660-750/954, decode competes -> ~6 FPS / msEntities 26ms) and LIE — both reverted and applied states showed identical ~6 FPS mid-load. MUST sample steady-state: wait until getStats().inFlight==0 && assets==954 THEN sample. Steady-state far-camera (all 951 visible) = ~54 FPS; framing matters (worst case = all visible). measure-fps.mjs adaptive warmup handles this; ad-hoc samples must replicate the inFlight==0 wait. Nearly reverted good work over this artifact.
