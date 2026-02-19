import { mkdirSync } from "node:fs";

export const ensureDir = (dirPath: string): void => {
  mkdirSync(dirPath, { recursive: true });
};
