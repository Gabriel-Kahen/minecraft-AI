import { nowIso } from "../utils/time";
import type { SQLiteStore } from "../store";

interface LockLease {
  resourceKey: string;
  ownerBotId: string;
  expiresAt: number;
}

export class LockManager {
  private readonly leases = new Map<string, LockLease>();

  private readonly leaseMs: number;

  private readonly store: SQLiteStore;

  constructor(store: SQLiteStore, leaseMs: number) {
    this.store = store;
    this.leaseMs = leaseMs;
  }

  acquire(resourceKey: string, ownerBotId: string): boolean {
    this.expireOldLeases();

    const current = this.leases.get(resourceKey);
    if (current && current.ownerBotId !== ownerBotId) {
      return false;
    }

    const next: LockLease = {
      resourceKey,
      ownerBotId,
      expiresAt: Date.now() + this.leaseMs
    };
    this.leases.set(resourceKey, next);
    this.store.insertLockEvent(resourceKey, ownerBotId, "ACQUIRE", nowIso(), {
      expires_at_ms: next.expiresAt
    });

    return true;
  }

  heartbeat(resourceKey: string, ownerBotId: string): boolean {
    const current = this.leases.get(resourceKey);
    if (!current || current.ownerBotId !== ownerBotId) {
      return false;
    }
    current.expiresAt = Date.now() + this.leaseMs;
    this.leases.set(resourceKey, current);
    return true;
  }

  release(resourceKey: string, ownerBotId: string): void {
    const current = this.leases.get(resourceKey);
    if (!current || current.ownerBotId !== ownerBotId) {
      return;
    }

    this.leases.delete(resourceKey);
    this.store.insertLockEvent(resourceKey, ownerBotId, "RELEASE", nowIso());
  }

  ownerOf(resourceKey: string): string | null {
    this.expireOldLeases();
    const current = this.leases.get(resourceKey);
    return current?.ownerBotId ?? null;
  }

  private expireOldLeases(): void {
    const now = Date.now();
    for (const [key, lease] of this.leases.entries()) {
      if (lease.expiresAt <= now) {
        this.leases.delete(key);
        this.store.insertLockEvent(key, lease.ownerBotId, "EXPIRE", nowIso(), {
          expired_at_ms: now
        });
      }
    }
  }
}
