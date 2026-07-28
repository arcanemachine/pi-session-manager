import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  MAX_PI_ARGS,
  MAX_PI_ARGS_BYTES,
  forceCloseFleetInstance,
  listFleets,
  registerTools,
  SEQUENTIAL_TOOLS,
  TOOL_GUIDELINES,
  validateCreateFleetInput,
} from "../src/tools.js";
import { resetAuthorization, setAuthorized } from "../src/authorization.js";
import {
  TOOL_CLOSE,
  TOOL_CREATE,
  TOOL_FORCE_CLOSE,
  TOOL_LIST,
  TOOL_VIEW,
} from "../src/constants.js";
import { ErrorCode, SessionManagerError } from "../src/errors.js";
import { TmuxAdapter } from "../src/tmux.js";
import type { ManagedInstance, TmuxInventory } from "../src/types.js";
import { createFakePi } from "./fake-pi.js";

const EXPECTED_TOOLS = [
  TOOL_LIST,
  TOOL_VIEW,
  TOOL_CREATE,
  TOOL_CLOSE,
  TOOL_FORCE_CLOSE,
] as const;

describe("tool registration", () => {
  beforeEach(() => {
    resetAuthorization();
  });

  it("registers exactly the five V1 tools, by name", () => {
    const fake = createFakePi();
    registerTools(fake.pi);
    expect(fake.tools.map((t) => t.name).sort()).toEqual(
      [...EXPECTED_TOOLS].sort(),
    );
    expect(fake.tools).toHaveLength(5);
  });

  it("all tools define static promptSnippet and promptGuidelines", () => {
    const fake = createFakePi();
    registerTools(fake.pi);
    for (const tool of fake.tools) {
      expect(typeof tool.promptSnippet).toBe("string");
      expect(tool.promptSnippet!.length).toBeGreaterThan(0);
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("promptGuidelines bullets name their own tool", () => {
    for (const name of EXPECTED_TOOLS) {
      for (const bullet of TOOL_GUIDELINES[name]) {
        expect(bullet).toContain(name);
      }
    }
  });

  it("every tool carries static disabled-result guidance: do not retry, do not enable, wait for the user", () => {
    for (const name of EXPECTED_TOOLS) {
      const bullets = TOOL_GUIDELINES[name];
      const disabledBullet = bullets.find((b) =>
        b.includes("reports Session Manager is disabled"),
      );
      expect(
        disabledBullet,
        `${name} missing disabled-result guidance`,
      ).toBeDefined();
      expect(disabledBullet).toContain(name);
      expect(disabledBullet).toMatch(/do not retry/);
      expect(disabledBullet).toMatch(/do not attempt to enable it yourself/);
      expect(disabledBullet).toMatch(/wait for the user/);
    }
  });

  it("the three mutating tools execute sequentially; list/view do not override the mode", () => {
    const fake = createFakePi();
    registerTools(fake.pi);
    for (const tool of fake.tools) {
      if (SEQUENTIAL_TOOLS.has(tool.name)) {
        expect(tool.executionMode).toBe("sequential");
      } else {
        expect(tool.executionMode).toBeUndefined();
      }
    }
  });

  it("every disabled tool denies before any tmux inspection, as a failed tool result", async () => {
    const inventory = vi.spyOn(TmuxAdapter.prototype, "inventory");
    const fake = createFakePi();
    registerTools(fake.pi);
    for (const tool of fake.tools) {
      await expect(
        tool.execute("id", {} as never, undefined, undefined, {} as never),
      ).rejects.toMatchObject({
        code: ErrorCode.SESSION_MANAGER_DISABLED,
      });
    }
    expect(inventory).not.toHaveBeenCalled();
    inventory.mockRestore();
  });

  it("dispatches authorized close tools to their runtime validation", async () => {
    setAuthorized(true);
    const fake = createFakePi();
    registerTools(fake.pi);
    for (const tool of fake.tools.filter(
      (tool) => tool.name === TOOL_CLOSE || tool.name === TOOL_FORCE_CLOSE,
    )) {
      await expect(
        tool.execute("id", {} as never, undefined, undefined, {} as never),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_FLEET,
      });
    }
    const create = fake.tools.find((tool) => tool.name === TOOL_CREATE)!;
    await expect(
      create.execute("id", {} as never, undefined, undefined, {
        cwd: "/tmp",
      } as never),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_FLEET,
    });
  });

  it("validates the optional list fleet filter before inspecting tmux", async () => {
    const inventory = vi.spyOn(TmuxAdapter.prototype, "inventory");
    await expect(listFleets({ fleet: "Alpha" })).rejects.toMatchObject({
      code: ErrorCode.INVALID_FLEET,
    });
    expect(inventory).not.toHaveBeenCalled();
    inventory.mockRestore();
  });

  it("kept authorization is reflected by the disabled->authorized transition", async () => {
    const inventory = vi
      .spyOn(TmuxAdapter.prototype, "inventory")
      .mockResolvedValue({
        serverPresent: false,
        fleets: [],
        warnings: [],
        clients: [],
      });
    const fake = createFakePi();
    registerTools(fake.pi);
    const list = fake.tools.find((t) => t.name === TOOL_LIST)!;
    await expect(
      list.execute("id", {} as never, undefined, undefined, {} as never),
    ).rejects.toMatchObject({
      code: ErrorCode.SESSION_MANAGER_DISABLED,
    });
    setAuthorized(true);
    await expect(
      list.execute("id", {} as never, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { serverPresent: false, fleets: [] },
    });
    inventory.mockRestore();
  });

  it("force-close schema and runtime require confirmProcessTermination to be exactly true", async () => {
    const fake = createFakePi();
    registerTools(fake.pi);
    const force = fake.tools.find((t) => t.name === TOOL_FORCE_CLOSE)!;
    const schema = force.parameters as Record<string, unknown>;
    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.confirmProcessTermination.const).toBe(true);
    await expect(
      forceCloseFleetInstance({
        fleet: "alpha-worker",
        instance: 1,
        confirmProcessTermination: false,
      } as never),
    ).rejects.toMatchObject({ code: ErrorCode.CONFIRMATION_REQUIRED });
  });

  it("create fleet schema carries the fleet name pattern and bounded opaque pi arguments", () => {
    const fake = createFakePi();
    registerTools(fake.pi);
    const create = fake.tools.find((t) => t.name === TOOL_CREATE)!;
    const schema = create.parameters as Record<string, unknown>;
    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(typeof properties.fleet.pattern).toBe("string");
    expect(properties.fleet.pattern).toContain("a-z0-9");
    expect(properties.piArgs.maxItems).toBe(MAX_PI_ARGS);
  });

  it("validates fleet, safe instance, cwd, and opaque pi argument bounds", async () => {
    await expect(
      validateCreateFleetInput({ fleet: "Alpha", instance: 1 }, "/tmp"),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_FLEET });
    await expect(
      validateCreateFleetInput(
        { fleet: "alpha", instance: Number.MAX_SAFE_INTEGER + 1 },
        "/tmp",
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INSTANCE });
    await expect(
      validateCreateFleetInput(
        { fleet: "alpha", instance: 1, cwd: "/does/not/exist" },
        "/tmp",
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CWD });
    await expect(
      validateCreateFleetInput(
        {
          fleet: "alpha",
          instance: 1,
          piArgs: Array(MAX_PI_ARGS + 1).fill("x"),
        },
        "/tmp",
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PI_ARGS });
    await expect(
      validateCreateFleetInput(
        {
          fleet: "alpha",
          instance: 1,
          piArgs: ["x".repeat(MAX_PI_ARGS_BYTES)],
        },
        "/tmp",
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PI_ARGS });
  });

  it("resolves cwd relative to Manager Pi and preserves each opaque pi argument", async () => {
    const validated = await validateCreateFleetInput(
      { fleet: "alpha", instance: 1, cwd: ".", piArgs: ["one value", "$HOME"] },
      "/tmp",
    );
    expect(validated).toEqual({
      fleet: "alpha",
      instance: 1,
      cwd: "/tmp",
      piArgs: ["one value", "$HOME"],
    });
  });
});

