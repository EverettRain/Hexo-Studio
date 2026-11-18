# Hexo-Studio 设计方案（v1）

> 状态：方向已确认（见第 10 节）。标 **【待实测】** 的地方要在真实环境验证（见第 11 节）；标 **【待确认】** 的地方开工到对应里程碑前先问用户（见第 12 节）。

## 1. 目标与约束

| 项 | 要求 |
| --- | --- |
| 做什么 | 本地管理 Hexo 博客：文章 / 草稿的列表与编辑、主题真实效果的实时预览、`hexo clean / generate / deploy` 一键执行并看日志、阿里云 OSS 图片的上传插入与管理 |
| 不做什么 | 不改动任何云端配置（Vercel、GitHub、DNS）；不做在线写作；不内置 Node / Hexo，使用博客项目自己的 `node_modules` |
| 目标博客 | `Workspace Of GitHub/EverettBlog`：Hexo 7.3 + anzhiyu 主题，部署方式 `hexo-deployer-git` → `EverettRain.github.io` → Vercel |
| 通用性 | 博客路径在设置里选择；front-matter 字段、图片约定等**按这个博客的实际约定实现**，不为其他主题预先抽象 |
| 平台 | 仅 macOS（Apple Silicon 优先） |
| 技术栈 | Tauri 2 + React 18 + Vite + Tailwind + lucide-react，工程骨架沿用 Mihomo-Monitor（pnpm、`app/` 子目录、Rust 侧 domain / infra / service / shell 分层） |

## 1.1 项目模型（像 VS Code 一样打开项目）

- **启动先到欢迎页**：最近打开的项目（名称、路径、git 远程地址）、“打开文件夹…”、当前版本与检查更新。选一个项目才进入写作界面；写作界面里可以随时“切换项目”回到欢迎页。
- **项目 = 一个本地 Hexo 博客目录**（通常是 GitHub 上博客源码仓库的本地克隆）。只打开本地文件夹，不做克隆；打开时按 3.1 节校验。
- **单窗口**：同一时刻只打开一个项目、只有一个预览服务器。切换项目时停止预览；有命令在执行时不允许切换。以后需要再扩展成多窗口。
- **`.hexostudio/` 目录**：打开项目时在博客根目录自动创建，参照 `.vscode/`：

  | 路径 | 内容 | 是否进 git |
  | --- | --- | --- |
  | `.hexostudio/settings.json` | 项目设置（M3 起：OSS 桶、地域、路径前缀、压缩参数等），有设置项时才创建 | 进，换电脑也带得走 |
  | `.hexostudio/local/` | 本机状态：预览服务器进程号 `preview.pid` 等 | 不进 |
  | `.hexostudio/.gitignore` | 内容为 `local/`，让上一行生效，不必改博客根目录的 `.gitignore` | 进 |

  Hexo 只处理 `source/` 和主题目录，根目录下的点目录不参与生成和部署（与 `.deploy_git` 相同）。密钥一律只放钥匙串，不进这个目录。
- **应用数据目录**（`~/Library/Application Support/Hexo-Studio`）只放与机器相关的：最近项目列表、Node 路径、日志。界面主题在 WebView 的本地存储里。

## 2. 进程模型

单个 Tauri 应用，普通窗口（不需要托盘常驻）、单实例。Rust 主进程按需拉起两类 Node 子进程：

| 子进程 | 生命周期 | 说明 |
| --- | --- | --- |
| 预览服务器 `hexo server --draft -p <空闲端口>` | 打开编辑器时启动、退出应用或执行部署前停止 | 长驻，日志流到前端“预览日志” |
| 一次性命令 `hexo clean` / `generate` / `deploy` / `new` / `publish` | 执行完即退出 | 标准输出 / 错误逐行通过 Tauri 事件推给前端 |

- 所有子进程以独立进程组启动，停止时整组终止；应用退出时清理全部子进程，不留孤儿 `hexo server`。
- **同一时刻只允许一个会写 `db.json` / `public/` 的操作**：`generate`、`deploy`、`clean` 执行前自动停止预览服务器，结束后按需恢复。用一个全局互斥（service 层的 runner 状态机）保证。

### 2.1 找到 Node（macOS 的 PATH 问题）

从 Finder / Dock 启动的应用拿不到用户 shell 里的 `PATH`（nvm、fnm、Volta、Homebrew 装的 node 都找不到）。顺序：

1. 设置里用户手动指定的 Node 可执行文件路径；
2. 启动时用用户的登录 shell 解析一次 `PATH`：执行 `$SHELL -lic`，用前后标记取出 `$PATH`（忽略 shell 欢迎语等输出），5 秒超时。`fix-path-env-rs` 没有发布到 crates.io（只能 git 依赖），且会改写整个进程环境，所以不用它，自己实现这十几行；
3. 常见位置兜底：`/opt/homebrew/bin`、`/usr/local/bin`、`~/.volta/bin`、`~/.nvm/versions/node/*/bin`（取最高版本）。

