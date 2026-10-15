import type { Snapshot } from "@/github";

export const snapshot = (): Snapshot => ({
  head: "head-sha",
  base: "base-sha",
  baseBranch: "main",
  defaultBranch: "main",
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  mergeableState: "clean",
  labels: ["agent:merge"],
  title: "Fix edge case",
  body: "",
  author: "author",
  checks: [{ name: "test", success: true }],
  approvals: ["reviewer"],
  changesRequested: false,
  completeDiff: true,
  files: [{ path: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }],
});
