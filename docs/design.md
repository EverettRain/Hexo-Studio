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
- **项目 = 一个本地 Hexo 博客目录**（通常是 GitHub 上博客源码仓库的本地克隆）。只打开本地文件夹，不做克隆；打开时按 3.1 节校验。也可以在欢迎页从模板新建一个博客（第 15 节）。
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
| 预览服务器 `hexo server --draft -p <空闲端口>` | 打开编辑器或在预览页点“启动”时启动，预览页点“停止”、退出应用或执行部署前停止 | 长驻，日志流到前端“预览日志” |
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
- **文章信息**（front-matter）：直接写在文章开头，和正文在同一个滚动里，往下写就滚出视线，不占额外区域：大号标题（回车进入正文），下面每个属性一行（日期、分类、标签、描述、封面），“更多属性”展开主题选项（顶部图、过期提醒、版权），“源码”直接改 YAML（保存时原样保留没有控件的字段）。控件全部自绘，不用系统控件：日期是自带日历和时分秒的弹出框（“今天”“现在”按博客时区）；标签和分类是标签块输入，自带候选列表，回车、Tab、逗号或离开输入框都会生成标签块，输入法组字时的回车只确认文字（WebKit 里这个回车带 keyCode 229，Safari 还会在 compositionend 之后才发，所以同时看组字状态和 229）；分类按 Hexo 的规则显示成层级（A › B）；封面、顶部图显示缩略图和图片名，不显示地址。
- **正文**：CodeMirror 6（GFM：表格、删除线、任务列表）；底部状态栏显示行列号和字数（中日韩文字按字、其他按词，不含代码块、图片、链接地址和标签插件）。
- **图片按名称显示**：正文里的图片不显示地址，而是一张卡片：缩略图、图片库里的名称、写法（图片标签 / Markdown / 行内）、宽高和说明；独占一行的图是大卡片，句子里的是小标签。光标把整张图当一个字符跳过，退格整张删除。点卡片弹出样式框：在主题的 `{% image %}`（宽、高、图片说明、占位底色）、Markdown（markdown-it-imsize 的 `=宽x高`、替代文字）和行内（`{% inlineimage %}`，高度）之间切换，宽度有本博客常用的 400 / 500 / 700 / 100% 快捷值；还可以“换一张”（从图库选）或移除。每次改动直接改写这张图的源码，文件里仍是标准写法，Hexo 和其他编辑器照常可用。不在图片库的图（还没接管的旧图、外部图片）按文件名显示并标明。顶栏的 `</>` 按钮切回显示源码，供手工改写。识别和写回规则在 `lib/imageMarkup.ts`，照博客实际用的渲染器和主题脚本实现：`image` / `inlineimage` 的参数按“逗号 + 空格”切分（值里的“, ”写成全角逗号，否则会被拆开），`inlineImg` 按空格切分，imsize 只认数字和 `%`（`2em` 这类宽度写不进 Markdown 写法，切换时去掉）；围栏代码块里的图片语法只是示例，不识别。

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

- 像 PicGo 一样把“图床”做成可选的提供方。字段沿用 PicGo 的叫法，方便从 PicGo 搬配置：桶（bucket）、地域（area / region）、路径前缀（path）、自定义域名（customUrl）。
- **存储配置（2026-11-18 用户确定）**：一个博客可以有多套配置，每套是一个完整的组合——名称、存储（提供方、桶、地域 / API 地址、路径前缀、域名）、密钥、上传方式（WebP / 原图、WebP 质量、最长边、插入写法）。配置在**图片页**里新建、编辑、删除和切换（顶部的配置条和下拉菜单），不在设置页；“当前配置”决定新图片传到哪里、怎么传，编辑器也读它。所有配置共用的只有“图库设置”：项目名（图片路径用）和本机母图位置。
  - 存在 `.hexostudio/settings.json`：`profiles`（每套的 `id`、`name`、`storage`、`upload`）和 `active`。旧版本的单个 `storage` + `upload` 读入时变成一套 id 为 `default`、名称如“阿里云 OSS · 桶名”的配置并设为当前，下次保存即写成新格式。
  - **每张图属于哪套配置按地址判断**（地址在哪套配置的公开地址下），不另存：切换配置后，旧图的检查、删除仍用它所在的那套存储；同一个桶建了几套配置时任取其一（当前那套优先），存储相同所以结果一样。没有哪套配置包含的图（配置被删除或改了地址）照常显示和引用，只是不能在这里检查和删除，详情里会标明。
  - 缩略图按图所在的配置决定：阿里云的图用图片处理参数取小图，其他存储取原图。
  - 删除配置不动桶里的图；密钥在没有别的配置用同一个桶时才从钥匙串删除。“测试连接”用表单里尚未保存的值（Secret 留空则用已保存的）。
  - “接管旧图”针对当前配置：从它的桶里读旧图，一律转成 WebP（用这套配置的 WebP 质量和最长边，不看它的“原图”选项：接管本来就是为了把旧图换成 WebP），放回它的桶。
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

