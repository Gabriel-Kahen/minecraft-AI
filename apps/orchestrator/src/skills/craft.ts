import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, findNearestBlock, success } from "./helpers";

const placeCraftingTableIfNeeded = async (ctx: SkillExecutionContext): Promise<any | null> => {
  let table = findNearestBlock(ctx, "crafting_table", 8);
  if (table) {
    return table;
  }

  const tableItem = (ctx.bot.inventory?.items?.() ?? []).find((item: any) => item.name === "crafting_table");
  if (!tableItem) {
    return null;
  }

  await ctx.bot.equip(tableItem, "hand");
  const reference = ctx.bot.blockAt(ctx.bot.entity.position.offset(0, -1, 0));
  if (!reference || reference.name === "air") {
    return null;
  }

  await ctx.bot.placeBlock(reference, ctx.bot.entity.position.offset(1, 0, 0).minus(reference.position));
  table = findNearestBlock(ctx, "crafting_table", 8);
  return table;
};

export const craftSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const itemName = String(params.item ?? "");
  const count = Number(params.count ?? 1);
  if (!itemName) {
    return failure("DEPENDS_ON_ITEM", "craft requires item name", false);
  }

  const mcData = require("minecraft-data")(ctx.bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) {
    return failure("DEPENDS_ON_ITEM", `unknown item ${itemName}`, false);
  }

  try {
    let crafted = 0;
    while (crafted < count) {
      let table: any = null;
      let recipes = ctx.bot.recipesFor(item.id, null, 1, null);
      if (recipes.length === 0) {
        table = await placeCraftingTableIfNeeded(ctx);
        if (!table) {
          return failure("DEPENDS_ON_ITEM", "crafting table required but unavailable", true);
        }
        recipes = ctx.bot.recipesFor(item.id, null, 1, table);
      }

      const recipe = recipes[0];
      if (!recipe) {
        return failure("DEPENDS_ON_ITEM", `no recipe available for ${itemName}`, true);
      }

      await ctx.bot.craft(recipe, 1, table);
      crafted += 1;
    }

    return success(`crafted ${count} ${itemName}`, { crafted: count });
  } catch (error) {
    return asSkillFailure(error, "DEPENDS_ON_ITEM");
  }
};
