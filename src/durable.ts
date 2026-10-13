/**
 * Durable code mode over opencode's CodeMode interpreter: a script that survives a process crash and resumes without
 * running its finished tool calls again. Modelled on pi-durable's code mode (`pi/packages/durable/src/codemode`).
 *
 * The interpreter runs deterministically: time and randomness come from a virtual clock and a seeded PRNG (the
 * `determinism` option added to the vendored interpreter), and tool results reach the script only through a gate that
 * releases one result at a time, at points where the interpreter is idle (`IdleScheduler`). Given the same start data
 * and the same results in the same order, the script makes the same calls with the same arguments.
 *
 * Journal (see `store.ts`), written before anything it describes can be observed:
 * - the run's start data (code, seed, startedAt, fingerprint), once, and its final result, once;
 * - each call, by call index, before the tool runs; its outcome, before it can be delivered;
 * - each delivery (which call's result was handed over, and the clock value), before the hand-off;
 * - after each delivery, how many calls the script had made once idle again (an "ack").
 *
 * An attempt on a run with a journal replays it: it starts the script from the stored start data, answers each call the
 * journal has with its stored outcome, releases those outcomes in journal order, and checks along the way that the
 * script makes the same calls (name and canonical JSON args, by index) and the same number of calls between results.
 * Any mismatch is a divergence: the run ends with a stored `ReplayDivergence` result and no new calls are made. Calls
 * the journal does not have an outcome for are held until the replay is through, then run live: calls that were in
 * flight at the crash run again (or fail, per their replay policy), new calls run for the first time.
 */
import { Cause, Deferred, Effect, Exit, Formatter, Scheduler } from "effect"
import { CodeMode, type Tool } from "../vendor/codemode/index.js"
import { isNamespace } from "../vendor/codemode/namespace.js"
import { isTool } from "../vendor/codemode/tool.js"
import type { Tools } from "../vendor/codemode/tools.js"
import { VirtualWorld } from "./determinism.js"
import { IdleScheduler } from "./scheduler.js"
import type { CallRecord, DeliveryRecord, JournalStore, Outcome } from "./store.js"
import { EFFECT_VERSION, MODULE_VERSION, UPSTREAM_COMMIT } from "./version.js"

/** What happens to a call that was in flight when the run crashed: run it again, or fail it for the script. */
export type ReplayPolicy = "rerun" | "fail"

/**
 * `serialized` (default): results are released one at a time at idle points, live and on replay.
 * `none`: no gate; results reach the interpreter whenever they complete (live) or at once (replay). Only for showing
 * why the gate is needed.
 */
export type GateMode = "serialized" | "none"

export type RunOptions<R> = {
  readonly runId: string
  /** Required to start a run; a later attempt defaults to the stored code. */
  readonly code?: string
  readonly tools: Tools<R>
  readonly store: JournalStore
  /** Fixed for the run when it starts; defaults to random / now. */
  readonly seed?: number
  readonly startedAt?: number
  readonly limits?: CodeMode.ExecutionLimits
  /** Per tool path (`"agents.run"`), for calls in flight at a crash. Default `rerun`. */
  readonly replay?: Readonly<Record<string, ReplayPolicy>>
  readonly gate?: GateMode
}

export type DurableFailure = {
  readonly ok: false
  readonly error: { readonly kind: "ReplayDivergence" | "FingerprintMismatch"; readonly message: string }
  readonly toolCalls: ReadonlyArray<{ readonly name: string }>
}

export type DurableResult = CodeMode.Result | DurableFailure

/** Identifies the code that turns a journal into what a script sees. A run only replays under the same one. */
export const fingerprint = (toolPaths: ReadonlyArray<string>): string => {
  const tools = new Bun.CryptoHasher("sha256").update([...toolPaths].sort().join("\n")).digest("hex").slice(0, 12)
  return `codemode@${UPSTREAM_COMMIT.slice(0, 12)}+durable@${MODULE_VERSION}+effect@${EFFECT_VERSION}+tools@${tools}`
}