Hexo 一律用博客项目里的 `node_modules/.bin/hexo` 执行（不用 `npx`，避免意外下载）；找不到时提示用户在博客目录执行 `npm install`。具体是 `<node> node_modules/.bin/hexo …`，子进程的 `PATH` = Node 所在目录 + 登录 shell 的 `PATH` + 兜底目录 + `/usr/bin:/bin:/usr/sbin:/sbin`（hexo-deployer-git 要用 `git`、`ssh`）。

所有 Hexo 子进程都带 `TZ=<_config.yml 的 timezone>`：Hexo 把无时区的 `date` 按配置时区解释，却用**进程时区**格式化地址里的年月日（`post_permalink` 里的 `date.format('YYYY')`）。实测同一份博客 `TZ=UTC` 生成 `2025/11/23/pointer-security/`，`TZ=Asia/Shanghai` 生成 `2025/11/24/…`。设上 `TZ` 后，无论 Mac 在哪个时区，预览、生成、部署的地址都与第 4 节的计算一致。

## 3. 博客项目

### 3.1 识别与读取

- 用户选择目录后校验：存在 `_config.yml`、`package.json` 且依赖里有 `hexo`、存在 `source/`。
- 读取 `_config.yml` 中用到的字段：`permalink`、`timezone`、`new_post_name`、`source_dir`、`url`、`deploy`。只读，不写回。

### 3.2 文章与草稿

| 目录 | 含义 |
| --- | --- |
| `source/_posts/*.md` | 已发布文章（25 篇，可有子目录） |
| `source/_drafts/*.md` | 草稿（4 篇；`render_drafts: false`，只在预览服务器的 `--draft` 下可见） |
| `scaffolds/post.md`、`draft.md` | 新建模板，新建文章 / 草稿走 `hexo new` / `hexo new draft`，保持与命令行一致 |

front-matter 实际使用情况（25 篇文章统计，4 篇草稿字段相同）：

| 字段 | 出现次数 | 表单控件 |
| --- | --- | --- |
| `title` / `date` / `tags` / `categories` / `description` / `cover` | 29 | 文本 / 日期时间 / 标签输入 / 分类输入 / 多行文本 / 图片（可从 OSS 选） |
| `top_img`、`noticeOutdate`、`copyright_author` / `copyright_url` / `copyright_info` | 7–8 | 折叠在“更多”里 |
| 其他（`swiper_index`、`highlight_shrink`、`abbrlink` 等） | 1 | 不做控件，原样保留 |

- **保存时必须原样保留**未知字段、字段顺序、注释与日期写法（现有写法 `date: 2025-11-24 01:14:20`，无时区，按 `_config.yml` 的 `timezone` 解释）。前端用 `yaml` 包（Hydra 已在用）的 Document API 只改动表单改过的键，不整体重新序列化。
  - 实测：`parseDocument(...).toString()` 即使什么都不改也不是逐字节还原：行尾空格会被删掉（29 篇里 4 篇有，如 `tags: `、`cover: … `），值后面换行的注释会被挪位。所以做法是：用 Document API 找到改动键的 `key` / `value` 节点在源文本里的区间，只把这一段替换成新序列化的 `key: value`，其余字节不动；新键追加在末尾；清空的键保留为 `key:`。替换后重新解析，与“原值 + 改动”逐键比对，不一致就拒绝保存并提示改用源码模式（`app/src/lib/frontmatter.ts`）。
  - 改动键沿用原值的风格：列表的 flow / block 与缩进、作者主动加的引号（值本来就必须加引号时不沿用，否则输入过程中出现过的尾随空格会让引号一直留着）。
  - 对 29 篇真实文章同时改标题、标签、描述、`noticeOutdate`，其余行全部逐字节相同。
- 表单只覆盖常用字段，另有“源码”模式直接编辑整段 YAML；YAML 有语法错误时自动进入源码模式。
- 写文件是**原地覆写**而不是“写临时文件再改名”：没有 `date` 的文章 Hexo 用文件创建时间定日期（见第 4 节），换成新文件会让文章地址变掉。
- 保存时带上读取时内容的指纹；磁盘上的内容已被别处（其他编辑器、git）改过就不写，提示“重新载入 / 保留我的版本”。自动保存让静默覆盖的风险变大，所以这一半的“外部改动检测”提前在 M1 做了；M4 再补监听文件、主动提示。
- 列表页的标题、日期、分类由 Rust 只读解析（`yaml-rust2`），不需要保留格式。
- 正文里大量使用 anzhiyu 标签插件（`{% note %}`、`{% tabs %}`、`{% image %}`、`{% gallery %}` 等），编辑器只当普通文本处理，渲染交给预览服务器。

### 3.3 文件变动

博客目录可能被外部编辑器或 git 同时修改：监听 `source/_posts`、`source/_drafts`（`notify` crate），列表自动刷新；正在编辑的文件被外部改动时提示“重新载入 / 保留我的版本”，不静默覆盖。

