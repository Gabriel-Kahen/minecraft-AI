import Database from "better-sqlite3";
import type { IncidentRecord, PlannerCallRecord, SubgoalAttemptRecord } from "../../../../contracts/events";
import type { SnapshotV1 } from "../../../../contracts/snapshot";

export class SQLiteStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_state (
        bot_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(bot_id) REFERENCES bots(id)
      );

      CREATE TABLE IF NOT EXISTS subgoal_attempts (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        subgoal TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        error_details TEXT,
        result_json TEXT NOT NULL,
        FOREIGN KEY(bot_id) REFERENCES bots(id)
      );

      CREATE TABLE IF NOT EXISTS llm_calls (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        details TEXT,
        FOREIGN KEY(bot_id) REFERENCES bots(id)
      );

      CREATE TABLE IF NOT EXISTS locks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_key TEXT NOT NULL,
        owner_bot_id TEXT NOT NULL,
        action TEXT NOT NULL,
        ts TEXT NOT NULL,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        category TEXT NOT NULL,
        error_code TEXT,
        details TEXT NOT NULL,
        FOREIGN KEY(bot_id) REFERENCES bots(id)
      );

      CREATE INDEX IF NOT EXISTS idx_subgoal_attempts_bot_time ON subgoal_attempts(bot_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_llm_calls_bot_time ON llm_calls(bot_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_locks_key_time ON locks(resource_key, ts);
    `);

    this.migrateLegacyBotsRoleColumn();
  }

  insertRun(id: string, startedAt: string, config: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO runs (id, started_at, config_json) VALUES (?, ?, ?)")
      .run(id, startedAt, JSON.stringify(config));
  }

  upsertBot(botId: string, createdAt: string): void {
    this.db
      .prepare(
        `
          INSERT INTO bots (id, created_at)
          VALUES (?, ?)
          ON CONFLICT(id) DO NOTHING
        `
      )
      .run(botId, createdAt);
  }

  upsertBotSnapshot(botId: string, snapshot: SnapshotV1, updatedAt: string): void {
    this.db
      .prepare(
        `
          INSERT INTO bot_state (bot_id, snapshot_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(bot_id) DO UPDATE
          SET snapshot_json=excluded.snapshot_json,
              updated_at=excluded.updated_at
        `
      )
      .run(botId, JSON.stringify(snapshot), updatedAt);
  }

  insertSubgoalAttempt(attempt: SubgoalAttemptRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO subgoal_attempts
          (id, bot_id, subgoal, started_at, ended_at, duration_ms, outcome, error_code, error_details, result_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        attempt.id,
        attempt.botId,
        attempt.subgoal,
        attempt.startedAt,
        attempt.endedAt,
        attempt.durationMs,
        attempt.result.outcome,
        attempt.result.outcome === "FAILURE" ? attempt.result.errorCode : null,
        attempt.result.outcome === "FAILURE" ? attempt.result.details : null,
        JSON.stringify(attempt.result)
      );
  }

  insertPlannerCall(call: PlannerCallRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO llm_calls
          (id, bot_id, started_at, ended_at, duration_ms, status, model, tokens_in, tokens_out, details)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        call.id,
        call.botId,
        call.startedAt,
        call.endedAt,
        call.durationMs,
        call.status,
        call.model,
        call.tokensIn ?? null,
        call.tokensOut ?? null,
        JSON.stringify({})
      );
  }

  insertLockEvent(
    resourceKey: string,
    ownerBotId: string,
    action: "ACQUIRE" | "RELEASE" | "EXPIRE",
    ts: string,
    details: Record<string, unknown> = {}
  ): void {
    this.db
      .prepare(
        "INSERT INTO locks (resource_key, owner_bot_id, action, ts, details_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run(resourceKey, ownerBotId, action, ts, JSON.stringify(details));
  }

  insertIncident(incident: IncidentRecord): void {
    this.db
      .prepare(
        "INSERT INTO incidents (id, bot_id, ts, category, error_code, details) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        incident.id,
        incident.botId,
        incident.ts,
        incident.category,
        incident.errorCode ?? null,
        incident.details
      );
  }

  close(): void {
    this.db.close();
  }

  private migrateLegacyBotsRoleColumn(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(bots)")
      .all() as Array<{ name: string }>;
    const hasRoleColumn = columns.some((column) => column.name === "role");
    if (!hasRoleColumn) {
      return;
    }

    this.db.exec(`
      PRAGMA foreign_keys = OFF;

      CREATE TABLE IF NOT EXISTS bots_next (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      INSERT OR REPLACE INTO bots_next (id, created_at)
      SELECT id, created_at FROM bots;

      DROP TABLE bots;
      ALTER TABLE bots_next RENAME TO bots;

      PRAGMA foreign_keys = ON;
    `);
  }
}
