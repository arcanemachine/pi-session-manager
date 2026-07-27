---
title: Pi Session Manager V1
status: execution-in-progress
artifact_type: implementation-plan
scope: standalone Pi extension package
implementation_authority: task-by-task user authorization
current_task: Task 2 — Tmux adapter and inventory
current_owner: pi-session-manager-worker
---

# Pi Session Manager V1 — Executable Implementation Plan

## Execution state and advancement protocol

This section is the durable coordination record for execution across sessions. The Architect/coordinator owns it and must keep it synchronized with reviewed work.

### Current state

- **Task 1 — Package foundation and authorization:** Accepted after implementation, review, correction, and package-local verification.
- **Task 2 — Tmux adapter and inventory:** In progress. Assigned to `pi-session-manager-worker`.
- **Tasks 3–7:** Not started.
- **Outstanding Task 1 live verification:** Real-TUI `/reload` authorization retention and separately spawned-process default-disabled behavior remain deferred to the mandatory live acceptance stage. They were not claimed as completed by Task 1 unit tests.

### Advancement protocol

1. Dispatch only the current authorized task.
2. Review the worker’s implementation and verification evidence against this plan.
3. Return substantial corrections to the same worker; the Architect/coordinator may make only minor corrections directly.
4. After accepting a task, update this section to mark it accepted, record any explicitly deferred verification, and leave the next task not started. Commit that plan advancement in the child repository, then commit the updated submodule pointer in the superproject.
5. Report acceptance to the user and wait for explicit permission to begin the next task.
6. When permission arrives, update this section and frontmatter to mark the next task in progress and name its owner. Commit child-first and then the superproject pointer before dispatching the task.
7. Never mark a task accepted merely because the worker reported completion; acceptance follows Architect/coordinator review.
8. Keep this section concise. Detailed requirements and completion criteria remain authoritative in the task sections below.

## 1. Purpose and authority

This document is the authoritative implementation plan for the first version of `pi-session-manager`.

It converts the earlier exploratory seed and the subsequent Architect/user decision process into a standalone, executable package plan. Future implementation owners must follow this document rather than reconstructing intent from conversation history or from the earlier seed at `/workspace/tmp/PLAN.pi-session-manager.md`. Where the seed conflicts with this plan, this plan is authoritative.

This plan does not itself authorize implementation. It is designed to be assigned to a future implementation owner. Once assigned, the owner should not make new product or architecture decisions from convenience or inference. Stop and return to the user if a material mechanism cannot be implemented as specified.

The package is intentionally independent of `inter-agent`, `pi-role`, `pi-session-snapshot`, and `pi-subagent`. Those packages may supply arguments or complementary behavior to Pi processes created here, but `pi-session-manager` must not import them, inspect their storage, depend on their protocols, or reproduce their responsibilities.

## 2. Product objective

Build a Pi extension that gives one user-authorized Pi process a simple agent-callable interface for creating and observing fleets of independent, normal Pi TUI processes hosted in a dedicated tmux server.

The extension provides the terminal/process-hosting layer:

- one isolated tmux server for all managed fleets;
- one tmux session per fleet;
- one full tmux window per Pi instance;
- normal interactive Pi running directly inside each window;
- agent tools to list, view, create, close, and force-close managed windows;
- ordinary tmux attachment for the human user;
- process-local, human-granted authority controlling every agent tool.

The extension does **not** control the work performed inside those Pi processes. A separate system such as inter-agent may later prompt, steer, abort, or gracefully shut down a worker. The user may also attach through tmux and interact with a worker directly. Session Manager remains agnostic to both mechanisms.

## 3. Product mental model

```text
one dedicated tmux server
│
├── tmux session: myproject-worker
│   ├── window 1: normal interactive Pi process
│   ├── window 2: normal interactive Pi process
│   └── window 3: retained running or exited Pi process
│
├── tmux session: myproject-reviewer
│   ├── window 1: normal interactive Pi process
│   └── window 2: normal interactive Pi process
│
└── tmux session: otherproject-worker
    └── window 1: normal interactive Pi process
```

A fleet name conventionally uses `<project>-<role>`, but the package treats the complete fleet name as an opaque validated namespace. It does not understand roles.

The instance number is the human-facing tmux window index. Windows begin at index `1`. Stable tmux IDs, not the mutable textual target alone, protect mutations against races and mistaken identity.

## 4. Terminology

- **Manager Pi:** The Pi process in which this extension is loaded and for which the user has enabled Session Manager authority.
- **Worker:** A separately running normal interactive Pi process hosted inside a managed tmux window. “Worker” is generic and does not imply a `pi-role` role.
- **Dedicated server:** The tmux server selected by Session Manager’s explicit socket path. It is distinct from the user’s default tmux server.
- **Fleet:** One tagged tmux session inside the dedicated server.
- **Instance:** One tagged tmux window, containing exactly one managed pane and one directly launched Pi process.
- **Managed object:** A tmux session or window carrying the exact Session Manager V1 ownership metadata defined below.
- **Running instance:** A managed one-pane window whose pane is not dead.
- **Exited instance:** A managed one-pane window retained by `remain-on-exit` after Pi exits.
- **Close:** Remove an exited managed window. It must not terminate a live process.
- **Force close:** Remove a live managed window and thereby terminate its process. This is an explicit exceptional action.
- **Authorization:** A process-local Boolean granted only by a human through the TUI. It gates every agent-callable Session Manager operation.

Do not use bare “session” where it could mean a Pi conversation session, a tmux session, or an extension runtime. Qualify it.

## 5. Accepted V1 decisions

### 5.1 Standalone boundary

- This is a standalone Pi extension/package.
- No dependency on inter-agent, role, snapshot, subagent, or another Pi extension.
- The caller may pass flags belonging to those systems through an opaque Pi argument array.
- Session Manager does not determine whether a worker is connected to a bus, has a role, is semantically ready, or has completed a task.

