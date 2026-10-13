import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteJournalStore } from "../src/index.js"
import { runAndKill, runToEnd } from "./fixtures/crash.js"
import { Ledger, TASKS } from "./fixtures/scenario.js"

const dir = mkdtempSync(join(tmpdir(), "durable-codemode-crash-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The same scenario, seed, and start time, never interrupted. */
const reference = runToEnd(join(dir, "ref.sqlite"), join(dir, "ref-ledger.sqlite"), "ref")

const keyOf = (call: { name: string; args: string }) =>
  `${call.name === "agents.run" ? "run" : "review"}:${(JSON.parse(call.args) as { task: string }).task}`

describe("a real process kill mid-run", () => {
  for (const killAfter of [3, 9]) {
    test(`SIGKILL after ${killAfter} completed calls, then resume`, async () => {
      const journal = join(dir, `k${killAfter}.sqlite`)
      const ledgerPath = join(dir, `k${killAfter}-ledger.sqlite`)
      const killed = await runAndKill(journal, ledgerPath, "run", killAfter)
      expect(killed.signal).toBe("SIGKILL")

      const done = killed.calls.filter((call) => call.outcome !== null).map(keyOf)
      const inFlight = killed.calls.filter((call) => call.outcome === null).map(keyOf)
      expect(done.length).toBeGreaterThanOrEqual(killAfter)
      // The kill landed while calls were running: there is something to re-run.
      expect(inFlight.length).toBeGreaterThan(0)

      const resumed = await runToEnd(journal, ledgerPath, "run")
      expect(resumed.ok).toBe(true)

      // Same value as the uninterrupted run with the same seed: the clock, PRNG, and UUID replayed exactly (the phase-2
      // calls carry `Date.now()` and `Math.random()` in their arguments, so anything else would have diverged).
      expect(resumed.value).toEqual((await reference).value)

      const ledger = new Ledger(ledgerPath)
      const counts = ledger.counts()
      ledger.close()
      // Calls finished before the kill ran exactly once.
      for (const key of done) expect(counts[key]).toEqual({ starts: 1, finishes: 1 })
      // Calls in flight at the kill started twice and finished once (the second time).
      for (const key of inFlight) expect(counts[key]).toEqual({ starts: 2, finishes: 1 })
      // Everything else ran once, after the restart.
      const all = [...TASKS.map((task) => `run:${task}`), ...(resumed.value.reviews as Array<string>).map((r) => `review:${r.split(":")[0]}`)]
      for (const key of all.filter((key) => !done.includes(key) && !inFlight.includes(key))) {
        expect(counts[key]).toEqual({ starts: 1, finishes: 1 })
      }

      // A third invocation returns the stored result and runs nothing.
      const again = await runToEnd(journal, ledgerPath, "run")
      expect(again).toEqual(resumed)
      const after = new Ledger(ledgerPath)
      expect(after.counts()).toEqual(counts)
      after.close()

      const store = new SqliteJournalStore(journal)
      expect(store.getRun("run")?.result).toBeDefined()
      store.close()
    }, 30_000)
  }
})
