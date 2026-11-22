import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeftRight, CheckCircle2, ChevronLeft, ChevronRight, FolderSearch, Info, Paintbrush, RotateCcw, Server, User, XCircle } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { UpdateCard } from "@/components/UpdateCard";
import { Group, Row } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type AppInfo, type BlogStatus, type ThemeMode } from "@/lib/api";
import { usePreferences, useTheme } from "@/lib/preferences";
import { inline, RELEASES } from "@/lib/changelog";
import { THEMES, themeOf } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface SettingsPageProps {
  status: BlogStatus | null;
  info: AppInfo | null;
  onStatus: (s: BlogStatus) => void;
  onSwitchProject: () => void;
}

type SectionId = "user" | "editor" | "project" | "node" | "about";

const SECTIONS: { id: SectionId; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "user", label: "用户", hint: "头像、名字", icon: User },
  { id: "editor", label: "编辑器", hint: "主题、明暗", icon: Paintbrush },
  { id: "project", label: "项目", hint: "当前博客与站点", icon: FolderSearch },
  { id: "node", label: "Node", hint: "运行 Hexo 的 Node", icon: Server },
  { id: "about", label: "关于", hint: "版本、更新日志", icon: Info },
];

const MODES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const AVATAR_FILES = ["png", "jpg", "jpeg", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff"];

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className="flex items-start gap-1.5">
      {ok ? <CheckCircle2 className="mt-[2px] h-3.5 w-3.5 shrink-0 text-ok" /> : <XCircle className="mt-[2px] h-3.5 w-3.5 shrink-0 text-danger" />}
      <span className="selectable min-w-0 break-all">{children}</span>
    </span>
  );
}

