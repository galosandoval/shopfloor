/**
 * Where the skills plugin this package bundles lives on disk (shopfloor#26).
 *
 * The plugin is a **git dependency pinned to a tag** of its own repository,
 * not a copy vendored into this one. That repository is a fork merged from
 * upstream regularly; a vendored copy would give every one of those merges a
 * second destination, by hand, with a stale copy looking identical to a fresh
 * one. A tag, never a branch: a branch reference resolves to different content
 * on two installs a day apart, which is a moving target rather than a harness.
 *
 * IO, and deliberately so — an unstated `pluginDirs` resolves to this path,
 * and finding it is filesystem work that has no place in the pure
 * `resolveImplementConfig`. It decides nothing, which is why it keeps a
 * `resolve*` name in the shell (see CONTEXT.md §Pure core, IO shell).
 *
 * It is exported because a consumer who wants this plugin *and* one of their
 * own has to be able to name both: a stated list **replaces** the default
 * rather than adding to it, so the CLI never arbitrates a collision this
 * package created. The result is validated like any stated entry —
 * `runPluginDirsCheck` makes no exception for it.
 */

import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImplementAgentError } from './implement-error'

/** The package the bundled plugin ships as; every message about it names this. */
export const BUNDLED_PLUGIN_PACKAGE = 'galosandoval-skills'

/**
 * Absolute path to the bundled plugin's directory. Throws
 * {@link ImplementAgentError} when the dependency is not on disk — a pruned
 * `node_modules`, or an install that skipped dependencies, which is the
 * likeliest way this fails. That refusal is the whole point of bundling: a run
 * that quietly proceeded with none of the procedure it was configured to have
 * is the failure mode this replaces, and it reports nothing.
 *
 * Found through Node's own module resolution rather than by walking to a
 * guessed `node_modules/` path, so a hoisted install and a nested one both
 * answer, and neither is a path this package has to keep correct by hand.
 */
export function resolveBundledPluginDir(): string {
  const from = bundleFile()
  if (from) {
    try {
      const manifest = createRequire(from).resolve(
        `${BUNDLED_PLUGIN_PACKAGE}/package.json`
      )
      return path.dirname(manifest)
    } catch {
      // Nothing to resolve from here — the refusal below says so.
    }
  }

  throw new ImplementAgentError(
    `Bundled skills plugin not found — @galosandoval/shopfloor depends on ` +
      `${BUNDLED_PLUGIN_PACKAGE} and could not resolve it from its own ` +
      'install. Reinstall @galosandoval/shopfloor with its dependencies, or ' +
      'state `pluginDirs` / PLUGIN_DIRS to point at a plugin of your own.'
  )
}

/**
 * The file this bundle was loaded as, in either module format: the ESM build
 * has `import.meta.url`, while the CJS build's bundler shims that away and
 * leaves `__filename`. Undefined if neither answers, which the caller treats
 * as nothing to resolve from.
 */
function bundleFile(): string | undefined {
  const moduleUrl = import.meta.url as string | undefined
  if (moduleUrl) return fileURLToPath(moduleUrl)
  if (typeof __filename === 'string') return __filename
  return undefined
}
