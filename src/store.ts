import { Database } from "bun:sqlite"

/** How a tool call ended, as the script sees it. Stored as JSON; the same value drives live and replayed delivery. */
export type Outcome =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly message: string }

/** What a run starts with; every attempt starts the interpreter from exactly this. */
export type RunRecord = {
  readonly runId: string
  readonly code: string
  readonly seed: number
  readonly startedAt: number
  readonly fingerprint: string
  /** The final result (JSON), written once. */
  readonly result?: string
}

/** One tool call, by the order the script made it (`idx` 0, 1, ...). Written before the tool runs. */
export type CallRecord = {
  readonly idx: number
  readonly name: string
  /** Canonical JSON of the decoded input. */
  readonly args: string
  /** Absent while running; a call without one at restart was in flight. */
  readonly outcome?: Outcome
}

/** One result handed to the script, in delivery order (`seq` 1, 2, ...). Written before the hand-off. */
export type DeliveryRecord = {
  readonly seq: number
  readonly idx: number
  /** The virtual clock while the script processes this result. */
  readonly at: number
}

/**
 * The journal. Every write is durable before the caller continues: a call is recorded before it runs, its outcome
 * before it can be delivered, a delivery before the script sees it.
 */
export interface JournalStore {
  getRun(runId: string): RunRecord | undefined
  createRun(run: RunRecord): void
  finishRun(runId: string, result: string): void
  calls(runId: string): Array<CallRecord>
  recordCall(runId: string, idx: number, name: string, args: string): void
  recordOutcome(runId: string, idx: number, outcome: Outcome): void
  deliveries(runId: string): Array<DeliveryRecord>
  recordDelivery(runId: string, delivery: DeliveryRecord): void
  /** Calls the script had made once it was idle after delivery `seq` (0: after its first run), by seq. */
  acks(runId: string): Map<number, number>
  recordAck(runId: string, seq: number, issued: number): void
}

/** `JournalStore` over bun:sqlite. Writes are synchronous, so "recorded" means committed when the call returns. */
export class SqliteJournalStore implements JournalStore {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = FULL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, code TEXT NOT NULL, seed INTEGER NOT NULL, started_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS calls (
        run_id TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, outcome TEXT,
        PRIMARY KEY (run_id, idx)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, idx INTEGER NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS acks (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, issued INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
      );
    `)
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db
      .query<
        { code: string; seed: number; started_at: number; fingerprint: string; result: string | null },
        [string]
      >("SELECT code, seed, started_at, fingerprint, result FROM runs WHERE run_id = ?")
      .get(runId)
    if (row === null) return undefined
    return {
      runId,
      code: row.code,
      seed: row.seed,
      startedAt: row.started_at,
      fingerprint: row.fingerprint,
      ...(row.result === null ? {} : { result: row.result }),
    }
  }

  createRun(run: RunRecord): void {
    this.db
      .query("INSERT INTO runs (run_id, code, seed, started_at, fingerprint) VALUES (?, ?, ?, ?, ?)")
      .run(run.runId, run.code, run.seed, run.startedAt, run.fingerprint)
  }

  finishRun(runId: string, result: string): void {
    // Decided once: a second decision (a racing divergence) keeps the first.
    this.db.query("UPDATE runs SET result = ? WHERE run_id = ? AND result IS NULL").run(result, runId)
  }

  calls(runId: string): Array<CallRecord> {
    return this.db
      .query<{ idx: number; name: string; args: string; outcome: string | null }, [string]>(
        "SELECT idx, name, args, outcome FROM calls WHERE run_id = ? ORDER BY idx",
      )
      .all(runId)
      .map((row) => ({
        idx: row.idx,
        name: row.name,
        args: row.args,
        ...(row.outcome === null ? {} : { outcome: JSON.parse(row.outcome) as Outcome }),
      }))
  }

  recordCall(runId: string, idx: number, name: string, args: string): void {
    this.db.query("INSERT INTO calls (run_id, idx, name, args) VALUES (?, ?, ?, ?)").run(runId, idx, name, args)
  }

  recordOutcome(runId: string, idx: number, outcome: Outcome): void {
    this.db
      .query("UPDATE calls SET outcome = ? WHERE run_id = ? AND idx = ?")
      .run(JSON.stringify(outcome), runId, idx)
  }

  deliveries(runId: string): Array<DeliveryRecord> {
    return this.db
      .query<DeliveryRecord, [string]>("SELECT seq, idx, at FROM deliveries WHERE run_id = ? ORDER BY seq")
      .all(runId)
  }

  recordDelivery(runId: string, delivery: DeliveryRecord): void {
    this.db
      .query("INSERT INTO deliveries (run_id, seq, idx, at) VALUES (?, ?, ?, ?)")
      .run(runId, delivery.seq, delivery.idx, delivery.at)
  }

  acks(runId: string): Map<number, number> {
    const rows = this.db
      .query<{ seq: number; issued: number }, [string]>("SELECT seq, issued FROM acks WHERE run_id = ?")
      .all(runId)
    return new Map(rows.map((row) => [row.seq, row.issued]))
  }

  recordAck(runId: string, seq: number, issued: number): void {
    this.db.query("INSERT OR IGNORE INTO acks (run_id, seq, issued) VALUES (?, ?, ?)").run(runId, seq, issued)
  }

  close(): void {
    this.db.close()
  }
}
