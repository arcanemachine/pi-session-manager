import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode } from "../src/errors.js";
import { createFleetInstance, listFleets, viewFleet } from "../src/tools.js";
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
  readonly binDir: string;
  readonly clients: Set<ReturnType<typeof spawn>>;
}

let fixture: Fixture | undefined;

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-manager-test-"));
  const agentDir = join(directory, "agent");
  const binDir = join(directory, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(agentDir, "pi-session-manager"), {
    recursive: true,
    mode: 0o700,
  });
  return {
    directory,
    socket: join(agentDir, "pi-session-manager", "tmux.sock"),
    agentDir,
    binDir,
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

async function writeFakePi(
  outputPath: string,
  mode: "sleep" | "exit" = "sleep",
): Promise<void> {
  if (!fixture) throw new Error("fixture is not initialized");
  const script = `#!/bin/sh
{
  printf 'cwd=%s\\n' "$PWD"
  printf 'argc=%s\\n' "$#"
  for argument in "$@"; do printf 'arg=%s\\n' "$argument"; done
  for key in PI_SESSION_ID PI_SESSION_FILE PI_PROVIDER PI_MODEL PI_REASONING_LEVEL; do
    if printenv "$key" >/dev/null; then state=set; else state=unset; fi
    printf '%s=%s\\n' "$key" "$state"
  done
} > "$FAKE_PI_OUTPUT"
${mode === "exit" ? "exit 7" : "sleep 60"}
`;
  await writeFile(join(fixture.binDir, "pi"), script, { mode: 0o700 });
}

function createFixtureAdapter(
  outputPath: string,
  customTmuxPath?: string,
): TmuxAdapter {
  if (!fixture) throw new Error("fixture is not initialized");
  return new TmuxAdapter({
    agentDir: fixture.agentDir,
    ...(customTmuxPath ? { tmuxPath: customTmuxPath } : {}),
    environment: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      FAKE_PI_OUTPUT: outputPath,
      PI_SESSION_ID: "parent-session",
      PI_SESSION_FILE: "/sensitive/parent.jsonl",
      PI_PROVIDER: "parent-provider",
      PI_MODEL: "parent-model",
      PI_REASONING_LEVEL: "high",
    },
  });
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for fixture output: ${path}`);
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

describe("TmuxAdapter list and view integration", () => {
  it("lists an absent dedicated server as an empty successful inventory", async () => {
    fixture = await createFixture();
    const result = await listFleets(
      {},
      undefined,
      new TmuxAdapter({ agentDir: fixture.agentDir }),
    );

    expect(result.content[0]?.text).toContain(
      "dedicated tmux server is absent",
    );
    expect(result.details).toMatchObject({
      serverPresent: false,
      fleets: [],
      warningCount: 0,
    });
  });

  it("lists only exact managed inventory and reports ambiguous managed-looking windows as warnings", async () => {
    fixture = await createFixture();
    const expected = await createManagedFixture();
    await tmux(["split-window", "-d", "-t", expected.windowId, "sleep 60"]);
    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });

    const result = await listFleets(
      { fleet: "alpha-worker" },
      undefined,
      adapter,
    );
    expect(result.details).toMatchObject({
      serverPresent: true,
      filter: "alpha-worker",
      fleets: [{ name: "alpha-worker", instances: [] }],
      warningCount: 1,
    });
    expect(result.content[0]?.text).toContain("Warnings (1)");
    expect(result.details.warnings).toContainEqual(
      expect.objectContaining({
        code: "AMBIGUOUS_WINDOW",
        windowId: expected.windowId,
      }),
    );
  });

  it("captures bounded plain running-pane output by stable pane ID without changing a client's active window", async () => {
    fixture = await createFixture();
    await createManagedFixture(
      "alpha-worker",
      "printf '\\033[31mfirst\\033[0m\\nsecond\\nthird\\nfourth\\n'; sleep 60",
    );
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
    const activeBefore = await tmux([
      "display-message",
      "-p",
      "-t",
      "alpha-worker",
      "#{window_id}",
    ]);

    const result = await viewFleet(
      { fleet: "alpha-worker", instance: 1, lines: 2 },
      undefined,
      new TmuxAdapter({ agentDir: fixture.agentDir }),
    );

    expect(result.details).toMatchObject({
      state: "running",
      requestedLines: 2,
      captureTruncated: true,
      outputTruncated: false,
    });
    expect(result.content[0]?.text).toContain("third");
    expect(result.content[0]?.text).toContain("fourth");
    expect(result.content[0]?.text).not.toContain("\u001b");
    expect(result.content[0]?.text).toContain("[Terminal view truncated");
    await expect(
      tmux(["display-message", "-p", "-t", "alpha-worker", "#{window_id}"]),
    ).resolves.toBe(activeBefore);
  });

  it("truncates large captures below Pi's tool-output ceiling with a clear indicator", async () => {
    fixture = await createFixture();
    await createManagedFixture(
      "alpha-worker",
      "sleep 0.2; i=0; while [ $i -lt 500 ]; do printf '%0200d\\n' \"$i\"; i=$((i + 1)); done; sleep 60",
    );
    await tmux([
      "resize-window",
      "-t",
      "alpha-worker:1",
      "-x",
      "512",
      "-y",
      "40",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const result = await viewFleet(
      { fleet: "alpha-worker", instance: 1, lines: 500 },
      undefined,
      new TmuxAdapter({ agentDir: fixture.agentDir }),
    );

    expect(result.details).toMatchObject({ outputTruncated: true });
    expect(result.content[0]?.text).toContain("[Terminal view truncated");
    expect(
      Buffer.byteLength(result.content[0]?.text ?? "", "utf8"),
    ).toBeLessThan(50 * 1024);
  });

  it("captures live alternate-screen output and retained exited primary output", async () => {
    fixture = await createFixture();
    await createManagedFixture(
      "alpha-worker",
      "printf '\\033[?1049halternate live screen\\n'; sleep 60",
    );
    const adapter = new TmuxAdapter({ agentDir: fixture.agentDir });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const live = await viewFleet(
      { fleet: "alpha-worker", instance: 1, lines: 20 },
      undefined,
      adapter,
    );
    expect(live.details).toMatchObject({
      state: "running",
      alternateScreenActive: true,
      capturedAlternateScreen: false,
      usedPrimaryFallback: true,
    });
    expect(live.content[0]?.text).toContain("alternate live screen");
    expect(live.content[0]?.text).toContain("primary-screen fallback");

    await createManagedFixture(
      "beta-worker",
      "printf 'retained exited output\\n'; sleep 0.15; exit 7",
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const exited = await viewFleet(
      { fleet: "beta-worker", instance: 1, lines: 100 },
      undefined,
      adapter,
    );
    expect(exited.details).toMatchObject({
      state: "exited",
      capturedAlternateScreen: false,
    });
    expect(exited.content[0]?.text).toContain("retained exited output");
    expect(exited.content[0]?.text).toContain("retained primary screen");
  });

  it("refuses a split managed window rather than capturing an ambiguous pane", async () => {
    fixture = await createFixture();
    const expected = await createManagedFixture();
    await tmux(["split-window", "-d", "-t", expected.windowId, "sleep 60"]);

    await expect(
      viewFleet(
        { fleet: "alpha-worker", instance: 1 },
        undefined,
        new TmuxAdapter({ agentDir: fixture.agentDir }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.AMBIGUOUS_WINDOW });
  });
});

describe("TmuxAdapter create integration", () => {
  it("creates and tags a one-based fleet using fixed direct pi argv and a sanitized environment", async () => {
    fixture = await createFixture();
    const output = join(fixture.directory, "fake-pi-output");
    const workerCwd = join(fixture.directory, "worker-cwd");
    await mkdir(workerCwd);
    await writeFakePi(output);
    const adapter = createFixtureAdapter(output);

    const result = await createFleetInstance(
      {
        fleet: "alpha-worker",
        instance: 1,
        cwd: workerCwd,
        piArgs: [
          "one value",
          ";",
          "\\;",
          "literal;touch should-not-exist",
          "$HOME",
        ],
      },
      { cwd: fixture.directory },
      undefined,
      adapter,
    );

    expect(result.details).toMatchObject({
      fleet: "alpha-worker",
      instance: 1,
      windowIndex: 1,
      windowName: "alpha-worker-1",
      state: "running",
      cwd: workerCwd,
    });
    const piOutput = await waitForFile(output);
    expect(piOutput).toContain(`cwd=${workerCwd}`);
    expect(piOutput).toContain("argc=5");
    expect(piOutput).toContain("arg=one value");
    expect(piOutput).toContain("arg=;");
    expect(piOutput).toContain("arg=\\;");
    expect(piOutput).toContain("arg=literal;touch should-not-exist");
    expect(piOutput).toContain("arg=$HOME");
    expect(piOutput).toContain("PI_SESSION_ID=unset");
    expect(piOutput).toContain("PI_SESSION_FILE=unset");
    expect(piOutput).toContain("PI_PROVIDER=unset");
    expect(piOutput).toContain("PI_MODEL=unset");
    expect(piOutput).toContain("PI_REASONING_LEVEL=unset");
    await expect(
      access(join(workerCwd, "should-not-exist")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(tmux(["show-options", "-g", "base-index"])).resolves.toBe(
      "base-index 1\n",
    );
    await expect(
      tmux(["show-options", "-g", "renumber-windows"]),
    ).resolves.toBe("renumber-windows off\n");
    await expect(tmux(["show-options", "-g", "remain-on-exit"])).resolves.toBe(
      "remain-on-exit on\n",
    );
    await expect(
      tmux(["show-options", "-t", result.details.windowId, "automatic-rename"]),
    ).resolves.toBe("automatic-rename off\n");

    const inventory = await adapter.inventory();
    expect(inventory.fleets[0]?.instances[0]).toMatchObject({
      windowId: result.details.windowId,
      paneId: result.details.paneId,
      sessionId: result.details.sessionId,
    });
  });

  it("rejects a non-initial new instance and occupied windows", async () => {
    fixture = await createFixture();
    const output = join(fixture.directory, "fake-pi-output");
    await writeFakePi(output);
    const adapter = createFixtureAdapter(output);

    await expect(
      createFleetInstance(
        { fleet: "alpha-worker", instance: 2 },
        { cwd: fixture.directory },
        undefined,
        adapter,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INSTANCE });

    await createFleetInstance(
      { fleet: "alpha-worker", instance: 1 },
      { cwd: fixture.directory },
      undefined,
      adapter,
    );
    await expect(
      createFleetInstance(
        { fleet: "alpha-worker", instance: 1 },
        { cwd: fixture.directory },
        undefined,
        adapter,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INSTANCE_COLLISION });

    await createFleetInstance(
      { fleet: "alpha-worker", instance: 3 },
      { cwd: fixture.directory },
      undefined,
      adapter,
    );
    await tmux(["new-window", "-d", "-t", "alpha-worker:2", "sleep", "60"]);
    await expect(
      createFleetInstance(
        { fleet: "alpha-worker", instance: 2 },
        { cwd: fixture.directory },
        undefined,
        adapter,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INSTANCE_COLLISION });

    await tmux(["new-session", "-d", "-s", "beta-worker", "sleep", "60"]);
    await expect(
      createFleetInstance(
        { fleet: "beta-worker", instance: 1 },
        { cwd: fixture.directory },
        undefined,
        adapter,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FLEET_COLLISION });
  });

  it("reports an immediate retained pi exit", async () => {
    fixture = await createFixture();
    const output = join(fixture.directory, "fake-pi-output");
    await writeFakePi(output, "exit");
    const adapter = createFixtureAdapter(output);

    const result = await createFleetInstance(
      { fleet: "alpha-worker", instance: 1 },
      { cwd: fixture.directory },
      undefined,
      adapter,
    );
    expect(result.details).toMatchObject({ state: "exited", exitStatus: 7 });
  });

  it("removes the exact new window when controlled tag application fails", async () => {
    fixture = await createFixture();
    const output = join(fixture.directory, "fake-pi-output");
    await writeFakePi(output);
    const failingTmux = join(fixture.directory, "failing-tmux");
    await writeFile(
      failingTmux,
      `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "${WINDOW_VERSION_TAG}" ]; then exit 1; fi
done
exec ${tmuxPath} "$@"
`,
      { mode: 0o700 },
    );
    const adapter = createFixtureAdapter(output, failingTmux);

    await expect(
      createFleetInstance(
        { fleet: "alpha-worker", instance: 1 },
        { cwd: fixture.directory },
        undefined,
        adapter,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CREATE_PARTIAL_FAILURE });
    await expect(adapter.inventory()).resolves.toEqual({
      serverPresent: false,
      fleets: [],
      warnings: [],
      clients: [],
    });
  });
});
