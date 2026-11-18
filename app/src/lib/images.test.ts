import { describe, expect, it } from "vitest";
import type { ImageRecord } from "./api";
import { describeImage, indexImages } from "./images";

const record = (over: Partial<ImageRecord>): ImageRecord =>
  ({ id: "3f9a1c07b2e4", name: "宿舍的路", url: "https://cdn.example/EverettBlog/3f9a1c07b2e4.webp", legacyUrls: [], width: 1280, height: 720, ...over }) as ImageRecord;

describe("image names", () => {
  it("come from the library by current or old address, ignoring a query", () => {
    // Arrange
    const index = indexImages([record({ legacyUrls: ["https://cdn.example/IMG_1442.jpeg"] })], "x-oss-process=image/resize,w_480");

    // Act
    const now = describeImage(index, "https://cdn.example/EverettBlog/3f9a1c07b2e4.webp?x-oss-process=image/resize,w_800");
    const old = describeImage(index, "https://cdn.example/IMG_1442.jpeg");

    // Assert
    expect(now).toMatchObject({ id: "3f9a1c07b2e4", name: "宿舍的路" });
    expect(now.thumb).toBe("https://cdn.example/EverettBlog/3f9a1c07b2e4.webp?x-oss-process=image/resize,w_480");
    expect(old.id).toBe("3f9a1c07b2e4");
  });

  it("fall back to the decoded file name for an image the library does not hold", () => {
    // Act
    const info = describeImage(new Map(), "https://bu.dusays.com/2023/%E5%9B%BE%201.webp");

    // Assert
    expect(info).toMatchObject({ id: null, name: "图 1.webp", thumb: "https://bu.dusays.com/2023/%E5%9B%BE%201.webp" });
  });
});
