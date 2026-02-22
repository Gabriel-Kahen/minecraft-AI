import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, countItem, failure, findNearestBlock, gotoCoordinates, success } from "./helpers";
import { getMcData } from "../utils/mc-data";

interface CollectTargetSpec {
  searchBlocks: string[];
  inventoryItems: string[];
  label: string;
}

const dedupe = (values: string[]): string[] => [...new Set(values)];

const resolveCollectTarget = (ctx: SkillExecutionContext, rawTarget: string): CollectTargetSpec => {
  const target = rawTarget.trim().toLowerCase();
  const mcData = getMcData(ctx.bot.version);
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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tryManualDig = async (ctx: SkillExecutionContext, block: any): Promise<"dug" | "cannot_dig" | "no_block"> => {
  try {
    await gotoCoordinates(ctx, block.position.x, block.position.y, block.position.z, 3, 15000);
  } catch {
    return "no_block";
  }

  const refreshed = ctx.bot.blockAt(block.position);
  if (!refreshed || refreshed.name === "air") {
    return "no_block";
  }

  if (typeof ctx.bot.canDigBlock === "function" && !ctx.bot.canDigBlock(refreshed)) {
    return "cannot_dig";
  }

  try {
    await ctx.bot.dig(refreshed);
    await wait(700);
    return "dug";
  } catch {
    return "no_block";
  }
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

  const deadlineMs = Date.now() + Math.max(15000, Number(params.timeout_ms ?? 90000));
  let after = current;
  let attempts = 0;
  let misses = 0;
  let noProgressAttempts = 0;

  while (Date.now() < deadlineMs && after < desiredCount) {
    const block = findNearestCollectBlock(ctx, target.searchBlocks, maxDistance);
    if (!block) {
      misses += 1;
      if (misses >= 3) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      continue;
    }

    try {
      if (typeof ctx.bot.canDigBlock === "function" && !ctx.bot.canDigBlock(block)) {
        return failure(
          "RESOURCE_NOT_FOUND",
          `cannot dig ${block.name} at ${block.position?.x},${block.position?.y},${block.position?.z} (spawn-protection or permissions)`,
          false
        );
      }

      const beforeAttempt = after;
      await collector([block]);
      attempts += 1;
      misses = 0;
      after = countInventoryItems(ctx, target.inventoryItems);

      if (after <= beforeAttempt) {
        const manualResult = await tryManualDig(ctx, block);
        if (manualResult === "cannot_dig") {
          return failure(
            "RESOURCE_NOT_FOUND",
            `cannot dig ${block.name} at ${block.position?.x},${block.position?.y},${block.position?.z} (spawn-protection or permissions)`,
            false
          );
        }
        if (manualResult === "dug") {
          after = countInventoryItems(ctx, target.inventoryItems);
        }
      }

      if (after <= beforeAttempt) {
        noProgressAttempts += 1;
      } else {
        noProgressAttempts = 0;
      }

      if (attempts >= Math.max(6, desiredCount * 3) && after <= current) {
        break;
      }
      if (noProgressAttempts >= 4) {
        break;
      }
    } catch (error) {
      const mapped = asSkillFailure(error, "RESOURCE_NOT_FOUND");
      const detailsLower = mapped.details.toLowerCase();
      if (
        detailsLower.includes("cannot dig") ||
        detailsLower.includes("not diggable") ||
        detailsLower.includes("spawn") ||
        detailsLower.includes("permission")
      ) {
        return failure("RESOURCE_NOT_FOUND", mapped.details, false);
      }
      if (!mapped.retryable) {
        return mapped;
      }
      attempts += 1;
      if (attempts >= Math.max(6, desiredCount * 3)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  if (after < desiredCount) {
    return failure(
      "RESOURCE_NOT_FOUND",
      `collected ${after}/${desiredCount} ${target.label} before timeout (attempts=${attempts}, no_progress=${noProgressAttempts})`,
      true
    );
  }
  return success(`collected ${target.label} to ${after}`, { gathered: after - current });
};
