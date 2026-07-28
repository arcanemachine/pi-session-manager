import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommand } from "./command.js";
import { registerTools } from "./tools.js";

/**
 * pi-session-manager extension entry point.
 *
 * Hosts fleets of normal interactive Pi TUI processes in a dedicated tmux
 * server. The `/session-manager on|off|status` command and five
 * always-registered authorization-gated tools are registered here. Task 3
 * implements creation; the remaining tool behavior arrives in later tasks.
 *
 * All five tools are registered unconditionally and remain active regardless of
 * authorization (PLAN.md section 5.4); tool schemas and prompt metadata never
 * change when authorization toggles, and no tool activation changes are made.
 */
export default function sessionManagerExtension(pi: ExtensionAPI): void {
  registerCommand(pi);
  registerTools(pi);
}
