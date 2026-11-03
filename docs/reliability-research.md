# Reliability: constraints and validation plan

This plan consolidates the October 23–24, 2026 investigations of Eve 0.82.0,
GitHub Tools SDK 1.18.0 / extension 0.9.0, AI SDK 7.0.148, and the
OpenAI-compatible provider 3.0.75. Historical observations explain the priorities;
they do not establish current production settings or improvement rates. Recheck
framework claims against the resolved package's bundled docs/source on upgrade.

## Model routing and invocation budget

The app's [model middleware](../agent/lib/model.ts) applies a **90-second total
deadline** to each provider invocation, including continuously arriving output.
It preserves caller cancellation. This is not an aggregate turn or Workflow-step
budget. Eve's `harness/model-call/call.js` can wrap that timeout as
`ModelStreamStalledError` even while output is arriving; `retry.js` allows three
attempts. AI SDK and Workflow have separate retry layers. Their constants alone
do not establish how many requests a particular error will cause.

Two historical incidents establish why increasing the deadline is insufficient:

- October 23: session `wrun_41M5MXZG0M0GZZP5NMQYQ47816` took about 14m36s to
  fail. Five provider attempts reached 90 seconds; another was interrupted by
  the host's 300-second limit, and Workflow replayed the unfinished step.
- October 24: session `wrun_41M5QRF03G0GPTGYJ5A5WGT0F3` failed after about
  17 minutes. Six 90-second calls emitted reasoning but no answer/tool input;
  a host interruption, replay, and later Workflow quota failure added delay.
  Active reasoning at the parsed SDK boundary was observed, not a silent stream.

