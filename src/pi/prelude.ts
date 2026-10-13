/**
 * The JavaScript that gives a script pi-codemode's surface inside opencode's interpreter: `tools`, `ALL_TOOLS`,
 * globals, `text`, `image`, `exit`, `console`, `store`/`load`, and `performance`. A port of pi-codemode's prelude
 * (`pi/packages/codemode/src/runtime/prelude-source.ts`) to the subset opencode runs: no classes, no Proxy, no getters.
 *
 * The script is wrapped the way pi's VM wraps it, as the body of an async arrow function whose parameters shadow the
 * globals, with the script starting on line 1:
 *
 *     return await __codemode_main(async (tools, console, text, ...) => {<script>
 *     })
 *     function __codemode_main(script) { ...this prelude... }
 *
 * The prelude reaches the host through one opencode tool, `tools.__codemode_call(request)`, for every call the script
 * makes (`request` is one string: `t` or `g`, the name's length, `:`, the name, then `=` and the arguments' JSON if
 * any; it resolves with `{ ok, payload, properties }` once the host releases the result), and four
 * synchronous extension globals: `__codemode_host_init()` (start data as JSON), `__codemode_host_output(kind, a, b)`,
 * `__codemode_host_done(ok, json, writes)`, and `__codemode_host_perf()`. Values cross as JSON text, as in pi.
 */

export const MAX_STORE_VALUE_CHARS = 256 * 1024
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024
export const MAX_OUTPUT_ITEMS = 100_000

const IMAGE_HELPER_EXPECTS =
  'image expects a non-empty image URL string, an object with image_url, or an image block { type: "image", data, mimeType }'

/** Names the script function receives, in order; globals follow. */
export const BUILTIN_PARAMS = [
  "globalThis",
  "tools",
  "console",
  "text",
  "image",
  "exit",
  "store",
  "load",
  "ALL_TOOLS",
  "performance",
]

