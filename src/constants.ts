/** Command and tool name constants, meant to be referenced everywhere. */

export const COMMAND_NAME = "session-manager";

export const TOOL_LIST = "pi_fleet_list";
export const TOOL_VIEW = "pi_fleet_view";
export const TOOL_CREATE = "pi_fleet_create";
export const TOOL_CLOSE = "pi_fleet_close";
export const TOOL_FORCE_CLOSE = "pi_fleet_force_close";

/** Fleet name validation rule (PLAN.md section 17.3). */
export const FLEET_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";
