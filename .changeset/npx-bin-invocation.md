---
'@galosandoval/shopfloor': patch
---

Fix the scaffolded workflow invoking its own bins in a form `npx` cannot
resolve. Both steps used the bare `npx --yes @galosandoval/shopfloor@<v>
shopfloor-admit` form, which derives the command from the package *name* —
`shopfloor` — a bin this package does not ship. `npx` exits with "could not
determine executable to run" and swallows the bin name as an argument, so
neither `shopfloor-admit` nor `shopfloor-run-phase` ever ran.

**The failure mode this closes is a silent one, and existing workflows have
it.** The admit step captures stdout; an empty verdict parses to `null`;
`run-phase` is gated on `admitted == 'true'` and skips. The run reads green in
a few seconds having implemented nothing, which looks like ordinary
"not-a-trigger" traffic rather than broken wiring. Anyone whose runs finish
fast and change nothing is seeing this.

**Consumers must edit their own workflow — nothing reads it back.** `init`
scaffolds the file once and the consumer owns it after, so a re-scaffold does
not reach an already-installed one. Change both steps in
`.github/workflows/*.yml` to the `--package` form:

    npx --yes --package @galosandoval/shopfloor@<version> -- shopfloor-admit
    npx --yes --package @galosandoval/shopfloor@<version> -- shopfloor-run-phase

No API, input, or result field changed; freshly scaffolded workflows carry the
fixed form.
