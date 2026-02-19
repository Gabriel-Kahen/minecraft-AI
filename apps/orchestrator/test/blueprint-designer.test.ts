import { describe, expect, it } from "vitest";
import { validateBlueprintDesign } from "../src/planner/blueprint-designer";

describe("validateBlueprintDesign", () => {
  const limits = {
    maxBlocks: 6,
    maxSpan: 8,
    maxHeight: 6
  };

  it("accepts a valid generated blueprint", () => {
    const blueprint = validateBlueprintDesign(
      {
        name: "small-hut",
        description: "simple shelter",
        blocks: [
          { x: 0, y: 0, z: 0, block: "oak_planks" },
          { x: 1, y: 0, z: 0, block: "oak_planks" },
          { x: 0, y: 1, z: 0, block: "oak_planks" },
          { x: 1, y: 1, z: 0, block: "oak_planks" }
        ]
      },
      limits
    );

    expect(blueprint.blocks).toHaveLength(4);
    expect(blueprint.name).toBe("small-hut");
  });

  it("rejects denied blocks", () => {
    expect(() =>
      validateBlueprintDesign(
        {
          name: "bad",
          blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }]
        },
        limits
      )
    ).toThrow(/not allowed/);
  });

  it("rejects blueprints without floor blocks", () => {
    expect(() =>
      validateBlueprintDesign(
        {
          name: "floating",
          blocks: [{ x: 0, y: 1, z: 0, block: "oak_planks" }]
        },
        limits
      )
    ).toThrow(/y=0/);
  });
});
