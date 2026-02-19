import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, gotoCoordinates, success } from "./helpers";

export const gotoSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const x = Number(params.x);
  const y = Number(params.y);
  const z = Number(params.z);
  const range = Number(params.range ?? 2);

  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    return failure("DEPENDS_ON_ITEM", "goto requires numeric x/y/z", false);
  }

  try {
    await gotoCoordinates(ctx, x, y, z, range, 30000);
    return success(`arrived near ${x},${y},${z}`);
  } catch (error) {
    return asSkillFailure(error, "PATHFIND_FAILED");
  }
};
