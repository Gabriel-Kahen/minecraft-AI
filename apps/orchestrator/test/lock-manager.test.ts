import { describe, expect, it } from "vitest";
import type { SnapshotV1 } from "../../../contracts/snapshot";
import { LockManager } from "../src/coordination/lock-manager";

const noopSnapshot = {
  bot_id: "bot-1",
  time: { tick: 0, day_phase: "day" },
  player: {
    position: { x: 0, y: 0, z: 0 },
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
    resources: [],
    points_of_interest: []
  },
  task_context: {
    current_goal: null,
    current_subgoal: null,
    progress_counters: {}
  }
} satisfies SnapshotV1;

class MockStore {
  upsertBotSnapshot(_botId: string, _snapshot: SnapshotV1, _updatedAt: string): void {
    void noopSnapshot;
  }

  insertLockEvent(): void {
    // no-op
  }
}

describe("LockManager", () => {
  it("prevents lock conflicts", () => {
    const manager = new LockManager(new MockStore() as never, 10000);
    expect(manager.acquire("resource:oak_log", "bot-1")).toBe(true);
    expect(manager.acquire("resource:oak_log", "bot-2")).toBe(false);
    manager.release("resource:oak_log", "bot-1");
    expect(manager.acquire("resource:oak_log", "bot-2")).toBe(true);
  });
});
