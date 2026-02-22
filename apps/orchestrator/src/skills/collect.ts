import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import {
  asSkillFailure,
  countItem,
  equipBestToolForBlock,
  failure,
  gotoCoordinates,
  withTimeout,
  success
} from "./helpers";
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

const isBlockVisible = (ctx: SkillExecutionContext, block: any): boolean => {
  if (!block) {
    return false;
  }
  if (typeof ctx.bot.canSeeBlock !== "function") {
    return true;
  }
  try {
    return ctx.bot.canSeeBlock(block);
  } catch {
    return false;
  }
};

const findCollectCandidates = (
  ctx: SkillExecutionContext,
  blockNames: string[],
  maxDistance: number,
  maxCount = 24
): any[] => {
  if (blockNames.length === 0) {
    return [];
  }

  const blockNameSet = new Set(blockNames.map((name) => name.toLowerCase()));
  const positions = ctx.bot.findBlocks({
    matching: (candidate: any) => blockNameSet.has(String(candidate?.name ?? "").toLowerCase()),
    maxDistance,
    count: maxCount
  });

  return positions
    .map((position: any) => ctx.bot.blockAt(position))
    .filter((block: any) => block && block.name !== "air")
    .sort(
      (a: any, b: any) =>
        ctx.bot.entity.position.distanceTo(a.position) - ctx.bot.entity.position.distanceTo(b.position)
    );
};

