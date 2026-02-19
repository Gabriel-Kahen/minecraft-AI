import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, findNearestBlock, gotoCoordinates, success } from "./helpers";

export const gotoNearestSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const blockName = String(params.block ?? params.resource ?? "");
  const maxDistance = Number(params.max_distance ?? 48);
  if (!blockName) {
    return failure("DEPENDS_ON_ITEM", "goto_nearest requires block/resource name", false);
  }

  const block = findNearestBlock(ctx, blockName, maxDistance);
  if (!block) {
    return failure("RESOURCE_NOT_FOUND", `no ${blockName} within ${maxDistance} blocks`, true);
  }

  try {
    await gotoCoordinates(ctx, block.position.x, block.position.y, block.position.z, 2, 25000);
    return success(`arrived near nearest ${blockName}`);
  } catch (error) {
    return asSkillFailure(error, "PATHFIND_FAILED");
  }
};
