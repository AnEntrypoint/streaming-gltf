---
key: mem-aad48b9cb20fe47c-1132
ns: default
created: 1779876122393
updated: 1779876122393
---

## Resolved mutable: lod-switch-stutter-cause

Instrumented _applyLod (browser-639): a 6-step zoom cycle fired 17,545 switches (avg 53-92ms incl async loads, max 2685ms); still camera fired 404 switches/2s (browser-644) = perpetual re-fire. ROOT CAUSE: per-entity LOD picker (_pickMeshLod) ran every frame for every visible entity with NO dead-band, and the FPS-controller's _lodDistanceScale hunting + orbit camera continuously crossed thresholds -> flip every frame; the 3-LOD [0,2,4] mapping made it jump straight LOD0<->LOD4 (lodHist {0:171,4:328}, no middle). Each switch also allocated a new THREE.Mesh/SkinnedMesh + swapped material (shader program change) on vertcolor<->textured. FIX (3 parts): (1) picker hysteresis ±18% dead-band keyed on current ladder index; (2) per-pool _lodEpoch bumped only on camera-move or scale-change>4% — entities re-pick only when epoch changes, so still camera = 0 re-picks; (3) default to 5-LOD ladder [0,1,2,3,4] not 3-LOD. Witnessed browser-656/658: still camera switches 404->0; zoom-cycle switches 17545->10; frame times p50 6.9ms p99 9.9ms max 19.2ms (was max 2685ms) = stutter gone.
