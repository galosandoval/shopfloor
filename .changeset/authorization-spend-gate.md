---
'@galosandoval/shopfloor': minor
---

Add the authorization guard — the spend gate (shopfloor#41).

On a public repository, anyone who can add a label can start a run that spends
the maintainer's Claude subscription. Until now the only thing standing between
a stranger and that spend was a line of YAML in each consumer's workflow
(`github.actor == '<name>'`), with no test anywhere. This ships it as a typed,
tested guard.

**New API.** `evaluateAuthorization` (pure: probed permission + actor → verdict)
and `runAuthorization` (the shell: probes
`gh api repos/{repo}/collaborators/{actor}/permission --jq '.role_name // .permission'`,
returns the verdict, writes nothing). `SPENDING_PERMISSIONS` and the
input/verdict types are exported alongside them, plus a `SpendingPermission`
union — an authorized verdict's `permission` is now that union rather than
`string`, so a caller switching on it gets exhaustiveness from the compiler.

`PermissionProbe`'s discriminant is `answered`, not `read`: `read` is also one
of the levels being judged, and `{ read: true, permission: 'read' }` reads as a
contradiction it is not. `AuthorizationInput.probe` is optional — omit it and
the verdict is `undetermined` with "the permission was never probed", which is
what a caller that skipped the probe should get rather than a probe result
invented on its behalf.

**New bin: `shopfloor-authorize`.** Prints the verdict and exits non-zero on any
refusal, so a job that has installed nothing can run it first:

```yaml
- run: npx -y @galosandoval/shopfloor@<version> shopfloor-authorize
```

`GITHUB_ACTOR` and `GITHUB_REPOSITORY` come from the runner; `GH_TOKEN` must be
able to read the repository's collaborator permissions. A spend gate that runs
after the runner's setup has already let the spend happen, which is why it is
its own bin rather than a step inside the existing ones.

**New failure mode, and it is deliberate: this guard refuses on uncertainty.**
Every other guardrail in this package proceeds when its signal is unreadable,
because a missing diagnostic should not cause an outage. This one does the
opposite — an errored probe, an empty answer, or a permission level it does not
recognize all refuse. Concretely, a run triggered by an authorized maintainer
will now **fail** if `gh` is missing, unauthenticated, rate-limited, or the
token cannot read collaborator permissions. That is the intended direction: an
unreadable permission is not permission. The verdict distinguishes
`not-permitted` (the probe answered no) from `undetermined` (it answered
nothing usable), so a broken token is not reported as a trespasser.

Only `admin`, `maintain`, and `write` may spend — a `triage` collaborator can
add a label, and labeling is not spending. The probe reads the endpoint's
`role_name`, not its legacy `permission` field: that one reports only `admin` /
`write` / `read` / `none`, which would collapse `maintain` into `write` and
`triage` into `read` and make two of those levels unreachable. An API old
enough not to send `role_name` falls back to `permission` rather than refusing.
One consequence worth knowing before you upgrade: an organization's **custom
repository role** now arrives as a name this guard has never seen, so its
holder is `undetermined` and refused — deliberate, but it will stop a run that
a permission-field probe would have allowed. That set (`SPENDING_PERMISSIONS`,
exported) is fixed rather than configurable, for the reason the label
vocabulary is: a stated set could only be validated against a role model this
package does not own, and one consumer writing `['read']` would undo the guard
with no error anywhere. An actor or repository that is not a well-formed GitHub
login / `owner/repo` is `undetermined` and never probed.

Nothing existing changes: no current export, verb, or run behaviour is touched,
and a consumer who does not call the new guard is unaffected. Consumers should
replace their workflow's `github.actor == '<name>'` condition with a setup-free
job running `shopfloor-authorize`; the YAML check is not deleted by this
release, since it is in the consumer's repository.

One internal move rides along: `asExecFailure` in `src/process/` is now the
single narrowing of a rejected `execFile`, shared by the doctor's probe and
this one, along with the `node:child_process` stub their wiring tests use. Not
exported, nothing about the public surface changes.
