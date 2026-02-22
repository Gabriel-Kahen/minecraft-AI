import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import {
  countNearbyHostiles,
  failure,
  findNearestFoodAnimal,
  findNearestHostile,
  gotoCoordinates,
  success
} from "./helpers";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const nearestDroppedItemEntity = (ctx: SkillExecutionContext, maxDistance: number): any | null => {
  const entities = Object.values(ctx.bot.entities ?? {}) as Array<any>;
  let nearest: any | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const entity of entities) {
    if (!entity?.position || entity.type !== "object") {
      continue;
    }
    const distance = ctx.bot.entity.position.distanceTo(entity.position);
    if (!Number.isFinite(distance) || distance > maxDistance) {
      continue;
    }
    if (distance < nearestDistance) {
      nearest = entity;
      nearestDistance = distance;
    }
  }

  return nearest;
};

const sweepCombatDrops = async (ctx: SkillExecutionContext): Promise<void> => {
  for (let pass = 0; pass < 3; pass += 1) {
    const drop = nearestDroppedItemEntity(ctx, 8);
    if (!drop) {
      return;
    }
    try {
      await gotoCoordinates(ctx, drop.position.x, drop.position.y, drop.position.z, 1, 6000);
      await wait(250);
    } catch {
      return;
    }
  }
};

export const combatEngageSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const maxDistance = Number(params.max_distance ?? 18);
  const timeoutMs = Number(params.timeout_ms ?? 12000);
  const targetMode = String(params.target_mode ?? "hostile").toLowerCase();

  const pvp = ctx.bot.pvp;
  if (!pvp || typeof pvp.attack !== "function") {
    return failure("DEPENDS_ON_ITEM", "mineflayer-pvp plugin unavailable", false);
  }

  const selectTarget = (): any | null => {
    if (targetMode === "animal" || targetMode === "food") {
      return findNearestFoodAnimal(ctx, Math.max(10, maxDistance));
    }
    if (targetMode === "auto") {
      const hostile = findNearestHostile(ctx, maxDistance);
      if (hostile) {
        return hostile;
      }
      if ((ctx.bot.food ?? 20) <= 12 && (ctx.bot.health ?? 20) >= 9) {
        return findNearestFoodAnimal(ctx, Math.max(12, maxDistance));
      }
      return null;
    }
    return findNearestHostile(ctx, maxDistance);
  };

  const target = selectTarget();
  if (!target) {
    if (targetMode === "animal" || targetMode === "food") {
      return failure("RESOURCE_NOT_FOUND", "no food animal target found", true);
    }
    return success("no hostile target found");
  }

  try {
    pvp.attack(target);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const interval = setInterval(() => {
        const refreshed = ctx.bot.entities[target.id];
        if (!refreshed || refreshed.isValid === false) {
          if (!finished) {
            finished = true;
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        }
      }, 300);
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          clearInterval(interval);
          reject(new Error("combat timeout"));
        }
      }, Math.max(1500, timeoutMs));
    });
    pvp.stop();
    await sweepCombatDrops(ctx);
    return success(`engaged target ${target.name}`);
  } catch {
    pvp.stop();
    const nearbyHostiles = countNearbyHostiles(ctx, 10);
    if ((ctx.bot.health ?? 20) <= 7 && nearbyHostiles > 0) {
      return failure("INTERRUPTED_BY_HOSTILES", "combat disengaged to preserve health", true);
    }
    return failure("COMBAT_LOST_TARGET", "target not neutralized before timeout", true);
  }
};
