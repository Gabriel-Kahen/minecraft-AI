import { readFile } from "node:fs/promises";
import path from "node:path";
import { Vec3 } from "vec3";
import type { SkillFailure, SkillResultV1, SkillSuccess } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { getMcData } from "../utils/mc-data";

const HOSTILE_MOB_NAMES = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "pillager",
  "vindicator",
  "evoker"
]);

const FOOD_ANIMAL_NAMES = new Set([
  "cow",
  "pig",
  "chicken",
  "sheep",
  "rabbit"
]);

const PATHFIND_MAX_ATTEMPTS = 3;
const PATHFIND_MAX_TIMEOUT_MS = 20000;
const PATHFIND_STALL_CHECK_INTERVAL_MS = 400;
const PATHFIND_STALL_FAIL_MS = 4200;
const PATHFIND_INACTIVE_FAIL_MS = 2200;
const PATHFIND_NUDGE_MS = 280;
const PATHFIND_RETRY_JITTER_BASE_MS = 140;
const PATHFIND_RETRY_JITTER_SPAN_MS = 120;
const PATHFIND_NO_PATH_EVENT_LIMIT = 5;

export const success = (details: string, metrics?: Record<string, number>): SkillSuccess => ({
  outcome: "SUCCESS",
  details,
  metrics
});

export const failure = (
  errorCode: SkillFailure["errorCode"],
  details: string,
  retryable = true
): SkillFailure => ({
  outcome: "FAILURE",
  errorCode,
  details,
  retryable
});

