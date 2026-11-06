import type { E2EConfig } from "e2e";

export default {
  targets: [{ name: "github-protocol", platform: "api" }],
  tests: "e2e/**/*.e2e.ts",
  workers: 1,
  retries: 0,
  reporters: ["list", "junit"],
} satisfies E2EConfig;
