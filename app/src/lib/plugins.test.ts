import { describe, expect, it } from "vitest";
import type { Plugin } from "./api";
import { pluginForKey, pluginSections } from "./plugins";

const plugin = (name: string): Plugin => ({ name, wanted: "^1", version: "1.0.0", description: null, repo: null, fromTheme: false });
const INSTALLED = [
  "hexo-admin",
  "hexo-bilibili-bangumi",
  "hexo-butterfly-envelope",
  "hexo-butterfly-footer-beautify",
  "hexo-deployer-git",
  "hexo-generator-index",
  "hexo-generator-tag",
  "hexo-renderer-markdown-it",
  "hexo-server",
  "hexo-tag-aplayer",
  "hexo-wordcount",
].map(plugin);

describe("pluginForKey", () => {
  it("finds EverettBlog's plugin sections by name, and the few that are not named after theirs", () => {
    // Act
    const owner = (k: string) => pluginForKey(k, INSTALLED)?.name ?? null;

    // Assert
    expect(owner("index_generator")).toBe("hexo-generator-index");
    expect(owner("markdown")).toBe("hexo-renderer-markdown-it");
    expect(owner("aplayer")).toBe("hexo-tag-aplayer");
    expect(owner("bangumi")).toBe("hexo-bilibili-bangumi");
    expect(owner("footer_beautify")).toBe("hexo-butterfly-footer-beautify");
    expect(owner("admin")).toBe("hexo-admin");
    expect(owner("envelope_comment")).toBe("hexo-butterfly-envelope");
    expect(owner("deploy")).toBe("hexo-deployer-git");
    expect(owner("server")).toBe("hexo-server");
  });

  it("claims nothing for Hexo's own keys or a plugin that is not listed", () => {
    // Act / Assert
    expect(pluginForKey("permalink", INSTALLED)).toBeNull();
    expect(pluginForKey("feed", INSTALLED)).toBeNull();
    expect(pluginForKey("deploy", [])).toBeNull();
  });
});

describe("pluginSections", () => {
  it("puts plugins with settings first and keeps keys no plugin claims", () => {
    // Act
    const s = pluginSections(["title", "markdown", "deploy", "feed", "permalink"], [plugin("hexo-wordcount"), plugin("hexo-renderer-markdown-it"), plugin("hexo-deployer-git")]);

    // Assert
    expect(s.plugins.map((v) => [v.plugin.name, v.keys])).toEqual([
      ["hexo-renderer-markdown-it", ["markdown"]],
      ["hexo-deployer-git", ["deploy"]],
      ["hexo-wordcount", []],
    ]);
    expect(s.unclaimed).toEqual(["feed"]);
  });
});
