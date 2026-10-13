import effectPackage from "effect/package.json" with { type: "json" }

/** The opencode commit `vendor/codemode` was copied from. */
export const UPSTREAM_COMMIT = "69a71426ce74bf8362fa6183937b008fa24a5dfe"

/**
 * Version of everything in `src/` that turns journal entries into what a script sees: outcome mapping, the clock, the
 * PRNG, the delivery rules. Bump it when any of that changes, so a run started before an upgrade is not replayed by
 * different code.
 */
export const MODULE_VERSION = 1

/**
 * The interpreter's interleaving rests on Effect's fiber runtime (how `Effect.all` forks, when a fiber yields), so a
 * different Effect version may order tasks differently. It is part of the fingerprint.
 */
export const EFFECT_VERSION: string = effectPackage.version
