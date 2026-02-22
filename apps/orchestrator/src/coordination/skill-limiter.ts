export class SkillLimiter {
  private readonly maxConcurrent: number;

  private readonly active = new Set<string>();
  private readonly waiting: string[] = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  tryEnter(botId: string): boolean {
    if (this.active.has(botId)) {
      return true;
    }

    if (!this.waiting.includes(botId)) {
      this.waiting.push(botId);
    }

    if (this.waiting[0] !== botId) {
      return false;
    }

    if (this.active.size >= this.maxConcurrent) {
      return false;
    }

    this.waiting.shift();
    this.active.add(botId);
    return true;
  }

  leave(botId: string): void {
    this.active.delete(botId);
    const waitingIndex = this.waiting.indexOf(botId);
    if (waitingIndex >= 0) {
      this.waiting.splice(waitingIndex, 1);
    }
  }

  forget(botId: string): void {
    this.leave(botId);
  }
}
