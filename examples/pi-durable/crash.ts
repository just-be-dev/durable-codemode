import { Database } from "bun:sqlite"
import { join } from "node:path"

export const WORKER = join(import.meta.dir, "worker.ts")

export type Counts = Record<string, { starts: number; finishes: number }>

/** The ledger as another process sees it. */
export const readLedger = (ledgerPath: string): Counts => {
  const db = new Database(ledgerPath, { readonly: true })
  try {
    return Object.fromEntries(
      db
        .query<{ key: string; starts: number; finishes: number }, []>("SELECT key, starts, finishes FROM effects")
        .all()
        .map((row) => [row.key, { starts: row.starts, finishes: row.finishes }]),
    )
  } catch {
    return {}
  } finally {
    db.close()
  }
}

/**
 * Start a worker and SIGKILL it once `ready(counts)` holds, `graceMs` later (so the results that made it true are
 * committed; the next one is further away than that). Resolves with the ledger at the kill.
 */
export const runAndKill = async (
  sessionPath: string,
  ledgerPath: string,
  ready: (counts: Counts) => boolean,
  graceMs = 40,
) => {
  const proc = Bun.spawn(["bun", WORKER, sessionPath, ledgerPath], { stdout: "pipe", stderr: "inherit" })
  const deadline = Date.now() + 30_000
  while (!((await Bun.file(ledgerPath).exists()) && ready(readLedger(ledgerPath)))) {
    if (Date.now() > deadline) throw new Error("timed out before the kill")
    if (proc.exitCode !== null) throw new Error(`worker exited before the kill (code ${proc.exitCode})`)
    await Bun.sleep(2)
  }
  await Bun.sleep(graceMs)
  proc.kill("SIGKILL")
  await proc.exited
  return { signal: proc.signalCode, counts: readLedger(ledgerPath) }
}

/** Start a worker and wait for its answer. */
export const runToEnd = async (sessionPath: string, ledgerPath: string, env: Record<string, string> = {}): Promise<string> => {
  const proc = Bun.spawn(["bun", WORKER, sessionPath, ledgerPath], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...env },
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`worker failed with ${code}: ${out}`)
  return (JSON.parse(out.trim().split("\n").at(-1)!) as { answer: string }).answer
}

/** Keys of the subagent calls that had finished, and those still running, in a ledger snapshot. */
export const classify = (counts: Counts) => {
  const calls = Object.entries(counts).filter(([key]) => key.startsWith("subagent:"))
  return {
    finished: calls.filter(([, c]) => c.finishes > 0).map(([key]) => key.slice("subagent:".length)),
    running: calls.filter(([, c]) => c.finishes === 0).map(([key]) => key.slice("subagent:".length)),
  }
}

/** Subagent calls of phase 1 (`review`) or phase 2 (`verify-*`) that finished. */
export const finishedCount = (counts: Counts, prefix: string) =>
  Object.entries(counts).filter(([key, c]) => key.startsWith(`subagent:${prefix}`) && c.finishes > 0).length
