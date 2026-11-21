import { describe, expect, it } from "vitest";
import type { ImageRecord } from "./api";
import { copyText, defaultName, isImagePath, ownFileName, saving } from "./imageImport";

describe("defaultName", () => {
  it("takes the file's name without its extension, or a screenshot's time", () => {
    // Act / Assert
    expect(defaultName("IMG_1426.JPG", new Date())).toBe("IMG_1426");
    expect(defaultName("a.b.png", new Date())).toBe("a.b");
    expect(defaultName(null, new Date(2025, 10, 24, 1, 14, 5))).toBe("image-20251124-011405");
  });

  it("treats a pasted screenshot's image.png as having no name", () => {
    // Act / Assert
    expect(ownFileName("image.png")).toBeNull();
    expect(ownFileName("IMAGE.JPEG")).toBeNull();
    expect(ownFileName("photo.png")).toBe("photo.png");
  });
});

describe("saving", () => {
  it("says how much smaller or larger the upload is", () => {
    // Act / Assert
    expect(saving(1000, 90)).toBe("−91%");
    expect(saving(1000, 1040)).toBe("+4%");
    expect(saving(1000, 1001)).toBe("");
    expect(saving(0, 10)).toBe("");
  });
});

describe("copyText", () => {
  const img = (url: string) => ({ url }) as ImageRecord;

  it("writes each image in the chosen style, one per line", () => {
    // Act
    const urls = copyText([img("https://x/a.webp"), img("https://x/b.webp")], "url");
    const markdown = copyText([img("https://x/a.webp")], "markdown");
    const tag = copyText([img("https://x/a.webp")], "image");

    // Assert
    expect(urls).toBe("https://x/a.webp\nhttps://x/b.webp");
    expect(markdown).toBe("![](https://x/a.webp)");
    expect(tag).toContain("{% image https://x/a.webp");
  });
});

describe("isImagePath", () => {
  it("knows image files by extension, in any case", () => {
    // Act / Assert
    expect(isImagePath("/a/IMG_1.HEIC")).toBe(true);
    expect(isImagePath("/a/notes.md")).toBe(false);
  });
});
