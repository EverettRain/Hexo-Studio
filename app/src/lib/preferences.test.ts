import { describe, expect, it } from "vitest";
import type { UiPreferences } from "./api";
import { DEFAULT_UI, fromWebStorage, WEB_STORAGE_KEYS } from "./preferences";

const fresh: UiPreferences = { ...DEFAULT_UI, webStorageMigrated: false };
const storage = (values: Record<string, string>) => (k: string) => values[k] ?? null;

describe("fromWebStorage", () => {
  it("brings over the mode and the preview share once", () => {
    // Arrange
    const read = storage({ [WEB_STORAGE_KEYS.mode]: "dark", [WEB_STORAGE_KEYS.previewShare]: "0.35" });

    // Act
    const ui = fromWebStorage(fresh, read);

    // Assert
    expect(ui).toEqual({ ...DEFAULT_UI, mode: "dark", previewShare: 0.35 });
  });

  it("ignores values that are not usable and keeps the defaults", () => {
    // Arrange
    const read = storage({ [WEB_STORAGE_KEYS.mode]: "sepia", [WEB_STORAGE_KEYS.previewShare]: "3" });

    // Act
    const ui = fromWebStorage(fresh, read);

    // Assert
    expect(ui).toEqual({ ...DEFAULT_UI, webStorageMigrated: true });
  });

  it("leaves preferences that were already migrated alone", () => {
    // Arrange
    const saved: UiPreferences = { ...DEFAULT_UI, mode: "light", previewShare: 0.6 };

    // Act
    const ui = fromWebStorage(saved, storage({ [WEB_STORAGE_KEYS.mode]: "dark" }));

    // Assert
    expect(ui).toBe(saved);
  });
});
