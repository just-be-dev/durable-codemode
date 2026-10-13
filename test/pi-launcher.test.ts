/**
 * The opencode launcher against pi-codemode's VM contract, through pi's own host side (`CodemodeSandboxBase`).
 * `bun run test:pi` runs pi's suites against it as well; these are the contract's main points, kept here.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { CodemodeHostCall, CodemodeOutcome, CodemodeRunOptions } from "@earendil-works/pi-codemode/portable"
import { FINGERPRINT, OpencodeCodemodeSandbox } from "../src/pi/index.js"

const STARTED_AT = Date.UTC(2026, 0, 15, 10, 0, 0)
const savedTimezone = process.env.TZ
afterEach(() => {
  if (savedTimezone === undefined) delete process.env.TZ
  else process.env.TZ = savedTimezone
})

/** Start `code` with tools `echo` (answered at once with its argument, as result 1, 2, ...) and `wait` (left open). */
const start = (
  code: string,
  options: Partial<CodemodeRunOptions> & { answer?: (call: CodemodeHostCall) => CodemodeOutcome } = {},
) => {
  const sandbox = new OpencodeCodemodeSandbox()
  const calls: Array<CodemodeHostCall> = []
  const idles: Array<[number, number]> = []
  const events: Array<string> = []
  let seq = 0
  const answer = options.answer ?? ((call: CodemodeHostCall) => ({ ok: true, value: call.args }))
  const run = sandbox.start(code, {
    startedAt: STARTED_AT,
    seed: 1,
    tools: [{ name: "echo" }, { name: "wait" }],
    timeoutMs: 10_000,
    ...options,
    onStarted: (fingerprint) => events.push(`started ${fingerprint}`),
    onCall: (call) => {
      calls.push(call)
      events.push(`call ${call.id}`)
      if (call.name === "wait") return
      queueMicrotask(() => {
        seq++
        run.deliver(seq, STARTED_AT + 1000 * seq, call.id, answer(call))
      })
    },
    onIdle: (s, issued) => {
      idles.push([s, issued])
      events.push(`idle ${s}`)
    },
  })
  return { run, calls, idles, events }
}

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition was not reached")
    await Bun.sleep(2)
  }
}

