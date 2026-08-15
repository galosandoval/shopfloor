---
'@galosandoval/shopfloor': minor
---

Sharpen the authorization guard shipped in 0.11.0 (shopfloor#41).

**Breaking for anyone constructing an `AuthorizationInput` by hand.**
`PermissionProbe`'s discriminant is now `answered`, not `read`: `read` is also
one of the permission levels being judged, and `{ read: true, permission:
'read' }` reads as a contradiction it is not. `AuthorizationInput.probe` is now
optional — omit it and the verdict is `undetermined` with "the permission was
never probed", which is what a caller that skipped the probe should get rather
than a probe result invented on its behalf. Callers of `runAuthorization` (the
shell) and of `shopfloor-authorize` (the bin) are unaffected; only direct
callers of the pure `evaluateAuthorization` need to rename the field.

**The probe now reads `role_name`.** `runAuthorization` shells
`gh api repos/{repo}/collaborators/{actor}/permission --jq '.role_name //
.permission'`. The endpoint's legacy `permission` field reports only `admin` /
`write` / `read` / `none`, which collapses `maintain` into `write` and `triage`
into `read` and makes two of the levels this guard distinguishes unreachable.
An API old enough not to send `role_name` falls back to `permission` rather
than refusing.

**New failure mode: custom repository roles are now refused.** An
organization's custom role arrives as a name this guard has never seen, so its
holder is `undetermined` and the run stops — deliberate, given the guard
refuses on uncertainty, but it will stop a run that the previous
`permission`-field probe would have allowed. If your org uses custom roles,
check that the actors triggering runs hold `admin`, `maintain`, or `write`
directly.

An authorized verdict's `permission` is now the exported `SpendingPermission`
union rather than `string`, so a caller switching on it gets exhaustiveness
from the compiler.

One internal move rides along: `asExecFailure` in `src/process/` is now the
single narrowing of a rejected `execFile`, shared by the doctor's probe and
this one, along with the `node:child_process` stub their wiring tests use. Not
exported; nothing about the public surface changes there.
