import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode } from "../src/errors.js";
import {
  FLEET_VERSION_TAG,
  INSTANCE_TAG,
  PANE_ID_TAG,
  TmuxAdapter,
  V1_TAG_VALUE,
  WINDOW_VERSION_TAG,
  classifyFleetOwnership,
  classifyWindowOwnership,
  parseTmuxVersion,
  renderAttachmentCommand,
  resolveSessionManagerPaths,
  sanitizeChildEnvironment,
  supportsTmuxV35,
} from "../src/tmux.js";

const execFile = promisify(execFileCallback);
const tmuxPath = "/usr/bin/tmux";

interface Fixture {
  readonly directory: string;
  readonly socket: string;
  readonly agentDir: string;
  readonly clients: Set<ReturnType<typeof spawn>>;
}

let fixture: Fixture | undefined;

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-manager-test-"));
  const agentDir = join(directory, "agent");
  await mkdir(join(agentDir, "pi-session-manager"), {
    recursive: true,
    mode: 0o700,
  });
  return {
    directory,
    socket: join(agentDir, "pi-session-manager", "tmux.sock"),
    agentDir,
    clients: new Set(),
  };
}

async function tmux(
  args: readonly string[],
  allowFailure = false,
): Promise<string> {
  if (!fixture) throw new Error("fixture is not initialized");
  try {
    const result = await execFile(tmuxPath, ["-S", fixture.socket, ...args], {
      env: { ...process.env },
      maxBuffer: 64 * 1024,
    });
    return result.stdout;
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

async function startServer(
  session = "fixture",
  command = "sleep 60",
): Promise<void> {
  await tmux(["-f", "/dev/null", "new-session", "-d", "-s", session, command]);
}

async function createManagedFixture(
  fleet = "alpha-worker",
  command = "sleep 60",
  retainOnExit = false,
): Promise<{ sessionId: string; windowId: string; paneId: string }> {
  await startServer(fleet, command);
  if (retainOnExit) {
    await tmux([
      "set-window-option",
      "-t",
      `${fleet}:0`,
      "remain-on-exit",
      "on",
    ]);
  }
  await tmux(["move-window", "-s", `${fleet}:0`, "-t", `${fleet}:1`]);
  const sessionId = (
    await tmux(["display-message", "-p", "-t", fleet, "#{session_id}"])
  ).trim();
  const windowId = (
    await tmux(["display-message", "-p", "-t", `${fleet}:1`, "#{window_id}"])
  ).trim();
  const paneId = (
    await tmux(["display-message", "-p", "-t", `${fleet}:1`, "#{pane_id}"])
  ).trim();

  await tmux(["set-option", "-t", fleet, FLEET_VERSION_TAG, V1_TAG_VALUE]);
  await tmux([
    "set-window-option",
    "-t",
    windowId,
    WINDOW_VERSION_TAG,
    V1_TAG_VALUE,
  ]);
  await tmux(["set-window-option", "-t", windowId, INSTANCE_TAG, "1"]);
  await tmux(["set-window-option", "-t", windowId, PANE_ID_TAG, paneId]);
  await tmux(["rename-window", "-t", windowId, `${fleet}-1`]);

  return { sessionId, windowId, paneId };
}

afterEach(async () => {
  if (!fixture) return;
  for (const client of fixture.clients) {
    client.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  const clients = await tmux(["list-clients", "-F", "#{client_name}"], true);
  if (clients.trim() !== "") {
    throw new Error(
      `Refusing to kill test tmux server with attached client(s): ${clients.trim()}`,
    );
  }
  await tmux(["kill-server"], true);
  await rm(fixture.directory, { recursive: true, force: true });
  fixture = undefined;
});

describe("tmux adapter pure contracts", () => {
  it("resolves the configured agent directory and fixed dedicated socket", () => {
    expect(
      resolveSessionManagerPaths(
        { PI_CODING_AGENT_DIR: "  /tmp/custom-agent  " },
        "/ignored",
      ),
    ).toEqual({
      agentDir: "/tmp/custom-agent",
      stateDir: "/tmp/custom-agent/pi-session-manager",
      socketPath: "/tmp/custom-agent/pi-session-manager/tmux.sock",
    });
    expect(resolveSessionManagerPaths({}, "/home/tester").agentDir).toBe(
      "/home/tester/.pi/agent",
    );
  });

  it("removes exactly the five parent Pi session metadata variables", () => {
    const source = {
      PI_SESSION_ID: "session",
      PI_SESSION_FILE: "/secret/session.jsonl",
      PI_PROVIDER: "provider",
      PI_MODEL: "model",
      PI_REASONING_LEVEL: "high",
      PI_CODING_AGENT_DIR: "/agent",
      PI_OFFLINE: "1",
      PATH: "/bin",
      HOME: "/home/tester",
      CUSTOM: "preserved",
    };
    expect(sanitizeChildEnvironment(source)).toEqual({
      PI_CODING_AGENT_DIR: "/agent",
      PI_OFFLINE: "1",
      PATH: "/bin",
      HOME: "/home/tester",
      CUSTOM: "preserved",
    });
    expect(source.PI_SESSION_ID).toBe("session");
  });

  it("parses supported tmux release suffixes and recognizes the 3.5 floor", () => {
    const stable = parseTmuxVersion("tmux 3.5");
    const suffixed = parseTmuxVersion("tmux 3.5a\n");
    expect(stable).toMatchObject({ major: 3, minor: 5, suffix: "" });
    expect(suffixed).toMatchObject({ major: 3, minor: 5, suffix: "a" });
    expect(supportsTmuxV35(stable)).toBe(true);
    expect(supportsTmuxV35(parseTmuxVersion("tmux 3.6"))).toBe(true);
    expect(supportsTmuxV35(parseTmuxVersion("tmux 3.4"))).toBe(false);
    expect(() => parseTmuxVersion("not tmux")).toThrow(/Unable to parse/);
  });

  it("classifies tags strictly and renders an explicit-socket attachment command", () => {
    expect(classifyFleetOwnership("alpha-worker", "v1").kind).toBe("managed");
    expect(classifyFleetOwnership("Alpha", "v1").kind).toBe("malformed");
    expect(classifyFleetOwnership("alpha-worker", "v2").kind).toBe(
      "unsupported-version",
    );
    expect(classifyWindowOwnership("", "", "").kind).toBe("unmanaged");
    expect(classifyWindowOwnership("v1", "", "%1").kind).toBe("partial");
    expect(classifyWindowOwnership("v1", "01", "%1").kind).toBe("malformed");
    expect(classifyWindowOwnership("v1", "1", "%1")).toMatchObject({
      kind: "managed",
      instance: 1,
      paneId: "%1",
    });
    expect(renderAttachmentCommand("/tmp/a socket", "alpha-worker")).toBe(
      "tmux -S '/tmp/a socket' attach -t 'alpha-worker'",
    );
  });
});

describe("TmuxAdapter hermetic integration", () => {
  it("creates an owner-only state directory and detects an absent dedicated server", async () => {
    fixture = await createFixture();
    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });
    await adapter.ensureStateDirectory();
    const state = await stat(join(fixture.agentDir, "pi-session-manager"));
    expect(state.mode & 0o777).toBe(0o700);
    await expect(
      access(adapter.paths.stateDir, fsConstants.R_OK),
    ).resolves.toBeUndefined();
    await expect(adapter.inventory()).resolves.toEqual({
      serverPresent: false,
      fleets: [],
      warnings: [],
      clients: [],
    });
  });

  it("detects tmux 3.5a and applies only the required explicit option scopes", async () => {
    fixture = await createFixture();
    await startServer();
    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });
    await expect(adapter.getVersion()).resolves.toMatchObject({
      major: 3,
      minor: 5,
      suffix: "a",
    });
    await adapter.ensureCriticalOptions();

    await expect(tmux(["show-options", "-g", "base-index"])).resolves.toBe(
      "base-index 1\n",
    );
    await expect(
      tmux(["show-options", "-g", "renumber-windows"]),
    ).resolves.toBe("renumber-windows off\n");
    await expect(tmux(["show-options", "-g", "remain-on-exit"])).resolves.toBe(
      "remain-on-exit on\n",
    );
    await expect(tmux(["show-options", "-s", "extended-keys"])).resolves.toBe(
      "extended-keys on\n",
    );
    await expect(
      tmux(["show-options", "-s", "extended-keys-format"]),
    ).resolves.toBe("extended-keys-format csi-u\n");
  });

  it("times out a nonresponsive tmux executable without a shell", async () => {
    fixture = await createFixture();
    const executable = join(fixture.directory, "slow-tmux");
    await writeFile(
      executable,
      `#!${process.execPath}\nsetInterval(() => {}, 1_000);\n`,
    );
    await chmod(executable, 0o700);
    const adapter = new TmuxAdapter({
      agentDir: fixture.agentDir,
      tmuxPath: executable,
      timeoutMs: 100,
    });
    await expect(adapter.getVersion()).rejects.toMatchObject({
      code: ErrorCode.TMUX_SERVER_ERROR,
    });
  });

  it("returns only exact V1-managed one-pane inventory with stable IDs", async () => {
    fixture = await createFixture();
    const expected = await createManagedFixture();
    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });
    await adapter.disableAutomaticRename(expected.windowId);
    await expect(
      tmux(["show-options", "-t", expected.windowId, "automatic-rename"]),
    ).resolves.toBe("automatic-rename off\n");
    const inventory = await adapter.inventory();

    expect(inventory.serverPresent).toBe(true);
    expect(inventory.warnings).toEqual([]);
    expect(inventory.fleets).toHaveLength(1);
    const fleet = inventory.fleets[0];
    expect(fleet).toMatchObject({
      name: "alpha-worker",
      sessionId: expected.sessionId,
      attachmentCommand: `tmux -S '${fixture.agentDir}/pi-session-manager/tmux.sock' attach -t 'alpha-worker'`,
    });
    expect(fleet.instances).toEqual([
      expect.objectContaining({
        fleet: "alpha-worker",
        instance: 1,
        sessionId: expected.sessionId,
        windowId: expected.windowId,
        paneId: expected.paneId,
        windowIndex: 1,
        windowName: "alpha-worker-1",
        state: "running",
        viewedByUser: false,
        activeViewerCount: 0,
      }),
    ]);
  });

  it("reports retained exited panes with their exit status", async () => {
    fixture = await createFixture();
    await createManagedFixture("alpha-worker", "sleep 0.3; exit 7", true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });
    const inventory = await adapter.inventory();

    expect(inventory.fleets[0]?.instances[0]).toMatchObject({
      state: "exited",
      exitStatus: 7,
    });
    expect(inventory.fleets[0]?.instances[0]?.exitTime).toEqual(
      expect.any(Number),
    );
  });

  it("fails closed on a manually split managed window", async () => {
    fixture = await createFixture();
    const expected = await createManagedFixture();
    await tmux(["split-window", "-d", "-t", expected.windowId, "sleep 60"]);
    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });
    const inventory = await adapter.inventory();

    expect(inventory.fleets[0]?.instances).toEqual([]);
    expect(inventory.warnings).toContainEqual(
      expect.objectContaining({
        code: "AMBIGUOUS_WINDOW",
        windowId: expected.windowId,
      }),
    );
  });

  it("reports an attached active viewer without mutating focus", async () => {
    fixture = await createFixture();
    await createManagedFixture();
    const client = spawn(
      "/usr/bin/script",
      [
        "-qefc",
        `${tmuxPath} -S '${fixture.socket}' attach -t alpha-worker`,
        "/dev/null",
      ],
      { env: { ...process.env, TERM: "xterm" }, stdio: "ignore" },
    );
    fixture.clients.add(client);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });
    const inventory = await adapter.inventory();
    expect(inventory.clients).toHaveLength(1);
    expect(inventory.fleets[0]?.instances[0]).toMatchObject({
      viewedByUser: true,
      activeViewerCount: 1,
    });
  });
});
