import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./agent/lib", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
