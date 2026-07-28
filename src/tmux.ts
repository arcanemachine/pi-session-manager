import { access, chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";

import { FLEET_PATTERN } from "./constants.js";
import { ErrorCode, SessionManagerError } from "./errors.js";
import type {
  FleetOwnership,
  InventoryWarning,
  InventoryWarningCode,
  ManagedFleet,
  ManagedInstance,
  SessionManagerPaths,
  TmuxClient,
  TmuxInventory,
  TmuxVersion,
  WindowOwnership,
} from "./types.js";

export const FLEET_VERSION_TAG = "@pi-session-manager-fleet-version";
export const WINDOW_VERSION_TAG = "@pi-session-manager-window-version";
export const INSTANCE_TAG = "@pi-session-manager-instance";
export const PANE_ID_TAG = "@pi-session-manager-pane-id";
export const V1_TAG_VALUE = "v1";

const SESSION_FORMAT = `#{session_id}\t#{session_name}\t#{${FLEET_VERSION_TAG}}`;
const WINDOW_FORMAT = `#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active_clients}\t#{${WINDOW_VERSION_TAG}}\t#{${INSTANCE_TAG}}\t#{${PANE_ID_TAG}}`;
const PANE_FORMAT =
  "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_dead_time}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}";
const CLIENT_FORMAT = "#{client_name}\t#{client_session}";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const SESSION_ID_PATTERN = /^\$\d+$/;
const WINDOW_ID_PATTERN = /^@\d+$/;
const PANE_ID_PATTERN = /^%\d+$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;
const FLEET_NAME_PATTERN = new RegExp(FLEET_PATTERN);
const SESSION_METADATA_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputExceeded: boolean;
}

export interface TmuxAdapterOptions {
  readonly agentDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly tmuxPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface SessionRow {
  readonly id: string;
  readonly name: string;
  readonly fleetVersion: string;
}

interface WindowRow {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly paneCount: number;
  readonly activeViewerCount: number;
  readonly version: string;
  readonly instance: string;
  readonly paneId: string;
}

interface PaneRow {
  readonly sessionId: string;
  readonly windowId: string;
  readonly id: string;
  readonly dead: boolean;
  readonly deadStatus?: number;
  readonly deadSignal?: number;
  readonly deadTime?: number;
  readonly pid?: number;
  readonly currentCommand?: string;
  readonly currentPath?: string;
}

/** Resolve Pi's configured agent directory and this package's fixed socket path. */
export function resolveSessionManagerPaths(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): SessionManagerPaths {
  const configured = environment.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured || join(homeDirectory, ".pi", "agent");
  const stateDir = join(agentDir, "pi-session-manager");
  return { agentDir, stateDir, socketPath: join(stateDir, "tmux.sock") };
}

/** Preserve normal child configuration while dropping only stale parent session metadata. */
export function sanitizeChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const key of SESSION_METADATA_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

/** Parse tmux -V output, including release suffixes such as 3.5a. */
export function parseTmuxVersion(output: string): TmuxVersion {
  const raw = output.trim();
  const match = /^tmux\s+(\d+)\.(\d+)([a-z]*)$/i.exec(raw);
  if (!match) {
    throw new SessionManagerError(
      ErrorCode.TMUX_VERSION_UNSUPPORTED,
      `Unable to parse tmux version output: ${JSON.stringify(raw)}. tmux 3.5 or newer is required.`,
    );
  }

  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    suffix: match[3].toLowerCase(),
  };
}

export function supportsTmuxV35(version: TmuxVersion): boolean {
  return version.major > 3 || (version.major === 3 && version.minor >= 5);
}

export function classifyFleetOwnership(
  fleetName: string,
  version: string,
): FleetOwnership {
  if (version === "") return { kind: "unmanaged" };
  if (version !== V1_TAG_VALUE) {
    return {
      kind: "unsupported-version",
      reason: `fleet tag version ${JSON.stringify(version)} is not ${V1_TAG_VALUE}`,
    };
  }
  if (!FLEET_NAME_PATTERN.test(fleetName)) {
    return {
      kind: "malformed",
      reason: `fleet name ${JSON.stringify(fleetName)} is invalid`,
    };
  }
  return { kind: "managed" };
}

