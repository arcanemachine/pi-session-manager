# pi-session-manager

A [pi](https://github.com/earendil-works/pi) extension that hosts fleets of
normal interactive Pi TUI processes in a dedicated tmux server.

The extension provides the terminal/process-hosting layer only:

- one dedicated tmux server for all managed fleets;
- one tmux session per fleet;
- one full tmux window per Pi instance;
- normal interactive Pi running directly inside each window;
- agent tools to list, view, create, close, and force-close managed windows;
- ordinary tmux attachment for the human user;
- process-local, human-granted authority gating every agent tool.

It does not control the work performed inside those Pi processes, and it has no
dependency on inter-agent, role, snapshot, or subagent packages.

## Status

V1 in progress. This package currently implements the foundation and
authorization layer (Task 1): package metadata, the `/session-manager` command,
and five always-registered authorization-gated tool skeletons. Tmux behavior and
real tool behavior arrive in later tasks.

## Requirements

- tmux 3.5 or newer (introduced in later tasks; not used yet by the foundation).

## Installation

```bash
pi install git:github.com/arcanemachine/pi-session-manager@main
```

## Authorization

Authorization is off by default and deliberately not persisted anywhere:

- It survives `/reload`, `/new`, `/resume`, and `/fork` within the same running
  Pi process.
- It does not survive process exit. A separately spawned Pi process starts
  disabled, and authorization does not propagate to launched worker processes.

Enable it with a human command in an interactive TUI:

```text
/session-manager on
/session-manager off
/session-manager status
```

`on` and `off` both require a two-choice confirmation that defaults to **No**, so
an injected command cannot grant or revoke authority silently.

## Agent tools

The following tools are always registered and active regardless of
authorization. While disabled every call is denied before any tmux inspection:

- `pi_fleet_list` — list managed fleets and instances
- `pi_fleet_view` — bounded terminal capture of one instance (no focus change)
- `pi_fleet_create` — create one normal interactive Pi instance
- `pi_fleet_close` — remove one exited managed window
- `pi_fleet_force_close` — force-remove a live window, requiring explicit
  confirmation

## License

MIT
