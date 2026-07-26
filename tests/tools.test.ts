import { describe, it, expect, beforeEach } from "vitest";

import {
  registerTools,
  SEQUENTIAL_TOOLS,
  TOOL_GUIDELINES,
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
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
    }
  });

  it("promptGuidelines bullets name their own tool", () => {
    for (const name of EXPECTED_TOOLS) {
      for (const bullet of TOOL_GUIDELINES[name]) {
        expect(bullet).toContain(name);
      }
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

  it("every disabled tool denies before doing anything, as a failed tool result", async () => {
    const fake = createFakePi();
    registerTools(fake.pi);
    for (const tool of fake.tools) {
      await expect(
        tool.execute("id", {} as never, undefined, undefined, {} as never),
      ).rejects.toMatchObject({
        code: ErrorCode.SESSION_MANAGER_DISABLED,
      });
    }
  });

  it("an authorized skeleton tool fails with not-implemented rather than touching tmux", async () => {
    setAuthorized(true);
    const fake = createFakePi();
    registerTools(fake.pi);
    for (const tool of fake.tools) {
      await expect(
        tool.execute("id", {} as never, undefined, undefined, {} as never),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_IMPLEMENTED,
      });
    }
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
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_IMPLEMENTED,
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

  it("create fleet schema carries the fleet name pattern", () => {
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
  });
});