/** JSON with sorted keys, so arguments compare by value. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  ) ?? "null"

/** Map every tool in a CodeMode tool tree, by canonical dotted path. */
export const mapTools = <R>(
  tools: Tools<R>,
  f: (path: string, tool: Tool.Tool<R>) => Tool.Tool<R>,
  prefix: ReadonlyArray<string> = [],
): Tools<R> =>
  Object.fromEntries(
    Object.entries(tools).map(([key, value]) => {
      const path = [...prefix, ...key.split(".")]
      if (isTool<R>(value)) return [key, f(path.join("."), value)]
      if (isNamespace<R>(value)) return [key, { ...value, tools: mapTools(value.tools, f, path) }]
      return [key, mapTools(value, f, path)]
    }),
  )

const toolPaths = <R>(tools: Tools<R>): Array<string> => {
  const paths: Array<string> = []
  mapTools(tools, (path, tool) => {
    paths.push(path)
    return tool
  })
  return paths
}

/** How the interpreter would describe a tool failure; stored so live and replayed failures read the same. */
const failureMessage = (cause: Cause.Cause<unknown>): string =>
  Cause.prettyErrors(cause)
    .map((error) => (error.cause ? Formatter.format(error) : error.message || error.name))
    .join("\n")

const toOutcome = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isFailure(exit)) return { ok: false, message: failureMessage(exit.cause) }
  if (exit.value === undefined) return { ok: true }
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(exit.value)) }
  } catch (error) {
    return { ok: false, message: `Tool output is not JSON: ${String(error)}` }
  }
}

/** What the script gets; live and replayed outcomes take the same path. */
const fromOutcome = (outcome: Outcome): Effect.Effect<unknown, Error> =>
  outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(new Error(outcome.message))

type Issued = {
  outcome?: Outcome
  readonly release: Deferred.Deferred<Outcome>
}

/** One attempt at a run: a first run, or a rerun after a crash that replays the journal and continues. */
class Attempt<R> {
  readonly scheduler = new IdleScheduler(() => this.idle())
  /** Completed when the attempt decides an outcome other than the script's own (a divergence). */
  readonly decided = Deferred.makeUnsafe<DurableFailure>()
  readonly world: VirtualWorld
  private readonly calls: ReadonlyArray<CallRecord>
  private readonly deliveries: ReadonlyArray<DeliveryRecord>
  private readonly acks: ReadonlyMap<number, number>
  private readonly deliveredBefore: ReadonlySet<number>
  /** Opens when replay is through; live calls wait for it. */
  private readonly live = Deferred.makeUnsafe<void>()
  private readonly host = new Scheduler.MixedScheduler()
  private replaying: boolean
  private nextCall = 0
  /** Results handed to the script in this attempt, replayed and live; the next delivery is `delivered + 1`. */
  private delivered = 0
  private ackedThrough = -1
  private readonly issued = new Map<number, Issued>()
  /** Outcomes waiting for live delivery, in the order they became available. */
  private readonly ready: Array<number> = []
  private stopped = false

  constructor(
    private readonly runId: string,
    private readonly store: JournalStore,
    private readonly options: RunOptions<R>,
    startedAt: number,
    seed: number,
  ) {
    this.world = new VirtualWorld(startedAt, seed)
    this.calls = store.calls(runId)
    this.deliveries = store.deliveries(runId)
    this.acks = store.acks(runId)
    this.deliveredBefore = new Set(this.deliveries.map((delivery) => delivery.idx))
    this.replaying = this.mode === "serialized" && (this.calls.length > 0 || this.acks.size > 0)
    if (!this.replaying) Deferred.doneUnsafe(this.live, Exit.void)
  }

  get mode(): GateMode {
    return this.options.gate ?? "serialized"
  }

