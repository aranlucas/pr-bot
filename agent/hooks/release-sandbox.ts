import { defineHook } from "eve/hooks";
import { env } from "@/env";

export default defineHook({
  events: {
    async "session.waiting"(_event, ctx) {
      if (env.SANDBOX_ENABLED !== true) {
        return;
      }

      const sandbox = await ctx.getSandbox();
      await sandbox.stop();
    },
  },
});
