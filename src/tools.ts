import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { requireAuthorization } from "./authorization.js";
import { ErrorCode, SessionManagerError } from "./errors.js";
import { TmuxAdapter } from "./tmux.js";
import type {
  CreatedTmuxInstance,
  CreatedWindowCleanup,
  ManagedInstance,
  TmuxInventory,
} from "./types.js";
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
 * Task 3 implements pi_fleet_create. The other four tools remain authorized
 * skeletons until their assigned tasks implement their tmux behavior.
 */

const FLEET_DESCRIPTION =
  "Managed fleet name. Conventionally <project>-<role>, treated as an opaque namespace. Must match [a-z0-9][a-z0-9_-]{0,63}.";
const INSTANCE_DESCRIPTION =
  "Positive safe integer instance number, equal to the tmux window index.";

export const MAX_PI_ARGS = 128;
export const MAX_PI_ARGS_BYTES = 64 * 1024;
const FLEET_NAME_RE = new RegExp(FLEET_PATTERN);
const DEFAULT_VIEW_LINES = 100;
const MAX_VIEW_LINES = 500;
// Reserve space for a clear truncation notice below Pi's 50 KiB output ceiling.
const MAX_VIEW_TEXT_BYTES = 48 * 1024;

export interface ListFleetInput {
  readonly fleet?: string;
}

export interface ViewFleetInput {
  readonly fleet: string;
  readonly instance: number;
  readonly lines?: number;
}

export interface CreateFleetInput {
  readonly fleet: string;
  readonly instance: number;
  readonly cwd?: string;
  readonly piArgs?: readonly string[];
}

export interface ValidatedCreateFleetInput {
  readonly fleet: string;
  readonly instance: number;
  readonly cwd: string;
  readonly piArgs: readonly string[];
}

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
/**
 * Shared guidance appended to every tool: how to react to a disabled result
 * (PLAN.md section 18). The bullet names the tool it refers to because Pi
 * appends guidelines flat with no tool-name prefix.
 */
function disabledGuidance(tool: string): string {
  return `If a ${tool} call reports Session Manager is disabled, do not retry ${tool} and do not attempt to enable it yourself; wait for the user to run /session-manager on.`;
}

export const TOOL_GUIDELINES: Record<
  (typeof SHARED_TOOL_NAMES)[number],
  string[]
