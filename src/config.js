const fs = require("fs");
const { z } = require("zod");

const EnvSchema = z.object({
  MICROWORKERS_BASE_URL: z.string().url().default("https://www.microworkers.com"),
  MICROWORKERS_USERNAME: z.string().min(1).optional(),
  MICROWORKERS_PASSWORD: z.string().min(1).optional(),

  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
  OPENAI_CLASSIFY_TASKS: z.coerce.boolean().default(true),
  OPENAI_SKIP_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

  BROWSER_HEADLESS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  STORAGE_STATE_PATH: z.string().default("data/microworkers-storage-state.json"),

  STREAM_PORT: z.coerce.number().int().positive().optional(),
  PORT: z.coerce.number().int().positive().optional(),

  MAX_TASKS_PER_RUN: z.coerce.number().int().positive().default(5),

  // If true, we pause when the flow isn't understood instead of trying risky guesses.
  SAFE_MANUAL_PAUSE: z.coerce.boolean().default(false),
});

function loadConfigFromEnv() {
  const cfg = EnvSchema.parse(process.env);
  const resolvedStoragePath = cfg.STORAGE_STATE_PATH;
  const storageDir = resolvedStoragePath.split("/").slice(0, -1).join("/");
  if (!fs.existsSync(storageDir) && storageDir !== "") {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  const streamPort = cfg.STREAM_PORT ?? cfg.PORT ?? 3000;
  return { ...cfg, STORAGE_STATE_PATH: resolvedStoragePath, STREAM_PORT: streamPort };
}

module.exports = { loadConfigFromEnv };