const findNearestCollectBlock = (
  ctx: SkillExecutionContext,
  blockNames: string[],
  maxDistance: number
): any | null => {
  const candidates = findCollectCandidates(ctx, blockNames, maxDistance);
  for (const candidate of candidates) {
    if (isBlockVisible(ctx, candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? null;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const nearbyDroppedItemEntities = (ctx: SkillExecutionContext, maxDistance: number): any[] => {
  const entities = Object.values(ctx.bot.entities ?? {}) as Array<any>;
  const drops: any[] = [];

  for (const entity of entities) {
    if (!entity?.position) {
      continue;
    }
    if (entity.type !== "object") {
      continue;
    }
    const distance = ctx.bot.entity.position.distanceTo(entity.position);
    if (!Number.isFinite(distance) || distance > maxDistance) {
      continue;
    }
    drops.push(entity);
  }

  drops.sort(
    (a, b) =>
      ctx.bot.entity.position.distanceTo(a.position) - ctx.bot.entity.position.distanceTo(b.position)
  );
  return drops;
};

const waitForDropCollectedOrGone = async (
  ctx: SkillExecutionContext,
  dropId: number,
  timeoutMs = 1800
): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      ctx.bot.removeListener("playerCollect", onPlayerCollect);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const settle = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const onPlayerCollect = (collector: any, collected: any): void => {
      if (collector?.id !== ctx.bot.entity?.id) {
        return;
      }
      if (collected?.id === dropId) {
        settle(true);
      }
    };

    pollTimer = setInterval(() => {
      const refreshed = (ctx.bot.entities ?? {})[dropId];
      if (!refreshed) {
        settle(true);
      }
    }, 120);

    timeoutTimer = setTimeout(() => settle(false), timeoutMs);
    ctx.bot.on("playerCollect", onPlayerCollect);
  });

const sweepNearbyDrops = async (
  ctx: SkillExecutionContext,
  maxDistance = 9,
  maxPasses = 6
): Promise<void> => {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const drops = nearbyDroppedItemEntities(ctx, maxDistance);
    if (drops.length === 0) {
      return;
    }
    let progressed = false;

    for (const drop of drops.slice(0, 8)) {
      try {
        await gotoCoordinates(
          ctx,
          drop.position.x,
          drop.position.y,
          drop.position.z,
          1,
          7000
        );
        const collected = await waitForDropCollectedOrGone(ctx, drop.id, 1800);
        if (collected) {
          progressed = true;
        }
        await wait(120);
      } catch {
        continue;
      }
    }

    if (!progressed) {
      await wait(250);
    }
  }
};

const shouldPreferManualDig = (target: CollectTargetSpec, block: any): boolean => {
  const name = String(block?.name ?? "");
  if (name.endsWith("_log")) {
    return true;
  }
  if (target.label === "log" || target.label === "logs" || target.label === "wood" || target.label === "tree") {
    return true;
  }
  return false;
};

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
  if (!isBlockVisible(ctx, refreshed)) {
    return "no_block";
  }

  if (typeof ctx.bot.canDigBlock === "function" && !ctx.bot.canDigBlock(refreshed)) {
    return "cannot_dig";
  }

  try {
    await equipBestToolForBlock(ctx, refreshed, false);
    await ctx.bot.dig(refreshed);
    await wait(900);
    await sweepNearbyDrops(ctx);
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
  const perAttemptTimeoutMs = Math.max(5000, Number(params.attempt_timeout_ms ?? 15000));
  const missLimit = Math.max(3, Math.floor(Number(params.miss_limit ?? 8) || 8));
  const noProgressLimit = Math.max(3, Math.floor(Number(params.no_progress_limit ?? 10) || 10));
  const maxAttempts = Math.max(12, desiredCount * 6);
  let after = current;
  let attempts = 0;
  let misses = 0;
  let noProgressAttempts = 0;
  let lastErrorDetail = "";

  while (Date.now() < deadlineMs && after < desiredCount) {
    let block = findNearestCollectBlock(ctx, target.searchBlocks, maxDistance);
    if (!block) {
      misses += 1;
      if (misses >= missLimit) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      continue;
    }

    if (!isBlockVisible(ctx, block)) {
      try {
        await gotoCoordinates(
          ctx,
          block.position.x,
          block.position.y,
          block.position.z,
          2,
          12000
        );
      } catch {
        misses += 1;
        await wait(350);
        continue;
      }
      const refreshed = ctx.bot.blockAt(block.position);
      if (!refreshed || refreshed.name === "air" || !isBlockVisible(ctx, refreshed)) {
        misses += 1;
        await wait(350);
        continue;
      }
      block = refreshed;
    }

    try {
      await equipBestToolForBlock(ctx, block, false);

      const beforeAttempt = after;
      if (shouldPreferManualDig(target, block)) {
        const manualResult = await tryManualDig(ctx, block);
        if (manualResult === "cannot_dig") {
          return failure(
            "RESOURCE_NOT_FOUND",
            `cannot dig ${block.name} at ${block.position?.x},${block.position?.y},${block.position?.z} (spawn-protection or permissions)`,
            false
          );
        }
        if (manualResult === "dug") {
          attempts += 1;
          misses = 0;
          after = countInventoryItems(ctx, target.inventoryItems);
          if (after <= beforeAttempt) {
            await sweepNearbyDrops(ctx);
            await wait(350);
            after = countInventoryItems(ctx, target.inventoryItems);
          }
          if (after <= beforeAttempt) {
            noProgressAttempts += 1;
          } else {
            noProgressAttempts = 0;
          }
          if (noProgressAttempts >= noProgressLimit) {
            break;
          }
          continue;
        }
      }

      await withTimeout(collector([block]), perAttemptTimeoutMs);
      await sweepNearbyDrops(ctx);
      await wait(300);
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
          await sweepNearbyDrops(ctx);
          await wait(300);
          after = countInventoryItems(ctx, target.inventoryItems);
        }
      }

      if (after <= beforeAttempt) {
        noProgressAttempts += 1;
      } else {
        noProgressAttempts = 0;
      }

      if (attempts >= maxAttempts && after <= current) {
        break;
      }
      if (noProgressAttempts >= noProgressLimit) {
        break;
      }
    } catch (error) {
      const mapped =
        error instanceof Error && error.message === "timeout"
          ? failure(
              "RESOURCE_NOT_FOUND",
              `collect attempt timed out after ${perAttemptTimeoutMs}ms`,
              true
            )
          : asSkillFailure(error, "RESOURCE_NOT_FOUND");
      lastErrorDetail = mapped.details;
      const detailsLower = mapped.details.toLowerCase();
      if (
        detailsLower.includes("cannot dig") ||
        detailsLower.includes("not diggable") ||
        detailsLower.includes("spawn") ||
        detailsLower.includes("permission")
      ) {
        return failure("RESOURCE_NOT_FOUND", mapped.details, false);
      }

      const manualResult = await tryManualDig(ctx, block);
      if (manualResult === "cannot_dig") {
        return failure(
          "RESOURCE_NOT_FOUND",
          `cannot dig ${block.name} at ${block.position?.x},${block.position?.y},${block.position?.z} (spawn-protection or permissions)`,
          false
        );
      }
      if (manualResult === "dug") {
        await sweepNearbyDrops(ctx);
        await wait(300);
        attempts += 1;
        misses = 0;
        const beforeManualCount = after;
        after = countInventoryItems(ctx, target.inventoryItems);
        if (after <= beforeManualCount) {
          noProgressAttempts += 1;
        } else {
          noProgressAttempts = 0;
        }
        if (noProgressAttempts >= noProgressLimit) {
          break;
        }
        continue;
      }

      if (!mapped.retryable) {
        return mapped;
      }
      attempts += 1;
      noProgressAttempts += 1;
      if (attempts >= maxAttempts) {
        break;
      }
      if (noProgressAttempts >= noProgressLimit) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  if (after < desiredCount) {
    return failure(
      "RESOURCE_NOT_FOUND",
      `collected ${after}/${desiredCount} ${target.label} before timeout (attempts=${attempts}, no_progress=${noProgressAttempts}, last_error=${lastErrorDetail || "none"})`,
      true
    );
  }
  return success(`collected ${target.label} to ${after}`, { gathered: after - current });
};
