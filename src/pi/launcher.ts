/**
 * A pi-codemode `VmLauncher` that runs scripts in opencode's interpreter instead of QuickJS.
 *
 * pi-codemode's `CodemodeSandboxBase(options, launch)` owns everything on the host side (tool table, call records,
 * output, deadline, abort) and talks to its VM only through the messages in its `protocol.ts`. This module is the VM
 * side of that protocol, for the vendored opencode interpreter:
 *
 * - VM -> host: `started { fingerprint }` (deterministic runs), `call { id, target, name, args }`, `output { item }`,
 *   `idle { seq, issued }` (deterministic runs), `done { ok, value | error, writes, during? }`, `crash { message }`.
 * - Host -> VM: `result { id, ok, payload, seq?, now?, properties? }`.
 *
 * Deterministic runs (`data.deterministic`, from `CodemodeSandboxBase.start()`, which pi-durable's code mode uses) hold
 * to pi's contract: the clock reads `startedAt`, then the `now` of the result being processed, never going backwards;
 * `Math.random()` is QuickJS's stream for the seed; local time is UTC; results are applied strictly in `seq` order,
 * waiting through gaps; after the first run and after each result, once the interpreter is idle, `idle` reports the
 * calls issued so far. "Idle" comes from `IdleScheduler`, as in the standalone durable layer: a result is only applied
 * when every interpreter fiber is waiting, so the script's whole reaction to result N runs before result N+1.
 *
 * Messages to the host are delivered in a microtask, never from inside an interpreter fiber, so host code (tool calls,
 * `finish()`, `stop()`) does not re-enter the interpreter, as with pi's inline launcher.
 */
import type {
  CodemodeError,
  HostToWorkerMessage,
  VmStartData,
  WorkerToHostMessage,
} from "@earendil-works/pi-codemode/portable"
import { Deferred, Effect, Exit, Fiber, Scheduler } from "effect"
import { CodeMode, Extension, Tool } from "../../vendor/codemode/index.js"
import { IdleScheduler } from "../scheduler.js"
import { EFFECT_VERSION, UPSTREAM_COMMIT } from "../version.js"
import { BUILTIN_PARAMS, fnv1a, PRELUDE_SOURCE, programSource } from "./prelude.js"
import { quickjsRandom, randomBytes } from "./random.js"

/** Bumped whenever this module or the prelude changes what a deterministic script observes. */
export const LAUNCHER_VERSION = 1

/** pi-codemode's launcher types (not exported by its package), matched structurally. */
export interface VmEvents {
  message(message: unknown): void
  failure(error: CodemodeError): void
}
export interface VmChannel {
  post(message: HostToWorkerMessage): void
  stop(): Promise<void>
}
export type VmLauncher = (data: VmStartData, events: VmEvents) => VmChannel | Promise<VmChannel>

export const FINGERPRINT = `opencode-codemode ${UPSTREAM_COMMIT.slice(0, 12)}, effect ${EFFECT_VERSION}, launcher ${LAUNCHER_VERSION}, prelude ${fnv1a(PRELUDE_SOURCE)}`

const STALLED =
  "The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here."

type Answer = { ok: boolean; payload?: string; properties?: string }

const isParams = (name: string, params: ReadonlyArray<string>) => params.includes(name)

/** One script in one interpreter. */
class OpencodeVm {
  private readonly scheduler = new IdleScheduler(() => this.idle())
  private readonly deterministic: { startedAt: number; seed: number } | undefined
  private readonly pending = new Map<number, Deferred.Deferred<Answer>>()
  /** Deterministic: results by `seq`, applied from `nextSeq` on. Otherwise: results in arrival order. */
  private readonly early = new Map<number, HostToWorkerMessage>()
  private readonly arrived: Array<HostToWorkerMessage> = []
  private nextSeq = 1
  /** The result being processed, 0 during the first run. */
  private current = 0
  private issued = 0
  private nextId = 1
  /** Deterministic: the `idle` for `current` is still to be reported. */
  private idleDue = true
  private clock: number
  private readonly origin = performance.now()
  /** `done` or `crash` was posted; nothing more is. */
  private finished = false
  private stopped = false
  private fiber: Fiber.Fiber<CodeMode.Result> | undefined
  /** Characters before the script on line 1 of the program. */
  private prefix = 0

