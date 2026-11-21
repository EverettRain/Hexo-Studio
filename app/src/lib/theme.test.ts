import { describe, expect, it } from "vitest";
import { THEMES, themeOf } from "./theme";

describe("themeOf", () => {
  it("finds every theme by its id", () => {
    // Act / Assert
    for (const t of THEMES) expect(themeOf(t.id)).toBe(t);
  });

  it("falls back to the first theme for an id it does not know", () => {
    // Act / Assert
    expect(themeOf("from-a-newer-version")).toBe(THEMES[0]);
    expect(themeOf("")).toBe(THEMES[0]);
  });
});
