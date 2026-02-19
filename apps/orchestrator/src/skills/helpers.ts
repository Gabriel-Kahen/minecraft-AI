import { readFile } from "node:fs/promises";
import path from "node:path";
import { Vec3 } from "vec3";
import type { SkillFailure, SkillResultV1, SkillSuccess } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";

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

const getPathfinderModule = (): any => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("mineflayer-pathfinder");
};

const ensureMovements = (ctx: SkillExecutionContext): void => {
  if (!ctx.bot.pathfinder?.setMovements) {
    throw failure("DEPENDS_ON_ITEM", "pathfinder plugin not loaded", false);
  }

  const mcData = require("minecraft-data")(ctx.bot.version);
  const pathfinderModule = getPathfinderModule();
  const movements = new pathfinderModule.Movements(ctx.bot, mcData);
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

  const pathfinderModule = getPathfinderModule();
  const goal = new pathfinderModule.goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range);

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        ctx.bot.removeListener("goal_reached", onGoalReached);
        ctx.bot.removeListener("path_reset", onPathReset);
        ctx.bot.removeListener("error", onError);
      };

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        fn();
      };

      const onGoalReached = (): void => settle(resolve);
      const onPathReset = (reason: string): void => {
        if (reason === "noPath") {
          settle(() => reject(failure("PATHFIND_FAILED", "pathfinder reported no path")));
        }
      };
      const onError = (err: unknown): void =>
        settle(() => reject(failure("PATHFIND_FAILED", err instanceof Error ? err.message : "pathfinding error")));

      ctx.bot.once("goal_reached", onGoalReached);
      ctx.bot.on("path_reset", onPathReset);
      ctx.bot.once("error", onError);
      ctx.bot.pathfinder.setGoal(goal);
    }),
    timeoutMs
  ).catch((err) => {
    if (typeof err === "object" && err && "errorCode" in err) {
      throw err;
    }
    throw failure("PATHFIND_FAILED", err instanceof Error ? err.message : "path timeout");
  });
};

export const findNearestBlock = (ctx: SkillExecutionContext, blockName: string, maxDistance = 48): any => {
  const mcData = require("minecraft-data")(ctx.bot.version);
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
      const distance = ctx.bot.entity.position.distanceTo(entity.position);
      return distance <= maxDistance;
    })
    .sort(
      (a, b) =>
        ctx.bot.entity.position.distanceTo(a.position) - ctx.bot.entity.position.distanceTo(b.position)
    );

  return hostiles[0] ?? null;
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
