---
'@galosandoval/shopfloor': minor
---

`shopfloor init` — one command from an empty repository to a working loop
(shopfloor#43).

**New bin: `shopfloor-init`.** `doctor` tells you what is wrong with your setup;
`init` fixes the half a command can. It runs `doctor`'s evaluation first and
writes only what that verdict says is missing: the six labels, the workflow
wired to `issues.labeled` and `workflow_run.completed`, and the prompt carrying
the six substituted tokens.

**The environment block is filled, not left as a placeholder.** `init` reads
your lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`)
and your `package.json` scripts, and writes the install command and the gate —
`pnpm run typecheck && pnpm run test` — into the prompt's fenced environment
block. Where it cannot determine a value it writes the `TODO(shopfloor)`
sentinel, which `doctor`'s `prompt-environment-block` check already fails on.
Never an empty string and never prose: a scaffold that emitted a plausible
default would replicate the `standardsDir` failure shape in the one file a run
cannot work without.

**New check: `workflow-unfilled`.** The same sentinel names what `init` cannot
know about the workflow — the `workflow_run` source, and the `claude` version
when no `CLI_VERSION` is stated — and this check is what refuses on it. Read
this as a new failure you will see: **a repository `init` just scaffolded fails
`doctor` on `workflow-unfilled` until you replace those values.** That is the
point. Without it a scaffolded workflow reads fully green while its machine
edge is dead, because a `workflow_run` block whose `workflows:` names a
sentinel is still wired to the event and passes `workflow-triggers`. If you
consume `SetupCheckId`, it has gained a member.

**This is the first thing in this package that writes to your repository**, so
the constraints matter as much as the capability:

- **Re-runnable.** A second run on a configured repository writes nothing.
- **Never a silent overwrite.** An existing file is left alone or rewritten only
  after you confirm it by name. With no TTY attached — in CI — every overwrite
  is declined, so this is safe to run there, though a fresh repository will
  still have labels created and files scaffolded.
- **An unreadable `gh` creates nothing.** A label probe that answered `unknown`
  is not evidence of a missing label, and creating six on no evidence is a
  durable write to a shared human workspace.
- **A prompt whose environment `init` cannot account for is left alone.** No
  fences means the environment is prose this command cannot locate. A rewrite
  for a missing _token_ keeps an already-filled block verbatim rather than
  rebuilding it. And a block still carrying the sentinel on a project that
  states nothing to fill it with is skipped, not re-derived — otherwise every
  run would ask you to approve an overwrite of a file `init` itself wrote.

What `init` does not do, and names in its report instead: set secrets,
authenticate `gh`, or merge the scaffolded workflow to your default branch —
without which the `workflow_run` edge cannot fire. Every planned write carries
the reason it is there, and the merge rides on the action that creates the need
for it, because with no workflow on disk the doctor reports that check unknown
rather than failing and nothing else would say it.

**The scaffolded workflow is a starting point you own**, wired to both events,
checking out with the PAT, running the spend gate first, and **installing the
`claude` CLI** — the harness spawns it from PATH, and nothing else on a fresh
runner puts it there, so a scaffold without that step produced a workflow that
could not run. Both `npx` invocations and that install are pinned: to the
version of this package doing the scaffolding, and to your `CLI_VERSION`. Its
job condition filters the label on `issues` without filtering `workflow_run`
out of existence — `github.event.label` is null on that event, so a bare label
condition would ship a workflow that passes its own doctor with the loop half
of it dead. Three things in it are inert by design and marked with the
sentinel: the CI workflow whose completion retriggers the loop, the CLI version
when you state none, and how a `workflow_run` event resolves to an issue number
— the outer loop, designed and not shipped.

**The six labels are created with a colour and a description**, not as bare
names GitHub then colours at random.

**New exports:** `runInit`, `formatInitResult`, `LABEL_VOCABULARY` with the
`LabelDefinition` type, and the types `RunInitInput`, `RunInitResult`,
`InitPlan`, `InitAction`, `CreateLabelsAction`, `WriteFileAction`, `InitSkip`.
The planner, the scaffold builders, and the project probe stay internal — the
command is the surface. **`REQUIRED_LABELS` is now `readonly string[]`** rather
than a literal tuple, derived from `LABEL_VOCABULARY`; code that depended on
the literal member types will need widening.

**Two scope lines in `CLAUDE.md` are amended** rather than quietly stretched:
the package now ships a prompt _skeleton_ (a shim to the skills plugin — the
content is still read off your project, never shipped) and a workflow template
(a starting point you then own; nothing reads it back). Label creation lands
here, at a moment a human asked for it, which is where design §11 puts it — but
nothing is being removed from a run: no run has ever created a label, and a
run's side stays verify-and-refuse. No existing behaviour changes.
