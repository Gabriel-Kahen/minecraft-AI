import type { PlannerSubgoal } from "../../../../contracts/planner";
import type { SnapshotV1 } from "../../../../contracts/snapshot";

export interface GuardResult {
  subgoals: PlannerSubgoal[];
  notes: string[];
}

export interface AutonomousPlan {
  reason: string;
  subgoals: PlannerSubgoal[];
}

export interface ProgressionHint {
  recommendedGoal: string;
  recommendedSubgoals: Array<{ name: PlannerSubgoal["name"]; params: Record<string, unknown> }>;
  capabilityGaps: string[];
  actionableResources: string[];
}

interface RecipePlan {
  recipe: any;
  ingredients: Map<string, number>;
  resultCount: number;
  needsTable: boolean;
  ingredientUnits: number;
}

interface PlanningContext {
  mcData: any;
  snapshot: SnapshotV1;
  projected: Map<string, number>;
  nearbyResourceDistance: Map<string, number>;
  nearbyPoiDistance: Map<string, number>;
}

const mcDataCache = new Map<string, any>();

const getMcData = (version: string): any => {
  const cached = mcDataCache.get(version);
  if (cached) {
    return cached;
  }
  const loaded = require("minecraft-data")(version);
  mcDataCache.set(version, loaded);
  return loaded;
};

const positiveInt = (value: unknown, fallback = 1): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const buildProjectedInventory = (snapshot: SnapshotV1): Map<string, number> => {
  const projected = new Map<string, number>();
  for (const [name, count] of Object.entries(snapshot.inventory_summary.key_items)) {
    projected.set(name, (projected.get(name) ?? 0) + count);
  }
  for (const [name, count] of Object.entries(snapshot.inventory_summary.tools)) {
    projected.set(name, (projected.get(name) ?? 0) + count);
  }
  return projected;
};

const buildNearbyResourceDistance = (snapshot: SnapshotV1): Map<string, number> => {
  const map = new Map<string, number>();
  for (const resource of snapshot.nearby_summary.resources) {
    const existing = map.get(resource.type);
    if (existing === undefined || resource.distance < existing) {
      map.set(resource.type, resource.distance);
    }
  }
  return map;
};

const buildNearbyPoiDistance = (snapshot: SnapshotV1): Map<string, number> => {
  const map = new Map<string, number>();
  for (const poi of snapshot.nearby_summary.points_of_interest) {
    const existing = map.get(poi.type);
    if (existing === undefined || poi.distance < existing) {
      map.set(poi.type, poi.distance);
    }
  }
  return map;
};

const hasNearbyPoi = (ctx: PlanningContext, poiName: string, maxDistance: number): boolean => {
  const distance = ctx.nearbyPoiDistance.get(poiName);
  return distance !== undefined && distance <= maxDistance;
};

const hasItem = (ctx: PlanningContext, itemName: string, count = 1): boolean =>
  (ctx.projected.get(itemName) ?? 0) >= count;

const addProjected = (ctx: PlanningContext, itemName: string, count: number): void => {
  ctx.projected.set(itemName, (ctx.projected.get(itemName) ?? 0) + count);
};

const parseToolRank = (itemName: string): { known: boolean; materialRank: number } => {
  const match = itemName.match(/^(wooden|stone|iron|diamond|netherite|golden)_(pickaxe|axe|shovel|hoe)$/);
  if (!match) {
    return { known: false, materialRank: Number.MAX_SAFE_INTEGER };
  }
  const material = match[1];
  const rankMap: Record<string, number> = {
    wooden: 0,
    stone: 1,
    iron: 2,
    diamond: 3,
    netherite: 4,
    golden: 5
  };
  return {
    known: true,
    materialRank: rankMap[material] ?? Number.MAX_SAFE_INTEGER
  };
};

const requiredToolForBlock = (ctx: PlanningContext, blockName: string): string | null => {
  const block = ctx.mcData.blocksByName[blockName];
  const harvestTools = block?.harvestTools as Record<string, boolean> | undefined;
  if (!harvestTools || Object.keys(harvestTools).length === 0) {
    return null;
  }

  const candidates = Object.keys(harvestTools)
    .map((id) => ctx.mcData.items?.[Number(id)]?.name as string | undefined)
    .filter((name): name is string => Boolean(name));
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const a = parseToolRank(left);
    const b = parseToolRank(right);
    if (a.known !== b.known) {
      return a.known ? -1 : 1;
    }
    if (a.materialRank !== b.materialRank) {
      return a.materialRank - b.materialRank;
    }
    return left.localeCompare(right);
  });

  return candidates[0] ?? null;
};

