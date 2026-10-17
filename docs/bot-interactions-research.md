# PR Bot interaction research

Research question: what interaction is missing for a useful, trustworthy PR
review bot, especially after the bot left a comment on PR #111 after the PR had
already merged?

Researched on October 17, 2026. Product recommendations below are judgments
informed by the cited documentation and studies, not proven outcomes for this bot.

## Implementation in this branch

The channel now accepts `opened`, `reopened`, `ready_for_review`, and
`synchronize` events for open, non-draft, unpaused PR payloads. Native extension
tools provide timeline history and label controls. A `review-follow-up` skill
defines explain, reconsider, verify, review-only, fix, and pause/resume paths;
the main review instructions reconcile previous findings and batch inline output.
No custom GitHub tools, database, or polling loop was added.

The event filters and automatic PR reply suppression run in code. Intent
handling, label mutations, deduplication, and freshness checks remain model
instructions. Automatic thread resolution is excluded because the installed
SDK's thread-only input cannot select this app's repository installation.
CI completion events still do not start turns. These boundaries are not claims
of complete deterministic enforcement of the recommendations below.

## Product shape at the start of the research

The repository initially started a PR turn when a pull request opened or when a
comment invokes the bot. Pushes, reopened PRs, and completed check runs do not
start a turn, and the channel does not check whether a PR is closed or merged
before dispatching it. The model instructions ask it to refresh the PR and stop
silently when the PR is closed or merged. Review output and fixes are written
through GitHub tools. See [README.md](../README.md#what-starts-a-turn),
[agent/channels/github.ts](../agent/channels/github.ts), and
[agent/instructions.md](../agent/instructions.md).

The linked failure is a concrete lifecycle mismatch: PR #111 was merged at
16:08:30Z, yet the bot's final response was published afterward. That means
“finish silently” cannot be only a model instruction; it must be an invariant
at the boundary of every external write. [PR #111](https://github.com/aranlucas/shipshape-mcp/pull/111#issuecomment-6236400129)

The concrete cause was Eve 0.80.1's default `message.completed` handler, which
posts final assistant text. The channel change in this work suppresses that
automatic delivery for PR conversations and retains issue replies. It does
not add a freshness guard to explicit extension writes. See the installed
`eve` package's `docs/channels/github.mdx` and
`dist/src/public/channels/github/defaults.js` for the matching contract and implementation.

## Highest-priority missing interactions

### 1. A write-time lifecycle gate: “is this still the same open PR?”

Before posting a review, replying, resolving a thread, committing a fix, or
merging, refresh the PR and verify all of the following:

```text
state == open
merged == false
headSha == the SHA that was reviewed
```

If the PR closed or merged, cancel the pending side effect and end silently.
If the head changed, review the new code before publishing. Run these checks
immediately before writes because a PR can change while a model turn runs.
Treat a stale turn as a normal no-op. These are product recommendations;
the current repository does not enforce them for extension writes. A fresh
read narrows the race but cannot make a subsequent GitHub write atomic with
that read. Native SHA preconditions should be used wherever available.

GitHub's review API supports binding a review to a `commit_id`, and warns that
comments based on an older commit can become outdated after later commits. The
API also exposes separate review submission, comment, and thread operations.
See [GitHub's pull request review API](https://docs.github.com/en/rest/pulls/reviews#Create-a-review-for-a-pull-request)
and [review webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review).
The installed SDK's `createPullRequestReview` schema does not currently expose
`commit_id`, so verify the wrapper's freshness behavior before relying on it;
do not silently assume that the native tool provides the API's full safety
contract.

### 2. A review conversation, rather than a single report

Give every finding a small state machine: `open`, `questioned`, `accepted`,
`fixed`, `rejected/intentional`, or `outdated`. Keep the discussion in the
inline review thread and make the next action explicit.

Useful author interactions, expressed as natural language or optional commands:

- **Explain:** restate the specific failure case and evidence in the existing thread.
- **Reconsider:** check an author's correction against the code; retain or withdraw
  the finding with a reason. An assertion that behavior is intentional still needs
  evaluation against the concrete risk.
- **Verify:** inspect the latest head after “I fixed it”; resolve the finding only
  when the underlying failure is addressed.
- **Fix:** apply a minimal correction under the repository's enabled fix policy,
  or offer a GitHub suggestion the author can apply.
- **Defer:** let an authorized maintainer record an accepted scope decision and
  avoid repeating it without new evidence. Deferral alone is not proof that a
  defect is fixed or that the PR is ready to merge.

Use native threads and their history as the initial record of these outcomes;
this does not require a new comment database or persistent state machine.
When a finding depends on an unresolved product requirement, ask one focused
question about that requirement before presenting the assumption as a defect.
Batch new findings into a review rather than sending a notification per finding;
GitHub explicitly recommends batching to reduce notifications. See
[GitHub's commenting guidance](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/commenting-on-a-pull-request).

The installed native surface includes listing reviews and threads, formal
reviews, replies, resolution, comment updates/deletion, and reviewer requests.
Prefer those tools over a custom comment database or wrapper; see the
[GitHub Tools catalog](https://github-tools.com/api/tools-catalog) and the
repository's [extension configuration](../agent/extensions/github.ts). Before
shipping this loop, verify two wrapper details against the installed version:
`resolveReviewThread` accepts only a GraphQL `threadId`, while this app's token
provider routes installation tokens by `owner` and `repo`; and formal review
creation does not expose `commit_id`. If either prevents correct per-installation
or freshness checks, record the missing extension capability and fix/upgrade the
extension before adding a custom API wrapper.

The interaction is also consistent with GitHub's own review model: reviewers
can comment, suggest an exact change, approve, request changes, reply, and
resolve a conversation. [GitHub: giving reviews](https://docs.github.com/en/pull-requests/concepts/giving-reviews)
and [resolving reviews](https://docs.github.com/en/pull-requests/concepts/resolving-reviews)
describe that workflow. Copilot comments support human replies, but GitHub says
Copilot does not see or answer those replies. That leaves room for a bot that
actually reconsiders a finding in conversation. CodeRabbit already documents
contextual chat. See [Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
and [CodeRabbit interactive review](https://docs.coderabbit.ai/guides/code-review-overview).

### 3. Re-review when the author changes the PR

Subscribe to `pull_request.synchronize` (and likely `reopened` and
`ready_for_review`) with a debounced, head-SHA-specific re-review. On each
review, reconcile existing bot threads against the new diff: resolve a finding
only when the new code addresses it, retain still-valid findings, and mark
findings whose lines disappeared as outdated. Do not replay the whole review
as a new top-level comment on every push. GitHub's line-outdated status alone
does not establish that a defect was fixed.

GitHub exposes separate webhook events for PR activity, submitted/edited/
dismissed reviews, review comments, and resolved review threads. Eve's GitHub
channel documents opt-in hooks for PR, check-suite, check-run, and workflow-run
events, while the native GitHub Tools preset exposes the review/thread reads and
writes. See [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
and [Eve's GitHub channel](https://eve.dev/docs/channels/github).

The product evidence favors this loop but argues for restraint: GitHub says
Copilot does not automatically re-review new pushes unless configured to do so,
and CodeRabbit distinguishes incremental review from a full review and offers
pause/resume controls. See [Copilot re-review behavior](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
and [CodeRabbit's review controls](https://docs.coderabbit.ai/guides/commands).

### 4. CI-aware interaction with a clear boundary

When a check suite or workflow fails, the bot should be able to explain the
failure in the relevant PR thread, identify whether the failure is caused by
the changed code, and offer `rerun` or `fix` only as an explicit author action.
When CI succeeds after a finding was fixed, the bot can run the targeted
verification and close the thread. This gives authors a single place to ask
“what is blocking this PR?” without turning every check event into a review.

The current repository explicitly ignores completed check runs. Eve documents
`onCheckSuite`, `onCheckRun`, and `workflow_run` hooks, and the installed SDK
has a `ci-ops` preset for reading failures and rerunning workflows. Reuse those
native surfaces if this interaction is added; do not create a parallel CI
adapter. See [Eve's CI hook example](https://eve.dev/docs/channels/github) and
the current [README behavior](../README.md#what-starts-a-turn).

### 5. Controls for when the bot acts

Support “review only,” “fix this finding,” and “pause reviews” as distinct
requests. This is a product recommendation, not a requirement to reconfirm
actions already authorized by repository policy. The current bot can already
commit localized fixes and merge eligible changes automatically. Any new
controls should respect that configured authority while making the current
mode clear. A question or a request to explain a finding should produce an
answer without unexpectedly triggering a fix or merge.

This matters because the current extension runs with `requireApproval: false`
for webhook turns, and the repository says merge danger is currently model
judgment rather than a deterministic precondition. GitHub formal reviews have
distinct `COMMENT`, `APPROVE`, and `REQUEST_CHANGES` actions; use those states
deliberately instead of treating a bot comment as approval. See [GitHub review
API actions](https://docs.github.com/en/rest/pulls/reviews#parameters-for-create-a-review-for-a-pull-request)
and [current extension policy](../README.md#what-the-bot-can-do).

## What to measure

Measure the interaction loop, not only review latency:

- stale-write suppression rate: attempted writes cancelled because the PR
  closed, merged, or changed head;
- findings resolved after a new commit, with separate counts for verified fixes,
  intentional decisions, and outdated findings;
- author follow-up rate for `explain`, `reconsider`, `verify`, `fix`, and
  `defer`;
- accepted, disputed, and rejected findings by severity and repository;
- duplicate comments per PR/head and comments posted after merge.

The empirical evidence suggests why these measures matter. A 2026 study of
54,791 agent comments across 342 repositories found that inline code suggestions
were the strongest predictor of resolution, while incorrect suggestions and
intentional design decisions were the most common unresolved patterns; long,
complex comments were less likely to be acted on. A separate study of 31,073
CodeRabbit review/feedback pairs found 56.3% rejected, commonly because
suggestions were invalid, redundant, out of scope, or misaligned with author
intent. These are observational studies, not a guarantee for this bot, but they
support short, evidence-linked findings plus explicit dispute and intent paths.
See [Cynthia et al., 2026](https://arxiv.org/abs/2607.21997v2) and [Lin et al., 2026](https://arxiv.org/abs/2607.03316v2).

GitHub's September 2026 Copilot update provides a useful product precedent:
after a later commit addresses a comment, Copilot resolves it during re-review
while outstanding feedback stays open. That is the right behavior to emulate,
with the additional write-time lifecycle gate required by PR #111. See
[GitHub's auto-resolution update](https://github.blog/changelog/2026-09-11-auto-resolution-and-analysis-updates-in-copilot-code-review/).

## Recommended sequence

1. Make all PR writes pass the deterministic open/merged/head-SHA gate, and
   add a regression test for a turn that becomes merged before publication.
2. Add native thread replies and explicit `explain`, `reconsider`, `verify`,
   `fix`, and `defer` interactions, with no new top-level comment for a reply.
3. Add synchronize-triggered, debounced re-review with thread reconciliation.
4. Add opt-in CI failure context and explicit rerun/fix commands.
5. Add merge/fix policy controls and instrument the measures above.

The design principle is simple: a great bot remains quiet when its context is
stale, and becomes conversational when its finding is uncertain. Every
interaction should either reduce uncertainty for the author or move one
specific review thread toward a verifiable outcome.
