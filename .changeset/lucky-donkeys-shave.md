---
'@galosandoval/shopfloor': patch
---

Establish a Changesets release pipeline. `ci.yml` is replaced by `release.yml`,
whose `verify` job runs lint/typecheck/test/build (plus `changeset status` on
PRs) and whose `release` job publishes to npm via an OIDC trusted publisher
with provenance. No package behavior changes; README gains a versioning
section and its consumer-repo references are corrected to `recipe-chat-v1`.
