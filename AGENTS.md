# Agent guidance

Read `README.md` for the agent's structure and `coding-standards.md` for the
review criteria that also apply to changes here.

## GitHub capabilities

Prefer the GitHub Tools extension over authoring tools. To give the agent a new
GitHub capability, enable it in `agent/extensions/github.ts` with a `preset`,
`include`, or `exclude` before writing anything custom. Check the presets and
tool names in the installed `@github-tools/sdk` (shipped with
`@github-tools/eve-extension`). Use `exclude` to narrow a preset that brings in
tools the bot must not have.

Write a custom tool, sandbox command, or GitHub wrapper only when no extension
tool can do the job, and state that missing capability in the PR.
