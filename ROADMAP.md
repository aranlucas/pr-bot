# PR Bot feature roadmap

Updated 2026-10-26. Proposed releases, not delivered capabilities. Digits and MCP
products take portfolio priority; PR Bot supports their maintenance workflow.

## Starting point

Baseline: `62cb5e660f5a5bccd96d05834c883e384d0002c7`. The
[README](README.md) describes signed-webhook review, typed merge assessments,
localized fixes, exact-reviewed-SHA squash merges, GitHub auto-merge queueing,
pause controls and metadata-only diagnostics. Finishing a review while CI runs
and queueing an eligible merge already exist.

Target user: a maintainer who wants a trustworthy review and a clear next action
without repeatedly inspecting bot logs or paying for duplicate work.

## Priorities

### 1. Explain the next action in the existing PR summary

Make the current state easy to distinguish: review underway, changes needed,
waiting for evidence, human decision needed, queued, or failed. Name the exact
head and the missing evidence, with relevant GitHub links.

Acceptance: a provider failure never appears as a clean review; a new commit
makes an old assessment visibly stale; status updates use the existing summary
rather than adding timeline noise. Do not build a separate dashboard first.

### 2. Review a follow-up without repeating useful work

Reconcile earlier findings against a new diff and report fixed, still-open and
new findings. Reuse evidence only when the current change leaves its assumptions
valid. Distinguish this from the existing same-head event suppression.

Acceptance: moved code and newly changed callers are considered; dismissed
findings are not blindly reposted; the bot states what it did not inspect.
Every new head still needs its own merge assessment and current readiness checks.

### 3. Predictable review effort

Offer maintainer-selected review modes with explicit scope and enforceable turn,
tool or model-usage limits supported by the existing runtime. First establish
which usage fields are reliably available; never present missing billing data
as zero cost.

Acceptance: reaching a limit leaves a partial-review result and actionable next
step, never an approval; mode changes cannot bypass authorization, authorship or
branch protection. Compare accepted findings and maintainer time with model
usage before increasing depth.

### 4. A useful recovery path after failure

Give the maintainer one explicit way to retry the current head, with a concise
failure category and links to existing run diagnostics. Prevent a retry from
duplicating a published review or blindly repeating a consequential write.

Acceptance: a stale retry refreshes target/head first; successful prior actions
are reconciled; cancellation and ambiguous merge outcomes remain distinguishable.
Never run an indefinite background polling loop.

## First release and evidence

Start with priority 1 on a small set of owned repositories. For the next ten
reviews, record whether the maintainer understood the state, time spent finding
the next action, repeated comments, accepted findings and incomplete reviews.
Use existing metadata and voluntary feedback; exclude private code and review
bodies from product analytics. This is an evaluation plan, not a measured saving.

Follow [review standards](coding-standards.md). Prefer existing Eve/GitHub tools;
add custom behavior only for a demonstrated missing capability, with tests in
the existing runner. Keep Shipshape's portfolio prioritization separate from
this bot's responsibility for one PR.