export const asSkillFailure = (error: unknown, fallbackCode: SkillFailure["errorCode"]): SkillFailure => {
  if (typeof error === "object" && error && "errorCode" in error) {
    return error as SkillFailure;
  }
  return failure(fallbackCode, error instanceof Error ? error.message : "unknown error");
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

let pathfinderModuleCache: any | null = null;
const movementCache = new WeakMap<any, { version: string; movements: any }>();

const getPathfinderModule = (): any => {
  if (pathfinderModuleCache) {
    return pathfinderModuleCache;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pathfinderModuleCache = require("mineflayer-pathfinder");
  return pathfinderModuleCache;
};

const ensureMovements = (ctx: SkillExecutionContext): void => {
  if (!ctx.bot.pathfinder?.setMovements) {
    throw failure("DEPENDS_ON_ITEM", "pathfinder plugin not loaded", false);
  }

  const cached = movementCache.get(ctx.bot);
  if (cached && cached.version === ctx.bot.version) {
    return;
  }

  const mcData = getMcData(ctx.bot.version);
  const pathfinderModule = getPathfinderModule();
  const movements = new pathfinderModule.Movements(ctx.bot, mcData);
  movementCache.set(ctx.bot, { version: ctx.bot.version, movements });
  ctx.bot.pathfinder.setMovements(movements);
};

export const gotoCoordinates = async (
  ctx: SkillExecutionContext,
  x: number,
  y: number,
  z: number,
  range = 2,
  timeoutMs = 20000
): Promise<void> => {
  ensureMovements(ctx);

  const target = new Vec3(x, y, z);
  if (ctx.bot.entity.position.distanceTo(target) <= range + 0.2) {
    return;
  }

  const pathfinderModule = getPathfinderModule();
  let lastFailure: SkillFailure | null = null;

  const nudgeTowardTarget = async (): Promise<void> => {
    try {
      await ctx.bot.lookAt(target, true);
    } catch {
      // best-effort
    }

    try {
      ctx.bot.setControlState("forward", true);
      if (target.y > ctx.bot.entity.position.y + 0.35) {
        ctx.bot.setControlState("jump", true);
      }
      await new Promise((resolve) => setTimeout(resolve, PATHFIND_NUDGE_MS));
    } finally {
      try {
        ctx.bot.clearControlStates?.();
      } catch {
        // best-effort
      }
    }
  };

  const runAttempt = async (attempt: number): Promise<void> => {
    const attemptRange = range + Math.min(2, attempt - 1);
    const goal = new pathfinderModule.goals.GoalNear(
      Math.floor(x),
      Math.floor(y),
      Math.floor(z),
      attemptRange
    );
    const distance = ctx.bot.entity.position.distanceTo(target);
    const computedTimeoutMs = Math.min(
      PATHFIND_MAX_TIMEOUT_MS,
      Math.max(timeoutMs, 2200 + Math.round(distance * 280) + (attempt - 1) * 1000)
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let noPathEvents = 0;
      let sawPathActivity = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let movementWatchHandle: NodeJS.Timeout | null = null;
      const attemptStartedAt = Date.now();
      let lastMoveAt = Date.now();
      let lastPos = ctx.bot.entity.position.clone();

      const cleanup = (): void => {
        ctx.bot.removeListener("goal_reached", onGoalReached);
        ctx.bot.removeListener("path_reset", onPathReset);
        ctx.bot.removeListener("path_update", onPathUpdate);
        ctx.bot.removeListener("error", onError);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (movementWatchHandle) {
          clearInterval(movementWatchHandle);
          movementWatchHandle = null;
        }
      };

      const settle = (fn: () => void, stopGoal = false): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (stopGoal) {
          try {
            ctx.bot.pathfinder?.setGoal(null);
          } catch {
            // ignore best-effort path cancel
          }
        }
        fn();
      };

      const onGoalReached = (reachedGoal: unknown): void => {
        if (reachedGoal && reachedGoal !== goal) {
          return;
        }
        settle(resolve);
      };

      const onPathReset = (reason: string): void => {
        sawPathActivity = true;
        if (reason === "noPath") {
          noPathEvents += 1;
        }
      };

      const onPathUpdate = (update: { status?: string } | undefined): void => {
        if (!update) {
          return;
        }
        sawPathActivity = true;
        if (update.status === "noPath" || update.status === "timeout") {
          noPathEvents += 1;
          return;
        }
        if (update.status === "success" || update.status === "partial") {
          noPathEvents = 0;
        }
      };

      const onError = (err: unknown): void =>
        settle(
          () =>
            reject(
              failure("PATHFIND_FAILED", err instanceof Error ? err.message : "pathfinding error")
            ),
          true
        );

      timeoutHandle = setTimeout(() => {
        const distanceNow = ctx.bot.entity.position.distanceTo(target);
        if (distanceNow <= attemptRange + 0.4) {
          settle(resolve, true);
          return;
        }
        settle(
          () => reject(failure("PATHFIND_FAILED", `path timeout after ${computedTimeoutMs}ms`)),
          true
        );
      }, computedTimeoutMs);

      movementWatchHandle = setInterval(() => {
        const currentPos = ctx.bot.entity.position;
        const moved = currentPos.distanceTo(lastPos);
        const distanceNow = currentPos.distanceTo(target);
        if (distanceNow <= attemptRange + 0.3) {
          settle(resolve, true);
          return;
        }

        if (moved >= 0.2) {
          lastMoveAt = Date.now();
          lastPos = currentPos.clone();
          noPathEvents = 0;
          return;
        }

        const pathfinder = ctx.bot.pathfinder;
        const isMoving =
          Boolean(pathfinder) &&
          typeof pathfinder.isMoving === "function" &&
          pathfinder.isMoving();

        const stalledForMs = Date.now() - lastMoveAt;
        const sinceStartMs = Date.now() - attemptStartedAt;
        if (noPathEvents >= PATHFIND_NO_PATH_EVENT_LIMIT && !isMoving && stalledForMs >= 1500) {
          settle(() => reject(failure("PATHFIND_FAILED", "pathfinder reported no stable path")), true);
          return;
        }

        if (!isMoving && !sawPathActivity && sinceStartMs >= PATHFIND_INACTIVE_FAIL_MS) {
          settle(
            () =>
              reject(
                failure(
                  "PATHFIND_FAILED",
                  `pathfinder inactive for ${sinceStartMs}ms (no movement/path updates)`
                )
              ),
            true
          );
          return;
        }

        if (!isMoving && stalledForMs >= PATHFIND_STALL_FAIL_MS) {
          settle(
            () =>
              reject(
                failure(
                  "PATHFIND_FAILED",
                  `pathfinder stopped moving for ${stalledForMs}ms`
                )
              ),
            true
          );
          return;
        }

        if (!isMoving) {
          return;
        }

        if (stalledForMs >= PATHFIND_STALL_FAIL_MS) {
          settle(
            () =>
              reject(
                failure("PATHFIND_FAILED", `movement stalled for ${stalledForMs}ms`)
              ),
            true
          );
        }
      }, PATHFIND_STALL_CHECK_INTERVAL_MS);

      ctx.bot.on("goal_reached", onGoalReached);
      ctx.bot.on("path_reset", onPathReset);
      ctx.bot.on("path_update", onPathUpdate);
      ctx.bot.on("error", onError);
      ctx.bot.pathfinder.setGoal(goal);
    });
  };

  for (let attempt = 1; attempt <= PATHFIND_MAX_ATTEMPTS; attempt += 1) {
    try {
      await runAttempt(attempt);
      return;
    } catch (error) {
      lastFailure = asSkillFailure(error, "PATHFIND_FAILED");
      if (attempt >= PATHFIND_MAX_ATTEMPTS) {
        break;
      }
      try {
        ctx.bot.pathfinder?.setGoal(null);
      } catch {
        // ignore best-effort path reset
      }
      await nudgeTowardTarget();
      await new Promise((resolve) =>
        setTimeout(resolve, PATHFIND_RETRY_JITTER_BASE_MS + Math.floor(Math.random() * PATHFIND_RETRY_JITTER_SPAN_MS))
      );
    }
  }

  throw (
    lastFailure ??
    failure("PATHFIND_FAILED", `unable to reach ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`)
  );
};

