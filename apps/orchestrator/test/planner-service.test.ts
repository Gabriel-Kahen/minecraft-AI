import { describe, expect, it } from "vitest";
import type { PlannerRequestV1 } from "../../../contracts/planner";
import type { SnapshotV1 } from "../../../contracts/snapshot";
import { PlannerRateLimiter } from "../src/planner/rate-limiter";
import { SchemaValidator } from "../src/planner/schema-validator";
import { PlannerService } from "../src/planner/planner-service";

const baseSnapshot = (): SnapshotV1 => ({
  bot_id: "pi-bot-1",
  time: { tick: 100, day_phase: "day" },
  player: {
    position: { x: 0, y: 64, z: 0 },
    dimension: "overworld",
    health: 20,
    hunger: 20,
    status_effects: []
  },
  inventory_summary: {
    food_total: 0,
    tools: {},
    blocks: 0,
    key_items: {}
  },
  nearby_summary: {
    hostiles: [],
    resources: [
      { type: "oak_log", distance: 5, position: { x: 2, y: 64, z: 2 } },
      { type: "stone", distance: 9, position: { x: 4, y: 63, z: 4 } }
    ],
    points_of_interest: []
  },
  task_context: {
    current_goal: null,
    current_subgoal: null,
    progress_counters: {},
    last_error: null
  }
});

const baseRequest = (): PlannerRequestV1 => ({
  bot_id: "pi-bot-1",
  snapshot: baseSnapshot(),
  history: [],
  available_subgoals: [
    "explore",
    "goto",
    "goto_nearest",
    "collect",
    "craft",
    "smelt",
    "deposit",
    "withdraw",
    "build_blueprint",
    "combat_engage",
    "combat_guard"
  ]
});

class MockGeminiClient {
  public readonly prompts: string[] = [];

  private readonly responses: string[];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async generateJson(prompt: string): Promise<{ text: string; usage: { tokensIn: number; tokensOut: number } }> {
    this.prompts.push(prompt);
    const next = this.responses.shift();
    if (!next) {
      throw new Error("no mock response");
    }
    return {
      text: next,
      usage: { tokensIn: 100, tokensOut: 50 }
    };
  }
}

describe("PlannerService feasibility reprompt", () => {
  it("reprompts model when plan needs dependency rewrites", async () => {
    const client = new MockGeminiClient([
      JSON.stringify({
        next_goal: "gather stone",
        subgoals: [
          {
            name: "collect",
            params: { block: "stone", count: 8 },
            success_criteria: { item_count_gte: 8 }
          }
        ]
      }),
      JSON.stringify({
        next_goal: "bootstrap tools then gather stone",
        subgoals: [
          {
            name: "collect",
            params: { block: "oak_log", count: 3 },
            success_criteria: { item_count_gte: 3 }
          },
          {
            name: "craft",
            params: { item: "oak_planks", count: 12 },
            success_criteria: { item_count_gte: 12 }
          },
          {
            name: "craft",
            params: { item: "crafting_table", count: 1 },
            success_criteria: { item_count_gte: 1 }
          },
          {
            name: "craft",
            params: { item: "stick", count: 2 },
            success_criteria: { item_count_gte: 2 }
          },
          {
            name: "craft",
            params: { item: "wooden_pickaxe", count: 1 },
            success_criteria: { item_count_gte: 1 }
          },
          {
            name: "collect",
            params: { block: "stone", count: 8 },
            success_criteria: { item_count_gte: 8 }
          }
        ]
      })
    ]);

    const planner = new PlannerService(
      client as unknown as any,
      new SchemaValidator(),
      new PlannerRateLimiter(100, 1000),
      {
        timeoutMs: 3000,
        maxRetries: 0,
        mcVersion: "1.20.4",
        feasibilityRepromptEnabled: true,
        feasibilityRepromptMaxAttempts: 1,
        basePosition: { x: 0, y: 64, z: 0, radius: 16 }
      }
    );

    const outcome = await planner.plan(baseRequest());
    expect(outcome.status).toBe("SUCCESS");
    expect(client.prompts.length).toBe(2);
    expect(outcome.response.next_goal).toContain("bootstrap");
    expect(outcome.response.subgoals[0]?.params.block).toBe("oak_log");
    expect(outcome.notes?.includes("feasibility_reprompt_resolved")).toBe(true);
  });

  it("keeps guarded initial plan when reprompt is disabled", async () => {
    const client = new MockGeminiClient([
      JSON.stringify({
        next_goal: "gather stone",
        subgoals: [
          {
            name: "collect",
            params: { block: "stone", count: 8 },
            success_criteria: { item_count_gte: 8 }
          }
        ]
      })
    ]);

    const planner = new PlannerService(
      client as unknown as any,
      new SchemaValidator(),
      new PlannerRateLimiter(100, 1000),
      {
        timeoutMs: 3000,
        maxRetries: 0,
        mcVersion: "1.20.4",
        feasibilityRepromptEnabled: false,
        feasibilityRepromptMaxAttempts: 0,
        basePosition: { x: 0, y: 64, z: 0, radius: 16 }
      }
    );

    const outcome = await planner.plan(baseRequest());
    expect(outcome.status).toBe("SUCCESS");
    expect(client.prompts.length).toBe(1);
    expect(outcome.response.subgoals.some((subgoal) => subgoal.name === "craft")).toBe(true);
    expect(outcome.notes?.includes("guard_adjusted_initial_plan")).toBe(true);
  });
});
