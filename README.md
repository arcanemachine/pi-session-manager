# pi-session-manager

A [Pi](https://github.com/badlogic/pi-mono) extension that hosts fleets of
normal interactive Pi TUI processes in a dedicated tmux server.

Session Manager is only the terminal and process-hosting layer. It creates and
observes independent Pi processes; it does not assign roles, inspect readiness,
send prompts or keystrokes, steer work, shut Pi down gracefully, or integrate
with inter-agent, pi-role, pi-session-snapshot, or pi-subagent.

## Requirements

- Pi extension API 0.80.10 or later
- tmux 3.5 or later
- A POSIX environment where tmux is available on `PATH`

## Installation

### From GitHub

```bash
pi install git:github.com/arcanemachine/pi-session-manager
```

Update with:

```bash
pi update git:github.com/arcanemachine/pi-session-manager
```

### From a local clone

```bash
git clone git@github.com:arcanemachine/pi-session-manager.git
pi install /path/to/pi-session-manager
```

No superproject checkout or sibling Pi package is required for normal use.

## Authorization

All five Session Manager tools are registered at all times, but they deny every
operation until a human configures authorization in the Manager Pi's
interactive TUI:

```text
/session-manager configure
/session-manager status
```

`configure` uses Pi's native selector with exactly `On` and `Off`. The current
state is first/default (`Off`, `On` while disabled; `On`, `Off` while enabled),
and the prompt warns that enabling grants visibility and process/window
lifecycle authority, including force termination. Selecting the current state
or cancelling leaves authorization unchanged. Authorization is process-local:
it survives `/reload`, `/new`, `/resume`, and `/fork` in that same Pi process,
but not process exit. It is not written to the transcript, files, environment,
tmux metadata, or worker arguments, and it never propagates to launched workers.

## Fleets and tmux

Session Manager uses one separate tmux server, never the user's default tmux
server. The socket is:

```text
$PI_CODING_AGENT_DIR/pi-session-manager/tmux.sock
```

When `PI_CODING_AGENT_DIR` is unset, its full default path is:

```text
~/.pi/agent/pi-session-manager/tmux.sock
```

A fleet is one tmux session. Fleet names are opaque namespaces that must match
`[a-z0-9][a-z0-9_-]{0,63}`; the usual convention is `<project>-<role>`. An
instance is one full tmux window containing one directly launched interactive
Pi process. Instance numbers are positive integers and equal their tmux window
indexes; indexes begin at 1 and are never automatically renumbered.

For example, after creating `myproject-worker` instance 1, attach manually:

```bash
tmux -S ~/.pi/agent/pi-session-manager/tmux.sock attach -t myproject-worker
```

Substitute the configured agent directory when `PI_CODING_AGENT_DIR` is set.
Session Manager also reports the exact attachment command in its list results.
It never attaches, selects windows, or changes terminal focus for you.

## Agent tools

After the user has enabled authorization, the Manager Pi agent can call:

- `pi_fleet_list` — list managed fleets and instances; accepts an optional
  `fleet` filter.
- `pi_fleet_view` — capture 1–500 lines from one running or exited instance
  without changing focus; the default is 100 lines.
- `pi_fleet_create` — create one normal interactive Pi instance. It accepts
  `fleet`, `instance`, optional `cwd`, and an opaque `piArgs` string array.
- `pi_fleet_close` — remove one exited managed window only.
- `pi_fleet_force_close` — remove one live managed window and terminate its Pi
  process. It requires `confirmProcessTermination: true`.

Typical calls use individual creates, including in one ordinary Pi tool batch:

```text
pi_fleet_create
```

```json
{
  "fleet": "myproject-worker",
  "instance": 1,
  "cwd": "/workspace/projects/myproject"
}
```

```text
pi_fleet_view
```

```json
{ "fleet": "myproject-worker", "instance": 1, "lines": 100 }
```

```text
pi_fleet_force_close
```

```json
{
  "fleet": "myproject-worker",
  "instance": 1,
  "confirmProcessTermination": true
}
```

The last example is for `pi_fleet_force_close`, not ordinary close. It removes
the live window and terminates the contained process. Use it only when graceful
control is unavailable or has failed; never use it merely to tidy a fleet or
because a worker is slow. Neither close operation can remove a window currently
viewed by an attached human tmux client.

`piArgs` are passed directly to `pi`, one argument at a time. They are not shell
syntax and Session Manager does not interpret them as role, bus, readiness, or
child-tool configuration. No child-tool restriction profile is documented in
V1 because exact installed child-tool names must be verified before one is
recommended.

## Ownership and lifecycle

Tmux is the sole source of truth. Session Manager keeps no external registry.
It recognizes only exact V1 ownership metadata:

```text
tmux session: @pi-session-manager-fleet-version = v1
tmux window:  @pi-session-manager-window-version = v1
              @pi-session-manager-instance = <positive decimal integer>
              @pi-session-manager-pane-id = <%pane-id>
```

The session name is the fleet name. A managed window must contain exactly one
pane with the stored stable pane ID. Missing, partial, malformed, contradictory,
or unsupported tags—and windows manually split into multiple panes—are warnings,
not managed targets. Session Manager will not adopt, repair, or mutate them.
Manual tmux deletion is valid; the metadata disappears with the object and no
stale registry remains.

Pi exit is retained by tmux, so exited instances remain listable and viewable
until `pi_fleet_close` removes them. If the final window closes, tmux may remove
the empty fleet and server naturally.

## Limits and non-goals

- Terminal capture is bounded and observational; it is not task-completion or
  semantic readiness evidence.
- Session Manager does not restart workers, provision projects or worktrees,
  maintain a filesystem database, send keys, or control the default tmux
  server.
- It has no multi-user authorization, remote tmux support, per-worker
  environment overrides, arbitrary shell commands, arbitrary executable
  selection, or bulk fleet API.
- Anyone with same-user access to the dedicated socket can use ordinary tmux
  commands. The authorization gate protects against unintended agent tool use,
  not malicious same-process extensions or hostile local users.

## Development

```bash
npm install --loglevel=warning
npm run format:check
npm run typecheck
npm run test
npm run build
```

Do not run the superproject formatter for package-only work; it rewrites sibling
packages.

## License

MIT
