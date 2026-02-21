import type { AppConfig } from "../config";
import type { MetricsService } from "../observability";
import { makeId } from "../utils/id";
import { nowIso, sleep } from "../utils/time";
import type { JsonlLogger, SQLiteStore } from "../store";
import {
  ExplorerLimiter,
  LockManager,
  SkillLimiter
} from "../coordination";
import { SkillEngine } from "../skills";
import { BotController, type BotControllerDependencies } from "./bot-controller";
import type { BlueprintDesigner, PlannerService } from "../planner";

export interface OrchestratorDependencies {
  config: AppConfig;
  planner: PlannerService;
  blueprintDesigner: BlueprintDesigner;
  store: SQLiteStore;
  logger: JsonlLogger;
  metrics: MetricsService;
}

export class Orchestrator {
  private readonly deps: OrchestratorDependencies;

  private readonly controllers: BotController[] = [];

  private readonly lockManager: LockManager;

  private readonly explorerLimiter: ExplorerLimiter;

  private readonly skillEngine: SkillEngine;

  private readonly skillLimiter: SkillLimiter;

  private activeGaugeTimer: NodeJS.Timeout | null = null;

  private chatStatusTimer: NodeJS.Timeout | null = null;

  constructor(deps: OrchestratorDependencies) {
    this.deps = deps;
    this.lockManager = new LockManager(deps.store, deps.config.LOCK_LEASE_MS);
    this.explorerLimiter = new ExplorerLimiter(deps.config.MAX_CONCURRENT_EXPLORERS);
    this.skillLimiter = new SkillLimiter(deps.config.MAX_CONCURRENT_SKILLS);
    this.skillEngine = new SkillEngine();
  }

  async start(): Promise<void> {
    const runId = makeId("run");
    this.deps.store.insertRun(runId, nowIso(), {
      bot_count: this.deps.config.BOT_COUNT,
      minecraft_version: this.deps.config.MC_VERSION,
      host: this.deps.config.MC_HOST,
      planner_model: this.deps.config.GEMINI_MODEL
    });

    const shared: Omit<BotControllerDependencies, "blueprintRoot"> = {
      config: this.deps.config,
      planner: this.deps.planner,
      blueprintDesigner: this.deps.blueprintDesigner,
      store: this.deps.store,
      logger: this.deps.logger,
      metrics: this.deps.metrics,
      lockManager: this.lockManager,
      explorerLimiter: this.explorerLimiter,
      skillLimiter: this.skillLimiter,
      skillEngine: this.skillEngine
    };

    for (let index = 0; index < this.deps.config.BOT_COUNT; index += 1) {
      const botId = `${this.deps.config.BOT_USERNAME_PREFIX}-${index + 1}`;
      const controller = new BotController(botId, {
        ...shared,
        blueprintRoot: this.deps.config.BLUEPRINT_DIR
      });
      this.controllers.push(controller);

      await controller.start();
      await sleep(this.deps.config.BOT_START_STAGGER_MS);
    }

    this.activeGaugeTimer = setInterval(() => {
      const active = this.controllers.filter((controller) => controller.isConnected()).length;
      this.deps.metrics.setActiveBots(active);
    }, 2500);
    this.activeGaugeTimer.unref();

    if (this.deps.config.CHAT_STATUS_ENABLED) {
      this.chatStatusTimer = setInterval(() => {
        this.broadcastTaskStatus();
      }, this.deps.config.CHAT_STATUS_INTERVAL_MS);
      this.chatStatusTimer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.activeGaugeTimer) {
      clearInterval(this.activeGaugeTimer);
      this.activeGaugeTimer = null;
    }
    if (this.chatStatusTimer) {
      clearInterval(this.chatStatusTimer);
      this.chatStatusTimer = null;
    }

    for (const controller of this.controllers) {
      await controller.stop();
    }

    this.controllers.length = 0;
  }

  private broadcastTaskStatus(): void {
    const speaker = this.controllers.find((controller) => controller.canChat());
    if (!speaker) {
      this.deps.logger.write("orchestrator", {
        ts: nowIso(),
        type: "CHAT_STATUS_SKIPPED",
        payload: { reason: "no_connected_speaker" }
      });
      return;
    }

    const connected = this.controllers.filter((controller) => controller.isConnected()).length;
    const lines = [
      `[tasks] connected ${connected}/${this.controllers.length}`,
      ...this.controllers.map((controller) => `[task] ${controller.id} ${controller.taskSummary()}`.slice(0, 240))
    ];
    for (const line of lines) {
      speaker.chat(line);
    }
    this.deps.logger.write("orchestrator", {
      ts: nowIso(),
      botId: speaker.id,
      type: "CHAT_STATUS_SENT",
      payload: { lines }
    });
  }
}
