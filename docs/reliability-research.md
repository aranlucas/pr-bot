# PR Bot reliability research

Investigated on October 23, 2026, around 17:00 UTC, against commit
`a7a0fb7` and installed Eve `0.82.0`. This is an evidence-backed improvement
plan; it does not change production configuration or runtime behavior.

Local fixes implemented after this investigation are tracked in
[the follow-up cycle](reliability/2026-10-23-1717Z.md). The observations below
describe the original baseline rather than the uncommitted implementation.

## Recommendation

Prioritize model transport reliability and useful failure telemetry, then repair
the deployment/session recovery path. Measure completed turns and delivered
reviews rather than failed attempt counts or completed sessions. Add behavioral
evals before changing model routing, context policy, or write controls.

The agent already uses native GitHub integration, a deterministic merge gate,
durable state, a bounded model deadline, early compaction, and metadata-only
telemetry. Preserve those foundations. A second orchestration system, a custom
GitHub client, or another retry layer is not justified by the evidence.

## Evidence and its limits

### Sentry

The signed-in dashboard's `pr-bot` project is `4512300594298880`. Its unresolved
issue view was set to all environments and 14 days; the integration's issues
were first seen roughly one day ago. Counts below are the issue totals shown at
inspection, not a 24-hour failure rate:

- [PR-BOT-5: model.call.failed](https://lucas-hl.sentry.io/issues/7807101635/):
  49 events, production; latest sampled release `a7a0fb79b345`.
- [PR-BOT-7: step.attempt.failed](https://lucas-hl.sentry.io/issues/7807242549/):
  32 events.
- [PR-BOT-4: tool.call.failed](https://lucas-hl.sentry.io/issues/7807085819/):
  10 events. The inspected event was `github__mergePullRequest`,
  `TOOL_EXECUTION_DENIED`, duration 613 ms, session
  `wrun_41M5MSHZ950GW2WYAF133B6FFR`, turn 0, step 22. A denial is evidence of
  enforcement; it does not establish that GitHub was unavailable or that the
  policy was wrong. Inspect the policy reason before classifying it as an incident.
- [PR-BOT-9: turn.failed](https://lucas-hl.sentry.io/issues/7808228877/): 2 events.
- [PR-BOT-8: session.failed](https://lucas-hl.sentry.io/issues/7807270063/): 2 events.
- [PR-BOT-A: channel.delivery.failed](https://lucas-hl.sentry.io/issues/7808228896/):
  2 events; the inspected event has `MODEL_CALL_FAILED` and the same session/turn
  as the sampled PR-BOT-9 event. [PR-BOT-6](https://lucas-hl.sentry.io/issues/7807238704/)
  has 5 events.

These lifecycle counts overlap. A model failure can also fail a step, turn,
and delivery. They must not be summed into a count of failed reviews.

Sentry was read through the existing browser login because no Sentry connector
or read token was available. No Sentry settings or issue states were changed.

### Vercel logs

Project `prj_UctrKXBXr0Nz9rtQSet28sqicxpF`, team
`team_CwphA8xYZkul7djQrwHlLr4G`, production deployment
`dpl_4tMqRZvaMPYRhPGvGf9e2UVc8tJi`.

The runtime-log API rejected a 24-hour query because this Hobby project retains
one hour of runtime logs. Queries using a rolling 50-minute window succeeded.
The error-cluster API accepted a 24-hour request, but returned clusters whose
first-seen timestamps extend back to October 15. Treat its counts as historical
cluster totals, not confirmed counts inside the requested day.

Concrete recent observations:

- At **16:12:28Z**, session `wrun_41M5MRAP5P0GWMK8Q0A2EP7AD1`, turn 0,
  step 4: a model attempt failed after **90,004 ms**. Eve logged
  `ModelStreamStalledError`, caused by a timeout, then retried after 597 ms.
- At **16:14:01Z**, session `wrun_41M5MRFWHK0GRNNZQVCEY5RXBB`, turn 0,
  step 10: a model attempt failed after **60,644 ms**. Eve's diagnostic log
  identified `AI_APICallError: Failed to process successful response`, with
  an underlying terminated connection and `UND_ERR_SOCKET`. This failure
  happened before the application's 90-second deadline. Eve retried after 565 ms.
- That second turn subsequently completed at **16:15:54Z**. Agent Runs records
  a completed `github__createPullRequestReview` call at 16:15:42Z. This proves
  recovery to a completed tool call; the GitHub review itself was not independently
  fetched during this investigation.
- The JSON failure records above, including a merge denial, were indexed with
  Vercel level `info` despite `stream=stderr`. A query restricted to error and
  warning levels missed those JSON records. Search `pr-bot.runtime` plus the
  event name or session ID when investigating.

A focused `model.call.completed` query returned 67 records, with 67 distinct
operation IDs, during approximately **16:08–16:58Z**. Successful completed calls
had median latency **11.3 s**, sample p95 **53.4 s**, maximum **73.7 s**, and
reported input counts from **15,576 to 84,514**. The served model IDs were:

- `poolside/laguna-s-2.1:free`: 26 calls.
- `nvidia/nemotron-3-ultra-550b-a55b`: 19 calls.
- `gemini-3.6-flash`: 11 calls.
- `nvidia/nemotron-3.5-lightning:free`: 10 calls.
- `z-ai/glm-5.3`: 1 call.

These are a small observational sample of completed calls, excluding failed or
unfinished calls. They do not establish which route fails most often. One turn
also switched served model IDs between calls. The app's configured `auto` route
does not provide a stable model identity.

The historical error clusters additionally report 25 tool-loop stream errors,
3 invocations reaching the **300-second** function limit, and two workflows
exhausting **4 attempts / 3 max retries** at the Workflow layer. These are
different layers from Eve's internal model retries and are not additive incidents.

Three webhook dispatch failures on October 22 point to the same old session,
`wrun_41M563ZETK0GNPK72HD1QT4BQY`, and deployment
`dpl_6ai6muEywovKTLdE4NbCY7UdbfjK`. The underlying key lookup returned
**404 Deployment not found**, surfaced as `AcceptedSessionIdentityError`.
The log explicitly says the session command was accepted before identity lookup
failed; this dispatch error does not prove the turn never started.

The project logs and traces can be inspected from the
[Vercel project](https://vercel.com/aranlucas-projects/pr-bot).

### Agent Runs

`vercel agent-runs list --since 24h --limit 100 --json` returned all 42 listed
sessions (`hasMore: false`): 38 waiting, 3 failed, 1 running. There were zero
completed sessions. **This is not zero completed reviews**: a long-lived session
normally waits after a completed turn. Eve documents that distinction in its
[session lifecycle](https://eve.dev/docs/concepts/sessions-runs-and-streaming).

Two useful trace examples:

- Session `wrun_41M5KPYDSQ0GXDZYZPGDP874QG`: turn 0 failed after roughly
  29 minutes, with 23 completed `getFileContent` calls; turn 1 later completed.
  Its current session status was waiting. None of those file-read counts alone
  proves redundant reads, because the metadata trace omits arguments.
- Session `wrun_41M5MPKH180GK1G68ERGAFFZT4`: turn 0 failed after roughly
  6 minutes 40 seconds. Its trace lists 14 completed file reads and no review
  publication tool. Runtime error clusters also record a model timeout and
  parking message for this session.

Session usage totals can be large: the list's median reported cumulative total
was 454,433 tokens and maximum 2,055,122. These are accumulated across calls and
sometimes turns, include provider-reported caching fields, and are **not**
individual prompt sizes. Do not compare them directly with the 131,072-token
context window or assume the provider's reported zero cost means zero resource use.

## Prioritized improvements

### 1. Improve routing reliability without multiplying retries

Keep the bounded deadline while benchmarking a stable primary model route and
an independently available fallback. Measure completion, time to review,
transport errors, timeout rate, token use, and review quality on identical cases.
The sample proves route diversity and two transport failure modes; it does not
prove a specific model or commercial provider is the right replacement.

The current middleware applies a 90-second total deadline to each provider
invocation, including streamed output. Three such attempts leave little room in
a 300-second invocation for backoff, compaction, tools, or reporting. A shorter
deadline could worsen slow-but-successful calls; a longer one can worsen hard
function timeouts. Inspect the resolved Eve retry implementation and observed
per-step wall time before selecting a new value. Do not add an SDK or proxy retry
layer without accounting for Eve and Workflow retries.

The 270-second calculation is a risk illustration, not a complete upper bound:
AI SDK retries can introduce additional provider invocations with fresh
middleware deadlines. Eve requests `maxDuration: "max"` for its flow route.
Confirm the effective deployment limit when tuning; the 300-second failures
above are observed runtime evidence, not a universal Eve limit.

Implementation surface: [model configuration](../agent/lib/model.ts),
[agent configuration](../agent/agent.ts), and the upstream model router.
Current [Vercel function limits](https://vercel.com/docs/functions/limitations)
and the installed Eve sources should guide the budget.

Validation: stalled headers, stalled body, continuously streaming output,
socket close after HTTP success, caller cancellation, exhausted retries, and
successful fallback. Existing model tests cover the first deadline/cancellation
cases; exercise the real Eve retry path for the combined budget.

### 2. Make telemetry identify the outcome and cause

Separate expected policy denials, recovered attempts, failed turns, and terminal
sessions. Keep attempt failures searchable, but alert primarily on terminal
failures, exhausted retries, webhook dispatch failure, and repeated inability to
publish a review. Preserve a metric for unexpected repeated merge attempts.
Keep a Vercel dispatch-error signal as well: failures before lifecycle delivery
instrumentation runs may never reach the current Sentry provider.

Persist the requested model/provider in operation-scoped `ctx.state` at model
start, and include it on failure. Retain the provider response identity on
successful completions. Add stable, low-cardinality classification only where
the runtime can supply it safely, such as deadline, connection interruption,
rate limit, auth, and policy denial. Add an explicit structured severity field
and verify actual Vercel indexing before relying on level filters.

The [current instrumentation](../agent/instrumentation/runtime.ts) logs only
duration for `model.call.failed`; the [Sentry schema](../agent/lib/sentry.ts)
therefore groups failures without a model or cause. Crucially, with
`recordOutputs: false`, Eve removes error details **before** invoking the
handler. Simply reading `event.error` cannot recover the missing cause. Prefer
an upstream structural error classification or a narrow provider-boundary
classifier using existing SDK error predicates. Keep raw errors, bodies,
headers, prompts, and credentials out of telemetry. See Eve's
[instrumentation contract](https://eve.dev/docs/observability/instrumentation).

There is also a **GitHub returned-error visibility gap in the source**. The installed
SDK's `runGithubToolStep` catches errors and returns `{ error: ... }`; this repo's
[extension test](../test/github-extension.test.ts) verifies a 404 returns
`error.code: "github_tools.NOT_FOUND"`. That is an ordinary resolved executor
result, not a thrown exception. Eve's native lifecycle maps a completed action
to `output.type: "result"`, and the metadata-only policy removes its body.
The current `output.type === "error"` check consequently cannot identify that
payload as a GitHub failure. Thus neither a completed tool trace nor the absence
of a Sentry tool error proves a successful GitHub API operation. Eve's native
`action.result` hook can inspect the returned output and emit only an allowlisted
SDK catalog code, tool name, and correlation IDs; no custom GitHub executor is
needed. Follow the installed [hook guide](https://eve.dev/docs/guides/hooks),
including `toolResultFrom` where its tool definition is available. Validate
401/403/404/422/429 responses without logging the error message or result body.

Use session and turn IDs to correlate consequences; use operation IDs to dedupe
replayed attempt records. Keep high-cardinality IDs in event context, with
links to the corresponding Vercel session rather than a synthetic unrelated
Sentry trace. Record separate outcomes for reviewed, skipped as stale/paused,
human review required, and publication failed, through the existing agent/state
and instrumentation surfaces where supported.

Validation: retry then success does not count as a failed review; merge denial
remains visible but is classified; nested/ambient secret data remains excluded;
model and provider survive worker replacement; a returned GitHub error is
classified even when the executor resolves; replay does not inflate metrics.

### 3. Repair and test old-deployment recovery

Investigate the missing deployment and retain deployments needed by active
Workflow sessions and stream anchors. Check the project's actual retention and
deletion history before attributing the 404 to automatic retention. Vercel's
[retention policy](https://vercel.com/docs/deployment-retention) describes the
control, but the logs do not identify who or what removed this deployment.

Treat the accepted-command/failed-identity path as a framework/platform
reproduction. Before redelivering, inspect whether work already ran and whether
GitHub already contains its output. Avoid a custom reset-on-error wrapper:
it could duplicate accepted work or discard state.

Two native ingress details make recovery testing especially important. Eve's
GitHub route returns 200 after scheduling dispatch with `waitUntil`, and its
dispatcher catches/logs later failures. The dispatcher includes the GitHub
delivery ID in model context but omits Eve's supported `idempotencyKey` send
option. Request that wiring upstream and test duplicate signed deliveries;
do not infer that duplicate reviews occurred from this source gap alone.
GitHub does not automatically redeliver failed webhooks, and its HTTP status
cannot reveal this background failure. See the installed `githubChannel.js`
and `dispatch.js` paths in the [framework research](eve-reliability-framework-research.md),
plus [GitHub's delivery guidance](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

Eve 0.82 supports moving an **idle** Vercel session to the deployment accepting
the next delivery, while keeping the original session ID and stream. Running
turns, pending input, queued work, and active tasks prevent handoff. Vercel does
not use the automatic stranded-session reset described for other worlds.
Some README statements saying existing runs always stay on their original
deployment are therefore too broad and should be revised. See the installed
durability guide and
[official execution model](https://eve.dev/docs/concepts/execution-model-and-durability).

Validation: open a test PR, complete a turn, redeploy, then invoke it again;
also redeploy during an active review and test rollback compatibility. Verify
one logical delivery, retained state, and correct output. Reproduce a missing
deployment in disposable infrastructure before proposing automatic recovery.

### 4. Add behavioral evals and replay tests

The repository has Vitest coverage for policy, channel, provider, and telemetry
behavior, but no `evals/` directory. Add the native Eve eval runner rather than a
custom test script. Its [tool stubs](https://eve.dev/docs/evals/tool-stubs) and
[assertions](https://eve.dev/docs/evals/overview) can exercise decisions and call
ordering; keep existing Vitest tests for deterministic interfaces.

High-value cases: a clean PR; a real blocking defect; an already-reviewed head;
superseding synchronize events; paused/review-only requests; optional docs
service failure; a head changing before publication; a merge denial; a model
failure followed by retry; and interruption immediately after a successful
GitHub write but before the durable step commits.

Use a purpose-built nonproduction target or local eval server because the
production Eve HTTP channel intentionally has no interactive auth. Stub every
write capability used in a case: an unmatched Eve stub executes the real tool.
Model evals do not replace an actual signed-webhook/redeploy integration test.

### 5. Make publication invariants deterministic where native APIs allow it

Summary deduplication, freshness before comments/fixes, and much of intent
handling still depend on instructions. The source already documents a duplicate
summary incident. Eve replays an interrupted step, so durable execution alone
does not guarantee an external GitHub write happens once.
The GitHub SDK already puts its executor inside a nested durable step, so a
completed nested call can reuse its recorded result. Focus fault injection on
interruption inside that step, loss of the remote response after acceptance,
and a new model call repeating an action. Do not assume every outer replay
reissues completed GitHub requests.

First inspect the installed GitHub extension's override/approval/executor
capabilities. Add freshness and target enforcement at the existing tool
boundary where it can deny deterministically without parking a webhook turn.
Reconcile an existing summary using native read/update tools before creation;
use supported commit/head preconditions where available. Request upstream
capabilities for gaps instead of introducing a parallel GitHub client.
See [extension configuration](../agent/extensions/github.ts),
[merge policy](../agent/lib/merge-policy.ts), and Eve's
[replay semantics](https://eve.dev/docs/concepts/execution-model-and-durability).

The inspected recovered trace has both update-comment and create-comment calls
in one turn. With arguments/results omitted, that alone does not prove a
duplicate or wrong target; validate the invariant with fixtures and GitHub
artifacts before treating it as a new incident.

### 6. Bound unnecessary context growth with evidence

Preserve the existing 128k routing floor and 75% compaction trigger while
testing read reuse and review coverage. Measure per-call input size, total calls,
compactions, and review completeness. The sampled completed requests topped out
at 84,514 reported input tokens, so this investigation does not establish a
context-window overflow. Repeated file reads may cover distinct files or ranges.

For a repeatable large-PR fixture, assert useful completion and preserved
coverage after compaction before changing its threshold. Keep optional Context7
and search failures scoped to the claim that needs them. The sampled failed
trace completed both docs lookups; MCP outages were not established as a major
cause here. See [context control](https://eve.dev/docs/concepts/context-control)
and the accompanying [framework research](eve-reliability-framework-research.md).

## Implementation sequence and success measures

1. Add model/provider correlation, denial classification, and turn-level
   outcome reporting; verify privacy and Vercel log queries.
2. Add a small eval fixture set and baseline the current `auto` route against a
   stable candidate and independent fallback. Keep all merge safeguards enabled.
3. Reproduce the missing-deployment delivery failure, test delivery deduplication,
   and update the retention/recovery runbook based on actual platform behavior.
4. Use those fixtures to implement native write-boundary safeguards and context
   improvements. Require evidence of preserved review quality before rollout.

Track: review publication success per eligible delivery, turn failure rate,
recovered retry rate, timeout rate, time to first review and full review,
model calls/tokens per reviewed head, stale-head no-ops, duplicate publications,
and policy denials. Separate intentional skips and human-review decisions from
failures. A webhook 200, a session waiting state, and a successful CI run each
answer a different question; none alone proves a useful review was delivered.

## Reproducing the read-only investigation

```sh
vercel agent-runs list --project pr-bot --scope aranlucas-projects --since 24h --limit 100 --json
vercel agent-runs trace <session-id> --project pr-bot --scope aranlucas-projects --since 24h --json
vercel logs --project pr-bot --scope aranlucas-projects --since 50m --query 'pr-bot.runtime' --json
```

These are existing native commands, not new repository scripts. The CLI request
log representation and the MCP individual runtime-log representation differ.
No credentials or full raw traces are saved in this document.
