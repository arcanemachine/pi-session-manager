import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { requireAuthorization } from "./authorization.js";
import { ErrorCode, SessionManagerError } from "./errors.js";
import {
  FLEET_PATTERN,
  TOOL_CLOSE,
  TOOL_CREATE,
  TOOL_FORCE_CLOSE,
  TOOL_LIST,
  TOOL_VIEW,
} from "./constants.js";

/**
 * V1 agent tool skeletons (PLAN.md section 17).
 *
 * All five tools are always registered regardless of authorization. Every tool
 * first calls the shared authorization guard, so all tools deny before any tmux
 * inspection while disabled (PLAN.md section 12.3). Schemas, promptSnippet, and
 * promptGuidelines are static metadata that must NOT change when the
 * authorization Boolean toggles (PLAN.md section 5.4).
 *
 * Task 1 ships skeletons only: real tmux behaviour comes in later tasks, so the
 * authorized path currently returns a placeholder result until the corresponding
 * task implements it.
 */

const FLEET_DESCRIPTION =
  "Managed fleet name. Conventionally <project>-<role>, treated as an opaque namespace. Must match [a-z0-9][a-z0-9_-]{0,63}.";
const INSTANCE_DESCRIPTION =
  "Positive integer instance number, equal to the tmux window index.";

const SHARED_TOOL_NAMES = [
  TOOL_LIST,
  TOOL_VIEW,
  TOOL_CREATE,
  TOOL_CLOSE,
  TOOL_FORCE_CLOSE,
] as const;

export const TOOL_TRUE_DESCRIPTION =
  "Must be exactly true to confirm intent to terminate the live worker process by removing its managed window.";

/**
 * Stable system-prompt guidelines for every tool (PLAN.md section 18). Each
 * bullet names the tool it refers to because Pi appends guidelines flat.
 */
export const TOOL_GUIDELINES: Record<
  (typeof SHARED_TOOL_NAMES)[number],
  string[]
> = {
  [TOOL_LIST]: [
    `Call ${TOOL_LIST} only after the user runs /session-manager on. ${TOOL_LIST} reports managed fleets and instances; it is observation, not task-completion evidence.`,
  ],
  [TOOL_VIEW]: [
    `Call ${TOOL_VIEW} only after the user runs /session-manager on. Use ${TOOL_VIEW} for bounded terminal observation of one Pi instance, never as proof of task completion.`,
  ],
  [TOOL_CREATE]: [
    `Call ${TOOL_CREATE} only after the user runs /session-manager on. Use ${TOOL_CREATE} only to start normal interactive Pi TUI instances in the dedicated fleet.`,
  ],
  [TOOL_CLOSE]: [
    `Call ${TOOL_CLOSE} only after the user runs /session-manager on. End a worker Pi gracefully through the user or the appropriate control mechanism before calling ${TOOL_CLOSE}, which removes only an exited managed window.`,
  ],
  [TOOL_FORCE_CLOSE]: [
    `Call ${TOOL_FORCE_CLOSE} only after the user runs /session-manager on and when a live instance genuinely must be terminated and ordinary graceful control is unavailable or has failed. Never call ${TOOL_FORCE_CLOSE} merely to tidy a fleet or because an instance is slow.`,
  ],
};

