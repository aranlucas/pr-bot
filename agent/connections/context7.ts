import { defineMcpClientConnection } from "eve/connections";
import { env } from "@/env";

export default defineMcpClientConnection({
  url: "https://mcp.context7.com/mcp",
  description:
    "Context7: discover existing library APIs and verify version-specific behavior using documentation and examples.",
  auth: {
    getToken: () => {
      if (!env.CONTEXT7_API_KEY) {
        throw new Error("CONTEXT7_API_KEY is required for library documentation lookup");
      }

      return Promise.resolve({ token: env.CONTEXT7_API_KEY });
    },
  },
  tools: { allow: ["resolve-library-id", "query-docs"] },
});
