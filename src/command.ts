import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isAuthorized, setAuthorized } from "./authorization.js";
import { ErrorCode, SessionManagerError } from "./errors.js";
import { COMMAND_NAME } from "./constants.js";

/**
 * `/session-manager on|off|status` user command (PLAN.md section 12.2).
 *
 * Only a real human in an interactive TUI can change authorization. Both `on`
 * and `off` require a two-choice prompt defaulting to No so an injected command
 * cannot grant or revoke authority silently. `status` reports with a transient
 * notification only — no persistent footer, transcript item, or file.
 */

const KNOWN_ARGS = ["on", "off", "status"] as const;
type Arg = (typeof KNOWN_ARGS)[number];

function isArg(value: string): value is Arg {
  return (KNOWN_ARGS as readonly string[]).includes(value);
}

const ENABLE_TITLE = "Enable Session Manager?";
const ENABLE_BODY =
  "Enabling grants this Pi agent visibility and process/window lifecycle authority over the dedicated Session Manager fleet, including force termination. Continue?";

const DISABLE_TITLE = "Disable Session Manager?";
const DISABLE_BODY =
  "Disabling removes this Pi agent's Session Manager authority until re-enabled.";

function usage(ctx: {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}): void {
  ctx.ui.notify("Usage: /session-manager on | off | status", "info");
}

// Use a two-choice selector with No first so the initial default is No.
// `ctx.ui.select()` only renders its `title` argument, so the explanatory body
// is folded into that title to keep the authority warning visibly on screen at
// the moment of choice. Options are ["No", "Yes"] so the initial selection is
// No; confirmation requires a deliberate move to Yes.
async function confirmYes(
  ui: { select(title: string, options: string[]): Promise<string | undefined> },
  title: string,
  body: string,
): Promise<boolean> {
  const choice = await ui.select(
    `${title}
${body}`,
    ["No", "Yes"],
  );
  // "No" (first/default) or cancellation both leave the state unchanged.
  return choice === "Yes";
}

export function registerCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Control Session Manager authorization: on, off, or status",
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
        ctx.ui.notify(
          `Session Manager is ${isAuthorized() ? "enabled" : "disabled"}.`,
          "info",
        );
        return;
      }

      // on / off: require an interactive human TUI and a real UI choice.
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        throw new SessionManagerError(
          ErrorCode.TUI_REQUIRED,
          "/session-manager on and /session-manager off require interactive TUI mode with a real UI.",
        );
      }

      if (arg === "on") {
        if (await confirmYes(ctx.ui, ENABLE_TITLE, ENABLE_BODY)) {
          setAuthorized(true);
          ctx.ui.notify("Session Manager enabled.", "info");
        } else {
          ctx.ui.notify("Session Manager remains disabled.", "info");
        }
        return;
      }

      if (arg === "off") {
        if (await confirmYes(ctx.ui, DISABLE_TITLE, DISABLE_BODY)) {
          setAuthorized(false);
          ctx.ui.notify("Session Manager disabled.", "info");
        } else {
          ctx.ui.notify("Session Manager remains enabled.", "info");
        }
        return;
      }
    },
  });
}