## 4. 编辑器与实时预览

布局：左侧编辑栏，右侧预览（可切换 / 拖动分隔）。编辑栏自上而下：

- **工具栏**：段落样式（正文 / 标题 1–4）、加粗、斜体、删除线、行内代码、链接、引用、无序 / 有序 / 任务列表、代码块、表格；“插入”菜单放分割线和本博客文章实际在用的 anzhiyu 标签插件（`note` 信息 / 警告 / 危险 / 公告、`folding`、`tabs`，写法照抄文章里最常见的形式）；图片上传、图库、上传格式（WebP / 原图）。每个按钮都只是改 Markdown 文本，和手打一样；有选区时包住选区，已有该格式时去掉（加粗等按语法树判断光标是否在其中），光标所在处的格式在按钮上高亮。快捷键沿用 Typora / Google Docs：⌘B / ⌘I / ⌘⇧X / ⌘E / ⌘K，⌘0–4 段落样式，⌘⇧7 / 8 / 9 列表，⌘⇧. 引用。查找替换（⌘F）在顶栏。
- **文章信息**（front-matter）：正文上方只有一行摘要（标题、日期、分类、标签、封面缩略图）。点它弹出一个浮在正文上的面板（照 Hydra 的对话框样式：浅灰面板里放白色分组卡片，左侧字段名、右侧控件），分“基本”和“主题选项”两组，另有“源码”模式；改动即时保存，Esc 或点面板外关闭。面板只盖住编辑栏，右侧预览照常可见，改封面、标题能直接看到效果。写正文时很少要看它，所以平时不占地方；YAML 有误时摘要标红。
- **正文**：CodeMirror 6（GFM：表格、删除线、任务列表）；底部状态栏显示行列号和字数（中日韩文字按字、其他按词，不含代码块、图片、链接地址和标签插件）。

- **主题真实预览（主）**：右侧内嵌 `http://127.0.0.1:<端口>/<文章路径>`（服务器用 `-i 127.0.0.1` 只监听本机，避免暴露到局域网；直接写 IP，不依赖 `localhost` 解析到 IPv4 还是 IPv6）。保存（手动 ⌘S 或停止输入约 1 秒后自动保存）后，由 Rust 轮询该地址直到内容变化且不是 404（比较响应体哈希，超时 5 秒；预览页跨源，前端 `fetch` 会被 CORS 拦住，所以放在 Rust），再刷新内嵌页面。
- **滚动位置**：预览页与应用跨源，应用读不到它的滚动位置。用 Tauri 的 `initialization_script_for_all_frames` 往预览 frame 注入一小段脚本，把滚动位置按路径存在该源的 `sessionStorage`，重新载入后恢复；主题在图片、字体加载时还会挪动内容，所以 2.5 秒内反复恢复，直到用户自己滚动。
- **端口**：每次启动取一个空闲端口，不做设置项。
- **清理**：退出应用时停止预览服务器。被强杀或崩溃时来不及停，所以把服务器的进程组号记在数据目录的 `preview.pid`，下次启动时若该进程还在且命令行含 `hexo`，结束整个进程组。
- **文章路径**：按 `_config.yml` 的 `permalink`（本博客为 `:year/:month/:day/:title/`）、文章 `date` 与 `timezone`、文件名计算。注意：时区必须用博客配置的 `Asia/Shanghai`，用系统 / UTC 会算错日期（这个问题已在构建环境里实际出现过），并且 Hexo 子进程设 `TZ`（见第 2.1 节）。`:title` 是 `_posts` / `_drafts` 下去掉扩展名的相对路径（`new_post_name: :title.md` 时 Hexo 不做 slugize）；front-matter 里有 `permalink` 时直接用它。没有 `date` 的文章 Hexo 用**文件创建时间**（`stats.birthtime`，不是当前时间），路径按它在博客时区的日期计算。只支持 `:year :month :day :hour :minute :second :i_month :i_day :title :name`，遇到其他占位符（`:category`、`:hash` 等）不猜，直接显示首页；算出的地址 404 时也退回首页并提示。
- **即时预览（辅，可选）**：markdown-it 在前端即时渲染，用于打字时的零延迟查看；不渲染主题标签插件，界面上注明“仅 Markdown”。M1 不做，按需在 M4 加。
- 预览中 `/api/*`（欢迎语、音乐、访问统计）不可用，属正常现象（线上由 Vercel 函数提供）。

## 5. 部署

部署页三个按钮：清理（`hexo clean`）、生成（`hexo generate`）、部署（`hexo clean && hexo generate && hexo deploy`，即博客现在的发布流程），外加“新建文章 / 草稿”“发布草稿”（`hexo publish`）。

