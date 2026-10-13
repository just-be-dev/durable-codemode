import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { DurableCodeMode, type DurableResult } from "../src/index.js"
import { Tool } from "../vendor/codemode/index.js"
import { crashAfter, memoryStore, runToEnd, timedTools } from "./fixtures/inprocess.js"
import { Ledger, makeTools, SCENARIO } from "./fixtures/scenario.js"

const divergence = (result: DurableResult) => {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("unreachable")
  expect(result.error.kind).toBe("ReplayDivergence")
  return result.error.message
}

describe("completed runs", () => {
  test("re-invoking a completed run returns the stored result with zero tool executions", async () => {
    const store = memoryStore()
    const ledger = new Ledger(":memory:")
    const options = { runId: "done", code: SCENARIO, tools: makeTools({ ledger }), store, seed: 7, startedAt: 0 }
    const first = await runToEnd(options)
    expect(first.ok).toBe(true)
    const executed = ledger.counts()

    const second = await runToEnd(options)
    expect(second).toEqual(first)
    expect(ledger.counts()).toEqual(executed)
    // Not even the code is needed.
    const third = await runToEnd({ runId: "done", tools: makeTools({ ledger }), store })
    expect(third).toEqual(first)
    expect(ledger.counts()).toEqual(executed)
  })

  test("a resumed run whose calls all finished re-executes nothing", async () => {
    const store = memoryStore()
    const ledger = new Ledger(":memory:")
    const options = { runId: "r", code: SCENARIO, tools: makeTools({ ledger }), store, seed: 7, startedAt: 0 }
    const first = await runToEnd(options)
    // As if the process died after the last call finished but before the result was stored.
    store.db.exec("UPDATE runs SET result = NULL")
    const executed = ledger.counts()
    const replayed = await runToEnd(options)
    expect(replayed).toEqual(first)
    expect(ledger.counts()).toEqual(executed)
  })
})

describe("divergence", () => {
  test("a changed script makes a different call: stored ReplayDivergence, no new calls", async () => {
    const store = memoryStore()
    const ledger = new Ledger(":memory:")
    const options = { runId: "d", code: SCENARIO, tools: makeTools({ ledger }), store, seed: 3, startedAt: 0 }
    await crashAfter(options, 3)
    const before = ledger.counts()

    const changed = SCENARIO.replace('"charlie"', '"carol"')
    const result = await runToEnd({ ...options, code: changed })
    expect(divergence(result)).toContain('call #2 is tools.agents.run({"task":"carol"}), but was tools.agents.run({"task":"charlie"})')
    // Calls in flight at the crash were not re-run for a diverged script.
    expect(ledger.counts()).toEqual(before)

    // The error is the run's outcome now, also for the original script.
    expect(await runToEnd(options)).toEqual(result)
    expect(ledger.counts()).toEqual(before)
  })

  test("a different delivery order in the journal leads the script elsewhere: divergence", async () => {
    // Phase 2 depends on which result was processed first.
    const code = `
      const order = []
      await Promise.all(["a", "b", "c"].map(async (id) => { await tools.t({ id }); order.push(id) }))
      return await tools.t({ id: "first-" + order[0] })
    `
    const { tools, executions } = timedTools({ a: 30, b: 10, c: 20, "first-b": 200 })
    const store = memoryStore()
    // Crash while the phase-2 call is running.
    await crashAfter({ runId: "o", code, tools, store }, (s) => s.calls("o").length === 4)
    // The journal says b, c, a were delivered. Swap the first two: replay hands over c first.
    const deliveries = store.deliveries("o")
    expect(deliveries.map((d) => d.idx)).toEqual([1, 2, 0])
    store.db.exec("UPDATE deliveries SET idx = CASE idx WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE idx END WHERE run_id = 'o'")
    const count = executions.length
    const result = await runToEnd({ runId: "o", code, tools, store })
    expect(divergence(result)).toContain('call #3 is tools.t({"id":"first-c"}), but was tools.t({"id":"first-b"})')
    expect(executions.length).toBe(count)
  })

  test("an extra call between results, where the earlier attempt was idle, is caught by the ack check", async () => {
    const original = `
      const a = await tools.t({ id: "a" })
      const b = await tools.t({ id: "b" })
      return a + b
    `
    // Same calls at the same indices, plus one the original never made after result 1.
    const changed = `
      const a = await tools.t({ id: "a" })
      const [b, x] = await Promise.all([tools.t({ id: "b" }), tools.t({ id: "x" })])
      return a + b + x
    `
    const { tools, executions } = timedTools({ a: 5, b: 300 })
    const store = memoryStore()
    // Crash once the original was idle after result 1 (waiting on b) and recorded how many calls it had made.
    await crashAfter({ runId: "x", code: original, tools, store }, (s) => s.acks("x").has(1))
    const result = await runToEnd({ runId: "x", code: changed, tools, store })
    expect(divergence(result)).toContain("once idle after result 1 it had made 3 calls, where it had made 2")
    expect(executions).not.toContain("x")
  })

  test("a script that ends where it went on before diverges", async () => {
    const { tools } = timedTools({ a: 5, b: 300 })
    const store = memoryStore()
    await crashAfter({ runId: "e", code: `await tools.t({ id: "a" }); return await tools.t({ id: "b" })`, tools, store }, 1)
    const result = await runToEnd({ runId: "e", code: `return 1`, tools, store })
    expect(divergence(result)).toContain("it ended after result 0 having made 0 calls")
  })

  test("a changed tool set refuses to replay: FingerprintMismatch", async () => {
    const { tools } = timedTools({ a: 5, b: 300 })
    const store = memoryStore()
    const code = `await tools.t({ id: "a" }); return await tools.t({ id: "b" })`
    await crashAfter({ runId: "f", code, tools, store }, 1)
    const extra = Tool.make({ description: "new", input: Schema.Struct({}), execute: () => Effect.void })
    const result = await runToEnd({ runId: "f", code, tools: { ...tools, extra }, store })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("FingerprintMismatch")
    expect(store.getRun("f")?.result).toBeDefined()
  })
})

