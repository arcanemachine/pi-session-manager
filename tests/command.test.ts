import { describe, it, expect, beforeEach } from "vitest";

import { registerCommand } from "../src/command.js";
import { isAuthorized, resetAuthorization } from "../src/authorization.js";
import { COMMAND_NAME } from "../src/constants.js";
import { ErrorCode, SessionManagerError } from "../src/errors.js";
import {
  createFakePi,
  createCommandContext,
  type FakeCommandContext,
} from "./fake-pi.js";

type CommandMap = Map<
  string,
  {
    name: string;
    definition: {
      description?: string;
      getArgumentCompletions?: (
        prefix: string,
      ) => { value: string; label: string }[] | null;
      handler: (a: string, c: FakeCommandContext) => Promise<void>;
    };
  }
>;

function getCommand(commands: CommandMap) {
  const cmd = commands.get(COMMAND_NAME);
  if (!cmd) throw new Error("command not registered");
  return cmd.definition.handler;
}

describe("/session-manager command", () => {
  let commands: CommandMap;

  beforeEach(() => {
    resetAuthorization();
    const fake = createFakePi();
    registerCommand(fake.pi);
    commands = fake.commands as unknown as CommandMap;
  });

  it("registers with the expected name and completions", () => {
    const cmd = commands.get(COMMAND_NAME);
    expect(cmd).toBeDefined();
    const completions = cmd!.definition.getArgumentCompletions?.("") ?? [];
    const values = completions.map((c) => c.value);
    expect(values).toEqual(["on", "off", "status"]);
  });

  it("shows usage and does not change state for no or unknown argument", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext();
    await handler("", ctx);
    await handler("bogus", ctx);
    expect(isAuthorized()).toBe(false);
    expect(ctx.ui.notifies.some((n) => n.message.startsWith("Usage:"))).toBe(
      true,
    );
  });

  it("status reports the current state without changing it", async () => {
    const handler = getCommand(commands);
    const ctx1 = createCommandContext();
    await handler("status", ctx1);
    expect(ctx1.ui.notifies.some((n) => n.message.includes("disabled"))).toBe(
      true,
    );

    const ctx2 = createCommandContext({ nextSelect: "Yes" });
    await handler("on", ctx2);
    const ctx3 = createCommandContext();
    await handler("status", ctx3);
    expect(ctx3.ui.notifies.some((n) => n.message.includes("enabled"))).toBe(
      true,
    );
  });

  it("on requires interactive TUI mode", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({
      mode: "rpc",
      hasUI: true,
      nextSelect: "Yes",
    });
    await expect(handler("on", ctx)).rejects.toMatchObject({
      code: ErrorCode.TUI_REQUIRED,
    });
    expect(isAuthorized()).toBe(false);
  });

  it("on requires a real UI", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({
      mode: "tui",
      hasUI: false,
      nextSelect: "Yes",
    });
    await expect(handler("on", ctx)).rejects.toMatchObject({
      code: ErrorCode.TUI_REQUIRED,
    });
    expect(isAuthorized()).toBe(false);
  });

  it("on confirms with No selected by default and leaves state unchanged", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({ nextSelect: undefined }); // cancellation / No
    await handler("on", ctx);
    expect(isAuthorized()).toBe(false);
    // The confirm prompt presents No first.
    expect(ctx.ui.selects[0]?.options).toEqual(["No", "Yes"]);
  });

  it("on enables authorization when the user deliberately selects Yes", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({ nextSelect: "Yes" });
    await handler("on", ctx);
    expect(isAuthorized()).toBe(true);
  });

  it("off requires confirmation defaulting to No and keeps authorization when not confirmed", async () => {
    const handler = getCommand(commands);
    const enableCtx = createCommandContext({ nextSelect: "Yes" });
    await handler("on", enableCtx);
    expect(isAuthorized()).toBe(true);

    const offCtx = createCommandContext({ nextSelect: undefined });
    await handler("off", offCtx);
    expect(isAuthorized()).toBe(true);
    expect(offCtx.ui.selects[0]?.options).toEqual(["No", "Yes"]);
  });

  it("off disables authorization when the user deliberately selects Yes", async () => {
    const handler = getCommand(commands);
    const enableCtx = createCommandContext({ nextSelect: "Yes" });
    await handler("on", enableCtx);

    const offCtx = createCommandContext({ nextSelect: "Yes" });
    await handler("off", offCtx);
    expect(isAuthorized()).toBe(false);
  });

  it("throws typed SessionManagerError outside TUI", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({ mode: "print", hasUI: false });
    let caught: unknown;
    try {
      await handler("on", ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionManagerError);
    expect((caught as SessionManagerError).code).toBe(ErrorCode.TUI_REQUIRED);
  });
});