- 粘贴、拖入、点“导入图片”选择文件：都打开导入面板（6.5 节），面板标题为“导入图片并插入文章”，上传后在光标处插入，写法按存储配置的插入写法；位置描述默认“<文章标题> 内图”。
- “图库”：从图片库选图插入，分“本文”“全部”两栏，可搜索；也可以“设为封面”（写入 front-matter 的 `cover`，同样只改这一个键）。同一个选图框也用于样式框里的“换一张”和文章开头的封面 / 顶部图。
- “插入”菜单里的“相册”：把选中的几行包进 anzhiyu 的 `{% gallery %}`。主题的相册只读 Markdown 图片，且它的匹配规则遇到 imsize 的 `=宽x高` 会失败（相册自己排版行高），所以里面的图片标签会改写成不带尺寸的 Markdown，图片说明保留为替代文字。

### 6.5 导入面板（2026-11-21 用户确定）

- 入口：图片页“添加图片”（选择文件）、把图片拖进项目窗口的任何页面、不在输入框里时按 ⌘V 且剪贴板里是图片（编辑器正文里粘贴也一样）。只在按下 ⌘V 时读剪贴板，不在后台监视。标题、摘要等输入框里粘贴图片不打开面板。
- 每张图上传前先在本机转换一遍，不上传、不留文件（`prepare_image`）：显示原图和转换后的尺寸、体积与变化（变大时用警示色并提示），图库已有同一张时标出、不会重复上传；点缩略图看大图，可在“压缩后”和“原图”之间切换。
- 统一设置格式（WebP / 原图）、质量、最长边（原尺寸 / 1280 / 1920 / 2560 / 3840），初始值取当前存储配置；单张可展开“单独设置”。改了质量或最长边可以“设为默认”写回当前存储配置（`set_upload_encoding`，只改这两项，不碰 AccessKey）。
- 名称默认取文件名（截图按时间，与 `image_key::screenshot_stem` 相同），可直接改；位置描述可填。
- 回车即上传。编辑器里上传后插入光标处并关闭面板；其他地方上传后把地址按插入写法复制到剪贴板（Tauri 剪贴板插件，只开放写文本；网页剪贴板接口在上传结束后已没有用户点击，会被拒绝），结果页可改复制 `{% image %}` / Markdown / 链接。
- 所有入口都以字节上传（`read_image_file` 读文件，`upload_image_bytes` 带名称、描述、格式、质量、最长边），按路径上传的旧命令和编辑器自己的拖拽、占位上传逻辑已删除；编辑器工具栏的 WebP / 原图切换也移到面板里。

## 7. 界面

沿用 Mihomo-Monitor 的界面风格（自绘标题栏、Tailwind、lucide 图标、浅 / 深色跟随系统）。页面：

| 页面 | 内容 |
| --- | --- |
| 文章 | 文章 / 草稿两个分组，按日期排序，搜索标题与标签，新建 |
| 编辑器 | 格式工具栏、可收起的文章信息、Markdown 编辑器、状态栏（行列、字数）、预览、保存状态、在 Finder / 默认编辑器中打开 |
| 图片 | 存储配置（新建、编辑、切换、删除）与图库设置；图片库：浏览、搜索、筛选、详情编辑、上传、检查、删除、接管旧图、导入 / 导出清单 |
| 预览 | 启动 / 停止 `hexo server --draft`、地址与在浏览器中打开、服务器日志（编辑器里的预览窗格与它是同一个服务器） |
| 源码 | 博客源码仓库（不是部署仓库）：分支与远程的差距、未提交的改动、提交（标题与说明分开，提交全部改动）、推送、拉取（只接受快进）、最近提交（每次 30 条，可加载更多）。左边的框在“改动”和选中的那条提交之间切换：点历史里的提交，框里就显示它的完整说明和改动的文件与行数（不弹窗）；再点一次或点“改动”回到未提交的改动，切换时提交标题与说明保留 |
| 部署 | 清理 / 生成 / 部署、实时日志、历史运行 |
| 欢迎页 | 最近项目、打开文件夹、版本与更新 |
| 配置 | 站点 / 插件 / 主题 / 页面数据四栏；左侧按主题文件自己的段落分组并可搜索，右侧逐项编辑；标出与主题默认不同的值；保存后提示重启预览（第 14 节） |
| 设置 | 当前项目信息与关闭项目、Node 路径、外观、更新（图片存储改在图片页的存储配置里） |

