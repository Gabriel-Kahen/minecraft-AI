import process from "node:process";
import { loadConfig } from "./config";
import { Orchestrator } from "./core";
import {
  BlueprintDesigner,
  PlannerRateLimiter,
  PlannerService,
  SchemaValidator,
  VertexGeminiClient
} from "./planner";
import { MetricsService } from "./observability";
import { ensureDir } from "./utils/fs";
import { JsonlLogger, SQLiteStore } from "./store";

const installLogGuards = (): void => {
  const originalWarn = console.warn.bind(console);
  const marker = "deprecated event (physicTick)";
  let suppressed = 0;
  let lastReportMs = Date.now();

  console.warn = (...args: unknown[]): void => {
    const rendered = args.map((value) => (typeof value === "string" ? value : String(value))).join(" ");
    if (rendered.includes(marker)) {
      suppressed += 1;
      const now = Date.now();
      if (now - lastReportMs >= 60000) {
        originalWarn(`[mc-orchestrator] suppressed ${suppressed} physicTick deprecation warnings in last minute`);
        suppressed = 0;
        lastReportMs = now;
      }
      return;
    }

    originalWarn(...args);
  };
};

const bootstrap = async (): Promise<void> => {
  installLogGuards();

  const config = loadConfig();

  ensureDir(config.DATA_DIR);
  ensureDir(config.BLUEPRINT_DIR);
  ensureDir(config.LOG_DIR);

  const store = new SQLiteStore(config.SQLITE_FILE);
  store.migrate();

  const logger = new JsonlLogger(config.LOG_DIR);
  const metrics = new MetricsService();
  metrics.start(config.METRICS_PORT);

  const validator = new SchemaValidator();
  const client = new VertexGeminiClient(
    config.GEMINI_PROJECT_ID,
    config.GEMINI_LOCATION,
    config.GEMINI_MODEL
  );
  const limiter = new PlannerRateLimiter(config.LLM_PER_BOT_HOURLY_CAP, config.LLM_GLOBAL_HOURLY_CAP);
  const planner = new PlannerService(client, validator, limiter, {
    timeoutMs: config.PLANNER_TIMEOUT_MS,
    maxRetries: config.PLANNER_MAX_RETRIES,
    mcVersion: config.MC_VERSION,
    basePosition: {
      x: config.BASE_X,
      y: config.BASE_Y,
      z: config.BASE_Z,
      radius: config.BASE_RADIUS
    }
  });
  const blueprintDesigner = new BlueprintDesigner(client, {
    timeoutMs: config.BLUEPRINT_TIMEOUT_MS,
    maxRetries: config.BLUEPRINT_MAX_RETRIES,
    outputDir: config.BLUEPRINT_DIR,
    maxBlocks: config.BLUEPRINT_MAX_BLOCKS,
    maxSpan: config.BLUEPRINT_MAX_SPAN,
    maxHeight: config.BLUEPRINT_MAX_HEIGHT
  });

  const orchestrator = new Orchestrator({
    config,
    planner,
    blueprintDesigner,
    store,
    logger,
    metrics
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await orchestrator.stop();
    metrics.stop();
    logger.close();
    store.close();
  };

  process.once("SIGINT", () => {
    stop().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    stop().finally(() => process.exit(0));
  });

  await orchestrator.start();
};

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
