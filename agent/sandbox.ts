import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

// Vercel Sandbox supports the network policy the GitHub channel's checkout
// needs and runs native binaries such as oxfmt.
export const environment = VercelSandbox.environment();

export default defineSandbox(() => environment.open());
