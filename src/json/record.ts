/**
 * Narrowing an `unknown` parsed from JSON to a plain object, and nothing more.
 *
 * Extracted once a third caller needed it (`docs/typescript-style.md`: only
 * extract to a separate file when it is reused) — the webhook payload reader,
 * the usage stream, and the trajectory reader all fold untrusted JSON, and
 * three copies is three ideas of whether an array counts as a record. It does
 * not; `typeof [] === 'object'` is the whole reason this exists.
 *
 * **Absent is `undefined`, not `null`.** The callers reach through it with
 * `?.` and `??`, both of which treat the two alike, so the distinction bought
 * nothing and only the majority spelling survives.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