const recipeNeedsTable = (recipe: any): boolean => {
  if (Array.isArray(recipe.inShape)) {
    const rows = recipe.inShape.length;
    const columns = recipe.inShape.reduce(
      (max: number, row: unknown) => Math.max(max, Array.isArray(row) ? row.length : 0),
      0
    );
    return rows > 2 || columns > 2;
  }
  if (Array.isArray(recipe.ingredients)) {
    return recipe.ingredients.length > 4;
  }
  return false;
};

const parseIngredients = (mcData: any, recipe: any): Map<string, number> => {
  const byId = new Map<number, number>();
  const pushValue = (value: unknown): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === "number") {
      byId.set(value, (byId.get(value) ?? 0) + 1);
      return;
    }
    if (typeof value === "object") {
      const raw = value as { id?: unknown; count?: unknown };
      if (typeof raw.id === "number") {
        byId.set(raw.id, (byId.get(raw.id) ?? 0) + positiveInt(raw.count, 1));
      }
    }
  };

  if (Array.isArray(recipe.ingredients)) {
    for (const ingredient of recipe.ingredients) {
      pushValue(ingredient);
    }
  }
  if (Array.isArray(recipe.inShape)) {
    for (const row of recipe.inShape) {
      if (!Array.isArray(row)) {
        continue;
      }
      for (const ingredient of row) {
        pushValue(ingredient);
      }
    }
  }

  const byName = new Map<string, number>();
  for (const [id, count] of byId) {
    const itemName =
      mcData.items?.[id]?.name ??
      mcData.itemsByName?.[mcData.blocks?.[id]?.name ?? ""]?.name;
    if (!itemName) {
      continue;
    }
    byName.set(itemName, (byName.get(itemName) ?? 0) + count);
  }
  return byName;
};

const parseResultCount = (recipe: any): number => positiveInt(recipe?.result?.count, 1);

const pickRecipePlan = (
  ctx: PlanningContext,
  itemName: string
): RecipePlan | null => {
  const item = ctx.mcData.itemsByName[itemName];
  if (!item) {
    return null;
  }

  const recipes = (ctx.mcData.recipes?.[item.id] ?? []) as any[];
  if (recipes.length === 0) {
    return null;
  }

  const tableAccessible =
    hasItem(ctx, "crafting_table", 1) || hasNearbyPoi(ctx, "crafting_table", 8);

  const ranked = recipes
    .map((recipe) => {
      const ingredients = parseIngredients(ctx.mcData, recipe);
      const ingredientUnits = [...ingredients.values()].reduce((sum, units) => sum + units, 0);
      const missingUnits = [...ingredients.entries()].reduce((sum, [ingredientName, needed]) => {
        const have = ctx.projected.get(ingredientName) ?? 0;
        return sum + Math.max(0, needed - have);
      }, 0);
      const needsTable = recipeNeedsTable(recipe);
      const tablePenalty = needsTable && !tableAccessible ? 3 : 0;
      const score = missingUnits + tablePenalty;
      return {
        recipe,
        ingredients,
        ingredientUnits,
        resultCount: parseResultCount(recipe),
        needsTable,
        score
      };
    })
    .sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      if (a.needsTable !== b.needsTable) {
        return a.needsTable ? 1 : -1;
      }
      return a.ingredientUnits - b.ingredientUnits;
    });

  const best = ranked[0];
  if (!best) {
    return null;
  }

  return {
    recipe: best.recipe,
    ingredients: best.ingredients,
    resultCount: best.resultCount,
    needsTable: best.needsTable,
    ingredientUnits: best.ingredientUnits
  };
};

const sourceBlocksForItem = (ctx: PlanningContext, itemName: string): string[] => {
  const names = new Set<string>();
  if (ctx.mcData.blocksByName[itemName]) {
    names.add(itemName);
  }

  const item = ctx.mcData.itemsByName[itemName];
  if (!item) {
    return [...names];
  }

  for (const block of Object.values(ctx.mcData.blocksByName) as any[]) {
    if (!Array.isArray(block.drops)) {
      continue;
    }
    if (block.drops.includes(item.id)) {
      names.add(block.name);
    }
  }

  return [...names];
};

