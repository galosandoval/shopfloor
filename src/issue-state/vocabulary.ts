/**
 * The label vocabulary the loop transitions over, and the one place it is
 * written down (shopfloor#45).
 *
 * **Package-owned, and that is a deliberate exception.** `CLAUDE.md` lists
 * consumer naming under what this package does not own; these six names are
 * the exception, because a name the harness does not own is a binding it
 * cannot guarantee. The concrete failure the exception was bought with: the
 * live consumer's workflow swapped `ready-for-agent` for `ready-for-human`
 * against a repository that had no `ready-for-human` label, so the step failed
 * on every successful run since it was written — swallowed by `|| true`. A
 * transition the pipeline claimed to make had never once happened.
 *
 * It lives here rather than in `src/setup/`, where it was first written, for
 * the reason it is now read from three places: the doctor judges a repository
 * against it, `init` creates what is missing, and a run verifies and refuses.
 * A vocabulary owned by the diagnostic that happens to check it is a vocabulary
 * that moves when the diagnostic does.
 */

/** One label in the vocabulary, with what GitHub needs to create it. */
export interface LabelDefinition {
  name: string
  /**
   * What a transition onto it means. Carried rather than left to GitHub's
   * default of nothing: six bare names in a shared label list is a vocabulary
   * only the person who created it can read.
   */
  description: string
  /** Six hex digits, no leading `#` — what `gh label create --color` takes. */
  color: string
}

/**
 * The vocabulary: the harness's own run state, and the process lifecycle
 * either side of it. Fixed rather than configurable — see the module doc.
 *
 * The colours are the vocabulary's own shape, not decoration: the two process
 * labels are green and blue, and the four `agent:` run states run from neutral
 * through to red as a run goes wrong.
 */
export const LABEL_VOCABULARY: readonly LabelDefinition[] = [
  {
    name: 'ready-for-agent',
    description: 'Spec is ready for an agent to implement',
    color: '0E8A16'
  },
  {
    name: 'ready-for-human',
    description: 'The agent is done — a human owns the next move',
    color: '1D76DB'
  },
  {
    name: 'agent:implement',
    description: 'The implement phase owns this issue',
    color: 'C5DEF5'
  },
  {
    name: 'agent:in-progress',
    description: 'A run is in flight — do not start a second one on this issue',
    color: 'FBCA04'
  },
  {
    name: 'agent:blocked',
    description: 'A run refused or could not proceed — a human must unblock it',
    color: 'D93F0B'
  },
  {
    name: 'agent:exhausted',
    description: 'A run hit its ceiling without passing the gate',
    color: 'B60205'
  }
]

/** The vocabulary by name — what a presence check compares against. */
export const REQUIRED_LABELS: readonly string[] = LABEL_VOCABULARY.map(
  (label) => label.name
)

/**
 * The label a human adds to admit an issue to the loop, and therefore the
 * handle a human retries with. Named on its own because a refusal has to tell
 * someone what to do next, and naming the wrong label there is the same class
 * of silently-wrong binding this vocabulary exists to eliminate: every
 * terminal transition drops this label, and GitHub fires `issues.labeled` only
 * on an *add*, so "re-add this to retry" is only true of this one.
 */
export const ENTRY_LABEL = 'ready-for-agent'

/**
 * The label a run wears while it is in flight, and therefore the one the outer
 * loop's two guards are read off (shopfloor#46): its **presence** says a run is
 * going, and the count of times it was ever *added* — which GitHub's issue
 * timeline keeps even after the label is removed — is how many attempts the
 * issue has had. Named on its own for the reason {@link ENTRY_LABEL} is: a
 * guard that reads a label by string literal is the rotted binding this
 * vocabulary exists to eliminate.
 */
export const IN_PROGRESS_LABEL = 'agent:in-progress'