> = {
  [TOOL_LIST]: [
    `Call ${TOOL_LIST} only after the user runs /session-manager on. ${TOOL_LIST} reports managed fleets and instances; it is observation, not task-completion evidence.`,
    disabledGuidance(TOOL_LIST),
  ],
  [TOOL_VIEW]: [
    `Call ${TOOL_VIEW} only after the user runs /session-manager on. Use ${TOOL_VIEW} for bounded terminal observation of one Pi instance, never as proof of task completion.`,
    disabledGuidance(TOOL_VIEW),
  ],
  [TOOL_CREATE]: [
    `Call ${TOOL_CREATE} only after the user runs /session-manager on. Use ${TOOL_CREATE} only to start normal interactive Pi TUI instances in the dedicated fleet.`,
    disabledGuidance(TOOL_CREATE),
  ],
  [TOOL_CLOSE]: [
    `Call ${TOOL_CLOSE} only after the user runs /session-manager on. End a worker Pi gracefully through the user or the appropriate control mechanism before calling ${TOOL_CLOSE}, which removes only an exited managed window.`,
    disabledGuidance(TOOL_CLOSE),
  ],
  [TOOL_FORCE_CLOSE]: [
    `Call ${TOOL_FORCE_CLOSE} only after the user runs /session-manager on and when a live instance genuinely must be terminated and ordinary graceful control is unavailable or has failed. Never call ${TOOL_FORCE_CLOSE} merely to tidy a fleet or because an instance is slow.`,
    disabledGuidance(TOOL_FORCE_CLOSE),
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
    async execute(_toolCallId, params, signal) {
      requireAuthorization();
      return listFleets(params, signal);
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
    async execute(_toolCallId, params, signal) {
      requireAuthorization();
      return viewFleet(params, signal);
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
            "Working directory for the worker. Defaults to the Manager Pi cwd and must resolve to an existing directory.",
        }),
      ),
      piArgs: Type.Optional(
        Type.Array(Type.String({ maxLength: 16_384 }), {
          maxItems: MAX_PI_ARGS,
          description:
            "Opaque Pi argument array passed directly to pi. At most 128 arguments and 64 KiB UTF-8 encoded size total; each item remains one argument and is never interpreted as shell syntax.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireAuthorization();
      return createFleetInstance(params, ctx, signal);
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

/** List exact V1-managed tmux objects, optionally for one validated fleet. */
export async function listFleets(
  input: ListFleetInput,
  signal?: AbortSignal,
  adapter = new TmuxAdapter(),
) {
  const fleet = validateOptionalFleet(input.fleet);
  const inventory = await adapter.inventory(signal);
  const fleets = fleet
    ? inventory.fleets.filter((candidate) => candidate.name === fleet)
    : inventory.fleets;
  const output = truncateHead(renderFleetList(inventory, fleets), {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES - 256,
  });
  const text = output.truncated
    ? `${output.content}\n\n[Fleet list truncated to the safe tool-output limit.]`
    : output.content;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      serverPresent: inventory.serverPresent,
      ...(fleet === undefined ? {} : { filter: fleet }),
      fleets,
      warningCount: inventory.warnings.length,
      warnings: inventory.warnings,
      outputTruncated: output.truncated,
    },
  };
}

/** Return a bounded observational terminal capture for one exact managed pane. */
export async function viewFleet(
  input: ViewFleetInput,
  signal?: AbortSignal,
  adapter = new TmuxAdapter(),
) {
  const fleet = validateRequiredFleet(input.fleet);
  const instance = validateInstance(input.instance);
  const lines = validateViewLines(input.lines);
  const inventory = await adapter.inventory(signal);
  const managed = inventory.fleets
    .find((candidate) => candidate.name === fleet)
    ?.instances.find((candidate) => candidate.instance === instance);
  if (!managed) {
    throwViewLookupError(inventory, fleet, instance);
  }

  const { instance: revalidated, capture } =
    await adapter.captureManagedInstance(managed, lines, signal);
  const output = truncateTail(capture.text, {
    maxLines: Math.min(lines, DEFAULT_MAX_LINES),
    maxBytes: Math.min(MAX_VIEW_TEXT_BYTES, DEFAULT_MAX_BYTES),
  });
  const truncated = capture.captureTruncated || output.truncated;
  let text = output.content || "(No terminal text captured.)";
  if (truncated) {
    text +=
      "\n\n[Terminal view truncated to the requested or safe output limit.]";
  }
  if (capture.usedPrimaryFallback) {
    text +=
      "\n\n[tmux returned an empty alternate-screen capture, so this view uses the bounded primary-screen fallback.]";
  } else if (revalidated.state === "exited" && !capture.alternateScreen) {
    text +=
      "\n\n[Captured the retained primary screen. A full-screen application's former alternate screen is unavailable after exit.]";
  }

  return {
    content: [{ type: "text" as const, text }],
    details: {
      ...revalidated,
      requestedLines: lines,
      capturedAlternateScreen: capture.alternateScreen,
      alternateScreenActive: capture.alternateScreenActive,
      usedPrimaryFallback: capture.usedPrimaryFallback,
      captureTruncated: capture.captureTruncated,
      outputTruncated: output.truncated,
    },
  };
}

function validateOptionalFleet(fleet: unknown): string | undefined {
  if (fleet === undefined) return undefined;
  return validateRequiredFleet(fleet);
}

function validateRequiredFleet(fleet: unknown): string {
  if (typeof fleet !== "string" || !FLEET_NAME_RE.test(fleet)) {
    throw new SessionManagerError(
      ErrorCode.INVALID_FLEET,
      "fleet must match [a-z0-9][a-z0-9_-]{0,63}.",
    );
  }
  return fleet;
}

function validateInstance(instance: unknown): number {
  if (!Number.isSafeInteger(instance) || (instance as number) < 1) {
    throw new SessionManagerError(
      ErrorCode.INVALID_INSTANCE,
      "instance must be a positive safe integer.",
    );
  }
  return instance as number;
}

function validateViewLines(lines: unknown): number {
  if (lines === undefined) return DEFAULT_VIEW_LINES;
  if (
    !Number.isSafeInteger(lines) ||
    (lines as number) < 1 ||
    (lines as number) > MAX_VIEW_LINES
  ) {
    throw new SessionManagerError(
      ErrorCode.CAPTURE_FAILED,
      `lines must be a positive safe integer from 1 to ${MAX_VIEW_LINES}.`,
    );
  }
  return lines as number;
}

function renderFleetList(
  inventory: TmuxInventory,
  fleets: readonly {
    readonly name: string;
    readonly instances: readonly ManagedInstance[];
  }[],
): string {
  const lines: string[] = [];
  if (!inventory.serverPresent) {
    lines.push("No managed fleets: the dedicated tmux server is absent.");
  } else if (fleets.length === 0) {
    lines.push("No managed fleets found.");
  } else {
    for (const fleet of fleets) {
      const instances = fleet.instances
        .map((instance) => `${instance.instance} ${instance.state}`)
        .join(", ");
      lines.push(`${fleet.name}: ${instances || "no managed instances"}`);
    }
  }
  if (inventory.warnings.length > 0) {
    lines.push(
      `Warnings (${inventory.warnings.length}): managed-looking tmux objects require manual handling.`,
    );
  }
  return lines.join("\n");
}

function throwViewLookupError(
  inventory: TmuxInventory,
  fleet: string,
  instance: number,
): never {
  if (
    !inventory.serverPresent ||
    !inventory.fleets.some((candidate) => candidate.name === fleet)
  ) {
    const warning = inventory.warnings.find(
      (candidate) =>
        candidate.sessionName === fleet &&
        (candidate.windowIndex === undefined ||
          candidate.windowIndex === instance),
    );
    if (warning?.code === "AMBIGUOUS_WINDOW") {
      throw new SessionManagerError(
        ErrorCode.AMBIGUOUS_WINDOW,
        `Fleet ${fleet} instance ${instance} is structurally ambiguous and cannot be viewed.`,
      );
    }
    if (warning?.code === "UNSUPPORTED_TAG_VERSION") {
      throw new SessionManagerError(
        ErrorCode.UNSUPPORTED_TAG_VERSION,
        `Fleet ${fleet} is not an exact V1-managed fleet.`,
      );
    }
    if (warning) {
      throw new SessionManagerError(
        ErrorCode.UNMANAGED_TARGET,
        `Fleet ${fleet} instance ${instance} is not an exact V1-managed target.`,
      );
    }
    throw new SessionManagerError(
      ErrorCode.FLEET_NOT_FOUND,
      `Managed fleet ${fleet} was not found.`,
    );
  }

  const warning = inventory.warnings.find(
    (candidate) =>
      candidate.sessionName === fleet && candidate.windowIndex === instance,
  );
  if (warning?.code === "AMBIGUOUS_WINDOW") {
    throw new SessionManagerError(
      ErrorCode.AMBIGUOUS_WINDOW,
      `Fleet ${fleet} instance ${instance} is structurally ambiguous and cannot be viewed.`,
    );
  }
  if (warning) {
    throw new SessionManagerError(
      warning.code === "UNSUPPORTED_TAG_VERSION"
        ? ErrorCode.UNSUPPORTED_TAG_VERSION
        : ErrorCode.UNMANAGED_TARGET,
      `Fleet ${fleet} instance ${instance} is not an exact V1-managed target.`,
    );
  }
  throw new SessionManagerError(
    ErrorCode.INSTANCE_NOT_FOUND,
    `Managed instance ${instance} was not found in fleet ${fleet}.`,
  );
}

export async function validateCreateFleetInput(
  input: CreateFleetInput,
  managerCwd: string,
): Promise<ValidatedCreateFleetInput> {
  if (typeof input.fleet !== "string" || !FLEET_NAME_RE.test(input.fleet)) {
    throw new SessionManagerError(
      ErrorCode.INVALID_FLEET,
      "fleet must match [a-z0-9][a-z0-9_-]{0,63}.",
    );
  }
  if (!Number.isSafeInteger(input.instance) || input.instance < 1) {
    throw new SessionManagerError(
      ErrorCode.INVALID_INSTANCE,
      "instance must be a positive safe integer.",
    );
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") {
    throw new SessionManagerError(
      ErrorCode.INVALID_CWD,
      "cwd must be a path string when provided.",
    );
  }
  const cwd = resolve(managerCwd, input.cwd ?? managerCwd);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new SessionManagerError(
      ErrorCode.INVALID_CWD,
      `cwd must resolve to an existing directory: ${cwd}.`,
    );
  }

  const piArgs = input.piArgs ?? [];
  if (!Array.isArray(piArgs) || piArgs.length > MAX_PI_ARGS) {
    throw new SessionManagerError(
      ErrorCode.INVALID_PI_ARGS,
      `piArgs may contain at most ${MAX_PI_ARGS} arguments.`,
    );
  }
  let encodedBytes = 0;
  for (const argument of piArgs) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new SessionManagerError(
        ErrorCode.INVALID_PI_ARGS,
        "piArgs must contain plain string arguments without NUL characters.",
      );
    }
    encodedBytes += Buffer.byteLength(argument, "utf8") + 1;
  }
  if (encodedBytes > MAX_PI_ARGS_BYTES) {
    throw new SessionManagerError(
      ErrorCode.INVALID_PI_ARGS,
      `piArgs UTF-8 encoded size must not exceed ${MAX_PI_ARGS_BYTES} bytes.`,
    );
  }
  return { fleet: input.fleet, instance: input.instance, cwd, piArgs };
}

