import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, findNearestBlock, gotoCoordinates, success } from "./helpers";

const candidateBlocks = (ctx: SkillExecutionContext, rawTarget: string): string[] => {
  const target = rawTarget.trim().toLowerCase();
  const mcData = require("minecraft-data")(ctx.bot.version);
  const names = new Set<string>();
  const allLogNames = Object.keys(mcData.blocksByName).filter((name) => name.endsWith("_log"));

  if (target === "log" || target === "logs" || target === "wood" || target === "tree") {
    for (const blockName of allLogNames) {
      names.add(blockName);
    }
  } else if (mcData.blocksByName[target]) {
    names.add(target);
    // If planner specifies one log species (e.g. oak_log), allow any logs as fallback.
    if (target.endsWith("_log")) {
      for (const blockName of allLogNames) {
        names.add(blockName);
      }
    }
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

const isVisible = (ctx: SkillExecutionContext, block: any): boolean => {
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

const findCandidateBlocks = (
  ctx: SkillExecutionContext,
  names: string[],
  maxDistance: number,
  maxCount = 24
): any[] => {
  const nameSet = new Set(names.map((name) => name.toLowerCase()));
  const positions = ctx.bot.findBlocks({
    matching: (candidate: any) => nameSet.has(String(candidate?.name ?? "").toLowerCase()),
    maxDistance,
    count: maxCount
  });
  const blocks = positions
    .map((position: any) => ctx.bot.blockAt(position))
    .filter((block: any) => block && block.name !== "air");

  const visible: any[] = [];
  const hidden: any[] = [];
  for (const block of blocks) {
    if (isVisible(ctx, block)) {
      visible.push(block);
    } else {
      hidden.push(block);
    }
  }

  const byDistance = (a: any, b: any): number =>
    ctx.bot.entity.position.distanceTo(a.position) - ctx.bot.entity.position.distanceTo(b.position);

  visible.sort(byDistance);
  hidden.sort(byDistance);
  return [...visible, ...hidden];
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

  const names = candidateBlocks(ctx, blockName);
  const candidates = findCandidateBlocks(ctx, names, maxDistance);
  if (candidates.length === 0) {
    // fallback to old lookup path as a last resort
    const fallback = names.map((name) => findNearestBlock(ctx, name, maxDistance)).find(Boolean);
    if (!fallback) {
      return failure("RESOURCE_NOT_FOUND", `no ${blockName} within ${maxDistance} blocks`, true);
    }
    candidates.push(fallback);
  }

  const perCandidateTimeoutMs = Math.max(7000, Math.floor(Number(params.attempt_timeout_ms ?? 12000)));
  let lastError: unknown = null;

  for (const block of candidates) {
    try {
      await gotoCoordinates(
        ctx,
        block.position.x,
        block.position.y,
        block.position.z,
        2,
        perCandidateTimeoutMs
      );
      return success(`arrived near nearest ${blockName}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (!lastError) {
    return failure("RESOURCE_NOT_FOUND", `no ${blockName} within ${maxDistance} blocks`, true);
  }

  return asSkillFailure(lastError, "PATHFIND_FAILED");
};
