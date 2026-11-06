# Correctness and reliability audit — 2026-11-06

Baseline: remote main `007ed0a` (merged untangle pass). No structural cleanup.
Tests and builds run in CI only; local inspection and dependency installation
with lifecycle scripts disabled are permitted.

## Inventory and boundaries

- Signed GitHub webhooks enter `agent/channels/github.ts`. Automatic reviews
  filter event kind, head freshness, pause state and paginated App review history;
  mentions permit explicit reassessment. Eve owns signature validation, session
  routing and durable dispatch. PR assistant-message delivery is suppressed.
- `agent/lib/github.ts` selects repository installation tokens with Octokit App
  auth; credentials must stay outside model context, sandbox and telemetry.
- The GitHub extension exposes review/read/file/comment capabilities. Formal
  review publication checks the signed current PR and current-turn assessment.
- Merge assessment is durable session state, scoped to policy version, turn,
  repository, PR and SHA. Direct merge checks reviews, labels, CI completeness,
  authorship and freshness, then pins the reviewed SHA. Auto-merge additionally
  requires stale-review dismissal and a current-head approval.
- Model routing has per-invocation cancellation/deadlines. Diagnostics retain
  metadata only. MCP allowlists constrain documentation/search tools. Optional
  sandbox compute stops when a session waits. Environment validation runs at
  module load. CI currently runs Vitest, types, lint and formatting.

## Findings before implementation

### F1 — stale installation identity survives repository installation changes

Medium impact, high confidence. `agent/lib/github.ts:installationFor` caches
`owner/repo -> installation ID` forever. After a repository's App installation
changes (for example removal and reinstallation), a warm process never reads the
current installation again. Once the old token expires, token creation continues
using the obsolete ID and fails until a process restart, despite a valid current
installation. Expected: token selection follows the repository's current
installation; actual: the first successful identity wins for process lifetime.
Remove the redundant identity cache and retain `@octokit/auth-app`'s native token
cache. A regression will resolve the same repository twice with different
installation responses and require the second token to use the current ID.

## Rejected hypotheses and known limits

- Duplicate review filtering is paginated and excludes pending/dismissed reviews;
  this is not a simultaneous-event lock. Existing docs explicitly acknowledge it.
- Read/write races and ambiguous remote writes are not exactly-once guarantees.
  SHA pinning protects direct merges; SDK review commit binding and native webhook
  idempotency remain upstream limitations already documented in
  `reliability-research.md`. No second persistent coordination layer is proposed.
- Incomplete CI, review history or authorship fails closed. Pending checks are
  allowed only for approval/queueing, not immediate merge.
- Model retry and deployment recovery concerns in the existing research are
  historical observations, not proof of a new current defect. No retry wrapper,
  timeout tuning, deployment or production data changes are justified here.

## Requested e2e framework

Inspected the actual npm `e2e@0.23.0` tarball (repository tester-army/e2e),
including bundled quickstart, CI, GitHub Actions, API testing, fixtures and engine
contracts. Node requirement is `^22.22.3 || >=24.8.0`; CI uses Node 24.
`api-testing.mdx` explicitly supports targets without an engine. Use that public
runner for signed webhook ingress through native Eve routing to session delivery,
including forged-signature rejection and completed-review suppression, with
controlled GitHub HTTP fixtures. No unrelated UI, model calls, or real credentials.
This establishes the protocol boundary, not semantic model judgment or durable
Workflow replay; existing Vitest merge/review/provider coverage remains intact.

### F2 — extension writes can cross the signed repository boundary

High impact, high confidence (independent review). The installed code-review
preset and explicit includes expose file, comment, PR metadata and label writes.
Only formal review publication has a target approval predicate. `githubToken`
accepts model-supplied owner/repo and can authenticate to other installations.
A prompt-injected repository A can therefore request a write to installed
repository B, contrary to the current-target trust boundary in coding standards.
Add native approval overrides to all enabled writes; compare their repository to
the signed invocation repository. Cross-repository reads remain available.
Comment IDs and file branches still require model judgment within that repository;
this change does not claim to bind every write to a particular PR or branch.

## Validation evidence

Independent review confirmed both runtime fixes and challenged the protocol/test
harness. CI run `42305447819` passed Vitest, type checking and the compile job.
Its F1 baseline reproduction passed; F2 correctly failed the new denial assertions
against the old permissive policy, but the evidence step expected the wrong error
text. The corrected proof pins baseline `007ed0a`, so later PR base changes do not
silently replace the defective version. Protocol CI exposed a missing compare-files
fixture; it is corrected without weakening the diff-delivery assertion. Latest
head still requires CI validation before merge. No local tests/builds were run.
