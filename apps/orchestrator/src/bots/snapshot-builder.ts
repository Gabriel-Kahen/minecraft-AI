import type { SnapshotV1 } from "../../../../contracts/snapshot";
import type { RuntimeTaskState } from "../core/types";

const RESOURCE_BLOCKS = [
  "oak_log",
  "birch_log",
  "spruce_log",
  "stone",
  "coal_ore",
  "iron_ore",
  "water"
];

const POI_BLOCKS = ["crafting_table", "furnace", "chest"];

const HOSTILE_MOBS = new Set([
  "zombie",
  "skeleton",
  "creeper",
  "spider",
  "enderman",
  "drowned",
  "witch"
]);

const phaseFromTick = (timeOfDay: number): "dawn" | "day" | "dusk" | "night" => {
  if (timeOfDay < 1000) {
    return "dawn";
  }
  if (timeOfDay < 12000) {
    return "day";
  }
  if (timeOfDay < 13500) {
    return "dusk";
  }
  return "night";
};

const inventorySummary = (bot: any): SnapshotV1["inventory_summary"] => {
  const items: Array<{ name: string; count: number }> = bot.inventory?.items?.() ?? [];
  let foodTotal = 0;
  let blocks = 0;
  const tools: Record<string, number> = {};
  const keyItems: Record<string, number> = {};

  for (const item of items) {
    if (item.name.includes("_sword") || item.name.includes("_pickaxe") || item.name.includes("_axe")) {
      tools[item.name] = (tools[item.name] ?? 0) + item.count;
    }
    if (item.name.includes("_log") || item.name.includes("_planks") || item.name.includes("_cobblestone")) {
      blocks += item.count;
    }
    if (item.name.includes("beef") || item.name.includes("bread") || item.name.includes("potato")) {
      foodTotal += item.count;
    }

    keyItems[item.name] = (keyItems[item.name] ?? 0) + item.count;
  }

  return {
    food_total: foodTotal,
    tools,
    blocks,
    key_items: keyItems
  };
};

const nearbyHostiles = (bot: any): SnapshotV1["nearby_summary"]["hostiles"] => {
  const entities = Object.values(bot.entities ?? {}) as Array<any>;

  return entities
    .filter((entity) => entity.type === "mob" && HOSTILE_MOBS.has(entity.name))
    .map((entity) => ({
      type: entity.name,
      distance: bot.entity.position.distanceTo(entity.position)
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6);
};

const nearbyBlocksByName = (
  bot: any,
  names: string[],
  maxDistance: number,
  maxResults: number
): Array<{ type: string; distance: number; position: { x: number; y: number; z: number } }> => {
  const blocks: Array<{ type: string; distance: number; position: { x: number; y: number; z: number } }> = [];
  const mcData = require("minecraft-data")(bot.version);

  for (const name of names) {
    const blockDef = mcData.blocksByName[name];
    if (!blockDef) {
      continue;
    }

    const found = bot.findBlock({
      matching: blockDef.id,
      maxDistance,
      count: maxResults
    }) as any[] | null;

    if (!found) {
      continue;
    }

    for (const block of found) {
      blocks.push({
        type: name,
        distance: bot.entity.position.distanceTo(block.position),
        position: {
          x: block.position.x,
          y: block.position.y,
          z: block.position.z
        }
      });
    }
  }

  return blocks.sort((a, b) => a.distance - b.distance).slice(0, maxResults);
};

export const buildSnapshot = (
  bot: any,
  botId: string,
  taskState: RuntimeTaskState
): SnapshotV1 => {
  const timeOfDay = bot.time?.timeOfDay ?? 0;

  return {
    bot_id: botId,
    time: {
      tick: bot.time?.age ?? 0,
      day_phase: phaseFromTick(timeOfDay)
    },
    player: {
      position: {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z
      },
      dimension: bot.game?.dimension ?? "overworld",
      health: bot.health ?? 20,
      hunger: bot.food ?? 20,
      status_effects: Object.keys(bot.entity.effects ?? {})
    },
    inventory_summary: inventorySummary(bot),
    nearby_summary: {
      hostiles: nearbyHostiles(bot),
      resources: nearbyBlocksByName(bot, RESOURCE_BLOCKS, 32, 8),
      points_of_interest: nearbyBlocksByName(bot, POI_BLOCKS, 32, 6)
    },
    task_context: {
      current_goal: taskState.currentGoal,
      current_subgoal: taskState.currentSubgoal?.name ?? null,
      progress_counters: taskState.progressCounters,
      last_error: taskState.lastError
    }
  };
};
