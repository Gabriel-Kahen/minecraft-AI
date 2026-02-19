import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/fs";

export class JsonlLogger {
  private readonly rootDir: string;

  private readonly streams = new Map<string, WriteStream>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    ensureDir(rootDir);
  }

  private getStream(channel: string): WriteStream {
    const existing = this.streams.get(channel);
    if (existing) {
      return existing;
    }

    const filePath = path.join(this.rootDir, `${channel}.jsonl`);
    const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
    this.streams.set(channel, stream);
    return stream;
  }

  write(channel: string, event: Record<string, unknown>): void {
    const stream = this.getStream(channel);
    stream.write(`${JSON.stringify(event)}\n`);
  }

  close(): void {
    for (const stream of this.streams.values()) {
      stream.end();
    }
    this.streams.clear();
  }
}
