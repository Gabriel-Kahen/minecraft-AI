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
import { buildLocalActivityPlan } from "./local-activity-plan";
import type { PlannerTrigger, RuntimeSubgoal, RuntimeTaskState } from "./types";
import { enforceSubgoalPrerequisites, type BlueprintDesigner, type PlannerService } from "../planner";
import { nowIso, sleep, withJitter } from "../utils/time";
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

  private lastAlwaysActiveAtMs = 0;

  private lastTaskEventChatAtMs = 0;

  private lastChatAtMs = 0;

  private lastChatMessage = "";

  private lastChatMessageAtMs = 0;

  private repeatedFailureKey: string | null = null;

  private repeatedFailureCount = 0;

  private repeatedFailureLastAtMs = 0;

  private currentSubgoalStartedAtMs = 0;

  private currentSubgoalTimeoutHandled = false;

  private forcedDisconnectReason: string | null = null;

  private lastStuckTriggerAtMs = 0;

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

  canChat(): boolean {
    return this.connected && Boolean(this.bot?.chat);
  }

  chat(message: string): void {
    if (!this.canChat()) {
      return;
    }

    const normalized = message.trim();
    if (!normalized) {
      return;
    }

    const nowMs = Date.now();
    if (nowMs - this.lastChatAtMs < this.deps.config.CHAT_MIN_INTERVAL_MS) {
      return;
    }

    if (
      this.lastChatMessage === normalized &&
      nowMs - this.lastChatMessageAtMs < this.deps.config.CHAT_DUPLICATE_WINDOW_MS
    ) {
      return;
    }

    try {
      this.bot.chat(normalized.slice(0, 240));
      this.lastChatAtMs = nowMs;
      this.lastChatMessage = normalized;
      this.lastChatMessageAtMs = nowMs;
    } catch {
      // best-effort status broadcast only
    }
  }

  private subgoalSummary(subgoal: RuntimeSubgoal | PlannerSubgoal): string {
    const params = subgoal.params ?? {};
    switch (subgoal.name) {
      case "goto": {
        const x = Math.round(Number(params.x ?? 0));
        const y = Math.round(Number(params.y ?? 0));
        const z = Math.round(Number(params.z ?? 0));
        const range = Number(params.range ?? 2);
        return `goto x:${x} y:${y} z:${z} r:${range}`;
      }
      case "goto_nearest": {
        const target = String(
          params.block ?? params.resource ?? params.resource_type ?? params.type ?? "unknown"
        );
        const maxDistance = Number(params.max_distance ?? 48);
        return `goto_nearest ${target} d:${maxDistance}`;
      }
      case "collect": {
        const target = String(
          params.item ??
            params.block ??
            params.resource ??
            params.resource_type ??
            params.type ??
            "unknown"
        );
        const count = Number(params.count ?? params.amount ?? params.qty ?? 1);
        return `collect ${target} x${count}`;
      }
      case "craft": {
        const item = String(params.item ?? params.output ?? params.result ?? params.type ?? "unknown");
        const count = Number(params.count ?? params.amount ?? params.qty ?? 1);
        return `craft ${item} x${count}`;
      }
      case "smelt": {
        const input = String(params.input ?? params.item ?? params.type ?? "unknown");
        const count = Number(params.count ?? params.amount ?? params.qty ?? 1);
        return `smelt ${input} x${count}`;
      }
      case "deposit": {
        const strategy = String(params.strategy ?? "all_non_essential");
        return `deposit ${strategy}`;
      }
      case "withdraw": {
        const item = String(params.item ?? params.type ?? params.resource ?? "unknown");
        const count = Number(params.count ?? params.amount ?? params.qty ?? 1);
        return `withdraw ${item} x${count}`;
      }
      case "build_blueprint": {
        const blueprintName = String(params.blueprint_name ?? "generated");
        return `build ${blueprintName}`;
      }
      case "explore": {
        const radius = Number(params.radius ?? 28);
        const returnToBase = Boolean(params.return_to_base ?? false);
        return `explore r:${radius} return:${returnToBase ? "yes" : "no"}`;
      }
      case "combat_engage": {
        const maxTargets = Number(params.max_targets ?? 1);
        const maxDistance = Number(params.max_distance ?? 18);
        return `combat_engage targets:${maxTargets} d:${maxDistance}`;
      }
      case "combat_guard": {
        const radius = Number(params.radius ?? 12);
        const durationMs = Number(params.duration_ms ?? 6000);
        return `combat_guard r:${radius} t:${Math.round(durationMs / 1000)}s`;
      }
      default:
        return subgoal.name;
    }
  }

  private subgoalExecutionSteps(subgoal: RuntimeSubgoal | PlannerSubgoal): string[] {
    const params = subgoal.params ?? {};
    switch (subgoal.name) {
      case "craft": {
        const item = String(params.item ?? params.output ?? params.result ?? params.type ?? "item");
        const count = Number(params.count ?? params.amount ?? params.qty ?? 1);
        return [
          `check/craft prerequisites for ${item}`,
          "ensure crafting table is available (nearby or inventory)",
          "place and use crafting table if recipe requires it",
          `craft ${item} until inventory gains ${count}`
        ];
      }
      case "collect": {
        const target = String(
          params.item ?? params.block ?? params.resource ?? params.resource_type ?? params.type ?? "resource"
        );
        const count = Number(params.count ?? params.amount ?? params.qty ?? 1);
        return [
          `locate nearest source block for ${target}`,
          "pathfind to source and mine/collect",
          `repeat until target count ${count} is reached`
        ];
      }
      case "goto_nearest": {
        const target = String(params.block ?? params.resource ?? params.resource_type ?? params.type ?? "target");
        return [
          `scan nearby world for ${target}`,
          "pathfind to closest valid block",
          "stop once within interaction range"
        ];
      }
      case "goto":
        return ["compute destination point", "pathfind with retries", "confirm in-range arrival"];
      case "smelt":
        return [
          "ensure smelting inputs and fuel exist",
          "ensure furnace is available",
          "smelt until requested count is reached"
        ];
      case "build_blueprint":
        return [
          "load generated blueprint file",
          "for each placement: move, orient, place",
          "verify placements and stop on placement failure"
        ];
      case "explore":
        return ["pick exploration waypoint", "pathfind to waypoint", "continue scanning for resources/threats"];
      case "deposit":
        return ["navigate to base chest", "open container", "deposit items by policy"];
      case "withdraw":
        return ["navigate to base chest", "open container", "withdraw requested items"];
      case "combat_engage":
        return ["acquire hostile target", "engage with pvp controls", "disengage when area is safe"];
      case "combat_guard":
        return ["hold guard radius", "monitor nearby hostiles", "interrupt and engage threats"];
      default:
        return ["execute deterministic skill handler"];
    }
  }

  taskSummary(): string {
    if (!this.connected) {
      return "offline";
    }

    if (this.taskState.currentSubgoal) {
      return `active ${this.subgoalSummary(this.taskState.currentSubgoal)}`;
    }

    const queued = this.taskState.queue[0];
    if (queued) {
      return `queued ${this.subgoalSummary(queued)}`;
    }

    if (this.taskState.currentGoal) {
      return `goal ${this.taskState.currentGoal.slice(0, 36)}`;
    }

    return "idle";
  }

  private shortenForChat(value: string, maxLength = 80): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
  }

  private maybeChatTaskEvent(message: string, force = false): void {
    if (!this.deps.config.CHAT_TASK_EVENTS_ENABLED) {
      return;
    }
    if (!this.canChat()) {
      return;
    }

    const nowMs = Date.now();
    if (!force && nowMs - this.lastTaskEventChatAtMs < this.deps.config.CHAT_TASK_EVENT_MIN_MS) {
      return;
    }
    this.lastTaskEventChatAtMs = nowMs;
    this.chat(message.slice(0, 240));
  }

  private inventoryCounts(): Record<string, number> {
    if (!this.bot?.inventory?.items) {
      return {};
    }
    const counts: Record<string, number> = {};
    const items: Array<{ name: string; count: number }> = this.bot.inventory.items();
    for (const item of items) {
      counts[item.name] = (counts[item.name] ?? 0) + item.count;
    }
    return counts;
  }

  private inventoryDelta(
    before: Record<string, number>,
    after: Record<string, number>
  ): Record<string, number> | undefined {
    const delta: Record<string, number> = {};
    const names = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    for (const name of names) {
      const change = (after[name] ?? 0) - (before[name] ?? 0);
      if (change !== 0) {
        delta[name] = change;
      }
    }
    return Object.keys(delta).length > 0 ? delta : undefined;
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
    this.deps.skillLimiter.forget(this.botId);
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
      this.forcedDisconnectReason = null;
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
      this.forcedDisconnectReason = null;
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
      const reason = this.forcedDisconnectReason ?? "connection_end";
      this.forcedDisconnectReason = null;
      this.log("DISCONNECTED", {
        reason
      });
      this.scheduleReconnect(bot, "end", reason);
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

    this.deps.skillLimiter.forget(this.botId);
    this.disconnectStreak += 1;
    this.connected = false;
    this.reconnectPending = true;
    const interruptedSubgoal = this.taskState.currentSubgoal;
    this.taskState.busy = false;
    this.taskState.currentSubgoal = null;

    if (
      interruptedSubgoal &&
      interruptedSubgoal.retryCount < this.deps.config.SUBGOAL_RETRY_LIMIT
    ) {
      this.taskState.queue.unshift({
        ...interruptedSubgoal,
        id: makeId(`subgoal_${this.botId}`),
        assignedAt: nowIso(),
        retryCount: interruptedSubgoal.retryCount + 1
      });
      this.log("SUBGOAL_INTERRUPTED_REQUEUED", {
        subgoal: interruptedSubgoal.name,
        retry_count: interruptedSubgoal.retryCount + 1,
        reason
      });
    }

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

    if (trigger === "DEATH") {
      this.taskState.queue = [];
    }

    this.log("INTERRUPT", {
      trigger,
      details
    });

    if (trigger === "STUCK" && this.bot) {
      try {
        this.bot.pathfinder?.setGoal(null);
        this.bot.clearControlStates?.();
      } catch {
        // best-effort stuck reset
      }
    }
  }

  private canRetryFailure(errorCode: FailureCode): boolean {
    switch (errorCode) {
      case "RESOURCE_NOT_FOUND":
      case "PATHFIND_FAILED":
      case "INTERRUPTED_BY_HOSTILES":
      case "STUCK_TIMEOUT":
      case "INVENTORY_FULL":
      case "COMBAT_LOST_TARGET":
      case "PLACEMENT_FAILED":
        return true;
      case "DEPENDS_ON_ITEM":
      case "NO_TOOL_AVAILABLE":
      case "BOT_DIED":
      default:
        return false;
    }
  }

  private retryLimitFor(errorCode: FailureCode): number {
    const base = this.deps.config.SUBGOAL_RETRY_LIMIT;
    switch (errorCode) {
      case "PATHFIND_FAILED":
      case "RESOURCE_NOT_FOUND":
        return base + 4;
      case "INTERRUPTED_BY_HOSTILES":
      case "COMBAT_LOST_TARGET":
        return base + 3;
      case "STUCK_TIMEOUT":
      case "PLACEMENT_FAILED":
        return base + 2;
      default:
        return base;
    }
  }

  private maybeHandleActiveSubgoalTimeout(now: number): void {
    if (!this.taskState.busy || !this.taskState.currentSubgoal || !this.bot) {
      return;
    }
    if (this.currentSubgoalTimeoutHandled) {
      return;
    }
    if (this.currentSubgoalStartedAtMs <= 0) {
      return;
    }

    const elapsedMs = now - this.currentSubgoalStartedAtMs;
    if (elapsedMs < this.deps.config.SUBGOAL_EXEC_TIMEOUT_MS) {
      return;
    }

    this.currentSubgoalTimeoutHandled = true;
    this.forcedDisconnectReason = "subgoal_timeout";
    this.log("SUBGOAL_TIMEOUT", {
      subgoal: this.taskState.currentSubgoal.name,
      elapsed_ms: elapsedMs
    });
    this.maybeChatTaskEvent(
      `[task] ${this.botId} timeout ${this.subgoalSummary(this.taskState.currentSubgoal)} after ${Math.round(
        elapsedMs / 1000
      )}s; reconnecting`
    );

    try {
      this.bot.pathfinder?.setGoal(null);
      this.bot.clearControlStates?.();
      this.bot.quit("subgoal timeout");
    } catch {
      // best effort reset
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.bot || !this.connected) {
      return;
    }

    const now = Date.now();
    this.maybeHandleActiveSubgoalTimeout(now);

    if (this.taskState.busy) {
      const hasStuckTrigger = this.taskState.pendingTriggers.includes("STUCK");
      if (hasStuckTrigger && this.currentSubgoalStartedAtMs > 0) {
        const elapsedMs = now - this.currentSubgoalStartedAtMs;
        if (elapsedMs >= 25000 && now - this.lastStuckTriggerAtMs >= 12000) {
          this.lastStuckTriggerAtMs = now;
          const currentSubgoal = this.taskState.currentSubgoal;
          const currentLabel = currentSubgoal ? this.subgoalSummary(currentSubgoal) : "subgoal";
          this.log("SUBGOAL_STUCK_RECOVERY", {
            subgoal: currentSubgoal?.name ?? "unknown",
            elapsed_ms: elapsedMs
          });
          this.maybeChatTaskEvent(
            `[task] ${this.botId} stuck ${currentLabel}; reconnecting for recovery`
          );
          this.forcedDisconnectReason = "stuck_recovery";
          this.taskState.pendingTriggers = this.taskState.pendingTriggers.filter(
            (trigger) => trigger !== "STUCK"
          );
          try {
            this.bot.pathfinder?.setGoal(null);
            this.bot.clearControlStates?.();
            this.bot.quit("stuck recovery");
          } catch {
            // best effort recovery
          }
        }
      }
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
      const freshSnapshot = this.refreshSnapshot(now, true);
      if (!freshSnapshot) {
        return;
      }
      await this.requestPlan(freshSnapshot);
    }

    if (this.taskState.queue.length === 0) {
      this.enqueueAlwaysActiveSubgoal(now);
    }
  }

  private enqueueAlwaysActiveSubgoal(nowMs: number): void {
    if (!this.deps.config.ALWAYS_ACTIVE_MODE || !this.bot) {
      return;
    }
    if (this.plannerInFlight) {
      return;
    }
    if (this.taskState.busy || this.taskState.queue.length > 0) {
      return;
    }
    if (nowMs - this.lastAlwaysActiveAtMs < this.deps.config.ALWAYS_ACTIVE_REQUEUE_MS) {
      return;
    }

    const snapshot = this.refreshSnapshot(nowMs, false);
    if (!snapshot) {
      return;
    }

    const localPlan = buildLocalActivityPlan(snapshot, this.deps.config.MC_VERSION);
    if (localPlan.subgoals.length === 0) {
      return;
    }

    this.taskState.queue = localPlan.subgoals.map((subgoal) => this.runtimeSubgoal(subgoal));
    this.lastAlwaysActiveAtMs = nowMs;

    this.log("ALWAYS_ACTIVE_ENQUEUED", {
      reason: localPlan.reason,
      subgoals: localPlan.subgoals.map((subgoal) => subgoal.name)
    });
    this.maybeChatTaskEvent(
      `[task] ${this.botId} local ${localPlan.reason} -> ${localPlan.subgoals
        .map((subgoal) => this.subgoalSummary(subgoal))
        .join(" ; ")}`
    );
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
      const snapshot = buildSnapshot(this.bot, this.botId, this.taskState, {
        nowMs,
        nearbyCacheMs: this.deps.config.SNAPSHOT_NEARBY_CACHE_MS,
        nearbyRescanDistance: this.deps.config.SNAPSHOT_NEARBY_RESCAN_DISTANCE
      });
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
      if (outcome.notes && outcome.notes.length > 0) {
        this.log("PLANNER_NORMALIZED", {
          notes: outcome.notes
        });
      }
      const materializedSubgoals = await this.materializeBuildSubgoals(
        snapshot,
        outcome.response.next_goal,
        outcome.response.subgoals
      );
      const guarded = enforceSubgoalPrerequisites(
        snapshot,
        materializedSubgoals,
        this.deps.config.MC_VERSION
      );
      this.taskState.queue = guarded.subgoals.map((subgoal) => this.runtimeSubgoal(subgoal));
      this.taskState.pendingTriggers = [];
      this.lastPlanAt = Date.now();
      this.maybeChatTaskEvent(
        `[plan] ${this.botId} ${this.shortenForChat(
          this.taskState.currentGoal ?? "goal"
        )} -> ${this.taskState.queue
          .slice(0, 3)
          .map((subgoal) => this.subgoalSummary(subgoal))
          .join(" ; ")}`
      );

      if (guarded.notes.length > 0) {
        this.log("PLANNER_GUARD_APPLIED", {
          notes: guarded.notes,
          original_count: materializedSubgoals.length,
          guarded_count: guarded.subgoals.length
        });
      }

      if (outcome.status !== "SUCCESS") {
        this.log("PLANNER_FALLBACK", {
          status: outcome.status,
          next_goal: outcome.response.next_goal
        });
      }

      if (this.taskState.queue.length === 0) {
        this.log("PLANNER_EMPTY_FALLBACK", {
          status: outcome.status,
          next_goal: outcome.response.next_goal
        });
        this.taskState.queue = [
          this.runtimeSubgoal({
            name: "explore",
            params: { radius: 20, return_to_base: true },
            success_criteria: { explored_points_min: 1 }
          })
        ];
      }
    } catch (error) {
      this.taskState.plannerCooldownUntil = Date.now() + this.deps.config.PLANNER_COOLDOWN_MS;
      this.taskState.pendingTriggers = ["SUBGOAL_FAILED"];
      this.deps.metrics.recordLlmCall(this.botId, "ERROR");
      this.log("INCIDENT", {
        category: "planner_error",
        error: error instanceof Error ? error.message : String(error)
      });

      if (this.taskState.queue.length === 0) {
        const localPlan = buildLocalActivityPlan(snapshot, this.deps.config.MC_VERSION);
        if (localPlan.subgoals.length > 0) {
          this.taskState.queue = localPlan.subgoals.map((subgoal) => this.runtimeSubgoal(subgoal));
          this.log("PLANNER_LOCAL_FALLBACK_ENQUEUED", {
            reason: localPlan.reason,
            subgoals: localPlan.subgoals.map((subgoal) => subgoal.name)
          });
        }
      }
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
    this.currentSubgoalStartedAtMs = Date.now();
    this.currentSubgoalTimeoutHandled = false;
    const startedAtMs = Date.now();
    const startedAt = nowIso();
    const inventoryBefore = this.inventoryCounts();
    const healthBefore = Number(this.bot.health ?? 20);

    this.log("SUBGOAL_STARTED", {
      subgoal: subgoal.name,
      params: subgoal.params,
      steps: this.subgoalExecutionSteps(subgoal)
    });
    this.maybeChatTaskEvent(`[task] ${this.botId} start ${this.subgoalSummary(subgoal)}`);
    if (this.deps.config.CHAT_INCLUDE_STEPS) {
      this.maybeChatTaskEvent(
        `[steps] ${this.botId} ${this.subgoalExecutionSteps(subgoal)
          .map((step, index) => `${index + 1}) ${step}`)
          .join(" | ")}`
      );
    }

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
      const inventoryAfter = this.inventoryCounts();
      const healthAfter = Number(this.bot.health ?? healthBefore);
      this.deps.metrics.recordSubgoal(this.botId, subgoal.name, result.outcome, durationMs);

      const historyEntry: ActionHistoryEntry = {
        timestamp: endedAt,
        subgoal_name: subgoal.name as SubgoalName,
        params: subgoal.params,
        outcome: result.outcome,
        error_code: result.outcome === "FAILURE" ? (result.errorCode as FailureCode) : null,
        error_details: result.outcome === "FAILURE" ? result.details : null,
        inventory_delta: this.inventoryDelta(inventoryBefore, inventoryAfter),
        health_delta: healthAfter - healthBefore,
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
        let retryable = result.retryable !== false && this.canRetryFailure(result.errorCode);
        const retryCount = subgoal.retryCount ?? 0;
        const nowMs = Date.now();
        const failureKey = `${subgoal.name}:${result.errorCode}`;
        if (
          this.repeatedFailureKey === failureKey &&
          nowMs - this.repeatedFailureLastAtMs <= this.deps.config.SUBGOAL_FAILURE_STREAK_WINDOW_MS
        ) {
          this.repeatedFailureCount += 1;
        } else {
          this.repeatedFailureKey = failureKey;
          this.repeatedFailureCount = 1;
        }
        this.repeatedFailureLastAtMs = nowMs;

        if (this.repeatedFailureCount >= this.deps.config.SUBGOAL_LOOP_GUARD_REPEATS) {
          retryable = false;
          this.log("SUBGOAL_LOOP_GUARD", {
            subgoal: subgoal.name,
            error_code: result.errorCode,
            repeats: this.repeatedFailureCount
          });
        }

        const retryLimit = this.retryLimitFor(result.errorCode);
        if (retryable && retryCount < retryLimit) {
          const baseDelayMs = this.deps.config.SUBGOAL_RETRY_BASE_DELAY_MS * (retryCount + 1);
          const retryDelayMs = Math.min(
            this.deps.config.SUBGOAL_RETRY_MAX_DELAY_MS,
            Math.max(0, withJitter(baseDelayMs))
          );
          await sleep(retryDelayMs);
          const retrySubgoal: RuntimeSubgoal = {
            ...subgoal,
            id: makeId(`subgoal_${this.botId}`),
            assignedAt: nowIso(),
            retryCount: retryCount + 1
          };
          this.taskState.queue.unshift(retrySubgoal);
          this.log("SUBGOAL_REQUEUED", {
            subgoal: subgoal.name,
            retry_count: retrySubgoal.retryCount,
            error_code: result.errorCode,
            retry_delay_ms: retryDelayMs,
            retry_limit: retryLimit
          });
        } else {
          // For non-retryable or exhausted attempts, clear stale dependent queue and request immediate replan.
          if (this.taskState.queue.length > 0) {
            this.log("QUEUE_DROPPED_AFTER_HARD_FAILURE", {
              failed_subgoal: subgoal.name,
              error_code: result.errorCode,
              dropped_count: this.taskState.queue.length
            });
            this.taskState.queue = [];
          }
          this.taskState.plannerCooldownUntil = Date.now();
          this.taskState.pendingTriggers = ["SUBGOAL_FAILED"];
        }
        this.deps.metrics.recordFailure(this.botId, result.errorCode);
      } else {
        this.repeatedFailureKey = null;
        this.repeatedFailureCount = 0;
        this.repeatedFailureLastAtMs = 0;
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
      if (result.outcome === "SUCCESS") {
        this.maybeChatTaskEvent(
          `[task] ${this.botId} done ${this.subgoalSummary(subgoal)} in ${Math.round(durationMs / 1000)}s`
        );
      } else {
        this.maybeChatTaskEvent(
          `[task] ${this.botId} fail ${this.subgoalSummary(subgoal)} (${result.errorCode}) ${this.shortenForChat(
            result.details
          )}`
        );
      }
    } finally {
      this.taskState.currentSubgoal = null;
      this.taskState.busy = false;
      this.currentSubgoalStartedAtMs = 0;
      this.currentSubgoalTimeoutHandled = false;
      this.deps.skillLimiter.leave(this.botId);
    }
  }

  private runtimeSubgoal(subgoal: PlannerSubgoal): RuntimeSubgoal {
    return {
      ...subgoal,
      id: makeId(`subgoal_${this.botId}`),
      assignedAt: nowIso(),
      retryCount: 0
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
      try {
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
      } catch (error) {
        this.log("INCIDENT", {
          category: "blueprint_design",
          error: error instanceof Error ? error.message : String(error)
        });
        materialized.push({
          name: "explore",
          params: { radius: 20, return_to_base: true },
          success_criteria: { explored_points_min: 1 }
        });
      }
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
