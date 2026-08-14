/**
 * The package's public surface: the four verbs a consumer calls, the error
 * they throw, the three pure escape hatches the README documents
 * (`evaluatePreflight`, `buildVerifyComment`, `classifyCommand`,
 * `evaluatePluginDirs`), the bundled plugin's resolved location — API because
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
