import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    CONTEXT7_API_KEY: z.string().min(1).optional(),
    FREELLM_API_BASE_URL: z.url().default("https://freellmapi-production-1175.up.railway.app/v1"),
    FREELLM_API_KEY: z.string().default(""),
    FREELLM_MODEL: z.string().min(1).default("auto"),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z
      .string()
      .min(1)
      .transform((key) => key.replaceAll(String.raw`\n`, "\n")),
  },
  runtimeEnv: process.env,
  // `eve build` evaluates agent modules; set this to build without App credentials.
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
  emptyStringAsUndefined: true,
});