### 5.2 Tmux topology

- Use one dedicated tmux server selected by an explicit socket path.
- Use multiple tmux sessions within it.
- Each fleet is one tmux session.
- Each instance is one full window containing one pane.
- Window indexing begins at `1`.
- Do not automatically renumber windows.
- Retain panes after process exit.
- Load the user’s ordinary tmux configuration, then enforce only the manager-critical options.
- Require tmux 3.5 or newer. The current development environment has tmux 3.5a, which satisfies this requirement.

### 5.3 Tmux as the sole source of truth

There is no external registry in V1.

The dedicated tmux server supplies:

- fleet and window existence;
- stable session/window/pane identity;
- process running/dead status;
- PID/current command/current path;
- exit status, signal, and time;
- attached-client state;
- captured terminal contents.

Minimal tmux user options identify objects created by this package. Because ownership metadata lives on the object, manually deleting a window deletes its metadata at the same time. There is no second source to drift.

If the dedicated tmux server is destroyed, fleet awareness is lost. This is accepted: the hosted terminals and processes have also been destroyed, and a filesystem registry could not recover them.

### 5.4 Authorization

- Every agent tool is registered and remains active at all times.
- Every operation, including list and view, is denied until the user authorizes this Pi process.
- Tool activation must never be changed with `pi.setActiveTools()` as part of authorization.
- Authorization is off by default.
- Only a user-facing command can change it.
- Enabling and disabling both require a real human confirmation in interactive TUI mode.
- No startup authorization flag exists.
- No tool can enable or disable authorization.
- Authorization survives `/reload`, `/new`, `/resume`, and `/fork` within the same OS Pi process.
- Authorization disappears when that process exits.
- Authorization does not propagate to separately launched Pi workers.
- No persistent footer/status item is shown. The user may explicitly query status.

### 5.5 Agent tools

Register exactly these V1 tools:

- `pi_fleet_list`
- `pi_fleet_view`
- `pi_fleet_create`
- `pi_fleet_close`
- `pi_fleet_force_close`

There is no bulk-create tool. Pi’s ordinary batched tool calls may contain several individual `pi_fleet_create` calls. Mutating tool executions must be sequential within one Pi process.

### 5.6 Human navigation

- The human uses ordinary tmux to attach, select sessions, and switch windows.
- The extension may return exact attachment commands.
- It does not switch, attach, detach, or refocus the user’s terminal automatically.
- There is no V1 “teleport” UI.

## 6. Explicit non-goals

Do not add any of the following to V1:

- semantic prompts, steering, follow-ups, abort, or graceful Pi shutdown;
- inter-agent integration or readiness checks;
- role interpretation or role discovery;
- snapshot discovery or snapshot-package integration;
- RPC-mode workers or a custom RPC TUI;
- `tmux send-keys` as a control mechanism;
- a filesystem registry, database, daemon, or background supervisor;
- automatic process restart;
- arbitrary shell command strings;
- arbitrary executable selection;
- per-worker environment overrides;
- bulk fleet APIs;
- machine-to-machine or multi-user authorization;
- hiding or dynamically unregistering tools based on authorization;
- persistent authorization in JSONL, settings, files, flags, or environment variables;
- automatic adoption of existing tmux sessions/windows;
- modification of untagged tmux objects;
- deletion of Pi JSONL conversation history or project files;
- Git branch/worktree/project provisioning;
- an interactive fleet cleanup menu;
- native Windows support outside a POSIX/tmux environment.

## 7. Verified technical evidence

### 7.1 Pi extension behavior

The current Pi extension API supports:

- `pi.registerTool()` with strict TypeBox schemas;
- static `promptSnippet` and `promptGuidelines` metadata;
- `pi.registerCommand()` for `/session-manager`;
- TUI-only user confirmation via `ctx.ui`;
- stable tool registration across runtime state changes;
- sequential tool execution where shared state or ordered mutations require it;
- bounded output/truncation utilities;
- `/reload`, which replaces the extension runner and extension instance.

Extension commands do not expose documented invocation provenance. A command injected programmatically may look like a human command to its handler. Therefore command spelling is not the authorization boundary: changing authorization requires `ctx.mode === "tui"`, `ctx.hasUI`, and an actual TUI choice defaulting to No.

### 7.2 Process-local reload precedent

The maintained inter-agent Pi integration uses `globalThis[Symbol.for(...)]` for same-process reload handoff state:

- `projects/inter-agent/integrations/pi/src/mailbox.ts`, `createProcessGlobalHandoffCarrier()`;
- its unit tests verify that a fresh extension-side instance sees the same process-global symbol state.

Session Manager reuses only this JavaScript architecture pattern, not code or a dependency. A process-global Boolean is simpler than inter-agent’s one-use, versioned, expiring mailbox handoff.

The role package’s `pi.appendEntry()` restoration pattern was evaluated and rejected for authorization. Session entries survive process restart/resume and are cleared or inherited according to Pi session history. That lifetime is deliberately different from this package’s process-local authority.

### 7.3 Tmux behavior

Tmux 3.5a provides:

- `-S socket-path` for an explicit independent server;
- stable `$` session, `@` window, and `%` pane IDs;
- direct execution of multi-argument `new-session`/`new-window` commands without `sh -c`;
- `base-index`, `renumber-windows`, and `remain-on-exit`;
- `list-sessions`, `list-windows`, `list-panes`, and custom formats;
- custom `@...` user options;
- `pane_dead`, `pane_dead_status`, `pane_dead_signal`, `pane_dead_time`, `pane_pid`, `pane_current_command`, and `pane_current_path` formats;
- `capture-pane` with bounded history selection and plain stdout output;
- attached-client inspection;
- `kill-window` for both dead-window cleanup and live-process termination;
- global/session environment inheritance;
- direct user attachment with the same socket path.

