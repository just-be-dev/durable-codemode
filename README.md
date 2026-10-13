# durable-codemode

A proof of concept: **opencode's code mode interpreter, made durable**. A script that fans out tool calls survives a
process crash (a real `SIGKILL`) and resumes without re-running the tool calls that had finished. The design follows
pi-durable's code mode (`pi/packages/durable/src/codemode/codemode.ts` and pi-codemode's deterministic VM).

```sh
bun install
bun test           # 23 tests: crash/resume, divergence, completed runs, delivery order, determinism
bun run demo       # spawn a worker, SIGKILL it after 3 finished calls, restart it, show what ran how often
bunx tsc --noEmit  # typecheck
bun run test:upstream  # upstream's own codemode test suite against the patched vendor copy (needs ../opencode)
```

## Layout

| Path                       | What                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `vendor/codemode/`         | `@opencode/codemode` `src/`, vendored from opencode `69a71426ce74`, with 6 small patches   |
| `vendor/codemode.patch`    | The full diff against upstream                                                             |
| `src/durable.ts`           | `DurableCodeMode.run`: start, resume, or return the stored result; replay; divergence      |
| `src/scheduler.ts`         | `IdleScheduler`: an Effect `Scheduler` that knows when the interpreter is idle             |
| `src/store.ts`             | `JournalStore` interface and its bun:sqlite implementation                                 |
| `src/determinism.ts`       | Virtual clock and seeded PRNG (`Date.now`, `Math.random`, `crypto.*` for the script)       |
| `src/version.ts`           | Upstream commit, module version, Effect version: the replay fingerprint                    |
| `test/`                    | Tests; `test/fixtures/worker.ts` is the process that gets killed                           |
| `demo/crash-demo.ts`       | The runnable demo                                                                          |

## API

```ts
import { DurableCodeMode, SqliteJournalStore } from "./src/index.js"

const result = await Effect.runPromise(
  DurableCodeMode.run({
    runId: "call-123",       // the identity of the run; a later call with the same id resumes or returns it
    code,                    // required to start; a later attempt defaults to the stored code
    tools,                   // ordinary CodeMode tools (Tool.make / Namespace.make / nested records)
    store: new SqliteJournalStore("journal.sqlite"),
    seed, startedAt,         // optional; fixed for the run when it starts
    replay: { "agents.run": "rerun" }, // per-tool policy for calls in flight at a crash: "rerun" (default) | "fail"
  }),
)
// result: CodeMode.Result, or { ok: false, error: { kind: "ReplayDivergence" | "FingerprintMismatch", message } }
```

## How it works

Same idea as pi: **the script runs deterministically, and every tool result is journaled before the script sees it.**
After a crash, run the script again from the stored start data, hand it the journaled results in journal order, check
that it makes the same calls, then continue live.

1. **Start data.** The first attempt stores `code`, `seed`, `startedAt`, and a fingerprint (upstream commit, module
   version, Effect version, tool paths). Every attempt starts the interpreter from exactly this.
2. **Determinism.** `Date.now()`, `new Date()`, `Date()`, `Math.random()`, `crypto.randomUUID()`, and
   `crypto.getRandomValues()` come from a `VirtualWorld`: the clock reads `startedAt` until the first result is
   delivered, then the time at which the result being processed was delivered (journaled with the delivery, never going
   backwards), as in pi-codemode's VM; randomness comes from sfc32 over the seed.