  wrap(tools: Tools<R>): Tools<R> {
    return mapTools(tools, (name, tool) => ({ ...tool, execute: (input) => this.call(name, tool, input) }))
  }

  /** The script called `tools.<name>(input)`: answer from the journal, or run it live; then wait for release. */
  private call(name: string, tool: Tool.Tool<R>, input: unknown): Effect.Effect<unknown, unknown, R> {
    return Effect.suspend(() => {
      if (this.stopped) return Effect.never
      const idx = this.nextCall++
      const args = canonicalJson(input)
      const recorded = this.calls[idx]
      if (recorded !== undefined && (recorded.name !== name || recorded.args !== args)) {
        this.diverge(`call #${idx} is tools.${name}(${args}), but was tools.${recorded.name}(${recorded.args})`)
        return Effect.never
      }
      if (recorded === undefined) this.store.recordCall(this.runId, idx, name, args)
      const issued: Issued = { release: Deferred.makeUnsafe() }
      this.issued.set(idx, issued)

      const obtain: Effect.Effect<Outcome, never, R> =
        recorded?.outcome !== undefined
          ? Effect.succeed(recorded.outcome)
          : recorded !== undefined && this.options.replay?.[name] === "fail"
            ? Effect.sync(() => {
                const outcome: Outcome = {
                  ok: false,
                  message: `tools.${name} was in flight when the run was interrupted; its replay policy is "fail".`,
                }
                this.store.recordOutcome(this.runId, idx, outcome)
                return outcome
              })
            : Effect.andThen(Deferred.await(this.live), this.execute(idx, tool, input))

      if (this.mode === "none") return Effect.flatMap(obtain, fromOutcome)
      return Effect.flatMap(obtain, (outcome) => {
        issued.outcome = outcome
        // Journaled deliveries are released in journal order by `idle`; anything else waits its turn live.
        if (!this.deliveredBefore.has(idx)) this.ready.push(idx)
        this.scheduler.kick()
        return Effect.flatMap(Deferred.await(issued.release), fromOutcome)
      })
    })
  }

  /** Run a tool for real, on the host's scheduler, and journal its outcome. Interruption is not an outcome. */
  private execute(idx: number, tool: Tool.Tool<R>, input: unknown): Effect.Effect<Outcome, never, R> {
    return Effect.suspend(() => tool.execute(input)).pipe(
      Effect.provideService(Scheduler.Scheduler, this.host),
      Effect.exit,
      Effect.flatMap((exit): Effect.Effect<Outcome> => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.interrupt
        const outcome = toOutcome(exit)
        this.store.recordOutcome(this.runId, idx, outcome)
        return Effect.succeed(outcome)
      }),
    )
  }

  /** The interpreter is idle: check the replay, then release at most one result. Returns whether it released one. */
  private idle(): boolean {
    if (this.stopped) return false
    if (this.ackedThrough < this.delivered) {
      this.ackedThrough = this.delivered
      const recorded = this.acks.get(this.delivered)
      if (recorded === undefined) this.store.recordAck(this.runId, this.delivered, this.nextCall)
      else if (recorded !== this.nextCall) {
        this.diverge(
          `once idle after result ${this.delivered} it had made ${this.nextCall} calls, where it had made ${recorded}`,
        )
        return false
      }
    }
    if (this.replaying) {
      const next = this.deliveries[this.delivered]
      if (next !== undefined) {
        const issued = this.issued.get(next.idx)
        if (issued?.outcome === undefined) {
          const call = this.calls[next.idx]!
          this.diverge(`it is waiting without making call #${next.idx} (tools.${call.name}(${call.args})), as it had`)
          return false
        }
        this.delivered++
        this.world.advance(next.at)
        Deferred.doneUnsafe(issued.release, Exit.succeed(issued.outcome))
        return true
      }
      if (this.nextCall < this.calls.length) {
        this.diverge(`it made ${this.nextCall} calls and waits, where it had made ${this.calls.length}`)
        return false
      }
      // Replay is through: every call an earlier attempt made has been made again, with the same arguments.
      this.replaying = false
      Deferred.doneUnsafe(this.live, Exit.void)
    }
    const idx = this.ready.shift()
    if (idx === undefined) return false
    const issued = this.issued.get(idx)!
    this.delivered++
    const at = this.world.advance(Date.now())
    this.store.recordDelivery(this.runId, { seq: this.delivered, idx, at })
    Deferred.doneUnsafe(issued.release, Exit.succeed(issued.outcome!))
    return true
  }

  /** The script ended: in a replay, ending before the journal does is a divergence. */
  ended(): DurableFailure | undefined {
    this.stop()
    if (!this.replaying) return undefined
    if (this.delivered < this.deliveries.length || this.nextCall < this.calls.length) {
      return this.failure(
        `it ended after result ${this.delivered} having made ${this.nextCall} calls, where it went on before (${this.deliveries.length} results, ${this.calls.length} calls)`,
      )
    }
    return undefined
  }

  private failure(message: string): DurableFailure {
    return {
      ok: false,
      error: { kind: "ReplayDivergence", message: `The script took a different path when resumed: ${message}.` },
      toolCalls: [],
    }
  }

  /** Release nothing more and journal nothing more: the attempt is over (decided, ended, or interrupted). */
  stop(): void {
    this.stopped = true
    this.scheduler.stop()
  }

  private diverge(message: string): void {
    if (this.stopped) return
    this.stop()
    Deferred.doneUnsafe(this.decided, Exit.succeed(this.failure(message)))
  }
}

