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
import { Vec3 } from "vec3";

interface CollectTargetSpec {
  searchBlocks: string[];
  inventoryItems: string[];
  label: string;
}

type CollectManualResult = "dug" | "cannot_dig" | "no_block";

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

const positionKey = (position: any): string =>
  `${Math.floor(Number(position?.x ?? 0))},${Math.floor(Number(position?.y ?? 0))},${Math.floor(
    Number(position?.z ?? 0)
  )}`;

const isLikelyDroppedItemEntity = (entity: any): boolean => {
  if (!entity?.position) {
    return false;
  }
  if (entity.type === "object") {
    return true;
  }
  const objectType = String(entity.objectType ?? "").toLowerCase();
  if (objectType.includes("item")) {
    return true;
  }
  const name = String(entity.name ?? "").toLowerCase();
  if (name === "item") {
    return true;
  }
  return false;
};

const findCollectCandidates = (
  ctx: SkillExecutionContext,
  blockNames: string[],
  maxDistance: number,
  maxCount = 24,
  failedCandidateCounts?: Map<string, number>
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

  const botY = Number(ctx.bot.entity?.position?.y ?? 0);
  return positions
    .map((position: any) => ctx.bot.blockAt(position))
    .filter((block: any) => block && block.name !== "air")
    .sort(
      (a: any, b: any) => {
        const distanceA = ctx.bot.entity.position.distanceTo(a.position);
        const distanceB = ctx.bot.entity.position.distanceTo(b.position);
        const yPenaltyA = Math.abs(Number(a.position?.y ?? botY) - botY) * 1.2;
        const yPenaltyB = Math.abs(Number(b.position?.y ?? botY) - botY) * 1.2;
        const failPenaltyA = (failedCandidateCounts?.get(positionKey(a.position)) ?? 0) * 10;
        const failPenaltyB = (failedCandidateCounts?.get(positionKey(b.position)) ?? 0) * 10;
        return distanceA + yPenaltyA + failPenaltyA - (distanceB + yPenaltyB + failPenaltyB);
      }
    );
};

const findNearestCollectBlock = (
  ctx: SkillExecutionContext,
  blockNames: string[],
  maxDistance: number,
  failedCandidateCounts?: Map<string, number>
): any | null => {
  const candidates = findCollectCandidates(ctx, blockNames, maxDistance, 24, failedCandidateCounts);
  const lessFailed = candidates.filter(
    (candidate) => (failedCandidateCounts?.get(positionKey(candidate.position)) ?? 0) < 3
  );
  const ordered = lessFailed.length > 0 ? lessFailed : candidates;

  for (const candidate of ordered) {
    if (isBlockVisible(ctx, candidate)) {
      return candidate;
    }
  }
  return ordered[0] ?? null;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const findLineOfSightObstruction = (ctx: SkillExecutionContext, targetBlock: any): any | null => {
  if (!targetBlock?.position || !ctx.bot?.entity?.position) {
    return null;
  }

  const eye = ctx.bot.entity.position.offset(0, Number(ctx.bot.entity.height ?? 1.62) * 0.9, 0);
  const targetCenter = targetBlock.position.offset(0.5, 0.5, 0.5);
  const direction = targetCenter.minus(eye);
  const distance = eye.distanceTo(targetCenter);
  if (!Number.isFinite(distance) || distance < 0.5) {
    return null;
  }

  const normal = direction.scaled(1 / distance);
  for (let traveled = 0.6; traveled < distance - 0.35; traveled += 0.35) {
    const sample = eye.plus(normal.scaled(traveled));
    const samplePos = new Vec3(Math.floor(sample.x), Math.floor(sample.y), Math.floor(sample.z));
    const block = ctx.bot.blockAt(samplePos);
    if (!block || block.name === "air") {
      continue;
    }
    if (positionKey(block.position) === positionKey(targetBlock.position)) {
      continue;
    }
    return block;
  }

  return null;
};

const nearbyDroppedItemEntities = (
  ctx: SkillExecutionContext,
  maxDistance: number,
  originPosition?: any
): any[] => {
  const entities = Object.values(ctx.bot.entities ?? {}) as Array<any>;
  const drops: any[] = [];
  const origin = originPosition ?? ctx.bot.entity.position;

  for (const entity of entities) {
    if (!isLikelyDroppedItemEntity(entity)) {
      continue;
    }
    const distance = origin.distanceTo(entity.position);
    if (!Number.isFinite(distance) || distance > maxDistance) {
      continue;
    }
    drops.push(entity);
  }

  drops.sort(
    (a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position)
  );
  return drops;
};

const waitForDropCollectedOrGone = async (
  ctx: SkillExecutionContext,
  dropId: number,
  timeoutMs = 900
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
    }, 80);

    timeoutTimer = setTimeout(() => settle(false), timeoutMs);
    ctx.bot.on("playerCollect", onPlayerCollect);
  });

