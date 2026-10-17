import { generateKeyPairSync } from "node:crypto";

// dotenvx loads the public fixtures from .env.test. Generate an RSA key before
// any test module loads the agent so GitHub App authentication stays under test.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
