import { Effect } from "effect"
import { constructor, type Method, methods, prototypeFrom, receiver } from "../interpreter/native.js"
import { rangeError } from "../interpreter/model.js"
import { DateObj, Obj, coerceToNumber, coerceToString, type Value } from "../interpreter/objects.js"
import { toPrimitive, toPrimitiveNumber } from "../interpreter/callback.js"
import type { Interpreter } from "../interpreter/interpreter.js"

const constructDate = <R>(ctx: Interpreter<R>, args: Array<Value>, proto: Obj) => {
  // DURABLE PATCH: the current time comes from the host's `determinism.now`.
  if (args.length === 0) return Effect.succeed(new DateObj(proto, ctx.determinism.now()))
  if (args.length === 1) {
    const arg = args[0]
    if (arg instanceof DateObj) return Effect.succeed(new DateObj(proto, arg.time))
    return Effect.map(toPrimitive(ctx, arg, "default"), (value) =>
      typeof value === "string"
        ? // DURABLE PATCH: parse through `parseDate`, which honors `determinism.utc`.
          new DateObj(proto, parseDate(ctx, value))
        : new DateObj(proto, new Date(coerceToNumber(value)).getTime()),
    )
  }
  // The spec converts at most seven components, in order, so extra arguments never run program code.
  return Effect.map(
    Effect.forEach(args.slice(0, 7), (arg) => toPrimitiveNumber(ctx, arg), { concurrency: 1 }),
    (parts) =>
      new DateObj(
        proto,
        // DURABLE PATCH: components are UTC under `determinism.utc`.
        ctx.determinism.utc
          ? Date.UTC(...(parts as [number, number]))
          : new Date(...(parts as [number, number])).getTime(),
      ),
  )
}

// DURABLE PATCH: `determinism.utc` makes local time UTC, whatever the host's time zone: the local-time methods answer
// with their UTC counterparts, date components and zoneless ISO date-times are read as UTC, and the offset is 0.
const utcCounterparts: Readonly<Record<string, string>> = Object.fromEntries(
  ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"].flatMap((part) => [
    [`get${part}`, `getUTC${part}`],
    [`set${part}`, `setUTC${part}`],
  ]),
)
const localName = <R>(ctx: Interpreter<R>, name: string): string =>
  ctx.determinism.utc ? (utcCounterparts[name] ?? name) : name
