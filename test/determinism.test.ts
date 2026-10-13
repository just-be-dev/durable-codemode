import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { prng, VirtualWorld } from "../src/index.js"
import { CodeMode } from "../vendor/codemode/index.js"
import { memoryStore, runToEnd, timedTools } from "./fixtures/inprocess.js"

const NONDETERMINISTIC = `
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return {
    now: Date.now(),
    date: new Date().toISOString(),
    called: Date(),
    random: [Math.random(), Math.random()],
    uuid: crypto.randomUUID(),
    bytes: Array.from(bytes),
  }
`

describe("the determinism patch (vendored interpreter)", () => {
  test("time and randomness come from the injected sources", async () => {
    let n = 0
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: NONDETERMINISTIC,
        determinism: {
          now: () => 1_000,
          random: () => (n++ % 2) / 2,
          randomUUID: () => "00000000-0000-4000-8000-000000000000",
          getRandomValues: (bytes) => bytes.fill(7),
        },
      }),
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        now: 1_000,
        date: "1970-01-01T00:00:01.000Z",
        called: "1970-01-01T00:00:01.000Z",
        random: [0, 0.5],
        uuid: "00000000-0000-4000-8000-000000000000",
        bytes: [7, 7, 7, 7],
      },
    })
  })

  test("without the option, the host's sources are used as before", async () => {
    const before = Date.now()
    const result = await Effect.runPromise(CodeMode.execute({ code: NONDETERMINISTIC }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { now: number; random: Array<number>; uuid: string }
    expect(value.now).toBeGreaterThanOrEqual(before)
    expect(value.now).toBeLessThanOrEqual(Date.now())
    expect(value.random[0]).not.toBe(value.random[1])
    expect(value.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe("the virtual world", () => {
  test("a seed fixes the random stream", () => {
    const a = prng(42)
    const b = prng(42)
    const c = prng(43)
    const xs = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs)
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true)
  })

  test("the clock never goes backwards", () => {
    const world = new VirtualWorld(100, 1)
    expect(world.advance(200)).toBe(200)
    expect(world.advance(150)).toBe(200)
    expect(world.determinism.now()).toBe(200)
  })

  test("a durable run reads startedAt until the first result, then the time that result was delivered", async () => {
    const { tools } = timedTools({ a: 5 })
    const store = memoryStore()
    const code = `
      const t0 = Date.now()
      const r = Math.random()
      await tools.t({ id: "a" })
      return { t0, r, t1: Date.now(), again: Date.now() }
    `
    const result = await runToEnd({ runId: "c", code, tools, store, seed: 9, startedAt: 1_000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { t0: number; r: number; t1: number; again: number }
    expect(value.t0).toBe(1_000)
    expect(value.r).toBe(prng(9)())
    expect(value.t1).toBe(store.deliveries("c")[0]!.at)
    // Time stands still while the script processes a result.
    expect(value.again).toBe(value.t1)
  })
})