export function classifyWindowOwnership(
  version: string,
  instance: string,
  paneId: string,
): WindowOwnership {
  if (version === "" && instance === "" && paneId === "") {
    return { kind: "unmanaged" };
  }
  if (version !== V1_TAG_VALUE) {
    return {
      kind: "unsupported-version",
      reason: `window tag version ${JSON.stringify(version)} is not ${V1_TAG_VALUE}`,
    };
  }
  if (instance === "" || paneId === "") {
    return { kind: "partial", reason: "window V1 tags are incomplete" };
  }
  if (!POSITIVE_INTEGER_PATTERN.test(instance)) {
    return {
      kind: "malformed",
      reason: `window instance ${JSON.stringify(instance)} is not a positive decimal integer`,
    };
  }
  if (!PANE_ID_PATTERN.test(paneId)) {
    return {
      kind: "malformed",
      reason: `window pane ID ${JSON.stringify(paneId)} is invalid`,
    };
  }

  return { kind: "managed", instance: Number(instance), paneId };
}

/** Render a POSIX shell command for a human to attach to the dedicated server. */
export function renderAttachmentCommand(
  socketPath: string,
  fleet: string,
): string {
  return `tmux -S ${shellQuote(socketPath)} attach -t ${shellQuote(fleet)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The Task 2 tmux boundary. It never invokes a server command without the
 * package's explicit socket path, never uses a shell, and emits typed snapshots.
 */
export class TmuxAdapter {
  readonly paths: SessionManagerPaths;
  readonly environment: NodeJS.ProcessEnv;

  private readonly configuredTmuxPath?: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private executable?: string;

  constructor(options: TmuxAdapterOptions = {}) {
    const pathEnvironment = options.agentDir
      ? { ...options.environment, PI_CODING_AGENT_DIR: options.agentDir }
      : options.environment;
    this.paths = resolveSessionManagerPaths(pathEnvironment);
    this.environment = sanitizeChildEnvironment(options.environment);
    this.configuredTmuxPath = options.tmuxPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /** Create the owner-only package state directory without storing authorization there. */
  async ensureStateDirectory(): Promise<SessionManagerPaths> {
    await mkdir(this.paths.stateDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(this.paths.stateDir, 0o700);
    }
    return this.paths;
  }

  async getVersion(signal?: AbortSignal): Promise<TmuxVersion> {
    const executable = await this.resolveExecutable();
    const result = await runProcess(executable, ["-V"], {
      environment: this.environment,
      signal,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    this.throwForProcessFailure(result, "checking tmux version");
    const version = parseTmuxVersion(result.stdout);
    if (!supportsTmuxV35(version)) {
      throw new SessionManagerError(
        ErrorCode.TMUX_VERSION_UNSUPPORTED,
        `tmux ${version.raw} is unsupported. tmux 3.5 or newer is required.`,
      );
    }
    return version;
  }

  /** Apply only manager-critical defaults to an already-running dedicated server. */
  async ensureCriticalOptions(signal?: AbortSignal): Promise<void> {
    await this.runServerCommand(
      ["set-option", "-g", "base-index", "1"],
      signal,
    );
    await this.runServerCommand(
      ["set-option", "-g", "renumber-windows", "off"],
      signal,
    );
    await this.runServerCommand(
      ["set-window-option", "-g", "remain-on-exit", "on"],
      signal,
    );
    await this.runServerCommand(
      ["set-option", "-s", "extended-keys", "on"],
      signal,
    );
    await this.runServerCommand(
      ["set-option", "-s", "extended-keys-format", "csi-u"],
      signal,
    );
  }

  /** Disable automatic renaming on one already-identified managed window. */
  async disableAutomaticRename(
    windowId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!WINDOW_ID_PATTERN.test(windowId)) {
      throw new SessionManagerError(
        ErrorCode.TMUX_SERVER_ERROR,
        `Refusing to set a window option for invalid stable window ID ${JSON.stringify(windowId)}.`,
      );
    }
    await this.runServerCommand(
      ["set-window-option", "-t", windowId, "automatic-rename", "off"],
      signal,
    );
  }

  /** Return the complete typed managed inventory, or an empty inventory when the server is absent. */
  async inventory(signal?: AbortSignal): Promise<TmuxInventory> {
    const sessionResult = await this.runServerCommandRaw(
      ["list-sessions", "-F", SESSION_FORMAT],
      signal,
    );
    if (await this.isServerAbsent(sessionResult)) {
      return { serverPresent: false, fleets: [], warnings: [], clients: [] };
    }
    this.throwForProcessFailure(sessionResult, "listing tmux sessions");

    const sessions = parseSessions(sessionResult.stdout);
    const [windowResult, paneResult, clientResult] = await Promise.all([
      this.runServerCommandRaw(
        ["list-windows", "-a", "-F", WINDOW_FORMAT],
        signal,
      ),
      this.runServerCommandRaw(["list-panes", "-a", "-F", PANE_FORMAT], signal),
      this.runServerCommandRaw(["list-clients", "-F", CLIENT_FORMAT], signal),
    ]);
    this.throwForProcessFailure(windowResult, "listing tmux windows");
    this.throwForProcessFailure(paneResult, "listing tmux panes");
    this.throwForProcessFailure(clientResult, "listing tmux clients");

    return buildInventory(
      this.paths.socketPath,
      sessions,
      parseWindows(windowResult.stdout),
      parsePanes(paneResult.stdout),
      parseClients(clientResult.stdout),
    );
  }

  private async runServerCommand(
    args: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.runServerCommandRaw(args, signal);
    this.throwForProcessFailure(result, `running tmux ${args[0]}`);
  }

  private async runServerCommandRaw(
    args: string[],
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const executable = await this.resolveExecutable();
    return runProcess(executable, ["-S", this.paths.socketPath, ...args], {
      environment: this.environment,
      signal,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  private async resolveExecutable(): Promise<string> {
    if (this.executable) return this.executable;
    const candidate = this.configuredTmuxPath ?? "tmux";
    const executable = await resolveExecutable(
      candidate,
      this.environment.PATH,
    );
    if (!executable) {
      throw new SessionManagerError(
        ErrorCode.TMUX_NOT_FOUND,
        "tmux was not found on PATH. Install tmux 3.5 or newer and retry.",
      );
    }
    this.executable = executable;
    return executable;
  }

  private async isServerAbsent(result: ProcessResult): Promise<boolean> {
    if (result.exitCode === 0) return false;
    const output = `${result.stderr}\n${result.stdout}`;
    if (/no server running on\b/i.test(output)) return true;
    try {
      await stat(this.paths.socketPath);
      return false;
    } catch (error: unknown) {
      return isMissingPath(error);
    }
  }

  private throwForProcessFailure(result: ProcessResult, action: string): void {
    if (result.cancelled) {
      throw new SessionManagerError(
        ErrorCode.TMUX_SERVER_ERROR,
        `tmux command cancelled while ${action}.`,
      );
    }
    if (result.timedOut) {
      throw new SessionManagerError(
        ErrorCode.TMUX_SERVER_ERROR,
        `tmux command timed out while ${action}.`,
      );
    }
    if (result.outputExceeded) {
      throw new SessionManagerError(
        ErrorCode.TMUX_SERVER_ERROR,
        `tmux command produced too much output while ${action}.`,
      );
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const detail = stderr ? ` ${truncateDiagnostic(stderr)}` : "";
      throw new SessionManagerError(
        ErrorCode.TMUX_SERVER_ERROR,
        `tmux failed while ${action}.${detail}`,
        stderr || undefined,
      );
    }
  }
}

function buildInventory(
  socketPath: string,
  sessions: readonly SessionRow[],
  windows: readonly WindowRow[],
  panes: readonly PaneRow[],
  clients: readonly TmuxClient[],
): TmuxInventory {
  const warnings: InventoryWarning[] = [];
  const managedSessions = new Map<string, SessionRow>();
  for (const session of sessions) {
    const ownership = classifyFleetOwnership(
      session.name,
      session.fleetVersion,
    );
    if (ownership.kind === "managed") {
      managedSessions.set(session.id, session);
    } else if (ownership.kind !== "unmanaged") {
      warnings.push(sessionWarning(session, ownership.kind, ownership.reason));
    }
  }

  const panesByWindow = new Map<string, PaneRow[]>();
  for (const pane of panes) {
    const existing = panesByWindow.get(pane.windowId) ?? [];
    if (!existing.some((candidate) => candidate.id === pane.id)) {
      existing.push(pane);
    }
    panesByWindow.set(pane.windowId, existing);
  }

  const sessionIdsByWindow = new Map<string, Set<string>>();
  for (const window of windows) {
    const ids = sessionIdsByWindow.get(window.id) ?? new Set<string>();
    ids.add(window.sessionId);
    sessionIdsByWindow.set(window.id, ids);
  }

  const instancesBySession = new Map<string, ManagedInstance[]>();
  for (const window of windows) {
    const session = managedSessions.get(window.sessionId);
    const ownership = classifyWindowOwnership(
      window.version,
      window.instance,
      window.paneId,
    );
    if (!session) {
      if (ownership.kind !== "unmanaged") {
        warnings.push({
          code: "WINDOW_OUTSIDE_MANAGED_FLEET",
          message: "Tagged window is not in an exact V1-managed fleet.",
          sessionId: window.sessionId,
          sessionName: window.sessionName,
          windowId: window.id,
          windowIndex: window.index,
        });
      }
      continue;
    }
    if (ownership.kind === "unmanaged") continue;
    if (ownership.kind !== "managed") {
      warnings.push(windowWarning(window, ownership.kind, ownership.reason));
      continue;
    }
    if (ownership.instance !== window.index) {
      warnings.push(
        windowWarning(
          window,
          "malformed",
          "stored instance does not equal the tmux window index",
        ),
      );
      continue;
    }
    if (window.name !== `${session.name}-${ownership.instance}`) {
      warnings.push(
        windowWarning(
          window,
          "malformed",
          "window name does not match the required fleet-instance name",
        ),
      );
      continue;
    }
    if (sessionIdsByWindow.get(window.id)?.size !== 1) {
      warnings.push(
        windowWarning(
          window,
          "ambiguous-window",
          "window is linked to more than one tmux session",
        ),
      );
      continue;
    }
    const windowPanes = panesByWindow.get(window.id) ?? [];
    if (window.paneCount !== 1 || windowPanes.length !== 1) {
      warnings.push(
        windowWarning(
          window,
          "ambiguous-window",
          "managed windows must contain exactly one pane",
        ),
      );
      continue;
    }
    const pane = windowPanes[0];
    if (pane.id !== ownership.paneId) {
      warnings.push(
        windowWarning(
          window,
          "ambiguous-window",
          "stored pane ID does not match the sole current pane",
        ),
      );
      continue;
    }
    const instance: ManagedInstance = {
      fleet: session.name,
      instance: ownership.instance,
      sessionId: session.id,
      windowId: window.id,
      paneId: pane.id,
      windowIndex: window.index,
      windowName: window.name,
      state: pane.dead ? "exited" : "running",
      ...(pane.pid === undefined ? {} : { pid: pane.pid }),
      ...(pane.currentCommand === undefined
        ? {}
        : { currentCommand: pane.currentCommand }),
      ...(pane.currentPath === undefined
        ? {}
        : { currentPath: pane.currentPath }),
      ...(pane.deadStatus === undefined ? {} : { exitStatus: pane.deadStatus }),
      ...(pane.deadSignal === undefined ? {} : { exitSignal: pane.deadSignal }),
      ...(pane.deadTime === undefined ? {} : { exitTime: pane.deadTime }),
      activeViewerCount: window.activeViewerCount,
      viewedByUser: window.activeViewerCount > 0,
      attachmentCommand: renderAttachmentCommand(socketPath, session.name),
    };
    const instances = instancesBySession.get(session.id) ?? [];
    instances.push(instance);
    instancesBySession.set(session.id, instances);
  }

  const fleets: ManagedFleet[] = [];
  for (const session of managedSessions.values()) {
    const instances = instancesBySession.get(session.id) ?? [];
    const duplicateInstances = new Set<number>();
    const seenInstances = new Set<number>();
    for (const instance of instances) {
      if (seenInstances.has(instance.instance))
        duplicateInstances.add(instance.instance);
      seenInstances.add(instance.instance);
    }
    const safeInstances = instances.filter((instance) => {
      if (!duplicateInstances.has(instance.instance)) return true;
      warnings.push({
        code: "CONTRADICTORY_IDENTITY",
        message: "Multiple managed candidates share one fleet instance number.",
        sessionId: session.id,
        sessionName: session.name,
        windowId: instance.windowId,
        windowIndex: instance.windowIndex,
      });
      return false;
    });
    fleets.push({
      name: session.name,
      sessionId: session.id,
      attachmentCommand: renderAttachmentCommand(socketPath, session.name),
      instances: safeInstances.sort((a, b) => a.instance - b.instance),
    });
  }

  return {
    serverPresent: true,
    fleets: fleets.sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
    clients,
  };
}

function sessionWarning(
  session: SessionRow,
  kind: Exclude<FleetOwnership["kind"], "managed" | "unmanaged">,
  reason: string,
): InventoryWarning {
  return {
    code: ownershipWarningCode(kind),
    message: `Unmanaged fleet session: ${reason}.`,
    sessionId: session.id,
    sessionName: session.name,
  };
}

function windowWarning(
  window: WindowRow,
  kind:
    | Exclude<WindowOwnership["kind"], "managed" | "unmanaged">
    | "ambiguous-window",
  reason: string,
): InventoryWarning {
  return {
    code: ownershipWarningCode(kind),
    message: `Unmanaged window: ${reason}.`,
    sessionId: window.sessionId,
    sessionName: window.sessionName,
    windowId: window.id,
    windowIndex: window.index,
  };
}

function ownershipWarningCode(kind: string): InventoryWarningCode {
  switch (kind) {
    case "partial":
      return "PARTIAL_TAG";
    case "unsupported-version":
      return "UNSUPPORTED_TAG_VERSION";
    case "ambiguous-window":
      return "AMBIGUOUS_WINDOW";
    case "malformed":
    default:
      return "MALFORMED_TAG";
  }
}

function parseSessions(output: string): SessionRow[] {
  return parseRecords(output, 3, "sessions").map((fields) => {
    const [id, name, fleetVersion] = fields;
    requireId(id, SESSION_ID_PATTERN, "session ID");
    return { id, name, fleetVersion };
  });
}

function parseWindows(output: string): WindowRow[] {
  return parseRecords(output, 10, "windows").map((fields) => {
    const [
      sessionId,
      sessionName,
      id,
      index,
      name,
      paneCount,
      activeViewerCount,
      version,
      instance,
      paneId,
    ] = fields;
    requireId(sessionId, SESSION_ID_PATTERN, "window session ID");
    requireId(id, WINDOW_ID_PATTERN, "window ID");
    return {
      sessionId,
      sessionName,
      id,
      index: parseNonNegativeInteger(index, "window index"),
      name,
      paneCount: parseNonNegativeInteger(paneCount, "window pane count"),
      activeViewerCount: parseNonNegativeInteger(
        activeViewerCount,
        "window active-viewer count",
      ),
      version,
      instance,
      paneId,
    };
  });
}

function parsePanes(output: string): PaneRow[] {
  return parseRecords(output, 10, "panes").map((fields) => {
    const [
      sessionId,
      windowId,
      id,
      dead,
      deadStatus,
      deadSignal,
      deadTime,
      pid,
      currentCommand,
      currentPath,
    ] = fields;
    requireId(sessionId, SESSION_ID_PATTERN, "pane session ID");
    requireId(windowId, WINDOW_ID_PATTERN, "pane window ID");
    requireId(id, PANE_ID_PATTERN, "pane ID");
    if (dead !== "0" && dead !== "1") {
      throw malformedOutput(
        `pane dead state ${JSON.stringify(dead)} is invalid`,
      );
    }
    return {
      sessionId,
      windowId,
      id,
      dead: dead === "1",
      ...(optionalNonNegativeInteger(deadStatus, "pane exit status") ===
      undefined
        ? {}
        : {
            deadStatus: optionalNonNegativeInteger(
              deadStatus,
              "pane exit status",
            ),
          }),
      ...(optionalNonNegativeInteger(deadSignal, "pane exit signal") ===
      undefined
        ? {}
        : {
            deadSignal: optionalNonNegativeInteger(
              deadSignal,
              "pane exit signal",
            ),
          }),
      ...(optionalNonNegativeInteger(deadTime, "pane exit time") === undefined
        ? {}
        : { deadTime: optionalNonNegativeInteger(deadTime, "pane exit time") }),
      ...(optionalPositiveInteger(pid, "pane PID") === undefined
        ? {}
        : { pid: optionalPositiveInteger(pid, "pane PID") }),
      ...(currentCommand === "" ? {} : { currentCommand }),
      ...(currentPath === "" ? {} : { currentPath }),
    };
  });
}

function parseClients(output: string): TmuxClient[] {
  return parseRecords(output, 2, "clients").map(([name, sessionName]) => ({
    name,
    sessionName,
  }));
}

function parseRecords(
  output: string,
  fieldCount: number,
  label: string,
): string[][] {
  if (output === "") return [];
  const lines = output.endsWith("\n")
    ? output.slice(0, -1).split("\n")
    : output.split("\n");
  return lines.map((line, index) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    const fields = normalized.split("\t");
    if (fields.length !== fieldCount) {
      throw malformedOutput(
        `${label} record ${index + 1} has ${fields.length} fields; expected ${fieldCount}`,
      );
    }
    return fields;
  });
}

function requireId(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw malformedOutput(`${label} ${JSON.stringify(value)} is invalid`);
  }
}

function parseNonNegativeInteger(value: string, label: string): number {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    throw malformedOutput(`${label} ${JSON.stringify(value)} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw malformedOutput(
      `${label} ${JSON.stringify(value)} is outside safe integer range`,
    );
  }
  return parsed;
}