const zonelessDateTime = /^[+-]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/
const parseDate = <R>(ctx: Interpreter<R>, text: string): number =>
  ctx.determinism.utc && zonelessDateTime.test(text) ? Date.parse(`${text}Z`) : Date.parse(text)
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, "0")
const utcDateString = (date: Date): string => {
  if (Number.isNaN(date.getTime())) return "Invalid Date"
  const year = date.getUTCFullYear()
  const shownYear = year < 0 ? `-${pad(year, 6)}` : pad(year, 4)
  return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${shownYear}`
}
const utcTimeString = (date: Date): string =>
  Number.isNaN(date.getTime())
    ? "Invalid Date"
    : `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`

type Getter = keyof {
  [K in keyof Date as Date[K] extends () => number ? K : never]: never
}

const getters: ReadonlyArray<Getter> = [
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
]

type Setter = keyof {
  [K in keyof Date as Date[K] extends (value: number, ...rest: Array<number>) => number ? K : never]: never
}

const setters: ReadonlyArray<readonly [Setter, number]> = [
  ["setTime", 1],
  ["setMilliseconds", 1],
  ["setUTCMilliseconds", 1],
  ["setSeconds", 2],
  ["setUTCSeconds", 2],
  ["setMinutes", 3],
  ["setUTCMinutes", 3],
  ["setHours", 4],
  ["setUTCHours", 4],
  ["setDate", 1],
  ["setUTCDate", 1],
  ["setMonth", 2],
  ["setUTCMonth", 2],
  ["setFullYear", 3],
  ["setUTCFullYear", 3],
]

export const dateGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const proto = builtins.Date
  const date = constructor<R>(builtins, proto, {
    name: "Date",
    length: 7,
    // ISO instead of the host's locale string: date strings are deterministic and must not leak the host timezone.
    // DURABLE PATCH: the current time comes from the host's `determinism.now`.
    call: () => Effect.sync(() => new Date(ctx.determinism.now()).toISOString()),
    construct: (args, newTarget) => constructDate(ctx, args, prototypeFrom(newTarget, proto)),
  })
  methods(builtins, date, [
    // DURABLE PATCH: the current time comes from the host's `determinism.now`.
    ["now", 0, () => ctx.determinism.now()],
    // DURABLE PATCH: honors `determinism.utc`.
    ["parse", 1, (_, args) => parseDate(ctx, coerceToString(args[0]))],
    [
      "UTC",
      7,
      (_, args) =>
        Effect.map(
          Effect.forEach(args.slice(0, 7), (arg) => toPrimitiveNumber(ctx, arg), { concurrency: 1 }),
          (parts) => Date.UTC(...(parts as Parameters<typeof Date.UTC>)),
        ),
    ],
  ])

  const self = (thisValue: Value, name: string) => receiver(DateObj, thisValue, `Date.prototype.${name}`)
  const iso = (value: DateObj) => {
    if (!Number.isFinite(value.time)) throw rangeError("Invalid time value.")
    return new Date(value.time).toISOString()
  }
  methods(builtins, proto, [
    ["getTime", 0, (thisValue) => self(thisValue, "getTime").time],
    ["valueOf", 0, (thisValue) => self(thisValue, "valueOf").time],
    ["toISOString", 0, (thisValue) => iso(self(thisValue, "toISOString"))],
    [
      "toJSON",
      1,
      (thisValue) => {
        const value = self(thisValue, "toJSON")
        return Number.isFinite(value.time) ? iso(value) : null
      },
    ],
    ["toString", 0, (thisValue) => coerceToString(self(thisValue, "toString"))],
    // DURABLE PATCH: UTC under `determinism.utc`.
    [
      "toDateString",
      0,
      (thisValue) => {
        const date = new Date(self(thisValue, "toDateString").time)
        return ctx.determinism.utc ? utcDateString(date) : date.toDateString()
      },
    ],
    [
      "toTimeString",
      0,
      (thisValue) => {
        const date = new Date(self(thisValue, "toTimeString").time)
        return ctx.determinism.utc ? utcTimeString(date) : date.toTimeString()
      },
    ],
    ["toUTCString", 0, (thisValue) => new Date(self(thisValue, "toUTCString").time).toUTCString()],
    ["toGMTString", 0, (thisValue) => new Date(self(thisValue, "toGMTString").time).toUTCString()],
    ...(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"] as const).map(
      (name): Method => [
        name,
        0,
        (thisValue) => new Date(self(thisValue, name).time)[name]("en-US", { timeZone: "UTC" }),
      ],
    ),
    // DURABLE PATCH: local-time getters answer in UTC under `determinism.utc`, where the offset is 0.
    ...getters.map(
      (name): Method => [
        name,
        0,
        (thisValue) => {
          const date = new Date(self(thisValue, name).time)
          if (name === "getTimezoneOffset" && ctx.determinism.utc) return Number.isNaN(date.getTime()) ? NaN : 0
          return date[localName(ctx, name) as Getter]()
        },
      ],
    ),
    ...setters.map(
      ([name, length]): Method => [
        name,
        length,
        (thisValue, args) => {
          const target = self(thisValue, name)
          // Native setters read the current time before argument coercion, whose callbacks may mutate the Date.
          const hosted = new Date(target.time)
          return Effect.map(
            Effect.forEach(args.slice(0, length), (arg) => toPrimitiveNumber(ctx, arg), {
              concurrency: 1,
            }),
            (values) => {
              // Every setter but setTime and setFullYear leaves an invalid Date untouched and answers NaN.
              if (Number.isNaN(hosted.getTime()) && name !== "setTime" && !name.endsWith("FullYear")) return NaN
              // DURABLE PATCH: local-time setters set UTC under `determinism.utc`.
              target.time = hosted[localName(ctx, name) as Setter](...(values as [number, number, number, number]))
              return target.time
            },
          )
        },
      ],
    ),
  ])
  return date
}