CSP 需放行：`frame-src http://localhost:*`（预览）、`img-src` 加上 OSS 桶域名（缩略图）。

## 8. 代码结构

```text
app/
  src/                      React：pages/（Welcome、Posts、Editor、Preview、Source、Deploy、Settings）、components/、
                            lib/api.ts（invoke 与事件封装）、lib/frontmatter.ts（yaml Document 区间替换）、lib/date.ts、
                            lib/markdownCommands.ts（工具栏格式命令）
  src-tauri/src/
    domain/                 纯逻辑：config（_config.yml 字段）、post（front-matter 切分、列表字段、slug）、
                            permalink（按 permalink 模式 + 时区算路径）、task（Hexo 命令与互斥要求）、
                            deploy_log（行级别与错误识别）、source（git status / log 的读取、git 失败的说明）、storage（存储提供方与公开地址）、
                            image_key（uid、对象路径、输出格式）、catalog（图片库与清单 CSV）、
                            image_refs（找出与改写图片地址、使用情况、接管规划）
    infra/                  对外适配：blog（校验、文章读写与冲突检测）、project（.hexostudio/）、node_env（PATH 与 Node 发现）、
                            hexo（子进程、进程组、逐行输出、残留清理）、git（状态、日志、提交、推送、拉取，未提交改动数、origin）、settings、paths、
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
4. **M4 图片库与完善**：图片库浏览 / 搜索 / 删除 / 插入；未引用检测；封面从图片库选择；外部改动检测；（可选）即时 Markdown 预览。
   - ✅ 已做：预览页（独立启停 `hexo server`）与源码页（git 状态、提交、推送、拉取）；见第 10 节“源码仓库”各条。
5. **M5 配置管理**（第 14 节），每一步都能端到端使用：
   1. ✅ 配置页 + 通用 YAML 树编辑器：三处配置文件的全部字段都能看、能改，保留注释与写法，标出与主题默认不同的值，保存后提示重启预览。
   2. ✅ 常用分组的专用控件（导航菜单树、评论 / 搜索“选一个再填”、图片字段接图片库、侧边栏卡片、页脚链接）。
   3. ✅ 插件区：按 `package.json` 里已安装的插件列出各自的配置。
   4. ✅ 页面数据：`source/_data` 里友链、相册、装备等的列表编辑。
6. ✅ **新建博客**（第 15 节）：欢迎页新建纯 Hexo 或从模板新建（目前只有 anzhiyu）。

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
- （编辑器）工具栏的格式命令是纯函数（`lib/markdownCommands.ts`：输入编辑器状态、返回改动），按钮与快捷键共用，单测覆盖；标签插件只放本博客在用的写法（第 4 节）。
- （编辑器）文章信息放在文章开头、随正文滚走（不做浮动面板或下拉）；日期、标签、分类、选项全部自绘控件（第 4 节）。
- （编辑器）文章信息与正文在视觉上分开、风格扁平：标题仍在最上方作为文章标题；属性放在标题下一块白色卡片里（`card`，压在窗口灰色的正文底上，无边框无阴影），卡片顶部一行是“文章属性”与“更多属性 / 源码”，主题属性展开后用一条细线隔开，源码模式也在同一块卡片里。标签与分类是实心小块（`pill-hover`），比输入框悬停色深一档，悬停时也看得出。
- （3+）多套存储配置放在图片页、成套切换；图片按地址归属配置，不在图库里另存配置 id（6.1 节）。
- （编辑器）图片在编辑器里只显示为图片 + 名称，文件里仍写标准的地址（不引入自定义的“按名称引用”语法：那需要往博客里加渲染脚本，其他编辑器和 Hexo 本身也读不懂）；名称来自图片库，按地址（含接管前的旧地址）查找。
- （源码仓库）源码页只管博客自己的仓库：提交一律是 `git add -A` 加 `git commit`（博客历史一直如此，不做逐文件暂存）；推送在确认框之后才执行，分支没有可用的上游时推到 `origin` 并设为上游；拉取固定 `--ff-only`，两边都有新提交时拒绝并提示去终端处理，应用里不做合并、变基、冲突解决。
- （源码仓库）git 子进程不接终端、不弹口令（`GIT_TERMINAL_PROMPT=0`、无 stdin），放进独立进程组；提交类 30 秒、推送 / 拉取 120 秒超时，超时整组终止（ssh 等辅助进程握着输出管道，只杀 git 会一直等下去）。失败信息按常见情形翻成中文说明（没有提交者、被拒绝需先拉取、SSH 登录失败、GH013、仓库不存在），其余原样显示。
- （源码仓库）页面不等 git：状态与历史各自读取、各自显示，重新读取时旧内容保留（只有最新一次读取能更新页面）；提交详情点开时才读；git 都在后台线程里跑，界面线程不会被占住。提交说明分成标题（单行，必填）和说明（可选），对应 `git commit -m 标题 -m 说明`。
- （源码仓库）读取走 `git status --porcelain=v1 -b -z`（路径不转义，中文文件名原样）；`domain/source.rs` 只解析文本。
- （3+）接管与“使用情况”扫描的范围：`source/` 下的文章、草稿、页面和 `.md` / `.yml` / `.json` 数据，博客根目录的 `_config*.yml`，以及每个主题目录下直接放着的 `_config*.yml`（导航菜单图标等写在那里）。主题的模板、脚本和其他文件是代码，不扫描也不改写。真实博客上曾因没扫主题配置，漏掉 `themes/anzhiyu/_config.yml` 里的一张图。
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
   - **编辑器工具栏结果（Linux WebKitGTK，博客副本）**：在真实文章上实际点过——选中文字加粗（选区首尾的空格留在标记外，否则 `**文字 **` 不算加粗）、光标在加粗里按钮高亮、再点去掉、撤销；段落样式菜单显示并切换当前标题级别；插入菜单插入 `tabs` / `note`（有选区时包住选区）；改动都按原有方式自动保存并刷新预览。默认 50/50 分栏时工具栏一行放得下，更窄时换行。⌘ 显示与 macOS 键位要在 Mac 上确认。
   - **图片卡片与文章开头（Linux WebKitGTK，博客副本）**：博客全部文章里的 39 处图片（19 个 `{% image %}`、17 个 Markdown、3 个行内）读出再写回逐字节一致；`MacBookPro.md` 里点图片卡片改宽度 700、切到 Markdown，文件分别写成 `width=700px` 和 `![说明](地址 =700x)`，预览随之刷新；标签用回车和逗号各加一个、候选列表出现；日历选日、方向键调小时，日期按“年-月-日 时:分:秒”写回，Esc 关闭。测试中发现：由 mousedown 打开的弹出框会被同一次按下当成“点了外面”立刻关掉（React 在这次事件冒泡到 window 之前就挂上了监听），已在 `useDismiss` 里忽略弹出前开始的按下。**输入法组字时的回车只能在 Mac 上用中文输入法确认**（Xvfb 里没有输入法）。
   - **多套存储配置（Linux，moto 模拟 S3）**：集成测试里先用一套配置上传，再新建第二套（同一个桶、不同路径和公开地址）并切换，新图传到第二套，删除旧图时按地址找回第一套、在第一套的存储里删除成功。界面里：旧格式的 `settings.json` 打开后显示为一套配置；新建第二套时填完表单直接“测试连接”通过（未保存）；保存后 `settings.json` 只剩 `profiles` 和 `active`；切换后配置条和编辑器都跟着变，旧图详情仍显示属于第一套；图库设置对话框正常。

7. （M5）`hexo server` 运行中改 `_config.yml` / `_config.anzhiyu.yml` 是否生效。
   - **结果（macOS，博客副本）**：不生效。改了站点标题和 `inject.head` 后等 8 秒，页面不变；重启服务器后两处都生效。所以配置保存后显示“重启预览”按钮（`preview_restart`：停止后立即启动）。
8. （M5）Hexo 7 合并 `_config.anzhiyu.yml` 与主题默认时的规则，决定“与默认不同”怎么标、删掉一个键会不会回落到默认值。
   - **结果（读 Hexo 7.3 源码并实际调用 `hexo-util` 的 `deepMerge`）**：对象逐层合并；值写成 `null` 会盖掉默认值；**列表不是整体替换**，而是按位置合并、只增不减——默认 `[1, 2, 3]` 与覆盖 `[7]` 合并成 `[1, 2, 3, 7]`，列表里的对象按位置逐层合并。所以主题默认里已有的列表项，在 `_config.anzhiyu.yml` 里删掉也会被合并回来；删掉一个键则回落到默认值。面板编辑列表时要按合并后的结果显示，删除主题默认里也有的项时明确提示“只改覆盖文件删不掉”（14.4 节）。

## 12. 待用户确认（对应里程碑开工前提问）

| 编号 | 问题 | 建议默认 | 何时需要 |
| --- | --- | --- | --- |
| Q1 | 新上传图片放在哪里 | **已定（2026-11-17）**：`<项目名>/<页面名>/<图片名>`；另做旧图“读取 → 转 WebP → 迁移”功能（6.2、6.3 节） | — |
| Q2 | 上传时是否自动压缩 / 转格式 | **已定（2026-11-17）**：默认 WebP，原图可选；原尺寸母图存本机用户目录（6.2 节） | — |
| Q3 | 是否需要自动更新与 GitHub Release 发布流程 | **已定（2026-11-17）**：要，欢迎页检查更新，Tauri updater + GitHub Release，见第 13 节 | — |
| Q4 | 是否把应用代码推到 GitHub（私有仓库） | **部分已定**：更新要求 Release 可匿名下载，所以仓库须公开；建仓、首次推送、配置 Secrets 仍由用户确认后再做 | 发布第一个版本前 |


M5 开工前确认：

| 编号 | 问题 | 建议默认 | 何时需要 |
| --- | --- | --- | --- |
| Q5 | `_config.anzhiyu.yml` 保持整份复制，还是精简成只写改过的值 | **已定（2026-11-21）**：保持整份复制，只改动到的值；“与默认不同”由界面对比后标出（14.4 节） | — |
| Q6 | 页面数据（友链、相册等）放在配置页里，还是单独一页 | **已定（2026-11-21）**：配置页里单独一组，以后内容多了再拆成独立页 | — |
| Q7 | `_config.yml` 里 hexo-admin 的 `password_hash`、`secret` 已在 git 里 | **已定（2026-11-21）**：面板不显示、不编辑这两项，文件里原样保留（EverettBlog 仓库是私有的） | — |
| Q8 | 不再使用的 `_config.butterfly.yml`、空的 `_admin-config.yml`、依赖里的 hexo-admin 与 hexo-theme-landscape | **已定（2026-11-21）**：面板不展示，博客里暂不清理 | — |

## 13. 更新与发布

- 照 Mihomo-Monitor：`tauri-plugin-updater`，更新地址 `https://github.com/EverettRain/Hexo-Studio/releases/latest/download/latest.json`（仓库名待建仓时确认），更新包用 Tauri 的 minisign 密钥签名。公钥写在 `tauri.conf.json`；私钥只放本机 `signing/`（不进 git）和 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`。
- 私有仓库的 Release 不能匿名下载，应用拿不到 `latest.json`，所以仓库须公开（Q4）。
- 发布：推送 `v*` 标签触发 GitHub Actions，在 macOS（Apple Silicon）上 `tauri build`，产出 `.dmg`、`.app.tar.gz` 与签名、`latest.json`，上传到 Release。不做 Apple 公证（个人自用；首次打开需右键“打开”），更新包由应用自己下载，不带隔离属性，不受影响。
- 欢迎页启动时检查一次；有新版本显示版本号与“安装并重启”。

