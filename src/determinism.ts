import type { CodeMode } from "../vendor/codemode/index.js"

/** splitmix32: spreads a 32-bit seed so nearby seeds give unrelated streams. */
const splitmix32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
    return (z ^ (z >>> 16)) >>> 0
  }
}

/** sfc32 over a seed: a small, fast PRNG whose stream is a pure function of the seed. */
export const prng = (seed: number): (() => number) => {
  const mix = splitmix32(seed)
  let a = mix()
  let b = mix()
  let c = mix()
  let d = mix()
  return () => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}

/**
 * The clock and randomness of one attempt. The clock reads `startedAt` until the first result is delivered, then the
 * time at which the result being processed was delivered, never going backwards (as pi-codemode's VM does). The PRNG
 * restarts from the seed on every attempt, so a replay draws the same numbers in the same order.
 */
export class VirtualWorld {
  private current: number
  private readonly next: () => number

  constructor(startedAt: number, seed: number) {
    this.current = startedAt
    this.next = prng(seed)
  }

  /** Advance to the delivery time of the result about to be processed; returns the clock value used. */
  advance(at: number): number {
    this.current = Math.max(this.current, at)
    return this.current
  }

  get now(): number {
    return this.current
  }

  private bytes(target: Uint8Array): void {
    for (let i = 0; i < target.length; i++) target[i] = Math.floor(this.next() * 256)
  }

  readonly determinism: Required<CodeMode.Determinism> = {
    utc: true,
    now: () => this.current,
    random: () => this.next(),
    getRandomValues: (bytes) => this.bytes(bytes),
    randomUUID: () => {
      const b = new Uint8Array(16)
      this.bytes(b)
      b[6] = (b[6]! & 0x0f) | 0x40
      b[8] = (b[8]! & 0x3f) | 0x80
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
  }
}
