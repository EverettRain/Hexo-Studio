import { describe, expect, it } from "vitest";
import { applyEdits, changed, readFrontMatter } from "./frontmatter";

/** A post's front-matter as the blog writes it, with the oddities real posts have. */
const POST = [
  "title: 自制载具系统：CylinderCaster",
  "date: 2024-12-20 12:04:22",
  "tags: ",
  "  - Unity",
  "  - C#",
  "categories:",
  "  - Unity汽车系统",
  "description: 碰撞检测 # why it matters",
  "cover: https://example.com/a.PNG ",
  "top_img: false",
  "swiper_index: 6",
  "abbrlink: d50a",
  "# a comment line",
  "copyright_info: 本文版权归网站所有。",
  "",
].join("\n");

describe("applyEdits", () => {
  it("returns the text unchanged when nothing changed", () => {
    // Act
    const out = applyEdits(POST, {});

    // Assert
    expect(out).toBe(POST);
  });

  it("rewrites only the changed key and keeps every other line byte for byte", () => {
    // Act
    const out = applyEdits(POST, { title: "新标题" });

    // Assert
    const before = POST.split("\n");
    const after = out.split("\n");
    expect(after[0]).toBe("title: 新标题");
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  it("keeps the date as written next to a changed key", () => {
    // Act
    const out = applyEdits(POST, { description: "x" });

    // Assert
    expect(out).toContain("date: 2024-12-20 12:04:22\n");
    expect(out).toContain("description: x # why it matters\n");
  });

  it("replaces a block list with the new items in the same indentation", () => {
    // Act
    const out = applyEdits(POST, { tags: ["Unity", "Code"] });

    // Assert
    expect(out).toContain("tags:\n  - Unity\n  - Code\ncategories:\n");
  });

  it("keeps unindented and flow lists in their style", () => {
    // Arrange
    const yaml = "tags:\n- a\ncategories: [x, y]\n";

    // Act
    const out = applyEdits(yaml, { tags: ["a", "b"], categories: ["z"] });

    // Assert
    expect(out).toBe("tags:\n- a\n- b\ncategories: [ z ]\n");
  });

  it("adds missing keys at the end and leaves emptied keys bare", () => {
    // Arrange
    const yaml = "title: A\ncover: x\n";

    // Act
    const out = applyEdits(yaml, { cover: "", description: "新的描述", top_img: "" });

    // Assert
    expect(out).toBe("title: A\ncover:\ndescription: 新的描述\n");
  });

  it("fills a key that was empty", () => {
    // Arrange
    const yaml = "title: A\ntags:\ncover:\n";

    // Act
    const out = applyEdits(yaml, { tags: ["x"], cover: "https://example.com/c.jpg" });

    // Assert
    expect(out).toBe("title: A\ntags:\n  - x\ncover: https://example.com/c.jpg\n");
  });

  it("quotes text that would otherwise read as another type or break the YAML", () => {
    // Arrange
    const yaml = "title: A\n";

    // Act
    const out = applyEdits(yaml, { title: "C#: 委托 # 1", description: "true" });

    // Assert
    expect(readFrontMatter(out).values).toEqual({ title: "C#: 委托 # 1", description: "true" });
  });

  it("keeps quotes the old value had", () => {
    // Arrange
    const yaml = "title: 'A'\n";

    // Act
    const out = applyEdits(yaml, { title: "B" });

    // Assert
    expect(out).toBe("title: 'B'\n");
  });

  it("does not keep quotes a value only needed while it was being typed", () => {
    // Arrange: "Smart " needs quotes for its trailing space.
    const typing = applyEdits("title: A\n", { title: "Smart " });

    // Act
    const out = applyEdits(typing, { title: "Smart P" });

    // Assert
    expect(typing).toBe('title: "Smart "\n');
    expect(out).toBe("title: Smart P\n");
  });

  it("sets switches as booleans", () => {
    // Act
    const out = applyEdits(POST, { top_img: "https://example.com/top.jpg", noticeOutdate: true });

    // Assert
    expect(out).toContain("top_img: https://example.com/top.jpg\n");
    expect(out.endsWith("noticeOutdate: true\n")).toBe(true);
  });

  it("replaces a block scalar without joining it to the next line", () => {
    // Arrange
    const yaml = "description: |\n  line one\n  line two\ncover: x\n";

    // Act
    const out = applyEdits(yaml, { description: "short" });

    // Assert
    expect(out).toBe("description: short\ncover: x\n");
  });

  it("writes into an empty block", () => {
    // Act
    const out = applyEdits("", { title: "A" });

    // Assert
    expect(out).toBe("title: A\n");
  });

  it("refuses invalid YAML", () => {
    // Act / Assert
    expect(() => applyEdits("title: [a", { title: "b" })).toThrow();
  });
});

describe("readFrontMatter", () => {
  it("reads values with dates kept as text", () => {
    // Act
    const r = readFrontMatter(POST);

    // Assert
    expect(r.error).toBeNull();
    expect(r.values?.date).toBe("2024-12-20 12:04:22");
    expect(r.values?.tags).toEqual(["Unity", "C#"]);
  });

  it("reports a block that is not a mapping", () => {
    // Act
    const r = readFrontMatter("- a\n- b\n");

    // Assert
    expect(r.values).toBeNull();
    expect(r.error).not.toBeNull();
  });
});

describe("changed", () => {
  it("treats every kind of empty as the same", () => {
    // Act / Assert
    expect(changed(null, "")).toBe(false);
    expect(changed(undefined, [])).toBe(false);
    expect(changed(["a"], ["a"])).toBe(false);
    expect(changed(["a"], ["a", "b"])).toBe(true);
    expect(changed(false, null)).toBe(true);
  });
});
