/**
 * A pi-durable agent whose code mode runs on opencode's interpreter.
 *
 * - Storage: SQLite (`openNodeSqliteStorage`), so a new process picks up where a killed one stopped.
 * - Code mode: pi-durable's own `createCodemodeExtension`, with `OpencodeCodemodeSandbox` as the sandbox. pi-durable
 *   owns the journal, the replay, the divergence checks, and the nested tool tasks; the sandbox only runs the script.
 * - `subagent`: a durable subagent (after pi's experimental one): each call creates a child conversation owned by the
 *   call's task and runs the task there. It is replay-safe: a rerun after a crash finds the child and its submission.
 * - The model is scripted (faux provider, no API keys). The root conversation answers its input with one `codemode`
 *   call running `SCRIPT`, then a final answer built from the script's `RESULT` line. A child answers its task after a
 *   delay that depends on the task, as a JSON line.
 * - A ledger (its own SQLite file, standing in for the outside world) counts every child model request and every
 *   subagent execution, started and finished, so a test can see what ran twice.
 */
import { Database } from "bun:sqlite"
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context"
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryId,
  type Extension,
  Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable"
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable"
import { opencodeLauncher, type VmLauncher } from "../../src/pi/index.js"

export const context: Context = BACKGROUND_CONTEXT

export const AREAS = ["auth", "billing", "search", "storage", "notifications", "reporting"] as const

/** How long a child takes to answer: spread out, so a kill lands between answers. */
export const childDelay = (task: string): number => {
  if (task.startsWith("verify-worst")) return 120
  if (task.startsWith("verify-spot")) return 360
  const area = AREAS.findIndex((name) => task === `review ${name}`)
  return 150 + 120 * Math.max(0, area)
}

const hash = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0
  return h
}

/**
 * What the model writes: fan out one subagent per area, then a second phase that depends on the first and uses
 * `Date.now()` and `Math.random()` (in the arguments of its calls, so a replay that saw another clock or random stream
 * would make other calls and be refused). The `RESULT` line depends only on what the subagents said.
 */
export const SCRIPT = `const areas = ${JSON.stringify(AREAS)}
const started = Date.now()
const reviews = await Promise.all(areas.map((area) => tools.subagent({ task: "review " + area })))
const findings = reviews.map((text) => JSON.parse(text))
const worst = findings.reduce((a, b) => (b.risk > a.risk ? b : a))
const others = areas.filter((area) => area !== worst.area)
const spot = others[Math.floor(Math.random() * others.length)]
const checks = await Promise.all([["worst", worst.area], ["spot", spot]].map(([role, area]) =>
  tools.subagent({ task: "verify-" + role + " " + area + " at=" + (Date.now() - started) + " nonce=" + Math.random().toString(36).slice(2, 8) })))
const verified = checks.map((text) => JSON.parse(text))
console.log("spot-checked " + spot + " at +" + (Date.now() - started) + "ms")
text("RESULT " + JSON.stringify({ findings, worst: worst.area, confirmed: verified[0].confirmed }))
`

export const PROMPT = "Run the release review across all services."

/** The outside world: counts per key, in its own SQLite file so it survives the process. */
export class Ledger {
  readonly db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    // The busy timeout first: another process may be reading the file while this one switches it to WAL.
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY, starts INTEGER NOT NULL DEFAULT 0, finishes INTEGER NOT NULL DEFAULT 0)",
    )
  }
  started(key: string): void {
    this.db.query("INSERT INTO effects (key, starts) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET starts = starts + 1").run(key)
  }
  finished(key: string): void {
    this.db.query("UPDATE effects SET finishes = finishes + 1 WHERE key = ?").run(key)
  }
  counts(): Record<string, { starts: number; finishes: number }> {
    return Object.fromEntries(
      this.db
        .query<{ key: string; starts: number; finishes: number }, []>("SELECT key, starts, finishes FROM effects ORDER BY key")
        .all()
        .map((row) => [row.key, { starts: row.starts, finishes: row.finishes }]),
    )
  }
  close(): void {
    this.db.close()
  }
}

type Message = { role: string; content: string | Array<{ type: string; text?: string }> }
const textOf = (message: Message | undefined): string =>
  message === undefined
    ? ""
    : typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("")

