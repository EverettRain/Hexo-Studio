import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ChevronLeft, ExternalLink, FolderSearch, PanelRightClose, PanelRightOpen, Search, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorToolbar } from "@/components/EditorToolbar";
import { FrontMatterBar, FrontMatterPanel } from "@/components/FrontMatterForm";
import { MarkdownEditor, type EditorHandle } from "@/components/MarkdownEditor";
import { PreviewPane } from "@/components/PreviewPane";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ImagePicker } from "@/components/ImagePicker";
import { api, errorText, type BlogConfigView, type ImageFormat, type Ingested, type PageProbe, type PostFile, type PostSummary, type PreviewState } from "@/lib/api";
import { applyEdits } from "@/lib/frontmatter";
import { wordCount, type FormatState } from "@/lib/markdownCommands";
import { usePageActive } from "@/lib/pageActive";
import { cn } from "@/lib/utils";

interface EditorPageProps {
  id: string;
  config: BlogConfigView;
  preview: PreviewState;
  posts: PostSummary[];
  onClose: () => void;
  onSaved: (summary: PostSummary) => void;
  /** A draft became a post with this id. */
  onPublished: (id: string) => void;
  /** Set to a function that saves pending changes, for the window to call before it leaves the project. */
  flushRef: React.MutableRefObject<(() => Promise<void>) | null>;
}

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg"];
const isImagePath = (p: string) => IMAGE_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? "");
const baseName = (p: string) => p.split("/").pop() ?? p;
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** Pasted screenshots arrive as `image.png`: those are named by time instead. */
const pastedName = (f: File) => (/^image\.\w+$/i.test(f.name) ? "" : f.name);

/** Typing stops this long before the post is saved (and the preview refreshed). */
const AUTOSAVE_MS = 1000;
const PREVIEW_WIDTH_KEY = "hexo-studio.preview-width";

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    return v >= 0.2 && v <= 0.8 ? v : 0.5;
  } catch {
    return 0.5;
  }
}

/** Where the page of a post is, under the site root. */
function sitePath(config: BlogConfigView, summary: PostSummary | undefined): string | null {
  return summary?.urlPath ? `${config.root}${summary.urlPath}` : null;
}

