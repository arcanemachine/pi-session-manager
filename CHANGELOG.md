# Changelog

## 0.1.0

Initial package foundation and authorization layer (Task 1).

- Pi extension `pi-session-manager` registered via `pi.extensions`.
- `/session-manager on|off|status` user command with default-No confirmation
  for `on`/`off` and a transient `status` notification.
- Process-local authorization helper using a versioned `globalThis` state keyed
  by `Symbol.for("pi-session-manager.authorization.v1")`. Authorization is off
  by default, survives reload/same-process session replacement, and is never
  persisted to files, session entries, environment variables, or worker args.
- Five always-registered, always-active, authorization-gated tool skeletons:
  `pi_fleet_list`, `pi_fleet_view`, `pi_fleet_create`, `pi_fleet_close`, and
  `pi_fleet_force_close`, with static prompt metadata and sequential execution
  for the three mutating tools.
- Focused unit tests for authorization lifetime, command parsing/default-No,
  and stable tool registration.

Tmux behavior and real tool behavior are deliberately not implemented yet; they
arrive in later tasks.