- 日志逐行显示，保留最近 10 次运行记录（内存即可，不落盘；切换项目时清空）。
- 同一时刻只运行一个命令（`service/runner`）；清理 / 生成 / 部署先停预览服务器，结束后若之前在运行就自动恢复；执行期间不能启动预览、不能切换项目。“停止”结束整个进程组，剩余步骤不再执行。
- 部署前弹出确认，显示目标仓库与分支；博客源码仓库有未提交改动时在确认框和日志开头提醒。
- 新建：`hexo new post|draft -- <标题>`（总是写明 layout，标题叫 `draft` 也不会被当成 layout；`--` 防止以 `-` 开头的标题被当成选项），文件名由 Hexo 按标题生成。发布草稿：`hexo publish post -- <slug>`。新文件通过“运行前后文章列表的差集”找到，然后在编辑器打开。
- 失败时高亮关键行并给出提示，已知情形：
  - GitHub Push Protection 拦截（`GH013`，例如 Twikoo 打包文件里的示例 SecretId 曾被误报）→ 显示 GitHub 给出的放行链接；
  - SSH 认证失败 → 提示检查 ssh-agent / 钥匙串；
  - `node_modules` 缺失 → 提示 `npm install`；
  - git 没有设置提交者（`Please tell me who you are`）→ 提示 `git config --global user.name / user.email`（实测：hexo-deployer-git 在没有 git 身份的机器上会在提交这一步失败）。
- 识别规则在 `domain/deploy_log.rs`，GH013 的样例输出按 GitHub 实际格式写进了单测；还用本地 bare 仓库的 `pre-receive` 钩子回放同样的拒绝信息，端到端验证了识别与放行链接显示。
- 部署前检查博客源码仓库（`EverettBlog`）是否有未提交改动，仅提示不阻止。

## 6. 图片与对象存储（OSS）

现状（从文章统计）：存储桶 `hexo-image-storage`，地域 `oss-cn-shanghai`，文章里引用 44 次，**全部平铺在根目录**，文件名多为 `IMG_xxxx_compressed.jpg`（用户上传前会先压缩）。插图写法以 `![](URL)` 为主，少量 `<img>` 和 `{% image %}`。

### 6.1 多家存储（参照 PicGo）

- 像 PicGo 一样把“图床”做成可选的提供方，每个项目选一个。字段沿用 PicGo 的叫法，方便从 PicGo 搬配置：桶（bucket）、地域（area / region）、路径前缀（path）、自定义域名（customUrl）。
- 实现用 Apache OpenDAL（`opendal` crate，一套接口覆盖各家对象存储，签名由其 `reqsign` 负责），不自己写签名。上传、列举、删除都走它；上传由 Rust 发起，不经过 WebView，**不需要给存储桶配 CORS**。
- 接入顺序：**阿里云 OSS**（OpenDAL `oss`，原生 API）先做；同时做“S3 兼容”（OpenDAL `s3`，覆盖七牛 Kodo、Cloudflare R2、AWS S3、MinIO 等，也用于本地用 S3 模拟服务端到端测试）。腾讯云 COS、又拍云、GitHub 之后按需加（OpenDAL 都有对应服务）。SM.MS、Imgur 这类图床 API 不是对象存储，不支持列举，暂不做。
- 公开地址：有自定义域名用 `customUrl/<key>`；否则阿里云为 `https://<bucket>.<area>.aliyuncs.com/<key>`，S3 兼容需填写公开访问地址前缀。
- 凭据：AccessKey ID 与 Secret 都存 macOS 钥匙串（`keyring` crate，按提供方 + 桶区分），不进 `.hexostudio/settings.json`——博客仓库是公开的，ID 也不放进去。RAM 子账号按用户要求暂不处理，先用用户提供的任意可写该桶的 AccessKey。非 macOS 的构建只用于开发和测试，凭据只存在进程内存里（容器里内核 keyring 不可用）。
- OpenDAL 不开默认特性，HTTP 走应用已有的 reqwest（同一版本、同一套 rustls），启动时安装一次传输层。
- “测试连接”只读：列举一个不存在的目录。存在的桶返回空列表；桶不存在、AccessKey 不对时按存储返回的错误码（`NoSuchBucket`、`InvalidAccessKeyId`、`SignatureDoesNotMatch`）给出中文说明。

### 6.2 图片库（2026-11-17 用户确定，取代按页面分目录的方案）

图片按**项目**统一管理，不按文章分目录：一张图可能被多个页面用，“属于哪些页面”是多对多关系，记在图片库里、由扫描实时得出，不体现在存储路径上。

