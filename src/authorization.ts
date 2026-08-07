import { DISABLED_MESSAGE, ErrorCode, SessionManagerError } from "./errors.js";

/**
 * Process-local authorization for Session Manager.
 *
 * Authorization is a single in-process Boolean that gates every agent tool. It
 * is configured only by a human through the `/session-manager configure`
 * command.
 *
 * Lifetime contract (PLAN.md section 12.1):
 * - Authorization is OFF by default.
 * - It survives `/reload`, `/new`, `/resume`, and `/fork` within the same OS Pi
 *   process: the same JavaScript process re-evaluates the extension, and the
 *   state object persists on `globalThis` via a `Symbol.for(...)` key.
 * - It does NOT survive OS process exit. A separately spawned Pi process begins
 *   disabled, and authorization does not propagate to launched worker Pi
 *   processes.
 * - This state is NEVER serialized, written to `process.env`, appended to the
 *   Pi transcript, passed through worker arguments, or stored in tmux options.
 * - This is a same-process capability guard, NOT protection from another trusted
 *   extension executing arbitrary code in the same process.
 *
 * The single shared state object is reused in place across extension
 * re-evaluation, so toggling mutates the same object rather than replacing it.
 * That keeps identity stable for any cached references within a process.
 */

const AUTH_SYMBOL = Symbol.for("pi-session-manager.authorization.v1");

export interface AuthorizationStateV1 {
  readonly version: 1;
  enabled: boolean;
}

function isState(value: unknown): value is AuthorizationStateV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { enabled?: unknown }).enabled === "boolean"
  );
}

function readRaw(): unknown {
  return (globalThis as Record<symbol, unknown>)[AUTH_SYMBOL];
}

/** Initialize or reuse the shared authorization state for this process. */
export function getState(): AuthorizationStateV1 {
  const current = readRaw();
  if (isState(current)) {
    return current;
  }
  const fresh: AuthorizationStateV1 = { version: 1, enabled: false };
  (globalThis as Record<symbol, unknown>)[AUTH_SYMBOL] = fresh;
  return fresh;
}

/** Whether authorization is currently granted in this process. */
export function isAuthorized(): boolean {
  return getState().enabled;
}

/** Set the authorization flag for this process (mutates the shared object). */
export function setAuthorized(enabled: boolean): void {
  const state = getState();
  state.enabled = enabled;
}

/**
 * Test-only reset seam. Clears the shared process state back to the disabled
 * default. This is NOT registered as a Pi command or tool and must not be
 * reachable from the agent surface.
 */
export function resetAuthorization(): void {
  (globalThis as Record<symbol, unknown>)[AUTH_SYMBOL] = {
    version: 1,
    enabled: false,
  };
}

/**
 * Shared guard invoked at the top of every agent tool. Throws a typed
 * disabled error when authorization is missing; tools signal failure by
 * throwing as Pi's extension API requires.
 */
export function requireAuthorization(): void {
  if (!isAuthorized()) {
    throw new SessionManagerError(
      ErrorCode.SESSION_MANAGER_DISABLED,
      DISABLED_MESSAGE,
    );
  }
}