3. **Journal.** Each call is recorded by call index (name and canonical JSON args) before the tool runs; its outcome
   (value or failure message) when it finishes; each delivery (which call's outcome, at what clock value) before the
   script gets it; and after each delivery, how many calls the script had made once idle again (an "ack", pi's
   `issuedAfter`).
4. **The gate.** Tool results do not reach the interpreter when the tool finishes. They are released one at a time, and
   only when the interpreter is idle, by `IdleScheduler` (below). So the script's whole reaction to result N runs before
   result N+1 is released, live and on replay alike, and the journal of deliveries fully determines what the script did.
5. **Replay.** A later attempt wraps every tool's `execute`: call #i must match the journal's call #i (name and args) or
   the run diverges. A journaled outcome is used instead of running the tool. Journaled deliveries are released in
   journal order, each at an idle point, with the journaled clock value. At each idle point the call count must match
   the journaled ack. If the script is idle without having made the call whose result comes next, ends early, or made
   fewer calls than the journal has, it diverged.
6. **Back to live.** Calls without an outcome in the journal wait until the replay is through (every journaled delivery
   released, every check passed, every journaled call made again), so a diverging script never starts new side
   effects. Then calls that were in flight at the crash run again (or get a failure, under `replay: "fail"`), finished
   but undelivered outcomes are delivered without running anything, and new calls run for the first time.
7. **Outcome.** The script's result, or a divergence or fingerprint error, is stored once. Any later invocation returns
   it and executes nothing.

### Obstacle 2: delivery order (what I found in opencode's interpreter)

opencode's interpreter is not a single job queue. It emulates JS promise semantics with Effect fibers:

- Every promise and every async function call is its own fiber (`Pending.create` → `Effect.forkIn(..., { startImmediately: true })`).
  A tool call is a fiber that runs the tool's Effect.
- `await` waits on the fiber (`Fiber.await`), then continues through `Effect.yieldNow`
  (`interpreter.ts`, `Frame.await`; `promises.ts` does the same for reactions and combinators).
- In Effect 4, an async resume calls `fiber.evaluate` **synchronously** in whatever callback completed it (a timer,
  socket, promise), and `yieldNow` schedules the continuation on the fiber's own dispatcher; the default
  `MixedScheduler` gives **every fiber its own dispatcher with its own `setImmediate` batch**.

So where a tool result lands relative to the script's pending continuations depends on wall-clock timing. The tests show
it concretely (`test/delivery-order.test.ts`):

- Two results with the **same values and the same completion order** (a before b) produce different program behaviour
  depending on spacing: with b 50 ms later the log is `a1,a2,a3,b`; with b 1 ms later it is `a1,b,a2,a3`, because b
  arrived while a's three-turn continuation was between turns. **Journaling the completion order alone is therefore not
  enough** to replay either run.
- A naive replay that returns journaled results at once resolves every call synchronously during its fork, so the
  script sees results in call order rather than completion order, takes another path, and diverges. Over 25 random
  timings with many same-tick completions, 22 to 23 of 25 naive replays diverged (across several runs); with the gate,
  25 of 25 replays reproduced the live result exactly, executing nothing.

The fix needed no interpreter patch: Effect 4's `Scheduler` is a `Context.Reference`, so `DurableCodeMode.run` provides
an `IdleScheduler` to the interpreter's root fiber and every forked fiber inherits it. `IdleScheduler` puts all tasks of
the execution in one FIFO (by priority, like `MixedScheduler`), runs it in `setImmediate` batches, and when a batch leaves
the queue empty, every interpreter fiber is suspended on something outside the interpreter, i.e. on the gate. Only then
does it ask the gate for the next result. Releasing a result resumes fibers inline, which queue tasks, which run in the
next batch. Yielding stays operation-count based (`maxOpsBeforeYield`), which is deterministic. Real tools run on a
separate `MixedScheduler`, so their internal scheduling never touches the interpreter's queue.

Live delivery is serialized too, not just replay. That is the guarantee pi's VM gives (`deliver(seq, ...)` is applied
strictly in order, then the VM reports `idle`), and without it a live run could take a path that no replay can
reproduce.

Item 3 (pending calls are interrupted when the script ends) is kept as is: those calls stay "in flight" in the journal,
which is harmless because a finished run is never replayed.

## Patches against upstream

Vendored from `anomalyco/opencode` `packages/codemode/src` at `69a71426ce74bf8362fa6183937b008fa24a5dfe`
(`@opencode/codemode` 2.0.27). One feature, a `determinism` option, threaded through as an injection point; defaults keep
upstream behaviour. Every change is marked `// DURABLE PATCH:`; the full diff is `vendor/codemode.patch`
(6 files, +60/-9). Upstream's own test suite (1398 tests, test262 and WPT subsets included) passes against the patched
copy (`bun run test:upstream`).

| File                         | Change                                                                                     | Why                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `codemode.ts`                | New exported `Determinism` type (`now`, `random`, `randomUUID`, `getRandomValues`, all optional); `Options.determinism`; passed to `executeProgram` | The public injection point                                                 |
| `interpreter/execute.ts`     | `executeProgram(..., determinism?)` passes it to `new Interpreter(...)`                   | Threading                                                                  |
| `interpreter/interpreter.ts` | `Interpreter.determinism: Required<Determinism>`, defaults to `Date.now`, `Math.random`, `crypto` | One place the stdlib reads from                                             |
| `stdlib/date.ts`             | `new Date()`, `Date()`, `Date.now()` read `ctx.determinism.now()`                         | Time went straight to the host                                             |
| `stdlib/math.ts`             | `Math.random()` reads `ctx.determinism.random()`                                         | Randomness went straight to the host                                       |
| `stdlib/web.ts`              | `crypto.randomUUID()`, `crypto.getRandomValues()` read `ctx.determinism`                  | Randomness went straight to the host                                       |

Could this be done from outside, without patching? Not cleanly: extensions cannot shadow built-ins (`CodeMode.make`
throws), and replacing the host's `Date.now`/`Math.random` would also change Effect's clock and every other user in the
process. The scheduler, the tool wrapping, and the journal are all done from outside.

## Tests

`bun test` (23 tests, about 7 s):

- `test/crash.test.ts`: **real process kill.** Spawns `test/fixtures/worker.ts` (`Bun.spawn`), polls the journal, and
  `SIGKILL`s it after 3 finished calls (mid phase 1) and after 9 (mid phase 2). The restarted worker completes; the
  side-effect ledger (a separate SQLite file the fake tools write to) shows finished calls ran exactly once and in-flight
  calls ran twice; the value equals an uninterrupted run with the same seed; a third invocation returns the stored
  result and runs nothing. The phase-2 calls carry `Date.now()` and a `Math.random()` nonce in their arguments, so a
  replay with a different clock or random stream would have diverged.
