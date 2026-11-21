import { describe, expect, it } from "vitest";
import { appendItem, blankLike, getIn, joinLink, merge, outline, pathKey, readConfig, removeItem, removeKey, renameKey, setValue, splitLink } from "./configYaml";

const THEME = `# Code Blocks (代码相关)
# --------------------------------------

highlight_theme: light #  darker / pale night / light / ocean / mac / mac light / false
highlight_copy: true # copy button

# social settings (社交图标设置)
social:
  Github: https://github.com/x || anzhiyu-icon-github
  BiliBili: 'https://space.bilibili.com/1 || anzhiyu-icon-bilibili'

# Footer Settings
# --------------------------------------
footer:
  owner:
    enable: true
    since: 2020
  list:
    enable: false
    project:
      - title: 服务
        links:
          - title: 51la统计
            link: https://v6.51.la/
  custom_text:

inject:
  head:
    # 自定义css
    - <link rel="stylesheet" href="/css/music-player.css">

  bottom:
    - <script src="/js/a.js"></script>
    - <script src="/js/b.js"></script>
tags: [a, b]
`;

const data = (t: string) => readConfig(t).data;

describe("setValue", () => {
  it("rewrites only the value, keeping the inline comment and everything else", () => {
    // Act
    const out = setValue(THEME, ["highlight_theme"], "mac");

    // Assert
    expect(out).toBe(THEME.replace("highlight_theme: light #", "highlight_theme: mac #"));
  });

  it("keeps the quotes the author chose", () => {
    // Act
    const out = setValue(THEME, ["social", "BiliBili"], "https://space.bilibili.com/2 || anzhiyu-icon-bilibili");

    // Assert
    expect(out).toContain("  BiliBili: 'https://space.bilibili.com/2 || anzhiyu-icon-bilibili'\n");
  });

  it("sets nested switches and numbers", () => {
    // Act
    const out = setValue(setValue(THEME, ["footer", "owner", "enable"], false), ["footer", "owner", "since"], 2024);

    // Assert
    expect(getIn(data(out), ["footer", "owner"])).toEqual({ enable: false, since: 2024 });
    expect(out.split("\n").length).toBe(THEME.split("\n").length);
  });

  it("fills an empty value after its colon and empties it back to `key:`", () => {
    // Act
    const filled = setValue(THEME, ["footer", "custom_text"], "Hi");
    const emptied = setValue(filled, ["footer", "custom_text"], null);

    // Assert
    expect(filled).toContain("  custom_text: Hi\n");
    expect(emptied).toBe(THEME);
  });

  it("writes text a plain value would misread with quotes", () => {
    // Act
    const out = setValue(THEME, ["highlight_theme"], "a: b # c");

    // Assert
    expect(getIn(data(out), ["highlight_theme"])).toBe("a: b # c");
  });

  it("writes multi-line text as one quoted value", () => {
    // Act
    const out = setValue(THEME, ["footer", "custom_text"], "line 1\nline 2");

    // Assert
    expect(getIn(data(out), ["footer", "custom_text"])).toBe("line 1\nline 2");
  });

  it("edits an item of a list of objects", () => {
    // Act
    const out = setValue(THEME, ["footer", "list", "project", 0, "links", 0, "title"], "统计");

    // Assert
    expect(out).toContain("          - title: 统计\n");
  });

  it("keeps a flow list in flow form", () => {
    // Act
    const out = setValue(THEME, ["tags", 1], "c, d");

    // Assert
    expect(getIn(data(out), ["tags"])).toEqual(["a", "c, d"]);
    expect(out).toContain("tags: [a, ");
  });

  it("adds a key only the defaults have under its parent, at the parent's indent", () => {
    // Act
    const out = setValue(THEME, ["footer", "owner", "author"], "Rain");

    // Assert
    expect(out).toContain("    since: 2020\n    author: Rain\n");
    expect(getIn(data(out), ["footer", "owner", "author"])).toBe("Rain");
  });

  it("adds a missing section with all its levels", () => {
    // Act
    const out = setValue(THEME, ["nav", "travelling", "enable"], true);

    // Assert
    expect(getIn(data(out), ["nav"])).toEqual({ travelling: { enable: true } });
    expect(out.startsWith(THEME.trimEnd())).toBe(true);
  });

  it("starts an empty file", () => {
    // Act
    const out = setValue("", ["nav", "enable"], false);

    // Assert
    expect(out).toBe("nav:\n  enable: false\n");
  });

  it("refuses to change a file it cannot read", () => {
    // Act / Assert
    expect(() => setValue("a: [1,\n", ["a"], 1)).toThrow();
  });

  it("leaves a value folded over several lines alone when it does not change", () => {
    // Arrange
    const folded = "aside:\n  content: <span>one</span>\n    <span>two</span> # 必须项\n";

    // Act
    const same = setValue(folded, ["aside", "content"], "<span>one</span> <span>two</span>");
    const edited = setValue(folded, ["aside", "content"], "<span>1</span> <span>two</span>");

    // Assert
    expect(same).toBe(folded);
    expect(getIn(data(edited), ["aside", "content"])).toBe("<span>1</span> <span>two</span>");
    expect(edited).toContain("# 必须项");
  });
});