- **对象路径**：`<路径前缀><项目名>/<uid>.webp`。uid = 原图内容 SHA-256 的前 12 位十六进制：同一张图传多次只存一份、迁移重跑不重复、地址永不变化。GIF、SVG 原样保存，扩展名不变；选择“原图”上传时扩展名为原文件的。
- **图片库文件**：`.hexostudio/images.json`，跟博客一起提交。字段覆盖用户手工维护的《Hexo 网站图片核对清单》全部列，并补充应用需要的：

  | 字段 | 含义 | 对应清单列 |
  | --- | --- | --- |
  | `id` | uid（内容哈希） | — |
  | `name` | 图片名称 | 图片名称 |
  | `description` | 图片位置描述（手写） | 图片位置描述 |
  | `ok` | 是否正常（手工标记，可空） | 是否正常 |
  | `key` / `url` | OSS 对象名与公开地址 | 阿里云 OSS 图床 |
  | `uploadedAt` | 上传日期 `YYYY-MM-DD` | 上传日期 |
  | `mirrors` | 备用图床：名称、地址、日期（只记录，不自动上传） | 聚合图床 / Hello Image 及其日期 |
  | `format`、`bytes`、`width`、`height` | 存储上的格式与体积、尺寸 | — |
  | `original` | 原文件名、体积、本机母图相对路径 | — |
  | `legacyUrls` | 接管前的旧地址（迁移可追溯） | — |

- **使用情况**（哪些页面用了这张图）不存文件，每次扫描文章、草稿、`source/` 下其他页面与数据文件、`_config*.yml` 得出；所以在文章里传入的图自动归入该文章，A 页引用 B 页的图也自然成立。
- **是否正常**：手工标记（导入清单时沿用原来的 TRUE / FALSE）+ 自动检查（存储里对象存在、公开地址用 1 字节的 `GET`（`Range: bytes=0-0`）能取到——像浏览器一样取图；实测有的服务对 `HEAD` 与 `GET` 的权限判断不同）；自动检查结果是本机状态，存 `.hexostudio/local/image-checks.json`。另单独标出“未被任何页面引用”。
- **母图**：每次入库先把原文件原样存到 `<母图目录>/<项目名>/<uid>-<原文件名>`（默认 `~/Pictures/Hexo-Studio`），写成功才上传。
- **转换**：默认转 WebP（有损，质量 82，最长边超过 2560px 等比缩小，可改）；“原图”可选；GIF、SVG 总是原样。
- **并发**：多张图同时上传时，对 `images.json` 的读改写串行进行；同一张图同时传两次，对象写同一个 key，图片库只记一条。

### 6.3 图片页（全局维护）

侧边栏“图片”页：
1. 浏览：缩略图网格（阿里云用 `?x-oss-process=image/resize,w_240` 省流量）、搜索名称 / 描述、筛选“全部 / 未使用 / 有问题 / 未入库”。
2. 详情：大图、可编辑名称 / 位置描述 / 是否正常 / 备用图床；只读的 uid、对象名、地址（复制）、格式与体积、原图与母图位置（在 Finder 中显示）；“被这些页面使用”列表，点一下打开对应文章。
3. 上传：不属于任何文章的图（网站头图、头像等）也可在这里直接入库。
4. 检查：逐张自动检查，结果显示在卡片上。
5. 删除：只允许删除没被引用的图（删存储对象与图片库记录，母图保留），二次确认。
6. **接管旧图**（取代原 6.3 的“迁移”）：博客里指向该存储、但不在图片库里的图（现在平铺在桶根目录的 106 张），以及清单 CSV 里列出的图 → 读出 → 存母图 → 转 WebP → 上传到 `<项目名>/<uid>.webp` → 入库（选了清单 CSV 时名称、位置描述、是否正常、日期、备用图床都从清单带过来）→ 改写博客里的地址（只替换地址本身，保留 `?x-oss-process=…` 参数）。先列计划确认再执行；失败的保留旧地址；旧对象不删。
7. 导入清单：把清单 CSV 的字段合并到已入库的图（按 OSS 地址或旧地址匹配）；导出 CSV：同样的列加上 uid、格式、体积、被哪些页面使用（UTF-8 带 BOM，Numbers / Excel 直接打开）。
- 实测（接管规划，不连网）：博客副本 + 用户的清单，共 **110** 张待接管——博客引用 106 张（文章、`_data`、主题配置都有，不止文章里的 44 处）、只在清单里的 4 张；清单 109 行全部对上。博客里引用但清单没有的 1 张（`allanbrok.png`）按文件名命名。
- 同一内容的两个旧对象接管后合成一条记录，两个旧地址都记在 `legacyUrls`，博客里两处都改成同一个新地址。
- 识别与改写规则在 `domain/image_refs.rs`，图片库与清单在 `domain/catalog.rs`，执行在 `service/images.rs`（入库、检查、删除）与 `service/adopt.rs`（接管）。

### 6.4 文章里取用图片

- 粘贴、拖入、点“图片”选择文件：入库（位置描述默认“<文章标题> 内图”）后在光标处插入 `![](地址)`；同一张图已在库里就直接用。
- “图库”：从图片库选图插入，分“本文”“全部”两栏，可搜索；也可以“设为封面”（写入 front-matter 的 `cover`，同样只改这一个键）。

## 7. 界面

沿用 Mihomo-Monitor 的界面风格（自绘标题栏、Tailwind、lucide 图标、浅 / 深色跟随系统）。页面：

