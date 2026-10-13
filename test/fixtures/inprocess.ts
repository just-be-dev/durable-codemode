import { Effect, Fiber, Schema } from "effect"
import { DurableCodeMode, type JournalStore, type RunOptions, SqliteJournalStore } from "../../src/index.js"
import { Tool } from "../../vendor/codemode/index.js"

/**
 * Start a run in this process and interrupt it once `k` calls have a journaled outcome (or `until` holds): a crash
 * without the kill. Interrupting the run stops its attempt, so nothing more is journaled after this returns.
 */
export const crashAfter = async <R extends never>(
  options: RunOptions<R>,
  until: number | ((store: JournalStore) => boolean),
): Promise<void> => {
  const reached =
    typeof until === "function"
      ? until
      : (store: JournalStore) => store.calls(options.runId).filter((call) => call.outcome !== undefined).length >= until
  const fiber = Effect.runFork(DurableCodeMode.run(options))
  const deadline = Date.now() + 10_000
  while (!reached(options.store)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for completions")
    if (fiber.pollUnsafe() !== undefined) throw new Error("run finished before the crash")
    await Bun.sleep(1)
  }
  await Effect.runPromise(Fiber.interrupt(fiber))
}

export const runToEnd = <R extends never>(options: RunOptions<R>) => Effect.runPromise(DurableCodeMode.run(options))

export const memoryStore = () => new SqliteJournalStore(":memory:")

/**
 * `tools.t({ id })` resolves with `id` after `delays[id]` ms (default 10) and counts its executions.
 * Used by the small, order-sensitive scripts.
 */
export const timedTools = (delays: Record<string, number> = {}) => {
  const executions: Array<string> = []
  const tools = {
    t: Tool.make({
      description: "Resolve with the id after a delay",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.String,
      execute: ({ id }) =>
        Effect.sync(() => executions.push(id)).pipe(Effect.andThen(Effect.sleep(delays[id] ?? 10)), Effect.as(id)),
    }),
  }
  return { tools, executions }
}
