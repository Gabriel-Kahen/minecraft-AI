import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, gotoCoordinates, success } from "./helpers";

export const exploreSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  if (!ctx.explorerLimiter.tryEnter(ctx.botId)) {
    return failure("DEPENDS_ON_ITEM", "exploration slot unavailable", true);
  }

  const radius = Number(params.radius ?? 28);
  const returnToBase = Boolean(params.return_to_base ?? false);
  const angle = Math.random() * Math.PI * 2;
  const targetX = ctx.bot.entity.position.x + Math.cos(angle) * radius;
  const targetZ = ctx.bot.entity.position.z + Math.sin(angle) * radius;
  const targetY = ctx.bot.entity.position.y;

  try {
    await gotoCoordinates(ctx, targetX, targetY, targetZ, 2, 25000);
    if (returnToBase) {
      await gotoCoordinates(ctx, ctx.base.x, ctx.base.y, ctx.base.z, ctx.base.radius, 30000);
    }
    return success("exploration waypoint completed", { waypoints: 1 });
  } catch (error) {
    return asSkillFailure(error, "STUCK_TIMEOUT");
  } finally {
    ctx.explorerLimiter.leave(ctx.botId);
  }
};
