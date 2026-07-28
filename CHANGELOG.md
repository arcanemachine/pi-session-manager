# Changelog

## 0.1.0

V1 implementation in progress through Task 5.

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

- Dedicated explicit-socket tmux adapter with V1 ownership tags, strict
  inventory, normal direct Pi launch, bounded plain-text capture, and no
  default-server mutation.
- Functional `pi_fleet_create`, `pi_fleet_list`, and `pi_fleet_view` tools.
- Functional dead-only `pi_fleet_close` and guarded live-process
  `pi_fleet_force_close` tools, including stable-ID revalidation and protection
  for actively viewed human windows.

Root integration, final package documentation, and mandatory live user
acceptance remain before V1 completion.