const chooseSourceBlock = (ctx: PlanningContext, itemName: string): string | null => {
  const candidates = sourceBlocksForItem(ctx, itemName);
  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates
    .map((blockName) => {
      const requiredTool = requiredToolForBlock(ctx, blockName);
      const canMineNow = !requiredTool || hasItem(ctx, requiredTool, 1);
      const distance = ctx.nearbyResourceDistance.get(blockName) ?? 9999;
      return { blockName, canMineNow, distance };
    })
    .sort((a, b) => {
      if (a.canMineNow !== b.canMineNow) {
        return a.canMineNow ? -1 : 1;
      }
      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }
      return a.blockName.localeCompare(b.blockName);
    });

  return scored[0]?.blockName ?? null;
};

const primaryDroppedItemForBlock = (ctx: PlanningContext, blockName: string): string | null => {
  const block = ctx.mcData.blocksByName[blockName];
  if (!block) {
    return null;
  }

  if (Array.isArray(block.drops) && block.drops.length > 0) {
    const firstDrop = block.drops[0];
    const itemName = ctx.mcData.items?.[firstDrop]?.name as string | undefined;
    if (itemName) {
      return itemName;
    }
  }

  if (ctx.mcData.itemsByName[blockName]) {
    return blockName;
  }

  return null;
};

const targetNameFromSubgoal = (subgoal: PlannerSubgoal): string => {
  return String(
    subgoal.params.item ??
      subgoal.params.block ??
      subgoal.params.resource ??
      subgoal.params.resource_type ??
      subgoal.params.type ??
      ""
  );
};

const resolveBlockFromTarget = (ctx: PlanningContext, targetName: string): string | null => {
  if (!targetName) {
    return null;
  }
  if (ctx.mcData.blocksByName[targetName]) {
    return targetName;
  }
  const fromItem = chooseSourceBlock(ctx, targetName);
  return fromItem;
};

const planAcquireItem = (
  ctx: PlanningContext,
  itemName: string,
  desiredCount: number,
  notes: string[],
  stack = new Set<string>(),
  depth = 0
): PlannerSubgoal[] => {
  if (desiredCount <= 0 || hasItem(ctx, itemName, desiredCount)) {
    return [];
  }
  if (depth > 8 || stack.has(itemName)) {
    notes.push(`dependency_cycle_or_depth_limit_${itemName}`);
    return [];
  }

  const shortage = Math.max(0, desiredCount - (ctx.projected.get(itemName) ?? 0));
  if (shortage === 0) {
    return [];
  }

  stack.add(itemName);
  const subgoals: PlannerSubgoal[] = [];

  const recipePlan = pickRecipePlan(ctx, itemName);
  if (recipePlan) {
    if (recipePlan.needsTable && itemName !== "crafting_table") {
      const hasTableAccess =
        hasItem(ctx, "crafting_table", 1) || hasNearbyPoi(ctx, "crafting_table", 8);
      if (!hasTableAccess) {
        const tablePlan = planAcquireItem(ctx, "crafting_table", 1, notes, stack, depth + 1);
        subgoals.push(...tablePlan);
      }
    }

    const craftsNeeded = Math.max(1, Math.ceil(shortage / recipePlan.resultCount));
    for (const [ingredientName, units] of recipePlan.ingredients.entries()) {
      const ingredientNeeded = units * craftsNeeded;
      const ingredientPlan = planAcquireItem(
        ctx,
        ingredientName,
        ingredientNeeded,
        notes,
        stack,
        depth + 1
      );
      subgoals.push(...ingredientPlan);
    }

    subgoals.push({
      name: "craft",
      params: {
        item: itemName,
        count: shortage
      },
      success_criteria: { item_count_gte: desiredCount }
    });
    addProjected(ctx, itemName, craftsNeeded * recipePlan.resultCount);
    stack.delete(itemName);
    return subgoals;
  }

  const sourceBlock = chooseSourceBlock(ctx, itemName);
  if (!sourceBlock) {
    notes.push(`unresolved_dependency_${itemName}`);
    stack.delete(itemName);
    return subgoals;
  }

  const requiredTool = requiredToolForBlock(ctx, sourceBlock);
  if (requiredTool && !hasItem(ctx, requiredTool, 1)) {
    const toolPlan = planAcquireItem(ctx, requiredTool, 1, notes, stack, depth + 1);
    subgoals.push(...toolPlan);
  }

  subgoals.push({
    name: "goto_nearest",
    params: {
      block: sourceBlock,
      max_distance: 64
    },
    success_criteria: { found: true }
  });
  subgoals.push({
    name: "collect",
    params: {
      item: itemName,
      count: shortage
    },
    success_criteria: { item_count_gte: desiredCount }
  });
  addProjected(ctx, itemName, shortage);
  stack.delete(itemName);
  return subgoals;
};