## 14. 配置管理（M5）

分析时间 2026-11-21，博客为 EverettBlog `0a7a9c1`，主题 anzhiyu 1.6.14。

### 14.1 配置从哪里来

| 文件 | 行数 | 内容 | 面板怎么对待 |
| --- | --- | --- | --- |
| `_config.yml` | 257 | Hexo 核心设置，以及 6 个插件的配置 | 拆成“站点”与“插件”两块 |
| `_config.anzhiyu.yml` | 1412 | 主题配置；Hexo 7 把它合并到主题默认值上，以它为准 | 主要编辑对象，主题配置只写这里 |
| `themes/anzhiyu/_config.yml` | 1340 | 主题默认值（主题随博客一起提交，用户也改过它） | 只读，用作对照与字段说明 |
| `themes/anzhiyu/scripts/events/merge_config.js` | — | 主题在代码里又兜底一层默认值 | 只在缺字段时参考 |
| `source/_data/*` | 7 个文件 | 关于、相册、创造力、装备、友链、打赏、追番 | 页面内容，不是配置，单独一组（14.3 节） |

不展示：`_config.butterfly.yml`（换主题前留下的 1154 行，主题已是 anzhiyu）、空的 `_admin-config.yml`、Hexo 生成且被 git 忽略的 `_multiconfig.yml`。

