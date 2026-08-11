import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    // Spawned as its own process by the Claude CLI's PreToolUse hook, so it
    // ships as a standalone entry rather than inside the index bundle.
    'command-guard-hook': 'src/guardrails/command-guard-hook.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20'
})
