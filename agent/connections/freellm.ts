import { defineMcpClientConnection } from "eve/connections";
import { env } from "@/env";

export default defineMcpClientConnection({
  url: new URL("/mcp", env.FREELLM_API_BASE_URL).href,
  description:
    "FreeLLMAPI web search: find public documentation, release notes, and upstream issues with source URLs and short extracts.",
  // FreeLLMAPI implements initialize, but not server/discover.
  protocolVersionDiscovery: false,
  auth: {
    getToken: () => Promise.resolve({ token: env.FREELLM_API_KEY }),
  },
  tools: { allow: ["web_search"] },
});
