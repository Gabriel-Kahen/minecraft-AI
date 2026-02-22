import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlannerSubgoal } from "../../../../contracts/planner";
import type { SnapshotV1 } from "../../../../contracts/snapshot";
import { ensureDir } from "../utils/fs";
import { nowIso, sleep, withJitter } from "../utils/time";
import { VertexGeminiClient } from "./gemini-client";

export interface BlueprintBlock {
  x: number;
  y: number;
  z: number;
  block: string;
}

export interface GeneratedBlueprint {
  name: string;
  description: string;
  blocks: BlueprintBlock[];
}

export interface BlueprintDesignRequest {
  botId: string;
  nextGoal: string;
  subgoal: PlannerSubgoal;
  snapshot: SnapshotV1;
}

export interface BlueprintDesignerOptions {
  timeoutMs: number;
  maxRetries: number;
  outputDir: string;
  maxBlocks: number;
  maxSpan: number;
  maxHeight: number;
}

export interface BlueprintDesignResult {
  filePath: string;
  blueprint: GeneratedBlueprint;
  generatedAt: string;
}

const BLOCK_DENYLIST = new Set([
  "lava",
  "water",
  "tnt",
  "bedrock",
  "command_block",
  "barrier",
  "end_portal"
]);

const extractJson = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("blueprint model response did not include JSON");
};

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "agent-design";

const intOrThrow = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`blueprint ${label} must be an integer`);
  }
  return value;
};

export const validateBlueprintDesign = (
  input: unknown,
  options: Pick<BlueprintDesignerOptions, "maxBlocks" | "maxSpan" | "maxHeight">
): GeneratedBlueprint => {
  if (!input || typeof input !== "object") {
    throw new Error("blueprint payload must be an object");
  }

  const payload = input as Record<string, unknown>;
  const name = typeof payload.name === "string" && payload.name.trim().length > 0
    ? payload.name.trim().slice(0, 80)
    : "agent-design";
  const description =
    typeof payload.description === "string" ? payload.description.trim().slice(0, 160) : "LLM-generated design";

  if (!Array.isArray(payload.blocks)) {
    throw new Error("blueprint blocks must be an array");
  }

  if (payload.blocks.length === 0) {
    throw new Error("blueprint must contain at least one block");
  }

  if (payload.blocks.length > options.maxBlocks) {
    throw new Error(`blueprint exceeds max block count ${options.maxBlocks}`);
  }

  const deduped = new Map<string, BlueprintBlock>();
  for (const [idx, entry] of payload.blocks.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`blueprint block ${idx} must be an object`);
    }

    const block = entry as Record<string, unknown>;
    const x = intOrThrow(block.x, `blocks[${idx}].x`);
    const y = intOrThrow(block.y, `blocks[${idx}].y`);
    const z = intOrThrow(block.z, `blocks[${idx}].z`);
    const blockName = typeof block.block === "string" ? block.block.trim() : "";

    if (!/^[a-z0-9_]+$/.test(blockName)) {
      throw new Error(`blueprint block name is invalid at index ${idx}`);
    }

    if (BLOCK_DENYLIST.has(blockName)) {
      throw new Error(`blueprint block ${blockName} is not allowed`);
    }

    if (Math.abs(x) > options.maxSpan || Math.abs(z) > options.maxSpan) {
      throw new Error(`blueprint coordinate out of span bounds at index ${idx}`);
    }

    if (y < 0 || y > options.maxHeight) {
      throw new Error(`blueprint y out of height bounds at index ${idx}`);
    }

    deduped.set(`${x},${y},${z}`, { x, y, z, block: blockName });
  }

  const blocks = [...deduped.values()].sort((a, b) => {
    if (a.y !== b.y) {
      return a.y - b.y;
    }
    if (a.x !== b.x) {
      return a.x - b.x;
    }
    return a.z - b.z;
  });

  if (blocks.length === 0) {
    throw new Error("blueprint is empty after deduplication");
  }

  const hasFloor = blocks.some((block) => block.y === 0);
  if (!hasFloor) {
    throw new Error("blueprint must include at least one y=0 floor block");
  }

  const xs = blocks.map((block) => block.x);
  const zs = blocks.map((block) => block.z);
  const maxX = Math.max(...xs);
  const minX = Math.min(...xs);
  const maxZ = Math.max(...zs);
  const minZ = Math.min(...zs);

  if (maxX - minX + 1 > options.maxSpan + 1 || maxZ - minZ + 1 > options.maxSpan + 1) {
    throw new Error("blueprint footprint exceeds allowed span");
  }

  return {
    name,
    description,
    blocks
  };
};

