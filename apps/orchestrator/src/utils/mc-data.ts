const mcDataCache = new Map<string, any>();

export const getMcData = (version: string): any => {
  const cached = mcDataCache.get(version);
  if (cached) {
    return cached;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const data = require("minecraft-data")(version);
  mcDataCache.set(version, data);
  return data;
};
