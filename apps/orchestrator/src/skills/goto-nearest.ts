import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, findNearestBlock, gotoCoordinates, success } from "./helpers";

const candidateBlocks = (ctx: SkillExecutionContext, rawTarget: string): string[] => {
  const target = rawTarget.trim().toLowerCase();
  const mcData = require("minecraft-data")(ctx.bot.version);
  const names = new Set<string>();

  if (target === "log" || target === "logs" || target === "wood" || target === "tree") {
    for (const blockName of Object.keys(mcData.blocksByName)) {
      if (blockName.endsWith("_log")) {
        names.add(blockName);
      }
    }
  } else if (mcData.blocksByName[target]) {
    names.add(target);
  }

  const item = mcData.itemsByName[target];
  if (item) {
    for (const blockName of Object.keys(mcData.blocksByName)) {
      const block = mcData.blocksByName[blockName];
      if (!Array.isArray(block.drops)) {
        continue;
      }
      if (block.drops.includes(item.id)) {
        names.add(blockName);
      }
    }
  }

  if (names.size === 0) {
    names.add(target);
  }

  return [...names];
};

const findNearestByNames = (
  ctx: SkillExecutionContext,
  names: string[],
  maxDistance: number
): any | null => {
  let nearest: any | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const name of names) {
    const found = findNearestBlock(ctx, name, maxDistance);
    if (!found) {
      continue;
    }
    const distance = ctx.bot.entity.position.distanceTo(found.position);
    if (distance < bestDistance) {
      nearest = found;
      bestDistance = distance;
    }
  }

  return nearest;
};

export const gotoNearestSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const blockName = String(
    params.block ??
      params.resource ??
      params.resource_type ??
      params.type ??
      ""
  );
  const maxDistance = Number(params.max_distance ?? 48);
  if (!blockName) {
    return failure("DEPENDS_ON_ITEM", "goto_nearest requires block/resource name", false);
  }

  const block = findNearestByNames(ctx, candidateBlocks(ctx, blockName), maxDistance);
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