const buildPrompt = (
  request: BlueprintDesignRequest,
  options: Pick<BlueprintDesignerOptions, "maxBlocks" | "maxSpan" | "maxHeight">
): string => {
  return [
    "You design Minecraft build blueprints for a deterministic agent.",
    "Return JSON only with this exact shape:",
    '{"name": string, "description": string, "blocks": [{"x": integer, "y": integer, "z": integer, "block": string}]}',
    "Coordinates are relative offsets from anchor (0,0,0).",
    `Hard limits: max blocks=${options.maxBlocks}, max |x|/|z| offset=${options.maxSpan}, max y=${options.maxHeight}.`,
    "Use practical survival blocks and include a valid floor at y=0.",
    "Never use lava, water, tnt, bedrock, command blocks, barrier, or portal blocks.",
    "Keep designs realistic for early-mid game resources.",
    "Build request:",
    JSON.stringify({
      bot_id: request.botId,
      next_goal: request.nextGoal,
      build_subgoal: request.subgoal,
      snapshot: {
        position: request.snapshot.player.position,
        inventory_summary: request.snapshot.inventory_summary,
        nearby_summary: request.snapshot.nearby_summary,
        day_phase: request.snapshot.time.day_phase
      }
    })
  ].join("\n");
};

export class BlueprintDesigner {
  private readonly client: VertexGeminiClient;

  private readonly options: BlueprintDesignerOptions;

  constructor(client: VertexGeminiClient, options: BlueprintDesignerOptions) {
    this.client = client;
    this.options = options;
    ensureDir(options.outputDir);
  }

  async designAndPersist(request: BlueprintDesignRequest): Promise<BlueprintDesignResult> {
    const prompt = buildPrompt(request, this.options);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const completion = await this.client.generateJson(prompt, this.options.timeoutMs);
        const rawBlueprint = JSON.parse(extractJson(completion.text)) as unknown;
        const blueprint = validateBlueprintDesign(rawBlueprint, this.options);
        const generatedAt = nowIso();
        const filePath = await this.writeBlueprint(request.botId, request.nextGoal, blueprint, generatedAt);

        return {
          filePath,
          blueprint,
          generatedAt
        };
      } catch (error) {
        lastError = error;
        if (attempt >= this.options.maxRetries) {
          break;
        }
        await sleep(withJitter(80 * (attempt + 1)));
      }
    }

    throw new Error(
      `blueprint design failed: ${lastError instanceof Error ? lastError.message : "unknown"}`
    );
  }

  private async writeBlueprint(
    botId: string,
    sourceGoal: string,
    blueprint: GeneratedBlueprint,
    generatedAt: string
  ): Promise<string> {
    const botDir = path.join(this.options.outputDir, botId);
    ensureDir(botDir);

    const timestamp = generatedAt.replace(/[^0-9]/g, "").slice(0, 14);
    const fileName = `${timestamp}-${slugify(blueprint.name)}.json`;
    const filePath = path.resolve(path.join(botDir, fileName));

    await writeFile(
      filePath,
      JSON.stringify(
        {
          ...blueprint,
          generated_at: generatedAt,
          source_goal: sourceGoal,
          generated_by: "llm-blueprint-designer"
        },
        null,
        2
      ),
      "utf8"
    );

    return filePath;
  }
}
