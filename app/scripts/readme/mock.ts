// A stand-in for the Rust side, answering from demo.json (made by demo.py), and a script per
// screenshot that clicks through the interface. Loaded before the app (see entry.ts).

type Json = Record<string, any>;

// `#posts` takes the shot as listed below; `#posts~vscode~dark` draws it in another theme and mode.
const [shot, themeOverride, modeOverride] = (location.hash.slice(1) || "posts").split("~");
const demo: Promise<Json> = fetch("./demo.json").then((r) => r.json());
const BLOG_DIR = "/Users/qingchuan/Blogs/qingchuan-blog";
const DATA_DIR = "/Users/qingchuan/Library/Application Support/Hexo-Studio";
const now = Math.floor(Date.now() / 1000);

/** Per screenshot: welcome page or the open blog, the theme and light / dark. */
const SHOTS: Record<string, { open: boolean; mode: "light" | "dark"; theme: string; steps: [string, boolean?][] }> = {
  welcome: { open: false, mode: "light", theme: "default", steps: [] },
  "new-blog": { open: false, mode: "light", theme: "default", steps: [["新建博客…"]] },
  posts: { open: true, mode: "light", theme: "default", steps: [] },
  "editor-light": { open: true, mode: "light", theme: "default", steps: [["用 Hexo 搭一个自己的博客"]] },
  "editor-dark": { open: true, mode: "dark", theme: "default", steps: [["用 Hexo 搭一个自己的博客"]] },
  "editor-instant": { open: true, mode: "light", theme: "default", steps: [["用 Hexo 搭一个自己的博客"]] },
  images: { open: true, mode: "light", theme: "default", steps: [["图片", true]] },
  config: { open: true, mode: "light", theme: "default", steps: [["配置", true], ["主题", true], ["menu"]] },
  source: { open: true, mode: "light", theme: "default", steps: [["源码", true], ["写完《用 Hexo 搭一个自己的博客》"]] },
  deploy: { open: true, mode: "light", theme: "default", steps: [["部署", true]] },
  settings: { open: true, mode: "light", theme: "default", steps: [["设置", true], ["编辑器"]] },
  "config-vscode": { open: true, mode: "light", theme: "vscode", steps: [["配置", true], ["主题", true], ["aside"]] },
};
const plan = { ...(SHOTS[shot] ?? SHOTS.posts) };
if (themeOverride) plan.theme = themeOverride;
if (modeOverride === "light" || modeOverride === "dark") plan.mode = modeOverride;

const config = (d: Json) => ({
  title: d.title,
  url: "https://qingchuan.example.com",
  root: "/",
  permalink: ":year/:month/:day/:title/",
  timezone: "Asia/Shanghai",
  deploy: [{ kind: "git", repo: "git@github.com:qingchuan/qingchuan.github.io.git", branch: "main" }],
});
const node = { manual: null, path: "/opt/homebrew/bin/node", version: "v22.13.1", error: null };

const commits = [
  ["写完《用 Hexo 搭一个自己的博客》", 0.2],
  ["周末徒步的照片换成图片库地址", 3],
  ["配置：侧栏加上作者卡片", 9],
  ["新文章：Rust 的所有权", 26],
  ["今年读完的 24 本书", 41],
  ["换成安知鱼主题", 62],
].map(([subject, days], i) => ({ hash: (0x9f3c2a1 + i * 0x1d4b7).toString(16) + "e8d0a5b2c4f6", subject, author: "晴川", time: Math.round(now - Number(days) * 86400) }));

const deployLog = [
  "INFO  Validating config",
  "INFO  Deleted database.",
  "INFO  Deleted public folder.",
  "INFO  Start processing",
  "INFO  Files loaded in 1.38 s",
  "INFO  Generated: index.html",
  "INFO  Generated: 2026/11/18/hexo-blog-setup/index.html",
  "INFO  Generated: 2026/11/09/weekend-hiking/index.html",
  "INFO  Generated: archives/index.html",
  "INFO  Generated: categories/index.html",
  "INFO  48 files generated in 812 ms",
  "INFO  Deploying: git",
  "INFO  Clearing .deploy_git folder...",
  "INFO  Copying files from public folder...",
  "[main 4c1e9a2] Site updated: 2026-11-22 10:41:05",
  " 48 files changed, 312 insertions(+), 97 deletions(-)",
  "To github.com:qingchuan/qingchuan.github.io.git",
  "   a81f3d0..4c1e9a2  HEAD -> main",
  "INFO  Deploy done: git",
];

const TEMPLATES = [
  {
    id: "anzhiyu",
    name: "安知鱼 anzhiyu",
    description: "卡片式设计的中文主题，基于 butterfly 修改，自带文章目录、侧栏卡片、评论与搜索等，配置页对它有专门的分组。",
    theme: "anzhiyu",
    package: "hexo-theme-anzhiyu",
    plugins: ["hexo-renderer-pug", "hexo-renderer-stylus"],
    credits: { author: "安知鱼（anzhiyu）", authorUrl: "https://blog.anheyu.com/", website: "https://hexo.anheyu.com/", docs: "https://docs.anheyu.com/", repo: "https://github.com/anzhiyu-c/hexo-theme-anzhiyu", license: "GPL-3.0" },
  },
];
const HEXO_CREDITS = { author: "Hexo 团队", authorUrl: "https://github.com/hexojs", website: "https://hexo.io/zh-cn/", docs: "https://hexo.io/zh-cn/docs/", repo: "https://github.com/hexojs/hexo", license: "MIT" };

