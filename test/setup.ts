import { generateKeyPairSync } from "node:crypto";

// `@/env` validates when first imported, so App credentials must exist before
// any test module loads the agent.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

process.env.GITHUB_APP_ID = "123";

process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

process.env.GITHUB_WEBHOOK_SECRET = "secret";
