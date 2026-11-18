你接手开发 **Hexo-Studio**：一个纯本地、仅 macOS 的 Tauri 2 桌面应用，用来管理我的 Hexo 博客（写文章、主题真实效果预览、hexo clean/generate/deploy、阿里云 OSS 图片上传与管理）。

## 先读这些

1. `Workspace Of Claude/Hexo-Studio/docs/design.md`：完整设计方案。目标、进程模型、各模块做法、代码结构、里程碑、已确认的决定、待实测和待确认事项都在里面，**以它为准**。
2. `Workspace Of Claude/Mihomo-Monitor`：工程骨架照它来。`app/` 子目录、pnpm、Vite + React 18 + Tailwind + lucide-react、Tauri 与 `@tauri-apps/*` 的版本、`rust-toolchain.toml`、Rust 侧 `domain / infra / service / shell` 分层，界面风格（自绘标题栏等）也参考它。它的 `docs/design.md` 是设计文档的写法范例。
3. `Workspace Of Claude/Claude-Hydra`：同一套技术栈的另一个项目。`app/src-tauri/src/clash.rs` 里的 `mihomo_exe()` 处理过“从 Finder 启动的应用拿不到 shell PATH”的问题，可参考。
4. 目标博客：`Workspace Of GitHub/EverettBlog`（我的 Mac 上是 `~/Data/Workspace Of GitHub/EverettBlog`），Hexo 7.3 + anzhiyu 主题。

## 这次要做的

按设计文档第 9 节的顺序推进：先完成 **M1（写作与预览）**，验证通过后接着做 **M2（部署）**。

**M3 开工前必须先停下来问我**：
- 设计文档第 12 节的 Q1（新图片放在 OSS 的什么路径）和 Q2（是否压缩、默认参数）；
- OSS 的 RAM 子账号 AccessKey 要由我创建并提供，你不要代我操作阿里云控制台。

## 硬性约束

- **不要修改 `EverettBlog` 仓库里的任何文件**：另一个 Agent 正在那里做网页端的工作。需要用真实博客测试时，把它复制到临时目录（包括 `node_modules`，或者在副本里 `npm install`），在副本上运行 `hexo server` / `generate`，并且**不要在副本上执行 `hexo deploy`**（那会推送到线上部署仓库）。部署功能用一个本地的 bare git 仓库作为 `deploy.repo` 来测。
- 不改动任何云端配置（Vercel、GitHub、DNS、阿里云）。
- 只做 macOS。构建和界面实测需要在 Mac 上进行；如果你的环境不是 macOS，能做的先做（Rust 单测、`tsc` 类型检查、前端构建），并在汇报里写清楚哪些项还没在 Mac 上验证。
- 写入文章时必须保留未知字段、字段顺序、注释和日期写法（见设计文档 3.2 节），用 `yaml` 包的 Document API 只改动改过的键。
- 计算文章地址必须用博客 `_config.yml` 里的 `timezone`（Asia/Shanghai）。用 UTC 会让 0–8 点发布的文章日期差一天，这个问题已经实际出现过。

## 已知的坑（设计文档里都有，开发时注意）

- `hexo server` 和 `generate` / `deploy` 会同时写 `db.json`，执行部署类命令前要先停预览服务器（设计文档第 2 节的互斥）。
- 预览里 `/api/*`（欢迎语、音乐、访问统计）不可用，这是正常的，线上由 Vercel 函数提供，不要去“修”。
- `hexo deploy` 曾被 GitHub Push Protection（`GH013`）拦截过，原因是 Twikoo 打包文件里的示例 SecretId 被误报。部署日志要能识别这类错误，并显示 GitHub 给出的放行链接。

## 工作方式

- 设计文档第 11 节的“待实测”事项，做到相关功能时实测，并把结果写回第 11 节。实测结果和设计不符时，先在文档里更新方案，再改代码。
- 每完成一个里程碑：在设计文档第 9 节打 ✅；新做出的决定补进第 10 节；跑通 Rust 单测（Arrange-Act-Assert，domain 层全覆盖）和 `pnpm typecheck`；然后向我汇报做了什么、怎么验证的、哪些还没验证。
- 仓库已经 `git init`，在 `main` 上还没有提交。是否提交、是否推到 GitHub，问我之后再做。