### 14.2 主题配置的现状

- 132 个顶层分区：有开关且开着的 42 个、关着的 46 个、没有开关（纯设置）的 44 个。
- 与引入时的 anzhiyu 1.6.14 相比，真正改过的只有 37 个分区里的 83 个值；1400 行里大部分是原样复制的默认值。
- 主题代码也被改过：`music_page`（自建音乐页）是新加的配置项，`ptool.share_llm`（分享栏“复制全文给 LLM”）是改出来的。按上游字段表做的控件会漏掉这类自定义字段，所以没有专门控件的字段一律能在通用编辑器里改（14.5 节）。
- 文件里 478 行注释，多是中英双语的字段说明，解析出来作为字段提示。
- 主题自己按注释分了 20 个大段（Code Blocks、Image、Post、Comments、Footer、Beautify/Effect、aside 等），粒度不均，面板按用户要做的事重新分组（14.3 节）。

### 14.3 拆分

**站点**（`_config.yml` 核心部分）：标题、作者、语言、时区、url、permalink、分页、目录、部署。`permalink`、`url`、`timezone` 影响 Studio 自己算出的文章地址和预览，改动时单独提醒。

**主题**（`_config.anzhiyu.yml`），按任务分组：

| 分组 | 包含的分区 | 控件 |
| --- | --- | --- |
| 首页与外观 | home_top、subtitle、index_img、default_top_img、cover、theme_color、font、display_mode、article_double_row | 图片字段接图片库 |
| 导航 | menu、nav、social、rightClickMenu、centerConsole | 树形编辑；菜单项的 `路径 \|\| 图标` 拆成两个输入框 |
| 侧边栏 | aside 的各张卡片、author_status、busuanzi、runtimeshow、newest_comments | 卡片开关（顺序由模板写死，各卡片的 `sort_order` 主题没用到，不做排序） |
| 文章页 | post_meta、toc、post_copyright、related_post、noticeOutdate、wordcount、ptool、reward、代码块相关 | 普通表单 |
| 评论 | comments.use + 选中服务（现为 twikoo）的配置 | 先选服务再只显示它的配置，其余服务折叠 |
| 搜索与公式 | algolia、docsearch、本地搜索（三选一）、mathjax、katex、mermaid | 同上 |
| 页脚 | footer（145 行，最大的一段） | 链接分组用列表编辑 |
| 音乐 | nav_music、music_page、aplayerInject | 歌单列表 |
| 特效 | canvas_*、fireworks、click_heart、preloader、peoplecanvas 等 | 一排开关 |
| 统计、验证、广告 | 5 个统计服务、site_verification、google_adsense | ID 输入框 |
| 高级 | CDN（86 行）、pjax、lazyload、pwa、icons、inject | 通用编辑器；`inject` 用代码编辑框 |