| 页面 | 内容 |
| --- | --- |
| 文章 | 文章 / 草稿两个分组，按日期排序，搜索标题与标签，新建 |
| 编辑器 | 格式工具栏、可收起的文章信息、Markdown 编辑器、状态栏（行列、字数）、预览、保存状态、在 Finder / 默认编辑器中打开 |
| 图片 | 图片库：浏览、搜索、筛选、详情编辑、上传、检查、删除、接管旧图、导入 / 导出清单 |
| 部署 | 清理 / 生成 / 部署、实时日志、历史运行 |
| 欢迎页 | 最近项目、打开文件夹、版本与更新 |
| 设置 | 当前项目信息与关闭项目、Node 路径、OSS（桶、地域、AccessKey ID、Secret）、压缩参数 |

CSP 需放行：`frame-src http://localhost:*`（预览）、`img-src` 加上 OSS 桶域名（缩略图）。

## 8. 代码结构

```text
app/
  src/                      React：pages/（Welcome、Posts、Editor、Deploy、Settings）、components/、
                            lib/api.ts（invoke 与事件封装）、lib/frontmatter.ts（yaml Document 区间替换）、lib/date.ts、
                            lib/markdownCommands.ts（工具栏格式命令）
  src-tauri/src/
    domain/                 纯逻辑：config（_config.yml 字段）、post（front-matter 切分、列表字段、slug）、
                            permalink（按 permalink 模式 + 时区算路径）、task（Hexo 命令与互斥要求）、
                            deploy_log（行级别与错误识别）、storage（存储提供方与公开地址）、
                            image_key（uid、对象路径、输出格式）、catalog（图片库与清单 CSV）、
                            image_refs（找出与改写图片地址、使用情况、接管规划）
    infra/                  对外适配：blog（校验、文章读写与冲突检测）、project（.hexostudio/）、node_env（PATH 与 Node 发现）、
                            hexo（子进程、进程组、逐行输出、残留清理）、git（未提交改动、origin）、settings、paths、
                            store（OpenDAL）、keychain、image_encode（解码、缩放、WebP）
    service/                用例：preview（预览服务器生命周期与刷新判定）、runner（命令互斥、预览停启与运行记录）、
                            images（入库：母图、转换、上传；检查；删除）、adopt（接管旧图）
    shell/                  Tauri：命令、事件、窗口（含预览 frame 注入脚本）、单实例、updater
  src-tauri/tests/real_blog.rs  用真实博客副本跑的集成测试（HEXO_STUDIO_TEST_BLOG 未设置时跳过）
  src-tauri/tests/storage_upload.rs  对 S3 兼容服务（本地 moto）跑的入库、删除、接管测试（HEXO_STUDIO_TEST_S3 未设置时跳过）
.github/workflows/          ci.yml（类型检查、前端与 Rust 测试）、release.yml（标签发布）
```

测试遵循 Arrange-Act-Assert；domain 层全部单测（permalink 的时区与跨日、front-matter 列表解析、URL 提取与差集、日志错误识别）。测试用到博客文件时复制到临时目录，**不直接改动真实博客**。

## 9. 里程碑

每一步都能端到端使用：

1. ✅ **M1 写作与预览**：工程骨架；选择博客目录并校验；Node 发现；文章 / 草稿列表；编辑器（front-matter 表单 + Markdown，格式保留）；保存；预览服务器 + 自动刷新的主题真实预览。
2. ✅ **M2 部署**：部署页；clean / generate / deploy 与新建 / 发布草稿；命令互斥与预览自动停启；日志与错误提示。
2+. ✅ **项目与更新**（检查更新的真实下载安装要等第一个 Release 发布后才能验证）：欢迎页与最近项目、`.hexostudio/` 目录、单窗口切换项目（第 1.1 节）；Tauri updater 检查更新，GitHub Release 发布流程（第 13 节）。
3. ✅ **M3 图片上传**（阿里云 OSS 还没用真实 AccessKey 实测，见第 11 节）：存储提供方（阿里云 OSS、S3 兼容）的项目设置与钥匙串；拖拽 / 粘贴 / 选择文件上传并插入；默认转 WebP、可选原图；母图备份（第 6.1 节）。
3+. ✅ **图片库**（阿里云 OSS 同样待真实 AccessKey 实测）：按项目统一管理、uid 对象名、`images.json`、图片页、文章里从图库取用、接管旧图、清单导入导出（第 6.2–6.4 节；取代 M3 时按页面分目录的路径与“旧图迁移”）。
4. **M4 图片库与完善**：图片库浏览 / 搜索 / 删除 / 插入；未引用检测；封面从图片库选择；外部改动检测；（可选）即时 Markdown 预览、源码仓库 git 状态与提交。

## 10. 已确认的决定