- `test/durable.test.ts`: completed runs return the stored result with zero executions (also without code); a fully
  journaled run whose result was not stored re-executes nothing; **divergence**: a changed script (different call
  args), a tampered delivery order (leads to a different phase-2 call), an extra call where the earlier attempt was idle
  (caught by the ack check), a script that ends early, and a changed tool set (`FingerprintMismatch`), each a stored
  error with no new calls; replay policies `rerun` and `fail`; failed tool calls replay with the same message.
- `test/delivery-order.test.ts`: obstacle 2, as described above, gate vs no gate.
- `test/determinism.test.ts`: the patch (injected and default sources), the PRNG, the clock.

The in-process tests simulate a crash by interrupting the run's fiber after a journal condition holds; interruption
stops the attempt, so nothing is journaled afterwards, which matches a kill. Only `crash.test.ts` and the demo kill a
process.

## Limitations

- **Extensions are not journaled.** `Extension.make` globals call the host directly; a durable run should only use
  deterministic ones. pi journals its globals' outcomes; doing the same here means wrapping `extensions` like tools.
- **Local time zone.** Local-time `Date` getters (`getHours`, `getTimezoneOffset`, `toDateString`, ...) use the host's
  time zone. Resuming on a host in another zone could diverge. pi runs its VM in UTC; a `timeZone` field on
  `Determinism` would cover it.
- **`limits.timeoutMs` is per attempt and wall-clock.** pi stores a deadline and refuses to resume after it passed.
- **One attempt at a time.** There is no lease on a run; two processes resuming the same `runId` at once would both
  write the journal. pi's harness owns tasks.
- **Journal writes are per event and synchronous** (bun:sqlite, `synchronous=FULL`): one write per call, outcome,
  delivery, and ack. pi batches results and counts into one commit in flight at a time.
- **In-flight calls run again from scratch** (or fail). Nothing reattaches to work that might still be running
  elsewhere; with a real process kill it is gone anyway. Tools with side effects should be idempotent or use `fail`.
- **Delivery is serialized:** two results that complete together are processed one after the other, never interleaved.
  That is a valid JS schedule (timing is unspecified), but it is a change from upstream's behaviour.
- **Tool outputs must be JSON** (they are round-tripped through JSON live too, so live and replay see the same value).
  Failures are journaled as the message the interpreter would have shown, not the original error object.
- **The code can change between attempts.** Replay validates behaviour (same calls, same counts), not the source text,
  so a cosmetic change replays fine and a behavioural one diverges. pi does the same: the code is the tool call's input.
- `gate: "none"` exists only to demonstrate the problem.

## Compared with pi-durable

| Aspect                  | pi-durable code mode                                                                   | This PoC                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Interpreter             | QuickJS in WASM, in a worker; one job queue                                             | opencode's tree-walking interpreter; one Effect fiber per promise                |
| Time / randomness       | WASI clock and `random_get` virtualized; UTC; `WeakRef` removed                         | `determinism` option patched into the stdlib; host time zone                     |
| Delivery                | Host calls `deliver(seq, now, id, outcome)`; VM applies strictly in `seq` order, then reports `idle(seq, issued)` | Gate releases one result per idle point, detected by `IdleScheduler`; same ordering guarantee |
| Calls issued counts     | `issuedAfter` per journal entry, `firstIssued`                                          | `acks` table, seq 0 for the first run                                            |
| Live call admission     | A call launches only once its issued count is committed (nested calls are durable tasks keyed `c<id>` that may exist from an earlier attempt) | A call is journaled synchronously before it runs; no separate count commit needed |
| Replay hold             | Calls the journal lacks are held until replay releases (`release()`), checked against earlier keys | Same hold (`live` deferred), released once every journaled delivery and count matched |
| Nested calls            | Durable tool tasks with their own replay policy; may still be running and reattach      | Plain Effects; in flight at a crash means rerun (or fail, per tool)              |
| Divergence              | Different call or order, waits without the next call, ends where it went on, count mismatch | Same four checks                                                               |
| Refusal to resume       | Module version, VM fingerprint, deadline passed                                         | Fingerprint: upstream commit + module version + Effect version + tool paths      |
| Outcome                 | Stored once with store writes in one transaction; rerun returns it                      | Stored once; rerun returns it                                                    |
| Globals                 | Journaled (`store`, `models.*`, discovery from start data)                              | Not journaled (limitation)                                                       |
| Storage                 | Chord documents, batched commits                                                        | `JournalStore` interface; bun:sqlite, one synchronous write per event            |

The main difference is where determinism comes from. pi's VM is single-threaded by construction, so ordering only had to
be enforced at the host boundary. opencode's interpreter is concurrent by construction (fibers resumed from arbitrary
callbacks), so the "VM is idle" signal had to be built: a scheduler that owns every interpreter task.
