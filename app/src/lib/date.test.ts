import { describe, expect, it } from "vitest";
import { fromInputValue, nowIn, toInputValue } from "./date";

describe("nowIn", () => {
  it("writes the time in the blog's zone, not the machine's", () => {
    // Arrange: 17:14:20 UTC is 01:14:20 the next day in Shanghai.
    const at = new Date("2025-11-23T17:14:20Z");

    // Act
    const s = nowIn("Asia/Shanghai", at);

    // Assert
    expect(s).toBe("2025-11-24 01:14:20");
  });
});

describe("date input conversion", () => {
  it("goes both ways for the blog's way of writing dates", () => {
    // Act
    const input = toInputValue("2025-11-24 01:14:20");

    // Assert
    expect(input).toBe("2025-11-24T01:14:20");
    expect(fromInputValue(input!)).toBe("2025-11-24 01:14:20");
  });

  it("adds seconds the input leaves out", () => {
    // Act / Assert
    expect(fromInputValue("2025-11-24T01:14")).toBe("2025-11-24 01:14:00");
    expect(toInputValue("2025-11-24 01:14")).toBe("2025-11-24T01:14:00");
  });

  it("gives null for dates written another way", () => {
    // Act / Assert
    expect(toInputValue("2025-11-24T01:14:20+08:00")).toBeNull();
    expect(toInputValue("")).toBeNull();
  });
});