## 8. Package and repository requirements

The child repository is `git@github.com:arcanemachine/pi-session-manager.git` and lives as a submodule at:

```text
packages/pi-session-manager
```

The implementation must eventually add at least:

```text
AGENTS.md
README.md
CHANGELOG.md
LICENSE.md
package.json
tsconfig.json
src/index.ts
src/authorization.ts
src/tmux.ts
src/tools.ts
src/types.ts
tests/
```

This file is the authoritative pre-implementation artifact and precedes all package implementation commits.

The package should be independently installable. It must declare all of its own runtime, peer, and development dependencies. It must not rely on undeclared root-workspace dependencies.

Expected package metadata:

- package name: `pi-session-manager`;
- initial implementation version: `0.1.0` unless the project convention established during implementation requires another prerelease value;
- ESM TypeScript package;
- `pi-package` keyword;
- `pi.extensions: ["./src/index.ts"]`;
- peer dependencies on Pi-provided packages used by source, with `"*"` ranges as documented;
- no external tmux wrapper dependency;
- no production dependency on any sibling Pi package.

Use Node built-ins and Pi’s public extension API. Invoke tmux as a process with an argument array and `shell: false`.

## 9. State directory and dedicated socket

Resolve Pi’s agent directory as:

1. a nonblank `PI_CODING_AGENT_DIR`, when set;
2. otherwise `~/.pi/agent`.

Use:

```text
<agent-dir>/pi-session-manager/
<agent-dir>/pi-session-manager/tmux.sock
```

Requirements:

- create the package state directory as owner-only (`0700`) where supported;
- never place authorization state there;
- every tmux invocation must include the explicit `-S <socket-path>` pair;
- never run an unqualified tmux mutation that could reach the default server;
- treat a socket owned by an incompatible/non-manager server conservatively: inspect tags and reject collisions rather than taking it over destructively;
- allow tmux to remove its socket normally when the empty server exits.

Do not use `-L`: an explicit path is deterministic across manager Pi processes and independent of differing `TMUX_TMPDIR` values.

## 10. Tmux configuration contract

Start the dedicated server using the normal tmux configuration search. Do not use `-f /dev/null`.

Before creating the first fleet, enforce these options on the dedicated server/global defaults using explicit socket-qualified commands:

```text
base-index 1
renumber-windows off
remain-on-exit on
extended-keys on
extended-keys-format csi-u
```

Use the correct explicit option scopes (`session` versus `window`) determined from tmux 3.5 syntax. Do not depend on inference when an explicit scope flag is available.

Also disable automatic renaming on managed windows so a stable descriptive name remains visible.

Do not change unrelated user options, status styling, prefix keys, colors, or bindings. The purpose of normal config loading is to preserve the user’s expected tmux interaction while overriding only invariants required by this package.

Tmux servers normally exit when no sessions remain. Preserve that default. Do not create a permanent keeper or hidden administrative session.

## 11. Managed-object metadata

Use distinct option names so session and window option inheritance cannot make an untagged window appear tagged.

### 11.1 Fleet session tag

```text
@pi-session-manager-fleet-version = v1
```

The tmux session name is the canonical fleet name.

### 11.2 Worker window tags

```text
@pi-session-manager-window-version = v1
@pi-session-manager-instance = <positive integer as decimal text>
@pi-session-manager-pane-id = <stable %pane-id>
```

The window index must equal the instance integer.

The window name should be:

```text
<fleet>-<instance>
```

The stored pane ID identifies the one managed pane. A managed window must contain exactly one pane. If a human manually splits it, list it as ambiguous and refuse agent view/close/force-close operations until the user restores a one-pane shape or handles it manually.

### 11.3 Tag policy

- Only exact V1 tags are managed.
- Missing, partial, unsupported-version, malformed, or contradictory tags are warnings, not managed targets.
- Do not automatically repair or adopt them.
- Do not mutate an untagged object even if its name/index looks valid.
- User options are ownership metadata, not a security boundary. Anyone with same-user socket access can edit them.

## 12. Authorization design

### 12.1 Process-global storage

Create a package-local helper in `src/authorization.ts` using:

```text
Symbol.for("pi-session-manager.authorization.v1")
```

Store a small versioned object on `globalThis`:

```typescript
interface AuthorizationStateV1 {
  version: 1;
  enabled: boolean;
}
```

Requirements:

- initialize absent or malformed state to `{ version: 1, enabled: false }`;
- reuse the same object across extension re-evaluation in the same JavaScript process;
- never serialize it;
- never put it in `process.env`;
- never append it to the Pi transcript;
- never expose it through worker arguments or tmux options;
- allow a test-only reset seam that is not registered as a Pi command or tool;
- document that this is a same-process capability guard, not protection from another trusted extension executing arbitrary code in the same process.

Do not add inter-agent’s generation, TTL, session ID, one-use consumption, or handoff lifecycle. Those solve mailbox transfer, not a persistent-in-process Boolean.

### 12.2 User command

Register one command:

```text
/session-manager on
/session-manager off
/session-manager status
```

Behavior:

- Trim and parse one argument.
- With no/unknown argument, show concise usage without changing state.
- `status` reports enabled/disabled using a transient notification only.
- `on` and `off` reject outside interactive TUI or without a real UI.
- Both state changes require an actual two-choice user prompt with **No selected by default**.
- If the basic Pi confirm widget cannot guarantee No as the initial selection, use `ctx.ui.select()` with `No` as the first/default item and `Yes` as the deliberate second item. Do not silently assume default selection.
- Cancellation or No leaves state unchanged.
- A successful state change produces a concise notification.
- Do not set a footer status, widget, title, custom entry, or persistent transcript item.

