---
key: mem-11ebc1bf73b9dcca-539
ns: default
created: 1779889569799
updated: 1779889569799
---

## Resolved mutable: perf-baseline-fps

CHANNEL=chrome measure-fps.mjs 500 1000 on RTX 3060 Laptop GPU (ANGLE D3D11), fps-measurement.json: 500 distinct = 111.19 FPS median (min 65.5 max 171.6, visible 498, far 442, draws=3); 1000/954 distinct = 83.22 FPS median (min 36.9 max 164, visible 956, far 892, draws=0). KEY: draw calls are 0-3 — the BatchedMesh far tier already collapsed the prior 734-draw bottleneck (was 63 FPS). Renderer is now GPU-bound (fill/vertex/upload), not draw-call-bound. Both counts far exceed the 60 FPS target.
