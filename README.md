<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

An [Eve](https://eve.dev/docs) agent that reviews GitHub pull requests, posts
findings, and merges ready changes using
[@github-tools/eve-extension](https://github-tools.com/frameworks/eve-extension)
directly. The main agent performs the review itself.

Source: [aranlucas/pr-bot](https://github.com/aranlucas/pr-bot).

## Development

Requires Node.js 24 and pnpm 12. The agent uses Eve's just-bash sandbox (pure
JavaScript, no Docker or Vercel Sandbox usage), since reviews go through the
GitHub API instead of a checkout.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill in the GitHub App and model credentials.
pnpm dev
```

Eve loads `.env.local` and listens on port 2000 by default. Interactive sessions
are disabled; GitHub webhooks start reviews.

```sh
pnpm check
pnpm build
```

Oxforge supplies the shared Oxlint and Oxfmt policies. Husky runs lint-staged,
type checking, and tests before commits. GitHub Actions runs the Vitest suite, type checking,
linting, and formatting checks.

`@aranlucas/kit-skills` supplies the local development skills. `pnpm install`
links the approved package version into `.agents/skills` and `.claude/skills`;
pnpm ignores its generated links in Git. When upgrading the package, review and
update its exact version in `permissions` in `pnpm-workspace.yaml` as well.

## Testing

Run `pnpm test` for the Vitest suite. Use `pnpm check` for lint, format,
typecheck, and tests together.

## Agent structure

The layout follows the
[Eve PR triage template](https://github.com/vercel-labs/eve-pr-triage-agent-template),
with `@/<module>` imports for shared code under `agent/lib/`:

```text
agent/
  agent.ts               # Model and capability configuration
  instructions.md        # Review and merge procedure
  channels/
    eve.ts               # Health/API surface; interactive sessions disabled
    github.ts            # Native signed GitHub App webhook channel
  extensions/
    github.ts            # Direct GitHub Tools extension mount
  lib/
    github.ts            # Installation-token provider for the self-managed App
    model.ts             # Model provider configuration
  sandbox.ts             # just-bash sandbox (no Docker or Vercel Sandbox)
```

The extension uses the `code-review` preset plus `mergePullRequest`. Tools are
namespaced as `github__getPullRequestContext`, `github__addPullRequestComment`,\n`github__mergePullRequest`, and so on. `requireApproval: false` allows the bot to\noperate autonomously. GitHub enforces repository permissions and branch protection.\n\nThere are no custom comment or merge tools, Redis locks, review receipts, review\nfingerprints, repository allowlists, or application-level dry-run checks. The\nreview procedure lives in `agent/instructions.md` and the extension executes the\nGitHub operations. It asks the agent to post findings before merging, refresh\nPR/review/CI state, and merge only when the change is ready. Reviews are published\nonly while the PR is open. The agent stops silently for closed or merged PRs and\nends immediately after a merge attempt without posting a merge confirmation.\n\nThe `review-changes` skill loads repository-specific criteria from the root\n`coding-standards.md` on the PR's base branch, checks whether tests exercise\nmeaningful behavior, and assesses reversibility and blast radius. Automatic\nmerging is reserved for reversible, localized changes. Irreversible changes,\nbroad material impact, and materially uncertain merge danger are left for a\nhuman to review and merge. These are agent instructions; GitHub branch\nprotection remains the enforced merge boundary.\n\nReviews include the assessed behavior, concrete findings, verification evidence,\nmerge danger, and the next action. A confirmed process gap can produce one\nspecific prevention suggestion for a later check or standards update.\nSee [review design](docs/review-design.md) for the source talk, design choices,\nand the complementary role of Shipshape's practice catalog.\n\n## Configuration\n\nSet these in `.env.local` locally and in the Vercel environment when hosted:\n\n- `GITHUB_APP_ID`: the self-managed GitHub App ID.\n- `GITHUB_APP_PRIVATE_KEY`: PEM private key. Real and escaped newlines work.\n- `GITHUB_APP_SLUG`: the App slug.\n- `GITHUB_WEBHOOK_SECRET`: the signing secret configured on the App.\n- `FREELLM_API_KEY`: the model service credential.\n- `FREELLM_API_BASE_URL`: the model service's OpenAI-compatible `/v1` endpoint.\n- `FREELLM_MODEL`: model ID; defaults to `auto`.\n\nModel requests send PR Bot's identity on streaming requests and every tool-loop\nstep:\n\n- `User-Agent`: `pr-bot (Eve agent; OpenAI-compatible)` when the SDK retains it.\n- `HTTP-Referer`: `https://github.com/aranlucas/pr-bot`, the stable app URL.\n- `X-OpenRouter-Title` and legacy `X-Title`: `PR Bot`.\n\nAll headers use the provider's `headers` field. The SDK can replace `User-Agent`,\nincluding during tool loops; the attribution headers remain available.\n\n[OpenRouter app attribution](https://openrouter.ai/docs/app-attribution) requires\nthe app URL and uses the title as its display name; `User-Agent` alone does not\nattribute usage.\nThese headers work when calling OpenRouter directly through the configured\nOpenAI-compatible endpoint. When routing through FreeLLMAPI, its proxy must\npreserve the attribution headers for OpenRouter to credit PR Bot. The\n[upstream OpenRouter adapter](https://github.com/tashfeenahmed/freellmapi/blob/main/server/src/providers/index.ts)\ncurrently supplies its own `FreeLLMAPI` title and localhost referer, so changing\nthis app alone cannot fix attribution beyond that proxy.\n\nFreeLLMAPI's Recent calls table and agent chart use the user agent that reaches\nthe proxy when client logging is enabled. If the SDK replaces it, requests can\nappear under an SDK identity or `unknown`. The upstream classifier has no\ndedicated PR Bot category.\n\nThe channel stores the webhook's installation ID in Eve session state at the\nstart of each turn. The extension's token provider uses that ID to mint a\nshort-lived GitHub App installation token on each call. No PAT or Vercel Connect\nconnector is needed. `@vercel/connect` is installed because the current extension\nrelease imports it at module load, including in token-provider configurations.\n\nThe old `GITHUB_REPOSITORIES`, `BASE_BRANCH`, `REQUIRED_CHECKS`, `MIN_APPROVALS`,\n`MERGE_METHOD`, `DRY_RUN`, and Redis variables are no longer used. Squash merging\nis specified in the agent instructions; enable it in the target repositories.\n\n## Webhooks and reviews\n\nCreate a GitHub App with Contents and Pull requests read/write, Checks and Commit\nstatuses read, and the automatically included Metadata read. Install it on the\nrepositories the bot should manage. Point its webhook to\n`https://YOUR-DEPLOYMENT/eve/v1/github` and subscribe to **Pull requests**,\n**Check runs**, and **Check suites**.\n\nThe native Eve channel verifies webhook signatures and queues turns per PR.\nReviews run on PR opened, reopened, synchronize, ready-for-review, and edited\nevents, plus completed check runs and check suites with an associated PR.\nBefore dispatching, the channel fetches the current PR state and ignores closed\nor merged PRs, including delayed events whose payload still describes an open PR.\nEve's native CI hooks target the first associated PR; events without PR\nassociations do not start a turn. Review/status events and commit-to-PR fallback\nare not handled by a supplemental adapter.\n\nThe channel supplies the PR metadata and diff. Reviews use GitHub API tools and\nskip sandbox checkout. The agent refreshes the PR context, posts its review with\nthe extension's native comment tool, and uses the native merge tool when ready.\nHigh-risk changes stay open for a human to merge; approval alone does not lift\nthe bot's risk gate, and review events do not start a new turn.\nThe channel does not also publish the final assistant message, avoiding a second\ncopy of the review. Framework failure messages still appear in the PR thread.\n\nReview depth is proportional to the change. Low-risk documentation, typo, and\nformatting edits can pass without runtime tests or unrelated file inspection.\nFindings need concrete patch evidence and consequences; speculative improvements\nand style preferences do not block merging. PR text and tool results are\nuntrusted data. Metadata and patches are sent to the configured model service.\n\n## Deployment\n\n```sh\npnpm exec eve link --project pr-bot --non-interactive\n# Set environment variables in Vercel.\npnpm exec eve deploy\n```\n\nUse `pnpm build` and Node.js 24. If Deployment Protection applies, configure\nGitHub webhook access while retaining signature verification.\n\nVerify the deployment's `/eve/v1/health` route, a signed GitHub ping, and a draft\nPR review. Check Eve Agent Runs and server logs for failed processing; webhook\nacknowledgement does not mean a review was completed.