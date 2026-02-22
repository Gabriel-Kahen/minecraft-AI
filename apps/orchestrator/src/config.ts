import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MC_HOST: z.string().min(1),
  MC_PORT: z.coerce.number().int().min(1).max(65535).default(25565),
  MC_VERSION: z.string().default("1.20.4"),
  MC_OFFLINE_MODE: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  BOT_COUNT: z.coerce.number().int().min(1).max(5).default(4),
  BOT_USERNAME_PREFIX: z.string().default("pi-bot"),
  BOT_PASSWORD: z.string().optional().default(""),
  ORCH_TICK_MS: z.coerce.number().int().min(100).default(1000),
  SNAPSHOT_REFRESH_MS: z.coerce.number().int().min(1000).default(5000),
  SNAPSHOT_NEARBY_CACHE_MS: z.coerce.number().int().min(0).default(2500),
  SNAPSHOT_NEARBY_RESCAN_DISTANCE: z.coerce.number().min(0).default(4),
  BOT_START_STAGGER_MS: z.coerce.number().int().min(0).default(2500),
  RECONNECT_BASE_DELAY_MS: z.coerce.number().int().min(1000).default(12000),
  RECONNECT_JITTER_MS: z.coerce.number().int().min(0).default(8000),
  MAX_CONCURRENT_SKILLS: z.coerce.number().int().min(1).max(5).default(4),
  ALWAYS_ACTIVE_MODE: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  ALWAYS_ACTIVE_REQUEUE_MS: z.coerce.number().int().min(500).default(2500),
  SUBGOAL_EXEC_TIMEOUT_MS: z.coerce.number().int().min(5000).default(75000),
  SUBGOAL_RETRY_LIMIT: z.coerce.number().int().min(0).max(8).default(4),
  SUBGOAL_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(400),
  SUBGOAL_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(250).default(1800),
  CHAT_STATUS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  CHAT_STATUS_INTERVAL_MS: z.coerce.number().int().min(5000).default(10000),
  CHAT_TASK_EVENTS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  CHAT_TASK_EVENT_MIN_MS: z.coerce.number().int().min(250).default(1200),
  LLM_HISTORY_LIMIT: z.coerce.number().int().min(1).max(30).default(20),
  PLANNER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(6000),
  PLANNER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
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
    .string()
    .optional()
    .transform((value) => value === "true"),
  VIEWER_PORT_BASE: z.coerce.number().int().min(1).max(65535).default(3007),
  MAX_CONCURRENT_EXPLORERS: z.coerce.number().int().min(1).max(5).default(2),
  LOCK_LEASE_MS: z.coerce.number().int().min(1000).default(45000),
  LOCK_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(12000),
  PLANNER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(10000),
  BASE_X: z.coerce.number().default(0),
  BASE_Y: z.coerce.number().default(64),
  BASE_Z: z.coerce.number().default(0),
  BASE_RADIUS: z.coerce.number().int().min(1).default(16)
});

export type AppConfig = z.infer<typeof envSchema>;

export const loadConfig = (): AppConfig => envSchema.parse(process.env);