export async function createFleetInstance(
  input: CreateFleetInput,
  ctx: Pick<ExtensionContext, "cwd">,
  signal?: AbortSignal,
  adapter = new TmuxAdapter(),
) {
  const validated = await validateCreateFleetInput(input, ctx.cwd);
  await adapter.getVersion(signal);
  await adapter.ensureStateDirectory();

  const inspection = await adapter.inspectFleet(validated.fleet, signal);
  const initializeServer = !inspection.serverPresent;
  let existingSessionId: string | undefined;
  if (initializeServer && validated.instance !== 1) {
    throw new SessionManagerError(
      ErrorCode.INVALID_INSTANCE,
      "A new fleet must begin with instance 1.",
    );
  }

  if (inspection.fleet) {
    switch (inspection.fleet.ownership.kind) {
      case "managed":
        existingSessionId = inspection.fleet.sessionId;
        break;
      case "unsupported-version":
        throw new SessionManagerError(
          ErrorCode.UNSUPPORTED_TAG_VERSION,
          "The same-named tmux fleet has an unsupported Session Manager tag version and will not be adopted.",
        );
      case "unmanaged":
      case "malformed":
        throw new SessionManagerError(
          ErrorCode.FLEET_COLLISION,
          "The same-named tmux fleet is not an exact V1-managed fleet and will not be adopted.",
        );
    }
  } else if (validated.instance !== 1) {
    throw new SessionManagerError(
      ErrorCode.INVALID_INSTANCE,
      "A new fleet must begin with instance 1.",
    );
  }

  if (
    inspection.windows.some((window) => window.index === validated.instance)
  ) {
    throw new SessionManagerError(
      ErrorCode.INSTANCE_COLLISION,
      `Fleet ${validated.fleet} already has a window at instance ${validated.instance}.`,
    );
  }

  if (!initializeServer) {
    await adapter.ensureCriticalOptions(signal);
    const revalidated = await adapter.inspectFleet(validated.fleet, signal);
    if (existingSessionId) {
      if (
        !revalidated.fleet ||
        revalidated.fleet.sessionId !== existingSessionId ||
        revalidated.fleet.ownership.kind !== "managed"
      ) {
        throw new SessionManagerError(
          ErrorCode.IDENTITY_CHANGED,
          "Fleet identity or ownership changed before creating the Pi instance.",
        );
      }
    } else if (revalidated.fleet) {
      throw new SessionManagerError(
        ErrorCode.FLEET_COLLISION,
        `Fleet ${validated.fleet} appeared during creation and will not be adopted.`,
      );
    }
    if (
      revalidated.windows.some((window) => window.index === validated.instance)
    ) {
      throw new SessionManagerError(
        ErrorCode.INSTANCE_COLLISION,
        `Fleet ${validated.fleet} already has a window at instance ${validated.instance}.`,
      );
    }
  }

  let created: CreatedTmuxInstance;
  try {
    created = await adapter.createDetachedInstance(
      validated.fleet,
      validated.instance,
      validated.cwd,
      validated.piArgs,
      existingSessionId,
      initializeServer,
      signal,
    );
  } catch (error) {
    if (
      error instanceof SessionManagerError &&
      error.code === ErrorCode.TMUX_SERVER_ERROR
    ) {
      const after = await adapter.inspectFleet(validated.fleet, signal);
      if (after.windows.some((window) => window.index === validated.instance)) {
        throw new SessionManagerError(
          ErrorCode.INSTANCE_COLLISION,
          `Fleet ${validated.fleet} already has a window at instance ${validated.instance}.`,
        );
      }
      if (!existingSessionId && after.fleet) {
        throw new SessionManagerError(
          ErrorCode.FLEET_COLLISION,
          `Fleet ${validated.fleet} appeared during creation and will not be adopted.`,
        );
      }
    }
    throw error;
  }

  try {
    if (existingSessionId) {
      const revalidated = await adapter.inspectFleet(validated.fleet, signal);
      if (
        !revalidated.fleet ||
        revalidated.fleet.sessionId !== existingSessionId ||
        revalidated.fleet.ownership.kind !== "managed"
      ) {
        throw new SessionManagerError(
          ErrorCode.IDENTITY_CHANGED,
          "Fleet identity or ownership changed before tagging the Pi instance.",
        );
      }
    }
    await adapter.tagCreatedInstance(
      created,
      validated.fleet,
      validated.instance,
      signal,
    );
    const instance = await adapter.validateCreatedInstance(
      created,
      validated.fleet,
      validated.instance,
      signal,
    );
    return createResult(instance, validated.cwd);
  } catch (error) {
    const cleanup = await adapter.cleanupCreatedInstance(created);
    throw new SessionManagerError(
      ErrorCode.CREATE_PARTIAL_FAILURE,
      partialCreateMessage(created.windowId, error, cleanup),
    );
  }
}

