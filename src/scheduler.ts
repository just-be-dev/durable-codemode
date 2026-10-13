import type { Fiber, Scheduler } from "effect"

/**
 * An Effect `Scheduler` for one execution's interpreter fibers, which knows when the interpreter is idle.
 *
 * Why: every CodeMode promise and async function is its own Effect fiber, and the interpreter's `await` continues
 * through `Effect.yieldNow`, a task on the fiber's dispatcher. With Effect's default `MixedScheduler` each fiber has
 * its own dispatcher and its own `setImmediate` batch, so a tool result arriving from the outside (a timer, a socket)
 * lands between whichever tasks happen to be queued at that wall-clock instant. Which continuation runs first, and
 * where in a multi-step continuation another result lands, then depends on timing.
 *
 * This scheduler puts every task of the execution into one FIFO (by priority, like `MixedScheduler`) and runs it in
 * batches. When a batch leaves the queue empty, every interpreter fiber is suspended on something outside the
 * interpreter: the interpreter is idle. Only then does it call `onIdle`, which may release one tool result (resuming
 * fibers inline, which queue more tasks). So a result is only ever handed over at an idle point, and the program's
 * whole reaction to it runs before the next one is handed over. Given the same results in the same order, the task
 * sequence is the same.
 *
 * Yielding is by operation count, as in `MixedScheduler`, which is deterministic.
 */
export class IdleScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async" as const
  private buckets: Array<[priority: number, tasks: Array<() => void>]> = []
  private scheduled = false
  private stopped = false

  /** `onIdle` returns whether it released something; it is called again while the queue stays empty and it does. */
  constructor(private readonly onIdle: () => boolean) {}

  shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    return fiber.currentOpCount >= fiber.cache.maxOpsBeforeYield
  }

  makeDispatcher(): Scheduler.SchedulerDispatcher {
    return {
      scheduleTask: (task, priority) => this.enqueue(task, priority),
      flush: () => {
        while (this.buckets.length > 0) this.runBatch()
      },
    }
  }

  /** Something became releasable: check for idleness soon. */
  kick(): void {
    this.schedule()
  }

  /** Stop calling `onIdle` (the execution has been decided); tasks still run so fibers can finish interrupting. */
  stop(): void {
    this.stopped = true
  }

  private enqueue(task: () => void, priority: number): void {
    let index = 0
    while (index < this.buckets.length && this.buckets[index]![0] <= priority) index++
    const before = this.buckets[index - 1]
    if (before !== undefined && before[0] === priority) before[1].push(task)
    else this.buckets.splice(index, 0, [priority, [task]])
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(this.run)
  }

  private runBatch(): void {
    const buckets = this.buckets
    this.buckets = []
    for (const [, tasks] of buckets) for (const task of tasks) task()
  }

  private readonly run = (): void => {
    this.scheduled = false
    this.runBatch()
    while (this.buckets.length === 0 && !this.stopped && this.onIdle()) {}
    if (this.buckets.length > 0) this.schedule()
  }
}