export const PRELUDE_SOURCE = `async function __codemode_main(script) {
  // Captured before the script runs, which may reassign JSON's methods.
  const stringify = JSON.stringify
  const parse = JSON.parse
  const init = parse(__codemode_host_init())
  let finished = false
  // Thrown by exit() to unwind the script after it already reported success.
  const EXIT = Object.freeze({ exit: true })

  const done = (ok, payload, writes) => {
    if (finished) return
    finished = true
    __codemode_host_done(ok, payload, writes)
  }

  const serialize = (value) => (value === undefined ? undefined : stringify(value))

  const errorText = (error) => (error.message ? error.name + ": " + error.message : String(error.name))

  const format = (value) => {
    if (typeof value === "string") return value
    if (value instanceof Error) return errorText(value)
    try {
      const json = stringify(value)
      return json === undefined ? String(value) : json
    } catch {
      return String(value)
    }
  }

  const describeError = (error) => {
    try {
      if (error instanceof Error) {
        return stringify({ name: String(error.name), message: String(error.message), stack: errorText(error) })
      }
      return stringify({ message: String(format(error)) })
    } catch {
      return stringify({ message: "The script threw a value that cannot be described" })
    }
  }

  const caller = (target, name, spread) => async (...args) => {
    const json = serialize(spread ? args : args[0])
    // One string, so nothing a script patches on Object.prototype or Array.prototype (toJSON) changes the request.
    const request = (target === "global" ? "g" : "t") + name.length + ":" + name + (json === undefined ? "" : "=" + json)
    const answer = await tools.__codemode_call(request)
    if (answer.ok) return answer.payload === undefined ? undefined : parse(answer.payload)
    const error = new Error(answer.payload)
    if (answer.properties !== undefined) {
      const properties = parse(answer.properties)
      for (const key of Object.keys(properties)) {
        if (key === "name" || key === "message" || key === "stack") continue
        error[key] = properties[key]
      }
    }
    throw error
  }

  const scriptTools = Object.create(null)
  const allTools = []
  for (const tool of init.tools) {
    const fn = caller("tool", tool.name, false)
    // The first tool wins when two names normalize to the same identifier.
    if (!(tool.jsName in scriptTools)) {
      scriptTools[tool.jsName] = fn
      allTools.push(Object.freeze({ name: tool.jsName, description: tool.description }))
    }
    if (!(tool.name in scriptTools)) scriptTools[tool.name] = fn
  }
  Object.freeze(scriptTools)
  Object.freeze(allTools)

  const globals = Object.create(null)
  for (const global of init.globals) {
    const fn = caller("global", global.name, global.spread)
    const dot = global.name.indexOf(".")
    if (dot === -1) {
      globals[global.name] = fn
      continue
    }
    const namespace = global.name.slice(0, dot)
    if (!(namespace in globals)) globals[namespace] = Object.create(null)
    globals[namespace][global.name.slice(dot + 1)] = fn
  }
  for (const name of Object.keys(globals)) {
    if (typeof globals[name] === "object") Object.freeze(globals[name])
  }

  // key -> JSON text, in records rather than Maps so a script that patches Map.prototype cannot reach them.
  // Sizes count key and JSON characters.
  const stored = Object.create(null)
  const writes = Object.create(null)
  let storedChars = 0
  for (const key of Object.keys(init.store)) {
    stored[key] = init.store[key]
    storedChars += key.length + stored[key].length
  }

  const STORE_HINT =
    "store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool."

  const checkKey = (name, key) => {
    if (typeof key !== "string") throw new TypeError(name + "() key must be a string")
  }

  const store = (key, value) => {
    checkKey("store", key)
    const previous = key in stored ? key.length + stored[key].length : 0
    if (value === undefined) {
      delete stored[key]
      storedChars -= previous
      writes[key] = null
      return
    }
    let json
    try {
      json = stringify(value)
    } catch (error) {
      throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable: " + format(error))
    }
    if (json === undefined) throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable")
    if (json.length > ${MAX_STORE_VALUE_CHARS}) {
      throw new RangeError(
        "store(" + stringify(key) + ") value has " + json.length +
          " characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}. " + STORE_HINT,
      )
    }
    const next = storedChars - previous + key.length + json.length
    if (next > ${MAX_STORE_TOTAL_CHARS}) {
      throw new RangeError(
        "store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined). " +
          STORE_HINT,
      )
    }
    stored[key] = json
    storedChars = next
    writes[key] = json
  }

  const load = (key) => {
    checkKey("load", key)
    const json = stored[key]
    return json === undefined ? undefined : parse(json)
  }

  // Built from text, so a script that patches Array.prototype.toJSON cannot change it.
  const serializeWrites = () => {
    const entries = []
    for (const key of Object.keys(writes)) {
      entries.push("[" + stringify(key) + (writes[key] === null ? "" : "," + stringify(writes[key])) + "]")
    }
    return "[" + entries.join(",") + "]"
  }

  let outputChars = 0
  let outputItems = 0

  // Past the output limits the script fails: done() reports the error, so catching it does not resume output.
  const output = (kind, data, mimeType) => {
    if (finished) return
    outputChars += data.length
    outputItems++
    if (outputChars > ${MAX_OUTPUT_CHARS} || outputItems > ${MAX_OUTPUT_ITEMS}) {
      const error = new RangeError(
        "script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. " +
          "Print a summary instead, or write large data to a file with a tool.",
      )
      done(false, describeError(error))
      throw error
    }
    __codemode_host_output(kind, data, mimeType)
  }

  // Primitives become their string form, everything else JSON.
  const outputText = (value) => {
    if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) {
      return String(value)
    }
    const json = stringify(value)
    return json === undefined ? String(value) : json
  }

  const text = (value) => {
    let rendered
    try {
      rendered = outputText(value)
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error))
    }
    output("text", rendered)
  }

  const imageUrl = (value) => {
    if (typeof value === "string") return value
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(${JSON.stringify(IMAGE_HELPER_EXPECTS)})
    }
    if (value.image_url !== undefined) {
      if (typeof value.image_url !== "string") throw new TypeError(${JSON.stringify(IMAGE_HELPER_EXPECTS)})
      return value.image_url
    }
    if (typeof value.type !== "string") throw new TypeError(${JSON.stringify(IMAGE_HELPER_EXPECTS)})
    if (value.type !== "image") throw new TypeError('image only accepts image blocks, got "' + value.type + '"')
    if (typeof value.data !== "string" || value.data === "") throw new TypeError("image expected image block data")
    if (value.data.toLowerCase().startsWith("data:")) return value.data
    return "data:;base64," + value.data
  }

  const IMAGE_SIGNATURES = [
    ["image/png", /^iVBORw0KGg/],
    ["image/jpeg", /^[/]9j[/](?!9)/],
    ["image/gif", /^R0lGOD[dl]h/],
    ["image/webp", /^UklG.{8}RUJQ/],
  ]

  const image = (value) => {
    const url = imageUrl(value)
    if (url === "") throw new TypeError(${JSON.stringify(IMAGE_HELPER_EXPECTS)})
    const colon = url.indexOf(":")
    const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase()
    if (scheme === "http" || scheme === "https") {
      throw new TypeError("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead")
    }
    const comma = url.indexOf(",")
    const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";")
    if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
      throw new TypeError("invalid image output. Pass a base64 data URI instead")
    }
    const data = url.slice(comma + 1).replace(/\\s+/g, "")
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new TypeError("invalid image output. The image data is not valid base64 (truncated or corrupted?)")
    }
    const head = data.slice(0, 16)
    const signature = IMAGE_SIGNATURES.find((entry) => entry[1].test(head))
    if (!signature) throw new TypeError("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image")
    output("image", data, signature[0])
  }

  const exit = () => {
    let writesJson
    try {
      writesJson = serializeWrites()
    } catch (error) {
      done(false, describeError(error))
      throw EXIT
    }
    done(true, undefined, writesJson)
    throw EXIT
  }

  const scriptConsole = {}
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    scriptConsole[level] = (...args) => output("console", args.map(format).join(" "))
  }
  Object.freeze(scriptConsole)

  const performance = Object.freeze({ now: () => __codemode_host_perf() })

  // pi's VM has a real global object; this one holds the script's globals and the standard built-ins, and is the
  // script's own to change (assigning to it does not rebind the identifiers).
  const scriptGlobal = {
    Object, Function, Array, Number, String, Boolean, Symbol, Date, RegExp, Map, Set, WeakMap, WeakSet, Promise,
    JSON, Math, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, AggregateError,
    Iterator, URL, URLSearchParams, Headers, Uint8Array, TextEncoder, TextDecoder, parseInt, parseFloat, isFinite,
    isNaN, encodeURI, encodeURIComponent, decodeURI, decodeURIComponent, atob, btoa, structuredClone,
    NaN, Infinity, undefined,
  }
  const values = {
    globalThis: scriptGlobal,
    tools: scriptTools,
    console: scriptConsole,
    text,
    image,
    exit,
    store,
    load,
    ALL_TOOLS: allTools,
    performance,
  }
  for (const name of Object.keys(values)) if (name !== "globalThis") scriptGlobal[name] = values[name]
  for (const name of Object.keys(globals)) scriptGlobal[name] = globals[name]
  const args = init.params.map((name) => (name in values ? values[name] : globals[name]))

  // await, not .then(): a script may replace Promise.prototype.then.
  let value
  try {
    value = await script(...args)
  } catch (error) {
    done(false, describeError(error))
    return undefined
  }
  let json
  try {
    json = serialize(value)
  } catch (error) {
    done(false, describeError(error))
    return undefined
  }
  done(true, json, serializeWrites())
  return undefined
}
`

/** The program opencode runs: the script as the body of an async arrow function, then the prelude. */
export const programSource = (code: string, params: ReadonlyArray<string>): string =>
  `return await __codemode_main(async (${params.join(", ")}) => {${code}\n})\n${PRELUDE_SOURCE}`

/** FNV-1a over UTF-16 code units, as 8 hex digits: identifies the prelude in the fingerprint. */
export const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