**插件**（`_config.yml` 里各插件的段）：`markdown`（markdown-it 及其插件）、`aplayer`、`bangumi`、`envelope_comment`、`footer_beautify`、`admin`。每段对应 `package.json` 里的一个包，按已安装的插件列出；没装的不显示。
- （M5.3 实现）插件列表照 Hexo 7 自己的加载规则（`hexo/dist/hexo/load_plugins.js`）：博客 `package.json` 的 dependencies 与 devDependencies、主题目录 `package.json` 的 dependencies；名字是 `hexo-…` 或 `@作用域/hexo-…`，排除 `hexo-theme-…` 和 `@types/`。每个插件读出安装的版本、说明和 GitHub 地址（`repository` 的各种写法，没有时取 GitHub 上的 `homepage`），可打开 npm 与 GitHub 页面。`package.json` 里有但没装的标“没有安装”（Hexo 会跳过它）。
- 配置段归属：键名的每个词都出现在包名里就算（`index_generator` → hexo-generator-index、`markdown` → hexo-renderer-markdown-it），对不上的写在 `lib/plugins.ts` 的小表里（`envelope_comment` → hexo-butterfly-envelope；Hexo 自身的 `server`、`deploy` 归到 hexo-server、hexo-deployer-git，站点栏里也照样有）。没有插件认领的非 Hexo 键单列为“没有对应插件的设置”。EverettBlog 的 17 个插件、7 段插件设置全部对上。
- 本地脚本（博客 `scripts/` 目录）不是 npm 包，不在插件栏里。

