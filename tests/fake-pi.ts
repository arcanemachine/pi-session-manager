import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface FakeCommand {
  name: string;
  definition: {
    description?: string;
    getArgumentCompletions?: (
      prefix: string,
    ) => { value: string; label: string }[] | null;
    handler: (args: string, ctx: FakeCommandContext) => Promise<void>;
  };
}

export interface FakeCommandContext {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  ui: {
    notifies: { message: string; type?: "info" | "warning" | "error" }[];
    selects: { title: string; options: string[] }[];
    nextSelect: string | undefined;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

export interface CommandContextOverrides {
  mode?: FakeCommandContext["mode"];
  hasUI?: boolean;
  nextSelect?: string | undefined;
}

export interface FakePi {
  tools: ToolDefinition[];
  commands: Map<string, FakeCommand>;
}

export function createFakePi(): {
  pi: ExtensionAPI;
  tools: ToolDefinition[];
  commands: Map<string, FakeCommand>;
} {
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, FakeCommand>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand(name: string, definition: FakeCommand["definition"]) {
      commands.set(name, { name, definition });
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands };
}

export function createCommandContext(
  overrides: CommandContextOverrides = {},
): FakeCommandContext {
  const nextSelect = overrides.nextSelect;
  const ctx: FakeCommandContext = {
    mode: overrides.mode ?? "tui",
    hasUI: overrides.hasUI ?? true,
    ui: {
      notifies: [],
      selects: [],
      nextSelect,
      notify(message: string, type: "info" | "warning" | "error" = "info") {
        this.notifies.push({ message, type });
      },
      async select(title: string, options: string[]) {
        this.selects.push({ title, options });
        return this.nextSelect;
      },
    },
  };
  return ctx;
}
