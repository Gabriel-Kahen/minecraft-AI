import { randomUUID } from "node:crypto";

export const makeId = (prefix: string): string => `${prefix}_${randomUUID()}`;
