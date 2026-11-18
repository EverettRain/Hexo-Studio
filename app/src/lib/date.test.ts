import { describe, expect, it } from "vitest";
import { formatWritten, monthGrid, nowIn, parseWritten } from "./date";

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

describe("written dates", () => {
  it("go both ways, adding seconds when they were left out", () => {
    // Act
    const p = parseWritten("2025-11-24 01:14");

    // Assert
    expect(p).toEqual({ year: 2025, month: 11, day: 24, hour: 1, minute: 14, second: 0 });
    expect(formatWritten(p!)).toBe("2025-11-24 01:14:00");
  });

  it("are null when written another way", () => {
    // Act / Assert
    expect(parseWritten("2025-11-24T01:14:20+08:00")).toBeNull();
    expect(parseWritten("")).toBeNull();
  });

  it("keep a day past the end of a shorter month inside it", () => {
    // Act
    const s = formatWritten({ year: 2024, month: 2, day: 31, hour: 9, minute: 5, second: 0 });

    // Assert
    expect(s).toBe("2024-02-29 09:05:00");
  });
});

describe("month grid", () => {
  it("covers the month in Monday-first weeks", () => {
    // Act: 1 November 2025 is a Saturday.
    const grid = monthGrid(2025, 11);

    // Assert
    expect(grid.length % 7).toBe(0);
    expect(grid[0]).toEqual({ year: 2025, month: 10, day: 27, inMonth: false });
    expect(grid[5]).toEqual({ year: 2025, month: 11, day: 1, inMonth: true });
    expect(grid.filter((d) => d.inMonth).map((d) => d.day)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});
