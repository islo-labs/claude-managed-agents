import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const configSchema = z.object({
  ENVIRONMENT_ID: z.string().min(1),
  ANTHROPIC_ENVIRONMENT_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ISLO_API_KEY: z.string().min(1),
  ISLO_API_BASE_URL: z.string().url(),
  ISLO_GATEWAY_PROFILE: optionalNonEmptyString,
  ISLO_RUNNER_IMAGE: z.string().default("ghcr.io/islo-labs/islo-runner:latest"),
  ISLO_SANDBOX_CPUS: z.coerce.number().int().positive().default(2),
  ISLO_SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(4096),
  ISLO_SANDBOX_DISK_GB: z.coerce.number().int().positive().default(20),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default("./data/sessions.db"),
  ADMIN_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(16).optional(),
  ),
  WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  cached = configSchema.parse(env);
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
