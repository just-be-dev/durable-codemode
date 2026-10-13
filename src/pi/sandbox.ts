import { CodemodeSandboxBase, type CodemodeSandboxBaseOptions } from "@earendil-works/pi-codemode/portable"
import { opencodeLauncher } from "./launcher.js"

/** A pi-codemode sandbox whose scripts run in opencode's interpreter. A drop-in for `CodemodeSandbox`. */
export class OpencodeCodemodeSandbox extends CodemodeSandboxBase {
  constructor(options: CodemodeSandboxBaseOptions = {}) {
    super(options, opencodeLauncher())
  }
}
