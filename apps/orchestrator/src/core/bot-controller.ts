import type { ActionHistoryEntry, PlannerRequestV1, PlannerSubgoal } from "../../../../contracts/planner";
import type { SnapshotV1 } from "../../../../contracts/snapshot";
import {
  SUBGOAL_NAMES,
  type FailureCode,
  type SkillResultV1,
  type SubgoalName
} from "../../../../contracts/skills";
import type { MetricsService } from "../observability";
import { buildSnapshot, loadMineflayerPlugins } from "../bots";
import type { ExplorerLimiter, LockManager, SkillLimiter } from "../coordination";
import { ActionHistoryBuffer } from "./history-buffer";
import type { PlannerTrigger, RuntimeSubgoal, RuntimeTaskState } from "./types";
import type { BlueprintDesigner, PlannerService } from "../planner";
import { nowIso } from "../utils/time";
import { makeId } from "../utils/id";
import type { SQLiteStore, JsonlLogger } from "../store";
import { ReflexManager } from "../reflex";
import { SkillEngine } from "../skills";
import type { AppConfig } from "../config";

const formatDisconnectReason = (reason: unknown): string => {
  if (typeof reason === "string") {
    return reason;
  }

  try {
    const json = JSON.stringify(reason);
    return json ?? String(reason);
  } catch {
    return String(reason);
  }
};

export interface BotControllerDependencies {
  config: AppConfig;
  planner: PlannerService;
  store: SQLiteStore;
  logger: JsonlLogger;
  metrics: MetricsService;
  lockManager: LockManager;
  explorerLimiter: ExplorerLimiter;
  skillLimiter: SkillLimiter;
  skillEngine: SkillEngine;
  blueprintRoot: string;
  blueprintDesigner: BlueprintDesigner;
}

export class BotController {
  private readonly botId: string;

  private readonly deps: BotControllerDependencies;

  private readonly history: ActionHistoryBuffer;

  private readonly taskState: RuntimeTaskState;

  private readonly reflexManager: ReflexManager;

  private bot: any | null = null;

  private loopTimer: NodeJS.Timeout | null = null;

  private connected = false;

  private stopped = false;

  private reconnectPending = false;

  private lastPlanAt = 0;

  private plannerInFlight = false;

  private lastSnapshot: SnapshotV1 | null = null;

  private lastSnapshotAtMs = 0;

  private disconnectStreak = 0;

  constructor(botId: string, deps: BotControllerDependencies) {
    this.botId = botId;
    this.deps = deps;
    this.history = new ActionHistoryBuffer(deps.config.LLM_HISTORY_LIMIT);
    this.taskState = {
      currentGoal: null,
      currentSubgoal: null,
      queue: [],
      progressCounters: {},
      lastError: null,
      busy: false,
      plannerCooldownUntil: 0,
      pendingTriggers: ["IDLE"],
      history: []
    };
    this.reflexManager = new ReflexManager({
      x: deps.config.BASE_X,
      y: deps.config.BASE_Y,
      z: deps.config.BASE_Z,
      radius: deps.config.BASE_RADIUS
    });
  }

