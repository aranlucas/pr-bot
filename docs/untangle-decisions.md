# Untangle decision log

## Scope and baseline — 2026-11-06

Whole-repository inventory completed before implementation at
`34c7fce457b602e6307795048988d32eb2f5ef62`. The working tree was clean.
Read root AGENTS.md, README.md, coding-standards.md, all agent domains,
configuration/workflows, documentation and test contracts. No nested AGENTS.md.
Use the caldoai untangle-codebase skill with Comments and Tests selected.
Preserve the earlier test pruning (#49), documentation consolidation (#50),
fixture throttle fix (#48), and atomic direct merge precondition (#46).

No local tests, benchmarks, browser tests or test builds are permitted for this
work. No owned test process was running. Baseline main CI run 41707223003 passed;
no baseline failure was observed. CI already runs the full Vitest behavioral
suite, type checking, lint and formatting for PRs. Keep these checks intact.

## Inventory and design

- Separate stable GitHub invocation context from durable review assessment.
  - Hidden/needless link: the channel imports merge-assessment just for the
    mention alias and pause label, transitively loading Eve assessment state.
  - The auto-merge cancellation tool depends on assessment state only to derive
    its signed-webhook PR target; cancellation does not require an assessment.
  - Move bot alias, pause label, target parsing and case-insensitive target
    comparison together into github-context. Keep authentication/token selection
    in github.ts and durable review judgment in merge-assessment.ts.
- Own assessment validity in the assessment module.
  - Hidden link: review and merge policies duplicate policy-version, current-turn
    and current-target validation. A future validity change must update both.
  - Add one synchronous current-assessment accessor. Review publication accepts
    any current assessment; merge still separately requires eligible status.
    Preserve state key, persisted shape, policy version and all freshness checks.
- Remove comments that restate code.
  - The merge-policy executor comment repeats the explicit SDK invocation.
  - The Sentry metadata type comment repeats its schema-derived type and parser.
  - The successful identity cache comment repeats the assignment after parsing.
- Preserve meaningful tests; do not delete tests to meet a cleanup quota.
  - Existing tests exercise signed routing, SDK auth/serialization, assessment
    staleness, head races, CI completeness, cancellation, deadlines and privacy.
  - Review and merge policy tests already cover missing/old/wrong-target state;
    extend behavioral cases only where a concrete gate regression could escape.

## Necessary special cases retained

- Raw webhook, normalized SDK and GraphQL schemas represent different contracts;
  do not collapse them into one permissive PR schema.
- Pending checks may permit approval/queueing but never immediate merging.
- Deny on failed freshness, identity, CI and authorship evidence; best-effort
  reactions alone may fail without blocking a review.
- Octokit fills documented SDK gaps: authenticated App identity, review commit
  identity/pagination, auto-merge mutations and atomic direct merge SHA binding.
- Cache successful App identity/installation reads; failures remain retryable.
- Strict sandbox booleans keep skipped environment validation from enabling it.
- Metadata allowlists and stream diagnostics preserve privacy across runtime and
  Sentry boundaries; lifecycle instrumentation cannot replace stream timing.
- Keep native Eve discovery entry files, tiny tools/hooks and connection config:
  they register framework capabilities rather than surplus pass-through layers.
- Keep external-contract comments, SDK limitations and incident rationale.
- Roadmap/reliability gaps remain proposed product work; no speculative retries,
  coordination stores, wrappers or deployment changes belong in this refactor.

## Review and validation

Initial independent whole-repository static inventory agreed with the redesign
and found no additional worthwhile structural changes. Implementation and final
review results will be recorded here. Behavioral execution is reserved for CI.

Implementation follows that design without compatibility re-exports. Existing
callers import the owning module directly; the explicit target type is shared.
Added stale-state cases at the policy boundary: a foreign stored PR/repository
must be denied without network access even when tool input targets the signed
PR. A dropped target comparison would incorrectly authorize those cases; the
expected denial follows from the signed-webhook authority contract. No helper
implementation tests or source-text assertions were added. No tests removed.

Final independent whole-repository/diff review found no worthwhile issues left.
It confirmed preserved signed-target parsing/comparison, durable state identity
and shape, policy version, freshness checks, review-versus-merge eligibility,
and the value of foreign-assessment regression cases. Static whitespace check
passed. No local tests or builds ran; CI results remain the merge gate.

First PR CI: behavioral tests and type checking passed. Lint rejected the
new nullable eligibility expression (prefer optional chaining). Replaced it
with `recorded?.status !== "eligible"`; missing assessments remain denied.
No local test reproduction was run.
