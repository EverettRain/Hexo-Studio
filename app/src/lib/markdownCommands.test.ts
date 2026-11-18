import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { codeBlock, formatAt, hexoBlock, link, rule, setHeading, table, toggleInline, toggleList, toggleQuote, wordCount, type MdCommand } from "./markdownCommands";

/** A state from text where `|` is the cursor, or `‹` … `›` the selection (anchor first). */
function state(marked: string): EditorState {
  const a = marked.indexOf("‹");
  const doc = marked.replace(/[‹›|]/g, "");
  const selection = a >= 0 ? EditorSelection.single(a, marked.indexOf("›") - 1) : EditorSelection.single(marked.indexOf("|"));
  return EditorState.create({ doc, selection, extensions: [markdown({ base: markdownLanguage })] });
}

/** The text after the command, with the selection marked as in `state`. */
function run(cmd: MdCommand, marked: string): string {
  const s = state(marked);
  const spec = cmd(s);
  if (!spec) return marked;
  const after = s.update(spec).state;
  const { from, to } = after.selection.main;
  const doc = after.doc.toString();
  return from === to ? `${doc.slice(0, from)}|${doc.slice(from)}` : `${doc.slice(0, from)}‹${doc.slice(from, to)}›${doc.slice(to)}`;
}

describe("inline marks", () => {
  it("wrap the selection and keep it selected", () => {
    // Act / Assert
    expect(run(toggleInline("strong"), "a ‹word› b")).toBe("a **‹word›** b");
    expect(run(toggleInline("strike"), "‹gone›")).toBe("~~‹gone›~~");
  });

  it("leave the whitespace at the selection's ends outside", () => {
    // Act
    const after = run(toggleInline("strong"), "a‹ word ›b");

    // Assert
    expect(after).toBe("a **‹word›** b");
  });

  it("put an empty pair at a bare cursor", () => {
    // Act / Assert
    expect(run(toggleInline("code"), "run |now")).toBe("run `|`now");
  });

  it("come off when the cursor or selection is inside them", () => {
    // Act / Assert
    expect(run(toggleInline("strong"), "a **bo|ld** b")).toBe("a bo|ld b");
    expect(run(toggleInline("strong"), "a **‹bold›** b")).toBe("a ‹bold› b");
    expect(run(toggleInline("emphasis"), "*‹it›*")).toBe("‹it›");
    expect(run(toggleInline("code"), "x `c|ode` y")).toBe("x c|ode y");
  });

  it("are added, not removed, by a cursor just past them", () => {
    // Act
    const after = run(toggleInline("strong"), "**b**| c");

    // Assert
    expect(after).toBe("**b****|** c");
  });

  it("tell italic from bold", () => {
    // Act
    const after = run(toggleInline("emphasis"), "**‹bold›**");

    // Assert
    expect(after).toBe("***‹bold›***");
  });
});

describe("headings", () => {
  it("replace any level and come off when chosen again", () => {
    // Act / Assert
    expect(run(setHeading(2), "Ti|tle")).toBe("## Ti|tle");
    expect(run(setHeading(3), "# Ti|tle")).toBe("### Ti|tle");
    expect(run(setHeading(2), "## Ti|tle")).toBe("Ti|tle");
    expect(run(setHeading(0), "#### Ti|tle")).toBe("Ti|tle");
  });

  it("keep the cursor after the marks on an empty line", () => {
    // Act
    const after = run(setHeading(2), "a\n|\nb");

    // Assert
    expect(after).toBe("a\n## |\nb");
  });
});

describe("lists and quotes", () => {
  it("number the selected lines and skip blank ones between them", () => {
    // Act
    const after = run(toggleList("ordered"), "‹one\n\ntwo›");

    // Assert
    expect(after).toBe("‹1. one\n\n2. two›");
  });

  it("switch kind, keeping indentation", () => {
    // Act / Assert
    expect(run(toggleList("task"), "  - it|em")).toBe("  - [ ] it|em");
    expect(run(toggleList("bullet"), "3. it|em")).toBe("- it|em");
  });

  it("come off when every line already is that kind", () => {
    // Act / Assert
    expect(run(toggleList("bullet"), "‹- a\n- b›")).toBe("‹a\nb›");
    expect(run(toggleList("task"), "- [x] do|ne")).toBe("do|ne");
  });

  it("leave out a line the selection only reaches the start of", () => {
    // Act
    const after = run(toggleList("bullet"), "‹a\n›b");

    // Assert
    expect(after).toBe("‹- a\n›b");
  });

  it("quote and unquote lines", () => {
    // Act / Assert
    expect(run(toggleQuote, "‹a\n\nb›")).toBe("‹> a\n>\n> b›");
    expect(run(toggleQuote, "> q|uote")).toBe("q|uote");
  });
});

describe("blocks", () => {
  it("get a paragraph of their own", () => {
    // Act / Assert
    expect(run(rule, "above|")).toBe("above\n\n---|");
    expect(run(rule, "above\n|\nbelow")).toBe("above\n\n---|\n\nbelow");
    expect(run(rule, "a|b")).toBe("a\n\n---|\n\nb");
  });

  it("select the first header of a new table", () => {
    // Act
    const after = run(table, "|");

    // Assert
    expect(after).toBe("| ‹列 1› | 列 2 |\n| --- | --- |\n|  |  |");
  });

  it("fence the selected lines or open an empty fence", () => {
    // Act / Assert
    expect(run(codeBlock, "x\nl‹ine 1\nli›ne 2\ny")).toBe("x\n```|\nline 1\nline 2\n```\ny");
    expect(run(codeBlock, "|")).toBe("```\n|\n```");
  });

  it("wrap a tag plugin around the selected lines or select its placeholder", () => {
    // Arrange
    const note = hexoBlock("{% note info flat %}", "{% endnote %}", "内容");

    // Act / Assert
    expect(run(note, "|")).toBe("{% note info flat %}\n‹内容›\n{% endnote %}");
    expect(run(note, "a\n‹tip›\nb")).toBe("a\n\n{% note info flat %}\ntip\n{% endnote %}|\n\nb");
  });
});

describe("links", () => {
  it("put selected text in the brackets and the cursor in the address", () => {
    // Act / Assert
    expect(run(link, "see ‹docs› now")).toBe("see [docs](|) now");
    expect(run(link, "‹https://hexo.io›")).toBe("[|](https://hexo.io)");
  });
});

describe("format at the cursor", () => {
  it("reports the marks, heading, list and position", () => {
    // Arrange
    const s = state("x\n## a **b *c|* d** e");

    // Act
    const f = formatAt(s);

    // Assert
    expect(f.heading).toBe(2);
    expect(f.marks.sort()).toEqual(["emphasis", "strong"]);
    expect(f.list).toBeNull();
    expect([f.line, f.column]).toEqual([2, 12]);
  });
});

describe("word count", () => {
  it("counts Chinese characters and other words, not markup or addresses", () => {
    // Act
    const n = wordCount("# 你好 world\n\n![图](https://x/y.webp) [链接](https://a.b) **it's** ok\n\n```js\nignored code\n```\n{% note info %}");

    // Assert
    expect(n).toBe(2 + 1 + 2 + 2);
  });
});
