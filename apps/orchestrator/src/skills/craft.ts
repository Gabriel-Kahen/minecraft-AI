import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, countItem, failure, findNearestBlock, gotoCoordinates, success } from "./helpers";
import { Vec3 } from "vec3";
import { getMcData } from "../utils/mc-data";

const recipeNeedsTable = (recipe: any): boolean => {
  if (Array.isArray(recipe.inShape)) {
    const rows = recipe.inShape.length;
    const cols = recipe.inShape.reduce(
      (max: number, row: unknown) => Math.max(max, Array.isArray(row) ? row.length : 0),
      0
    );
    return rows > 2 || cols > 2;
  }
  if (Array.isArray(recipe.ingredients)) {
    return recipe.ingredients.length > 4;
  }
  return false;
};

const parseRecipeIngredients = (mcData: any, recipe: any): Map<string, number> => {
  const byId = new Map<number, number>();
  const push = (value: unknown): void => {
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
        const count = typeof raw.count === "number" && raw.count > 0 ? Math.floor(raw.count) : 1;
        byId.set(raw.id, (byId.get(raw.id) ?? 0) + count);
      }
    }
  };

  if (Array.isArray(recipe.ingredients)) {
    for (const ingredient of recipe.ingredients) {
      push(ingredient);
    }
  }
  if (Array.isArray(recipe.inShape)) {
    for (const row of recipe.inShape) {
      if (!Array.isArray(row)) {
        continue;
      }
      for (const ingredient of row) {
        push(ingredient);
      }
    }
  }

  const byName = new Map<string, number>();
  for (const [id, count] of byId.entries()) {
    const itemName = mcData.items?.[id]?.name;
    if (!itemName) {
      continue;
    }
    byName.set(itemName, (byName.get(itemName) ?? 0) + count);
  }
  return byName;
};

const inventoryCountByName = (ctx: SkillExecutionContext): Map<string, number> => {
  const map = new Map<string, number>();
  const items: Array<{ name: string; count: number }> = ctx.bot.inventory?.items?.() ?? [];
  for (const item of items) {
    map.set(item.name, (map.get(item.name) ?? 0) + item.count);
  }
  return map;
};

const missingIngredientsMessage = (ctx: SkillExecutionContext, mcData: any, itemId: number, itemName: string): string => {
  const recipes = (mcData.recipes?.[itemId] ?? []) as any[];
  if (recipes.length === 0) {
    return `no recipe exists for ${itemName} in ${ctx.bot.version}`;
  }

  const inventory = inventoryCountByName(ctx);
  const candidates = recipes
    .map((recipe) => {
      const ingredients = parseRecipeIngredients(mcData, recipe);
      const missing: Array<{ name: string; count: number }> = [];
      let totalMissing = 0;
      for (const [name, needed] of ingredients.entries()) {
        const have = inventory.get(name) ?? 0;
        const miss = Math.max(0, needed - have);
        if (miss > 0) {
          missing.push({ name, count: miss });
          totalMissing += miss;
        }
      }
      return {
        needsTable: recipeNeedsTable(recipe),
        missing,
        totalMissing
      };
    })
    .sort((a, b) => a.totalMissing - b.totalMissing);

  const best = candidates[0];
  if (!best) {
    return `no craftable recipe path found for ${itemName}`;
  }
  if (best.totalMissing === 0) {
    return `recipe for ${itemName} exists but craft execution failed`;
  }

  const missingSummary = best.missing
    .slice(0, 5)
    .map((entry) => `${entry.name} x${entry.count}`)
    .join(", ");
  const tableNote = best.needsTable ? " (requires crafting table)" : "";
  return `missing ingredients for ${itemName}${tableNote}: ${missingSummary}`;
};

