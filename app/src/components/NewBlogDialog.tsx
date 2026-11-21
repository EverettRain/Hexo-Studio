import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { Check, CircleAlert, ExternalLink, FolderOpen, Hexagon, LayoutTemplate, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { api, errorText, onEvent, type BlogTemplate, type CreateProgress, type CreateStep, type NewBlogForm } from "@/lib/api";
import { cn } from "@/lib/utils";

interface NewBlogDialogProps {
  open: boolean;
  onClose: () => void;
  /** The new blog's folder, to open it. */
  onCreated: (path: string) => void;
}

/** The theme step only runs for a template; `t` is set there. */
const STEPS: { step: CreateStep; label: (t: BlogTemplate | null) => string }[] = [
  { step: "files", label: () => "写入 Hexo 基础文件" },
  { step: "theme", label: (t) => `下载主题 ${t?.package}` },
  { step: "install", label: () => "安装依赖（npm install）" },
  { step: "git", label: () => "初始化 git 仓库" },
];

/** Lines of npm's output kept on screen. */
const KEPT_LINES = 300;

type Phase = { kind: "form" } | { kind: "running"; step: CreateStep | null } | { kind: "failed"; step: CreateStep | null; error: string };

/** A new blog, plain or from a template (docs/design.md, section 15): the form, then each step as it runs. */
export function NewBlogDialog({ open, onClose, onCreated }: NewBlogDialogProps) {
  const [form, setForm] = useState<NewBlogForm | null>(null);
  /** A template's id; null for plain Hexo; undefined until the form has loaded. */
  const [template, setTemplate] = useState<string | null | undefined>(undefined);
  const [title, setTitle] = useState("我的博客");
  const [author, setAuthor] = useState("");
  const [parent, setParent] = useState("");
  const [folder, setFolder] = useState("my-blog");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [lines, setLines] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: "form" });
    void api.newBlogForm().then((f) => {
      setForm(f);
      setTemplate((t) => (t === undefined ? (f.templates[0]?.id ?? null) : t));
      setParent((p) => p || f.parent);
      setAuthor((a) => a || f.author);
    });
  }, [open]);

  useEffect(
    () =>
      onEvent<CreateProgress>("create-progress", (p) => {
        if (p.kind === "step") setPhase((ph) => (ph.kind === "running" ? { kind: "running", step: p.step } : ph));
        else setLines((l) => [...l.slice(-(KEPT_LINES - 1)), p.text]);
      }),
    [],
  );

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const chosen = form?.templates.find((t) => t.id === template) ?? null;
  const steps = STEPS.filter((s) => s.step !== "theme" || chosen);
  const running = phase.kind === "running";
  const target = parent && folder.trim() ? `${parent.replace(/\/$/, "")}/${folder.trim()}` : "";
  const ready = template !== undefined && !!title.trim() && !!target;

  const create = async () => {
    if (!ready || running) return;
    setLines([]);
    setPhase({ kind: "running", step: null });
    let reached: CreateStep | null = null;
    const stop = onEvent<CreateProgress>("create-progress", (p) => {
      if (p.kind === "step") reached = p.step;
    });
    try {
      const path = await api.createBlog({ template: template ?? null, parent, folder: folder.trim(), title: title.trim(), author: author.trim() });
      setPhase({ kind: "form" });
      onCreated(path);
    } catch (e) {
      setPhase({ kind: "failed", step: reached, error: errorText(e) });
    } finally {
      stop();
    }
  };

  const pickParent = async () => {
    const dir = await chooseFolder({ title: "新博客放在哪个文件夹里", directory: true, multiple: false, defaultPath: parent || undefined });
    if (typeof dir === "string") setParent(dir);
  };

  const showSteps = phase.kind !== "form";

  return (
    <Dialog
      open={open}
      onClose={() => !running && onClose()}
      title="新建博客"
      description={showSteps ? target : "建一个可以直接预览、写作的 Hexo 博客：纯 Hexo，或者从模板开始。"}
      className="max-w-[760px]"
      footer={
        phase.kind === "form" ? (
          <>
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button onClick={() => void create()} disabled={!ready}>
              创建
            </Button>
          </>
        ) : running ? (
          <Button variant="outline" onClick={() => void api.cancelCreate()}>
            取消创建
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
            <Button onClick={() => setPhase({ kind: "form" })}>返回修改</Button>
          </>
        )
      }
    >
      {/* As in an IDE's new-project window: templates on the left, the chosen one's settings on the right. */}
      <div className="-mx-5 -my-3 flex h-[420px] border-y border-line">
        <div className="flex w-[200px] shrink-0 flex-col bg-bg/70 p-2">
          {/* Plain Hexo is not a template: it stands apart, above them. */}
          <button
            type="button"
            disabled={phase.kind !== "form"}
            onClick={() => setTemplate(null)}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] active:!scale-100 disabled:cursor-default",
              template === null ? "bg-brand-soft font-semibold text-brand" : "text-fg hover:bg-pill",
            )}
          >
            <Hexagon className="h-4 w-4 shrink-0" />
            纯 Hexo
          </button>
          <div className="mx-2 my-2 border-t border-line" />
          <div className="px-2 pb-1.5 text-[11.5px] font-medium text-muted">模板</div>
          {form?.templates.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={phase.kind !== "form"}
              onClick={() => setTemplate(t.id)}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] active:!scale-100 disabled:cursor-default",
                template === t.id ? "bg-brand-soft font-semibold text-brand" : "text-fg hover:bg-pill",
              )}
            >
              <LayoutTemplate className="h-4 w-4 shrink-0" />
              <span className="truncate">{t.name}</span>
            </button>
          ))}
          <p className="mt-auto px-2 pb-1 text-[11.5px] leading-[17px] text-muted">目前只有这一个模板。</p>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {template === null && (
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold">纯 Hexo</span>
                <span className="font-mono text-[11px] text-muted">hexo init</span>
              </div>
              <p className="mt-1 text-[12.5px] leading-[19px] text-fg-2">
                与官方 hexo init 的结果相同：Hexo 的基础骨架和它自带的默认主题 landscape，不另装主题和插件，之后可以自己换主题。
              </p>
            </div>
          )}
          {chosen && (
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold">{chosen.name}</span>
                <button
                  type="button"
                  title="在 npm 上查看"
                  onClick={() => void api.openUrl(`https://www.npmjs.com/package/${chosen.package}`)}
                  className="inline-flex items-center gap-0.5 font-mono text-[11px] text-muted hover:text-fg active:!scale-100"
                >
                  {chosen.package}
                  <ExternalLink className="h-3 w-3" />
                </button>
              </div>
              <p className="mt-1 text-[12.5px] leading-[19px] text-fg-2">{chosen.description}</p>
            </div>
          )}

          {showSteps ? (
            <div className="space-y-3">
              <ol className="space-y-1.5">
                {steps.map(({ step, label }, i) => {
                  const at = steps.findIndex((s) => s.step === phase.step);
                  const state = i < at ? "done" : i > at ? "pending" : phase.kind === "failed" ? "failed" : "running";
                  return (
                    <li key={step} className={cn("flex items-center gap-2.5 text-[13px]", state === "pending" ? "text-muted" : "text-fg")}>
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {state === "done" ? (
                          <Check className="h-4 w-4 text-ok" />
                        ) : state === "running" ? (
                          <Loader2 className="h-4 w-4 animate-spin text-brand" />
                        ) : state === "failed" ? (
                          <CircleAlert className="h-4 w-4 text-danger" />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full bg-muted/50" />
                        )}
                      </span>
                      {label(chosen)}
                    </li>
                  );
                })}
              </ol>
              {phase.kind === "failed" && (
                <div className="selectable whitespace-pre-wrap rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
                  {phase.error}
                  {"\n"}没有留下任何文件。
                </div>
              )}
              <div className="h-[150px] overflow-y-auto rounded-lg bg-bg px-3 py-2">
                {lines.length === 0 ? (
                  <div className="text-[12px] text-muted">npm 的输出会显示在这里。</div>
                ) : (
                  lines.map((l, i) => (
                    <div key={i} className="selectable whitespace-pre-wrap break-all font-mono text-[11px] leading-[17px] text-fg-2">
                      {l}
                    </div>
                  ))
                )}
                <div ref={logEnd} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[64px_1fr] items-center gap-x-3 gap-y-3">
              <Label>博客标题</Label>
              <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="我的博客" />
              <Label>作者</Label>
              <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="可以以后在配置页填" />
              <Label>位置</Label>
              <button
                type="button"
                onClick={() => void pickParent()}
                title="选择放在哪个文件夹里"
                className="field flex min-w-0 items-center gap-2 text-left text-fg-2 hover:bg-pill-hover active:!scale-100"
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="truncate font-mono text-[12px]">{parent || "选择文件夹…"}</span>
              </button>
              <Label>文件夹名</Label>
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="my-blog" className="font-mono text-[12px]" />
              <span />
              <p className="-mt-1 truncate font-mono text-[11.5px] text-muted">{target ? `将创建 ${target}` : "\u00a0"}</p>
              <span />
              <p className="text-[11.5px] leading-[18px] text-muted">
                创建时依次：{steps.map(({ label }) => label(chosen)).join(" → ")}，完成后直接打开。需要联网（npm）。
              </p>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