/** Names of the three mutating tools that must execute sequentially. */
export const SEQUENTIAL_TOOLS: ReadonlySet<string> = new Set([
  TOOL_CREATE,
  TOOL_CLOSE,
  TOOL_FORCE_CLOSE,
]);

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_LIST,
    label: "Fleet list",
    description:
      "List managed Session Manager fleets and instances from the dedicated tmux server. Returns an empty inventory when the server is absent.",
    promptSnippet: `List managed fleets and instances (${TOOL_LIST})`,
    promptGuidelines: TOOL_GUIDELINES[TOOL_LIST],
    parameters: Type.Object({
      fleet: Type.Optional(
        Type.String({ description: "Optional fleet filter." }),
      ),
    }),
    async execute() {
      requireAuthorization();
      return notImplemented(TOOL_LIST);
    },
  });

  pi.registerTool({
    name: TOOL_VIEW,
    label: "Fleet view",
    description:
      "Return a bounded plain-text terminal view of one managed Pi instance without changing focus. Permitted on both running and exited panes.",
    promptSnippet: `View a bounded terminal capture of one managed instance (${TOOL_VIEW})`,
    promptGuidelines: TOOL_GUIDELINES[TOOL_VIEW],
    parameters: Type.Object({
      fleet: Type.String({ description: FLEET_DESCRIPTION }),
      instance: Type.Integer({ minimum: 1, description: INSTANCE_DESCRIPTION }),
      lines: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 500,
          description:
            "Lines of scrollback to capture. Defaults to 100; clamped to 500 and to the Pi output ceiling.",
        }),
      ),
    }),
    async execute() {
      requireAuthorization();
      return notImplemented(TOOL_VIEW);
    },
  });

  pi.registerTool({
    name: TOOL_CREATE,
    label: "Fleet create",
    description:
      "Create one normal interactive Pi instance as a managed tmux window in a fleet.",
    promptSnippet: `Create one managed Pi instance in a fleet (${TOOL_CREATE})`,
    promptGuidelines: TOOL_GUIDELINES[TOOL_CREATE],
    executionMode: "sequential",
    parameters: Type.Object({
      fleet: Type.String({
        pattern: FLEET_PATTERN,
        description: FLEET_DESCRIPTION,
      }),
      instance: Type.Integer({ minimum: 1, description: INSTANCE_DESCRIPTION }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the worker. Defaults to the Manager Pi cwd.",
        }),
      ),
      piArgs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Opaque Pi argument array passed through to the worker. Each item is one argument; never joined as shell syntax.",
        }),
      ),
    }),
    async execute() {
      requireAuthorization();
      return notImplemented(TOOL_CREATE);
    },
  });

  pi.registerTool({
    name: TOOL_CLOSE,
    label: "Fleet close",
    description:
      "Remove one exited managed instance window. Rejects a running pane and a viewed target.",
    promptSnippet: `Close one exited managed instance (${TOOL_CLOSE})`,
    promptGuidelines: TOOL_GUIDELINES[TOOL_CLOSE],
    executionMode: "sequential",
    parameters: Type.Object({
      fleet: Type.String({ description: FLEET_DESCRIPTION }),
      instance: Type.Integer({ minimum: 1, description: INSTANCE_DESCRIPTION }),
    }),
    async execute() {
      requireAuthorization();
      return notImplemented(TOOL_CLOSE);
    },
  });

  pi.registerTool({
    name: TOOL_FORCE_CLOSE,
    label: "Fleet force close",
    description:
      "Force-remove a live managed instance window, terminating its Pi process. Requires explicit confirmation.",
    promptSnippet: `Force-close a live managed instance, terminating its process (${TOOL_FORCE_CLOSE})`,
    promptGuidelines: TOOL_GUIDELINES[TOOL_FORCE_CLOSE],
    executionMode: "sequential",
    parameters: Type.Object({
      fleet: Type.String({ description: FLEET_DESCRIPTION }),
      instance: Type.Integer({ minimum: 1, description: INSTANCE_DESCRIPTION }),
      confirmProcessTermination: Type.Literal(true as const, {
        description: TOOL_TRUE_DESCRIPTION,
      }),
    }),
    async execute() {
      requireAuthorization();
      return notImplemented(TOOL_FORCE_CLOSE);
    },
  });
}

/** Placeholder failure thrown by authorized skeletons until later tasks. */
function notImplemented(toolName: string): never {
  throw new SessionManagerError(
    ErrorCode.NOT_IMPLEMENTED,
    `${toolName} is not implemented yet (planned for later Session Manager tasks).`,
  );
}