  constructor(
    private readonly data: VmStartData,
    private readonly events: VmEvents,
  ) {
    this.deterministic = data.deterministic
    this.clock = data.deterministic?.startedAt ?? 0
  }

  start(): void {
    const { data } = this
    const globalNames = [...new Set(data.globals.map((global) => global.name.split(".")[0]!))]
    // A global may take a built-in parameter's place (pi only reserves some of them).
    const params = [...BUILTIN_PARAMS.filter((name) => !isParams(name, globalNames)), ...globalNames]
    const init = JSON.stringify({ tools: data.tools, globals: data.globals, store: data.store, params })

    const call = Tool.make({
      description: "pi-codemode bridge",
      input: {},
      output: {},
      execute: (input) => this.call(parseRequest(input)),
    })
    const host = Extension.make({
      name: "pi-codemode",
      globals: {
        __codemode_host_init: () => init,
        __codemode_host_output: (kind: string, a: string, b?: string) => this.output(kind, a, b),
        __codemode_host_done: (ok: boolean, payload?: string, writes?: string) => this.done(ok, payload, writes),
        __codemode_host_perf: () =>
          this.deterministic ? this.clock - this.deterministic.startedAt : performance.now() - this.origin,
      },
    })
    const seed = this.deterministic?.seed
    const runtime = CodeMode.make({
      tools: { __codemode_call: call },
      extensions: [host],
      ...(seed === undefined
        ? {}
        : {
            determinism: {
              now: () => this.clock,
              random: quickjsRandom(seed),
              getRandomValues: randomBytes(seed),
              randomUUID: uuid(randomBytes(seed ^ 0x5bd1e995)),
              utc: true,
            },
          }),
    })
    if (this.deterministic) this.post({ type: "started", fingerprint: FINGERPRINT })
    this.prefix = programSource("", params).indexOf("{") + 1
    const program = Effect.andThen(Effect.yieldNow, runtime.execute(programSource(data.code, params))).pipe(
      Effect.provideService(Scheduler.Scheduler, this.scheduler),
    )
    this.fiber = Effect.runFork(program)
    this.fiber.addObserver((exit) => this.ended(exit))
  }

  /** A `result` from the host: applied at the next idle point, in `seq` order when deterministic. */
  deliver(message: HostToWorkerMessage): void {
    if (this.stopped || this.finished) return
    if (!this.deterministic) {
      this.arrived.push(message)
      this.scheduler.kick()
      return
    }
    const { seq } = message
    if (seq === undefined || !Number.isInteger(seq) || seq < this.nextSeq || this.early.has(seq)) {
      this.crash(`Result ${message.id} has sequence number ${seq}, expected ${this.nextSeq} or later, once`)
      return
    }
    this.early.set(seq, message)
    this.scheduler.kick()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.scheduler.stop()
    if (this.fiber !== undefined) await Effect.runPromise(Fiber.interrupt(this.fiber))
  }

  /** `tools.__codemode_call(...)`: number the call, report it, and wait for its result to be applied. */
  private call(input: { target?: string; name: string; args?: string }): Effect.Effect<Answer> {
    return Effect.suspend(() => {
      if (this.stopped || this.finished) return Effect.never
      const id = this.nextId++
      this.issued++
      const answer = Deferred.makeUnsafe<Answer>()
      this.pending.set(id, answer)
      this.post({
        type: "call",
        id,
        target: input.target === "global" ? "global" : "tool",
        name: input.name,
        args: typeof input.args === "string" ? input.args : undefined,
      })
      return Deferred.await(answer)
    })
  }

  /** Every interpreter fiber waits: report, then apply at most one result. Returns whether it applied one. */
  private idle(): boolean {
    if (this.stopped || this.finished) return false
    if (this.deterministic && this.idleDue) {
      this.idleDue = false
      this.post({ type: "idle", seq: this.current, issued: this.issued })
    }
    let next: HostToWorkerMessage | undefined
    if (this.deterministic) {
      next = this.early.get(this.nextSeq)
      if (next !== undefined) {
        this.early.delete(this.nextSeq)
        // Never backwards: a resumed host's clock may be behind the one that started the run.
        if (next.now !== undefined && Number.isFinite(next.now)) this.clock = Math.max(this.clock, next.now)
        this.current = this.nextSeq++
        this.idleDue = true
      }
    } else {
      next = this.arrived.shift()
    }
    if (next !== undefined) {
      const answer = this.pending.get(next.id)
      this.pending.delete(next.id)
      if (answer !== undefined) {
        Deferred.doneUnsafe(
          answer,
          Exit.succeed({
            ok: next.ok,
            ...(next.payload === undefined ? {} : { payload: next.payload }),
            ...(next.properties === undefined ? {} : { properties: next.properties }),
          }),
        )
      }
      return true
    }
    // With no timers or I/O in the interpreter, a script waiting while no call is pending never resumes.
    if (this.pending.size === 0 && this.early.size === 0) {
      this.done(false, JSON.stringify({ name: "Error", message: STALLED }))
    }
    return false
  }