const placeCraftingTableIfNeeded = async (ctx: SkillExecutionContext): Promise<any | null> => {
  let table = findNearestBlock(ctx, "crafting_table", 24);
  if (table) {
    try {
      await gotoCoordinates(ctx, table.position.x, table.position.y, table.position.z, 3, 15000);
    } catch {
      // If movement fails we'll still try local placement fallback.
    }
    table = findNearestBlock(ctx, "crafting_table", 8) ?? table;
    return table;
  }

  const tableItem = (ctx.bot.inventory?.items?.() ?? []).find((item: any) => item.name === "crafting_table");
  if (!tableItem) {
    return null;
  }

  const feet = ctx.bot.entity.position.floored();
  const candidateTargets = [
    feet.offset(1, 0, 0),
    feet.offset(-1, 0, 0),
    feet.offset(0, 0, 1),
    feet.offset(0, 0, -1),
    feet.offset(1, -1, 0),
    feet.offset(-1, -1, 0),
    feet.offset(0, -1, 1),
    feet.offset(0, -1, -1)
  ];

  let support: any = null;
  let face: Vec3 | null = null;
  let targetPos: Vec3 | null = null;
  for (const candidate of candidateTargets) {
    const targetBlock = ctx.bot.blockAt(candidate);
    const supportBlock = ctx.bot.blockAt(candidate.offset(0, -1, 0));
    if (!targetBlock || targetBlock.name !== "air") {
      continue;
    }
    if (!supportBlock || supportBlock.name === "air") {
      continue;
    }
    support = supportBlock;
    face = new Vec3(0, 1, 0);
    targetPos = candidate;
    break;
  }

  if (!support || !face || !targetPos) {
    return null;
  }

  try {
    await gotoCoordinates(ctx, targetPos.x, targetPos.y, targetPos.z, 3, 15000);
  } catch {
    return null;
  }

  await ctx.bot.equip(tableItem, "hand");
  try {
    await ctx.bot.placeBlock(support, face);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.toLowerCase().includes("blockupdate") ||
      message.toLowerCase().includes("timeout")
    ) {
      throw failure(
        "DEPENDS_ON_ITEM",
        "crafting table placement blocked by server (spawn protection/permissions) or lag timeout",
        false
      );
    }
    throw error;
  }
  table = findNearestBlock(ctx, "crafting_table", 12);
  return table;
};

export const craftSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const itemName = String(params.item ?? params.output ?? params.result ?? params.type ?? "");
  const desiredUnits = Math.max(1, Math.floor(Number(params.count ?? params.amount ?? params.qty ?? 1) || 1));
  if (!itemName) {
    return failure("DEPENDS_ON_ITEM", "craft requires item name", false);
  }

  const mcData = getMcData(ctx.bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) {
    return failure("DEPENDS_ON_ITEM", `unknown item ${itemName}`, false);
  }

  try {
    const before = countItem(ctx, itemName);
    while (countItem(ctx, itemName) - before < desiredUnits) {
      let table: any = null;
      let recipes = ctx.bot.recipesFor(item.id, null, 1, null);
      if (recipes.length === 0) {
        table = await placeCraftingTableIfNeeded(ctx);
        if (!table) {
          return failure(
            "DEPENDS_ON_ITEM",
            "crafting table required but unavailable (no nearby table and none in inventory)",
            false
          );
        }
        recipes = ctx.bot.recipesFor(item.id, null, 1, table);
      }

      const recipe = recipes[0];
      if (!recipe) {
        return failure("DEPENDS_ON_ITEM", missingIngredientsMessage(ctx, mcData, item.id, itemName), true);
      }

      await ctx.bot.craft(recipe, 1, table);
    }

    const craftedUnits = countItem(ctx, itemName) - before;
    return success(`crafted ${craftedUnits} ${itemName}`, { crafted: craftedUnits });
  } catch (error) {
    const mapped = asSkillFailure(error, "DEPENDS_ON_ITEM");
    if (
      mapped.details.toLowerCase().includes("blockupdate") ||
      mapped.details.toLowerCase().includes("placement blocked")
    ) {
      return failure("DEPENDS_ON_ITEM", mapped.details, false);
    }
    return mapped;
  }
};
