import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { failure, findNearestHostile, success, withTimeout } from "./helpers";

export const combatEngageSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const maxDistance = Number(params.max_distance ?? 18);
  const timeoutMs = Number(params.timeout_ms ?? 12000);

  const pvp = ctx.bot.pvp;
  if (!pvp || typeof pvp.attack !== "function") {
    return failure("DEPENDS_ON_ITEM", "mineflayer-pvp plugin unavailable", false);
  }

  const target = findNearestHostile(ctx, maxDistance);
  if (!target) {
    return success("no hostile target found");
  }

  try {
    pvp.attack(target);
    await withTimeout(
      new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          const refreshed = ctx.bot.entities[target.id];
          if (!refreshed || refreshed.isValid === false) {
            clearInterval(interval);
            resolve();
          }
        }, 300);
      }),
      timeoutMs
    );
    pvp.stop();
    return success(`engaged hostile ${target.name}`);
  } catch {
    pvp.stop();
    return failure("COMBAT_LOST_TARGET", "target not neutralized before timeout", true);
  }
};