const waitForInventoryGain = async (
  ctx: SkillExecutionContext,
  itemNames: string[],
  beforeCount: number,
  timeoutMs = 1200
): Promise<number> => {
  const startedAt = Date.now();
  let current = countInventoryItems(ctx, itemNames);
  while (Date.now() - startedAt < timeoutMs) {
    if (current > beforeCount) {
      return current;
    }
    await wait(80);
    current = countInventoryItems(ctx, itemNames);
  }
  return current;
};

const nudgeToward = async (ctx: SkillExecutionContext, position: any, durationMs = 350): Promise<void> => {
  try {
    await ctx.bot.lookAt(position, true);
  } catch {
    // ignore look failures
  }

  try {
    ctx.bot.setControlState("forward", true);
    if (Number(position?.y ?? 0) > Number(ctx.bot.entity?.position?.y ?? 0) + 0.35) {
      ctx.bot.setControlState("jump", true);
    }
    await wait(durationMs);
  } finally {
    try {
      ctx.bot.setControlState("forward", false);
      ctx.bot.setControlState("jump", false);
    } catch {
      // ignore
    }
  }
};

const sweepNearbyDrops = async (
  ctx: SkillExecutionContext,
  maxDistance = 9,
  maxPasses = 6,
  expectedItems: string[] = [],
  centerPosition?: any
): Promise<void> => {
  const seenDropIds = new Set<number>();
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const drops = nearbyDroppedItemEntities(ctx, maxDistance);
    if (centerPosition) {
      const centeredDrops = nearbyDroppedItemEntities(ctx, maxDistance, centerPosition);
      for (const drop of centeredDrops) {
        if (!drops.some((candidate) => candidate.id === drop.id)) {
          drops.push(drop);
        }
      }
    }
    if (drops.length === 0) {
      return;
    }
    let progressed = false;
    const before = countInventoryItems(ctx, expectedItems);

    for (const drop of drops.slice(0, 12)) {
      if (seenDropIds.has(drop.id)) {
        continue;
      }
      seenDropIds.add(drop.id);
      try {
        try {
          await gotoCoordinates(
            ctx,
            drop.position.x,
            drop.position.y,
            drop.position.z,
            1,
            4000
          );
        } catch {
          await nudgeToward(ctx, drop.position, 450);
        }
        const collected = await waitForDropCollectedOrGone(ctx, drop.id, 900);
        if (collected) {
          progressed = true;
        }
        await wait(60);
      } catch {
        continue;
      }
    }

    const after = countInventoryItems(ctx, expectedItems);
    if (after > before) {
      progressed = true;
    }

    if (!progressed) {
      await wait(120);
      seenDropIds.clear();
    }
  }
};

