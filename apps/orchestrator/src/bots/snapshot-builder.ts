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
  const blockIdSet = new Set<number>();
  const requestedNames = new Set<string>();

  for (const name of names) {
    const blockDef = mcData.blocksByName[name];
    if (!blockDef) {
      continue;
    }
    blockIdSet.add(blockDef.id);
    requestedNames.add(name);
  }

  if (blockIdSet.size === 0) {
    return blocks;
  }

  const found = bot.findBlocks({
    matching: (block: { type: number }) => blockIdSet.has(block.type),
    maxDistance,
    count: maxResults * 6
  }) as unknown;

  if (!found) {
    return blocks;
  }

  const foundBlocks = Array.isArray(found) ? found : [found];
  for (const position of foundBlocks) {
    if (!position) {
      continue;
    }
    const block = bot.blockAt(position);
    if (!block || !requestedNames.has(block.name)) {
      continue;
    }
    blocks.push({
      type: block.name,
      distance: bot.entity.position.distanceTo(position),
      position: {
        x: position.x,
        y: position.y,
        z: position.z
      }
    });
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
      resources: nearbyBlocksByName(bot, RESOURCE_BLOCKS, 24, 6),
      points_of_interest: nearbyBlocksByName(bot, POI_BLOCKS, 24, 4)
    },
    task_context: {
      current_goal: taskState.currentGoal,
      current_subgoal: taskState.currentSubgoal?.name ?? null,
      progress_counters: taskState.progressCounters,
      last_error: taskState.lastError
    }
  };
};
