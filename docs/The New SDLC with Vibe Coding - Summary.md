# The New SDLC With Vibe Coding — Summary

**Source:** *The New SDLC With Vibe Coding: From Ad-Hoc Prompting to Agentic Engineering* (Google, May 2026)
**Authors:** Addy Osmani, Shubham Saboo, Sokratis Kartakis

> Focus of this summary: framed for someone **architecting and building AI tooling / harnesses**, so the Harness Engineering, Context Engineering, and Economics sections are covered in the most depth.

---

## 1. The Core Thesis

The biggest shift in software engineering isn't a new language or framework — it's the move **from writing syntax to expressing intent**, with AI systems translating that intent into working software. As of early 2026: 85% of professional developers use AI coding agents regularly, 51% daily, and ~41% of new code is AI-generated.

Evolution of the interface: **Autocomplete → Inline Suggestions → Chat-based Generation → Coding Agents (multi-file, tool-calling, self-correcting) → Autonomous Agents (clone repos, plan architecture, run in sandboxes, submit PRs — no human keystrokes required)**.

---

## 2. Vibe Coding vs. Agentic Engineering (a spectrum, not a binary)

The differentiator is **not whether you use AI — it's how much structure, verification, and human judgment surrounds the AI's output.**

| Dimension | Vibe Coding | Structured AI-Assisted | Agentic Engineering |
|---|---|---|---|
| Intent spec | Casual natural language | Detailed prompts + constraints | Formal specs, architecture docs, memory files |
| Verification | "Does it seem to work?" | Manual testing, spot-checks | Automated test suites, CI/CD gates, LLM judges |
| Codebase understanding | Minimal | Selective review of critical paths | Comprehensive; AI handles implementation details |
| Error handling | Copy-paste error back to AI | Developer diagnoses, AI fixes | Agents self-diagnose within bounds; humans handle architecture |
| Appropriate scope | Prototypes, scripts, hackathons | Features in established codebases | Production systems, team-scale development |
| Risk profile | High (fine for disposable code) | Moderate | Low — systematic verification at every stage |

**Key mechanism:** verification. Vibe coding = optional verification. Agentic engineering = two enforced mechanisms working together:
- **Tests** — verify deterministic parts (checked by code).
- **Evals** — verify non-deterministic parts: did the agent take the right trajectory, use the right tools, produce output that meets a quality bar (checked by labelled datasets, rubrics, LM judges).

Without both, it's still vibe coding no matter how sophisticated the prompts are. **The right position on the spectrum depends on the stakes** — a weekend prototype can be pure vibes; a production payments API demands agentic engineering.

---

## 3. Context Engineering — "the real skill"

Output quality depends less on prompt cleverness and more on the **quality of context** supplied. Six types of context every agent needs:

1. **Instructions** — role, goals, operational boundaries
2. **Knowledge** — retrieved docs, architecture diagrams, domain data
3. **Memory** — short-term session logs + long-term persistent state
4. **Examples** — few-shot demonstrations, reference patterns
5. **Tools** — precise definitions of APIs/scripts the agent can invoke
6. **Guardrails** — hard constraints, formatting rules, safety validations

### Static vs. Dynamic Context (a core harness design decision)
- **Static context**: always loaded (system instructions, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, global memory, core guardrails). Expensive — every token present on every call — but reliable; the agent never forgets it.
- **Dynamic context**: loaded on demand (skills triggered by task match, tool results, RAG-retrieved docs, windowed session history). Efficient — pay token cost only when needed.

> The boundary between static and dynamic context is a genuine engineering trade-off: too much static context wastes tokens and dilutes signal; too little means the agent forgets critical rules. **Treat this boundary as a first-class architectural decision, reviewed and versioned like code.**

### Agent Skills — the key pattern for scaling dynamic context
Structured, portable packages of procedural knowledge loaded only when a task calls for them (progressive disclosure: lightweight metadata at startup → full instructions on task match → deep reference material only when needed). Skills let an agent stay a lightweight generalist while flexing into many specialist roles without paying the token cost for capabilities it isn't using. They solve: context rot from overloaded prompts, absence of procedural memory in LLMs, operational overhead of multi-agent architectures, and the need for portability across tools/vendors.

---

## 4. The New Software Development Life Cycle (SDLC)

AI compresses the SDLC unevenly: implementation (once weeks) collapses to hours, while requirements, architecture, and verification stay human-paced. The result is a different workflow — phase boundaries blur, iteration cycles shrink from weeks to minutes, and the developer shifts from primary implementor to **system designer and quality arbiter**.