async function answer(cmd: string, args: Json): Promise<unknown> {
  const d = await demo;
  switch (cmd) {
    case "app_info":
      return { version: "1.0.0", dataDir: DATA_DIR };
    case "ui_preferences":
      return { mode: plan.mode, theme: plan.theme, previewShare: 0.5, instantPreview: shot === "editor-instant", webStorageMigrated: true };
    case "user_profile":
      return { name: d.author, avatar: null };
    case "blog_status":
      return plan.open ? { dir: BLOG_DIR, error: null, config: config(d), hexoError: null, remote: "git@github.com:qingchuan/blog-source.git", node } : { dir: null, error: null, config: null, hexoError: null, remote: null, node };
    case "recent_projects":
      return [
        { path: BLOG_DIR, name: d.title, remote: "git@github.com:qingchuan/blog-source.git", openedAt: now - 3600, error: null },
        { path: "/Users/qingchuan/Blogs/travel-notes", name: "在路上", remote: "https://github.com/qingchuan/travel-notes.git", openedAt: now - 4 * 86400, error: null },
        { path: "/Users/qingchuan/Work/team-docs", name: "团队周报", remote: null, openedAt: now - 23 * 86400, error: null },
      ];
    case "new_blog_form":
      return { templates: TEMPLATES, hexo: HEXO_CREDITS, parent: "/Users/qingchuan/Blogs", author: d.author };
    case "list_posts":
      return d.posts;
    case "read_post":
      return d.files[args.id];
    case "preview_state":
      return { state: "running", port: d.port };
    case "preview_log":
      return [{ stream: "out", text: `INFO  Hexo is running at http://localhost:${d.port}/ . Press Ctrl+C to stop.` }];
    case "preview_probe":
    case "preview_await_change":
      return { status: 200, hash: "demo" };
    case "blog_git_changes":
      return 2;
    case "config_read":
      return { path: args.file === "site" ? "_config.yml" : args.file === "theme" ? "_config.anzhiyu.yml" : "themes/anzhiyu/_config.yml", exists: true, text: d.config[args.file], fingerprint: args.file };
    case "list_plugins":
      return d.plugins;
    case "data_files":
      return [];
    case "storage_profiles":
      return {
        projectName: "qingchuan-blog",
        name: null,
        profiles: [{ id: "oss", name: "阿里云 OSS", storage: { kind: "aliyunOss", bucket: "qingchuan-img", area: "oss-cn-hangzhou", path: "blog", customUrl: "https://img.qingchuan.example.com" }, upload: { format: "webp", style: "image", quality: 82, maxEdge: 2560 }, accessKeyId: "LTAI5t••••", images: d.images.length }],
        active: "oss",
        backupDir: "/Users/qingchuan/Pictures/Hexo-Studio",
      };
    case "image_library":
      return { images: d.images, unadopted: 0, titles: d.titles };
    case "source_status":
      return { branch: "main", upstream: "origin/main", upstreamGone: false, ahead: 1, behind: 0, changes: [{ path: "source/_posts/hexo-blog-setup.md", from: null, kind: "modified" }, { path: "source/_drafts/kitchen-notes.md", from: null, kind: "untracked" }] };
    case "source_commits":
      return args.skip ? [] : commits;
    case "source_commit_detail": {
      const c = commits.find((c) => c.hash === args.hash)!;
      return { ...c, email: "qingchuan@example.com", body: "补上部署一节和配图，摘要改短。", files: [
        { path: "source/_posts/hexo-blog-setup.md", from: null, kind: "modified", added: 42, removed: 7 },
        { path: "_config.anzhiyu.yml", from: null, kind: "modified", added: 3, removed: 1 },
      ] };
    }
    case "list_runs":
      return [{ id: 1, task: { kind: "deploy" }, label: "部署", status: "succeeded", startedAt: Date.now() - 95_000, endedAt: Date.now() - 71_000, lines: deployLog.map((text) => ({ stream: "out", level: "info", text })), problems: [], notes: [], created: null }];
    case "plugin:updater|check":
    case "plugin:event|listen":
      (listeners[args.event] ??= []).push(args.handler);
      return args.handler;
    case "plugin:event|unlisten":
    default:
      return null;
  }
}

let nextId = 1;
const callbacks: Record<number, (e: unknown) => void> = {};
const listeners: Record<string, number[]> = {};
/** Sends an event as the Rust side would (for trying the interface by hand: `__emit("posts-changed", ...)`). */
(window as any).__emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach((id) => callbacks[id]?.({ event, payload, id: 0 }));
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  transformCallback: (cb: (e: unknown) => void) => {
    callbacks[nextId] = cb;
    return nextId++;
  },
  unregisterCallback() {},
  invoke: (cmd: string, args: Json = {}) => answer(cmd, args),
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The visible button whose text is (or starts with) `text`. */
function button(text: string, exact?: boolean): HTMLElement | undefined {
  const all = [...document.querySelectorAll<HTMLElement>("button")].filter((b) => b.offsetParent !== null);
  const label = (b: HTMLElement) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
  return all.find((b) => (exact ? label(b) === text : label(b).startsWith(text) || (b.textContent ?? "").includes(text)));
}

/** Clicks through the screenshot's steps; Chrome takes the picture when its time budget runs out. */
export async function play() {
  await wait(1500);
  for (const [text, exact] of plan.steps) {
    const b = button(text, exact);
    if (!b) console.error(`readme shot ${shot}: no button "${text}"`);
    b?.click();
    await wait(1500);
  }
  // No caret or focus ring in the picture.
  (document.activeElement as HTMLElement | null)?.blur();
}
