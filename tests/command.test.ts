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
    expect(values).toEqual(["configure", "status"]);
    expect(cmd!.definition.getArgumentCompletions?.("on")).toBeNull();
    expect(cmd!.definition.getArgumentCompletions?.("off")).toBeNull();
  });

  it("shows usage and does not change state for no or unknown argument", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext();
    await handler("", ctx);
    await handler("on", ctx);
    await handler("off", ctx);
    await handler("bogus", ctx);
    expect(isAuthorized()).toBe(false);
    expect(ctx.ui.selects).toHaveLength(0);
    expect(ctx.ui.notifies).toHaveLength(4);
    expect(
      ctx.ui.notifies.every((n) =>
        n.message.startsWith("Usage: /session-manager configure | status"),
      ),
    ).toBe(true);
  });

  it("status reports the current state without changing it", async () => {
    const handler = getCommand(commands);
    const ctx1 = createCommandContext();
    await handler("status", ctx1);
    expect(ctx1.ui.notifies).toContainEqual({
      message: "Session Manager is disabled.",
      type: "info",
    });
    expect(isAuthorized()).toBe(false);

    await handler("configure", createCommandContext({ nextSelect: "On" }));
    const ctx2 = createCommandContext();
    await handler("status", ctx2);
    expect(ctx2.ui.notifies).toContainEqual({
      message: "Session Manager is enabled.",
      type: "info",
    });
    expect(isAuthorized()).toBe(true);
  });

  it("configure requires interactive TUI mode", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({
      mode: "rpc",
      hasUI: true,
      nextSelect: "On",
    });
    await expect(handler("configure", ctx)).rejects.toMatchObject({
      code: ErrorCode.TUI_REQUIRED,
    });
    expect(isAuthorized()).toBe(false);
  });

  it("configure requires a real UI", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({
      mode: "tui",
      hasUI: false,
      nextSelect: "On",
    });
    await expect(handler("configure", ctx)).rejects.toMatchObject({
      code: ErrorCode.TUI_REQUIRED,
    });
    expect(isAuthorized()).toBe(false);
  });

  it("shows the disabled state first and warns about authority", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({ nextSelect: undefined });
    await handler("configure", ctx);

    expect(isAuthorized()).toBe(false);
    expect(ctx.ui.selects).toHaveLength(1);
    expect(ctx.ui.selects[0]?.options).toEqual(["Off", "On"]);
    const prompt = ctx.ui.selects[0]?.title ?? "";
    expect(prompt).toContain(
      "Session Manager authorization is currently disabled.",
    );
    expect(prompt).toContain("visibility");
    expect(prompt).toMatch(/force[- ]?termination|force termination/i);
    expect(ctx.ui.notifies).toContainEqual({
      message: "Session Manager is disabled.",
      type: "info",
    });
  });

  it("enables authorization when the user selects the opposite state", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({ nextSelect: "On" });
    await handler("configure", ctx);

    expect(isAuthorized()).toBe(true);
    expect(ctx.ui.selects[0]?.options).toEqual(["Off", "On"]);
    expect(ctx.ui.notifies).toContainEqual({
      message: "Session Manager is enabled.",
      type: "info",
    });
  });

  it("shows the enabled state first and disables on the opposite selection", async () => {
    const handler = getCommand(commands);
    await handler("configure", createCommandContext({ nextSelect: "On" }));

    const ctx = createCommandContext({ nextSelect: "Off" });
    await handler("configure", ctx);

    expect(isAuthorized()).toBe(false);
    expect(ctx.ui.selects[0]?.options).toEqual(["On", "Off"]);
    const prompt = ctx.ui.selects[0]?.title ?? "";
    expect(prompt).toContain(
      "Session Manager authorization is currently enabled.",
    );
    expect(ctx.ui.notifies).toContainEqual({
      message: "Session Manager is disabled.",
      type: "info",
    });
  });

  it("leaves authorization unchanged when the current state is selected", async () => {
    const handler = getCommand(commands);

    const disabledCtx = createCommandContext({ nextSelect: "Off" });
    await handler("configure", disabledCtx);
    expect(isAuthorized()).toBe(false);
    expect(disabledCtx.ui.notifies).toContainEqual({
      message: "Session Manager is disabled.",
      type: "info",
    });

    await handler("configure", createCommandContext({ nextSelect: "On" }));
    const enabledCtx = createCommandContext({ nextSelect: "On" });
    await handler("configure", enabledCtx);
    expect(isAuthorized()).toBe(true);
    expect(enabledCtx.ui.notifies).toContainEqual({
      message: "Session Manager is enabled.",
      type: "info",
    });
  });

  it("leaves authorization unchanged when configuration is cancelled", async () => {
    const handler = getCommand(commands);

    const disabledCtx = createCommandContext({ nextSelect: undefined });
    await handler("configure", disabledCtx);
    expect(isAuthorized()).toBe(false);
    expect(disabledCtx.ui.notifies).toContainEqual({
      message: "Session Manager is disabled.",
      type: "info",
    });

    await handler("configure", createCommandContext({ nextSelect: "On" }));
    const enabledCtx = createCommandContext({ nextSelect: undefined });
    await handler("configure", enabledCtx);
    expect(isAuthorized()).toBe(true);
    expect(enabledCtx.ui.notifies).toContainEqual({
      message: "Session Manager is enabled.",
      type: "info",
    });
  });

  it("throws typed SessionManagerError outside TUI", async () => {
    const handler = getCommand(commands);
    const ctx = createCommandContext({ mode: "print", hasUI: false });
    let caught: unknown;
    try {
      await handler("configure", ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionManagerError);
    expect((caught as SessionManagerError).code).toBe(ErrorCode.TUI_REQUIRED);
  });
});
