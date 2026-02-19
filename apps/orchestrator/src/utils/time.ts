export const nowIso = (): string => new Date().toISOString();

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withJitter = (baseMs: number, jitterRatio = 0.15): number => {
  const jitter = baseMs * jitterRatio;
  const min = Math.max(0, baseMs - jitter);
  const max = baseMs + jitter;
  return Math.floor(min + Math.random() * (max - min));
};

export const rollingHourWindowStart = (now = Date.now()): number => now - 60 * 60 * 1000;