describe("lists", () => {
  it("adds an item in the list's own dash indent", () => {
    // Act
    const out = appendItem(THEME, ["inject", "bottom"], '<script src="/js/c.js"></script>');

    // Assert
    expect(out).toContain('    - <script src="/js/b.js"></script>\n    - <script src="/js/c.js"></script>\n');
  });

  it("adds an object item shaped like the others", () => {
    // Act
    const like = getIn(data(THEME), ["footer", "list", "project", 0, "links", 0]);
    const out = appendItem(THEME, ["footer", "list", "project", 0, "links"], blankLike(like));

    // Assert
    expect(getIn(data(out), ["footer", "list", "project", 0, "links"])).toEqual([
      { title: "51la统计", link: "https://v6.51.la/" },
      { title: "", link: "" },
    ]);
  });

  it("removes one item and keeps the comment over the list", () => {
    // Act
    const out = removeItem(THEME, ["inject", "bottom"], 0);

    // Assert
    expect(getIn(data(out), ["inject", "bottom"])).toEqual(['<script src="/js/b.js"></script>']);
    expect(out).toContain("    # 自定义css\n");
  });

  it("removing the last item leaves an empty list, not an empty value", () => {
    // Act
    const out = removeItem(THEME, ["inject", "head"], 0);

    // Assert
    expect(getIn(data(out), ["inject", "head"])).toEqual([]);
  });

  it("edits flow lists in flow form", () => {
    // Act
    const out = removeItem(appendItem(THEME, ["tags"], "c"), ["tags"], 0);

    // Assert
    expect(out).toContain("tags: [b, c]");
  });
});

describe("merge (Hexo's deepMerge)", () => {
  it("merges objects key by key and lets null override", () => {
    // Act
    const out = merge({ a: { x: 1, y: 2 }, n: 5 }, { a: { x: 9 }, n: null });

    // Assert
    expect(out).toEqual({ a: { x: 9, y: 2 }, n: null });
  });

  it("never drops a default list item: lists merge by position and only grow", () => {
    // Act
    const out = merge({ l: [1, 2, 3] }, { l: [7] });
    const shorter = merge({ l: ["a", "b", "c"] }, { l: ["a", "c"] });

    // Assert
    expect(out).toEqual({ l: [1, 2, 3, 7] });
    expect(shorter).toEqual({ l: ["a", "b", "c"] });
  });

  it("merges objects inside lists by position", () => {
    // Act
    const out = merge({ l: [{ a: 1, b: 2 }] }, { l: [{ a: 9 }, { c: 3 }] });

    // Assert
    expect(out).toEqual({ l: [{ a: 9, b: 2 }, { c: 3 }] });
  });

  it("does not change its inputs", () => {
    // Arrange
    const defaults = { a: { x: 1 }, l: [1] };

    // Act
    merge(defaults, { a: { x: 2 }, l: [2] });

    // Assert
    expect(defaults).toEqual({ a: { x: 1 }, l: [1] });
  });
});

