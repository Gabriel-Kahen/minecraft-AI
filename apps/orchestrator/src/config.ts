import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MC_HOST: z.string().min(1),
  MC_PORT: z.coerce.number().int().min(1).max(65535).default(25565),
  MC_VERSION: z.string().default("1.20.4"),
  MC_OFFLINE_MODE: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  BOT_COUNT: z.coerce.number().int().min(1).max(5).default(3),
  BOT_USERNAME_PREFIX: z.string().default("pi-bot"),
  BOT_PASSWORD: z.string().optional().default(""),
  ORCH_TICK_MS: z.coerce.number().int().min(50).default(50),
  SNAPSHOT_REFRESH_MS: z.coerce.number().int().min(1000).default(5000),
  SNAPSHOT_NEARBY_CACHE_MS: z.coerce.number().int().min(0).default(2500),
  SNAPSHOT_NEARBY_RESCAN_DISTANCE: z.coerce.number().min(0).default(4),
  BOT_START_STAGGER_MS: z.coerce.number().int().min(0).default(400),
  RECONNECT_BASE_DELAY_MS: z.coerce.number().int().min(1000).default(2500),
  RECONNECT_JITTER_MS: z.coerce.number().int().min(0).default(1200),
  MAX_CONCURRENT_SKILLS: z.coerce.number().int().min(1).max(5).default(4),
  ALWAYS_ACTIVE_MODE: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  ALWAYS_ACTIVE_REQUEUE_MS: z.coerce.number().int().min(100).default(120),
  SUBGOAL_EXEC_TIMEOUT_MS: z.coerce.number().int().min(5000).default(180000),
  SUBGOAL_IDLE_STALL_MS: z.coerce.number().int().min(1000).default(5000),
  SUBGOAL_RETRY_LIMIT: z.coerce.number().int().min(0).max(20).default(8),
  SUBGOAL_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(60),
  SUBGOAL_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(100).default(500),
  SUBGOAL_LOOP_GUARD_REPEATS: z.coerce.number().int().min(2).max(50).default(8),
  SUBGOAL_FAILURE_STREAK_WINDOW_MS: z.coerce.number().int().min(10000).default(180000),
  CHAT_STATUS_ENABLED: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  CHAT_STATUS_INTERVAL_MS: z.coerce.number().int().min(5000).default(45000),
  CHAT_TASK_EVENTS_ENABLED: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  CHAT_TASK_EVENT_MIN_MS: z.coerce.number().int().min(250).default(3500),
  CHAT_MIN_INTERVAL_MS: z.coerce.number().int().min(250).default(5000),
  CHAT_DUPLICATE_WINDOW_MS: z.coerce.number().int().min(1000).default(30000),
  CHAT_INCLUDE_STEPS: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, false)),
  LLM_HISTORY_LIMIT: z.coerce.number().int().min(1).max(30).default(20),
  PLANNER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(3000),
  PLANNER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(0),
  PLANNER_FEASIBILITY_REPROMPT_ENABLED: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  PLANNER_FEASIBILITY_REPROMPT_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
  GEMINI_PROJECT_ID: z.string().min(1),
  GEMINI_LOCATION: z.string().default("us-central1"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash-lite"),
  LLM_PER_BOT_HOURLY_CAP: z.coerce.number().int().min(1).default(24),
  LLM_GLOBAL_HOURLY_CAP: z.coerce.number().int().min(1).default(90),
  DATA_DIR: z.string().default("./data"),
  BLUEPRINT_DIR: z.string().default("./data/blueprints"),
  BLUEPRINT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(7000),
  BLUEPRINT_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  BLUEPRINT_MAX_BLOCKS: z.coerce.number().int().min(1).max(2000).default(300),
  BLUEPRINT_MAX_SPAN: z.coerce.number().int().min(4).max(64).default(24),
  BLUEPRINT_MAX_HEIGHT: z.coerce.number().int().min(3).max(64).default(12),
  SQLITE_FILE: z.string().default("./data/state.sqlite"),
  LOG_DIR: z.string().default("./data/logs"),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  DEBUG_VIEWER: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, false)),
  VIEWER_PORT_BASE: z.coerce.number().int().min(1).max(65535).default(3007),
  WEB_INVENTORY_ENABLED: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, false)),
  WEB_INVENTORY_PORT_BASE: z.coerce.number().int().min(1).max(65535).default(4100),
  BLOODHOUND_ENABLED: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  TPS_PLUGIN_ENABLED: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  MAX_CONCURRENT_EXPLORERS: z.coerce.number().int().min(1).max(5).default(2),
  LOCK_LEASE_MS: z.coerce.number().int().min(1000).default(45000),
  LOCK_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(12000),
  PLANNER_COOLDOWN_MS: z.coerce.number().int().min(250).default(750),
  PLAN_PREFETCH_ENABLED: z
    .unknown()
    .optional()
    .transform((value) => parseBoolean(value, true)),
  PLAN_PREFETCH_MIN_INTERVAL_MS: z.coerce.number().int().min(100).default(2500),
  PLAN_PREFETCH_MAX_AGE_MS: z.coerce.number().int().min(1000).default(30000),
  PLAN_PREFETCH_RESERVE_CALLS: z.coerce.number().int().min(0).default(4),
  BASE_X: z.coerce.number().default(0),
  BASE_Y: z.coerce.number().default(64),
  BASE_Z: z.coerce.number().default(0),
  BASE_RADIUS: z.coerce.number().int().min(1).default(16)
});

export type AppConfig = z.infer<typeof envSchema>;

interface LoadConfigOptions {
  configPath?: string;
}

const readYamlConfig = (configPath?: string): Record<string, unknown> => {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8");
  if (!raw.trim()) {
    return {};
  }

  const parsed = parseYaml(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid config yaml at ${configPath}: expected top-level mapping`);
  }
  return parsed as Record<string, unknown>;
};

export const loadConfig = (options?: LoadConfigOptions): AppConfig => {
  const yamlConfig = readYamlConfig(options?.configPath);
  const merged = {
    ...yamlConfig,
    ...process.env
  };
  return envSchema.parse(merged);
};
