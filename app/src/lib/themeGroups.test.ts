import { describe, expect, it } from "vitest";
import { commentServices, looksLikeImage, SEARCH_PANEL, taskGroups, writeCommentServices } from "./themeGroups";

describe("taskGroups", () => {
  it("keeps the listed sections that are there and puts the rest under 其他", () => {
    // Act
    const groups = taskGroups(["menu", "music_page", "my_custom", "comments"]);

    // Assert
    expect(groups.map((g) => [g.title, g.items])).toEqual([
      ["导航", ["menu"]],
      ["评论", ["comments"]],
      ["搜索与公式", [SEARCH_PANEL]],
      ["音乐", ["music_page"]],
      ["其他", ["my_custom"]],
    ]);
  });
});

describe("comment services", () => {
  it("reads a comma list or a list, in any case", () => {
    // Act / Assert
    expect(commentServices("Twikoo")).toEqual(["Twikoo"]);
    expect(commentServices("twikoo, waline")).toEqual(["Twikoo", "Waline"]);
    expect(commentServices(["Valine"])).toEqual(["Valine"]);
    expect(commentServices(null)).toEqual([]);
  });

  it("writes back in the form the file uses", () => {
    // Act / Assert
    expect(writeCommentServices("Twikoo", ["Twikoo", "Waline"])).toBe("Twikoo,Waline");
    expect(writeCommentServices(["Twikoo"], ["Waline"])).toEqual(["Waline"]);
    expect(writeCommentServices("Twikoo", [])).toBeNull();
  });
});

describe("looksLikeImage", () => {
  it("knows image values and image-named keys, and leaves links, icons and HTML alone", () => {
    // Act / Assert
    expect(looksLikeImage("img", "https://x.cn/a.webp", false)).toBe(true);
    expect(looksLikeImage("background", "", false)).toBe(true);
    expect(looksLikeImage("anything", "https://oss/abc", true)).toBe(true);
    expect(looksLikeImage("statusImg", "/img/s.png", false)).toBe(true);
    expect(looksLikeImage("icon", "anzhiyu-icon-github", false)).toBe(false);
    expect(looksLikeImage("归档", "/archives/ || anzhiyu-icon-box", false)).toBe(false);
    expect(looksLikeImage("content", "<img src='a.png'>", false)).toBe(false);
    expect(looksLikeImage("img", true, false)).toBe(false);
  });
});
