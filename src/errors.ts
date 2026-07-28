/**
 * Typed Session Manager errors.
 *
 * Codes are the stable error classes from PLAN.md section 19. The full taxonomy
 * is exercised by later tasks; Task 1 only needs the disabled and TUI guards.
 * Codes are kept as the authoritative string set so handlers and tests can map
 * them consistently.
 */

export const ErrorCode = {
  SESSION_MANAGER_DISABLED: "SESSION_MANAGER_DISABLED",
  TUI_REQUIRED: "TUI_REQUIRED",
  USER_CANCELLED: "USER_CANCELLED",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  TMUX_NOT_FOUND: "TMUX_NOT_FOUND",
  TMUX_VERSION_UNSUPPORTED: "TMUX_VERSION_UNSUPPORTED",
  TMUX_SERVER_ERROR: "TMUX_SERVER_ERROR",
  INVALID_FLEET: "INVALID_FLEET",
  INVALID_INSTANCE: "INVALID_INSTANCE",
  INVALID_CWD: "INVALID_CWD",
  INVALID_PI_ARGS: "INVALID_PI_ARGS",
  FLEET_NOT_FOUND: "FLEET_NOT_FOUND",
  FLEET_COLLISION: "FLEET_COLLISION",
  INSTANCE_NOT_FOUND: "INSTANCE_NOT_FOUND",
  INSTANCE_COLLISION: "INSTANCE_COLLISION",
  UNMANAGED_TARGET: "UNMANAGED_TARGET",
  UNSUPPORTED_TAG_VERSION: "UNSUPPORTED_TAG_VERSION",
  AMBIGUOUS_WINDOW: "AMBIGUOUS_WINDOW",
  IDENTITY_CHANGED: "IDENTITY_CHANGED",
  INSTANCE_RUNNING: "INSTANCE_RUNNING",
  INSTANCE_EXITED: "INSTANCE_EXITED",
  INSTANCE_VIEWED_BY_USER: "INSTANCE_VIEWED_BY_USER",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  CAPTURE_FAILED: "CAPTURE_FAILED",
  CREATE_PARTIAL_FAILURE: "CREATE_PARTIAL_FAILURE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class SessionManagerError extends Error {
  readonly code: ErrorCodeValue;
  readonly stderr?: string;

  constructor(code: ErrorCodeValue, message: string, stderr?: string) {
    super(message);
    this.name = "SessionManagerError";
    this.code = code;
    this.stderr = stderr;
  }
}

/** Standardized denial message returned while authorization is off. */
export const DISABLED_MESSAGE =
  "Session Manager is disabled. The user must run /session-manager on and confirm access. Do not retry until the user enables it.";
