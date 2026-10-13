/**
 * Runs the fan-out scenario in a worker process, SIGKILLs it after a few subagent calls finished, starts it again,
 * and shows what ran how often.
 *
 *   bun run demo [killAfter=3]
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteJournalStore } from "../src/index.js"
import { runAndKill, runToEnd } from "../test/fixtures/crash.js"
import { Ledger, SCENARIO } from "../test/fixtures/scenario.js"

const killAfter = Number(process.argv[2] ?? 3)
const dir = mkdtempSync(join(tmpdir(), "durable-codemode-demo-"))
const journal = join(dir, "journal.sqlite")
const ledgerPath = join(dir, "ledger.sqlite")

console.log("Script:\n" + SCENARIO.trim().split("\n").map((line) => "  | " + line).join("\n") + "\n")

console.log(`1. Start the worker; SIGKILL it once ${killAfter} tool calls have finished.`)
const killed = await runAndKill(journal, ledgerPath, "demo", killAfter)
console.log(`   worker killed by ${killed.signal}. Journal at that moment:`)
for (const call of killed.calls) {
  console.log(`   #${call.idx} tools.${call.name}(${call.args}) ${call.outcome === null ? "IN FLIGHT" : "finished"}`)
}

console.log("\n2. Start the worker again with the same run id.")
const started = Date.now()
const resumed = await runToEnd(journal, ledgerPath, "demo")
console.log(`   finished in ${Date.now() - started}ms: ${resumed.ok ? "ok" : JSON.stringify(resumed.error)}`)
console.log("   value: " + JSON.stringify(resumed.value))
console.log("   logs:  " + JSON.stringify(resumed.logs))

const store = new SqliteJournalStore(journal)
console.log(`   deliveries (call index, in the order the script got them): ${store.deliveries("demo").map((d) => d.idx).join(", ")}`)
store.close()

const ledger = new Ledger(ledgerPath)
console.log("\n3. Side effects (starts / finishes per call):")
for (const [key, { starts, finishes }] of Object.entries(ledger.counts())) {
  const note = starts === 1 ? "ran once" : "in flight at the kill: ran again"
  console.log(`   ${key.padEnd(16)} ${starts} / ${finishes}  ${note}`)
}
const counts = ledger.counts()

console.log("\n4. Invoke the finished run a third time.")
const again = await runToEnd(journal, ledgerPath, "demo")
const unchanged = JSON.stringify(ledger.counts()) === JSON.stringify(counts)
console.log(`   same result: ${JSON.stringify(again) === JSON.stringify(resumed)}; tool executions: ${unchanged ? 0 : "some!"}`)
ledger.close()

console.log("\n5. Compare with an uninterrupted run (same seed and start time, fresh journal).")
const reference = await runToEnd(join(dir, "ref.sqlite"), join(dir, "ref-ledger.sqlite"), "demo")
console.log(`   values equal: ${JSON.stringify(reference.value) === JSON.stringify(resumed.value)}`)

rmSync(dir, { recursive: true, force: true })
