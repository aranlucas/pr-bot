# Eve PR reviewer reliability research

Research date: 2026-10-23. Scope: source and documentation research only. No
production logs, Sentry events, network calls to configured model/MCP services,
dependency installation, runtime changes, or PR creation were performed.

## Evidence and version boundary

Read `AGENTS.md`, `README.md`, `coding-standards.md`, the agent configuration,
instructions, skills, channels, connections, extension, model/auth helpers,
merge assessment/policy, sandbox lifecycle, and instrumentation. Reviewed the
existing channel, extension, model, and search-connection tests without running
them. Dependencies became available during research. Installed versions are
Eve **0.82.0**, GitHub Tools SDK **1.18.0**, Eve extension **0.9.0**, AI SDK
**7.0.148**, OpenAI-compatible provider **3.0.75**, Octokit **5.0.5**, and
Octokit retry plugin **8.1.1**. The lockfile, rather than the package.json caret
ranges, defines this research's runtime version boundary.

**Verified** below means established by matching local implementation/docs or
official external documentation. **Hypothesis** means a plausible failure path
that still needs fault injection or production evidence. A source-level gap is
not evidence that it caused a particular incident. Bundled Eve docs, beginning
with [their index](../node_modules/eve/docs/README.md), take precedence over
the moving [official website](https://eve.dev/docs) for version-specific claims.
Local dependency links require installation; SDK source maps include the
original TypeScript in `sourcesContent`.

## Recommended order

1. Reproduce and bound model retry/deadline behavior through the actual Eve
   harness, including compaction, before changing the existing 90-second limit.
2. Verify signed-delivery deduplication and dispatch acceptance separately from
   the webhook's HTTP response. Prefer an Eve channel fix over another ingress.
3. Inject ambiguous GitHub write outcomes through the mounted extension; retain
   its durable steps and request handling. Pursue missing write idempotency and
   merge head preconditions upstream.
4. Exercise MCP initialization, discovery, tool calls, cancellation, and failure
   reporting against a local protocol fixture. Configuration tests do not cover
   these paths.
5. Add compaction and review-behavior evals, keeping transport tests independent
   of model judgment. Measure completed, correctly delivered reviews at a known
   SHA, not just successful turns.

## 1. Retry ownership and time budgets

**Verified — app:** [model.ts](../agent/lib/model.ts) combines Eve's incoming
abort signal with a fresh `AbortSignal.timeout(90_000)` in model middleware.
This bounds an underlying provider invocation, including its streaming body;
it does not establish an aggregate turn or Workflow-step deadline. Existing
[model tests](../test/model.test.ts) cover waiting for headers, a stalled body,
continuous output, and caller cancellation through AI SDK `streamText`. They
do not run Eve's outer retry loop or a durable workflow.

**Verified — Eve:** [`runModelCallWithRetries`](../node_modules/eve/dist/src/harness/model-call/retry.js)
allows **three total attempts**, with approximately 500–749 ms then
1,000–1,249 ms backoffs. Its [classifier](../node_modules/eve/dist/src/harness/model-call/errors.js)
retries flagged retryable errors, recognized transient failures, and statuses
408, 409, 429, and 5xx; other errors can be terminal or recoverable. In
[`ModelCaller.attempt`](../node_modules/eve/dist/src/harness/model-call/call.js),
an abort-like error becomes `ModelStreamStalledError` when Eve's own generation
signal was not aborted. Consequently, a provider deadline can be reported as a
stall even when output had continued. Eve configures ten-minute first-output
and inter-output timers, rather than a ten-minute total request cap. Its
public [agent configuration](../node_modules/eve/docs/agent-config.md) exposes
no supported model-retry-count or aggregate model/tool timeout setting in this
release.

**Verified — additional layers:** AI SDK defaults `maxRetries` to two;
this is separate from Eve's three attempts. See the current official
[`streamText` reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text#maxretries)
and the installed [AI SDK implementation](../node_modules/ai/dist/index.js).
Workflow also retries failed steps; the current official
[Workflow retry guide](https://workflow-sdk.dev/docs/foundations/errors-and-retries)
documents three retries by default and `FatalError`/`maxRetries` for step
authors. These are not equivalent to a public Eve agent setting. Do not assume
all layers multiply for every error: the layer that catches or converts the
failure determines which outer retries remain possible.

**Verified — hosting uncertainty:** The README assumes a 300-second function
limit, but Eve's installed [Vercel build configuration](../node_modules/eve/dist/src/internal/nitro/host/vercel-build-output-config.js)
requests `maxDuration: "max"` for the workflow flow route. Current Vercel docs
list Fluid Compute limits of 300 seconds for Hobby and an 800-second normal
maximum for Pro/Enterprise, with a separate extended-duration beta. Therefore
300 seconds is not established for this deployment by repository source alone.
Read the generated function configuration and confirm the project's plan and
effective limit before tuning. A durable session can span many invocations;
the relevant budget is the invocation executing an unfinished step. See
[Vercel duration configuration](https://vercel.com/docs/functions/configuring-functions/duration).

**Hypothesis:** repeated 90-second attempts can approach a 300-second invocation
limit: three such calls consume about 270 seconds before backoff and other work.
This is a conditional calculation, not an observed latency distribution or a
complete upper bound. Fresh SDK calls may reset middleware deadlines;
compaction, GitHub requests, and other work add separate time.

**Recommended validations:**

- Use a controlled OpenAI-compatible HTTP fixture with Eve's actual model loop.
  Return 429 with `Retry-After`, 503, 401, an error SSE event, truncated SSE,
  headers followed by a stall, and slow continuous output. Record external
  request count and timestamps, model/step attempt identities, termination
  state, and whether any tool ran. Verify cancellation stops further attempts.
- Include a failure after an inline write and a compaction failure. Determine
  whether the next attempt reuses history and tool results or initiates new
  work. Avoid asserting a multiplier inferred only from constants.
- Set a budget equation from the measured path: provider calls + retry delays +
  compaction + tools + persistence/flush margin must fit the effective function
  duration. Prefer a reliable configured provider route and smaller evidence
  requests before increasing deadlines or adding fallback/retry layers.
- If retries need coordinated control, request supported Eve configuration
  upstream. Middleware controls provider calls; it cannot safely rewrite Eve's
  durable orchestration. Do not patch dependency internals.

## 2. Durable replay is not external write idempotency

**Verified — Eve:** completed steps replay recorded results; interrupted steps
can execute again. Default `experimental.workflow.modelCallsPerStep` is one;
increasing it broadens the replay unit to include more earlier model calls and
inline tool executions. Keep the default while investigating reliability. See
the version-matched [durability guide](../node_modules/eve/docs/concepts/execution-model-and-durability.mdx#resuming-after-a-crash)
and [batching configuration](../node_modules/eve/docs/agent-config.md#workflow-checkpoint-batching).

**Verified — GitHub SDK:** mounted tools use `runGithubToolStep`, whose inner
`executeGithubToolStep` has a `use step` directive. Completed nested GitHub
steps can therefore reuse recorded outcomes; it would be inaccurate to claim
that every outer model-step replay necessarily reissues a completed write.
The external request can nevertheless succeed before its durable result is
recorded. The SDK explicitly identifies comment creation as non-idempotent;
each invocation calls GitHub's comment-create endpoint. Sources: SDK original
`src/eve/steps.ts`, `src/eve/build.ts`, and `src/core/pull-requests.ts`, embedded
in [Eve runtime source map](../node_modules/@github-tools/sdk/dist/eve-runtime-DnhM9Vog.mjs.map)
and [core source map](../node_modules/@github-tools/sdk/dist/write-tools-BaoTUCg7.mjs.map).
Workflow's official [idempotency guide](https://workflow-sdk.dev/docs/foundations/idempotency)
also distinguishes duplicate workflow starts from duplicate external effects.

**Verified — app:** the summary override in
[github.ts](../agent/extensions/github.ts) changes description/model output to
discourage repeats. It does not reject a second call. The existing durable
[merge assessment](../agent/lib/merge-assessment.ts) is an appropriate use of
native `defineState`, but a durable state update and a remote GitHub write do
not form one transaction. State alone cannot close the success-before-save
window. See [Eve state semantics](../node_modules/eve/docs/concepts/state.md).

**Hypothesis:** duplicates can arise from an interrupted GitHub step, Octokit
retrying an ambiguous write, a repeated model call, or another delivery/session.
These require separate reproductions. A model instruction or a successful
replay test does not establish protection against all four.

**Recommended validations:**

- Use a fake GitHub endpoint that stores a created comment/review, then drops
  the response. Retry/restart at the nested step boundary and count stored
  external objects. Separately make the model issue the same write twice after
  a normal successful response. Assert one summary and no repeated inline
  findings for the reviewed SHA as the desired behavior, expecting current
  tests to expose missing guarantees rather than presuming they pass.
- Reconcile unknown write outcomes with existing native comment/review reads
  before a new creation. Existing GitHub summaries should remain the durable
  cross-session review record. A stable summary marker or stored comment ID
  can aid reconciliation, but a list-then-create sequence still races and must
  not be described as exactly-once.
- First request SDK/extension support for replay-stable operation identity and
  result reconciliation. Add local coordination only after proving the native
  integration cannot meet a concrete requirement. Do not introduce a second
  GitHub client or a generic persistence service as an assumed solution.

## 3. GitHub delivery and tool reliability

**Verified — ingress:** the native
[`githubChannel`](../node_modules/eve/dist/src/public/channels/github/githubChannel.js)
verifies the request, schedules dispatch with `waitUntil`, and returns HTTP 200.
[`sendGitHubTurn`](../node_modules/eve/dist/src/public/channels/github/dispatch.js)
catches send failures and logs them. PR-context read failures are also swallowed
so dispatch can proceed without that context. HTTP 200 therefore does not prove
that Eve accepted a durable turn or that a review was delivered.

**Verified — delivery identity gap:** that dispatcher places the GitHub delivery
ID in context but does **not** supply `idempotencyKey` in `from(...).send(...)`.
The public native channel API does not expose a per-delivery options override
in the app's `onPullRequest` result. Eve's general channel send API supports
deduplication keys and remembers the last 1,024 distinct keys per session,
including across replay/handoffs. Thus general Eve support exists but is not
wired into this GitHub dispatcher. See [retried deliveries](../node_modules/eve/docs/channels/custom.mdx#retried-deliveries)
and [delivery semantics](../node_modules/eve/docs/concepts/execution-model-and-durability.mdx#message-delivery-and-steering).
GitHub preserves `X-GitHub-Delivery` for redeliveries and asks receivers to reply
within ten seconds. See [GitHub webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

**Verified — recovery limit:** GitHub does not automatically redeliver failed
webhooks. Its manual/API redelivery facilities cover HTTP delivery failures;
they cannot identify a background dispatch failure hidden behind HTTP 200.
See [failed delivery handling](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

**Verified — request layers differ:** Eve's native channel
[API helper](../node_modules/eve/dist/src/public/channels/github/api.js) and the
app's [installation lookup](../agent/lib/github.ts) use fetch without an explicit
per-request deadline. GitHub extension operations instead construct
`new Octokit({ auth: token })` in SDK `src/client.ts`. Installed Octokit includes
retry and throttling plugins, not merely a thin request wrapper. The retry
plugin defaults to three retries, excluding several 4xx statuses; Octokit's
default rate-limit handlers allow a first retry. Sources: [SDK core map](../node_modules/@github-tools/sdk/dist/write-tools-BaoTUCg7.mjs.map),
installed `octokit/dist-src/octokit.js` and
`@octokit/plugin-retry/dist-src/index.js` under `node_modules/.pnpm`, and the
[official Octokit repository](https://github.com/octokit/octokit.js).
Throttling belongs to each created client; do not infer an app-wide request
queue or global mutation pacing from it.

**Verified — merge transport constraint:** GitHub's merge API supports a head
`sha` precondition and returns conflict when it differs. The installed SDK's
`mergePullRequestInputSchema` and request omit that parameter. The app's
[merge policy](../agent/lib/merge-policy.ts) checks the head again after gathering
evidence but cannot make the later merge atomic. Prefer adding the precondition
upstream and enabling the upgraded extension. See [GitHub merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
and SDK `src/core/pull-requests.ts` in the core map above.

**Recommended validations:**

- Extend the signed-webhook fixture to send identical delivery IDs twice,
  including while the first turn runs, and send distinct deliveries for one
  head SHA. Check both durable turn count and external review count. The current
  [channel tests](../test/github-channel.test.ts) establish signatures, filters,
  and routing, not full-workflow deduplication. Ask Eve to forward the delivery
  ID through its native dispatcher before authoring a replacement channel.
- Make the background send reject after webhook acknowledgement and make PR
  context reads fail. Verify distinct operational signals for received,
  durably accepted, review completed, and review published. Recovery should
  replay the intended event only after reconciling current PR/head state.
- Exercise extension reads/writes with 401, 403 permission denial, primary and
  secondary rate limits, 429, 5xx, dropped bodies, and hanging fetches. Assert
  actual wait durations, retry counts, and abort propagation at the network
  boundary. Do not blindly retry all 403s. GitHub documents `Retry-After`, reset
  headers, increasing delays, and pacing mutative requests in its
  [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
- Test a changed head after the gate's last read and before merge; keep the
  current fail-closed readiness checks and record the remaining race until
  upstream supports the precondition. Also test lost merge responses: a later
  read of merged state should reconcile success rather than report a new merge.
- Audit installation-ID cache behavior after repository transfer or App
  uninstall/reinstall. The module-local map has no invalidation; whether this
  is an incident source is unverified. Test before adding cache machinery.

## 4. MCP initialization and remote tool calls

**Verified — app and protocol:** FreeLLMAPI already sets
`protocolVersionDiscovery: false`. Eve then skips `server/discover` and uses
`initialize`, proposing protocol `2025-11-25`. Keep this compatibility setting
until server support changes. Context7 retains discovery defaults. See
[connections](../agent/connections/freellm.ts),
[bundled MCP docs](../node_modules/eve/docs/connections/mcp.mdx#configure-protocol-discovery),
and the official [2025-11-25 initialization lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
Do not confuse Eve's newer discovery option with a server violating the older
handshake protocol.

**Verified — Eve transport:**
[`McpConnectionClient`](../node_modules/eve/dist/src/runtime/connections/mcp-client.js)
tries HTTP first and falls back to SSE for HTTP 400/404/405. It caches successful
connection/tool metadata, clears failed initialization promises, and refreshes
authorization/retries a request once after a qualifying 401. These mechanisms
do not constitute arbitrary transient-error retries or a timeout policy.

**Verified — missing deadline exposure:** the public
[MCP connection definition](../node_modules/eve/dist/src/public/definitions/connections/mcp.d.ts)
has no initialization/tool timeout or retry-count option. Eve's client
construction does not supply the bundled MCP client's `initializationOptions`
or `maxRetries`; metadata uses `listTools()` without request options. The bundled
client defaults tool-call retries to zero and creates request timers only when
options specify a timeout. Discovery has a short explicit probe timeout for
applicable HTTP transports, but that does not bound initialization or tool
listing. Execution forwards the active abort signal to the tool call, which
is cancellation rather than a fixed deadline. Sources:
[Eve connection client](../node_modules/eve/dist/src/runtime/connections/mcp-client.js)
and [bundled MCP implementation](../node_modules/eve/dist/src/compiled/@ai-sdk/mcp/index.js).
The app's model-only 90-second middleware does not time out MCP fetches.

**Hypothesis:** a reachable MCP endpoint that never completes initialization,
tool listing, or a tool response can occupy a step until an outer cancellation
or host limit. Cached sessions may also need recovery after expiry; inspect the
bundled transport and reproduce before claiming every stale session fails.

**Recommended validations:**

- Use a local MCP fixture, driven through Eve discovery/execution. Assert
  `initialize` → `notifications/initialized` → `tools/list` → `tools/call`, Bearer
  auth, negotiated protocol/session headers, allowlists, and no disallowed tool
  exposure. Cover discovery-enabled and handshake-only servers separately.
- Inject unsupported discovery, 401 before/after initialization, transport
  fallback statuses, session expiry, malformed results, `isError: true`, stalled
  initialization/list/call, and cancellation. Assert network requests and final
  model-visible outcome, not just connection object properties. The current
  [search tests](../test/search-connection.test.ts) only cover configuration/auth.
- Test missing Context7 credentials and unavailable search as optional evidence
  failures: a review should continue when the missing lookup is immaterial and
  withhold a consequential unsupported claim when it is material. Keep credential
  provisioning outside prompts and keep public-only query restrictions.
- Request native Eve per-phase deadlines and retry controls upstream. If an
  urgent unsupported capability requires an authored operation, limit it to
  that operation and document why the native connection cannot satisfy it;
  avoid replacing all MCP access or monkey-patching global fetch.

## 5. Context compaction and evidence retention

**Verified — current safeguards:** the agent declares 131,072 context tokens,
compacts at 75%, requests streamed usage, and instructs a coverage ledger at a
fixed reviewed SHA. The nominal threshold is 98,304 tokens; it is not a
guaranteed usable transcript size. Eve includes estimated request/checkpoint
overhead and provider input counts. It first caps older oversized tool results,
then summarizes when that is insufficient. The prior checkpoint is carried
separately into a later compaction. Sources:
[agent config](../agent/agent.ts), [review skill](../agent/skills/review-changes/SKILL.md),
[default harness guide](../node_modules/eve/docs/concepts/default-harness.md),
and [compaction engine](../node_modules/eve/dist/src/harness/compaction/engine.js).

**Verified — compaction uses provider capacity too:** it uses the active model
unless overridden, streams the summary, and invokes the same Eve retry helper.
A compaction failure disables retrying the enclosing model call in
`ModelCaller`, avoiding that particular nested retry multiplication. An
independent compaction model has its own behavior; do not assume the main
model's middleware follows an override. Sources:
[compaction step](../node_modules/eve/dist/src/harness/compaction/step.js) and
[model caller](../node_modules/eve/dist/src/harness/model-call/call.js).

**Hypotheses:** routed models with unknown/smaller actual windows, large
tool outputs added between compactions, inaccurate usage, or summaries losing
coverage/finding identifiers can produce failures or repeated reads. The README
describes a FreeLLMAPI routing floor, but repository configuration alone cannot
prove the live service's floor or selected upstream model. Do not infer that
`auto` always selects a particular model or has independent provider fallback.

**Recommended validations:**

- Use a deterministic fixture with an explicitly smaller context window and
  scripted input usage to force two successive compactions. Include a resolved
  finding, still-open finding, author correction, summary ID, reviewed SHA,
  assessed files, remaining files, failed lookup, and pause/review-only intent.
  Assert final external actions and coverage, not exact summary wording.
- Include omitted files (`filesOmitted > 0` with `filesHasMore: false`) and prove
  pagination happens; include a head change after compaction and prove the old
  ledger cannot authorize merge. Test absent/underreported/large provider usage
  and an oversized individual tool result.
- Measure repeated identical reads and maximum request size as diagnostic
  metrics. Consider native `defineState` for a compact typed coverage ledger
  only if an eval demonstrates material summary loss. State should aid evidence
  accounting, never substitute for fresh GitHub state or become a generic cache.
- Verify that compaction failure leaves an explicit recoverable/terminal result
  and no false completed-review marker. Current app instrumentation does not
  subscribe to compaction events; correlate framework stream events in tests
  before adding new telemetry.

## 6. Evals and reliable completion signals

**Verified — available framework:** native Eve evals drive a real HTTP server,
support multi-turn sessions, deterministic fixture models, qualified tool stubs,
and hard/soft assertions. `mockModel` defaults to a very large context window,
so compaction tests must override it. Stubs preserve input schemas and approvals;
sequences advance per new call, while transparent workflow replay reuses an
outcome. Connection discovery remains live even for stubbed operations.
An injected error named `TimeoutError` is immediate and does not test an actual
deadline. Sources: [eval overview](../node_modules/eve/docs/evals/overview.mdx),
[stubs](../node_modules/eve/docs/evals/tool-stubs.mdx), and
[targets](../node_modules/eve/docs/evals/targets.mdx).

**Verified — app constraint:** [eveChannel({ auth: [] })](../agent/channels/eve.ts)
disables interactive sessions. A stock `t.send()` eval is not by itself proof
of signed GitHub ingress, and production auth should not be broadened to make
evals work. Use dedicated fixtures for protocol/model tests and signed webhook
requests plus attached sessions for channel tests where the configured eval
identity has access. Verify session discovery/stream access in that harness
before promising a plug-and-play deployment eval.

**Verified — telemetry distinction:** SDK `runGithubToolStep` converts caught
exceptions into ordinary `{ error: ... }` results, and its model-output formatter
preserves that shape as JSON. The app
[instrumentation](../agent/instrumentation/runtime.ts) flags a completed tool
when `event.output.type === "error"`, not when a JSON payload contains `error`.
Thus extension failure payloads warrant a regression test: a completed lifecycle
event can mean executor completion rather than GitHub operation success. This
source mismatch is verified; whether a particular mounted error path reaches
these hooks with JSON output remains to be demonstrated. Source:
SDK `src/eve/steps.ts`/`src/eve/registry.ts` in its Eve runtime map above.

**Recommended minimum validation set:**

- Existing Vitest boundary tests: realistic provider streams, signed delivery
  duplicates, asynchronous dispatch failure, GitHub rate limits/ambiguous writes,
  real MCP protocol messages, and extension error-payload classification.
- Deterministic Eve fixtures: interrupted step/restart, duplicate tool intent,
  cancellation, two compactions, stale-head rejection, and expected failure
  recovery. Stubs cannot establish transport or external-write idempotency.
- Review-behavior evals with the real instructions: clean small PR; concrete
  defect; incomplete diff; superseded head; already-reviewed head; paused auto
  review; review-only mention; author dispute/verification; transient lookup
  failure; write failure; bot-authored fix; unavailable CI; and denied merge.
  Assert externally delivered review/summary and tool arguments/counts, including
  prohibited writes. A valid silent exit should assert no PR write.
- Define success as a review at the expected SHA with complete claimed coverage,
  one reconciled summary, no duplicate findings, and no unauthorized/stale
  mutation. Track delivery acceptance, completion, publication, request counts,
  latency, compactions, and waiting-for-input separately. A parked usage-limit
  approval is not a completed review; Eve's default session usage cap is
  40 million new input tokens and requests continuation approval when reached.
  `sessionTimeoutMs` is an idle-session timeout, not a turn deadline. See
  [runtime limits](../node_modules/eve/docs/agent-config.md#runtime-limits).
- Run behavioral gates on prompt/model/SDK upgrades; use real-network smoke tests
  against a disposable repository/service separately. Pin expectations to the
  resolved dependency versions and record provider response model IDs when
  supplied. Never use production logs or credentials as fixture data.

## Conclusions requiring parent-side evidence

This research does not establish which failures occur most often, the live
provider routing policy, the deployment's effective function duration, actual
rate-limit pressure, or whether stalled sessions eventually resume. The parent
should correlate those independently with the source-level failure paths above.
Keep framework changes, service configuration, and app behavior tests distinct;
none of these findings justifies adding another retry wrapper by default.