**页面数据**（`source/_data`）：友链、相册、装备等是一条条记录，用列表 / 卡片编辑，不放进配置表单（Q6）。
- （M5.4 实现）配置页第四栏“页面数据”，列出 `source/_data` 里的 `.yml` / `.yaml` / `.json`（Rust 只接受该目录下的这几种文件名，带内容指纹）。最外层是列表的文件（anzhiyu 的页面数据都是“分组列表”）按分组卡片显示，标题取 `class_name`，可增删分组（新分组照最后一组的字段格式）；列表里的每一项显示名称（`name` / `title` / `date` 等）而不只是序号；图片字段照常显示缩略图、可从图库换。
- JSON 文件改完整体按原缩进重新输出（原来写在一行的仍写一行）：JSON 没有注释和引号风格要保留，用 YAML 的原地改写反而可能写出不是 JSON 的内容。
- hexo-bilibili-bangumi 抓取生成的 `bangumis.json` / `cinemas.json` / `games.json` 只显示各列表的条数，不编辑（下次 `hexo bangumi -u` 会覆盖），提示手工补充请改对应的 `extra_….json`。
- 实测（macOS，博客副本）：运行中的 `hexo server` 改 `source/_data` 后几秒内页面就更新，不用重启，所以页面数据保存后不提示重启预览。
- 在 EverettBlog 的 6 个 YAML 页面数据文件上：322 个值原值写回逐字节不变、改值全部成功；29 个列表“加一项再删掉”全部恢复原样。删除条目时，隔开它的空行一起去掉；删的是文件最后一项且原文件末尾没有换行时，结尾保持原样。

### 14.4 写入规则

- 主题配置只写 `_config.anzhiyu.yml`，不碰主题目录。
- 与文章 front-matter 相同：用 `yaml` 的 Document API 只替换改动键在源文本里的区间，注释、键的顺序、引号与日期写法都保留；带内容指纹，磁盘上被外部改过时不覆盖。
- 默认保持整份复制的写法，不自动精简成“只写改过的值”（那会改写整个文件，diff 无法审）；“与主题默认不同”由界面对比 `themes/anzhiyu/_config.yml` 后标出（Q5）。
- 字段值里的 HTML（`inject.head` / `bottom`、`_config.yml` 的 `description`）按原文编辑，不转义、不格式化。
- Hexo 合并列表时只增不减（第 11 节第 8 项）：列表按合并后的实际结果显示；要删除的项若在主题默认里也有，提示这样删不掉，不悄悄去改主题目录。

### 14.5 控件从哪来

两层，与“按 EverettBlog 实现、不做多主题抽象”的决定一致：

1. **通用 YAML 树编辑器**：按值的类型给控件（布尔 → 开关，数字、字符串、列表、对象逐层展开），保证所有字段都能改，自定义字段也不例外；字段提示取自上方的注释。
2. **常用分组的专用控件**：只为 14.3 节表里列出的分组手写，字段表写死在代码里，对应 anzhiyu 1.6.14；表里没有的字段落回第 1 层。
   - （M5.2 实现）主题目录默认“按用途”分组（`lib/themeGroups.ts`，在 14.3 节的表上补了“在线聊天”“友链与页面”两组，没列到的进“其他”），也可切回“按文件”（主题文件自己的段落）。
   - 不按分区写死、按值的形状识别的通用增强：`链接 || 图标` 拆成两个输入框；值全是链接的表（`social`、菜单的每组）可以增删、改名；表里套链接表的（`menu`）可以增删、改名分组；图片地址（值是图片文件或在图片库里，或键名像 `img` / `avatar` / `cover` / `background`）显示缩略图与图片库名称，可从图库选图。改名只替换键名本身，位置、值和注释不动。
   - 专用面板：评论（默认显示与第二个服务两个选择，按文件原来的形式写 `comments.use`，再只显示选中服务的设置）、搜索（Algolia / 本地 / DocSearch 三选一，选一个时关掉其他的；主题按这个顺序取第一个开着的）、侧栏（卡片开关一览，下面是其余设置）。
   - 页脚链接没有单独做：它是“对象列表”，通用的列表编辑（增删、按已有项的形状新增）已经够用。

### 14.6 生效与安全

