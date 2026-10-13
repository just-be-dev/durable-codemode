/**
 * pi-durable's own code mode tool, running on opencode's interpreter (`OpencodeCodemodeSandbox`), survives a real
 * SIGKILL: a new process reopens the SQLite session, pi-durable replays the script through the opencode launcher, the
 * subagents that had finished are not asked again, and the answer is the one an uninterrupted run gives.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classify, finishedCount, readLedger, runAndKill, runToEnd } from "../examples/pi-durable/crash.js"

const dir = mkdtempSync(join(tmpdir(), "durable-codemode-pi-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const reference = runToEnd(join(dir, "ref.sqlite"), join(dir, "ref-ledger.sqlite"))

const scenarios = [
  { name: "mid fan-out (3 of 6 reviews done)", ready: (c: Parameters<typeof finishedCount>[0]) => finishedCount(c, "review") >= 3 },
  {
    name: "mid phase 2 (all reviews and the first verification done)",
    ready: (c: Parameters<typeof finishedCount>[0]) => finishedCount(c, "verify-worst") >= 1,
  },
]

describe("pi-durable code mode on opencode's interpreter", () => {
  test("an uninterrupted run answers from every subagent", async () => {
    const answer = await reference
    expect(answer).toStartWith("Release review finished. ")
    const result = JSON.parse(answer.slice("Release review finished. ".length))
    expect(result.findings).toHaveLength(6)
    const counts = readLedger(join(dir, "ref-ledger.sqlite"))
    for (const [key, count] of Object.entries(counts)) expect([key, count]).toEqual([key, { starts: 1, finishes: 1 }])
  })

  for (const [index, scenario] of scenarios.entries()) {
    test(`SIGKILL ${scenario.name}, then resume in a new process`, async () => {
      const session = join(dir, `s${index}.sqlite`)
      const ledger = join(dir, `l${index}.sqlite`)
      const killed = await runAndKill(session, ledger, scenario.ready)
      expect(killed.signal).toBe("SIGKILL")
      const { finished, running } = classify(killed.counts)
      expect(finished.length).toBeGreaterThan(0)
      expect(running.length).toBeGreaterThan(0)

      const answer = await runToEnd(session, ledger)
      // The script completed after the restart and the answer is the uninterrupted one.
      expect(answer).toBe(await reference)

      const counts = readLedger(ledger)
      // Subagents that had answered were not run or asked again: pi-durable replayed their results into the script.
      for (const task of finished) {
        expect([task, counts[`subagent:${task}`], counts[`model:${task}`]]).toEqual([
          task,
          { starts: 1, finishes: 1 },
          { starts: 1, finishes: 1 },
        ])
      }
      // Subagents running at the kill ran again (they are replay-safe) and their child asked the model again.
      for (const task of running) {
        expect([task, counts[`subagent:${task}`], counts[`model:${task}`]]).toEqual([
          task,
          { starts: 2, finishes: 1 },
          { starts: 2, finishes: 1 },
        ])
      }
      // Everything else ran once, after the restart.
      for (const [key, count] of Object.entries(counts)) {
        const task = key.slice(key.indexOf(":") + 1)
        if (!finished.includes(task) && !running.includes(task)) expect([key, count]).toEqual([key, { starts: 1, finishes: 1 }])
      }
      // A third process finds the run answered and runs nothing.
      expect(await runToEnd(session, ledger)).toBe(answer)
      expect(readLedger(ledger)).toEqual(counts)
    }, 60_000)
  }

  test("a replay that sees another clock makes other calls, and pi-durable refuses it", async () => {
    const session = join(dir, "skew.sqlite")
    const ledger = join(dir, "skew-ledger.sqlite")
    // Killed in phase 2, after a verification whose arguments carry a clock reading has finished.
    await runAndKill(session, ledger, scenarios[1]!.ready)
    const answer = await runToEnd(session, ledger, { SKEW_CLOCK_MS: "1" })
    // The script's code mode call ended with an error instead of a RESULT line, and nothing new was started.
    expect(answer).toBe("Release review finished. (none)")
  }, 60_000)
})
