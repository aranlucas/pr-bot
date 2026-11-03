import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./agent/lib", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    server: {
      deps: { inline: ["@github-tools/sdk", "@github-tools/eve-extension"] },
    },
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