function optionalNonNegativeInteger(
  value: string,
  label: string,
): number | undefined {
  return value === "" ? undefined : parseNonNegativeInteger(value, label);
}

function optionalPositiveInteger(
  value: string,
  label: string,
): number | undefined {
  if (value === "") return undefined;
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw malformedOutput(`${label} ${JSON.stringify(value)} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw malformedOutput(
      `${label} ${JSON.stringify(value)} is outside safe integer range`,
    );
  }
  return parsed;
}

function malformedOutput(message: string): SessionManagerError {
  return new SessionManagerError(
    ErrorCode.TMUX_SERVER_ERROR,
    `tmux returned malformed inventory output: ${message}.`,
  );
}

async function resolveExecutable(
  candidate: string,
  pathValue: string | undefined,
): Promise<string | undefined> {
  const candidates =
    isAbsolute(candidate) || candidate.includes("/")
      ? [candidate]
      : (pathValue ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, candidate));
  for (const path of candidates) {
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {
      // Continue through PATH candidates.
    }
  }
  return undefined;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function truncateDiagnostic(stderr: string): string {
  const bounded = stderr.slice(0, 1_000);
  return bounded === stderr ? bounded : `${bounded}…`;
}

interface RunProcessOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

function runProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: true,
        outputExceeded: false,
      });
      return;
    }

    let child;
    try {
      child = spawn(executable, args, {
        env: options.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(processSpawnError(error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let outputExceeded = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const terminate = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 250);
      forceKillTimer.unref();
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const append = (current: string, chunk: Buffer): string => {
      const remaining = options.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        outputExceeded = true;
        terminate();
        return current;
      }
      const kept = chunk.subarray(0, remaining);
      outputBytes += kept.length;
      if (kept.length < chunk.length) {
        outputExceeded = true;
        terminate();
      }
      return current + kept.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(processSpawnError(error));
    });
    child.once("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled,
        outputExceeded,
      });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function processSpawnError(error: unknown): SessionManagerError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "ENOENT") {
    return new SessionManagerError(
      ErrorCode.TMUX_NOT_FOUND,
      "tmux was not found on PATH. Install tmux 3.5 or newer and retry.",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SessionManagerError(
    ErrorCode.TMUX_SERVER_ERROR,
    `Unable to start tmux: ${message}`,
  );
}
