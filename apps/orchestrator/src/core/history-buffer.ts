import type { ActionHistoryEntry } from "../../../../contracts/planner";

export class ActionHistoryBuffer {
  private readonly limit: number;

  private readonly entries: ActionHistoryEntry[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  add(entry: ActionHistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  snapshot(): ActionHistoryEntry[] {
    return [...this.entries];
  }
}