  get id(): string {
    return this.botId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.deps.store.upsertBot(this.botId, nowIso());
    await this.connect();

    this.loopTimer = setInterval(() => {
      this.tick().catch((error) => {
        this.log("INCIDENT", {
          category: "loop",
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.deps.config.ORCH_TICK_MS);
    this.loopTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }

    this.reflexManager.detach();

    if (this.bot) {
      try {
        this.bot.quit("orchestrator shutdown");
      } catch {
        // ignore
      }
      this.bot = null;
    }

    this.connected = false;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.reconnectPending || this.connected) {
      return;
    }

    const mineflayer = require("mineflayer");
    const username = this.botId;

    const bot = mineflayer.createBot({
      host: this.deps.config.MC_HOST,
      port: this.deps.config.MC_PORT,
      username,
      password: this.deps.config.BOT_PASSWORD || undefined,
      version: this.deps.config.MC_VERSION,
      auth: this.deps.config.MC_OFFLINE_MODE ? "offline" : "microsoft"
    });

    this.bot = bot;
    loadMineflayerPlugins(bot, {
      debugViewer: this.deps.config.DEBUG_VIEWER,
      viewerPort: this.deps.config.VIEWER_PORT_BASE + Number(this.botId.split("-").at(-1) ?? 0)
    });

    bot.once("spawn", () => {
      if (this.bot !== bot || this.stopped) {
        return;
      }
      this.connected = true;
      this.disconnectStreak = 0;
      this.log("CONNECTED", {});
      this.reflexManager.attach(bot, {
        isBusy: () => this.taskState.busy,
        onTrigger: (trigger, details) => this.pushTrigger(trigger, details)
      });
    });

    bot.on("error", (error: unknown) => {
      if (this.bot !== bot || this.stopped) {
        return;
      }
      this.log("INCIDENT", {
        category: "bot_error",
        error: error instanceof Error ? error.message : String(error)
      });
    });

    bot.on("kicked", (reason: unknown) => {
      if (this.bot !== bot || this.stopped) {
        return;
      }
      const formatted = formatDisconnectReason(reason);
      this.log("DISCONNECTED", {
        reason: formatted
      });
      this.scheduleReconnect(bot, "kicked", formatted);
    });

    bot.on("end", () => {
      if (this.bot !== bot || this.stopped) {
        return;
      }
      this.log("DISCONNECTED", {
        reason: "connection_end"
      });
      this.scheduleReconnect(bot, "end");
    });

    bot.on("death", () => {
      if (this.bot !== bot || this.stopped) {
        return;
      }
      this.taskState.queue = [];
      this.taskState.currentSubgoal = null;
      this.taskState.currentGoal = "recover_from_death";
      this.taskState.busy = false;
    });
  }

  private scheduleReconnect(sourceBot: any, reason: "kicked" | "end", detail?: string): void {
    if (this.reconnectPending || this.stopped || this.bot !== sourceBot) {
      return;
    }

    this.disconnectStreak += 1;
    this.connected = false;
    this.reconnectPending = true;
    this.taskState.busy = false;
    this.taskState.queue = [];
    this.taskState.currentSubgoal = null;
    this.pushTrigger("RECONNECT", { reason: `scheduled_${reason}` });
    this.deps.metrics.recordReconnect(this.botId);
    const timeoutRelated = detail?.includes("disconnect.timeout") || detail?.includes("Timed out");
    const streakPenaltyMs = Math.min(this.disconnectStreak, 6) * (timeoutRelated ? 6000 : 3000);
    const delayMs =
      this.deps.config.RECONNECT_BASE_DELAY_MS +
      Math.floor(Math.random() * this.deps.config.RECONNECT_JITTER_MS) +
      streakPenaltyMs;

    setTimeout(() => {
      if (this.stopped) {
        this.reconnectPending = false;
        return;
      }

      if (this.bot !== sourceBot) {
        this.reconnectPending = false;
        return;
      }

      this.reflexManager.detach();
      try {
        sourceBot.removeAllListeners();
        sourceBot.quit("reconnect");
      } catch {
        // ignore cleanup errors
      }
      this.bot = null;
      this.reconnectPending = false;
      this.connect().catch((error) => {
        this.log("INCIDENT", {
          category: "reconnect",
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, delayMs).unref();
  }

  private pushTrigger(trigger: PlannerTrigger, details: Record<string, unknown>): void {
    if (!this.taskState.pendingTriggers.includes(trigger)) {
      this.taskState.pendingTriggers.push(trigger);
    }

    if (trigger === "DEATH" || trigger === "STUCK") {
      this.taskState.queue = [];
    }

    this.log("INTERRUPT", {
      trigger,
      details
    });
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.bot || !this.connected) {
      return;
    }

    const now = Date.now();
    const snapshot = this.refreshSnapshot(now, false);
    if (!snapshot) {
      return;
    }

    if (this.taskState.busy) {
      return;
    }

    if (this.taskState.queue.length > 0) {
      await this.executeNextSubgoal();
      return;
    }

    if (now - this.lastPlanAt > 10000 && !this.taskState.pendingTriggers.includes("IDLE")) {
      this.taskState.pendingTriggers.push("IDLE");
    }

    const shouldPlan =
      this.taskState.pendingTriggers.length > 0 && now >= this.taskState.plannerCooldownUntil;

    if (shouldPlan && !this.plannerInFlight) {
      const freshSnapshot = this.refreshSnapshot(Date.now(), true);
      if (!freshSnapshot) {
        return;
      }
      await this.requestPlan(freshSnapshot);
    }
  }

  private refreshSnapshot(nowMs: number, force: boolean): SnapshotV1 | null {
    if (
      !force &&
      this.lastSnapshot &&
      nowMs - this.lastSnapshotAtMs < this.deps.config.SNAPSHOT_REFRESH_MS
    ) {
      return this.lastSnapshot;
    }

    if (!this.bot) {
      return null;
    }

    try {
      const snapshot = buildSnapshot(this.bot, this.botId, this.taskState);
      this.lastSnapshot = snapshot;
      this.lastSnapshotAtMs = nowMs;
      this.deps.store.upsertBotSnapshot(this.botId, snapshot, nowIso());
      return snapshot;
    } catch (error) {
      this.log("INCIDENT", {
        category: "snapshot",
        error: error instanceof Error ? error.message : String(error)
      });
      return this.lastSnapshot;
    }
  }

  private async requestPlan(snapshot: ReturnType<typeof buildSnapshot>): Promise<void> {
    this.plannerInFlight = true;
    const startedAtMs = Date.now();
    const startedAt = nowIso();
    const request: PlannerRequestV1 = {
      bot_id: this.botId,
      snapshot,
      history: this.history.snapshot(),
      available_subgoals: [...SUBGOAL_NAMES]
    };

    try {
      this.log("PLANNER_CALLED", {
        triggers: this.taskState.pendingTriggers,
        queue_size: this.taskState.queue.length
      });

      const outcome = await this.deps.planner.plan(request);
      const endedAt = nowIso();
      const durationMs = Date.now() - startedAtMs;

      this.deps.store.insertPlannerCall({
        id: makeId("llm"),
        botId: this.botId,
        startedAt,
        endedAt,
        durationMs,
        status: outcome.status,
        model: this.deps.config.GEMINI_MODEL,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut
      });

      this.deps.metrics.recordLlmCall(this.botId, outcome.status);
      this.taskState.currentGoal = outcome.response.next_goal;
      const materializedSubgoals = await this.materializeBuildSubgoals(
        snapshot,
        outcome.response.next_goal,
        outcome.response.subgoals
      );
      this.taskState.queue = materializedSubgoals.map((subgoal) => this.runtimeSubgoal(subgoal));
      this.taskState.pendingTriggers = [];
      this.lastPlanAt = Date.now();

      if (outcome.status !== "SUCCESS") {
        this.log("PLANNER_FALLBACK", {
          status: outcome.status,
          next_goal: outcome.response.next_goal
        });
      }

      if (this.taskState.queue.length === 0) {
        this.taskState.pendingTriggers.push("IDLE");
      }
    } catch (error) {
      this.taskState.plannerCooldownUntil = Date.now() + this.deps.config.PLANNER_COOLDOWN_MS;
      this.taskState.pendingTriggers = ["SUBGOAL_FAILED"];
      this.deps.metrics.recordLlmCall(this.botId, "ERROR");
      this.log("INCIDENT", {
        category: "planner_error",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.plannerInFlight = false;
    }
  }

  private async executeNextSubgoal(): Promise<void> {
    if (!this.deps.skillLimiter.tryEnter(this.botId)) {
      return;
    }

    const subgoal = this.taskState.queue.shift();
    if (!subgoal || !this.bot) {
      this.deps.skillLimiter.leave(this.botId);
      return;
    }

    this.taskState.busy = true;
    this.taskState.currentSubgoal = subgoal;
    const startedAtMs = Date.now();
    const startedAt = nowIso();

    this.log("SUBGOAL_STARTED", {
      subgoal: subgoal.name,
      params: subgoal.params
    });

    try {
      const result = await this.deps.skillEngine.execute(
        {
          botId: this.botId,
          bot: this.bot,
          lockManager: this.deps.lockManager,
          explorerLimiter: this.deps.explorerLimiter,
          logger: this.deps.logger,
          base: {
            x: this.deps.config.BASE_X,
            y: this.deps.config.BASE_Y,
            z: this.deps.config.BASE_Z,
            radius: this.deps.config.BASE_RADIUS
          },
          lockHeartbeatMs: this.deps.config.LOCK_HEARTBEAT_MS,
          blueprintRoot: this.deps.blueprintRoot
        },
        subgoal
      );

      const endedAt = nowIso();
      const durationMs = Date.now() - startedAtMs;
      this.deps.metrics.recordSubgoal(this.botId, subgoal.name, result.outcome, durationMs);

      const historyEntry: ActionHistoryEntry = {
        timestamp: endedAt,
        subgoal_name: subgoal.name as SubgoalName,
        params: subgoal.params,
        outcome: result.outcome,
        error_code: result.outcome === "FAILURE" ? (result.errorCode as FailureCode) : null,
        error_details: result.outcome === "FAILURE" ? result.details : null,
        duration_ms: durationMs
      };

      this.history.add(historyEntry);
      this.taskState.history = this.history.snapshot();

      this.deps.store.insertSubgoalAttempt({
        id: subgoal.id,
        botId: this.botId,
        subgoal: subgoal.name,
        startedAt,
        endedAt,
        durationMs,
        result
      });

      if (result.outcome === "FAILURE") {
        this.taskState.lastError = {
          code: result.errorCode,
          details: result.details
        };
        this.taskState.plannerCooldownUntil = Date.now() + this.deps.config.PLANNER_COOLDOWN_MS;
        this.taskState.pendingTriggers = ["SUBGOAL_FAILED"];
        this.deps.metrics.recordFailure(this.botId, result.errorCode);
      } else {
        this.taskState.progressCounters[subgoal.name] =
          (this.taskState.progressCounters[subgoal.name] ?? 0) + 1;
        if (this.taskState.queue.length === 0) {
          this.taskState.pendingTriggers = ["SUBGOAL_COMPLETED"];
        }
      }

      this.log("SUBGOAL_FINISHED", {
        subgoal: subgoal.name,
        result,
        queue_remaining: this.taskState.queue.length
      });
    } finally {
      this.taskState.currentSubgoal = null;
      this.taskState.busy = false;
      this.deps.skillLimiter.leave(this.botId);
    }
  }

  private runtimeSubgoal(subgoal: PlannerSubgoal): RuntimeSubgoal {
    return {
      ...subgoal,
      id: makeId(`subgoal_${this.botId}`),
      assignedAt: nowIso()
    };
  }

  private async materializeBuildSubgoals(
    snapshot: SnapshotV1,
    nextGoal: string,
    subgoals: PlannerSubgoal[]
  ): Promise<PlannerSubgoal[]> {
    const materialized: PlannerSubgoal[] = [];

    for (const subgoal of subgoals) {
      if (subgoal.name !== "build_blueprint") {
        materialized.push(subgoal);
        continue;
      }

      const design = await this.deps.blueprintDesigner.designAndPersist({
        botId: this.botId,
        nextGoal,
        subgoal,
        snapshot
      });

      const withGeneratedPath: PlannerSubgoal = {
        ...subgoal,
        params: {
          ...subgoal.params,
          path: design.filePath,
          blueprint_name: design.blueprint.name,
          blueprint_generated_at: design.generatedAt
        }
      };
      materialized.push(withGeneratedPath);

      this.log("BLUEPRINT_DESIGNED", {
        source_goal: nextGoal,
        blueprint_name: design.blueprint.name,
        blueprint_path: design.filePath,
        block_count: design.blueprint.blocks.length
      });
    }

    return materialized;
  }

  private log(type: string, payload: Record<string, unknown>): void {
    const event = {
      ts: nowIso(),
      botId: this.botId,
      type,
      payload
    };
    this.deps.logger.write("orchestrator", event);
    this.deps.logger.write(this.botId, event);
  }
}