- 位置：`Workspace Of Claude/Hexo-Studio`，与 Claude-Hydra、Mihomo-Monitor 同级，独立 git 仓库。
- 纯本地方案，不改动任何云端配置；与博客现有的 `hexo d` 发布流程完全兼容。
- 平台：仅 macOS。
- 博客路径可配置，约定按 EverettBlog（anzhiyu）实现，不做多主题抽象。
- 预览以 `hexo server` 的主题真实渲染为准。
- 不内置 Node / Hexo。
- （M1）Hexo 子进程一律设 `TZ=<博客 timezone>`，让预览、生成、部署的文章地址与应用的计算一致，不随 Mac 所在时区变化（2.1 节）。
- （M1）front-matter 只替换改动键在源文本里的区间，不用 `Document.toString()` 整体输出（3.2 节）；文章原地覆写以保留文件创建时间。
- （M1）保存带内容指纹，磁盘内容被外部改过时不覆盖、由用户选择（3.2 节）。
- （M1）预览服务器只监听 `127.0.0.1`，端口自动取空闲端口；`preview.pid` 用于下次启动时清理残留的 `hexo server`（第 4 节）。
- （M1）登录 shell 的 `PATH` 自己读取，不引入 `fix-path-env-rs`（2.1 节）。
- （M1）没有 `date` 的文章按文件创建时间算地址（Hexo 的实际行为），不是当前时间（第 4 节）。
- （M2）部署前确认；新建 / 发布草稿走与命令行相同的 `hexo new` / `hexo publish`，总是写明 layout 并用 `--` 隔开标题（第 5 节）。
- （M2）运行记录只在内存，切换项目时清空。
- （2026-11-17，用户）像 IDE 一样先选项目：欢迎页 + 单窗口切换项目；项目数据放博客内 `.hexostudio/`（`local/` 不进 git）；只打开本地文件夹，不做克隆（第 1.1 节）。
- （2026-11-17，用户）现在接 Tauri updater + 公开 GitHub Release；签名私钥只在本机 `signing/` 和 Actions Secret（第 13 节）。
- （2+）发布说明手写在 `docs/releases/<tag>.md`，Release 与应用内更新提示都用它。
- （2026-11-17，用户）默认 WebP、原图可选；原尺寸母图存本机；做旧图迁移；参照 PicGo 支持多家存储，阿里云 OSS 优先；RAM 子账号暂不处理（第 6 节）。
- （2026-11-17，用户，取代上一版的按页面分目录）图片按项目统一管理：对象名 `<项目名>/<内容哈希>.webp`，页面归属记在图片库、由扫描得出；独立的图片页；文章里可从图库取图；备用图床只记录地址和日期；“是否正常”= 自动检查 + 手工标记（第 6.2–6.4 节）。
- （M3）对象存储统一用 OpenDAL；凭据（含 AccessKey ID）只放钥匙串（6.1 节）。
- （M3）先做阿里云 OSS 与 S3 兼容两种；S3 兼容同时用于本地端到端测试（moto 模拟 S3）。
- （3+）图片库的“使用情况”每次扫描得出，不存文件；自动检查结果是本机状态，存 `.hexostudio/local/`。
- （3+）只允许删除没被引用的图；删除不动本机母图。
- （3+）编辑器里入库的图，位置描述默认“<文章标题> 内图”；接管的图默认取第一个引用它的页面标题，清单有值时以清单为准。
- （编辑器）工具栏的格式命令是纯函数（`lib/markdownCommands.ts`：输入编辑器状态、返回改动），按钮与快捷键共用，单测覆盖；文章信息平时只占一行，编辑时弹出浮动面板；标签插件只放本博客在用的写法（第 4 节）。
- （M3）WebP 用 `webp` crate（libwebp，有损）；`image` crate 只负责解码和缩放（它只能写无损 WebP）。

## 11. 开工前要实测的事项

1. 从 Finder 启动的 `.app` 能否通过第 2.1 节的方式找到用户的 node（用户机器的 Node 安装方式未知）。
   - **M1 结果（Linux）**：查找逻辑已实现并有单测（标记提取、nvm 取最高版本、手动路径优先）；开发环境里自动找到 `/usr/local/bin/node`（v22）。**未在 Mac 上用 Finder 启动的 `.app` 实测**；找不到时设置页可手动指定。
2. GUI 应用里执行 `hexo deploy` 时 git 能否用上 SSH 密钥（`SSH_AUTH_SOCK` 是否继承、钥匙串里的口令）。
   - **M2 结果（Linux）**：部署流程用本地 bare 仓库作为 `deploy.repo` 端到端跑通（推送成功、预览自动停启、GH013 回放被识别）。子进程继承应用的全部环境变量（含 `SSH_AUTH_SOCK`），只覆盖 `PATH`、`TZ`、`NO_COLOR`。**SSH 推送到 GitHub 未实测**（规定不在副本上执行真实部署）；macOS 上由 launchd 给 GUI 应用设置 `SSH_AUTH_SOCK`，预计可用，失败时界面会给出 SSH 提示。需要在 Mac 上用真实博客部署一次确认。
