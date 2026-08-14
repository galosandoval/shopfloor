---
---

Deflake the `spawnClaude` runaway-guard tests. Their budgets were shorter than
the stand-in child's own node startup, so on a loaded runner a guard could trip
before the child had booted — no shipped code changed, and consumers see no
behaviour difference.
