import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderPlus, GitBranch, Moon, Sun, SunMoon, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import appIcon from "@/assets/app-icon.png";
import { NewBlogDialog } from "@/components/NewBlogDialog";
import { UpdateCard } from "@/components/UpdateCard";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type BlogStatus, type ProjectCard } from "@/lib/api";
import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface WelcomePageProps {
  version: string | null;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onOpened: (status: BlogStatus) => void;
}

const nextTheme: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };

/** `git@github.com:a/b.git`, `https://github.com/a/b.git` → `github.com/a/b`. */
function shortRemote(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, "")
    .replace(/\.git$/, "");
}

function ago(seconds: number): string {
  const d = Math.floor((Date.now() / 1000 - seconds) / 86400);
  return d <= 0 ? "今天" : d === 1 ? "昨天" : d < 30 ? `${d} 天前` : new Date(seconds * 1000).toLocaleDateString("zh-CN");
}

/** The first screen, as in an IDE: open a blog folder as the project, or one opened before. */
export function WelcomePage({ version, theme, onThemeChange, onOpened }: WelcomePageProps) {
  const toast = useToast();
  const [recent, setRecent] = useState<ProjectCard[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon;

  const load = useCallback(() => {
    api.recentProjects().then(setRecent, () => setRecent([]));
  }, []);
  useEffect(load, [load]);

  const openPath = async (path: string) => {
    setOpening(path);
    try {
      onOpened(await api.openProject(path));
    } catch (e) {
      toast(errorText(e), "error");
      load();
    } finally {
      setOpening(null);
    }
  };

  const choose = async () => {
    const dir = await open({ title: "打开 Hexo 博客文件夹", directory: true, multiple: false });
    if (typeof dir === "string") await openPath(dir);
  };

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <div data-tauri-drag-region className="flex h-12 shrink-0 items-center justify-end px-3">
        <button
          onClick={() => onThemeChange(nextTheme[theme])}
          title="切换主题"
          className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-muted hover:bg-pill hover:text-fg"
        >
          <ThemeIcon className="h-[15px] w-[15px]" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pb-10">
        <div className="view-in grid w-full max-w-[880px] grid-cols-[260px_1fr] gap-12 pt-[6vh]">
          <div className="space-y-6">
            <div className="space-y-3">
              <img src={appIcon} alt="" className="h-14 w-14 rounded-[13px]" draggable={false} />
              <div>
                <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Hexo-Studio</h1>
                <p className="mt-1 text-[13px] leading-5 text-fg-2">写文章、看主题真实效果、一键部署你的 Hexo 博客。</p>
              </div>
              <UpdateCard version={version} />
            </div>
            <div className="flex flex-col items-start gap-2">
              <Button onClick={() => void choose()} disabled={opening !== null}>
                <FolderOpen />
                打开博客文件夹…
              </Button>
              <Button variant="outline" onClick={() => setCreating(true)} disabled={opening !== null}>
                <FolderPlus />
                新建博客…
              </Button>
            </div>
            <p className="text-[12px] leading-[18px] text-muted">
              打开时选有 _config.yml 的那个文件夹（博客源码仓库），也可以新建一个。打开后会在里面建一个 .hexostudio/ 存放本应用的项目设置，其中 local/ 不进 git。
            </p>
          </div>

          <div className="min-w-0">
            <div className="group-label">最近打开</div>
            {recent === null ? null : recent.length === 0 ? (
              <div className="rounded-xl bg-card px-4 py-8 text-center text-[13px] text-muted shadow-card">还没有打开过博客。</div>
            ) : (
              <div className="list-card">
                {recent.map((p) => (
                  <div key={p.path} className={cn("group relative flex items-center", p.error && "opacity-60")}>
                    <button
                      onClick={() => void openPath(p.path)}
                      disabled={opening !== null || !!p.error}
                      title={p.error ?? p.path}
                      className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-pill/60 active:!scale-100 disabled:cursor-not-allowed"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[14px] font-medium">{p.name}</span>
                          <span className="shrink-0 text-[11.5px] text-muted">{opening === p.path ? "打开中…" : ago(p.openedAt)}</span>
                        </div>
                        <div className="truncate font-mono text-[11.5px] text-muted">{p.path}</div>
                        {p.remote && (
                          <div className="mt-0.5 flex items-center gap-1 truncate text-[11.5px] text-fg-2">
                            <GitBranch className="h-3 w-3 shrink-0" />
                            {shortRemote(p.remote)}
                          </div>
                        )}
                        {p.error && <div className="mt-0.5 truncate text-[11.5px] text-danger">{p.error}</div>}
                      </div>
                    </button>
                    <button
                      title="从列表移除（不删除文件）"
                      onClick={() => void api.forgetProject(p.path).then(load)}
                      className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-pill hover:text-fg group-hover:flex"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <NewBlogDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(path) => {
          setCreating(false);
          void openPath(path);
        }}
      />
    </div>
  );
}
