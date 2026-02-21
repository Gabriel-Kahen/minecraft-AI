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
  nearbyPoi: Set<string>;
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
    hasItem(ctx, "crafting_table", 1) || ctx.nearbyPoi.has("crafting_table");

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
        hasItem(ctx, "crafting_table", 1) || ctx.nearbyPoi.has("crafting_table");
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
      block: sourceBlock,
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
      hasItem(ctx, "crafting_table", 1) || ctx.nearbyPoi.has("crafting_table");
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

const createContext = (snapshot: SnapshotV1, mcVersion: string): PlanningContext => ({
  mcData: getMcData(mcVersion),
  snapshot,
  projected: buildProjectedInventory(snapshot),
  nearbyResourceDistance: buildNearbyResourceDistance(snapshot),
  nearbyPoi: new Set(snapshot.nearby_summary.points_of_interest.map((poi) => poi.type))
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
      if (blockName) {
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
    }

    if (subgoal.name === "craft") {
      const prereqs = ensureCraftPrerequisites(ctx, subgoal, notes);
      guarded.push(...prereqs);
    }

    guarded.push(subgoal);
    applyProjectedOutcome(ctx, subgoal);
  }

  return {
    subgoals: guarded,
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
  const sortedResources = [...snapshot.nearby_summary.resources]
    .filter((resource) => resource.type !== "water")
    .sort((a, b) => a.distance - b.distance);

  for (const resource of sortedResources) {
    const itemName = primaryDroppedItemForBlock(ctx, resource.type);
    if (!itemName) {
      continue;
    }

    const desired = (ctx.projected.get(itemName) ?? 0) + desiredIncrement;
    const subgoals = planAcquireItem(ctx, itemName, desired, notes);
    if (subgoals.length > 0) {
      return {
        reason: `acquire_${itemName}`,
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
