/**
 * pi-durable's code mode on opencode's interpreter, killed mid fan-out and resumed in a new process.
 *
 *   bun run demo:pi [reviewsBeforeKill=3]
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCRIPT } from "./agent.js"
import { classify, finishedCount, readLedger, runAndKill, runToEnd } from "./crash.js"

const reviewsBeforeKill = Number(process.argv[2] ?? 3)
const dir = mkdtempSync(join(tmpdir(), "durable-codemode-pi-demo-"))
const session = join(dir, "session.sqlite")
const ledger = join(dir, "ledger.sqlite")

console.log("The scripted model answers the prompt with one codemode call running:\n")
console.log(SCRIPT.trim().split("\n").map((line) => "  | " + line).join("\n") + "\n")

console.log(`1. Start the agent process; SIGKILL it once ${reviewsBeforeKill} subagent reviews have answered.`)
const killed = await runAndKill(session, ledger, (counts) => finishedCount(counts, "review") >= reviewsBeforeKill)
const { finished, running } = classify(killed.counts)
console.log(`   killed by ${killed.signal}.`)
console.log(`   answered: ${finished.join(", ")}`)
console.log(`   running:  ${running.join(", ")}\n`)

console.log("2. Start a new process on the same SQLite session. pi-durable resumes the run: its code mode tool replays")
console.log("   the script on opencode's interpreter with the journaled results, then continues live.")
const started = Date.now()
const answer = await runToEnd(session, ledger)
console.log(`   answered in ${Date.now() - started} ms:\n   ${answer}\n`)

console.log("3. What ran how often (starts / finishes):")
const counts = readLedger(ledger)
for (const task of [...new Set(Object.keys(counts).map((key) => key.slice(key.indexOf(":") + 1)))]) {
  const tool = counts[`subagent:${task}`]!
  const model = counts[`model:${task}`]!
  const note = finished.includes(task)
    ? "answered before the kill: not run again"
    : running.includes(task)
      ? "running at the kill: ran again"
      : "ran after the restart"
  console.log(
    `   ${task.padEnd(28)} subagent ${tool.starts}/${tool.finishes}  child model ${model.starts}/${model.finishes}  ${note}`,
  )
}

console.log("\n4. The same prompt in a fresh session, never interrupted:")
const reference = await runToEnd(join(dir, "ref.sqlite"), join(dir, "ref-ledger.sqlite"))
console.log(`   same answer: ${reference === answer}`)

rmSync(dir, { recursive: true, force: true })
