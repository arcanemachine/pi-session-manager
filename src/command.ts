import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isAuthorized, setAuthorized } from "./authorization.js";
import { ErrorCode, SessionManagerError } from "./errors.js";
import { COMMAND_NAME } from "./constants.js";

/**
 * `/session-manager configure|status` user command (PLAN.md section 12.2).
 *
 * Only a real human in an interactive TUI can configure authorization. The
 * native selector puts the actual state first and shows the authority warning
 * before allowing the user to choose `On` or `Off`. `status` reports with a
 * transient notification only — no persistent footer, transcript item, or
 * file.
 */

const KNOWN_ARGS = ["configure", "status"] as const;
type Arg = (typeof KNOWN_ARGS)[number];

function isArg(value: string): value is Arg {
  return (KNOWN_ARGS as readonly string[]).includes(value);
}

const AUTHORITY_WARNING =
  "Enabling grants this Pi agent visibility and process/window lifecycle authority over the dedicated Session Manager fleet, including force termination.";

function usage(ctx: {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}): void {
  ctx.ui.notify("Usage: /session-manager configure | status", "info");
}

function stateText(): string {
  return isAuthorized() ? "enabled" : "disabled";
}

function notifyState(ctx: {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}): void {
  ctx.ui.notify(`Session Manager is ${stateText()}.`, "info");
}

function configurePrompt(enabled: boolean): string {
  return [
    `Session Manager authorization is currently ${enabled ? "enabled" : "disabled"}.`,
    AUTHORITY_WARNING,
    "Select On or Off.",
  ].join("\n");
}

export function registerCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure Session Manager authorization or view its status",
    getArgumentCompletions: (prefix) => {
      const matches = KNOWN_ARGS.filter((a) => a.startsWith(prefix));
      return matches.length > 0
        ? matches.map((a) => ({ value: a, label: a }))
        : null;
    },
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim().toLowerCase();

      if (arg === "" || !isArg(arg)) {
        usage(ctx);
        return;
      }

      if (arg === "status") {
        notifyState(ctx);
        return;
      }

      if (ctx.mode !== "tui" || !ctx.hasUI) {
        throw new SessionManagerError(
          ErrorCode.TUI_REQUIRED,
          "/session-manager configure requires interactive TUI mode with a real UI.",
        );
      }

      const currentlyEnabled = isAuthorized();
      const options = currentlyEnabled ? ["On", "Off"] : ["Off", "On"];
      const choice = await ctx.ui.select(
        configurePrompt(currentlyEnabled),
        options,
      );

      if (choice === "On" && !currentlyEnabled) {
        setAuthorized(true);
      } else if (choice === "Off" && currentlyEnabled) {
        setAuthorized(false);
      }

      notifyState(ctx);
    },
  });
}
