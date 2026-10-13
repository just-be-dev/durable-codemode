import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { Namespace, Tool } from "../../vendor/codemode/index.js"

/**
 * The outside world the fake tools act on: how many times each call started and finished. Lives in its own SQLite
 * file so it survives the worker process being killed, as a real side effect would.
 */
export class Ledger {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY, starts INTEGER NOT NULL DEFAULT 0, finishes INTEGER NOT NULL DEFAULT 0)",
    )
  }

  started(key: string): void {
    this.db
      .query("INSERT INTO effects (key, starts) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET starts = starts + 1")
      .run(key)
  }

  finished(key: string): void {
    this.db.query("UPDATE effects SET finishes = finishes + 1 WHERE key = ?").run(key)
  }

  counts(): Record<string, { starts: number; finishes: number }> {
    const rows = this.db
      .query<{ key: string; starts: number; finishes: number }, []>("SELECT key, starts, finishes FROM effects")
      .all()
    return Object.fromEntries(rows.map((row) => [row.key, { starts: row.starts, finishes: row.finishes }]))
  }

  close(): void {
    this.db.close()
  }
}

export const TASKS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"] as const

/** A stable "random-ish" number per string. */
export const hash = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0
  return h
}

/** Phase-1 delay per task: spread out so completions arrive one at a time, in an order unlike the call order. */
export const defaultDelay = (task: string): number => 40 + (hash(task) % 8) * 45

export type ToolOptions = {
  readonly ledger?: Ledger
  /** Milliseconds a phase-1 call takes; default `defaultDelay`. */
  readonly delay?: (task: string) => number
}

/**
 * Fake subagent tools. `agents.run` is phase 1 (slow, parallel); `agents.review` is phase 2 and depends on phase-1
 * results. Each call counts a start before it waits and a finish after, in the ledger.
 */
export const makeTools = (options: ToolOptions = {}) => {
  const delay = options.delay ?? defaultDelay
  const run = Tool.make({
    description: "Run a subagent on a task",
    input: Schema.Struct({ task: Schema.String }),
    output: Schema.Struct({ task: Schema.String, summary: Schema.String, score: Schema.Number }),
    execute: ({ task }) =>
      Effect.gen(function* () {
        const key = `run:${task}`
        options.ledger?.started(key)
        yield* Effect.sleep(delay(task))
        options.ledger?.finished(key)
        return { task, summary: `${task} done`, score: hash(task) % 100 }
      }),
  })
  const review = Tool.make({
    description: "Review a subagent's work",
    input: Schema.Struct({ task: Schema.String, stamp: Schema.Number, nonce: Schema.String }),
    output: Schema.Struct({ task: Schema.String, verdict: Schema.String }),
    execute: ({ task }) =>
      Effect.gen(function* () {
        const key = `review:${task}`
        options.ledger?.started(key)
        yield* Effect.sleep(30 + (hash(key) % 5) * 40)
        options.ledger?.finished(key)
        return { task, verdict: hash(`review:${task}`) % 2 === 0 ? "approved" : "needs work" }
      }),
  })
  return { agents: Namespace.make({ description: "Subagents", tools: { run, review } }) }
}

/**
 * Fan out N subagents in parallel, then a second phase that depends on their results and uses `Date.now()` and
 * `Math.random()`. The phase-2 arguments carry a clock reading and a random nonce, so a replay that saw a different
 * clock or random stream would make different calls and be caught as a divergence.
 *
 * `order` (the order phase-1 results were processed in) depends on delivery order; it is logged, not returned, so the
 * returned value is comparable with an uninterrupted run.
 */
export const SCENARIO = `
const startedAt = Date.now()
const tasks = ${JSON.stringify(TASKS)}
const order = []
const results = await Promise.all(tasks.map(async (task) => {
  const result = await tools.agents.run({ task })
  order.push(task)
  return result
}))
console.log("processed in order: " + order.join(","))
const best = results.reduce((a, b) => (b.score > a.score ? b : a))
const pick = tasks[Math.floor(Math.random() * tasks.length)]
const reviews = await Promise.all([best.task, pick].map((task) =>
  tools.agents.review({ task, stamp: Date.now(), nonce: Math.random().toString(36).slice(2, 10) })))
return {
  startedAt: new Date(startedAt).toISOString(),
  scores: results.map((r) => r.task + ":" + r.score),
  best: best.task,
  pick,
  reviews: reviews.map((r) => r.task + ":" + r.verdict),
  id: crypto.randomUUID(),
}
`