describe("replay policy for calls in flight at a crash", () => {
  const code = `
    const settled = await Promise.allSettled(["a", "b"].map((id) => tools.t({ id })))
    return settled.map((s) => s.status === "fulfilled" ? s.value : "failed: " + s.reason.message)
  `

  test("rerun (default) runs them again", async () => {
    const { tools, executions } = timedTools({ a: 5, b: 300 })
    const store = memoryStore()
    await crashAfter({ runId: "p", code, tools, store }, 1)
    const result = await runToEnd({ runId: "p", code, tools, store })
    expect(result).toMatchObject({ ok: true, value: ["a", "b"] })
    expect(executions).toEqual(["a", "b", "b"])
  })

  test("fail hands the script a failure instead", async () => {
    const { tools, executions } = timedTools({ a: 5, b: 300 })
    const store = memoryStore()
    await crashAfter({ runId: "p", code, tools, store }, 1)
    const result = await runToEnd({ runId: "p", code, tools, store, replay: { t: "fail" } })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value).toEqual(["a", expect.stringContaining('tools.t was in flight when the run was interrupted') as unknown as string])
    expect(executions).toEqual(["a", "b"])
  })
})

describe("tool failures", () => {
  test("a failed call replays as the same error the script saw live", async () => {
    const flaky = Tool.make({
      description: "fails for odd n",
      input: Schema.Struct({ n: Schema.Number }),
      output: Schema.Number,
      execute: ({ n }) => (n % 2 === 1 ? Effect.fail(new Error(`odd ${n}`)) : Effect.as(Effect.sleep(n * 20), n)),
    })
    const code = `
      const out = []
      for (const n of [1, 2, 3, 30]) {
        try { out.push(await tools.flaky({ n })) } catch (e) { out.push(e.message) }
      }
      return out
    `
    const store = memoryStore()
    await crashAfter({ runId: "t", code, tools: { flaky }, store }, 3)
    const resumed = await runToEnd({ runId: "t", code, tools: { flaky }, store })
    const fresh = await runToEnd({ runId: "t2", code, tools: { flaky }, store: memoryStore() })
    expect(resumed).toEqual(fresh)
    expect(resumed).toMatchObject({ ok: true, value: ["odd 1", 2, "odd 3", 30] })
  })
})

test("DurableCodeMode.run is an Effect", async () => {
  const { tools } = timedTools()
  const result = await Effect.runPromise(
    DurableCodeMode.run({ runId: "e", code: `return await tools.t({ id: "z" })`, tools, store: memoryStore() }),
  )
  expect(result).toMatchObject({ ok: true, value: "z" })
})
