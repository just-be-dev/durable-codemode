/**
 * One process of the example: open the agent on a session file, run (or resume) the release review, print the answer.
 *
 *   bun examples/pi-durable/worker.ts <session.sqlite> <ledger.sqlite>
 */
import { runToAnswer } from "./agent.js"

const [sessionPath, ledgerPath] = process.argv.slice(2)
if (sessionPath === undefined || ledgerPath === undefined) {
  console.error("usage: worker.ts <session.sqlite> <ledger.sqlite>")
  process.exit(2)
}
console.log(JSON.stringify({ answer: await runToAnswer(sessionPath, ledgerPath) }))
