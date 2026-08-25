import { describe, expect, it } from "vitest";
import { backoffMs } from "../process-notifications.js";

describe("backoffMs", () => {
  it("grows exponentially between attempts", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(4)).toBe(8_000);
  });

  it("is capped so a long-failing job does not wait indefinitely", () => {
    expect(backoffMs(20)).toBe(60_000);
    expect(backoffMs(100)).toBe(60_000);
  });

  it("never returns a negative delay for a non-positive attempt", () => {
    expect(backoffMs(0)).toBe(1_000);
    expect(backoffMs(-1)).toBe(1_000);
  });
});
