/**
 * A worker process that runs (or resumes) the scenario durably and prints its result as JSON.
 *
 *   bun test/fixtures/worker.ts <journal.sqlite> <ledger.sqlite> <runId> [seed] [startedAt]
 *
 * The parent kills it with SIGKILL mid-run and starts it again with the same arguments.
 */
import { Effect } from "effect"
import { DurableCodeMode, SqliteJournalStore } from "../../src/index.js"
import { Ledger, makeTools, SCENARIO } from "./scenario.js"

const [journalPath, ledgerPath, runId, seed, startedAt] = process.argv.slice(2)
if (journalPath === undefined || ledgerPath === undefined || runId === undefined) {
  console.error("usage: worker.ts <journal.sqlite> <ledger.sqlite> <runId> [seed] [startedAt]")
  process.exit(2)
}
const store = new SqliteJournalStore(journalPath)
const ledger = new Ledger(ledgerPath)
const result = await Effect.runPromise(
  DurableCodeMode.run({
    runId,
    code: SCENARIO,
    tools: makeTools({ ledger }),
    store,
    seed: seed === undefined ? 42 : Number(seed),
    startedAt: startedAt === undefined ? 1_700_000_000_000 : Number(startedAt),
  }),
)
console.log(JSON.stringify(result))
store.close()
ledger.close()