describe("outline", () => {
  it("reads the comment right above a key and the one beside its value", () => {
    // Act
    const { hints } = outline(THEME);

    // Assert
    expect(hints.get(pathKey(["social"]))).toBe("social settings (社交图标设置)");
    expect(hints.get(pathKey(["highlight_copy"]))).toBe("copy button");
    expect(hints.get(pathKey(["highlight_theme"]))).toBe("darker / pale night / light / ocean / mac / mac light / false");
    expect(hints.get(pathKey(["inject", "head"]))).toBeUndefined();
  });

  it("groups top-level keys under the file's own section headers", () => {
    // Act
    const { groups } = outline(THEME);

    // Assert
    expect(groups).toEqual([
      { title: "Code Blocks (代码相关)", keys: ["highlight_theme", "highlight_copy", "social"] },
      { title: "Footer Settings", keys: ["footer", "inject", "tags"] },
    ]);
  });

  it("finds a header that follows a nested block", () => {
    // Arrange
    const text = "search:\n  local:\n    enable: false\n\n# Math (数学)\n# ------------\n# About the per_page\nmathjax:\n  enable: false\n";

    // Act
    const { groups, hints } = outline(text);

    // Assert
    expect(groups).toEqual([
      { title: "", keys: ["search"] },
      { title: "Math (数学)", keys: ["mathjax"] },
    ]);
    expect(hints.get(pathKey(["mathjax"]))).toBe("About the per_page");
  });
});

describe("blankLike", () => {
  it("keeps the keys and empties the values", () => {
    // Act / Assert
    expect(blankLike({ title: "x", enable: true, n: 3, links: [{ a: 1 }] })).toEqual({ title: "", enable: false, n: 0, links: [] });
  });
});

describe("keys", () => {
  const MENU = "menu:\n  文章:\n    归档: /archives/ || anzhiyu-icon-box-archive # 归档页\n    标签: /tags/ || anzhiyu-icon-tags\n\n  # 友链:\n  我的:\n    相册: /album/ || anzhiyu-icon-images\nnav:\n  enable: true\n";

  it("renames a key in place, keeping its value, comment and position", () => {
    // Act
    const out = renameKey(MENU, ["menu", "文章", "归档"], "时间线");

    // Assert
    expect(out).toBe(MENU.replace("    归档:", "    时间线:"));
  });

  it("refuses a name the parent already has", () => {
    // Act / Assert
    expect(() => renameKey(MENU, ["menu", "文章", "归档"], "标签")).toThrow();
  });

  it("removes a key with every line of its value and keeps the comments around it", () => {
    // Act
    const one = removeKey(MENU, ["menu", "文章", "标签"]);
    const group = removeKey(MENU, ["menu", "我的"]);

    // Assert
    expect(one).toBe(MENU.replace("    标签: /tags/ || anzhiyu-icon-tags\n", ""));
    expect(getIn(data(group), ["menu"])).toEqual({ 文章: { 归档: "/archives/ || anzhiyu-icon-box-archive", 标签: "/tags/ || anzhiyu-icon-tags" } });
    expect(group).toContain("  # 友链:\n");
  });

  it("adds a menu item after the others at their indent", () => {
    // Act
    const out = setValue(MENU, ["menu", "文章", "分类"], joinLink("/categories/", "anzhiyu-icon-shapes"));

    // Assert
    expect(out).toContain("    标签: /tags/ || anzhiyu-icon-tags\n    分类: /categories/ || anzhiyu-icon-shapes\n");
  });
});

describe("link || icon", () => {
  it("splits and joins anzhiyu's link values", () => {
    // Act / Assert
    expect(splitLink("/archives/ || anzhiyu-icon-box-archive")).toEqual({ link: "/archives/", icon: "anzhiyu-icon-box-archive" });
    expect(splitLink("https://x.com/a||fab fa-x")).toEqual({ link: "https://x.com/a", icon: "fab fa-x" });
    expect(splitLink("/plain/")).toBeNull();
    expect(joinLink(" /a/ ", "icon")).toBe("/a/ || icon");
    expect(joinLink("/a/", " ")).toBe("/a/");
  });
});

describe("a file whose top level is a list", () => {
  const LINKS = "- class_name: 框架\n  link_list:\n    - name: Hexo\n\n- class_name: 推荐博客\n  link_list: []\n";

  it("adds a group after the others and removes one with its lines", () => {
    // Act
    const added = appendItem(LINKS, [], blankLike(readConfig(LINKS).data && (readConfig(LINKS).data as unknown[])[0]));
    const removed = removeItem(LINKS, [], 0);

    // Assert
    expect(added).toBe(`${LINKS}- class_name: ""\n  link_list: []\n`);
    expect(removed).toBe("- class_name: 推荐博客\n  link_list: []\n");
  });

  it("adding then removing the last group gives back a file that had no final newline", () => {
    // Arrange
    const noNewline = "- class_name: 赞赏\n  reward_list:\n    - name: a";

    // Act
    const out = removeItem(appendItem(noNewline, [], { class_name: "", reward_list: [] }), [], 1);

    // Assert
    expect(out).toBe(noNewline);
  });
});
