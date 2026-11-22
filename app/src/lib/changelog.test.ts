import { describe, expect, it } from "vitest";
import { inline, parse, releases } from "./changelog";

describe("releases", () => {
  it("orders versions by number, newest first", () => {
    // Act
    const list = releases({ "a/v1.9.0.md": "x", "a/v1.10.0.md": "y", "a/v0.1.0.md": "z" });

    // Assert
    expect(list.map((r) => r.version)).toEqual(["1.10.0", "1.9.0", "0.1.0"]);
  });
});

describe("parse", () => {
  it("reads headings, lists and paragraphs", () => {
    // Act
    const blocks = parse("开头一段。\n\n### 写作\n- 一\n- 二\n\n### 图片\n- 三\n");

    // Assert
    expect(blocks).toEqual([
      { kind: "paragraph", text: "开头一段。" },
      { kind: "heading", text: "写作" },
      { kind: "list", items: ["一", "二"] },
      { kind: "heading", text: "图片" },
      { kind: "list", items: ["三"] },
    ]);
  });
});

describe("parse paragraphs", () => {
  it("joins wrapped lines and keeps blank-line breaks", () => {
    // Act
    const blocks = parse("第一行\n接着\n\n第二段");

    // Assert
    expect(blocks).toEqual([
      { kind: "paragraph", text: "第一行接着" },
      { kind: "paragraph", text: "第二段" },
    ]);
  });
});

describe("inline", () => {
  it("splits out code and bold", () => {
    // Act / Assert
    expect(inline("用 `hexo init` 和 **重点**。")).toEqual([
      { text: "用 ", style: "plain" },
      { text: "hexo init", style: "code" },
      { text: " 和 ", style: "plain" },
      { text: "重点", style: "bold" },
      { text: "。", style: "plain" },
    ]);
  });
});
