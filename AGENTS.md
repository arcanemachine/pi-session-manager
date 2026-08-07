# Agent Instructions — pi-session-manager

This is the package-local agent file for `pi-session-manager`. It complements
the superproject file at `projects/pi/AGENTS.md`; when the two disagree on a
matter of implementation authority, this file defers to the authoritative plan.

## Authoritative plan

`PLAN.md` in this package is the single source of truth for behavior. Do not
reconstruct intent from conversation history. Do not add features outside the
plan; stop and ask if a described mechanism cannot be implemented as specified.

## Standalone boundary

`pi-session-manager` must not import or depend on `inter-agent`, `pi-role`,
`pi-session-snapshot`, or `pi-subagent`. Those packages may pass arguments
through to launched workers; this package treats any such argument array as
opaque. Callers pass opaque Pi arguments; this package does not interpret roles,
readiness, or task completion.

## Authorization discipline

Authorization is a process-local Boolean gated by a human `/session-manager`
command. It is NOT persisted anywhere:

- Never serialize it, put it in `process.env`, append it to the Pi transcript,
  pass it through worker arguments, or store it in tmux options.
- Never change tool registration or tool activation (`pi.setActiveTools()`) as
  part of authorization. All five tools are always registered and always active.
- `configure` requires interactive TUI mode with a real native selector. It
  presents exactly `On` and `Off`, with the current state first/default. Keep
  the current-state ordering and visible authority warning if you touch the
  command.

If you need a clean slate in tests, use `resetAuthorization()` from
`src/authorization.ts`. It is a test seam only — never register it as a command
or tool.

## Tmux discipline (later tasks)

- A dedicated tmux server selected by an explicit `-S` socket path is the sole
  source of truth. Never run an unqualified tmux mutation that could reach the
  default server.
- Use `shell: false` and argument arrays. Never `sh -c`. Never `tmux send-keys`
  as a control mechanism.
- Only mutate objects carrying the exact V1 ownership tags. Fail closed on
  malformed/partial/unsupported tags, multi-pane windows, attached humans, and
  partial creation.

## Verification

Run package-local checks only unless explicitly assigned root integration:

```bash
pnpm run format:check
pnpm run typecheck
pnpm run test
```

Do NOT run the root formatter — it rewrites sibling packages. Do not modify or
commit superproject files (root `package.json`, root `pnpm-lock.yaml`, root
`README.md`) unless explicitly assigned the Task 6 integration step.
