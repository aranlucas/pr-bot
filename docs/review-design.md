# Review design

These changes adapt Matt Pocock's
[Fixing the PR Bottleneck](https://www.youtube.com/watch?v=LlgiOCmFG_w),
published by AI Engineer on September 26, 2026. The original English automatic
captions and metadata were retrieved with the `yt-dlp` CLI. The upload warns of
poor audio at the start; the design uses the later review examples.

## Lessons applied

- Around 3–8 minutes: green checks can conceal tautological assertions,
  source-structure checks posing as behavior tests, and mocks that remove the
  relevant failures. The review skill now examines which changed behavior a test
  can actually disprove and ties test findings to specific failure cases.
- Around 8–14 minutes: simple module interfaces support behavioral tests, and
  review deserves its own context and repository-specific standards. PR Bot
  already runs independently of the implementing agent. It now explicitly loads
  its review skill and reads `coding-standards.md` from the target PR's base
  branch. PR Bot's own standards are supplied in that file in this repository.
- Around 16–19 minutes: human attention should follow reversibility and blast
  radius. Reviews now explain merge danger and the next action. An irreversible
  external effect cannot be undone merely by reverting code. The instructions
  reserve automatic merging for reversible, localized changes; a human reviews
  and merges other materially risky changes.
- Around 20–22 minutes: review should improve the process behind the next PR.
  A confirmed gap can yield one specific proposed check or standards update,
  using evidence already gathered. Policy changes remain separate reviewable
  changes, rather than a bot changing its own policy while reviewing a PR.

Keep clean low-risk reviews short. Use a small before/after example or pseudocode
when it makes the behavior faster to understand. Neither generic design advice
nor a standards preference becomes a defect without a concrete consequence.

## Capability boundaries

The talk also recommends reviewers committing fixes. That requires a different
execution path from this bot's API-only review-and-merge setup: an isolated
checkout, a way to validate edits, and writes protected against a moving PR head.
This change does not add that path or claim to fix code. It keeps the dedicated
reviewer's context focused and makes its findings actionable.

Merge-danger classification is model judgment expressed in instructions, not a
deterministic enforcement mechanism. Repository owners should enforce mandatory
human approval with GitHub branch protection when required. The current native
merge tool also lacks a head-SHA precondition; a fresh context check narrows but
does not eliminate the race between review and merge.

## Shipshape ownership

[Shipshape](https://github.com/aranlucas/shipshape-mcp)'s practice catalog owns
portfolio adoption and shared prevention. Its companion `review-standards` seed
checks for a root `coding-standards.md` in explicitly selected repositories.
Presence is an adoption signal, not proof of review or test quality. The practice
instructions guide a coding agent to preserve repository-specific standards,
verify meaningful behavior, report merge danger, and propose separate prevention
changes from confirmed review feedback.

PR Bot owns the per-PR reasoning and merge decision. Shipshape does not execute
repository code or merge changes. A PR Bot prevention suggestion can become a
reviewed catalog change with the source PR, reviewed SHA, triggering case, and
intended check. Cross-PR recurrence requires history evidence; current practice
results alone do not establish it.

Shipshape's seed is separate from its live catalog. Adopting it follows the
catalog's normal review process; changing this repository does not publish it.
