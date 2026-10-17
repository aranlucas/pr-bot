import { z } from "zod";

export const env = z
  .object({
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
  })
  .parse(
    Object.fromEntries(
      Object.entries(process.env).map(([key, value]) => [key, value === "" ? undefined : value]),
    ),
  );
