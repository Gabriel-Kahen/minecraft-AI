import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, countItem, failure, findNearestBlock, success } from "./helpers";

export const collectSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const targetName = String(
    params.item ??
      params.block ??
      params.resource ??
      params.resource_type ??
      params.type ??
      ""
  );
  const desiredCount = Number(params.count ?? params.amount ?? params.qty ?? 1);
  const maxDistance = Number(params.max_distance ?? 48);

  if (!targetName) {
    return failure("DEPENDS_ON_ITEM", "collect requires item or block name", false);
  }

  const current = countItem(ctx, targetName);
  if (current >= desiredCount) {
    return success(`already has ${current}/${desiredCount} ${targetName}`);
  }

  const collector = ctx.bot.collectBlock?.collect;
  if (typeof collector !== "function") {
    return failure("DEPENDS_ON_ITEM", "collectblock plugin unavailable", false);
  }

  const block = findNearestBlock(ctx, targetName, maxDistance);
  if (!block) {
    return failure("RESOURCE_NOT_FOUND", `could not find ${targetName}`, true);
  }

  try {
    await collector([block]);
    const after = countItem(ctx, targetName);
    if (after < desiredCount) {
      return failure("RESOURCE_NOT_FOUND", `collected but below target: ${after}/${desiredCount}`, true);
    }
    return success(`collected ${targetName} to ${after}`, { gathered: after - current });
  } catch (error) {
    return asSkillFailure(error, "RESOURCE_NOT_FOUND");
  }
};
