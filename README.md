# durable-codemode

An experiment: can [opencode](https://github.com/anomalyco/opencode)'s code mode be made durable the way
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)'s code mode is?

**Short answer: yes.** It takes a ~60-line patch to the interpreter, a custom Effect scheduler, and a SQLite journal. A
script that fans out tool calls survives a real `SIGKILL` and resumes. Tool calls that had finished don't run again,
and the final result is identical to a run that never crashed.

## Background

"Code mode" lets a model write a small JavaScript program that calls tools, instead of calling tools one at a time.
Once a script can call a subagent tool, you get workflows: fan out ten reviewers, verify each finding with another
agent, aggregate the result. All of that happens in one tool call.

In October 2026 Mario Zechner [showed](https://x.com/badlogicgames/status/2109413968552820840) this running on
pi-durable: Claude Code–style dynamic workflows "for free, durably", with every subagent inspectable and steerable.
The durable part is pi-durable's code mode tool (`packages/durable/src/codemode/codemode.ts`). It works like this:

1. pi runs the script in QuickJS with a virtual clock, a seeded PRNG, and UTC, so the same inputs produce the same
   calls.
2. Every tool result is written to a journal *before* the script sees it.
3. After a crash, pi reruns the script from the start and hands it the journaled results in the same order. The script
   makes the same calls again, so finished calls are matched to their saved results instead of running. Then it
   continues live.
4. If the script takes a different path than last time, the call ends with an error instead of guessing.

opencode also has a code mode package, `@opencode/codemode`. Its runtime is quite different: a JS-subset interpreter
written from scratch in Effect on top of `acorn`, not QuickJS. And it has no durability; its docs say "hosts remain
responsible for … durable side effects". In opencode, a crash loses the script and everything it was doing.

So the question was whether pi's approach carries over to an interpreter with a completely different execution model.

## What I tried

- Vendor `@opencode/codemode` at a pinned commit and change as little as possible. The patch adds one optional
  `determinism: { now, random, randomUUID, getRandomValues, utc }` option. It's written so it could plausibly go upstream,
  and leaving it out keeps upstream behaviour.
- Build the durable layer outside the interpreter: a journal, a wrapper around every tool, replay and divergence
  checks, and a stored final result. These mirror pi-durable's design.
- Test it with a real crash: spawn a worker process, `SIGKILL` it partway through a fan-out, restart it, and count
  how many times each tool actually ran.

## What I found

**Clock and randomness had to be patched.** `Date.now()`, `Math.random()` and `crypto.randomUUID()` in opencode's
stdlib go straight to the host. Extensions can't override built-ins, and replacing the process-wide `Date.now` would
also change Effect's own clock. So this is the one thing that needed an interpreter patch: six files, +131/-16
(most of it a `utc` switch for local-time `Date` methods, added when running inside pi-durable). Upstream's own 1,398
codemode tests still pass against the patched copy.

**Result ordering was the hard part.** In QuickJS there's one job queue, so pi only has to control the order in which
results go in. opencode's interpreter is different: every promise is its own Effect fiber, and a fiber resumes
synchronously inside whatever callback completed it. Where a tool result lands among the script's pending steps
therefore depends on wall-clock timing, not just on completion order:

- Same results, same completion order, different spacing: b arriving 50 ms after a gives `a1,a2,a3,b`; 1 ms after
  gives `a1,b,a2,a3`. Recording the completion order is not enough to replay a run.
- A naive replay that hands back saved results immediately diverged in about 22 of 25 randomized trials.

**The ordering fix needed no interpreter patch.** In Effect 4, the `Scheduler` can be supplied through context, and
every fiber the interpreter starts inherits it. A custom `IdleScheduler` runs all of the interpreter's work in one
queue and notices when the script is fully idle. Only then does it release the next result, after journaling it.
That gives the same guarantee as pi's `deliver(seq, …)` + `idle`. With it, 25 of 25 randomized replays matched the
live run exactly.

**It works.** Killing the process mid-run and restarting gave these results:

- Calls that had finished ran exactly once.
- Calls that were in flight ran again.
- The final value equals an uninterrupted run with the same seed.
- Invoking a completed run again returns the stored result and runs nothing.
- Changed scripts, tampered journals, and a changed tool set end with a stored error and start no new side effects.

**Takeaway:** pi's journal-and-replay design isn't tied to QuickJS; any interpreter can use it if it offers two
things. It must read time and randomness from an injectable source, and the host must be able to tell when the script
is idle. QuickJS gets the second for free from its single job queue. opencode's fiber-per-promise interpreter needs a
scheduler to provide it, and Effect makes that possible without touching the interpreter.

That is also what a pi-durable `VmLauncher` needs from an engine, so the second experiment was to run opencode's
interpreter *inside* pi-durable, as the engine behind pi-durable's own code mode tool. It works: pi-durable's own code
mode test suites pass against it (52 of 52), and an agent on SQLite storage survives a `SIGKILL` mid fan-out with
real durable subagents. See [Running inside pi-durable](#running-inside-pi-durable).

The rest of this README is the technical write-up.

## Running it

```sh
bun install
bun test               # 35 tests: the standalone durable layer, the pi launcher, and the pi-durable example
bun run demo           # standalone: spawn a worker, SIGKILL it after 3 finished calls, restart it
bun run demo:pi        # inside pi-durable: SIGKILL an agent mid fan-out, resume it in a new process
bunx tsc --noEmit      # typecheck
bun run test:upstream  # upstream's own codemode test suite against the patched vendor copy (needs ../opencode)
bun run test:pi        # pi's own code mode test suites against the opencode-backed sandbox (needs ../pi)
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
| `src/pi/`                  | The pi-codemode `VmLauncher` for opencode's interpreter, its prelude, `OpencodeCodemodeSandbox` |
| `examples/pi-durable/`     | A pi-durable agent with code mode on opencode, durable subagents, and the crash demo       |
| `scripts/pi-tests.ts`      | Runs pi's own code mode suites against the opencode-backed sandbox                         |

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
(6 files, +131/-16). Upstream's own test suite (1398 tests, test262 and WPT subsets included) passes against the patched
copy (`bun run test:upstream`).

| File                         | Change                                                                                     | Why                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `codemode.ts`                | New exported `Determinism` type (`now`, `random`, `randomUUID`, `getRandomValues`, `utc`, all optional); `Options.determinism`; passed to `executeProgram` | The public injection point                                                 |
| `interpreter/execute.ts`     | `executeProgram(..., determinism?)` passes it to `new Interpreter(...)`                   | Threading                                                                  |
| `interpreter/interpreter.ts` | `Interpreter.determinism: Required<Determinism>`, defaults to `Date.now`, `Math.random`, `crypto` | One place the stdlib reads from                                             |
| `stdlib/date.ts`             | `new Date()`, `Date()`, `Date.now()` read `ctx.determinism.now()`. With `utc: true`, local-time getters and setters use their UTC counterparts, `getTimezoneOffset()` is 0, `new Date(y, m, ...)` and zoneless ISO date-times are UTC, and `toDateString`/`toTimeString` print UTC | Time and the host's time zone went straight to the script; pi's VM runs in UTC |
| `stdlib/math.ts`             | `Math.random()` reads `ctx.determinism.random()`                                         | Randomness went straight to the host                                       |
| `stdlib/web.ts`              | `crypto.randomUUID()`, `crypto.getRandomValues()` read `ctx.determinism`                  | Randomness went straight to the host                                       |

Could this be done from outside, without patching? Not cleanly: extensions cannot shadow built-ins (`CodeMode.make`
throws), and replacing the host's `Date.now`/`Math.random` would also change Effect's clock and every other user in the
process. The scheduler, the tool wrapping, and the journal are all done from outside.

## Tests

`bun test` (35 tests, about 14 s). The standalone durable layer:

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
stops the attempt, so nothing is journaled afterwards, which matches a kill. `crash.test.ts`, `pi-durable.test.ts`, and
the demos kill a process.

Inside pi-durable (next section): `test/pi-launcher.test.ts` (the VM contract through pi's own host side) and
`test/pi-durable.test.ts` (the agent, killed and resumed).

## Limitations

- **Extensions are not journaled.** `Extension.make` globals call the host directly; a durable run should only use
  deterministic ones. pi journals its globals' outcomes; doing the same here means wrapping `extensions` like tools.
- **Time zones.** Durable runs use `utc: true`, so local time is UTC wherever they resume. `Date.parse` of a non-ISO
  string without a zone (`"Jan 1 2024 10:00"`) is still read in the host's zone.
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
| Time / randomness       | WASI clock and `random_get` virtualized; UTC; `WeakRef` removed                         | `determinism` option patched into the stdlib; UTC through `utc: true`            |
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

## Running inside pi-durable

The standalone layer above re-implements pi-durable's journal. The second experiment drops it and puts opencode's
interpreter under pi-durable itself, as the engine behind pi-durable's own `codemode` tool. pi-durable keeps
everything it already does (the journal, replay, divergence checks, nested durable tool tasks); only the VM changes.

```ts
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode"
import { OpencodeCodemodeSandbox } from "./src/pi/index.js"

registry.install(createCodemodeExtension({ sandbox: new OpencodeCodemodeSandbox() }))
// or: new CodemodeSandboxBase(options, opencodeLauncher())
```

### How pi is consumed

The published npm packages, pinned exactly: `@earendil-works/pi-durable`, `pi-codemode`, `pi-ai`, and `chord`, all
1.2.0 (the release that has the `/codemode` export). `bun run test:pi` needs pi's tests, which are not published, so it
extracts pi at the `v1.2.0` tag (`06a466935536`) from the `../pi` checkout with `git archive` (the checkout is only
read), installs its workspace, and uses the published pi-ai `dist` (pi-ai has no `source` export). pi's `codemode`
and `durable` sources are identical at `v1.2.0` and at the checkout's HEAD.

### The seam

`CodemodeSandboxBase(options, launch)` is pi-codemode's host side: tool table, call records, output, deadline, abort.
It talks to its VM only through the messages in `protocol.ts`, and a `VmLauncher` decides where the VM runs.
`opencodeLauncher()` (`src/pi/launcher.ts`) is one more launcher, next to pi's worker, inline, and remote ones. pi
doesn't export the launcher types, so they are matched structurally.

| Protocol                                   | opencode launcher                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `started { fingerprint }`                  | `opencode-codemode <commit>, effect 4.0.1, launcher 1, prelude <fnv1a>`, before the script runs |
| `call { id, target, name, args }`          | Numbered 1, 2, ... across tools and globals in call order; `args` is the script's `JSON.stringify` |
| `output { item }`                          | `text()`, `image()` (pi's validation, ported), `console.*` (marked `console: true`)        |
| `result { id, ok, payload, seq, now, properties }` | Buffered by `seq` and applied strictly in order, waiting through gaps, one per idle point; the clock reads `now`, never going backwards; a rejection is an `Error` with `properties` |
| `idle { seq, issued }`                     | After the first run and after each result, once `IdleScheduler` sees every fiber waiting   |
| `done { ok, value, writes, during }`       | Return value as JSON, `store()` writes, and the result being processed when the script ended |
| `done` (stalled)                           | Idle, no call pending, not finished: pi's "promise that can never settle" error           |
| `crash`                                    | A `seq` used twice or out of range; the interpreter ending without a result               |
| Deterministic mode                         | Clock `startedAt` then `now`; `Math.random()` is QuickJS's xorshift64* stream for the seed, bit for bit (pi's pinned values match); UTC via `determinism.utc`; `performance.now()` counts from `startedAt` |
| `execute()` (not deterministic)            | Host clock, randomness, and time zone; results applied in arrival order                    |

Messages go to the host in a microtask, never from inside an interpreter fiber, as pi's inline launcher does, so host
code never re-enters the interpreter. `stop()` interrupts the program's fiber.

The script surface is a port of pi's prelude (`src/pi/prelude.ts`) to opencode's subset. The script becomes the body of
an async arrow function whose parameters are `globalThis, tools, console, text, image, exit, store, load, ALL_TOOLS,
performance` and the run's globals (`models.first` becomes a `models` object), so the script starts on line 1 as in
pi's VM. The prelude reaches the host through one opencode tool, `__codemode_call(request)`, which waits on the
launcher's gate, and four small synchronous extension globals for output, the result, start data, and the clock. Values
cross as JSON text, as in pi. The bridge doesn't depend on anything a script can patch: the request is a single string,
`await` is used instead of `.then`, and `JSON.stringify`/`JSON.parse` are captured before the script runs.

### pi's own test suites against it

`bun run test:pi` runs pi's suites with every `new CodemodeSandbox(...)` replaced by `new OpencodeCodemodeSandbox(...)`.

| Suite (pi v1.2.0)                                | QuickJS | opencode | Failures                                         |
| ------------------------------------------------ | ------- | -------- | ------------------------------------------------ |
| `durable/test/codemode.test.ts`                  | 40/40   | 40/40    |                                                  |
| `durable/test/codemode-models.test.ts`           | 7/7     | 7/7      |                                                  |
| `durable/test/codemode-describe.test.ts`         | 5/5     | 5/5      |                                                  |
| `codemode/test/deterministic.test.ts` (worker backend) | 15/15 | 13/15 | 2 QuickJS-specific assertions                  |
| `codemode/test/sandbox.test.ts` (`execute()`, worker backend) | 47/47 | 38/47 | 9 opencode subset gaps                     |

All of pi-durable's code mode tests pass: replay after a restart, divergence, fingerprint changes, deadlines, nested
calls, globals, `models.*`, the store, output formatting. Tests of the QuickJS hosts themselves (worker files, wasm
loading, the remote transport's reordering, the prelude's parse check) are skipped as not applicable.

The 11 failures:

- **QuickJS-specific assertions (2).** The fingerprint must match `quickjs-wasi …`. And `typeof WeakRef` must be
  `"function"` in `execute()` mode; opencode has no `WeakRef` at all. The deterministic half of that test (UTC,
  no `WeakRef`) passes.
- **No stack traces (3).** opencode errors have no `stack`, so thrown errors can't name `codemode.js:<line>`, and there
  are no V8-style frames. Syntax errors do carry the line.
- **No `Proxy` (2).** pi's `tools` and namespace objects throw a "does not exist. Did you mean …" error for unknown
  members; here an unknown member is `undefined` and calling it says "is not a function".
- **No `eval`/`Function`, classes, or user-defined constructors (2).** Unsupported syntax fails the script with a
  `SyntaxError` naming the construct.
- **No built-in lockdown and no cyclic data (2).** pi freezes every intrinsic and patches the override mistake with
  accessors; opencode has no accessor properties, and freezing prototypes without them breaks `obj.toString = …`. So a
  script can still patch built-ins (only its own data is affected; the bridge isn't). Separately, opencode rejects
  `circular.self = circular` outright, which one of the text/image argument checks relies on.

None of these are adapter bugs. Three adapter bugs the suites found are fixed: a script that replaced
`Promise.prototype.then` stopped the prelude from reporting its result, a patched `toJSON` broke the bridge and the
store writes, and `globalThis` was missing.

### The end-to-end example

`examples/pi-durable/` is a pi-durable agent on SQLite storage (`openNodeSqliteStorage`) with
`createCodemodeExtension({ sandbox: new CodemodeSandboxBase({}, opencodeLauncher()) })` and a durable `subagent` tool,
after pi's experimental one (`7472cda0d^:packages/coding-agent/src/experimental/durable/subagent.ts`). Each call
creates a child conversation owned by the call's task and runs the task there. It is replay-safe: a rerun finds the
child and its submission.

The model is scripted (pi-ai's faux provider, no API keys). The root conversation answers the prompt with one
`codemode` call. The script fans out six subagent reviews, then a second phase that depends on them: verify the
riskiest area and a random other one, with `Date.now()` and `Math.random()` in the verification tasks' arguments. Each
child answers after a delay that depends on its task. A ledger in a separate SQLite file counts every subagent
execution and every child model request.

`bun run demo:pi` kills the agent process with `SIGKILL` after three reviews have answered and starts a new process on
the same session file:

```text
   review auth                  subagent 1/1  child model 1/1  answered before the kill: not run again
   review billing               subagent 1/1  child model 1/1  answered before the kill: not run again
   review search                subagent 1/1  child model 1/1  answered before the kill: not run again
   review storage               subagent 2/1  child model 2/1  running at the kill: ran again
   review notifications         subagent 2/1  child model 2/1  running at the kill: ran again
   review reporting             subagent 2/1  child model 2/1  running at the kill: ran again
   verify-worst auth            subagent 1/1  child model 1/1  ran after the restart
   verify-spot storage          subagent 1/1  child model 1/1  ran after the restart

4. The same prompt in a fresh session, never interrupted:
   same answer: true
```

pi-durable reopened the session and resumed the `codemode` tool, which replayed the script on opencode's interpreter
with the journaled results. The finished subagents reattached by key, and the script continued live.
`test/pi-durable.test.ts` checks this for a kill mid fan-out and a kill mid phase 2. The phase-2 kill means the
replay must reproduce the `Date.now()` and `Math.random()` values in a finished verification's arguments, or pi-durable
would refuse the reused key. A last test shifts the replay's clock by 1 ms and checks that pi-durable does refuse it.

### Differences from pi's QuickJS VM

- The JavaScript subset, as listed above (no classes, `Proxy`, getters, `eval`, `WeakRef`, BigInt, stack traces).
  Scripts written for pi that use these fail with a clear error rather than misbehaving.
- No memory limit: `memoryLimitBytes` is ignored. A busy loop is stopped by the run's deadline, which can fire because
  the interpreter yields to the event loop between batches, so no interrupt budget is needed.
- The interpreter runs on the host's thread, like pi's inline sandbox. Long computations share the event loop with the
  host (the interpreter yields every 2,048 operations).
- Extra built-ins pi's VM doesn't have: `URL`, `Headers`, `crypto` (seeded in deterministic runs), `structuredClone`.
- `globalThis` is a plain object holding the script's globals and the standard built-ins. Assigning to it doesn't
  rebind identifiers.
- The four bridge globals (`__codemode_host_*`) are visible to the script; pi hides its bridge in a closure.
