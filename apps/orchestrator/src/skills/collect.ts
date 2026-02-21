import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, countItem, failure, findNearestBlock, success } from "./helpers";

interface CollectTargetSpec {
  searchBlocks: string[];
  inventoryItems: string[];
  label: string;
}

const dedupe = (values: string[]): string[] => [...new Set(values)];

const resolveCollectTarget = (ctx: SkillExecutionContext, rawTarget: string): CollectTargetSpec => {
  const target = rawTarget.trim().toLowerCase();
  const mcData = require("minecraft-data")(ctx.bot.version);
  const searchBlocks: string[] = [];
  const inventoryItems: string[] = [];

  const addBlock = (blockName: string): void => {
    if (!mcData.blocksByName[blockName]) {
      return;
    }
    searchBlocks.push(blockName);
    if (mcData.itemsByName[blockName]) {
      inventoryItems.push(blockName);
    }

    const drops = mcData.blocksByName[blockName].drops;
    if (!Array.isArray(drops)) {
      return;
    }
    for (const dropId of drops) {
      const dropName = mcData.items?.[dropId]?.name;
      if (dropName) {
        inventoryItems.push(dropName);
      }
    }
  };

  if (target === "log" || target === "logs" || target === "wood" || target === "tree") {
    for (const blockName of Object.keys(mcData.blocksByName)) {
      if (blockName.endsWith("_log")) {
        addBlock(blockName);
      }
    }
  } else {
    addBlock(target);
  }

  const item = mcData.itemsByName[target];
  if (item) {
    inventoryItems.push(target);
    for (const blockName of Object.keys(mcData.blocksByName)) {
      const block = mcData.blocksByName[blockName];
      if (!Array.isArray(block.drops)) {
        continue;
      }
      if (block.drops.includes(item.id)) {
        addBlock(blockName);
      }
    }
  }

  return {
    searchBlocks: dedupe(searchBlocks),
    inventoryItems: dedupe(inventoryItems.length > 0 ? inventoryItems : [target]),
    label: target
  };
};

const countInventoryItems = (ctx: SkillExecutionContext, itemNames: string[]): number =>
  [...new Set(itemNames)].reduce((sum, itemName) => sum + countItem(ctx, itemName), 0);

const findNearestCollectBlock = (
  ctx: SkillExecutionContext,
  blockNames: string[],
  maxDistance: number
): any | null => {
  let best: any | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const blockName of blockNames) {
    const found = findNearestBlock(ctx, blockName, maxDistance);
    if (!found) {
      continue;
    }
    const distance = ctx.bot.entity.position.distanceTo(found.position);
    if (distance < bestDistance) {
      best = found;
      bestDistance = distance;
    }
  }

  return best;
};

export const collectSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const rawTarget = String(
    params.item ??
      params.block ??
      params.resource ??
      params.resource_type ??
      params.type ??
      ""
  );
  const desiredCount = Math.max(1, Math.floor(Number(params.count ?? params.amount ?? params.qty ?? 1) || 1));
  const maxDistance = Math.max(8, Math.floor(Number(params.max_distance ?? 48) || 48));

  if (!rawTarget) {
    return failure("DEPENDS_ON_ITEM", "collect requires item or block name", false);
  }

  const target = resolveCollectTarget(ctx, rawTarget);
  const current = countInventoryItems(ctx, target.inventoryItems);
  if (current >= desiredCount) {
    return success(`already has ${current}/${desiredCount} ${target.label}`);
  }

  const collector = ctx.bot.collectBlock?.collect;
  if (typeof collector !== "function") {
    return failure("DEPENDS_ON_ITEM", "collectblock plugin unavailable", false);
  }

  const block = findNearestCollectBlock(ctx, target.searchBlocks, maxDistance);
  if (!block) {
    return failure("RESOURCE_NOT_FOUND", `could not find ${target.label}`, true);
  }

  try {
    await collector([block]);
    const after = countInventoryItems(ctx, target.inventoryItems);
    if (after < desiredCount) {
      return failure(
        "RESOURCE_NOT_FOUND",
        `collected but below target: ${after}/${desiredCount} ${target.label}`,
        true
      );
    }
    return success(`collected ${target.label} to ${after}`, { gathered: after - current });
  } catch (error) {
    return asSkillFailure(error, "RESOURCE_NOT_FOUND");
  }
};
