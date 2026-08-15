/**
 * The package's public surface: the verbs a consumer calls, the error they
 * throw, the pure escape hatches the README documents (`evaluatePreflight`,
 * `buildVerifyComment`, `classifyCommand`, `evaluatePluginDirs`,
 * `checkTrajectory`, `evaluateIteration`, `evaluateSetup`), the bundled
 * plugin's resolved location — API because
 * a stated `pluginDirs` replaces the default, so naming it alongside your own
 * has to be writable rather than guessable — and the types
 * of what goes in and comes out. Resolvers, invocation assembly, transcript
 * capture, and reference parsing are internals — they exist as test seams, not
 * as API.
 */

export {
  runImplementAgent,
  type RunImplementAgentResult
} from './orchestration/implement'

export { ImplementAgentError } from './orchestration/implement-error'

export { type RunImplementAgentConfig } from './orchestration/config'

export {
  DEFAULT_RUN_POLICY,
  type RunPolicyConfig
} from './guardrails/run-policy'

export { type CliVersionStrictness } from './guardrails/cli-version'

export {
  evaluateIteration,
  type GateResult,
  type IterationInput,
  type IterationVerdict
} from './orchestration/iteration'

export {
  evaluatePreflight,
  type LinkingPullRequest,
  type PreflightInput,
  type PreflightVerdict
} from './guardrails/preflight'

export {
  runPreflight,
  type RunPreflightInput,
  type RunPreflightResult
} from './guardrails/run-preflight'

export {
  evaluatePluginDirs,
  type PluginCapability,
  type PluginDirFacts,
  type PluginDirsVerdict
} from './guardrails/plugin-dirs'

export { runPluginDirsCheck } from './guardrails/run-plugin-dirs'

export { resolveBundledPluginDir } from './orchestration/bundled-plugin'

export {
  classifyCommand,
  type BlockedVerdict,
  type CommandVerdict
} from './guardrails/command-policy'

export {
  buildVerifyComment,
  type VerifyCommentInput
} from './guardrails/verify-comment'

export {
  postVerifyComment,
  type PostVerifyCommentInput,
  type PostVerifyCommentResult
} from './guardrails/post-verify'

export {
  checkTrajectory,
  formatScorecard,
  DEFAULT_HEADROOM_FRACTION,
  DEFAULT_GATE_COMMAND_PATTERNS,
  TRAJECTORY_INVARIANT_IDS,
  type CheckTrajectoryOptions,
  type TranscriptEvent,
  type TrajectoryEvidence,
  type TrajectoryFinding,
  type TrajectoryInvariantId,
  type TrajectoryStatus
} from './observability/trajectory'

export {
  runTrajectoryCheck,
  type RunTrajectoryCheckInput,
  type RunTrajectoryCheckResult
} from './observability/run-trajectory-check'

/**
 * The doctor. The constants exported alongside it are the ones a consumer can
 * act on today — the labels to create, the tokens a prompt must carry, the
 * fences that make an environment block checkable. The check ids, the admitted
 * events, and the config defaults stay internal until something outside this
 * package needs them: every export is a compatibility commitment, and `init`
 * does not exist yet.
 */
export {
  evaluateSetup,
  formatSetupReport,
  ENVIRONMENT_BLOCK_END,
  ENVIRONMENT_BLOCK_START,
  ENVIRONMENT_UNFILLED_SENTINEL,
  PROMPT_TOKENS,
  REQUIRED_LABELS,
  type SetupCheck,
  type SetupCheckId,
  type SetupCheckStatus,
  type SetupFacts,
  type SetupVerdict
} from './setup/setup'

export { probeSetup } from './setup/probe-setup'

export { type DoctorConfig } from './setup/setup-config'