/** The scripted model. */
const scriptedModel = (ledger: Ledger) => {
  const faux = fauxProvider({ models: [{ id: "scripted-1", contextWindow: 1e9 }] })
  const respond: FauxResponseFactory = async (transcript) => {
    faux.appendResponses([respond])
    const messages = transcript.messages as unknown as Array<Message>
    const task = textOf(messages.find((message) => message.role === "user"))
    if (task.startsWith("review ") || task.startsWith("verify-")) {
      const key = `model:${task.split(" at=")[0]}`
      ledger.started(key)
      await Bun.sleep(childDelay(task))
      ledger.finished(key)
      const area = task.split(" ")[1]!
      const answer = task.startsWith("review ")
        ? { area, risk: hash(area) % 10, note: `${area}: ${hash(area) % 3} open issues` }
        : { area, confirmed: hash(`verify ${area}`) % 2 === 0 }
      return fauxAssistantMessage(JSON.stringify(answer))
    }
    const result = messages.findLast((message) => message.role === "toolResult")
    if (result === undefined) {
      return fauxAssistantMessage(fauxToolCall("codemode", { code: SCRIPT }, { id: "codemode-1" }), {
        stopReason: "toolUse",
      }) as AssistantMessage
    }
    const line = textOf(result).split("\n").find((row) => row.startsWith("RESULT ")) ?? "RESULT (none)"
    return fauxAssistantMessage(`Release review finished. ${line.slice("RESULT ".length)}`)
  }
  faux.setResponses([respond])
  return faux
}

async function answerText(api: ToolExecutionApi, answer: EntryId, ctx: Context): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), ctx)
  const message = entry?.model?.[0] as AssistantMessage | undefined
  return message?.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("") ?? ""
}

/**
 * A foreground subagent, after pi's experimental `subagent.ts`: each call creates a child conversation owned by the
 * call's task, submits the task there, and returns the child's answer. A rerun after a crash finds the child and the
 * submission it made.
 */
const subagent = (ledger: Ledger): Extension => {
  const extension: Extension = defineExtension({
    name: "subagent",
    tools: [
      defineTool({
        name: "subagent",
        description: "Delegate a self-contained task to a subagent and get its answer back.",
        parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
        replay: "safe",
        execute: async (args, api, ctx) => {
          const key = `subagent:${args.task.split(" at=")[0]}`
          ledger.started(key)
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
            if (existing !== undefined) return existing.id
            const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })
            await configure(tx, created.id, { extensions: { remove: [extension] } })
            return created.id
          }, ctx)
          const handle = (await api.conversation(child, ctx))!
          const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const
          const settled = await (await handle.submit(request, ctx)).wait(ctx)
          if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`)
          const text = await answerText(api, settled.answer, ctx)
          ledger.finished(key)
          return { output: [{ type: "text", text }], details: { conversationId: child } }
        },
      }),
    ],
  })
  return extension
}

/**
 * The opencode launcher; with `SKEW_CLOCK_MS` set, one whose results carry a clock that much later, standing in for a
 * replay that sees another time than the first run did (for the test that shows pi-durable refuses it).
 */
const launcher = (): VmLauncher => {
  const base = opencodeLauncher()
  const skew = Number(process.env.SKEW_CLOCK_MS ?? 0)
  if (skew === 0) return base
  return async (data, events) => {
    const channel = await base(data, events)
    return { ...channel, post: (message) => channel.post({ ...message, ...(message.now === undefined ? {} : { now: message.now + skew }) }) }
  }
}

/** Open (or reopen) the agent on `sessionPath`. */
export async function openAgent(sessionPath: string, ledgerPath: string) {
  const ledger = new Ledger(ledgerPath)
  const faux = scriptedModel(ledger)
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(createCodemodeExtension({ sandbox: new CodemodeSandboxBase({}, launcher()), models: false }))
  registry.install(subagent(ledger))
  const harness = await Harness.open(
    await openNodeSqliteStorage(sessionPath),
    { models, registry, settings: { compaction: { enabled: false } } },
    context,
  )
  const model = faux.getModel()
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } })
  return { harness, root, ledger }
}

/** Submit the prompt (the same submission after a restart, by request id), wait for the answer, return its text. */
export async function runToAnswer(sessionPath: string, ledgerPath: string): Promise<string> {
  const { harness, root, ledger } = await openAgent(sessionPath, ledgerPath)
  try {
    harness.resume()
    const submission = await root.submit({ type: "input", content: PROMPT, requestId: "release-review" }, context)
    const settled = await submission.wait(context)
    if (settled.status !== "done" || settled.type !== "input") throw new Error(`Run failed: ${JSON.stringify(settled)}`)
    const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
    const message = answer?.model?.[0] as AssistantMessage | undefined
    return message?.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("") ?? ""
  } finally {
    await harness.close(context)
    ledger.close()
  }
}