Suggested confirmation text must state that enabling grants this Pi agent visibility and process/window lifecycle authority over the dedicated fleet, including force termination. Disabling text may be shorter but still requires human confirmation so an injected command cannot revoke authority silently.

### 12.3 Tool authorization guard

Every tool must call one shared guard before inspecting tmux or revealing fleet data.

An unauthorized call must fail with a minimal, actionable error equivalent to:

```text
Session Manager is disabled. The user must run /session-manager on and confirm access. Do not retry until the user enables it.
```

Signal tool failure by throwing as Pi’s extension API requires. Do not return an ordinary-success result containing an error string.

Tool schemas and static prompt metadata must remain unchanged when authorization toggles.

## 13. Child process environment

Workers use the ordinary environment inherited from the Manager Pi/tmux process chain, subject only to removal of parent Pi session metadata:

```text
PI_SESSION_ID
PI_SESSION_FILE
PI_PROVIDER
PI_MODEL
PI_REASONING_LEVEL
```

Requirements:

- preserve `PATH`, `HOME`, credentials, provider configuration, shell settings, `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, and other ordinary/Pi configuration variables;
- do not add manager-specific environment variables;
- do not expose a V1 per-worker environment field;
- ensure the tmux client/server process used for creation receives the sanitized environment so stale parent metadata does not become the server’s global environment;
- Pi workers still receive tmux’s normal `TMUX`, `TMUX_PANE`, and terminal variables;
- document that future explicit environment overrides are deferred until a demonstrated need exists.

Use a Node process-execution helper with `shell: false`, explicit environment, bounded stdout/stderr, timeout, and cancellation support. It may wrap `node:child_process.spawn`/`execFile` or a Pi public execution helper only if that helper demonstrably supports the required environment control. Do not fall back to a shell string.

## 14. Common tmux adapter requirements

Create one narrow tmux adapter rather than scattering commands through tool handlers.

Responsibilities:

- resolve/check tmux executable through `PATH`;
- obtain and parse `tmux -V`;
- reject versions below 3.5 with a precise error;
- resolve/create the state directory and socket path;
- execute every command against `-S <socket>`;
- use argument arrays and `shell: false`;
- enforce short bounded command timeouts;
- capture bounded stdout/stderr;
- distinguish “server absent” from command failure where tmux exit codes/messages permit;
- query sessions/windows/panes/clients with explicit machine-readable tab- or record-separated formats;
- parse output without depending on localized human prose;
- validate all returned IDs and numeric/status fields;
- keep user-supplied text out of tmux format expressions;
- centralize error redaction and formatting;
- never print environment contents or credentials.

Tool handlers should operate on typed snapshots returned by this adapter.

## 15. Identity and mutation safety

Every mutation follows a lookup-then-revalidate pattern:

1. Resolve the fleet and instance through a fresh tmux inventory.
2. Verify exact fleet/session and window tags.
3. Record stable session/window/pane IDs.
4. Verify the managed window has exactly one pane and its stable ID matches the pane tag.
5. Inspect attached clients and current live/dead state.
6. Immediately before mutation, query the stable IDs again.
7. Reject if the object disappeared, changed identity, changed tags, gained panes, or changed relevant state.
8. Mutate by stable window ID, not by name/index alone.
9. Query again to confirm the expected result.

Never pass tmux’s destructive `-k` option during creation. Never automatically replace a collision.

## 16. Attached-human protection

Agent tools must not disrupt an actively viewed target window.

A window is protected when any client attached to its fleet session currently has that window active. Closing the last window of an attached fleet is therefore also protected.

Both ordinary and force close must reject a protected target. Force close bypasses only the live-process restriction; it does not bypass the attached-human restriction.

The error should state that a human is viewing the target and must switch away or detach before retrying. Do not switch or detach the client automatically.

Manual tmux commands remain the user’s emergency override.

## 17. Tool contracts

All tool outputs must be concise, deterministic, and bounded. Put machine-meaningful data in typed `details` and return an LLM-readable text summary in `content`. Do not expose credentials or environment dumps.

Use `StringEnum` from `@earendil-works/pi-ai` where a tool schema needs string enums. Do not use incompatible literal unions.

### 17.1 `pi_fleet_list`

Purpose: List current managed fleets/instances from tmux.

Parameters:

```typescript
{
  fleet?: string
}
```

Rules:

- With no filter, list every exact V1-managed fleet and instance.
- With a fleet filter, validate it using the same fleet-name rules and list only that fleet.
- If the dedicated server is absent, return an empty successful inventory, not an infrastructure error.
- Do not reveal inventory while unauthorized.
- Ignore completely untagged objects for the managed result.
- Include a compact warning count/section for partially tagged, malformed, unsupported-version, or structurally ambiguous objects without exposing them as manageable targets.

For each managed instance report:

- fleet;
- instance;
- state: `running` or `exited`;
- stable session/window/pane IDs;
- window name/index;
- current command and PID when running;
- current pane path when available;
- dead exit status/signal/time when exited;
- whether a client is actively viewing it;
- exact human attachment command using the explicit socket and fleet target.

Do not report `ready`, `connected`, `idle`, `busy`, or task completion.

### 17.2 `pi_fleet_view`

Purpose: Return a bounded terminal view without changing focus.

Parameters:

```typescript
{
  fleet: string;
  instance: number;
  lines?: number; // default 100, minimum 1, maximum 500
}
```

Rules:

- Require authorization and exact managed identity.
- Require exactly one pane matching the stored pane ID.
- Permit both running and exited panes.
- Use `capture-pane` against the stable pane ID.
- Return plain text without ANSI styling/escape sequences.
- Join wrapped lines where tmux’s safe capture mode supports it.
- Respect the requested line bound and Pi’s 50KB/2000-line tool-output ceiling; the stricter bound wins.
- State clearly when output is truncated.
- Never write full output to a persistent project file.
- Never enter copy mode, attach a client, select a window, send keys, or change focus.
- Treat terminal capture as observational. It is not semantic Pi state.

Pi uses a full-screen terminal and may use an alternate screen. Integration tests must establish the correct `capture-pane` option combination for live Pi output and retained dead output. If one option cannot faithfully capture both, implement a bounded documented fallback rather than screen scraping through another mechanism.

### 17.3 `pi_fleet_create`

Purpose: Create one Pi instance.

Parameters:

```typescript
{
  fleet: string;
  instance: number;
  cwd?: string;      // defaults to ctx.cwd
  piArgs?: string[]; // defaults to []
}
```

Validation:

- `fleet` must match `[a-z0-9][a-z0-9_-]{0,63}`.
- `instance` must be a positive integer.
- `cwd` must resolve to an existing directory. Resolve relative cwd against the Manager Pi’s `ctx.cwd`; report the resolved absolute path.
- Bound the number and encoded size of `piArgs` to prevent pathological command lines. Use generous practical limits, document them in the schema, and do not silently truncate.
- Each argument remains one argument. Do not join or reinterpret it as shell syntax.

Creation behavior:

1. Require authorization.
2. Check tmux version and state directory.
3. Sanitize parent session environment.
4. Inventory the dedicated server.
5. If the fleet is absent, require `instance === 1`.
6. If a same-named untagged/malformed fleet exists, reject; never adopt it.
7. If the managed fleet exists, verify its tag/version.
8. Reject any occupied requested window index, tagged or untagged.
9. Ensure critical tmux options.
10. Create the first fleet with `new-session -d` or a later instance with `new-window -d`.
11. Pass `pi` and every `piArgs` item as separate command arguments so tmux executes Pi directly without `sh -c`.
12. Set the stable descriptive window name and disable automatic rename.
13. Capture stable session/window/pane IDs from tmux machine-readable output.
14. Apply exact session/window tags.
15. Re-read and validate the created object.
16. Return `running` or `exited` based on the observed pane state.

Creation success means the managed tmux window exists and has been tagged/validated. It does not mean Pi is semantically ready or connected to another extension.

If Pi exits immediately but the retained pane is tagged correctly, creation may succeed with `state: exited` and must report exit details.

If creation succeeds but tagging/validation fails, make a bounded best-effort cleanup of the exact newly created stable window only after confirming no human client has attached to it. Report both the original failure and cleanup outcome. Do not leave a live, untagged process silently. If safe cleanup is impossible, report the unmanaged stable ID prominently and stop; never guess.

A duplicate managed instance is an error, not idempotent success, because the original cwd/arguments are not stored and cannot be proven equivalent.

### 17.4 `pi_fleet_close`

Purpose: Remove one exited managed window.

Parameters:

```typescript
{
  fleet: string;
  instance: number;
}
```

Rules:

- Require authorization.
- Require exact V1 tags, stable identity, and one matching pane.
- Reject a running pane with guidance to end Pi gracefully through the user or another control mechanism.
- Reject if a human client is actively viewing the target.
- Kill the exact dead window by stable ID.
- Verify disappearance.
- If it was the final window, allow the fleet session/server to disappear naturally.
- Do not delete Pi JSONL session files, snapshots, cwd files, or any other filesystem state.

### 17.5 `pi_fleet_force_close`

Purpose: Explicitly remove a live managed window, terminating its process.

Parameters:

```typescript
{
  fleet: string;
  instance: number;
  confirmProcessTermination: true;
}
```

Schema and runtime must require the Boolean to be exactly `true`.

Rules:

- Require authorization.
- Require exact V1 tags, stable identity, and one matching pane.
- Require a live pane. If already exited, reject with guidance to use `pi_fleet_close`.
- Reject if a human client is actively viewing the target.
- State in prompt metadata and call rendering that this action terminates a live process.
- Kill the exact window by stable ID.
- Verify disappearance.
- Report that the process was terminated by tmux window removal.
- Do not attempt `ctx.shutdown()`, send terminal input, or contact another extension first.

No free-text reason field is included. It would be ceremonial and add no enforcement. The explicit tool name, human-granted manager authorization, live-state check, prompt guidance, and required confirmation Boolean are the chosen guardrails.

## 18. Static tool prompt guidance

Tool schemas remain active regardless of authorization. Use stable prompt metadata that does not change when the Boolean changes.

Every guideline must name the relevant tool explicitly, because Pi appends tool guidelines flat without a tool-name prefix.

Required intent:

- Session Manager tools require prior user authorization through `/session-manager on`.
- If a call reports disabled, do not retry or try to enable it; wait for the user.
- Use `pi_fleet_create` only for normal interactive Pi TUI instances.
- Use `pi_fleet_view` for bounded observation, not as task-completion evidence.
- End a Pi process gracefully through the user or the appropriate control extension before `pi_fleet_close`.
- Use `pi_fleet_force_close` only when a live instance genuinely must be terminated and ordinary graceful control is unavailable or has failed.
- Never force close merely to tidy a fleet or because an instance is slow.
- Never use these tools to manipulate the default tmux server.

Keep guidance direct and compact enough not to bloat every prompt.

## 19. Error taxonomy and reporting

Use typed internal errors and stable concise messages. At minimum distinguish:

- `SESSION_MANAGER_DISABLED`
- `TUI_REQUIRED`
- `USER_CANCELLED`
- `TMUX_NOT_FOUND`
- `TMUX_VERSION_UNSUPPORTED`
- `TMUX_SERVER_ERROR`
- `INVALID_FLEET`
- `INVALID_INSTANCE`
- `INVALID_CWD`
- `INVALID_PI_ARGS`
- `FLEET_NOT_FOUND`
- `FLEET_COLLISION`
- `INSTANCE_NOT_FOUND`
- `INSTANCE_COLLISION`
- `UNMANAGED_TARGET`
- `UNSUPPORTED_TAG_VERSION`
- `AMBIGUOUS_WINDOW`
- `IDENTITY_CHANGED`
- `INSTANCE_RUNNING`
- `INSTANCE_EXITED`
- `INSTANCE_VIEWED_BY_USER`
- `CONFIRMATION_REQUIRED`
- `CAPTURE_FAILED`
- `CREATE_PARTIAL_FAILURE`

Do not expose raw stack traces or environment values to the model. Preserve bounded tmux stderr when it materially helps, prefixed with the stable error class.

Errors caused by expected user state should be specific and actionable. Do not hide collisions or partial cleanup failures behind “tmux failed.”

## 20. Concurrency and batching

Pi executes sibling tools in parallel by default. Shared tmux mutations require deterministic ordering.

Requirements:

- Configure `pi_fleet_create`, `pi_fleet_close`, and `pi_fleet_force_close` for sequential execution.
- Preserve assistant source order so a batch creating instances 1, 2, and 3 initializes the fleet in that order.
- `pi_fleet_list` and independent views may remain parallel if they do not mutate shared adapter state.
- Do not add a bulk API.
- Do not use a filesystem lock or external registry in V1.
- Tmux server command processing and fail-closed collision checks handle cross-process races.
- If two separately authorized Manager Pi processes race to create the same instance, one must succeed and the other must return a collision; neither may overwrite the winner.
- Revalidate stable IDs before every mutation because list/view/create batches may interleave with direct user tmux actions.

## 21. Fleet initialization and lifecycle

### 21.1 New fleet

- A fleet not currently present must begin with instance `1`.
- Do not create a hidden/keeper/bootstrap window.
- Set global defaults before the first session’s initial window is allocated so it receives index `1`.
- Tag and validate the new fleet and window.

### 21.2 Existing fleet

- Later instance numbers may contain gaps.
- Creating an occupied index is always an error.
- Window indexes are not automatically compacted when one closes.

### 21.3 Pi exit

- `remain-on-exit on` retains the window.
- List reports `exited` with available exit details.
- View remains available.
- The instance remains fleet-aware until explicitly closed or manually removed through tmux.

### 21.4 Explicit close

- Dead-window close removes the window.
- Final-window close naturally removes the fleet session and may stop the empty tmux server.
- No empty fleet definition remains.

### 21.5 Direct human tmux mutation

- Manual window/session deletion is valid.
- Removed objects and their tags disappear together.
- Session Manager does not recreate them.
- Manual renaming or tag modification may cause the object to become unmanaged or contradictory; report warnings and refuse mutation.
- Manual pane splitting causes ambiguity; refuse managed mutations.

## 22. Security and capability posture

- Pi extensions have full user permissions. The authorization Boolean protects against accidental or undesired agent use, not malicious same-process code.
- Tmux socket separation prevents accidental interaction with the default server but is not a hostile same-user security boundary.
- Anyone who can access the dedicated socket can use ordinary tmux commands.
- Terminal capture may contain sensitive content. This is why list/view are authorization-gated.
- Never expose environment dumps, credentials, full unbounded scrollback, or other processes’ terminal data.
- Do not build multi-user access, secrets, ACLs, or remote tmux support into V1.
- Fail closed on malformed tags, unstable identity, multiple panes, attached users, and partial creation.

## 23. Required implementation reading

Before implementation, the assigned owner must read the most-specific `AGENTS.md` files first, then the following current sources completely or as narrowly indicated:

- `projects/pi/AGENTS.md`
- `projects/pi/packages/pi-session-manager/PLAN.md`
- package-local `AGENTS.md` after it is created
- `/workspace/.agents/languages/nodejs.md`
- Pi documentation:
  - `docs/extensions.md`
  - `docs/packages.md`
  - `docs/usage.md`
  - `docs/environment-variables.md`
  - `docs/tmux.md`
  - `docs/tui.md` only if implementing custom rendering/UI beyond basic notifications/selectors
- Pi examples:
  - `examples/extensions/tools.ts`
  - `examples/extensions/commands.ts`
- local `tmux(1)` documentation for the installed/runtime version, specifically socket selection, option scopes, direct multi-argument execution, formats, user options, capture-pane, clients, stable IDs, and kill-window.

Follow documentation cross-references required by Pi’s project instructions. Do not inspect sibling package implementations unless a concrete unresolved implementation question requires a separately approved comparison.

## 24. Detailed implementation sequence

### Task 1 — Package foundation and authorization

Create the independent package foundation:

- package manifest and Pi extension entrypoint;
- TypeScript configuration;
- license, README skeleton, changelog, and package guidance;
- process-global authorization helper;
- `/session-manager on|off|status` command;
- five registered tool skeletons with static metadata and common authorization rejection;
- focused unit tests for authorization lifetime helper, command parsing, default-No behavior, and stable tool registration.

Verification:

- package typecheck;
- package tests;
- `/reload` integration proving the same process retains authorization;
- new separately spawned Pi process begins disabled;
- no session/custom entry or file contains authorization.

Stop if process-global state does not survive the actual supported Pi runtime. Do not substitute session JSONL persistence.

### Task 2 — Tmux adapter and inventory

Implement:

- state/socket resolution;
- sanitized process environment;
- bounded shell-free tmux execution;
- tmux version check;
- server absence detection;
- critical option application;
- machine-readable session/window/pane/client queries;
- ownership tag parsing;
- typed managed/ambiguous inventory;
- attached-client detection;
- exact attachment command rendering.

Use isolated temporary sockets in integration tests. Never touch the default server.

Verification includes tmux 3.5a behavior for:

- one-based windows;
- no renumbering;
- retained dead panes;
- normal user config plus enforced critical options;
- stable IDs and user options;
- one-pane validation;
- active-client detection;
- empty server behavior.

### Task 3 — Create tool

Implement the complete `pi_fleet_create` contract, including:

- input validation;
- first-instance rule;
- collision handling;
- direct `pi` argument execution;
- environment sanitation;
- tagging and revalidation;
- immediate-exit reporting;
- partial-failure cleanup;
- sequential tool execution.

Integration tests should use harmless fixture commands through a test seam rather than launching paid/model-backed Pi sessions for every case. Production remains fixed to `pi`; the test seam must not become a public arbitrary executable option.

Add a bounded live test for a real Pi TUI only in the acceptance stage.

### Task 4 — List and view tools

Implement:

- complete managed inventory output;
- optional fleet filter;
- malformed/partial-tag warnings;
- bounded running/dead terminal capture;
- no focus/client mutation;
- compact default rendering and structured details.

Verify capture behavior with a full-screen terminal fixture and a normal Pi TUI during acceptance.

### Task 5 — Close and force-close tools

Implement:

- stable identity revalidation;
- one-pane/tag checks;
- dead-only ordinary close;
- live-only force close;
- required confirmation Boolean;
- attached-human protection;
- disappearance verification;
- final fleet/server disappearance behavior;
- strong static prompt guidance.

Test with harmless long-running and exited fixture processes. Never use a real user process as an automated force-close fixture.

### Task 6 — Documentation and superproject integration

Complete child documentation:

- installation and independent package use;
- tmux 3.5 requirement;
- dedicated socket path;
- fleet naming and tool examples;
- authorization UX;
- direct human attachment commands;
- force-close warning;
- source-of-truth/tag behavior;
- limitations and non-goals;
- child-tool restriction examples only after exact tool names are verified, otherwise retain as a follow-up rather than guessing.

Integrate into `projects/pi`:

- add `./packages/pi-session-manager/src/index.ts` to root `package.json` Pi extensions;
- add the package to root README package list;
- update root lockfile only as dependency/workspace changes require;
- validate from the root without running the destructive root formatter;
- commit child changes first, then the superproject pointer/integration changes.

### Task 7 — Full verification and user acceptance

Run package and root checks, inspect diffs, then execute the approved live acceptance surface below. Do not declare user-facing completion before explicit user acceptance.

## 25. Test strategy

### 25.1 Pure unit tests

- fleet-name validation;
- instance validation;
- cwd resolution;
- Pi argument limits and preservation;
- parent PI session-variable removal;
- version parsing including `3.5`, `3.5a`, newer versions, and rejection below 3.5;
- tmux format parsing;
- ownership tag validation;
- malformed/partial/unsupported tag classification;
- one-pane invariant;
- attached-client policy;
- domain error mapping;
- authorization default, enable, disable, and test reset;
- tool metadata/guidance remains stable across authorization toggles.

### 25.2 Hermetic tmux integration tests

Every test suite uses a unique temporary `-S` socket and cleans up only its own server/processes.

Cover:

- default tmux server remains untouched;
- server/session/window creation;
- first window is index 1;
- gaps remain after close;
- tags and stable IDs;
- direct multi-argument execution without shell expansion;
- cwd behavior;
- sanitized environment;
- duplicate and untagged collisions;
- process exits retained;
- exit code/signal/time reporting;
- bounded capture;
- multiple-pane ambiguity;
- direct manual deletion;
- ordinary dead close;
- live close rejection;
- force close confirmation rejection/success;
- attached active client rejection;
- final-window session/server disappearance;
- concurrent duplicate creation produces one winner and one collision;
- partial create/tag failure behavior through controlled test seams.

Before test cleanup, inspect attached clients. Never kill a test tmux session with an attached human client.

### 25.3 Pi extension integration tests

Cover:

- all tools remain registered while disabled;
- every disabled tool rejects before querying tmux;
- user command unavailable outside TUI for state changes;
- default-No cancellation;
- authorization survives real `/reload`;
- authorization survives same-process session replacement;
- authorization does not survive process exit;
- child Pi process starts unauthorized;
- batched create tool calls execute sequentially;
- tool errors reach Pi as failed tool results;
- no status/footer pollution.

### 25.4 Root validation

From `projects/pi`:

- targeted package install/dependency command as required;
- child format check, typecheck, and tests;
- root `pnpm run typecheck` and `pnpm run test` when proportionate and compatible with the current workspace state;
- `git diff --check` in child and parent;
- verify no sibling package was formatted or modified;
- inspect child commit before updating the superproject pointer.

Follow the documented Vitest capture workaround if output is unexpectedly empty. Do not run the root formatter.

## 26. Mandatory live user acceptance

User-facing behavior requires explicit user acceptance before architecture acceptance, integration closeout, or closure-equivalent reporting.

The final owner must guide the user through:

1. Start a Manager Pi with the extension loaded.
2. Confirm tools are visible but calls fail while disabled.
3. Run `/session-manager on`; verify default-No confirmation and deliberately enable.
4. Submit one batch containing individual create calls for `myproject-worker` instances 1, 2, and 3.
5. Verify all create sequentially and become separate one-based windows.
6. Create another fleet such as `myproject-reviewer` to verify multiple sessions in one dedicated server.
7. Attach manually using the reported `tmux -S ... attach -t ...` command.
8. Verify each worker is a normal interactive Pi TUI with expected key behavior.
9. Interact locally with one Pi; verify Session Manager has not sent keystrokes or semantic control messages.
10. Return to the Manager Pi and use list/view; verify bounded output and no terminal focus change.
11. Exit one worker Pi normally; verify its dead window remains visible and reports exit details.
12. Close that dead instance through `pi_fleet_close`.
13. Attempt ordinary close on a disposable live worker; verify rejection.
14. Attempt force close without the confirmation Boolean; verify rejection.
15. Force close the disposable live worker with explicit confirmation; verify process/window disappearance.
16. Attach a client to/select another target and verify both close operations refuse to disrupt the viewed window.
17. Manually remove a disposable managed window through tmux and verify it disappears without stale registry state.
18. Create an untagged diagnostic window in the dedicated server; verify tools do not mutate it and report/ignore it according to the contract.
19. Run `/reload`; verify authorization remains enabled without a persistent status item.
20. Run `/session-manager status`; verify enabled.
21. Start a separate Pi process; verify Session Manager begins disabled there.
22. Disable the Manager Pi with `/session-manager off` and human confirmation; verify all tools reject again.
23. Confirm the user’s default tmux server and unrelated sessions were never modified.

Do not use valuable sessions for force-close acceptance. Use explicitly disposable workers.

## 27. Completion criteria

V1 is complete only when:

- all five tools match their exact contracts;
- authorization lifetime and human gate match this plan;
- tmux is the sole authority with exact ownership tags;
- ordinary and force close respect live/dead and attached-human boundaries;
- batched individual creation works sequentially;
- no shell strings or default-server mutations exist;
- tests pass at child and applicable root scopes;
- documentation is independently usable;
- live acceptance is explicitly approved by the user;
- child commits precede superproject pointer/integration commits;
- no unrelated package changes are included.

## 28. Stop conditions

Stop and return to the user if:

- authorization cannot reliably survive reload while remaining process-local;
- the implementation would need session JSONL or filesystem authorization persistence;
- the supported Pi runtime cannot keep tool schemas registered without cache-disrupting changes;
- tmux direct multi-argument launch cannot avoid `sh -c` safely;
- the dedicated socket cannot be guaranteed on every mutation;
- creation requires an external registry or hidden keeper window;
- stable identity/tag checks cannot prevent accidental mutation of unowned objects;
- attached clients cannot be detected reliably;
- full-screen Pi output cannot be captured usefully within bounded tmux primitives;
- the work would require importing inter-agent, role, snapshot, or subagent packages;
- a new production dependency becomes necessary;
- implementation expands into semantic Pi control, project provisioning, or multi-user security;
- the child or parent working tree contains conflicting unrelated changes;
- live user acceptance cannot be performed.

## 29. Deferred follow-ups

These are concrete future investigations, not V1 implementation work and not code TODOs.

### 29.1 Child Pi tool restriction profiles

Investigate/document safe `piArgs` profiles using Pi’s native:

```text
--tools
--exclude-tools
--no-builtin-tools
--no-tools
--no-extensions
```

Use prevention of recursive subagent creation as the motivating example. Determine exact installed tool names rather than guessing. Consider whether a future launch-profile abstraction adds value only after real repeated usage.

### 29.2 Interactive user fleet cleanup menu

Consider a user-only `/session-manager` menu using ordinary Pi selection/confirmation UI:

- show managed running and dead windows;
- pressing `D` on a dead item closes it;
- pressing `D` on a live item offers a default-No force-close confirmation;
- cancellation returns to the menu;
- no registry/stale-entry action is needed because tmux remains authoritative.

This menu must not replace agent tools or direct tmux access.

### 29.3 Explicit per-worker environment overrides

Consider only if real workflows need them. Preserve the current inherited-environment default and require structured key/value input, never shell fragments.

### 29.4 Human navigation conveniences

A future user-invoked selector might emit or execute safe tmux navigation, but V1 intentionally relies on direct tmux attachment and never changes terminal focus automatically.

## 30. Rejected or deprioritized directions

- **External JSON registry:** Rejected because retained tmux objects already preserve required awareness and a second source creates drift.
- **One global fleet session:** Rejected in favor of one session per project-role fleet.
- **One tmux server/session per worker:** Rejected as unnecessary sprawl.
- **Default tmux server:** Rejected because manager automation must not collide with ordinary user sessions.
- **`-L` named socket:** Deprioritized in favor of deterministic explicit `-S` path.
- **Hidden keeper window/server:** Rejected; empty fleets need not persist.
- **Role/inter-agent/snapshot dependencies:** Rejected; callers pass opaque Pi arguments.
- **Magic terminal input/send-keys:** Rejected as fragile and semantically wrong.
- **RPC workers:** Rejected because the product requires normal visible Pi TUI sessions.
- **Dynamic tool enable/disable:** Rejected to preserve stable tool schemas and prompt caching.
- **Startup manager flag:** Rejected because spawned workers could grant themselves authority.
- **Session-entry authorization:** Rejected because it survives process restart/session history and has the wrong lifetime.
- **Free-text force-close reason:** Rejected as ceremonial; the explicit tool, Boolean, and state checks are sufficient.
- **Bulk create tool:** Rejected because ordinary batched singular tool calls already exist.
- **Persistent status indicator:** Rejected; the user can request `/session-manager status`.
- **Automatic readiness detection:** Rejected; tmux can report process/window state but not semantic Pi readiness.
- **Automatic graceful shutdown integration:** Deferred to complementary control systems; Session Manager only hosts and removes tmux windows.

## 31. Source-control discipline for execution

- The child repository owns package source commits.
- Commit coherent verified child work first.
- Update and commit the parent submodule pointer afterward.
- Stage only files belonging to the current task.
- Do not commit failing checks, generated runtime sockets/data, test tmux artifacts, or unrelated sibling changes.
- Do not push unless explicitly asked.
- Keep commit messages durable and free of transient planning/session references.
- The initial plan commit and initial parent submodule-registration commit precede implementation.

## 32. Expected next owner and action

The next owner is a future implementation agent explicitly assigned to execute this plan. Its first implementation action is Task 1 (package foundation and authorization), after reading the required guidance and confirming the child/superproject working trees are clean.

The implementation owner should execute Tasks 1–7 in dependency order, verify each coherent stage, commit child changes before parent pointer changes, and stop for the mandatory live user acceptance gate before declaring completion.