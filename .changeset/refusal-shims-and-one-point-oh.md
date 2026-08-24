---
'@galosandoval/shopfloor': major
---

`1.0.0` — the loop is closed, and every input it stopped accepting now refuses
by name (shopfloor#51).

**Why a major rather than another `0.x`.** This release is several times larger
than the one that last raised the question, and it is the first in which the
package **writes to your repository during a run**: the branch, the draft pull
request, the issue's labels, and its own handoff commits under `attemptsDir`.
The surface change beside it is the largest this package has made — four verbs
collapsed into one. Since consumers exact-pin (and the scaffolded workflow pins
both `npx` invocations and the CLI install), the bump costs nothing
operationally; it is a truthful signal, not a claim that the surface has stopped
moving. From here semver applies: breaking is a major, a minor is additive.

**Nothing removed is silently ignored.** Every field, environment variable,
result field, and bin removed across the loop sequence is refused by name, with
what replaced it. `standardsDir` set the precedent (shopfloor#27) and this
generalizes it, for the same reason: a type removal only reaches a caller who
typechecks against this package, while the binding that actually breaks is CI
still exporting a variable — where a plain deletion produces no type error, no
runtime error, and a run doing something its operator did not ask for.

| Removed                             | Refuses where                | What to do instead                                                                                                    |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `issueNumber` / `ISSUE_NUMBER`      | `runPhase`, before admission | Nothing — the payload names the issue                                                                                 |
| `issueTitle` / `ISSUE_TITLE`        | `runPhase`, before admission | Nothing — read from the issue once, so the prompt and the PR cannot disagree                                          |
| `branch` / `BRANCH`                 | `runPhase`, before admission | Nothing — the branch is `agent/issue-<n>`; `agentBranchForIssue` names it if your glue needs to                       |
| `repo`                              | `runPhase`, before admission | Nothing — the payload's repository is the run's                                                                       |
| `promptTemplate`                    | `runPhase`, before admission | `prompts: { implement }`, or `PROMPT_FILE`; unstated, the shipped per-phase shim runs                                 |
| `standardsDir` / `STANDARDS_DIR`    | configuration resolution     | `pluginDirs` / `PLUGIN_DIRS`; coding standards belong in the repository being worked on                               |
| `PermissionProbe.read`              | `evaluateAuthorization`      | `answered` — the discriminant was renamed because `read` is also a permission level being judged                      |
| `permission` on an admitted verdict | reading the field            | `authorizedBy` — `{ via: 'permission', permission }` on the human edge, `{ via: 'continuation' }` on the machine edge |
| `shopfloor-implement <issue>`       | the bin itself               | `shopfloor-run-phase`, which takes no arguments                                                                       |

**New failure modes, by name.**

- **A halfway-migrated call or workflow now fails before admission runs.** If
  your glue still passes `issueNumber` / `branch` / `repo` / `issueTitle` /
  `promptTemplate`, or still exports `ISSUE_NUMBER`, `ISSUE_TITLE`, or `BRANCH`
  in the step that runs `shopfloor-run-phase`, the run throws
  `ImplementAgentError` naming every one it found — before the spend gate,
  before a label moves, before a token is spent. Nothing is written. The fix is
  in the message; deleting the variable is the whole of it.
- **`GITHUB_REPOSITORY` and `GITHUB_REF_NAME` are deliberately not refused**,
  even though `repo` and `branch` once resolved from them. The runner sets both
  on every job, so refusing on their presence would refuse every run in GitHub
  Actions. Only names this package asked you to set are checked.
- **An empty value never refuses.** `ISSUE_NUMBER=` is a consumer who has
  already migrated. A stated field and a set variable each refuse on their own,
  so a stated value is not a way to mask a variable your workflow still exports.
- **`verdict.permission` on an admitted admission now throws** instead of
  reading `undefined`. It is a non-enumerable getter, so a spread,
  `util.inspect`, and `JSON.stringify` — how `shopfloor-admit` hands the verdict
  to a workflow — are all unaffected. **Read the limit of that plainly:** a
  JavaScript caller gets the sentence, and a workflow doing
  `fromJSON(steps.admit.outputs.verdict).permission` gets `null` with no
  refusal, because a value that has left the process cannot refuse. That
  serialized read is why the field is named in this table rather than only in
  the diff — check your YAML for it.
- **`PermissionProbe`'s old `read` discriminant now refuses.** A probe still
  shaped `{ read: … }` returns `undetermined` naming the rename, where it
  previously fell into the un-answered branch and reported "the probe answered
  nothing" — a true sentence about a token that was working fine. Detected by
  the key being present, so `read: false` refuses too.
- **`ISSUE_NUMBER`, `ISSUE_TITLE`, and `BRANCH` are no longer read anywhere**,
  not even by the internal config resolver, which kept them as fallbacks. A
  fallback that still read a variable the verb refuses would be a second,
  quieter answer to a question the payload settles. `GITHUB_REF_NAME` and
  `GITHUB_REPOSITORY` are untouched.
- **Not shimmed, and named here instead** (a moved verdict spelling cannot be):
  since `0.17.0` a `[bot]` actor on the human edge refuses as `not-permitted`
  rather than `undetermined`. If your glue branches on that spelling, it moved.
- **`shopfloor-implement` exits non-zero with a migration message.** It ships
  rather than being deleted because `npx` answers a bin a package no longer
  declares by fetching whatever the registry has published under that name,
  which is not a thing to leave pointing at an unclaimed name inside a
  fully-permissioned run.

**Also in this release:** `CLAUDE.md`'s scope boundary is restated as a set of
decisions rather than left to be inferred — the two capability classes that did
not exist before (the package **writes to** your repository during a run, and
**configures** it when a human runs `init`), the prompt-content line amended for
the per-phase shim, the consumer-env-var line recording that the class is broken
by six package-owned label names, and the CI-glue line amended for the branch,
the pull request, the issue state, and the scaffolded workflow template. The
`README.md` is accurate against the final surface.
