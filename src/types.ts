/** Stable tmux identity and inventory contracts for Session Manager V1. */

export interface TmuxVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly suffix: string;
}

export interface SessionManagerPaths {
  readonly agentDir: string;
  readonly stateDir: string;
  readonly socketPath: string;
}

export interface TmuxClient {
  readonly name: string;
  readonly sessionName: string;
}

export interface ManagedFleet {
  readonly name: string;
  readonly sessionId: string;
  readonly attachmentCommand: string;
  readonly instances: readonly ManagedInstance[];
}

export interface ManagedInstance {
  readonly fleet: string;
  readonly instance: number;
  readonly sessionId: string;
  readonly windowId: string;
  readonly paneId: string;
  readonly windowIndex: number;
  readonly windowName: string;
  readonly state: "running" | "exited";
  readonly pid?: number;
  readonly currentCommand?: string;
  readonly currentPath?: string;
  readonly exitStatus?: number;
  readonly exitSignal?: number;
  readonly exitTime?: number;
  readonly activeViewerCount: number;
  readonly viewedByUser: boolean;
  readonly attachmentCommand: string;
}

export type InventoryWarningCode =
  | "PARTIAL_TAG"
  | "UNSUPPORTED_TAG_VERSION"
  | "MALFORMED_TAG"
  | "CONTRADICTORY_IDENTITY"
  | "AMBIGUOUS_WINDOW"
  | "WINDOW_OUTSIDE_MANAGED_FLEET";

export interface InventoryWarning {
  readonly code: InventoryWarningCode;
  readonly message: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly windowId?: string;
  readonly windowIndex?: number;
}

export interface TmuxInventory {
  readonly serverPresent: boolean;
  readonly fleets: readonly ManagedFleet[];
  readonly warnings: readonly InventoryWarning[];
  readonly clients: readonly TmuxClient[];
}

export type FleetOwnership =
  | { readonly kind: "managed" }
  | { readonly kind: "unmanaged" }
  | { readonly kind: "unsupported-version"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string };

export type WindowOwnership =
  | {
      readonly kind: "managed";
      readonly instance: number;
      readonly paneId: string;
    }
  | { readonly kind: "unmanaged" }
  | { readonly kind: "partial"; readonly reason: string }
  | { readonly kind: "unsupported-version"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string };
