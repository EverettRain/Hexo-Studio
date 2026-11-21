import { ChevronsUpDown, FileText, GitBranch, Images, MonitorPlay, Moon, Rocket, Settings, SlidersHorizontal, Sun, SunMoon } from "lucide-react";
import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import appIcon from "@/assets/app-icon.png";
import type { PreviewState } from "@/lib/api";
import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type PageId = "posts" | "images" | "config" | "preview" | "source" | "deploy" | "settings";

type Icon = React.ComponentType<{ className?: string }>;
interface NavItem {
  id: PageId;
  label: string;
  icon: Icon;
}

const main: NavItem[] = [
  { id: "posts", label: "文章", icon: FileText },
  { id: "images", label: "图片", icon: Images },
  { id: "config", label: "配置", icon: SlidersHorizontal },
  { id: "preview", label: "预览", icon: MonitorPlay },
  { id: "source", label: "源码", icon: GitBranch },
  { id: "deploy", label: "部署", icon: Rocket },
];
const footer: NavItem[] = [{ id: "settings", label: "设置", icon: Settings }];

const nextTheme: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
const themeLabel: Record<ThemeMode, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

interface AppShellProps {
  activePage: PageId;
  onPageChange: (page: PageId) => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  preview: PreviewState;
  /** Title bar content in place of the page name (the editor shows the post here). */
  title: React.ReactNode;
  /** Controls placed in the title bar, left of the theme button. */
  headerExtra?: React.ReactNode;
  project: { name: string; path: string };
  onSwitchProject: () => void;
  children: React.ReactNode;
}

function NavRow({ item, active, onSelect, setRef }: { item: NavItem; active: boolean; onSelect: () => void; setRef: (el: HTMLButtonElement | null) => void }) {
  const Icon = item.icon;
  return (
    <button
      ref={setRef}
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative z-10 flex h-[30px] w-full items-center gap-[9px] rounded-[7px] px-2 text-left text-[13px] active:!scale-100",
        active ? "font-medium text-fg" : "text-fg-2 hover:bg-pill hover:text-fg",
      )}
    >
      <Icon className={cn("h-[15px] w-[15px] shrink-0", active ? "text-fg" : "text-muted")} />
      {item.label}
    </button>
  );
}

function previewText(p: PreviewState): string {
  switch (p.state) {
    case "running":
      return `预览运行中 · 端口 ${p.port}`;
    case "starting":
      return "预览启动中…";
    case "failed":
      return "预览服务器出错";
    default:
      return "预览未启动";
  }
}

export function AppShell({ activePage, onPageChange, theme, onThemeChange, preview, title, headerExtra, project, onSwitchProject, children }: AppShellProps) {
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon;
  const refs = useRef<Partial<Record<PageId, HTMLButtonElement | null>>>({});
  const nav = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<number | null>(null);

  // Sliding highlight behind the active row.
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[activePage];
      const box = nav.current;
      if (el && box) setThumb(el.getBoundingClientRect().top - box.getBoundingClientRect().top);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activePage]);

  const row = (item: NavItem) => (
    <NavRow key={item.id} item={item} active={activePage === item.id} onSelect={() => onPageChange(item.id)} setRef={(el) => (refs.current[item.id] = el)} />
  );

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-fg">
      <aside className="flex w-[216px] shrink-0 flex-col border-r-[0.5px] border-line bg-bg">
        {/* The title bar row holds only the traffic lights; the project gets a row of its own. */}
        <div data-tauri-drag-region className="h-12 shrink-0" />
        <div className="shrink-0 px-2.5 pb-2">
          <button
            onClick={onSwitchProject}
            title={`${project.path}\n点击切换项目`}
            className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left hover:bg-pill active:!scale-100"
          >
            <img src={appIcon} alt="" className="pointer-events-none h-7 w-7 shrink-0 rounded-[7px]" draggable={false} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-4">{project.name}</span>
              <span className="block truncate text-[11px] leading-4 text-muted">{project.path.split("/").pop()}</span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted" />
          </button>
        </div>

        <div ref={nav} className="relative flex min-h-0 flex-1 flex-col px-2.5">
          {thumb !== null && (
            <span
              aria-hidden
              className="absolute inset-x-2.5 h-[30px] rounded-[7px] bg-card shadow-edge transition-[top] duration-300 ease-soft dark:bg-white/[.07]"
              style={{ top: thumb }}
            />
          )}
          <div className="flex-1 space-y-0.5 overflow-y-auto pb-2 pt-1">{main.map(row)}</div>
          <div className="space-y-0.5 border-t-[0.5px] border-line-2 py-2">{footer.map(row)}</div>
        </div>

        <div className="flex h-9 shrink-0 items-center gap-2 px-[18px] pb-1 text-[11.5px] text-muted" title={preview.state === "failed" ? preview.message : undefined}>
          <span
            className={cn(
              "h-[7px] w-[7px] shrink-0 rounded-full",
              preview.state === "running" ? "bg-ok shadow-[0_0_0_3px_rgb(var(--ok-soft))]" : preview.state === "failed" ? "bg-danger" : preview.state === "starting" ? "bg-warn" : "bg-faint",
            )}
          />
          <span className="truncate">{previewText(preview)}</span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className="flex h-12 shrink-0 items-center justify-between gap-3 pl-5 pr-3">
          <div data-tauri-drag-region className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold">
            {title}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerExtra}
            <button
              onClick={() => onThemeChange(nextTheme[theme])}
              title={`主题：${themeLabel[theme]}（点击切换）`}
              aria-label={`主题：${themeLabel[theme]}`}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-muted hover:bg-pill hover:text-fg"
            >
              <ThemeIcon className="h-[15px] w-[15px]" />
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