  private output(kind: string, a: string, b?: string): void {
    if (this.finished) return
    this.post({
      type: "output",
      item:
        kind === "image"
          ? { type: "image", data: a, mimeType: b ?? "" }
          : kind === "console"
            ? { type: "text", text: a, console: true }
            : { type: "text", text: a },
    })
  }

  private done(ok: boolean, payload?: string, writes?: string): void {
    if (this.finished) return
    const during = this.deterministic ? { during: { seq: this.current, issued: this.issued } } : {}
    this.post(
      ok
        ? { type: "done", ok: true, value: payload, writes: writes ?? "[]", ...during }
        : { type: "done", ok: false, error: payload ?? JSON.stringify({ message: "Script failed" }), ...during },
    )
    this.finished = true
  }

  private crash(message: string): void {
    if (this.finished) return
    this.post({ type: "crash", message })
    this.finished = true
  }

  /** The interpreter's program ended. Normally the prelude reported `done` first; otherwise this reports it. */
  private ended(exit: Exit.Exit<CodeMode.Result>): void {
    if (this.stopped || this.finished) return
    if (Exit.isFailure(exit)) {
      this.crash("The interpreter stopped unexpectedly")
      return
    }
    const result = exit.value
    if (result.ok) {
      this.crash("The script ended without reporting a result")
      return
    }
    const { kind, message } = result.error
    const name = kind === "ParseError" || kind === "UnsupportedSyntax" ? "SyntaxError" : "Error"
    const error = JSON.stringify({ name, message, stack: `${name}: ${message}` })
    // A script that does not parse never ran: pi's VM reports no `during` for it either. Its stack names the script's
    // line, as QuickJS's does (the script starts on line 1, after the wrapper's prefix).
    if (kind === "ParseError") {
      // Acorn puts the position at the end of the message: "Unexpected token (2:10)".
      const position = / \((\d+):(\d+)\)$/.exec(message)
      const location =
        result.error.location ?? (position ? { line: Number(position[1]), column: Number(position[2]) } : undefined)
      const text = message.replace(/ \(\d+:\d+\)$/, "")
      const column = location === undefined ? 0 : location.line === 1 ? location.column - this.prefix : location.column
      const at = location === undefined ? "" : `\n    at codemode.js:${location.line}:${column + 1}`
      this.post({
        type: "done",
        ok: false,
        error: JSON.stringify({ name, message: text, stack: `${name}: ${text}${at}` }),
      })
      this.finished = true
      return
    }
    this.done(false, error)
  }

  private post(message: WorkerToHostMessage): void {
    if (this.finished) return
    queueMicrotask(() => {
      if (!this.stopped) this.events.message(message)
    })
  }
}

/** The prelude's call request: `t`/`g`, the name's length, `:`, the name, then `=` and the arguments' JSON if any. */
const parseRequest = (input: unknown): { target: string; name: string; args?: string } => {
  const text = typeof input === "string" ? input : ""
  const colon = text.indexOf(":")
  const length = Number(text.slice(1, colon))
  const name = text.slice(colon + 1, colon + 1 + length)
  const rest = text.slice(colon + 1 + length)
  return {
    target: text[0] === "g" ? "global" : "tool",
    name,
    ...(rest.startsWith("=") ? { args: rest.slice(1) } : {}),
  }
}

const uuid = (fill: (bytes: Uint8Array) => void) => (): string => {
  const b = new Uint8Array(16)
  fill(b)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A launcher for `new CodemodeSandboxBase(options, opencodeLauncher())`. */
export const opencodeLauncher =
  (): VmLauncher =>
  (data, events): VmChannel => {
    const vm = new OpencodeVm(data, events)
    vm.start()
    return { post: (message) => vm.deliver(message), stop: () => vm.stop() }
  }