const applyProjectedOutcome = (ctx: PlanningContext, subgoal: PlannerSubgoal): void => {
  if (subgoal.name === "craft" || subgoal.name === "withdraw") {
    const itemName = String(subgoal.params.item ?? subgoal.params.type ?? "");
    const count = positiveInt(subgoal.params.count ?? subgoal.params.amount ?? subgoal.params.qty, 1);
    if (itemName) {
      addProjected(ctx, itemName, count);
    }
    return;
  }

  if (subgoal.name === "collect") {
    const targetName = targetNameFromSubgoal(subgoal);
    const blockName = resolveBlockFromTarget(ctx, targetName);
    const collectedItem =
      (blockName ? primaryDroppedItemForBlock(ctx, blockName) : null) ??
      (ctx.mcData.itemsByName[targetName] ? targetName : null);
    if (!collectedItem) {
      return;
    }
    const count = positiveInt(subgoal.params.count ?? subgoal.params.amount ?? subgoal.params.qty, 1);
    addProjected(ctx, collectedItem, count);
  }
};

const ensureCraftPrerequisites = (
  ctx: PlanningContext,
  craftSubgoal: PlannerSubgoal,
  notes: string[]
): PlannerSubgoal[] => {
  const itemName = String(
    craftSubgoal.params.item ??
      craftSubgoal.params.output ??
      craftSubgoal.params.result ??
      craftSubgoal.params.type ??
      ""
  );
  if (!itemName) {
    return [];
  }

  const count = positiveInt(craftSubgoal.params.count ?? craftSubgoal.params.amount ?? craftSubgoal.params.qty, 1);
  const item = ctx.mcData.itemsByName[itemName];
  if (!item) {
    return [];
  }

  const recipePlan = pickRecipePlan(ctx, itemName);
  if (!recipePlan) {
    return [];
  }

  const craftsNeeded = Math.max(1, Math.ceil(count / recipePlan.resultCount));
  const prerequisites: PlannerSubgoal[] = [];

  if (recipePlan.needsTable && itemName !== "crafting_table") {
    const hasTableAccess =
      hasItem(ctx, "crafting_table", 1) || hasNearbyPoi(ctx, "crafting_table", 8);
    if (!hasTableAccess) {
      prerequisites.push(...planAcquireItem(ctx, "crafting_table", 1, notes));
    }
  }

  for (const [ingredientName, ingredientUnits] of recipePlan.ingredients.entries()) {
    const needed = ingredientUnits * craftsNeeded;
    prerequisites.push(...planAcquireItem(ctx, ingredientName, needed, notes));
  }

  return prerequisites;
};

const parseDesiredCountFromSubgoal = (subgoal: PlannerSubgoal): number =>
  positiveInt(subgoal.params.count ?? subgoal.params.amount ?? subgoal.params.qty, 1);

const makeExploreFallback = (target: string): PlannerSubgoal => ({
  name: "explore",
  params: {
    radius: 28,
    return_to_base: false,
    resource_hint: target || undefined,
    max_waypoints: 3,
    attempt_timeout_ms: 10000
  },
  success_criteria: { explored_points_min: 1 }
});

const dedupeAdjacentSubgoals = (
  subgoals: PlannerSubgoal[],
  notes: string[]
): PlannerSubgoal[] => {
  const output: PlannerSubgoal[] = [];
  let dropped = 0;

  for (const subgoal of subgoals) {
    const prev = output[output.length - 1];
    if (!prev) {
      output.push(subgoal);
      continue;
    }
    const same =
      prev.name === subgoal.name &&
      JSON.stringify(prev.params) === JSON.stringify(subgoal.params) &&
      JSON.stringify(prev.success_criteria) === JSON.stringify(subgoal.success_criteria);
    if (same) {
      dropped += 1;
      continue;
    }
    output.push(subgoal);
  }

  if (dropped > 0) {
    notes.push(`deduped_adjacent_subgoals_${dropped}`);
  }

  return output;
};