/** The app's settings, one group at a time: groups on the left, the chosen one on the right. */
export function SettingsPage({ status, info, onStatus, onSwitchProject }: SettingsPageProps) {
  const [section, setSection] = useState<SectionId>("user");
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="flex h-full min-h-0 gap-4 px-5 pb-5 pt-1">
      <nav className="w-[180px] shrink-0 space-y-0.5 overflow-y-auto">
        {SECTIONS.map((s) => {
          const active = s.id === section;
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              aria-current={active ? "true" : undefined}
              className={cn("flex h-[46px] w-full items-center gap-3 rounded-lg px-3 text-left active:!scale-100", active ? "bg-brand-soft" : "hover:bg-pill")}
            >
              <Icon className={cn("h-4 w-4 shrink-0", active ? "text-brand" : "text-muted")} />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[13px] leading-5", active ? "font-semibold text-brand" : "text-fg")}>{s.label}</span>
                <span className={cn("block truncate text-[11.5px] leading-4", active ? "text-brand/75" : "text-muted")}>{s.hint}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div key={section} className="view-in mx-auto w-full max-w-[680px] space-y-5 pb-10">
          <h2 className="sr-only">{current.label}</h2>
          {section === "user" && <UserSection />}
          {section === "editor" && <EditorSection />}
          {section === "project" && <ProjectSection status={status} onSwitchProject={onSwitchProject} />}
          {section === "node" && <NodeSection status={status} onStatus={onStatus} />}
          {section === "about" && <AboutSection info={info} />}
        </div>
      </div>
    </div>
  );
}

function UserSection() {
  const toast = useToast();
  const { user, setUser } = usePreferences();
  const [name, setName] = useState(user?.name ?? "");

  const run = async (p: Promise<Parameters<typeof setUser>[0]>) => {
    try {
      const next = await p;
      setUser(next);
      setName(next.name);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const chooseAvatar = async () => {
    const path = await open({ title: "选择头像", multiple: false, directory: false, filters: [{ name: "图片", extensions: AVATAR_FILES }] });
    if (typeof path === "string") await run(api.setUserAvatar(path));
  };

  const saveName = () => {
    const next = name.trim();
    if (next && next !== user?.name) void run(api.setUserName(next));
    else setName(user?.name ?? "");
  };

  return (
    <>
      <Group label="用户">
        <div className="flex items-center gap-4 px-4 py-4">
          <Avatar user={user} className="h-16 w-16 text-[24px]" />
          <div className="flex flex-col items-start gap-1.5">
            <Button variant="outline" size="sm" onClick={() => void chooseAvatar()}>
              更换头像…
            </Button>
            {user?.avatar && (
              <Button variant="ghost" size="sm" onClick={() => void run(api.clearUserAvatar())}>
                移除头像
              </Button>
            )}
          </div>
        </div>
        <Row label="名字" hint="显示在侧栏左下角。">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
            className="w-[220px] min-w-0"
          />
        </Row>
      </Group>
      <p className="px-1 text-[12px] leading-[18px] text-muted">
        头像取图片正中的正方形，缩成 256 像素保存。用户资料和偏好（外观、最近项目、Node 路径、原图备份目录等）只存在这台 Mac 的数据目录里；博客的存储配置仍随博客保存在 .hexostudio/。
      </p>
    </>
  );
}

function EditorSection() {
  const [mode, setMode] = useTheme();
  const { ui, update } = usePreferences();
  const current = themeOf(ui.theme).id;
  return (
    <>
      <Group label="主题">
        <div className="grid grid-cols-2 gap-2 p-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => update({ theme: t.id })}
              aria-pressed={current === t.id}
              className={cn(
                "rounded-lg px-3.5 py-3 text-left active:!scale-100",
                current === t.id ? "bg-brand-soft shadow-[inset_0_0_0_1.5px_rgb(var(--brand))]" : "bg-pill hover:bg-pill-hover",
              )}
            >
              <div className={cn("text-[13px] font-semibold", current === t.id && "text-brand")}>{t.name}</div>
              <div className="mt-0.5 text-[12px] leading-[18px] text-fg-2">{t.description}</div>
            </button>
          ))}
        </div>
      </Group>
      <Group label="明暗">
        <Row label="明暗" hint="每个主题都有浅色和深色；顶栏右上角的按钮也能切换。">
          <Segmented value={mode} options={MODES} onChange={setMode} />
        </Row>
      </Group>
    </>
  );
}

function ProjectSection({ status, onSwitchProject }: { status: BlogStatus | null; onSwitchProject: () => void }) {
  const toast = useToast();
  const config = status?.config;
  return (
    <Group label="项目">
      <Row
        label={config?.title ?? "博客"}
        hint={
          <span className="block space-y-0.5">
            <Check ok={!status?.error}>{status?.error ? `${status.dir}：${status.error}` : status?.dir}</Check>
            {status?.remote && <span className="selectable block pl-5 font-mono text-[11.5px]">origin {status.remote}</span>}
          </span>
        }
      >
        <Button variant="ghost" size="sm" title="在 Finder 中显示" onClick={() => void api.revealProject().catch((e) => toast(errorText(e), "error"))}>
          <FolderSearch />
        </Button>
        <Button variant="outline" size="sm" onClick={onSwitchProject}>
          <ArrowLeftRight />
          切换项目
        </Button>
      </Row>
      {status?.dir && !status.error && <Row label="Hexo" hint={<Check ok={!status.hexoError}>{status.hexoError ?? "已安装在博客的 node_modules 里"}</Check>} />}
      {config && (
        <Row
          label="站点配置"
          hint={
            <span className="selectable block space-y-0.5">
              <span className="block">地址 {config.url}</span>
              <span className="block">
                文章路径 <span className="font-mono">{config.permalink}</span> · 时区 {config.timezone ?? "未设置（使用本机时区）"}
              </span>
              <span className="block">
                部署 {config.deploy.length ? config.deploy.map((d) => [d.kind, d.repo, d.branch].filter(Boolean).join(" · ")).join("；") : "未配置"}
              </span>
            </span>
          }
        />
      )}
    </Group>
  );
}

function NodeSection({ status, onStatus }: { status: BlogStatus | null; onStatus: (s: BlogStatus) => void }) {
  const toast = useToast();
  const node = status?.node;
  const chooseNode = async () => {
    const picked = await open({ title: "选择 node 可执行文件", multiple: false, directory: false });
    if (typeof picked !== "string") return;
    try {
      onStatus(await api.setNodePath(picked));
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  return (
    <Group label="Node">
      <Row
        label={node?.manual ? "Node（手动指定）" : "Node（自动查找）"}
        hint={node ? <Check ok={!node.error}>{node.error ?? `${node.path}${node.version ? ` · ${node.version}` : ""}`}</Check> : "读取中…"}
      >
        {node?.manual && (
          <Button variant="ghost" size="sm" title="改回自动查找" onClick={() => void api.setNodePath(null).then(onStatus)}>
            <RotateCcw />
            自动
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void chooseNode()}>
          指定…
        </Button>
      </Row>
      <div className="px-4 py-2.5 text-[12px] leading-[18px] text-muted">
        自动查找依次看登录 shell 的 PATH（nvm、fnm、Volta、Homebrew 都在这里设置）和常见安装位置。Hexo 一律用博客自己的 node_modules。
      </div>
    </Group>
  );
}

function AboutSection({ info }: { info: AppInfo | null }) {
  const [notes, setNotes] = useState(false);
  if (notes) return <Changelog current={info?.version ?? null} onBack={() => setNotes(false)} />;
  return (
    <Group label="关于">
      <div className="px-4 py-3">
        <div className="text-[13px] font-medium">版本</div>
        <div className="mt-1">
          <UpdateCard version={info?.version ?? null} />
        </div>
      </div>
      <Row label="更新日志" hint="每个版本新增和改动了什么。">
        <Button variant="outline" size="sm" onClick={() => setNotes(true)}>
          查看
          <ChevronRight />
        </Button>
      </Row>
      <Row label="数据目录" hint={<span className="selectable break-all">{info?.dataDir}</span>} />
    </Group>
  );
}

/** Every version's notes, newest first, as on the GitHub release page. */
function Changelog({ current, onBack }: { current: string | null; onBack: () => void }) {
  const text = (t: string) =>
    inline(t).map((r, i) =>
      r.style === "code" ? (
        <code key={i} className="rounded-sm bg-pill px-1 font-mono text-[12px]">
          {r.text}
        </code>
      ) : r.style === "bold" ? (
        <strong key={i} className="font-semibold text-fg">
          {r.text}
        </strong>
      ) : (
        <span key={i}>{r.text}</span>
      ),
    );
  return (
    <div className="space-y-5">
      <button onClick={onBack} className="-ml-1 flex items-center gap-1 rounded-control px-1 py-0.5 text-[12.5px] text-muted hover:text-fg active:!scale-100">
        <ChevronLeft className="h-3.5 w-3.5" />
        关于
      </button>
      {RELEASES.map((r) => (
        <Group
          key={r.version}
          label={
            <span className="flex items-center gap-2 normal-case tracking-normal">
              <span className="font-mono text-[12px] font-semibold text-fg">v{r.version}</span>
              {r.version === current && <span className="rounded-sm bg-brand-soft px-1.5 text-[11px] font-medium text-brand">当前版本</span>}
            </span>
          }
        >
          <div className="selectable space-y-2.5 px-4 py-3.5 text-[12.5px] leading-[20px] text-fg-2">
            {r.blocks.map((b, i) =>
              b.kind === "heading" ? (
                <h3 key={i} className="pt-1 text-[13px] font-semibold text-fg first:pt-0">
                  {text(b.text)}
                </h3>
              ) : b.kind === "paragraph" ? (
                <p key={i}>{text(b.text)}</p>
              ) : (
                <ul key={i} className="list-disc space-y-1 pl-5 marker:text-faint">
                  {b.items.map((it, j) => (
                    <li key={j}>{text(it)}</li>
                  ))}
                </ul>
              ),
            )}
          </div>
        </Group>
      ))}
    </div>
  );
}