function createResult(instance: ManagedInstance, cwd: string) {
  const exit =
    instance.state === "exited"
      ? ` (exited${instance.exitStatus === undefined ? "" : ` with status ${instance.exitStatus}`})`
      : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Created ${instance.fleet} instance ${instance.instance}${exit}.`,
      },
    ],
    details: { ...instance, cwd },
  };
}

function partialCreateMessage(
  windowId: string,
  error: unknown,
  cleanup: CreatedWindowCleanup,
): string {
  const cause =
    error instanceof Error
      ? error.message
      : "unknown tagging or validation failure";
  switch (cleanup.outcome) {
    case "removed":
    case "already-absent":
      return `Created tmux window ${windowId} could not be tagged or validated (${cause}); cleanup ${cleanup.outcome}.`;
    case "viewed-by-user":
      return `Created unmanaged tmux window ${windowId} could not be tagged or validated (${cause}); it was not removed because a human is viewing it.`;
    case "identity-changed":
      return `Created unmanaged tmux window ${windowId} could not be tagged or validated (${cause}); it was not removed because its identity changed.`;
    case "failed":
      return `Created unmanaged tmux window ${windowId} could not be tagged or validated (${cause}); cleanup failed: ${cleanup.message}.`;
  }
}

/** Placeholder failure thrown by authorized skeletons until later tasks. */
function notImplemented(toolName: string): never {
  throw new SessionManagerError(
    ErrorCode.NOT_IMPLEMENTED,
    `${toolName} is not implemented yet (planned for later Session Manager tasks).`,
  );
}