const buildCapabilityGaps = (ctx: PlanningContext): string[] => {
  const gaps: string[] = [];
  const seen = new Set<string>();
  const resources = [...ctx.snapshot.nearby_summary.resources].sort((a, b) => a.distance - b.distance);

  for (const resource of resources) {
    const requiredTool = requiredToolForBlock(ctx, resource.type);
    if (!requiredTool || hasItem(ctx, requiredTool, 1)) {
      continue;
    }
    const key = `${resource.type}->${requiredTool}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    gaps.push(key);
    if (gaps.length >= 8) {
      break;
    }
  }

  return gaps;
};

const parseCapabilityGap = (
  gap: string
): { resource: string; requiredTool: string } | null => {
  const splitIndex = gap.indexOf("->");
  if (splitIndex <= 0 || splitIndex >= gap.length - 2) {
    return null;
  }
  return {
    resource: gap.slice(0, splitIndex),
    requiredTool: gap.slice(splitIndex + 2)
  };
};

const buildActionableResources = (ctx: PlanningContext): string[] => {
  const lines: string[] = [];
  const resources = [...ctx.snapshot.nearby_summary.resources].sort((a, b) => a.distance - b.distance);

  for (const resource of resources) {
    const requiredTool = requiredToolForBlock(ctx, resource.type);
    const actionable = !requiredTool || hasItem(ctx, requiredTool, 1);
    if (!actionable) {
      continue;
    }
    lines.push(`${resource.type}@${Math.round(resource.distance)}`);
    if (lines.length >= 10) {
      break;
    }
  }

  return lines;
};

const createContext = (snapshot: SnapshotV1, mcVersion: string): PlanningContext => ({
  mcData: getMcData(mcVersion),
  snapshot,
  projected: buildProjectedInventory(snapshot),
  nearbyResourceDistance: buildNearbyResourceDistance(snapshot),
  nearbyPoiDistance: buildNearbyPoiDistance(snapshot)
});

export const enforceSubgoalPrerequisites = (
  snapshot: SnapshotV1,
  subgoals: PlannerSubgoal[],
  mcVersion = "1.20.4"
): GuardResult => {
  const ctx = createContext(snapshot, mcVersion);
  const guarded: PlannerSubgoal[] = [];
  const notes: string[] = [];

  for (const subgoal of subgoals) {
    if (subgoal.name === "collect" || subgoal.name === "goto_nearest") {
      const target = targetNameFromSubgoal(subgoal);
      const blockName = resolveBlockFromTarget(ctx, target);
      if (!blockName) {
        if (subgoal.name === "collect" && target) {
          const desiredCount = parseDesiredCountFromSubgoal(subgoal);
          const replacement = planAcquireItem(ctx, target, desiredCount, notes);
          if (replacement.length > 0) {
            guarded.push(...replacement);
            notes.push(`replaced_unresolved_collect_${target}`);
            continue;
          }
        }
        guarded.push(makeExploreFallback(target));
        notes.push(`replaced_unresolved_${subgoal.name}_${target || "unknown"}`);
        continue;
      }

      const requiredTool = requiredToolForBlock(ctx, blockName);
      if (requiredTool && !hasItem(ctx, requiredTool, 1)) {
        guarded.push(...planAcquireItem(ctx, requiredTool, 1, notes));
        notes.push(`inserted_tool_prereq_${requiredTool}_for_${blockName}`);
      }

      const canonical: PlannerSubgoal = {
        ...subgoal,
        params: {
          ...subgoal.params,
          block: blockName
        }
      };
      guarded.push(canonical);
      applyProjectedOutcome(ctx, canonical);
      continue;
    }

    if (subgoal.name === "craft") {
      const itemName = String(
        subgoal.params.item ??
          subgoal.params.output ??
          subgoal.params.result ??
          subgoal.params.type ??
          ""
      );
      const desiredCount = parseDesiredCountFromSubgoal(subgoal);
      if (!itemName) {
        notes.push("dropped_invalid_craft_without_item");
        continue;
      }

      const recipeExists = Boolean(pickRecipePlan(ctx, itemName));
      if (!recipeExists) {
        const replacement = planAcquireItem(ctx, itemName, desiredCount, notes);
        if (replacement.length > 0) {
          guarded.push(...replacement);
          notes.push(`replaced_uncraftable_craft_${itemName}`);
        } else {
          guarded.push(makeExploreFallback(itemName));
          notes.push(`replaced_unresolved_craft_${itemName}`);
        }
        continue;
      }

      const prereqs = ensureCraftPrerequisites(ctx, subgoal, notes);
      guarded.push(...prereqs);
    }

    guarded.push(subgoal);
    applyProjectedOutcome(ctx, subgoal);
  }

  return {
    subgoals: dedupeAdjacentSubgoals(guarded, notes),
    notes
  };
};

export const buildAutonomousProgressionPlan = (
  snapshot: SnapshotV1,
  mcVersion = "1.20.4",
  desiredIncrement = 8
): AutonomousPlan => {
  const ctx = createContext(snapshot, mcVersion);
  const notes: string[] = [];
  const capabilityGaps = buildCapabilityGaps(ctx);

  // First, close explicit tool/capability gaps so progression advances (logs -> planks -> tools -> stone/ore).
  for (const gap of capabilityGaps) {
    const parsedGap = parseCapabilityGap(gap);
    if (!parsedGap) {
      continue;
    }
    if (hasItem(ctx, parsedGap.requiredTool, 1)) {
      continue;
    }
    const unlockSubgoals = planAcquireItem(ctx, parsedGap.requiredTool, 1, notes);
    if (unlockSubgoals.length > 0) {
      return {
        reason: `unlock_${parsedGap.requiredTool}_for_${parsedGap.resource}`,
        subgoals: unlockSubgoals
      };
    }
  }

  const sortedResources = [...snapshot.nearby_summary.resources]
    .filter((resource) => resource.type !== "water")
    .sort((a, b) => a.distance - b.distance);

  const candidates = sortedResources
    .map((resource) => {
      const itemName = primaryDroppedItemForBlock(ctx, resource.type);
      if (!itemName) {
        return null;
      }
      const requiredTool = requiredToolForBlock(ctx, resource.type);
      const actionable = !requiredTool || hasItem(ctx, requiredTool, 1);
      const current = ctx.projected.get(itemName) ?? 0;
      const shortage = Math.max(0, desiredIncrement - current);
      return {
        resource,
        itemName,
        actionable,
        current,
        shortage
      };
    })
    .filter(
      (
        candidate
      ): candidate is {
        resource: SnapshotV1["nearby_summary"]["resources"][number];
        itemName: string;
        actionable: boolean;
        current: number;
        shortage: number;
      } => Boolean(candidate && candidate.actionable && candidate.shortage > 0)
    )
    .sort((left, right) => {
      if (left.shortage !== right.shortage) {
        return right.shortage - left.shortage;
      }
      return left.resource.distance - right.resource.distance;
    });

  for (const candidate of candidates) {
    const desired = Math.max(desiredIncrement, candidate.current + candidate.shortage);
    const subgoals = planAcquireItem(ctx, candidate.itemName, desired, notes);
    if (subgoals.length > 0) {
      return {
        reason: `acquire_${candidate.itemName}`,
        subgoals
      };
    }
  }

  return {
    reason: "explore_for_resources",
    subgoals: [
      {
        name: "explore",
        params: { radius: 26, return_to_base: false },
        success_criteria: { explored_points_min: 2 }
      }
    ]
  };
};

export const deriveProgressionHint = (
  snapshot: SnapshotV1,
  mcVersion = "1.20.4",
  desiredIncrement = 8
): ProgressionHint => {
  const ctx = createContext(snapshot, mcVersion);
  const autonomous = buildAutonomousProgressionPlan(snapshot, mcVersion, desiredIncrement);
  const recommendation = enforceSubgoalPrerequisites(snapshot, autonomous.subgoals, mcVersion);

  return {
    recommendedGoal: autonomous.reason,
    recommendedSubgoals: recommendation.subgoals.slice(0, 4).map((subgoal) => ({
      name: subgoal.name,
      params: subgoal.params
    })),
    capabilityGaps: buildCapabilityGaps(ctx),
    actionableResources: buildActionableResources(ctx)
  };
};
