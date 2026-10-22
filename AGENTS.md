# Agent guidance

Read `README.md` for the agent's structure and `coding-standards.md` for the
review criteria that also apply to changes here.

## Scripts: native first

Before adding a script file (`scripts/`, `bin/`, `tools/`, root `*.sh|*.py|*.mjs`) or a package script that runs one, take the first rung that works:

1. A flag or subcommand of a tool the repo already uses (`<tool> --help`).
2. Declarative config for that tool (`tsconfig.json`, `vitest.config.ts`, `.oxlintrc.json`, `oxfmt.config.ts`, `pnpm-workspace.yaml`).
3. A maintained plugin for that tool.
4. A one-line package.json script that calls a native command.
5. A test in the existing runner (Vitest), for anything that asserts.
6. A custom script, only for behavior specific to this repo. Its first comment names the native rung it couldn't use and why. It has a test in the existing runner, and the PR that adds it quotes that comment.

## Code: libraries first

Before hand-writing general-purpose code, use a well-maintained library: actively released, widely adopted, typed, and a fit for this stack. Reach for one already in the dependencies first. Write custom code for domain logic and for the glue no library covers. A PR that adds a dependency says why it was picked; a PR that hand-writes something a library covers names the library and why it didn't fit.

- GitHub capabilities → `@github-tools/eve-extension` and `@github-tools/sdk`.
- GitHub App authentication → `@octokit/auth-app` `createAppAuth`.
- Runtime and environment validation → `zod` and `@t3-oss/env-core`.

Prefer the GitHub Tools extension over authoring tools. To give the agent a new
GitHub capability, enable it in `agent/extensions/github.ts` with a `preset`,
`include`, or `exclude` before writing anything custom. Check the presets and
tool names in the installed `@github-tools/sdk` (shipped with
`@github-tools/eve-extension`). Use `exclude` to narrow a preset that brings in
tools the bot must not have.

Write a custom tool, sandbox command, or GitHub wrapper only when no extension
tool can do the job, and state that missing capability in the PR.
