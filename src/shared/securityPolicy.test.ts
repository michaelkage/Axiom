import { describe, expect, it } from "vitest";
import { resolvePermissionDecision } from "./securityPolicy";

describe("worker permission policy", () => {
  it.each(["bash", "edit", "external_directory", "task", "webfetch"])(
    "downgrades persistent grants for privileged %s operations",
    permission => {
      expect(resolvePermissionDecision(permission, "always")).toBe("once");
      expect(resolvePermissionDecision(permission, "once")).toBe("once");
      expect(resolvePermissionDecision(permission, "reject")).toBe("reject");
    },
  );

  it("preserves persistent grants for non-privileged read-only permissions", () => {
    expect(resolvePermissionDecision("read", "always")).toBe("always");
    expect(resolvePermissionDecision("glob", "always")).toBe("always");
    expect(resolvePermissionDecision("websearch", "always")).toBe("always");
  });
});
