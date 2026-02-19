export class ExplorerLimiter {
  private readonly maxConcurrent: number;

  private readonly active = new Set<string>();

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  tryEnter(botId: string): boolean {
    if (this.active.has(botId)) {
      return true;
    }

    if (this.active.size >= this.maxConcurrent) {
      return false;
    }

    this.active.add(botId);
    return true;
  }

  leave(botId: string): void {
    this.active.delete(botId);
  }
}
