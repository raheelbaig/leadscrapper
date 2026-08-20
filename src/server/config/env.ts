import "server-only";

import { z } from "zod";

/**
 * The single place in the application that reads secrets from the environment.
 *
 * Nothing outside `src/server/**` may import this module, and no secret here
 * carries a NEXT_PUBLIC_ prefix, so none of it can be bundled into the browser.
 * Validation happens at first access and fails loudly: a missing Google key
 * should stop the process, not surface later as a confusing 400 from Google.
 */
const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  GOOGLE_MAPS_API_KEY: z.string().min(1),

  WORKER_SECRET: z.string().min(16, "WORKER_SECRET must be at least 16 characters"),
  WORKER_SLICE_MS: z.coerce.number().int().min(1_000).max(280_000).default(25_000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(90),
  WORKER_MAX_TILES_PER_TICK: z.coerce.number().int().min(1).max(500).default(25),
  WORKER_SELF_CHAIN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid server environment configuration:\n${issues}\n\n` +
        `Copy .env.example to .env.local and fill in the missing values.`,
    );
  }

  cached = parsed.data;
  return cached;
}