describe("fleet list rendering", () => {
  it("renders all available running and exited instance fields", async () => {
    const attachmentCommand =
      "tmux -S /tmp/pi-session-manager/tmux.sock attach -t alpha-worker";
    const inventory: TmuxInventory = {
      serverPresent: true,
      clients: [],
      warnings: [],
      fleets: [
        {
          name: "alpha-worker",
          sessionId: "$0",
          attachmentCommand,
          instances: [
            managedInstance({
              currentCommand: "pi",
              pid: 42,
              currentPath: "/workspace/worker",
              viewedByUser: true,
              activeViewerCount: 1,
              attachmentCommand,
            }),
            managedInstance({
              instance: 2,
              windowId: "@2",
              paneId: "%2",
              windowIndex: 2,
              windowName: "alpha-worker-2",
              state: "exited",
              exitStatus: 0,
              exitSignal: 15,
              exitTime: 1_700_000_000,
              attachmentCommand,
            }),
            managedInstance({
              instance: 3,
              windowId: "@3",
              paneId: "%3",
              windowIndex: 3,
              windowName: "alpha-worker-3",
              state: "exited",
              attachmentCommand,
            }),
          ],
        },
      ],
    };

    const result = await listFleets({}, undefined, listAdapter(inventory));
    const text = result.content[0]?.text ?? "";

    expect(text).toContain(
      'fleet="alpha-worker" instance=1 state=running session=$0 window=@1 pane=%1 index=1 name="alpha-worker-1" command="pi" pid=42 path="/workspace/worker" viewed=yes activeViewers=1',
    );
    expect(text).toContain(`attach="${attachmentCommand}"`);
    expect(text).toContain(
      'fleet="alpha-worker" instance=2 state=exited session=$0 window=@2 pane=%2 index=2 name="alpha-worker-2" exitStatus=0 exitSignal=15 exitTime=1700000000 viewed=no activeViewers=0',
    );
    expect(text).toContain(
      'fleet="alpha-worker" instance=3 state=exited session=$0 window=@3 pane=%3 index=3 name="alpha-worker-3" exitStatus=unavailable exitSignal=unavailable exitTime=unavailable viewed=no activeViewers=0',
    );
  });

  it("preserves safe bounded list rendering", async () => {
    const attachmentCommand =
      "tmux -S /tmp/pi-session-manager/tmux.sock attach -t alpha-worker";
    const inventory: TmuxInventory = {
      serverPresent: true,
      clients: [],
      warnings: [],
      fleets: [
        {
          name: "alpha-worker",
          sessionId: "$0",
          attachmentCommand,
          instances: Array.from({ length: 1_000 }, (_, index) =>
            managedInstance({
              instance: index + 1,
              windowId: `@${index + 1}`,
              paneId: `%${index + 1}`,
              windowIndex: index + 1,
              windowName: `alpha-worker-${"x".repeat(512)}`,
              attachmentCommand,
            }),
          ),
        },
      ],
    };

    const result = await listFleets({}, undefined, listAdapter(inventory));
    const text = result.content[0]?.text ?? "";

    expect(result.details.outputTruncated).toBe(true);
    expect(text).toContain(
      "[Fleet list truncated to the safe tool-output limit.]",
    );
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(50 * 1024);
  });
});

function managedInstance(
  overrides: Partial<ManagedInstance> = {},
): ManagedInstance {
  return {
    fleet: "alpha-worker",
    instance: 1,
    sessionId: "$0",
    windowId: "@1",
    paneId: "%1",
    windowIndex: 1,
    windowName: "alpha-worker-1",
    state: "running",
    activeViewerCount: 0,
    viewedByUser: false,
    attachmentCommand:
      "tmux -S /tmp/pi-session-manager/tmux.sock attach -t alpha-worker",
    ...overrides,
  };
}

function listAdapter(inventory: TmuxInventory): TmuxAdapter {
  return {
    inventory: vi.fn().mockResolvedValue(inventory),
  } as unknown as TmuxAdapter;
}