export const findNearestBlock = (ctx: SkillExecutionContext, blockName: string, maxDistance = 48): any => {
  const mcData = getMcData(ctx.bot.version);
  const blockDef = mcData.blocksByName[blockName];
  if (!blockDef) {
    return null;
  }

  return ctx.bot.findBlock({
    matching: blockDef.id,
    maxDistance,
    count: 1
  });
};

export const countItem = (ctx: SkillExecutionContext, itemName: string): number => {
  const items: Array<{ name: string; count: number }> = ctx.bot.inventory?.items?.() ?? [];
  return items
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
};

export const findNearestHostile = (ctx: SkillExecutionContext, maxDistance = 18): any | null => {
  const entities = Object.values(ctx.bot.entities ?? {}) as Array<any>;
  const hostiles = entities
    .filter((entity) => {
      if (entity.type !== "mob") {
        return false;
      }
      if (!HOSTILE_MOB_NAMES.has(String(entity.name ?? ""))) {
        return false;
      }
      const distance = ctx.bot.entity.position.distanceTo(entity.position);
      return distance <= maxDistance;
    })
    .sort(
      (a, b) =>
        ctx.bot.entity.position.distanceTo(a.position) - ctx.bot.entity.position.distanceTo(b.position)
    );

  return hostiles[0] ?? null;
};

export const findNearestFoodAnimal = (ctx: SkillExecutionContext, maxDistance = 24): any | null => {
  const entities = Object.values(ctx.bot.entities ?? {}) as Array<any>;
  const animals = entities
    .filter((entity) => {
      if (entity.type !== "mob") {
        return false;
      }
      if (!FOOD_ANIMAL_NAMES.has(String(entity.name ?? ""))) {
        return false;
      }
      const distance = ctx.bot.entity.position.distanceTo(entity.position);
      return distance <= maxDistance;
    })
    .sort(
      (a, b) =>
        ctx.bot.entity.position.distanceTo(a.position) - ctx.bot.entity.position.distanceTo(b.position)
    );

  return animals[0] ?? null;
};

