import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { failure, loadBlueprint, placeBlockAt, success } from "./helpers";

export const buildBlueprintSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const blueprintPath = typeof params.path === "string" ? params.path : null;
  if (!blueprintPath) {
    return failure(
      "DEPENDS_ON_ITEM",
      "build_blueprint requires `path`; stock templates are disabled",
      false
    );
  }

  const anchor = {
    x: Number(params.anchor_x ?? Math.floor(ctx.bot.entity.position.x)),
    y: Number(params.anchor_y ?? Math.floor(ctx.bot.entity.position.y)),
    z: Number(params.anchor_z ?? Math.floor(ctx.bot.entity.position.z))
  };

  let blueprint: {
    name?: string;
    blocks?: Array<{ x: number; y: number; z: number; block: string }>;
  };
  try {
    blueprint = await loadBlueprint(ctx, blueprintPath);
  } catch (error) {
    return failure(
      "DEPENDS_ON_ITEM",
      `could not load generated blueprint at ${blueprintPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true
    );
  }

  if (!Array.isArray(blueprint.blocks) || blueprint.blocks.length === 0) {
    return failure("PLACEMENT_FAILED", "blueprint is empty or invalid", false);
  }

  let placed = 0;
  for (const placement of blueprint.blocks) {
    const worldX = anchor.x + Number(placement.x);
    const worldY = anchor.y + Number(placement.y);
    const worldZ = anchor.z + Number(placement.z);
    const result = await placeBlockAt(ctx, worldX, worldY, worldZ, String(placement.block));
    if (result.outcome === "FAILURE") {
      return result;
    }
    placed += 1;
  }

  return success(`placed blueprint ${blueprint.name ?? "unnamed"}`, { placed_blocks: placed });
};
