import type { Bot } from "mineflayer";

const loadPluginModule = (moduleName: string): unknown => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName);
  } catch {
    return null;
  }
};

const extractPlugin = (moduleValue: unknown): ((bot: Bot) => void) | null => {
  if (!moduleValue || typeof moduleValue !== "object") {
    return typeof moduleValue === "function" ? (moduleValue as (bot: Bot) => void) : null;
  }

  const value = moduleValue as Record<string, unknown>;
  if (typeof value.plugin === "function") {
    return value.plugin as (bot: Bot) => void;
  }
  if (typeof value.pathfinder === "function") {
    return value.pathfinder as (bot: Bot) => void;
  }
  if (typeof value.loader === "function") {
    return value.loader as (bot: Bot) => void;
  }
  if (typeof value.default === "function") {
    return value.default as (bot: Bot) => void;
  }

  return null;
};

const stringifyError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export interface PluginLoadOptions {
  mineflayer?: unknown;
  debugViewer: boolean;
  viewerPort: number;
  bloodhoundEnabled: boolean;
  tpsPluginEnabled: boolean;
  webInventoryEnabled: boolean;
  webInventoryPort: number;
}

export interface PluginLoadReport {
  loaded: string[];
  failed: Array<{ name: string; reason: string }>;
  webInventoryUrl?: string;
}

export const loadMineflayerPlugins = (bot: Bot, options: PluginLoadOptions): PluginLoadReport => {
  const report: PluginLoadReport = {
    loaded: [],
    failed: []
  };

  const modules = [
    "mineflayer-pathfinder",
    "mineflayer-collectblock",
    "mineflayer-tool",
    "mineflayer-auto-eat",
    "mineflayer-armor-manager",
    "mineflayer-pvp"
  ];
  if (options.bloodhoundEnabled) {
    modules.push("@miner-org/bloodhound");
  }

  for (const moduleName of modules) {
    const moduleValue = loadPluginModule(moduleName);
    const plugin = extractPlugin(moduleValue);
    if (plugin) {
      try {
        bot.loadPlugin(plugin);
        report.loaded.push(moduleName);
      } catch (error) {
        report.failed.push({
          name: moduleName,
          reason: stringifyError(error)
        });
      }
    } else {
      report.failed.push({
        name: moduleName,
        reason: "plugin export not found"
      });
    }
  }

  if (options.tpsPluginEnabled) {
    const tpsFactory = loadPluginModule("mineflayer-tps");
    const mineflayerRef = options.mineflayer ?? loadPluginModule("mineflayer");
    if (typeof tpsFactory === "function" && mineflayerRef) {
      try {
        const tpsPluginCandidate = (tpsFactory as (mineflayerValue: unknown) => unknown)(mineflayerRef);
        const tpsPlugin = extractPlugin(tpsPluginCandidate);
        if (tpsPlugin) {
          bot.loadPlugin(tpsPlugin);
          report.loaded.push("mineflayer-tps");
        } else {
          report.failed.push({
            name: "mineflayer-tps",
            reason: "plugin export not found"
          });
        }
      } catch (error) {
        report.failed.push({
          name: "mineflayer-tps",
          reason: stringifyError(error)
        });
      }
    } else {
      report.failed.push({
        name: "mineflayer-tps",
        reason: "factory or mineflayer dependency unavailable"
      });
    }
  }

  if (options.webInventoryEnabled) {
    const inventoryViewer = loadPluginModule("mineflayer-web-inventory");
    if (typeof inventoryViewer === "function") {
      try {
        (inventoryViewer as (botValue: Bot, settings: Record<string, unknown>) => void)(bot, {
          port: options.webInventoryPort,
          startOnLoad: true,
          windowUpdateDebounceTime: 80
        });
        report.loaded.push("mineflayer-web-inventory");
        report.webInventoryUrl = `http://127.0.0.1:${options.webInventoryPort}`;
      } catch (error) {
        report.failed.push({
          name: "mineflayer-web-inventory",
          reason: stringifyError(error)
        });
      }
    } else {
      report.failed.push({
        name: "mineflayer-web-inventory",
        reason: "module export is not callable"
      });
    }
  }

  if (options.debugViewer) {
    const viewerModule = loadPluginModule("prismarine-viewer");
    const mineflayerViewer =
      viewerModule &&
      typeof viewerModule === "object" &&
      (viewerModule as Record<string, unknown>).mineflayer;

    if (typeof mineflayerViewer === "function") {
      try {
        (mineflayerViewer as (botValue: Bot, settings: { port: number; firstPerson: boolean }) => void)(bot, {
          port: options.viewerPort,
          firstPerson: false
        });
        report.loaded.push("prismarine-viewer");
      } catch (error) {
        report.failed.push({
          name: "prismarine-viewer",
          reason: stringifyError(error)
        });
      }
    } else {
      report.failed.push({
        name: "prismarine-viewer",
        reason: "mineflayer viewer export not found"
      });
    }
  }

  if ((bot as Bot & { autoEat?: { enable: () => void } }).autoEat) {
    try {
      (bot as Bot & { autoEat: { enable: () => void } }).autoEat.enable();
    } catch (error) {
      report.failed.push({
        name: "mineflayer-auto-eat",
        reason: `enable failed: ${stringifyError(error)}`
      });
    }
  }

  return report;
};
