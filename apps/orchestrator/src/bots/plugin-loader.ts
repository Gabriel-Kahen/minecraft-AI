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

export interface PluginLoadOptions {
  debugViewer: boolean;
  viewerPort: number;
}

export const loadMineflayerPlugins = (bot: Bot, options: PluginLoadOptions): void => {
  const modules = [
    "mineflayer-pathfinder",
    "mineflayer-collectblock",
    "mineflayer-tool",
    "mineflayer-auto-eat",
    "mineflayer-armor-manager",
    "mineflayer-pvp"
  ];

  for (const moduleName of modules) {
    const moduleValue = loadPluginModule(moduleName);
    const plugin = extractPlugin(moduleValue);
    if (plugin) {
      bot.loadPlugin(plugin);
    }
  }

  if (options.debugViewer) {
    const viewerModule = loadPluginModule("prismarine-viewer");
    const mineflayerViewer =
      viewerModule &&
      typeof viewerModule === "object" &&
      (viewerModule as Record<string, unknown>).mineflayer;

    if (typeof mineflayerViewer === "function") {
      (mineflayerViewer as (botValue: Bot, settings: { port: number; firstPerson: boolean }) => void)(bot, {
        port: options.viewerPort,
        firstPerson: false
      });
    }
  }

  if ((bot as Bot & { autoEat?: { enable: () => void } }).autoEat) {
    (bot as Bot & { autoEat: { enable: () => void } }).autoEat.enable();
  }
};
