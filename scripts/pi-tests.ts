/**
 * Run pi's own code mode test suites against the opencode-backed sandbox.
 *
 *   bun scripts/pi-tests.ts [--baseline] [--keep]
 *
 * 1. Extracts pi at the pinned tag (`git archive`, so the ../pi checkout is only read) into .tmp/pi-suite.
 * 2. Installs its workspace dependencies; pi-ai has no `source` export, so its dist comes from the published 1.2.0.
 * 3. Writes `*.opencode.test.ts` copies of the suites in which every `new CodemodeSandbox(...)` is
 *    `new OpencodeCodemodeSandbox(...)`, a `CodemodeSandboxBase` with `opencodeLauncher()` (src/pi/launcher.ts).
 *    Backends other than the worker one (inline, remote) are dropped, and so are tests of the QuickJS hosts
 *    themselves (remote transport reordering, worker files, the QuickJS prelude): they do not test the VM contract.
 * 4. Runs them with pi's vitest config and prints pass/fail per test. `--baseline` runs the unmodified suites too.
 */
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const PI_TAG = "v1.2.0"
const root = resolve(import.meta.dir, "..")
const pi = resolve(root, process.env.PI_SOURCE ?? "../pi")
const suite = join(root, ".tmp/pi-suite")
const baseline = process.argv.includes("--baseline")

if (!existsSync(join(suite, ".extracted-" + PI_TAG))) {
  rmSync(suite, { recursive: true, force: true })
  mkdirSync(suite, { recursive: true })
  await $`git -C ${pi} archive ${PI_TAG} | tar -x -C ${suite}`
  await $`npm ci --ignore-scripts --no-audit --no-fund`.cwd(suite).quiet()
  await $`cp -R ${join(root, "node_modules/@earendil-works/pi-ai/dist")} ${join(suite, "packages/ai/dist")}`
  writeFileSync(join(suite, ".extracted-" + PI_TAG), "")
}
const commit = (await $`git -C ${pi} rev-list -n 1 ${PI_TAG}`.text()).trim()

writeFileSync(
  join(suite, "packages/codemode/test/opencode-sandbox.ts"),
  `import { CodemodeSandboxBase, type CodemodeSandboxBaseOptions } from "../src/portable.ts";
import { opencodeLauncher } from ${JSON.stringify(join(root, "src/pi/launcher.ts"))};

/** CodemodeSandbox's place in the suites: the same host side, opencode's interpreter as the VM. */
export class OpencodeCodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: CodemodeSandboxBaseOptions & Record<string, unknown> = {}) {
		super(options, opencodeLauncher() as never);
	}
}
`,
)

type Suite = { dir: string; file: string; shim: string; edit?: (source: string) => string }
const suites: Array<Suite> = [
  {
    dir: "packages/codemode",
    file: "test/deterministic.test.ts",
    shim: "./opencode-sandbox.ts",
    edit: (source) =>
      source
        .replace("\tremote: (options = {}) => remote(options),\n", "")
        .replace(
          'describe("deterministic runs (remote transport)"',
          'describe.skip("deterministic runs (remote transport)"',
        ),
  },
  {
    // execute() (not deterministic) behavior: every backend becomes the opencode one; the worker-host tests
    // (worker files, wasm loading) and the QuickJS prelude parse check do not apply.
    dir: "packages/codemode",
    file: "test/sandbox.test.ts",
    shim: "./opencode-sandbox.ts",
    edit: (source) =>
      source
        .replace(
          /const BACKENDS: Record<[^\n]*\n[\s\S]*?\n};\n/,
          "const BACKENDS: Record<string, (options: CodemodeSandboxBaseOptions) => CodemodeSandboxBase> = {\n\topencode: (options) => new OpencodeCodemodeSandbox(options),\n};\n",
        )
        .replace('describe("embedded sources"', 'describe.skip("embedded sources"')
        .replace('describe("worker host"', 'describe.skip("worker host"'),
  },
  { dir: "packages/durable", file: "test/codemode.test.ts", shim: "../../codemode/test/opencode-sandbox.ts" },
  { dir: "packages/durable", file: "test/codemode-models.test.ts", shim: "../../codemode/test/opencode-sandbox.ts" },
  { dir: "packages/durable", file: "test/codemode-describe.test.ts", shim: "../../codemode/test/opencode-sandbox.ts" },
]

type Assertion = { fullName: string; status: string; failureMessages: Array<string> }
const run = async (dir: string, file: string) => {
  const out = join(suite, ".tmp-report.json")
  rmSync(out, { force: true })
  await $`npx vitest --run ${file} --reporter=json --outputFile=${out}`.cwd(join(suite, dir)).quiet().nothrow()
  const report = JSON.parse(readFileSync(out, "utf8")) as {
    testResults: Array<{ assertionResults: Array<Assertion>; message?: string }>
  }
  return report.testResults.flatMap((result) => result.assertionResults)
}

console.log(`pi ${PI_TAG} (${commit.slice(0, 12)}), opencode-backed sandbox\n`)
let passed = 0
let failed = 0
for (const { dir, file, shim, edit } of suites) {
  const source = readFileSync(join(suite, dir, file), "utf8")
  const copy = file.replace(/\.test\.ts$/, ".opencode.test.ts")
  const edited = (edit ?? ((s: string) => s))(source).replaceAll("new CodemodeSandbox(", "new OpencodeCodemodeSandbox(")
  writeFileSync(join(suite, dir, copy), `import { OpencodeCodemodeSandbox } from ${JSON.stringify(shim)};\n${edited}`)

  if (baseline) {
    const base = await run(dir, file)
    const ok = base.filter((test) => test.status === "passed").length
    console.log(`${dir}/${file} (QuickJS baseline): ${ok}/${base.length} passed`)
  }
  const results = await run(dir, copy)
  const ok = results.filter((test) => test.status === "passed")
  const bad = results.filter((test) => test.status === "failed")
  passed += ok.length
  failed += bad.length
  console.log(`${dir}/${file}: ${ok.length} passed, ${bad.length} failed, ${results.length - ok.length - bad.length} skipped`)
  for (const test of bad) {
    const first = (test.failureMessages[0] ?? "").split("\n").find((line) => line.trim() !== "") ?? ""
    console.log(`  FAIL ${test.fullName}\n       ${first.slice(0, 300)}`)
  }
}
console.log(`\ntotal: ${passed} passed, ${failed} failed`)
if (!process.argv.includes("--keep")) rmSync(join(suite, ".tmp-report.json"), { force: true })
