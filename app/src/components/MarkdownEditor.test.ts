import { describe, expect, it } from "vitest";
import { changedRange } from "./MarkdownEditor";

const apply = (s: string, r: { from: number; to: number; insert: string }) => s.slice(0, r.from) + r.insert + s.slice(r.to);

describe("changedRange", () => {
  it("replaces only the part that differs", () => {
    // Act
    const r = changedRange("第一段\n第二段\n第三段", "第一段\n改过的\n第三段");

    // Assert
    expect(r).toEqual({ from: 4, to: 7, insert: "改过的" });
  });

  it("turns any text into any other", () => {
    // Arrange
    const pairs = [["", "abc"], ["abc", ""], ["aaa", "aa"], ["abab", "ab"], ["same", "same"], ["x\ny", "x\n\ny"]];

    // Act / Assert
    for (const [a, b] of pairs) expect(apply(a, changedRange(a, b))).toBe(b);
  });
});
