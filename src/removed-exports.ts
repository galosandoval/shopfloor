/**
 * **Refusal shims for the verbs the public surface stopped exporting**
 * (shopfloor#51). Four of them collapsed into `runPhase` in shopfloor#47:
 * `runImplementAgent`, `runPreflight`, `postVerifyComment`, and
 * `runPluginDirsCheck`. They still exist — `runPhase` composes them — they are
 * simply not the interface any more.
 *
 * **An export is refused for the same reason a field is.** Deleting one reaches
 * a caller who typechecks against this package and nobody else; a JavaScript
 * consumer gets `undefined`, and the failure they see is
 * `runPreflight is not a function` at the point of call — a sentence that names
 * neither what replaced it nor that anything was decided. So each name stays,
 * as a function that throws what a migration note would have said.
 *
 * **They throw when called, not when imported**, because an import that threw
 * would take down a module doing nothing but re-exporting, and the caller this
 * is for finds out at the call site either way.
 */

/** The sentence every one of these shares: what the four became. */
const ONE_VERB =
  '`runPhase` is the whole surface now (shopfloor#47): it reads the webhook ' +
  'payload at GITHUB_EVENT_PATH, and owns the branch, the pull request, and ' +
  "the issue's state for the phase the payload named."

function removed(name: string, detail: string): never {
  throw new Error(
    `\`${name}\` was removed from the public surface in 1.0.0 — ${detail}\n\n${ONE_VERB}`
  )
}

/**
 * The phase's own run, internal since shopfloor#47. Its pure half —
 * `resolveImplementConfig` — is still exported, and is what a caller
 * inspecting a run's configuration wanted from it.
 */
export function runImplementAgent(): never {
  return removed(
    'runImplementAgent',
    'it is the step `runPhase` runs after admission and preflight admit the ' +
      'run, not a step to sequence yourself. `resolveImplementConfig` is ' +
      "still exported, and is what a caller inspecting a run's configuration " +
      'wanted from it.'
  )
}

/**
 * The preflight shell. `evaluatePreflight`, the decision it was wrapped
 * around, still ships — assert against that.
 */
export function runPreflight(): never {
  return removed(
    'runPreflight',
    'the judgement it made is `evaluatePreflight`, which is still exported; ' +
      'the probing around it belongs to `runPhase`.'
  )
}

/**
 * The verify comment's shell. `buildVerifyComment` still ships and is the half
 * worth calling — the other half was one `gh` invocation.
 */
export function postVerifyComment(): never {
  return removed(
    'postVerifyComment',
    'the comment itself is `buildVerifyComment`, which is still exported; ' +
      'posting it is part of the phase.'
  )
}

/**
 * The plugin-directory check's shell. `evaluatePluginDirs` still ships.
 */
export function runPluginDirsCheck(): never {
  return removed(
    'runPluginDirsCheck',
    'the check is `evaluatePluginDirs`, which is still exported; running it ' +
      'against the filesystem is part of the phase.'
  )
}