/**
 * Run `code` durably under `runId`: start it, resume it from its journal, or return its stored result.
 * A completed run (including one that ended with a divergence) returns its stored result and runs nothing.
 */
export const run = <R>(options: RunOptions<R>): Effect.Effect<DurableResult, never, R> =>
  Effect.suspend(() => {
    const { runId, store } = options
    const print = fingerprint(toolPaths(options.tools))
    let record = store.getRun(runId)
    if (record?.result !== undefined) return Effect.succeed(JSON.parse(record.result) as DurableResult)
    if (record === undefined) {
      if (options.code === undefined) return Effect.die(new Error(`Run ${runId} does not exist and no code was given`))
      record = {
        runId,
        code: options.code,
        seed: options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!,
        startedAt: options.startedAt ?? Date.now(),
        fingerprint: print,
      }
      store.createRun(record)
    }
    const decide = (result: DurableResult) => {
      store.finishRun(runId, JSON.stringify(result))
      return result
    }
    if (record.fingerprint !== print) {
      return Effect.succeed(
        decide({
          ok: false,
          error: {
            kind: "FingerprintMismatch",
            message: `The script cannot resume: it started under ${record.fingerprint}, this is ${print}.`,
          },
          toolCalls: [],
        }),
      )
    }

    const attempt = new Attempt(runId, store, options, record.startedAt, record.seed)
    const runtime = CodeMode.make({
      tools: attempt.wrap(options.tools) as Tools<never>,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      determinism: attempt.world.determinism,
    })
    const execute = runtime.execute(options.code ?? record.code) as Effect.Effect<CodeMode.Result, never, R>
    const program =
      attempt.mode === "serialized"
        ? // Start on the attempt's scheduler, so the first idle check comes after the script's first run.
          Effect.andThen(Effect.yieldNow, execute).pipe(Effect.provideService(Scheduler.Scheduler, attempt.scheduler))
        : execute
    return Effect.raceFirst(
      Effect.map(program, (result): DurableResult => attempt.ended() ?? result),
      Deferred.await(attempt.decided),
    ).pipe(
      Effect.map(decide),
      // Interrupted (the host is shutting down): decide nothing, so a later attempt replays.
      Effect.ensuring(Effect.sync(() => attempt.stop())),
    )
  })

export * as DurableCodeMode from "./durable.js"