const clearLineOfSightToBlock = async (
  ctx: SkillExecutionContext,
  targetBlock: any,
  expectedItems: string[],
  maxClearBlocks = 4
): Promise<"visible" | "blocked"> => {
  if (isBlockVisible(ctx, targetBlock)) {
    return "visible";
  }

  for (let attempt = 0; attempt < maxClearBlocks; attempt += 1) {
    const refreshedTarget = ctx.bot.blockAt(targetBlock.position);
    if (!refreshedTarget || refreshedTarget.name === "air") {
      return "blocked";
    }
    if (isBlockVisible(ctx, refreshedTarget)) {
      return "visible";
    }

    const obstruction = findLineOfSightObstruction(ctx, refreshedTarget);
    if (!obstruction || obstruction.name === "air") {
      return "blocked";
    }

    try {
      await gotoCoordinates(ctx, obstruction.position.x, obstruction.position.y, obstruction.position.z, 3, 4500);
    } catch {
      return "blocked";
    }

    const digTarget = ctx.bot.blockAt(obstruction.position);
    if (!digTarget || digTarget.name === "air") {
      continue;
    }

    if (typeof ctx.bot.canDigBlock === "function" && !ctx.bot.canDigBlock(digTarget)) {
      return "blocked";
    }

    try {
      await equipBestToolForBlock(ctx, digTarget, false);
      await ctx.bot.dig(digTarget, true);
      await wait(180);
      await sweepNearbyDrops(ctx, 10, 3, expectedItems, digTarget.position);
    } catch {
      return "blocked";
    }
  }

  const after = ctx.bot.blockAt(targetBlock.position);
  if (after && after.name !== "air" && isBlockVisible(ctx, after)) {
    return "visible";
  }
  return "blocked";
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

const tryManualDig = async (
  ctx: SkillExecutionContext,
  block: any,
  expectedItems: string[]
): Promise<CollectManualResult> => {
  try {
    await gotoCoordinates(ctx, block.position.x, block.position.y, block.position.z, 3, 8000);
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
    const beforeCount = countInventoryItems(ctx, expectedItems);
    const expectedBlockName = String(refreshed.name ?? "");
    try {
      await ctx.bot.dig(refreshed, true);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (message.includes("blockupdate") || message.includes("timeout")) {
        const post = ctx.bot.blockAt(refreshed.position);
        if (post && post.name === expectedBlockName) {
          return "no_block";
        }
      } else {
        throw error;
      }
    }
    await wait(280);
    await sweepNearbyDrops(ctx, 12, 8, expectedItems, refreshed.position);
    await waitForInventoryGain(ctx, expectedItems, beforeCount, 1200);
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
  const lineOfSightClearLimit = Math.max(0, Math.floor(Number(params.los_clear_limit ?? 4) || 4));

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
  const perAttemptTimeoutMs = Math.max(3000, Number(params.attempt_timeout_ms ?? 9000));
  const missLimit = Math.max(3, Math.floor(Number(params.miss_limit ?? 8) || 8));
  const noProgressLimit = Math.max(3, Math.floor(Number(params.no_progress_limit ?? 10) || 10));
  const maxAttempts = Math.max(12, desiredCount * 6);
  let after = current;
  let attempts = 0;
  let misses = 0;
  let noProgressAttempts = 0;
  let lastErrorDetail = "";
  const failedCandidateCounts = new Map<string, number>();

  while (Date.now() < deadlineMs && after < desiredCount) {
    let block = findNearestCollectBlock(ctx, target.searchBlocks, maxDistance, failedCandidateCounts);
    if (!block) {
      misses += 1;
      if (misses >= missLimit) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
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
          6000
        );
      } catch {
        misses += 1;
        await wait(120);
        continue;
      }
      const refreshed = ctx.bot.blockAt(block.position);
      if (!refreshed || refreshed.name === "air") {
        misses += 1;
        await wait(120);
        continue;
      }
      if (!isBlockVisible(ctx, refreshed)) {
        const losResult = await clearLineOfSightToBlock(
          ctx,
          refreshed,
          target.inventoryItems,
          lineOfSightClearLimit
        );
        const postClear = ctx.bot.blockAt(refreshed.position);
        if (!postClear || postClear.name === "air") {
          misses += 1;
          failedCandidateCounts.set(positionKey(refreshed.position), (failedCandidateCounts.get(positionKey(refreshed.position)) ?? 0) + 1);
          await wait(120);
          continue;
        }
        if (losResult !== "visible" && !isBlockVisible(ctx, postClear)) {
          misses += 1;
          failedCandidateCounts.set(positionKey(postClear.position), (failedCandidateCounts.get(positionKey(postClear.position)) ?? 0) + 1);
          await wait(120);
          continue;
        }
        block = postClear;
      } else {
        block = refreshed;
      }
    }

    try {
      await equipBestToolForBlock(ctx, block, false);

      const beforeAttempt = after;
      const blockPosKey = positionKey(block.position);
      if (shouldPreferManualDig(target, block)) {
        const manualResult = await tryManualDig(ctx, block, target.inventoryItems);
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
            await sweepNearbyDrops(ctx, 12, 8, target.inventoryItems, block.position);
            after = await waitForInventoryGain(ctx, target.inventoryItems, beforeAttempt, 1200);
          }
          if (after <= beforeAttempt) {
            noProgressAttempts += 1;
            failedCandidateCounts.set(blockPosKey, (failedCandidateCounts.get(blockPosKey) ?? 0) + 1);
          } else {
            noProgressAttempts = 0;
            failedCandidateCounts.delete(blockPosKey);
          }
          if (noProgressAttempts >= noProgressLimit) {
            break;
          }
          continue;
        }
      }

      await withTimeout(collector([block]), perAttemptTimeoutMs);
      await sweepNearbyDrops(ctx, 12, 8, target.inventoryItems, block.position);
      await wait(80);
      attempts += 1;
      misses = 0;
      after = countInventoryItems(ctx, target.inventoryItems);

      if (after <= beforeAttempt) {
        const manualResult = await tryManualDig(ctx, block, target.inventoryItems);
        if (manualResult === "cannot_dig") {
          return failure(
            "RESOURCE_NOT_FOUND",
            `cannot dig ${block.name} at ${block.position?.x},${block.position?.y},${block.position?.z} (spawn-protection or permissions)`,
            false
          );
        }
        if (manualResult === "dug") {
          await sweepNearbyDrops(ctx, 12, 8, target.inventoryItems, block.position);
          after = await waitForInventoryGain(ctx, target.inventoryItems, beforeAttempt, 1200);
        }
      }

      if (after <= beforeAttempt) {
        noProgressAttempts += 1;
        failedCandidateCounts.set(blockPosKey, (failedCandidateCounts.get(blockPosKey) ?? 0) + 1);
      } else {
        noProgressAttempts = 0;
        failedCandidateCounts.delete(blockPosKey);
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

      const manualResult = await tryManualDig(ctx, block, target.inventoryItems);
      if (manualResult === "cannot_dig") {
        return failure(
          "RESOURCE_NOT_FOUND",
          `cannot dig ${block.name} at ${block.position?.x},${block.position?.y},${block.position?.z} (spawn-protection or permissions)`,
          false
        );
      }
      if (manualResult === "dug") {
        await sweepNearbyDrops(ctx, 12, 8, target.inventoryItems, block.position);
        await wait(80);
        attempts += 1;
        misses = 0;
        const beforeManualCount = after;
        after = await waitForInventoryGain(ctx, target.inventoryItems, beforeManualCount, 1200);
        if (after <= beforeManualCount) {
          noProgressAttempts += 1;
          failedCandidateCounts.set(positionKey(block.position), (failedCandidateCounts.get(positionKey(block.position)) ?? 0) + 1);
        } else {
          noProgressAttempts = 0;
          failedCandidateCounts.delete(positionKey(block.position));
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
      await new Promise((resolve) => setTimeout(resolve, 180));
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