describe("deterministic runs", () => {
  test("clock, randomness, and UTC as pi's QuickJS VM has them", async () => {
    process.env.TZ = "Asia/Kolkata"
    const one = start(`
      const values = [Date.now(), performance.now(), Math.random(), new Date().toISOString(), new Date(0).getHours()]
      const first = await tools.echo(values)
      return [first, Date.now(), performance.now()]
    `)
    const result = await one.run.result
    // Seed 1's first Math.random() is QuickJS's: 0.34227450605335275 (pinned in pi's own tests).
    expect(result).toMatchObject({
      ok: true,
      value: [[STARTED_AT, 0, 0.34227450605335275, "2026-01-15T10:00:00.000Z", 0], STARTED_AT + 1000, 1000],
    })
    expect(one.events[0]).toBe(`started ${FINGERPRINT}`)
    // execute() is not deterministic: the host's time zone.
    expect(await new OpencodeCodemodeSandbox().execute("return new Date(0).getHours()")).toMatchObject({ value: 5 })
  })

  test("reports idle with the calls issued after each result, and `during` when the script ends", async () => {
    const { run, idles, calls } = start("await tools.echo(1); await Promise.all([tools.echo(2), tools.echo(3)]); return 4")
    expect(await run.result).toMatchObject({ ok: true, value: 4, during: { seq: 3, issued: 3 } })
    expect(idles).toEqual([
      [0, 1],
      [1, 3],
      [2, 3],
    ])
    expect(calls.map((call) => [call.id, call.name, call.args])).toEqual([
      [1, "echo", 1],
      [2, "echo", 2],
      [3, "echo", 3],
    ])
  })

  test("applies results in seq order, waiting through gaps", async () => {
    const recorded = start(`const order = [];
      await Promise.all([tools.wait("a").then(() => order.push("a")), tools.wait("b").then(() => order.push("b"))]);
      return order;`)
    await waitFor(() => recorded.calls.length === 2 && recorded.idles.length === 1)
    const [a, b] = recorded.calls
    recorded.run.deliver(2, STARTED_AT + 2000, a!.id, { ok: true, value: null })
    await Bun.sleep(20)
    recorded.run.deliver(1, STARTED_AT + 1000, b!.id, { ok: true, value: null })
    expect(await recorded.run.result).toMatchObject({ ok: true, value: ["b", "a"] })
  })

  test("applies one result at a time: a continuation runs to the end before the next result", async () => {
    // Both results are delivered before the interpreter processes either; QuickJS drains its job queue after each.
    const recorded = start(`const log = [];
      const a = (async () => { await tools.wait("a"); log.push("a1"); await null; log.push("a2"); await null; log.push("a3") })();
      const b = (async () => { await tools.wait("b"); log.push("b") })();
      await Promise.all([a, b]);
      return log.join(",");`)
    await waitFor(() => recorded.calls.length === 2)
    recorded.run.deliver(1, STARTED_AT, 1, { ok: true, value: null })
    recorded.run.deliver(2, STARTED_AT, 2, { ok: true, value: null })
    expect(await recorded.run.result).toMatchObject({ ok: true, value: "a1,a2,a3,b" })
  })

  test("globals are numbered with tools; rejections carry the answer's properties", async () => {
    const recorded = start(
      `const found = await search("x", 2);
      try { await tools.echo("fail") } catch (e) { return [found, e instanceof Error, e.message, e.name, e.structuredOutput] }`,
      {
        globals: [{ name: "search", spread: true }],
        answer: (call) =>
          call.args === "fail"
            ? { ok: false, message: "denied", properties: { structuredOutput: { code: 7 }, name: "Ignored" } }
            : { ok: true, value: ["found"] },
      },
    )
    expect(await recorded.run.result).toMatchObject({
      ok: true,
      value: [["found"], true, "denied", "Error", { code: 7 }],
    })
    expect(recorded.calls[0]).toEqual({ id: 1, target: "global", name: "search", args: ["x", 2] })
  })
})

describe("the script surface", () => {
  const sandbox = () =>
    new OpencodeCodemodeSandbox({
      tools: [{ name: "my-tool", execute: (args) => args }],
      globals: [{ name: "models.first", execute: (args) => args }],
    })

  test("tools, ALL_TOOLS, namespaced globals, output, and the store", async () => {
    const result = await sandbox().execute(
      `console.log("log", { a: 1 }); text({ b: 2 }); image("data:image/png;base64,iVBORw0KGgo=")
      store("k", [1]); store("gone", undefined)
      return [Object.keys(tools), ALL_TOOLS, await tools.my_tool(1), await models.first(2), load("k"), load("kept")]`,
      { store: { kept: "yes", gone: 1 } },
    )
    expect(result).toMatchObject({
      ok: true,
      value: [["my_tool", "my-tool"], [{ name: "my_tool", description: "" }], 1, 2, [1], "yes"],
      output: [
        { type: "text", text: 'log {"a":1}', console: true },
        { type: "text", text: '{"b":2}' },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      storeWrites: { set: { k: [1] }, delete: ["gone"] },
    })
  })

  test("exit(), thrown errors, syntax errors, and a script that can never resume", async () => {
    const box = sandbox()
    expect(await box.execute("exit(); text('never')")).toMatchObject({ ok: true, output: [] })
    expect(await box.execute("throw new TypeError('boom')")).toMatchObject({
      ok: false,
      error: { kind: "script", name: "TypeError", message: "boom" },
    })
    const syntax = await box.execute("const a = 1;\nconst b = ;")
    expect(syntax).toMatchObject({ ok: false, error: { kind: "script", name: "SyntaxError" } })
    expect(syntax.ok ? "" : syntax.error.stack).toContain("codemode.js:2")
    expect(await box.execute("await new Promise(() => {})")).toMatchObject({
      ok: false,
      error: { kind: "script", message: expect.stringContaining("can never settle") },
    })
  })

  test("a busy loop is stopped by the deadline", async () => {
    expect(await sandbox().execute("while (true) {}", { timeoutMs: 200 })).toMatchObject({
      ok: false,
      error: { kind: "timeout" },
    })
  })
})
