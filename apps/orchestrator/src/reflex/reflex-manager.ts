import type { PlannerTrigger } from "../core/types";

export interface ReflexContext {
  isBusy: () => boolean;
  onTrigger: (trigger: PlannerTrigger, details: Record<string, unknown>) => void;
}

export interface ReflexBase {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export class ReflexManager {
  private lastNightTriggerAt = 0;

  private lastFleeTriggerAt = 0;

  private stuckCounter = 0;

  private lastPos: { x: number; y: number; z: number } | null = null;

  private interval: NodeJS.Timeout | null = null;

  private readonly base: ReflexBase;

  constructor(base: ReflexBase) {
    this.base = base;
  }

  attach(bot: any, context: ReflexContext): void {
    bot.on("entityHurt", (entity: any) => {
      if (entity !== bot.entity) {
        return;
      }
      context.onTrigger("ATTACKED", {
        health: bot.health,
        food: bot.food
      });
      this.runImmediateReflex(bot);
    });

    bot.on("death", () => {
      context.onTrigger("DEATH", { reason: "bot_death_event" });
    });

    bot.on("kicked", (reason: unknown) => {
      context.onTrigger("RECONNECT", { reason: String(reason) });
    });

    bot.on("end", () => {
      context.onTrigger("RECONNECT", { reason: "connection_closed" });
    });

    this.interval = setInterval(() => {
      if (!bot.entity) {
        return;
      }

      const timeOfDay = bot.time?.timeOfDay ?? 0;
      const isNight = timeOfDay >= 13000 && timeOfDay <= 23000;
      if (isNight && Date.now() - this.lastNightTriggerAt > 120000) {
        this.lastNightTriggerAt = Date.now();
        context.onTrigger("NIGHTFALL", { time_of_day: timeOfDay });
      }

      const emptySlots = bot.inventory?.emptySlotCount?.() ?? 0;
      if (emptySlots <= 2) {
        context.onTrigger("INVENTORY_FULL", { empty_slots: emptySlots });
      }

      if (context.isBusy()) {
        const nearbyHostile = Object.values(bot.entities ?? {})
          .filter((entity: any) => entity?.type === "mob")
          .filter((entity: any) => {
            const name = String(entity.name ?? "");
            return (
              name === "zombie" ||
              name === "skeleton" ||
              name === "creeper" ||
              name === "spider" ||
              name === "enderman" ||
              name === "witch" ||
              name === "drowned" ||
              name === "husk"
            );
          })
          .map((entity: any) => ({
            name: entity.name,
            distance: bot.entity.position.distanceTo(entity.position)
          }))
          .sort((a: any, b: any) => a.distance - b.distance)[0];

        if (
          nearbyHostile &&
          nearbyHostile.distance <= 8 &&
          bot.health <= 9 &&
          Date.now() - this.lastFleeTriggerAt > 12000
        ) {
          this.lastFleeTriggerAt = Date.now();
          context.onTrigger("ATTACKED", {
            reason: "nearby_hostile_low_health",
            hostile: nearbyHostile.name,
            distance: nearbyHostile.distance,
            health: bot.health
          });
          this.runImmediateReflex(bot);
        }

        const pathfinder = bot.pathfinder;
        const isPathfinderMoving =
          Boolean(pathfinder) &&
          typeof pathfinder.isMoving === "function" &&
          pathfinder.isMoving();
        const isPathfinderMining =
          Boolean(pathfinder) &&
          typeof pathfinder.isMining === "function" &&
          pathfinder.isMining();
        const isPathfinderBuilding =
          Boolean(pathfinder) &&
          typeof pathfinder.isBuilding === "function" &&
          pathfinder.isBuilding();

        // Only run "stuck" detection while the bot is actively trying to move.
        // Mining/crafting/building can legitimately keep position nearly static.
        if (isPathfinderMoving && !isPathfinderMining && !isPathfinderBuilding) {
          const position = bot.entity.position;
          if (this.lastPos) {
            const moved = Math.hypot(
              position.x - this.lastPos.x,
              position.y - this.lastPos.y,
              position.z - this.lastPos.z
            );
            if (moved < 0.25) {
              this.stuckCounter += 1;
            } else {
              this.stuckCounter = 0;
            }
          }

          this.lastPos = { x: position.x, y: position.y, z: position.z };
        } else {
          this.stuckCounter = 0;
          const position = bot.entity.position;
          this.lastPos = { x: position.x, y: position.y, z: position.z };
        }

        if (this.stuckCounter >= 20) {
          this.stuckCounter = 0;
          context.onTrigger("STUCK", { reason: "movement_threshold" });
        }
      } else {
        this.stuckCounter = 0;
      }
    }, 1000);

    this.interval.unref();
  }

  detach(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private runImmediateReflex(bot: any): void {
    if (typeof bot.clearControlStates === "function") {
      bot.clearControlStates();
    }

    if (bot.health <= 8 && bot.pathfinder?.setGoal) {
      const pathfinder = require("mineflayer-pathfinder");
      const GoalNear = pathfinder.goals?.GoalNear;
      if (GoalNear) {
        bot.pathfinder.setGoal(new GoalNear(this.base.x, this.base.y, this.base.z, this.base.radius));
      }
    }
  }
}
