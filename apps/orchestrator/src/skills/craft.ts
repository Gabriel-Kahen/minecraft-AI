import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, countItem, failure, findNearestBlock, gotoCoordinates, success } from "./helpers";
import { Vec3 } from "vec3";

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

  const mcData = require("minecraft-data")(ctx.bot.version);
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
        return failure("DEPENDS_ON_ITEM", `no recipe available for ${itemName}`, true);
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