3. `hexo server --draft` 在文件保存后的重新渲染耗时，以及第 4 节“内容变化”判定是否可靠（anzhiyu 页面里有没有每次请求都变化的内容，若有需排除）。
   - **M1 结果（Linux，博客副本，`app/src-tauri/tests/real_blog.rs`）**：服务器约 3.2 秒就绪；保存后约 0.4 秒页面内容变化；同一页面间隔 1.5 秒两次请求响应体完全相同，anzhiyu 页面没有每次请求都变的内容，不需要排除。应用算出的 29 个文章 / 草稿地址（含中文文件名、0–8 点发布的文章）在 `hexo server --draft` 上全部返回 200。改日期后新地址起初返回 404，等待条件因此加上“不是 404”。
4. OSS 的 S3 兼容接口：上传、列举、删除、签名在所选 Rust 客户端下是否正常。
   - **方案已改**（M3）：阿里云改走 OpenDAL 的 OSS 原生服务，不再依赖 S3 兼容层。
   - **M3 / 3+ 结果**：S3 兼容路径用 moto 端到端验证——入库（WebP / 原图 / 截图命名 / 按内容去重）、读回、删除、“测试连接”区分桶不存在、接管旧图（带清单字段、同内容合并、改写文件、母图、旧对象保留）都通过；界面里设置、编辑器插入图片、图片页（接管、检查、详情、使用情况）、编辑器“图库”插入与设为封面也实际走了一遍。**阿里云 OSS 未实测**（用户暂未提供 AccessKey）：OSS 的签名与请求由 OpenDAL / reqsign 负责，代码路径与 S3 相同，拿到 AccessKey 后需实测上传、读取、测试连接与迁移。
5. WKWebView 内嵌 `http://localhost` 页面（预览）的 CSP / ATS 限制。
   - **M1 结果（Linux WebKitGTK）**：CSP `frame-src http://127.0.0.1:*` 下预览正常显示，注入 frame 的滚动脚本生效。**WKWebView 未实测**；按 Apple 文档 ATS 不限制 IP 地址与 loopback，预计无需额外配置，到 Mac 上确认。
6. 编辑器工具栏的格式命令在真实文章上是否可靠（Markdown 有不少边界写法）。
   - **编辑器工具栏结果（Linux WebKitGTK，博客副本）**：在真实文章上实际点过——选中文字加粗（选区首尾的空格留在标记外，否则 `**文字 **` 不算加粗）、光标在加粗里按钮高亮、再点去掉、撤销；段落样式菜单显示并切换当前标题级别；插入菜单插入 `tabs` / `note`（有选区时包住选区）；文章信息面板打开、修改（即时保存）、Esc 关闭，浅色 / 深色都看过；改动都按原有方式自动保存并刷新预览。默认 50/50 分栏时工具栏一行放得下，更窄时换行。⌘ 显示与 macOS 键位要在 Mac 上确认。

## 12. 待用户确认（对应里程碑开工前提问）

| 编号 | 问题 | 建议默认 | 何时需要 |
| --- | --- | --- | --- |
| Q1 | 新上传图片放在哪里 | **已定（2026-11-17）**：`<项目名>/<页面名>/<图片名>`；另做旧图“读取 → 转 WebP → 迁移”功能（6.2、6.3 节） | — |
| Q2 | 上传时是否自动压缩 / 转格式 | **已定（2026-11-17）**：默认 WebP，原图可选；原尺寸母图存本机用户目录（6.2 节） | — |
| Q3 | 是否需要自动更新与 GitHub Release 发布流程 | **已定（2026-11-17）**：要，欢迎页检查更新，Tauri updater + GitHub Release，见第 13 节 | — |
| Q4 | 是否把应用代码推到 GitHub（私有仓库） | **部分已定**：更新要求 Release 可匿名下载，所以仓库须公开；建仓、首次推送、配置 Secrets 仍由用户确认后再做 | 发布第一个版本前 |

## 13. 更新与发布

- 照 Mihomo-Monitor：`tauri-plugin-updater`，更新地址 `https://github.com/EverettRain/Hexo-Studio/releases/latest/download/latest.json`（仓库名待建仓时确认），更新包用 Tauri 的 minisign 密钥签名。公钥写在 `tauri.conf.json`；私钥只放本机 `signing/`（不进 git）和 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`。
- 私有仓库的 Release 不能匿名下载，应用拿不到 `latest.json`，所以仓库须公开（Q4）。
- 发布：推送 `v*` 标签触发 GitHub Actions，在 macOS（Apple Silicon）上 `tauri build`，产出 `.dmg`、`.app.tar.gz` 与签名、`latest.json`，上传到 Release。不做 Apple 公证（个人自用；首次打开需右键“打开”），更新包由应用自己下载，不带隔离属性，不受影响。
- 欢迎页启动时检查一次；有新版本显示版本号与“安装并重启”。
