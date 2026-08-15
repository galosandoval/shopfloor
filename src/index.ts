/**
 * The package's public surface: the verbs a consumer calls, the error they
 * throw, the pure escape hatches the README documents (`evaluatePreflight`,
 * `buildVerifyComment`, `classifyCommand`, `evaluatePluginDirs`,
 * `checkTrajectory`, `evaluateIteration`, `evaluateSetup`,
 * `evaluateAuthorization`, `evaluatePromptReadiness`), the bundled
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

/**
 * The spend gate (shopfloor#41), exported as its own callable — and shipped as
 * the `shopfloor-authorize` bin — so a setup-free job can refuse an
 * unauthorized actor before the runner pays for anything. Unlike every other
 * guard here, it refuses on uncertainty; see `CONTEXT.md`.
 */
export {
  evaluateAuthorization,
  SPENDING_PERMISSIONS,
  type AuthorizationInput,
  type AuthorizationVerdict,
  type PermissionProbe,
  type SpendingPermission
} from './guardrails/authorization'

export {
  runAuthorization,
  type RunAuthorizationInput,
  type RunAuthorizationResult
} from './guardrails/run-authorization'

export {
  evaluatePluginDirs,
  type PluginCapability,
  type PluginDirFacts,
  type PluginDirsVerdict
} from './guardrails/plugin-dirs'

export { runPluginDirsCheck } from './guardrails/run-plugin-dirs'

/**
 * The unfilled-prompt refusal (shopfloor#44), pure and exported for the same
 * reason its siblings are: a consumer's own tooling can ask the question this
 * package asks before every spawn, against whatever token table it renders
 * with. `PROMPT_TOKENS` is this package's, and already exported below.
 */
export {
  evaluatePromptReadiness,
  type PromptReadinessInput,
  type PromptReadinessVerdict
} from './guardrails/prompt-readiness'

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

/**
 * What a run spent (shopfloor#42). The types only: `usage` lands on the run
 * result, and a consumer reads it there. The parse and the fold behind it stay
 * internal — every export is a compatibility commitment, and nothing outside
 * this package needs to fold a stream this package is the one spawning.
 */
export { type RunUsage, type TokenUsage } from './observability/usage'

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
  LABEL_VOCABULARY,
  type LabelDefinition,
  type SetupCheck,
  type SetupCheckId,
  type SetupCheckStatus,
  type SetupFacts,
  type SetupVerdict
} from './setup/setup'

export { probeSetup } from './setup/probe-setup'

export { type DoctorConfig } from './setup/setup-config'

/**
 * `init` (shopfloor#43): the command, and the shape of what it reports having
 * done. Nothing else. The planner, the scaffold builders, and the project
 * probe stay internal — what they emit is checked by the doctor a caller
 * already has, and every export is a compatibility commitment on a package
 * still before `1.0.0`. The types below are here because `RunInitResult` is
 * made of them, not as a second entry point.
 */
export {
  runInit,
  formatInitResult,
  type RunInitInput,
  type RunInitResult
} from './setup/run-init'

export {
  type CreateLabelsAction,
  type InitAction,
  type InitPlan,
  type InitSkip,
  type WriteFileAction
} from './setup/init'