export function EditorPage({ id, config, preview, posts, onClose, onSaved, onPublished, flushRef }: EditorPageProps) {
  const toast = useToast();
  const [file, setFile] = useState<PostFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [yaml, setYaml] = useState("");
  const [body, setBody] = useState("");
  const [state, setState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showPreview, setShowPreview] = useState(true);
  const [width, setWidth] = useState(readWidth);
  const [publishing, setPublishing] = useState<"ask" | "busy" | null>(null);
  const editor = useRef<EditorHandle>(null);
  const active = usePageActive();
  const [format, setFormat] = useState<ImageFormat>("webp");
  const [storageReady, setStorageReady] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [picking, setPicking] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [fmt, setFmt] = useState<FormatState | null>(null);
  const words = useMemo(() => wordCount(body), [body]);
  const closeMeta = useCallback(() => setMetaOpen(false), []);

  // Read again whenever the page is shown: the store may have been set up in settings meanwhile.
  useEffect(() => {
    if (!active) return;
    api.imageSettings().then(
      (s) => {
        setFormat(s.upload.format);
        setStorageReady(!!s.storage && !!s.accessKeyId);
      },
      () => {},
    );
  }, [active]);

  /**
   * Each image gets a placeholder at the cursor at once, replaced by its link when the upload
   * finishes (or removed if it fails), so typing can go on meanwhile.
   */
  const uploadImages = useCallback(
    async (items: { label: string; run: () => Promise<Ingested> }[]) => {
      if (!items.length) return;
      if (!storageReady) {
        toast("还没有设置图片存储：设置 → 图片存储", "error");
        return;
      }
      const tagged = items.map((it, i) => ({ ...it, mark: `![上传中：${it.label}…](#${Date.now().toString(36)}${i})` }));
      editor.current?.insert(tagged.map((t) => t.mark).join("\n"));
      setUploading((n) => n + tagged.length);
      await Promise.all(
        tagged.map(async (t) => {
          try {
            const r = await t.run();
            editor.current?.replace(t.mark, `![](${r.image.url})`);
            toast(
              r.existed
                ? `图库里已有这张图（${r.image.name}），直接引用`
                : `已入库 ${t.label}（${r.image.format === "webp" ? `WebP ${kb(r.image.bytes)}，原图 ${kb(r.originalBytes)}` : kb(r.image.bytes)}）`,
            );
          } catch (e) {
            editor.current?.replace(t.mark, "");
            toast(`${t.label} 上传失败：${errorText(e)}`, "error");
          } finally {
            setUploading((n) => n - 1);
          }
        }),
      );
    },
    [storageReady, toast],
  );

  const uploadPaths = useCallback(
    (paths: string[]) => uploadImages(paths.filter(isImagePath).map((p) => ({ label: baseName(p), run: () => api.uploadImageFile(id, p, format) }))),
    [uploadImages, id, format],
  );

  const chooseImages = async () => {
    const picked = await openDialog({ title: "插入图片", multiple: true, filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }] });
    if (picked) void uploadPaths(Array.isArray(picked) ? picked : [picked]);
  };

  // Files dropped on the window arrive as paths through Tauri, not as DOM drop events.
  useEffect(() => {
    if (!active) return;
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter") setDropping(p.paths.some(isImagePath));
      else if (p.type === "leave") setDropping(false);
      else if (p.type === "drop") {
        setDropping(false);
        void uploadPaths(p.paths);
      }
    });
    return () => void un.then((f) => f());
  }, [active, uploadPaths]);
  const split = useRef<HTMLDivElement>(null);

  // The latest text and what is on disk, for saves started by timers and shortcuts.
  const current = useRef({ yaml, body });
  current.current = { yaml, body };
  const disk = useRef<{ file: PostFile; yaml: string; body: string } | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const f = await api.readPost(id);
      disk.current = { file: f, yaml: f.yaml, body: f.body };
      setFile(f);
      setYaml(f.yaml);
      setBody(f.body);
      setState("saved");
      setSaveError(null);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The preview server starts with the editor (and keeps running when it closes).
  useEffect(() => {
    if (preview.state === "stopped") void api.previewStart().catch(() => {});
    // Only when the editor opens; a server stopped on purpose stays stopped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(
    async (overwrite = false): Promise<void> => {
      if (saving.current) {
        await saving.current;
      }
      const d = disk.current;
      if (!d) return;
      const { yaml: y, body: b } = current.current;
      if (y === d.yaml && b === d.body && !overwrite) {
        setState("saved");
        return;
      }
      const run = (async () => {
        setState("saving");
        const hasFront = d.file.prefix !== "" || y.trim() !== "";
        const text = hasFront ? `${d.file.prefix || "---\n"}${y}${y && !y.endsWith("\n") ? "\n" : ""}${d.file.suffix || "---\n"}${b}` : b;
        const before = sitePath(config, d.file.summary);
        let probe: PageProbe | null = null;
        if (preview.state === "running" && before) probe = await api.previewProbe(before).catch(() => null);
        try {
          let expected = d.file.fingerprint;
          if (overwrite) expected = (await api.readPost(id)).fingerprint;
          const r = await api.writePost(id, text, expected);
          if (r.status === "conflict") {
            setState("conflict");
            return;
          }
          const saved: PostFile = { ...d.file, summary: r.summary, fingerprint: r.fingerprint, yaml: y, body: b, prefix: hasFront ? d.file.prefix || "---\n" : "", suffix: hasFront ? d.file.suffix || "---\n" : "" };
          disk.current = { file: saved, yaml: y, body: b };
          setFile(saved);
          setSaveError(null);
          const c = current.current;
          setState(c.yaml === y && c.body === b ? "saved" : "dirty");
          onSaved(r.summary);
          const after = sitePath(config, r.summary);
          if (preview.state === "running" && after) {
            // A changed date moves the page: nothing to compare with, the new page just loads.
            await api.previewAwaitChange(after, after === before ? probe : null).catch(() => null);
            setReloadKey((k) => k + 1);
          }
        } catch (e) {
          setState("error");
          setSaveError(errorText(e));
        }
      })();
      saving.current = run;
      await run;
      saving.current = null;
    },
    [config, id, onSaved, preview.state],
  );

  useEffect(() => {
    flushRef.current = async () => {
      window.clearTimeout(timer.current);
      await save();
    };
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, save]);

  // Autosave after a pause in typing.
  useEffect(() => {
    const d = disk.current;
    if (!d || (yaml === d.yaml && body === d.body)) return;
    if (state === "conflict") return;
    setState((s) => (s === "saving" ? s : "dirty"));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer.current);
    // `state` only gates; saving must not re-arm the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yaml, body, save]);

  // ⌘S anywhere in the editor (CodeMirror handles its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        window.clearTimeout(timer.current);
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const close = async () => {
    window.clearTimeout(timer.current);
    if (state !== "conflict") await save();
    onClose();
  };

  const publish = async () => {
    if (!file) return;
    setPublishing("busy");
    window.clearTimeout(timer.current);
    await save();
    try {
      const run = await api.runTaskAndWait({ kind: "publish", slug: file.summary.fileName.replace(/\.(md|markdown)$/, "") });
      if (run.status === "succeeded" && run.created) {
        toast("已发布到 _posts，下次部署时上线");
        onPublished(run.created);
      } else {
        toast(run.lines.filter((l) => l.level === "error").map((l) => l.text).slice(-3).join("\n") || "发布没有成功", "error");
      }
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setPublishing(null);
    }
  };

  const suggestions = useMemo(() => {
    const tags = new Set<string>();
    const cats = new Set<string>();
    for (const p of posts) {
      p.tags.forEach((t) => tags.add(t));
      p.categories.forEach((c) => cats.add(c));
    }
    return { tags: [...tags].sort(), categories: [...cats].sort() };
  }, [posts]);

  const startDrag = (e: React.PointerEvent) => {
    const box = split.current;
    if (!box) return;
    e.preventDefault();
    const rect = box.getBoundingClientRect();
    const move = (ev: PointerEvent) => setWidth(Math.min(0.8, Math.max(0.2, (rect.right - ev.clientX) / rect.width)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("col-resizing");
      setWidth((w) => {
        try {
          localStorage.setItem(PREVIEW_WIDTH_KEY, String(w));
        } catch {
          /* storage unavailable */
        }
        return w;
      });
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px]">
        <div className="text-danger">{loadError}</div>
        <Button variant="outline" onClick={onClose}>
          返回列表
        </Button>
      </div>
    );
  }
  if (!file) return null;

  const statusText: Record<SaveState, string> = { saved: "已保存", dirty: "未保存", saving: "保存中…", conflict: "文件已在外部修改", error: "保存失败" };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b-[0.5px] border-line px-3">
        <Button variant="ghost" size="sm" onClick={() => void close()} className="-ml-1 px-1.5">
          <ChevronLeft />
          文章
        </Button>
        <span className={cn("rounded-[5px] px-1.5 py-px text-[11px] font-medium", file.summary.kind === "draft" ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok")}>
          {file.summary.kind === "draft" ? "草稿" : "已发布"}
        </span>
        <span className="min-w-0 truncate font-mono text-[12px] text-muted">{file.summary.fileName}</span>
        <span className="flex-1" />
        {file.summary.kind === "draft" && (
          <Button size="sm" variant="outline" onClick={() => setPublishing("ask")} disabled={publishing !== null || state === "conflict"}>
            <Send />
            发布
          </Button>
        )}
        <span className={cn("text-[12px]", state === "error" || state === "conflict" ? "text-danger" : "text-muted")} title={saveError ?? undefined}>
          {statusText[state]}
        </span>
        <button title="查找与替换  ⌘F" onClick={() => editor.current?.openSearch()} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-muted hover:bg-pill hover:text-fg">
          <Search className="h-[15px] w-[15px]" />
        </button>
        <button title="在 Finder 中显示" onClick={() => void api.revealPost(id).catch((e) => toast(errorText(e), "error"))} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-muted hover:bg-pill hover:text-fg">
          <FolderSearch className="h-[15px] w-[15px]" />
        </button>
        <button title="用默认编辑器打开" onClick={() => void api.openPostExternally(id).catch((e) => toast(errorText(e), "error"))} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-muted hover:bg-pill hover:text-fg">
          <ExternalLink className="h-[15px] w-[15px]" />
        </button>
        <button title={showPreview ? "隐藏预览" : "显示预览"} onClick={() => setShowPreview((s) => !s)} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-muted hover:bg-pill hover:text-fg">
          {showPreview ? <PanelRightClose className="h-[15px] w-[15px]" /> : <PanelRightOpen className="h-[15px] w-[15px]" />}
        </button>
      </div>

      {state === "conflict" && (
        <div className="flex shrink-0 items-center gap-2 bg-danger-soft px-4 py-2 text-[12.5px] text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">这篇文章在别处（其他编辑器或 git）被修改了，自动保存已暂停。</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            重新载入（放弃我的修改）
          </Button>
          <Button size="sm" variant="destructive" onClick={() => void save(true)}>
            保留我的版本
          </Button>
        </div>
      )}
      {state === "error" && saveError && <div className="selectable shrink-0 bg-danger-soft px-4 py-2 text-[12.5px] text-danger">{saveError}</div>}

      <ImagePicker
        open={picking}
        onClose={() => setPicking(false)}
        postId={id}
        onInsert={(img) => {
          setPicking(false);
          editor.current?.insert(`![](${img.url})`);
        }}
        onCover={(img) => {
          setPicking(false);
          try {
            setYaml(applyEdits(yaml, { cover: img.url }));
            toast(`已设为封面：${img.name}`);
          } catch (e) {
            toast(errorText(e), "error");
          }
        }}
      />
      <Dialog
        open={publishing !== null}
        onClose={() => publishing === "ask" && setPublishing(null)}
        title="发布这篇草稿？"
        description="执行 hexo publish：文件移到 _posts，并写入当前时间作为日期。网站要在下次部署后才会更新。"
        footer={
          <>
            <Button variant="outline" disabled={publishing === "busy"} onClick={() => setPublishing(null)}>
              取消
            </Button>
            <Button disabled={publishing === "busy"} onClick={() => void publish()}>
              {publishing === "busy" ? "发布中…" : "发布"}
            </Button>
          </>
        }
      />

      <div ref={split} className="relative flex min-h-0 flex-1">
        {dropping && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-brand bg-brand-soft/80 text-[14px] font-medium text-brand">
            松开以上传图片（{format === "webp" ? "转成 WebP" : "原图"}），插入到光标处
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorToolbar
            format={fmt}
            run={(cmd) => editor.current?.run(cmd)}
            onUpload={() => void chooseImages()}
            onLibrary={() => setPicking(true)}
            imageFormat={format}
            onImageFormat={setFormat}
            uploading={uploading}
          />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b-[0.5px] border-line-2">
              <FrontMatterBar yaml={yaml} open={metaOpen} onOpenChange={setMetaOpen} />
            </div>
            {/* Absolute, so CodeMirror gets a definite height to scroll in rather than growing past the status bar. */}
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0">
                <MarkdownEditor
                  handle={editor}
                  value={body}
                  onChange={setBody}
                  onSave={() => void save()}
                  onFormat={setFmt}
                  onPasteImages={(files) => void uploadImages(files.map((f) => ({ label: f.name || "截图", run: () => api.uploadImageBytes(id, f, pastedName(f), format) })))}
                />
              </div>
            </div>
            <div className="flex h-6 shrink-0 items-center gap-3 border-t-[0.5px] border-line-2 px-4 text-[11px] tabular-nums text-muted">
              {fmt && (
                <span>
                  第 {fmt.line} 行，第 {fmt.column} 列
                </span>
              )}
              <span className="flex-1" />
              <span title="中日韩文字按字、其他文字按词计，不含代码块、图片、链接地址和标签插件">{words.toLocaleString()} 字</span>
            </div>
            {/* Over the body only: the preview beside it shows each change as it is saved. */}
            {metaOpen && (
              <FrontMatterPanel
                className="absolute inset-x-0 bottom-0 top-9"
                yaml={yaml}
                onChange={setYaml}
                onError={(m) => toast(m, "error")}
                timezone={config.timezone}
                tagSuggestions={suggestions.tags}
                categorySuggestions={suggestions.categories}
                onClose={closeMeta}
              />
            )}
          </div>
        </div>
        {showPreview && (
          <>
            <div onPointerDown={startDrag} className="w-[5px] shrink-0 cursor-col-resize border-l-[0.5px] border-line bg-bg hover:bg-pill" />
            <div style={{ width: `${width * 100}%` }} className="min-w-0 shrink-0">
              <PreviewPane preview={preview} path={sitePath(config, file.summary)} root={config.root} reloadKey={reloadKey} onStart={() => void api.previewStart().catch(() => {})} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
