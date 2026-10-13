import { Database } from "bun:sqlite"
import { join } from "node:path"

export const WORKER = join(import.meta.dir, "worker.ts")

/** Calls with a journaled outcome, read from another process's journal. */
export const completedCalls = (journalPath: string, runId: string): Array<{ idx: number; name: string; args: string }> => {
  const db = new Database(journalPath, { readonly: true })
  try {
    return db
      .query<{ idx: number; name: string; args: string }, [string]>(
        "SELECT idx, name, args FROM calls WHERE run_id = ? AND outcome IS NOT NULL ORDER BY idx",
      )
      .all(runId)
  } catch {
    return []
  } finally {
    db.close()
  }
}

export const allCalls = (journalPath: string, runId: string) => {
  const db = new Database(journalPath, { readonly: true })
  try {
    return db
      .query<{ idx: number; name: string; args: string; outcome: string | null }, [string]>(
        "SELECT idx, name, args, outcome FROM calls WHERE run_id = ? ORDER BY idx",
      )
      .all(runId)
  } finally {
    db.close()
  }
}

/** Start the worker, SIGKILL it once `killAfter` calls have completed; resolves with what the journal held then. */
export const runAndKill = async (journalPath: string, ledgerPath: string, runId: string, killAfter: number) => {
  const proc = Bun.spawn(["bun", WORKER, journalPath, ledgerPath, runId], { stdout: "pipe", stderr: "inherit" })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await Bun.file(journalPath).exists()) && completedCalls(journalPath, runId).length >= killAfter) break
    if (proc.exitCode !== null) throw new Error(`worker exited before the kill (code ${proc.exitCode})`)
    await Bun.sleep(2)
  }
  proc.kill("SIGKILL")
  await proc.exited
  return { signal: proc.signalCode, calls: allCalls(journalPath, runId) }
}

/** Start the worker and wait for its result. */
export const runToEnd = async (journalPath: string, ledgerPath: string, runId: string) => {
  const proc = Bun.spawn(["bun", WORKER, journalPath, ledgerPath, runId], { stdout: "pipe", stderr: "inherit" })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`worker failed with ${code}: ${out}`)
  return JSON.parse(out.trim().split("\n").at(-1)!)
}