The app requests `reasoning: "low"`. October 24 inspection of FreeLLMAPI 0.16.9
at commit `26484157fd15f5fb66f54d3a86f568997ea304de` found that its
[sampling policy](https://github.com/tashfeenahmed/freellmapi/blob/26484157fd15f5fb66f54d3a86f568997ea304de/server/src/lib/sampling-params.ts)
dropped `reasoning_effort` for Cloudflare. Application-to-router serialization
is covered by [model tests](../test/model.test.ts); router forwarding and latency
improvement require separate verification. Fixing the app alone cannot repair a
proxy's forwarding policy.

The same router revision's
[fallback loop](https://github.com/tashfeenahmed/freellmapi/blob/26484157fd15f5fb66f54d3a86f568997ea304de/server/src/lib/fallback-loop.ts)
recorded client cancellations with zero token placeholders and without benching
the route. Its [analytics](https://github.com/tashfeenahmed/freellmapi/blob/26484157fd15f5fb66f54d3a86f568997ea304de/server/src/routes/analytics.ts)
excluded cancellations from the success denominator. Those zeros are not proof
of no reasoning, and displayed router success is not PR Bot completion rate.
GLM-5.3 was disabled globally in that router on October 23; this affected other
clients too. A short quiet window did not establish causal improvement. Verify
current routing before changing it again.

Next validation, in a disposable harness:

1. Exercise Eve's real retry path with stalled headers/body, continuous output,
   socket closure after HTTP success, 429/503, caller cancellation, and compaction
   failure. Record physical requests separately from logical operation identities.
2. Confirm the deployment's effective duration, plan, and generated flow config.
   The incidents hit 300 seconds; Eve requests `maxDuration: "max"`, so that
   observation is not a universal framework limit.
3. Budget provider calls, backoff, compaction, tools, and persistence/flush margin
   together. Request supported Eve retry/budget control before patching internals
   or adding a retry layer.
4. Compare the current route with a stable primary and independent fallback on
   identical reviews: delivered outcomes, quality, latency, timeouts, and usage.
   Verify effort forwarding before comparing lower reasoning. Missing billing
   data is not zero cost.

## Missing deployments and accepted deliveries

October 22 logs showed `AcceptedSessionIdentityError` with **404 Deployment not
found** for session `wrun_41M563ZETK0GNPK72HD1QT4BQY`. The command had been accepted
before identity lookup failed. The logs did not identify why the deployment was
removed or establish that the turn never ran.

Before redelivery, inspect the session and GitHub for accepted work or published
output. A reset-on-error wrapper can discard state or duplicate a consequential
write. Retain deployments needed by active Workflow sessions/stream anchors;
check actual deletion history before attributing a 404 to automatic retention.
Use a disposable deployment to reproduce recovery and rollback compatibility.

Eve 0.82 can hand an **idle** Vercel session to the deployment accepting its next
delivery while preserving session ID and stream. Active turns, pending input,
queued work, and active tasks prevent handoff. It does not automatically reset
stranded Vercel sessions. Verify the serving release when checking a fix; consult
the bundled `concepts/execution-model-and-durability.mdx` before recovery changes.

The native GitHub route returns HTTP 200 after scheduling background dispatch;
subsequent send failures are logged. Its dispatcher includes delivery ID in
context but does not forward it as Eve's supported `idempotencyKey`. A 200 is
therefore neither durable acceptance nor delivered review. Request native wiring
upstream; test identical signed delivery IDs, distinct deliveries for one head,
and dispatch rejection after acknowledgement. Current channel fixtures establish
routing/filtering, not full-workflow deduplication. GitHub
[does not automatically redeliver failed webhooks](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

## Ambiguous writes and freshness

Completed durable steps reuse recorded results; an interrupted step can execute
again. GitHub Tools wraps executor calls in nested durable steps, so not every
outer replay repeats a completed write. The remote write can still succeed
before its result is saved. Assessment state and a GitHub write are not one
transaction. Keep the default one-model-call checkpoint batching while testing
these boundaries.

The [review gate](../agent/lib/review-policy.ts) narrows the read/write race but
the installed SDK omits review `commit_id`. Direct merges already pin `sha` via
[the local tool](../agent/tools/merge-reviewed-pull-request.ts). Comments, replies,
and file fixes retain instruction-level freshness checks. Do not describe these
as atomic or exactly-once guarantees.

Fault-inject a stored comment/review followed by a dropped response, interruption
before durable save, and a second model intent after normal success. Count actual
remote objects. Reconcile unknown outcomes with native reads before creating
again. Test stale heads and superseding events separately. Seek upstream
operation identity/reconciliation and review head binding before adding a second
coordination store or GitHub client. Existing direct-merge lost-response fixtures
do not establish general comment/review idempotency.

## MCP and review-behavior coverage

The model deadline does not bound remote MCP initialization, tool listing, or
tool execution. Eve 0.82's public MCP definition exposes no per-phase timeout or
retry setting. Current [search tests](../test/search-connection.test.ts) establish
configuration/auth, not end-to-end protocol or outage behavior.

Use a local MCP fixture for initialize/list/call, discovery versus handshake-only
servers, Bearer auth, allowlists, qualifying 401 recovery, session expiry,
malformed/error results, stalls, and cancellation. An optional documentation
outage should block only a material claim that needs it. Request native deadlines
rather than replacing every connection or patching global fetch.

Use native Eve evals for judgment and compaction; keep Vitest for deterministic
interfaces. Production interactive auth is disabled: use a dedicated target,
not broader production auth. Stub every write used in a case; an unmatched eval
stub can execute the real tool, and connection discovery can remain live.

Acceptance cases:

- Clean PR, real blocking defect, omitted files even with `filesHasMore: false`,
  already-reviewed head, superseding head, paused/review-only requests, author
  dispute, verified fix, optional lookup failure, write failure, and merge denial.
- Two forced compactions preserving reviewed SHA, assessed/remaining files,
  finding IDs, author corrections, summary ID, failed lookups, and invocation
  intent. A head change invalidates the old merge assessment. Assert external
  actions and coverage rather than exact summary wording.
- Retry then success remains distinct from failed review; a silent exit emits no
  PR write. Successful stream/tool completion never substitutes for observed
  publication at the expected SHA.

## Interaction follow-ups

The October 17 interaction research proposed two extensions beyond the current
follow-up controls. Neither has established delivery evidence:

- **Explicit deferral:** record a maintainer's accepted scope decision in the
  existing discussion without treating it as proof of a fix or readiness. Avoid
  reposting it unless new evidence changes the decision.
- **Opt-in CI context:** explain a failed check and offer rerun/fix only as an
  explicit author action, without reviewing on every CI event. Inspect Eve's CI
  hooks and the SDK `ci-ops` preset before adding an adapter. Any future thread
  resolution must first solve the installation-context gap.

The current product priorities and incremental-review acceptance criteria remain
in [the roadmap](../ROADMAP.md).

## Measuring results

Use deduplicated eligible deliveries at the same release and time window as the
denominator. Track delivered reviews, failed turns, recovered attempts, time to
review, usage, stale skips, duplicate publications, and policy denials separately.
For interaction changes, also track accepted/disputed findings and verified fixes
versus intentional or outdated findings. Historical overlapping Sentry event
counts, cumulative session tokens, and capped log queries cannot supply those
rates.

Vercel full-text queries can match more event types than requested. Filter exact
JSON events and split saturated windows; retention and Agent Runs trace gaps can
limit coverage. A waiting session can contain a completed turn, while a completed
tool can return an SDK error. Confirm the GitHub artifact. Follow the
[debugging procedure](../README.md#debug-a-review-run) and keep private content
out of telemetry and fixtures.
