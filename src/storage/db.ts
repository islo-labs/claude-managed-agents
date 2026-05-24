import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface SessionRow {
  session_id: string;
  sandbox_name: string | null;
  sandbox_id: string | null;
  snapshot_name: string | null;
  last_event_type: string | null;
  status: string;
  work_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventRow {
  id: string;
  event_type: string;
  session_id: string | null;
  payload: string;
  received_at: string;
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        sandbox_name TEXT,
        sandbox_id TEXT,
        snapshot_name TEXT,
        last_event_type TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        work_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        session_id TEXT,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_events_session
        ON webhook_events(session_id);
    `);
  }

  upsertSession(
    sessionId: string,
    eventType: string,
    status?: string,
  ): SessionRow {
    const now = new Date().toISOString();
    const existing = this.getSession(sessionId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE sessions
           SET last_event_type = ?, status = COALESCE(?, status), updated_at = ?
           WHERE session_id = ?`,
        )
        .run(eventType, status ?? null, now, sessionId);
      return this.getSession(sessionId)!;
    }
    this.db
      .prepare(
        `INSERT INTO sessions
         (session_id, sandbox_name, sandbox_id, snapshot_name, last_event_type, status, work_id, created_at, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, ?, NULL, ?, ?)`,
      )
      .run(sessionId, eventType, status ?? "unknown", now, now);
    return this.getSession(sessionId)!;
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
  }

  bindSandbox(
    sessionId: string,
    sandboxName: string,
    sandboxId: string,
    workId: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
         SET sandbox_name = ?, sandbox_id = ?, work_id = ?, status = 'running', updated_at = ?
         WHERE session_id = ?`,
      )
      .run(sandboxName, sandboxId, workId, now, sessionId);
  }

  setSnapshot(sessionId: string, snapshotName: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
         SET snapshot_name = ?, status = 'idle', updated_at = ?
         WHERE session_id = ?`,
      )
      .run(snapshotName, now, sessionId);
  }

  clearSandbox(sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
         SET sandbox_name = NULL, sandbox_id = NULL, work_id = NULL, status = 'idle', updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, sessionId);
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as SessionRow[];
  }

  recordWebhookEvent(
    id: string,
    eventType: string,
    sessionId: string | null,
    payload: unknown,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_events (id, event_type, session_id, payload, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        eventType,
        sessionId,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }
}
