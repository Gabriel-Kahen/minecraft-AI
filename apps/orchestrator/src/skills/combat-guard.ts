import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { failure, findNearestHostile, success } from "./helpers";

export const combatGuardSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const durationMs = Number(params.duration_ms ?? 8000);
  const radius = Number(params.radius ?? 14);

  const pvp = ctx.bot.pvp;
  if (!pvp || typeof pvp.attack !== "function") {
    return failure("DEPENDS_ON_ITEM", "mineflayer-pvp plugin unavailable", false);
  }

  const started = Date.now();
  let engagements = 0;

  while (Date.now() - started < durationMs) {
    const target = findNearestHostile(ctx, radius);
    if (target) {
      pvp.attack(target);
      engagements += 1;
      await new Promise((resolve) => setTimeout(resolve, 700));
    } else {
      pvp.stop();
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  pvp.stop();
  return success("guard window complete", { engagements });
};
