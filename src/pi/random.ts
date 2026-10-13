const MASK = (1n << 64n) - 1n

/**
 * `Math.random()` exactly as pi's deterministic QuickJS VM produces it for a seed: QuickJS's xorshift64*, whose state
 * pi seeds with `seed + 1` (it virtualizes the clock QuickJS seeds from), with one draw consumed before the script
 * runs. So a script sees the same random numbers on either engine.
 */
export const quickjsRandom = (seed: number): (() => number) => {
  let state = BigInt((seed >>> 0) + 1) & MASK
  if (state === 0n) state = 1n
  const view = new DataView(new ArrayBuffer(8))
  const next = () => {
    let x = state
    x ^= x >> 12n
    x = (x ^ (x << 25n)) & MASK
    x ^= x >> 27n
    state = x
    const value = (x * 0x2545f4914f6cdd1dn) & MASK
    view.setBigUint64(0, (0x3ffn << 52n) | (value >> 12n))
    return view.getFloat64(0) - 1
  }
  next()
  return next
}

/** mulberry32 over `seed ^ 0x9e3779b9`, pi's VM's source for other randomness; here for `crypto.*`. */
export const randomBytes = (seed: number): ((bytes: Uint8Array) => void) => {
  let state = (seed ^ 0x9e3779b9) >>> 0
  const draw = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return (value ^ (value >>> 14)) >>> 0
  }
  return (bytes) => {
    for (let index = 0; index < bytes.length; index += 4) {
      const value = draw()
      for (let byte = 0; byte < 4 && index + byte < bytes.length; byte++) bytes[index + byte] = value >>> (byte * 8)
    }
  }
}