**How AI reshapes each phase:**
- **Requirements & Planning** — AI generates user stories, edge cases, API schemas, and interactive prototypes from spec docs. Requirements become a human+AI conversation that produces spec and initial implementation together, not a document handoff.
- **Design & Architecture** — remains the most human-centric phase (trade-offs like consistency vs. availability need business/organizational context AI can't grasp). AI excels at *implementing* architecture once decided — scaffolding, consistent patterns, convention enforcement.
- **Implementation** — agents generate whole features/algorithms/multi-file changes. Real productivity gains (25–39% reported), but nuanced: a METR study found experienced devs using AI assistants took **19% longer** on some tasks due to verification/debugging overhead. AI shifts implementation work from *writing* to *reviewing, guiding, verifying*.
- **Testing & QA** — requires evaluating not just *what* the agent produced (output evaluation) but *how* it got there (trajectory evaluation). A fluent output that skipped verification steps is more dangerous than one with a visible error. Best practice: a continuous quality flywheel — evaluate against benchmark → cluster failure root causes → optimize prompts/tools → verify against regression suite → monitor production for new failure modes.
- **Code Review & Deployment** — AI as first-pass reviewer (bugs, style, security, perf) reduces reviewer cognitive load but doesn't replace human judgment on maintainability/strategic alignment. Deployment pipelines become AI-aware: monitoring health, auto-rollback, risk prediction.
- **Maintenance & Evolution** — the most underestimated transformation. Legacy code once "too risky to touch" can now be safely read, understood, and refactored by agents — with real implications for reducing technical debt.

### The Factory Model
> "The developer's primary output is not code — it's the system that produces code."

Factory components: specifications/context defining what to build → agents that translate specs into implementation → tests/quality gates that verify correctness → feedback loops routing failures back for correction → guardrails constraining agents to safe, predictable behavior.

Like a factory manager, the developer designs the assembly line and quality control rather than assembling every widget by hand — **giving agents success criteria, not step-by-step instructions**, then letting them iterate.

---

## 5. Harness Engineering: What Surrounds the Model *(most directly relevant section)*

**Core equation: `Agent = Model + Harness`**

A raw model is not an agent — it becomes one once a harness gives it state, tool execution, feedback loops, and enforceable constraints. The behavior developers experience with Claude Code, Cursor, Codex, Antigravity, Aider, or Cline is dominated by **what the harness does**, not just which model is underneath. Rough proportion cited: model ~10% of the experience, harness ~90%.

**Harness anatomy (concentric layers, model at center):**
- **Framework layer** (where intelligence is shaped): Instructions/Rule files, Tools & MCP servers, Orchestration logic, Guardrails & Hooks, Eval & Testing, Observability & Tracing
- **Developer interface**: CLI/IDE integration, Session/Memory store
- **Cloud infrastructure**: Managed runtimes, Deployment config, Service & scaling

**Concretely, a harness includes:**
- **Instructions & Rule Files** — defines who the agent is, what it cares about, what's forbidden (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, skill files, sub-agent prompts)
- **Tools** — functions, MCP servers, APIs the agent can call, plus the prose telling the model when/how to call them
- **Sandboxes & execution environments** — where code actually runs and what it can/can't access
- **Orchestration logic** — sub-agent spawning, model routing, hand-offs between specialists
- **Guardrails / Hooks** — deterministic code at specific lifecycle points (before a tool call, after a file edit, before a commit) — "the place for things the agent should never forget but often does"
- **Observability** — logs, traces, evals, cost/latency metering; without it, no way to tell if the agent is doing well or quietly drifting

**Harness responsibilities mapped to SDLC phases:**
1. **Requirements/Planning/Architecture → Configuring the Harness**: writing `AGENTS.md`, defining architectural constraints, choosing tool access (APIs, DB schemas), setting hard rules
2. **Implementation → Running the Harness**: sandbox executes generated code; agent uses harness-provided tools for file/web access
3. **Testing & QA → The Feedback Loop**: harness provides execution environment for tests; orchestration logic captures failures and routes them back to the model for retry — this is what creates the automated "think → act → observe" loop
4. **Code Review/Deployment/Maintenance → Observing the Harness**: deterministic hooks block unsafe actions (e.g., hard-coded secrets before commit); observability layer tracks token cost, latency, and drift so engineers can audit *why* an agent made a decision

**Why this matters practically:** the transition from vibe coding to agentic engineering is not about which tool you use — a developer can vibe code *or* practice agentic engineering with the exact same underlying agent. It's defined by **how deliberately you configure and apply the harness.**

**Evidence the harness dominates the model:**
- One team moved a coding agent from outside the Top 30 to Top 5 on Terminal Bench 2.0 by changing **only the harness**, no model change.
- A LangChain study raised a coding agent's benchmark score by 13.7 points by tweaking only the system prompt, tools, and middleware around a fixed model.
- **Practical implication:** when an agent fails, the first instinct is to blame the model. More often the failure traces to a missing tool, a vague rule, an absent guardrail, or a context window stuffed with noise — **most agent failures are configuration failures**, not model failures.

---

## 6. The Developer's Evolving Role: Conductor vs. Orchestrator

Two modes developers move between fluidly (not either/or):

| | **Conductor** | **Orchestrator** |
|---|---|---|
| Mode | Real-time, synchronous, in-IDE | Asynchronous, high-level, multi-agent |
| Control | Keystroke-level, immediate feedback | Goal-level, delayed feedback |
| Scope | Single-file | Multi-file, reviews outcomes not keystrokes |
| Best for | Exploratory coding, prototyping, learning a new API | Feature implementation, migrations, test generation |
| Example tools | GitHub Copilot, Gemini Code Assist, Cursor, Windsurf | Google Jules, Copilot agent mode, Cursor background agents, Claude Code |

Orchestrator mode demands different skills: **specification** (defining tasks precisely enough for unambiguous execution), **decomposition** (breaking work into agent-sized units), **evaluation** (fast quality assessment of output), **system design** (constraints/tests/feedback loops that keep agents productive).

### The 80% Problem
AI agents rapidly generate ~80% of feature code, but the remaining 20% — edge cases, error handling, integration points, subtle correctness — demands contextual knowledge current models often lack. AI error modes have shifted from syntax mistakes to **conceptual failures**: wrong business-logic assumptions, failure to seek clarification on ambiguous requirements, missing edge cases — errors that are harder to catch because the code "looks right" and may pass basic tests. The effective posture: use AI for rapid implementation of well-specified tasks; reserve human attention for ambiguous requirements, architectural trade-offs, and correctness verification.

---

## 7. Coding Agents in Practice — Three Surfaces

1. **In the editor**: inline completion, chat panels, whole-codebase awareness (GitHub Copilot, Cursor, Windsurf, JetBrains AI Assistant) — stays in flow.
2. **In the terminal**: full filesystem access, multi-file edits, runs tools/tests, iterates on results (Antigravity CLI, Claude Code, Codex CLI, Open Code, Cline) — where serious agentic work happens today.
3. **In the background**: autonomous cloud-hosted sandboxes running for hours, producing a PR for later review (Google Jules, Copilot agent mode, Cursor background agents, Google's AlphaEvolve).

Most developers use all three in a single day; the right starting point depends on the task, not a fixed autonomy ranking.

### Vibe Coding Production-Ready Agents
When the artifact you're building is itself an agent (a support bot, a research assistant, a compliance monitor), it needs its own tools, memory, evaluation, and deployment infrastructure — not just a terminal session.

Google's **Agents CLI** exemplifies this: a small CLI that bundles 7 skills covering the full ADK lifecycle (scaffold → write agent code → evaluate → deploy to Agent Runtime → wire up observability), and works with *whatever* coding agent the developer already uses (Claude Code, Codex, etc.) rather than requiring a new SDK to learn.

```
# One-time setup
uvx google-agents-cli setup
# Then in your coding agent:
> Build a support agent that answers questions from our docs.
> Evaluate it on the FAQ dataset
> Deploy it to Agent Engine
```

Multi-agent coordination happens via: shared session state (simple cases), **Model Context Protocol (MCP)** for tool access, and **Agent2Agent (A2A)** protocol for cross-agent delegation. (Anthropic's engineering team reported an agent team building a working C compiler in Rust over two weeks using this kind of architecture, with humans setting direction/reviewing output but not writing implementation.)

---

## 8. The Economics of AI Development

Framed as Total Cost of Ownership (TCO): CapEx (upfront investment) vs. OpEx (ongoing run/fix/maintain cost), with OpEx increasingly dictated by the **token economy**.

**Vibe Coding = Low CapEx, High OpEx (hidden debt):**
- Near-zero barrier to entry — subscription + casual prompts.
- Hidden compounding costs: **token burn** (unstructured context dumps + repeated "fix it" prompting loops with low first-pass success), **maintenance tax** (unstructured "spaghetti" AI code takes days to reverse-engineer months later), **security remediation** (without automated evaluation harnesses, rapid code generation = rapid vulnerability generation; fixing security flaws in production costs exponentially more than catching them at design time).
- Economically a dead end for complex, long-lived systems.

**Agentic Engineering = High CapEx, Low OpEx (investment):**
- Deliberate upfront cost: designing API schemas, building deterministic test suites, structuring agent context — before a line of production code is generated.
- Marginal cost of shipping/maintaining drops dramatically because the AI operates inside a governed "factory" — structurally sound, pre-tested, standards-aligned output.
- Sustainable at scale; the crossover point (where vibe coding costs 3–10x more per feature) arrives as codebases mature.

**Context Engineering as a Financial Lever:** LLMs charge per token — dumping a 100K-token repo into every prompt is financially unviable at scale. A precise, dense-signal `AGENTS.md` + guardrails (vs. a sprawling, noisy one) dramatically raises first-pass success rate and avoids costly trial-and-error loops.

**Intelligent Model Routing:** vibe coding typically pays premium frontier-model prices for *every* interaction, including trivial ones. A well-designed factory routes large/expensive models to high-complexity work (requirements, architecture, initial implementation) and cheaper/faster models to lower-complexity, deterministic work (test generation, code review, CI/CD monitoring) — maintaining output quality while systematically cutting token cost.

---

## 9. Where to Start — Actionable Checklists

### For individual developers
1. Set up an `AGENTS.md` (or equivalent) — start with ~10 lines: stack, conventions, hard rules, workflow. Add a rule every time the agent misbehaves.
2. Install a set of skills (e.g., Agents CLI) to build/evaluate/deploy/optimize agents.
3. Pick one repetitive workflow and turn it into your first agent; graduate it from prototype to production via something like Agents CLI once it earns its keep.
4. **Write tests and evals before generating code** — they're the contract with the AI and communicate intent more precisely than natural language.
5. Review every line the agent produces before it ships — be skeptical of "clever" code, check imports are real, verify error handling covers realistic failures.
6. Maintain your own foundational skills (debugging, system design, correctness intuition) — AI should scale expertise, not replace it.

### For engineering leaders
1. Make context engineering a first-class practice — treat `AGENTS.md`, system prompts, eval suites, and skill libraries as code: reviewed in PRs, versioned, owned by named engineers.
2. **Set the bar at the eval, not the demo** — a demo proves an agent *can* succeed once; a passing eval suite with clear rubrics (task success, tool-use quality, trajectory compliance, hallucination, response quality) proves it succeeds *reliably*. Require eval coverage as a precondition for shipping into shared workflows.
3. Re-shape code review for AI-generated code — train reviewers on its specific failure modes (hallucinated dependencies, inadequate error handling, subtle correctness gaps that look right at a glance).
4. Distinguish prototyping work from production work explicitly in team norms (which projects/branches/environments warrant which mode).
5. Invest in harness components (system prompts, skill libraries, MCP connections, eval harnesses) as **shared, versioned team infrastructure** — build the harness once, refine it many times.

### For organizations
1. Treat AI-assisted development as an engineering investment, not a productivity feature — pair tooling with eval coverage, observability, and architectural standards, or speed gains compound into technical debt faster than any team can pay down.
2. Build the production substrate (CI-run evals, full run traces, scoped per-agent permissions, security review tuned to generated-code failure modes) *before* the first production agent ships, not after.
3. Adopt open standards — **MCP** for tool access, **A2A** for cross-agent delegation — to keep vendor/framework flexibility and avoid re-platforming later.
4. Plan for **hybrid human+agent teams**, not human-only or agent-only workflows — humans set direction, agents implement, with clear handoff protocols; code review, on-call rotations, and team structures need to reflect agents as participants.
5. Reframe hiring/skill development around **judgment**, not implementation speed — the most valuable engineers going forward direct agents well, rather than write the most code.

---

## 10. Three Durable Principles (Conclusion)

1. **Structure scales, vibes don't.** Vibe coding is valid for exploration/prototypes/personal projects; for anything an organization depends on, agentic engineering's discipline (specs, tests, guardrails, human oversight of architecture) is not optional. The gap between "it seems to work" and "it works correctly under all conditions" is where outages, security vulnerabilities, and maintenance nightmares live.
2. **AI amplifies your engineering culture.** Teams with strong testing practices, clear architectural standards, and healthy review processes get dramatically more value from AI — it's a force multiplier for both strengths *and* weaknesses.
3. **The human role is evolving, not diminishing.** Value shifts from implementation to judgment — precise specification, critical evaluation, and system design (constraints + feedback loops) are the durable skills.

> *"Generation is solved. Verification, judgment, and direction are the new craft."*

---

### Companion papers referenced (part of a series)
- **Day 3**: Context Engineering — Sessions, Skills & Memory (deep dive on session design, writing/evaluating skills, persistent memory, token economics)
- **Day 5**: Spec-Driven Production-Grade Development in the Age of Vibe Coding (spec-driven development, structured code review at scale, guardrails, sandboxing, zero-trust development; also covers how human PR review changes when volume scales with agent output)
