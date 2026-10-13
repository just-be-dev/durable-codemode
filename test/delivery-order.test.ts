/**
 * Obstacle 2: in opencode's interpreter every promise and async function is its own Effect fiber, tool results arrive
 * whenever the tool's Effect completes, and `await` continues through `Effect.yieldNow` (a scheduler task). So what a
 * script does depends on when results arrive relative to the interpreter's queued tasks, not only on the results and
 * their order. These tests show that, and that the gate (`IdleScheduler` + one release per idle point, journaled)
 * makes live runs and replays agree.
 */
import { describe, expect, test } from "bun:test"
import { type GateMode } from "../src/index.js"
import { prng } from "../src/determinism.js"
import { crashAfter, memoryStore, runToEnd, timedTools } from "./fixtures/inprocess.js"

/** `a`'s continuation takes three turns; where `b`'s single turn lands among them depends on arrival time. */
const INTERLEAVE = `
const log = []
const a = (async () => { await tools.t({ id: "a" }); log.push("a1"); await null; log.push("a2"); await null; log.push("a3") })()
const b = (async () => { await tools.t({ id: "b" }); log.push("b") })()
await Promise.all([a, b])
return log.join(",")
`

/** Records the order results were processed in, then makes a call that depends on it. */
const ORDER = `
const order = []
await Promise.all(["a", "b", "c", "d"].map(async (id) => { await tools.t({ id }); order.push(id) }))
const next = await tools.t({ id: "after-" + order[0] })
return order.join(",") + " -> " + next
`

const live = async (code: string, delays: Record<string, number>, gate: GateMode) => {
  const { tools } = timedTools(delays)
  const result = await runToEnd({ runId: "r", code, tools, store: memoryStore(), gate, seed: 1, startedAt: 0 })
  expect(result.ok).toBe(true)
  return result.ok ? result.value : undefined
}

describe("without the gate, delivery is timing-dependent", () => {
  test("same results, same completion order (a before b), different outcome", async () => {
    const far = await live(INTERLEAVE, { a: 10, b: 60 }, "none")
    const near = await live(INTERLEAVE, { a: 10, b: 11 }, "none")
    expect(far).toBe("a1,a2,a3,b")
    // b's result arrived while a's continuation was between turns. A journal of completion order (a, b) cannot tell
    // these two runs apart, so recording the order alone is not enough to replay either.
    expect(near).toBe("a1,b,a2,a3")
  })

  test("a naive replay (journaled results returned at once) takes another path and diverges", async () => {
    const { tools } = timedTools({ a: 40, b: 10, c: 30, d: 20, "after-b": 300 })
    const store = memoryStore()
    // Crash while the phase-2 call runs: the journal has tools.t({ id: "after-b" }) as call #4.
    await crashAfter({ runId: "n", code: ORDER, tools, store, gate: "none" }, (s) => s.calls("n").length === 5)
    expect(store.calls("n")[4]).toMatchObject({ args: '{"id":"after-b"}' })
    const resumed = await runToEnd({ runId: "n", code: ORDER, tools, store, gate: "none" })
    // Results all available at once settle in call order: a first, so the script now calls after-a.
    expect(resumed).toMatchObject({
      ok: false,
      error: {
        kind: "ReplayDivergence",
        message: expect.stringContaining('call #4 is tools.t({"id":"after-a"}), but was tools.t({"id":"after-b"})'),
      },
    })
  })
})

const TRIALS = 25

/**
 * Run a script whose continuations interleave through shared state (phase 2 depends on what phase 1 observed) under
 * random timings with many simultaneous completions; then replay each run from its full journal and compare.
 */
const trials = async (gate: GateMode) => {
  const code = `
    const log = []
    const work = async (id) => {
      const v = await tools.t({ id })
      log.push(v + ":1")
      await null
      log.push(v + ":2")
      if (log.length % 3 === 0) log.push((await tools.t({ id: v + "-more" })) + ":3")
      return Math.floor(Math.random() * 1000)
    }
    const rolls = await Promise.all(["p", "q", "r", "s", "u", "v"].map(work))
    const tail = await tools.t({ id: "tail-" + log.slice(0, 4).join("|") })
    return { log, rolls, tail, now: Date.now() }
  `
  const random = prng(2024)
  const counts = { same: 0, diverged: 0, differed: 0 }
  for (let trial = 0; trial < TRIALS; trial++) {
    // Few distinct delays, so many results complete in the same timer tick.
    const delays: Record<string, number> = {}
    for (const id of ["p", "q", "r", "s", "u", "v"]) {
      delays[id] = [2, 2, 3, 5][Math.floor(random() * 4)]!
      delays[`${id}-more`] = [1, 2, 4][Math.floor(random() * 3)]!
    }
    const { tools, executions } = timedTools(delays)
    const store = memoryStore()
    const first = await runToEnd({ runId: "t", code, tools, store, seed: trial, startedAt: 0, gate })
    expect(first.ok).toBe(true)
    // Forget the result: the next attempt replays every delivery from the journal.
    store.db.exec("UPDATE runs SET result = NULL")
    const ran = executions.length
    const replayed = await runToEnd({ runId: "t", code, tools, store, gate })
    if (!replayed.ok) counts.diverged++
    else if (JSON.stringify(replayed) === JSON.stringify(first)) counts.same++
    else counts.differed++
    if (replayed.ok) expect(executions.length).toBe(ran)
  }
  return counts
}

describe("with the gate", () => {
  test("live delivery is serialized: a result is only released once the script is idle", async () => {
    // Whatever the spacing, b is held until a's whole continuation has run.
    for (const b of [60, 11, 10]) expect(await live(INTERLEAVE, { a: 10, b }, "serialized")).toBe("a1,a2,a3,b")
  })

  test("a replay after a crash takes the same path", async () => {
    const { tools, executions } = timedTools({ a: 40, b: 10, c: 30, d: 20, "after-b": 300 })
    const store = memoryStore()
    await crashAfter({ runId: "s", code: ORDER, tools, store }, (s) => s.calls("s").length === 5)
    const resumed = await runToEnd({ runId: "s", code: ORDER, tools, store })
    expect(resumed).toMatchObject({ ok: true, value: "b,d,c,a -> after-b" })
    // Only the call in flight at the crash ran again.
    expect(executions).toEqual(["a", "b", "c", "d", "after-b", "after-b"])
  })

  test("replay reproduces the live run exactly, across random timings with simultaneous completions", async () => {
    const serialized = await trials("serialized")
    expect(serialized).toEqual({ same: TRIALS, diverged: 0, differed: 0 })
    // The same trials without the gate: most replays take another path.
    const none = await trials("none")
    expect(none.diverged).toBeGreaterThan(TRIALS / 2)
  })
})
