import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  getState,
  isAuthorized,
  resetAuthorization,
  setAuthorized,
} from "../src/authorization.js";

describe("authorization", () => {
  beforeEach(() => {
    resetAuthorization();
  });

  it("is disabled by default", () => {
    expect(isAuthorized()).toBe(false);
  });

  it("can be enabled and disabled in the current process", () => {
    setAuthorized(true);
    expect(isAuthorized()).toBe(true);
    setAuthorized(false);
    expect(isAuthorized()).toBe(false);
  });

  it("returns a stable, versioned state object that is reused in place", () => {
    const a = getState();
    const b = getState();
    expect(a).toBe(b);
    expect(a.version).toBe(1);
    setAuthorized(true);
    expect(a.enabled).toBe(true);
    // Mutating does not replace the object.
    expect(getState()).toBe(a);
  });

  it("persists across module re-evaluation because it is a process-global Symbol", async () => {
    setAuthorized(true);
    vi.resetModules();
    const reloaded = await import("../src/authorization.js");
    expect(reloaded.isAuthorized()).toBe(true);
  });

  it("does not persist after an explicit reset", () => {
    setAuthorized(true);
    resetAuthorization();
    expect(isAuthorized()).toBe(false);
  });
});
