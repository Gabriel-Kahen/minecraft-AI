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
  const maxWaypoints = Math.max(1, Math.floor(Number(params.max_waypoints ?? 3)));
  const waypointTimeoutMs = Math.max(7000, Math.floor(Number(params.attempt_timeout_ms ?? 18000)));
  const origin = ctx.bot.entity.position.clone();
  let waypointsCompleted = 0;
  let lastError: unknown = null;

  try {
    for (let attempt = 0; attempt < maxWaypoints; attempt += 1) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.max(8, radius - attempt * 4);
      const targetX = origin.x + Math.cos(angle) * distance;
      const targetZ = origin.z + Math.sin(angle) * distance;
      const targetY = origin.y;
      try {
        await gotoCoordinates(ctx, targetX, targetY, targetZ, 2, waypointTimeoutMs);
        waypointsCompleted += 1;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (waypointsCompleted === 0) {
      throw lastError ?? new Error("explore waypoint failed");
    }

    if (returnToBase) {
      await gotoCoordinates(ctx, ctx.base.x, ctx.base.y, ctx.base.z, ctx.base.radius, 30000);
    }
    return success("exploration waypoint completed", { waypoints: waypointsCompleted });
  } catch (error) {
    return asSkillFailure(error, "STUCK_TIMEOUT");
  } finally {
    ctx.explorerLimiter.leave(ctx.botId);
  }
};