export const countNearbyHostiles = (ctx: SkillExecutionContext, maxDistance = 16): number => {
  const entities = Object.values(ctx.bot.entities ?? {}) as Array<any>;
  return entities.filter((entity) => {
    if (entity.type !== "mob") {
      return false;
    }
    if (!HOSTILE_MOB_NAMES.has(String(entity.name ?? ""))) {
      return false;
    }
    const distance = ctx.bot.entity.position.distanceTo(entity.position);
    return distance <= maxDistance;
  }).length;
};

export const loadBlueprint = async (ctx: SkillExecutionContext, requestedPath?: string): Promise<any> => {
  if (!requestedPath) {
    throw new Error("build_blueprint requires a generated blueprint path");
  }

  const resolved = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.join(ctx.blueprintRoot, requestedPath);

  const payload = await readFile(resolved, "utf8");
  return JSON.parse(payload) as {
    name: string;
    blocks: Array<{ x: number; y: number; z: number; block: string }>;
  };
};

export const selectHotbarItem = async (ctx: SkillExecutionContext, itemName: string): Promise<boolean> => {
  const item = (ctx.bot.inventory?.items?.() ?? []).find((entry: any) => entry.name === itemName);
  if (!item) {
    return false;
  }

  await ctx.bot.equip(item, "hand");
  return true;
};

export const equipBestToolForBlock = async (
  ctx: SkillExecutionContext,
  block: any,
  requireHarvest = false
): Promise<void> => {
  const toolApi = ctx.bot.tool;
  if (!toolApi || typeof toolApi.equipForBlock !== "function" || !block) {
    return;
  }

  try {
    await toolApi.equipForBlock(block, { requireHarvest });
  } catch {
    // Best-effort; the caller may still be able to dig by hand.
  }
};

export const placeBlockAt = async (
  ctx: SkillExecutionContext,
  x: number,
  y: number,
  z: number,
  blockName: string
): Promise<SkillResultV1> => {
  const existing = ctx.bot.blockAt(new Vec3(x, y, z));
  if (existing && existing.name === blockName) {
    return success(`block already present at ${x},${y},${z}`);
  }

  const equipped = await selectHotbarItem(ctx, blockName);
  if (!equipped) {
    return failure("DEPENDS_ON_ITEM", `missing block item ${blockName}`);
  }

  const candidateSupports: Array<{ pos: Vec3; face: Vec3 }> = [
    { pos: new Vec3(x, y - 1, z), face: new Vec3(0, 1, 0) },
    { pos: new Vec3(x + 1, y, z), face: new Vec3(-1, 0, 0) },
    { pos: new Vec3(x - 1, y, z), face: new Vec3(1, 0, 0) },
    { pos: new Vec3(x, y, z + 1), face: new Vec3(0, 0, -1) },
    { pos: new Vec3(x, y, z - 1), face: new Vec3(0, 0, 1) }
  ];

  let support: any = null;
  let face: Vec3 | null = null;
  for (const candidate of candidateSupports) {
    const block = ctx.bot.blockAt(candidate.pos);
    if (block && block.name !== "air") {
      support = block;
      face = candidate.face;
      break;
    }
  }

  if (!support || !face) {
    return failure("PLACEMENT_FAILED", `no support block around target ${x},${y},${z}`);
  }

  try {
    await gotoCoordinates(ctx, x, y, z, 3, 15000);
    await ctx.bot.placeBlock(support, face);
    return success(`placed ${blockName} at ${x},${y},${z}`);
  } catch (error) {
    return asSkillFailure(error, "PLACEMENT_FAILED");
  }
};

export const beginHeartbeat = (
  ctx: SkillExecutionContext,
  lockKey: string
): { stop: () => void } => {
  const timer = setInterval(() => {
    ctx.lockManager.heartbeat(lockKey, ctx.botId);
  }, ctx.lockHeartbeatMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer)
  };
};
