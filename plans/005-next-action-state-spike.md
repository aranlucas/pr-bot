# Plan 005 (spike): Define a deterministic next-action state for the PR summary

> **Executor instructions**: This is a design spike. Produce a short design
> note and, optionally, a prototype behind no feature flag. Do not change
> merge or review gates. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9c6c07b..HEAD -- ROADMAP.md agent/lib/merge-assessment.ts agent/tools agent/instructions.md`

## Status

- **Priority**: P3
- **Effort**: M (coarse; direction work)
- **Risk**: LOW (spike)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `9c6c07b`, 2026-11-11

## Why this matters

`ROADMAP.md` priority 1 asks for the summary to "distinguish: review underway,
changes needed, waiting for evidence, human decision needed, queued, or
failed", with acceptance that "a provider failure never appears as a clean
review; a new commit makes an old assessment visibly stale." Today the summary
text is entirely model-written (`agent/instructions.md`, "Publishing"). The
deterministic pieces already exist but nothing combines them:

- `decision()` in `agent/lib/merge-assessment.ts:20-56`, which yields
  `eligible`, `waiting_for_evidence` or `human_review_required` with reasons.
- The `enable-auto-merge` results `queued`, `ready`, `blocked` and `merged`.
- `turn.failed` in `agent/hooks/failed-turns.ts`.

## Questions the spike must answer

1. What is the state enum and its mapping from those sources? Include
   `stale`, meaning the reviewed SHA is not the head.
2. Who writes it? Options: (a) a tool output field the model must copy;
   (b) a deterministic `toModelOutput` on `record-merge-assessment` that gives
   the exact status line; (c) a hook that posts or updates a marker line in the
   summary. Option (c) conflicts with "PR output uses explicit GitHub tools" in
   the README, so justify it or reject it.
3. How does a failed turn surface without adding timeline noise? Eve's default
   `turn.failed` posts an error comment. Check whether the repo already
   suppresses it on PRs.
4. Which existing tests would cover it (`test/github-results.test.ts`,
   `test/merge-policy.test.ts`)?

## Output

`docs/next-action-state.md`, at most one page: the enum, the mapping table,
the chosen writer with rejected alternatives, and a test list. No runtime
change is required to finish this spike.