- 配置改动要重启预览服务器才生效（待实测，第 11 节第 7 项）；保存后提示“重启预览”，部署前不需要额外处理（部署本来就重新生成）。
- `admin.password_hash`、`admin.secret` 不显示、不编辑，文件里原样保留（Q7）。
- （M5.1 实现）读写在 Rust（`ConfigFile`：`site` / `theme` / `themeDefaults`，主题名不能跳出 `themes/`；`themeDefaults` 只读；不存在的覆盖文件读作空，第一次保存时创建；带内容指纹）。按路径改值在前端 `lib/configYaml.ts`：只替换那个值的文本，改完再解析一遍核对结果，不符就拒绝写入；值没变时文件原样不动（避免把折成多行的长值改写成一行）。在真实的三份配置上对全部 1337 个值各做一次“原值写回”和“改值”，以及 160 次列表增删：原值写回全部逐字节一致，改值只动一行（折成多行的长值除外），没有失败。
- 现有的图片接管与“使用情况”已经扫描 `_config*.yml` 与主题目录下的 `_config*.yml`，配置里的图片字段换图后，图片库的使用情况保持准确。

## 15. 新建博客（2026-11-21）

欢迎页“新建博客…”：选纯 Hexo 或一个模板、填标题与作者、选放在哪个文件夹，创建完直接打开。

- **界面**照 Visual Studio / JetBrains 的新建项目窗口左右分栏：左栏最上面是“纯 Hexo”，分隔线下是“模板”列表；右栏是选中项的说明和表单（标题、作者、位置、文件夹名），创建后右栏换成步骤进度与 npm 日志，左栏锁定。
- **纯 Hexo** 不算模板：结果与官方 `hexo init` 相同，即基础骨架加 hexo-starter 自带的 landscape 主题（`hexo-theme-landscape`、`hexo-renderer-ejs`、`hexo-renderer-stylus`），没有“下载主题”这一步。完全不带主题的博客 Hexo 生成不出页面，所以不做。
- **模板** = Hexo 基础骨架 + 一个主题。目前只有 anzhiyu（`domain/template.rs` 的列表，加模板只加一项）。
- **基础骨架**照 `hexo init`：`_config.yml`、`scaffolds/`、`source/_posts/hello-world.md` 取自 hexo-cli 4.3.2 自带的 `assets/`（`hexo init` 克隆失败时用的就是它，MIT），`.gitignore` 取自 hexo-starter。它们随应用打包，不在创建时联网拉 hexo-starter。
- **依赖版本不写死**：`package.json` 只写骨架（含 `"hexo": {"version": ""}`，hexo-cli 靠这个键认出博客目录，Hexo 第一次运行时填上版本），再用 `npm install --save <包名>` 装 hexo-starter 的那组包（去掉 landscape 主题和 ejs 渲染器）加模板要的渲染器，版本取当时最新。2026-11 实测装上的是 Hexo 8.1.2，需要 Node 20.19 以上，创建前检查 Node 版本，不够就直接说明。
- **主题从 npm 取**：`npm pack hexo-theme-anzhiyu` 再解压到 `themes/anzhiyu/`，与 EverettBlog 一样作为博客仓库里的普通文件（不是子模块、不在 `node_modules`）。走 npm 而不是 `git clone` GitHub，是因为会沿用用户 `~/.npmrc` 里的镜像（国内网络下 GitHub 常常很慢）；代价是 npm 上的版本可能比 GitHub 晚一点（实测 npm 1.7.0、GitHub 1.7.1）。
- 主题默认配置整份复制成 `_config.anzhiyu.yml`（anzhiyu 文档的做法，也与第 14.4 节“保持整份复制”一致）。`_config.yml` 只改 `title`、`author`、`language: zh-CN`、`timezone`（本机时区）、`theme` 这几行，其余保持官方原样。
- 最后 `git init`（遵循用户的 `init.defaultBranch`），不做首次提交，留给源码页。
- **原子性**：先在同一父目录下的隐藏临时文件夹里搭好，全部成功才改名成目标文件夹；失败或取消就删掉这个临时文件夹（它只含本次创建写入的东西）。目标文件夹已存在时不创建。
- 进度按步骤显示（写入骨架 → 下载主题 → 安装依赖 → 初始化 git），npm 的输出逐行进日志；可以取消（结束整个进程组）。
- 实测（2026-11-21，npmmirror）：取主题不到 1 秒，安装依赖约 7 秒；建出的博客 `hexo generate` 与 `hexo server --draft` 正常。`tests/create_blog.rs`（设 `HEXO_STUDIO_TEST_CREATE=1` 才跑，要联网）对每个模板和纯 Hexo 各真实创建一次并生成首页，另测安装中途取消后父目录里什么都不留。
- 创建中途退出应用时，退出流程结束 npm 并删掉临时文件夹。
