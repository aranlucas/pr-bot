import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "session.waiting"(_event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.stop();
    },
  },
});
