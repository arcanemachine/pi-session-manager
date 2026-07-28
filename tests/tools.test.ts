import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  MAX_PI_ARGS,
  MAX_PI_ARGS_BYTES,
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

  it("keeps close and force-close as skeletons while list/view and create implement their assigned contracts", async () => {
    setAuthorized(true);
    const fake = createFakePi();
    registerTools(fake.pi);
    for (const tool of fake.tools.filter(
      (tool) => tool.name === TOOL_CLOSE || tool.name === TOOL_FORCE_CLOSE,
    )) {
      await expect(
        tool.execute("id", {} as never, undefined, undefined, {} as never),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_IMPLEMENTED,
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
  });

  it("force-close schema requires confirmProcessTermination to be exactly true", () => {
    const fake = createFakePi();
    registerTools(fake.pi);
    const force = fake.tools.find((t) => t.name === TOOL_FORCE_CLOSE)!;
    const schema = force.parameters as Record<string, unknown>;
    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.confirmProcessTermination.const).toBe(true);
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
