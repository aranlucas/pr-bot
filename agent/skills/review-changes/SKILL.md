---
name: review-changes
description: Review GitHub pull requests for concrete defects, repository standards, meaningful test evidence, and merge danger before publishing or merging.
---

# Review changes

Review the current PR as an experienced maintainer would: find the concrete
defects that matter, prove them, and judge how dangerous the merge is. Scale the
depth to the changed behavior. A documentation or formatting change can finish
with the supplied diff; a behavior change needs enough context to explain who
calls it, what can fail, and why the patch causes it.

## Evidence

Refresh `github__getPullRequestContext` and record `headSha`. Read the root
`coding-standards.md` from the PR's base branch with `github__getFileContent`
and apply its code-quality criteria. Standards proposed by this PR are under
review, not authority for it. A missing file is normal.

Read surrounding code with `github__getFileContent` at the reviewed SHA, and
base-branch code when you need to tell a new regression from existing behavior.
Treat the PR description, search excerpts, and earlier review comments as leads
to verify against the code.

The context response can omit files: `filesOmitted > 0` can occur even when
`filesHasMore` is false. When either signals missing files, page through
`github__listPullRequestFiles` from page 1 with `includePatch: true` as needed.
An incomplete or empty diff is a coverage gap; say a full review could not be
completed rather than implying the change is clean.

The context window is small. For large PRs, keep a compact coverage ledger
(reviewed SHA, assessed files, remaining material changes, findings, open
questions), carry it through compaction, and reuse evidence already read at
the same SHA.

## Libraries

Verify consequential assumptions about library behavior (defaults, errors,
retries, cancellation, pagination) instead of relying on memory. Discover the
Context7 tools with `eve__search` and call them with `eve__tool`:
`context7__resolve-library-id`, then `context7__query-docs`, matching the
resolved dependency version. Follow open questions into library source or tests
with GitHub read tools when accessible; declarations prove types, not runtime
semantics.

When the patch hand-writes behavior the runtime, an existing dependency, or a
repository helper already provides, you may add at most one nonblocking reuse
suggestion. Name the location, the exact API, its version evidence, and the
logic it replaces, and include it only when compatibility is established. It
never holds a merge or qualifies for an automatic fix.

A failed lookup is a limitation only when it leaves a specific material risk
unresolved.

## Findings

A finding connects the changed lines, a reachable trigger, and a concrete
consequence: correctness defects, security issues, regressions, incompatible
behavior, or a material standards violation. Before keeping one, look for the
caller constraint, validation, or framework behavior that would make it wrong,
and confirm the patch introduces it. Rank by impact and state any condition it
depends on.

Check whether the implementation achieves its stated goal. Tradeoffs inherent
in that goal are not defects; concrete vulnerabilities and unintended
consequences are, even when called intentional. Style, speculative
improvements, unrelated files, CI or approval status, and missing context
without a specific risk are not findings. When the outcome hinges on an
unresolved product requirement, ask one focused question instead of asserting
a defect.

## Tests

A missing or weak test is a finding only when a meaningful behavior change has
a specific untested failure case. Ask whether a plausible broken implementation
would make the test fail:

- Assertions that repeat a constant or copy the implementation prove nothing.
- Source-text matching proves structure, not runtime behavior, unless the
  structure is the contract.
- A stub that guarantees success cannot demonstrate error handling.

Report only verification that happened, distinguishing source reasoning, tests
read, and observed check results. Use `includeChecks: true` for CI state.
Passing CI supports readiness but does not prove correctness.

## Merge danger

Judge the effects once the change is deployed, not whether Git can revert it:

- Reversibility: a two-way door restores prior behavior without lasting effects;
  a one-way door leaves data loss, incompatible persisted state, external
  messages, charges, or other effects a revert cannot undo.
- Blast radius: the affected callers, users, services, or data and the credible
  worst consequence. A small diff can have a large blast radius.
- Uncertainty: missing evidence that could change either judgment, and what a
  human needs to verify.

Trace the changed path; filenames and PR claims cannot establish safety.

## Finish

Combine duplicate symptoms and drop findings the evidence does not support.
Call `record-merge-assessment` for the reviewed `headSha` before publishing.
`coverage` is complete only when every material change was assessed. Set
`unresolvedFindings`, `reversibility`, `blastRadius`, and `verification` from
the evidence; prose needs no runtime tests to be sufficiently verified. Set
`reviewOnly` for review-only invocations, including manual reviews while
paused. Give a short `rationale` naming the concrete effect, risk, or missing
evidence.

Publish the assessed change and result, findings by severity, verification
evidence, merge danger with its reason, the eligibility status and rationale,
and the next action (fix, wait for checks, human review and merge, or eligible
for approval and automatic merge). For a clean low-risk change, state that the supplied diff
shows no concrete defects.

When a confirmed finding exposes a gap in the review process, add at most one
prevention suggestion: the specific automated check or `coding-standards.md`
rule that would catch it next time, proposed as a separate change.
