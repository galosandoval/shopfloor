import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'run-phase-cli': 'src/run-phase-cli.ts',
    'doctor-cli': 'src/doctor-cli.ts',
    'init-cli': 'src/init-cli.ts',
    'authorize-cli': 'src/authorize-cli.ts',
    'admit-cli': 'src/admit-cli.ts',
    // The removed verb's bin, kept as a refusal (shopfloor#51) — see the file
    // for why deleting it hands `npx` to the registry.
    'implement-cli': 'src/implement-cli.ts',
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
