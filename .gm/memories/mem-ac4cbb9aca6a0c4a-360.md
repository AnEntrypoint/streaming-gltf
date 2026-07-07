---
key: mem-ac4cbb9aca6a0c4a-360
ns: default
created: 1782915613790
updated: 1782915613790
---

## Resolved mutable: assets-master-push-huge-fails

Decision: reset master to origin/cluster-lod (blobs already on origin) then re-apply only the cluster-only purge+manifest+workflow delta (small), so master push transfers deletes+small files not 1GB. Avoids the re-baked-GLB byte-churn that caused the send-pack disconnect. Re-scoped assets-master-merge-push.
