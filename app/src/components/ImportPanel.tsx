import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Check, ChevronDown, Copy, ImagePlus, Loader2, Upload, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type Conversion, type ImageRecord, type InsertStyle, type PreparedImage } from "@/lib/api";
import {
  baseName,
  COPY_STYLES,
  copyText,
  defaultName,
  edgeLabel,
  IMAGE_EXTENSIONS,
  isImagePath,
  MAX_EDGES,
  measure,
  ownFileName,
  saving,
  type CopyStyle,
} from "@/lib/imageImport";
import { cn } from "@/lib/utils";

/** Where uploaded images go besides the library: the post open in the editor. */
export interface InsertTarget {
  postId: string;
  insert: (images: ImageRecord[]) => void;
}

interface ImportApi {
  /** Opens the panel with these images (added to the ones already in it). */
  open: (sources: { blob: Blob; fileName: string | null }[]) => void;
  openPaths: (paths: string[]) => void;
  /** Picks files in a dialog, then opens the panel with them. */
  choose: () => Promise<void>;
  /** The editor sets itself while it is shown. */
  setInsertTarget: (t: InsertTarget | null) => void;
  /** Bumped after every upload, for pages that list the library. */
  libraryVersion: number;
}

const ImportContext = createContext<ImportApi | null>(null);

export function useImport(): ImportApi {
  const ctx = useContext(ImportContext);
  if (!ctx) throw new Error("useImport outside ImportProvider");
  return ctx;
}

type Status = "ready" | "uploading" | "done" | "failed";

interface Item {
  key: number;
  blob: Blob;
  /** For the original's thumbnail and the large view. */
  url: string;
  fileName: string | null;
  name: string;
  description: string;
  /** Its own settings, when set apart from the panel's. */
  own: Conversion | null;
  prepared: PreparedImage | null;
  /** The settings `prepared` was made with. */
  preparedFor: string | null;
  prepareError: string | null;
  status: Status;
  error: string | null;
  result: ImageRecord | null;
  existed: boolean;
}

const sameConversion = (a: Conversion, b: Conversion) => a.format === b.format && a.quality === b.quality && a.maxEdge === b.maxEdge;
const conversionKey = (c: Conversion) => `${c.format}/${c.quality}/${c.maxEdge}`;
const isEditable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/**
 * The import panel and its ways in: images dropped anywhere on the project's window, pasted
 * (⌘V outside a text field, or into the editor), or chosen in a dialog. Each is converted as it
 * would be uploaded so the result can be judged (size, quality) before anything is uploaded.
 */
export function ImportProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const nextKey = useRef(1);
  const target = useRef<InsertTarget | null>(null);
  // Fixed when the panel opens: a panel opened in the editor inserts there.
  const [insertInto, setInsertInto] = useState<InsertTarget | null>(null);

  const add = useCallback((sources: { blob: Blob; fileName: string | null }[]) => {
    if (!sources.length) return;
    const now = new Date();
    setItems((list) => {
      if (!list.length || list.every((i) => i.status === "done")) list.forEach((i) => URL.revokeObjectURL(i.url));
      const kept = list.filter((i) => i.status !== "done");
      return [
        ...kept,
        ...sources.map((s) => ({
          key: nextKey.current++,
          blob: s.blob,
          url: URL.createObjectURL(s.blob),
          fileName: s.fileName,
          name: defaultName(s.fileName, now),
          description: "",
          own: null,
          prepared: null,
          preparedFor: null,
          prepareError: null,
          status: "ready" as Status,
          error: null,
          result: null,
          existed: false,
        })),
      ];
    });
    setOpen((was) => {
      if (!was) setInsertInto(target.current);
      return true;
    });
  }, []);

  const openPaths = useCallback(
    async (paths: string[]) => {
      const images = paths.filter(isImagePath);
      if (!images.length) return;
      const read = await Promise.all(
        images.map((p) =>
          api.readImageFile(p).then(
            (blob) => ({ blob, fileName: baseName(p) }),
            (e) => (toast(errorText(e), "error"), null),
          ),
        ),
      );
      add(read.filter((r): r is { blob: Blob; fileName: string } => r !== null));
    },
    [add, toast],
  );

  const choose = useCallback(async () => {
    const picked = await openDialog({ title: "导入图片", multiple: true, filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }] });
    if (picked) await openPaths(Array.isArray(picked) ? picked : [picked]);
  }, [openPaths]);

  // Files dropped on the window arrive as paths through Tauri, not as DOM drop events.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter") setDropping(p.paths.some(isImagePath));
      else if (p.type === "leave") setDropping(false);
      else if (p.type === "drop") {
        setDropping(false);
        void openPaths(p.paths);
      }
    });
    return () => void un.then((f) => f());
  }, [openPaths]);

  // ⌘V with an image on the clipboard, outside text fields (the editor hands its own over).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || isEditable(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      add(files.map((f) => ({ blob: f, fileName: ownFileName(f.name) })));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [add]);

  const api_ = useMemo<ImportApi>(
    () => ({
      open: add,
      openPaths: (p) => void openPaths(p),
      choose,
      setInsertTarget: (t) => (target.current = t),
      libraryVersion,
    }),
    [add, openPaths, choose, libraryVersion],
  );

  const close = () => {
    setOpen(false);
    setItems((list) => {
      list.forEach((i) => URL.revokeObjectURL(i.url));
      return [];
    });
  };

  return (
    <ImportContext.Provider value={api_}>
      {children}
      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand bg-brand-soft/85 text-[15px] font-medium text-brand">
          松开以导入图片
        </div>
      )}
      <ImportPanel
        open={open}
        items={items}
        setItems={setItems}
        insertInto={insertInto}
        onClose={close}
        onUploaded={() => setLibraryVersion((v) => v + 1)}
        onAddMore={() => void choose()}
      />
    </ImportContext.Provider>
  );
}

interface PanelProps {
  open: boolean;
  items: Item[];
  setItems: React.Dispatch<React.SetStateAction<Item[]>>;
  insertInto: InsertTarget | null;
  onClose: () => void;
  onUploaded: () => void;
  onAddMore: () => void;
}

function ConversionControls({ value, onChange, compact = false }: { value: Conversion; onChange: (c: Conversion) => void; compact?: boolean }) {
  const edges = MAX_EDGES.includes(value.maxEdge) ? MAX_EDGES : [...MAX_EDGES, value.maxEdge].sort((a, b) => a - b);
  return (
    <div className={cn("flex flex-wrap items-center gap-x-5 gap-y-2", compact && "gap-x-4")}>
      <Segmented
        value={value.format}
        onChange={(format) => onChange({ ...value, format })}
        options={[
          { value: "webp", label: "WebP", title: "转成 WebP 上传，体积小" },
          { value: "original", label: "原图", title: "按原文件上传，不压缩" },
        ]}
      />
      <label className={cn("flex items-center gap-2 text-[12.5px] text-fg-2", value.format === "original" && "opacity-40")}>
        质量
        <input
          type="range"
          min={1}
          max={100}
          value={value.quality}
          disabled={value.format === "original"}
          onChange={(e) => onChange({ ...value, quality: Number(e.target.value) })}
          className="w-28 accent-[rgb(var(--brand))]"
        />
        <span className="w-7 text-right font-mono tabular-nums text-fg">{value.quality}</span>
      </label>
      <label className={cn("flex items-center gap-2 text-[12.5px] text-fg-2", value.format === "original" && "opacity-40")}>
        最长边
        <select
          value={value.maxEdge}
          disabled={value.format === "original"}
          onChange={(e) => onChange({ ...value, maxEdge: Number(e.target.value) })}
          className="field h-7 w-auto pr-7 text-[12.5px]"
        >
          {edges.map((e) => (
            <option key={e} value={e}>
              {edgeLabel(e)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ImportPanel({ open, items, setItems, insertInto, onClose, onUploaded, onAddMore }: PanelProps) {
  const toast = useToast();
  const [shared, setShared] = useState<Conversion | null>(null);
  const [defaults, setDefaults] = useState<Conversion | null>(null);
  const [insertStyle, setInsertStyle] = useState<InsertStyle>("image");
  const [ready, setReady] = useState<boolean | null>(null);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState<CopyStyle | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [viewing, setViewing] = useState<{ key: number; side: "output" | "original" } | null>(null);

  // The active profile's settings start the panel each time it opens.
  useEffect(() => {
    if (!open) return;
    setCopied(null);
    api.storageProfiles().then(
      (s) => {
        const p = s.profiles.find((x) => x.id === s.active) ?? s.profiles[0];
        const c: Conversion = p ? { format: p.upload.format, quality: p.upload.quality, maxEdge: p.upload.maxEdge } : { format: "webp", quality: 82, maxEdge: 2560 };
        setDefaults(c);
        setShared((cur) => cur ?? c);
        setInsertStyle(p?.upload.style ?? "image");
        setReady(!!p?.accessKeyId);
      },
      () => setReady(false),
    );
  }, [open]);
  useEffect(() => {
    if (!open) setShared(null);
  }, [open]);

  const conversionOf = useCallback((i: Item) => i.own ?? shared, [shared]);

  // Converts each image with its settings, one at a time (a large photo takes a while), shortly
  // after the settings stop changing; a result made for older settings is dropped.
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => {
    if (!open || !shared) return;
    let stopped = false;
    const timer = window.setTimeout(async () => {
      for (const item of latest.current) {
        if (stopped) return;
        const c = item.own ?? shared;
        const k = conversionKey(c);
        if (item.preparedFor === k || item.status === "done") continue;
        try {
          const prepared = await api.prepareImage(item.blob, item.fileName, c);
          if (!stopped) setItems((list) => list.map((x) => (x.key === item.key ? { ...x, prepared, preparedFor: k, prepareError: null } : x)));
        } catch (e) {
          if (!stopped) setItems((list) => list.map((x) => (x.key === item.key ? { ...x, prepareError: errorText(e), preparedFor: k } : x)));
        }
      }
    }, 250);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [open, shared, items.map((i) => `${i.key}:${i.own ? conversionKey(i.own) : ""}:${i.preparedFor}`).join("|"), setItems]);

  const update = (key: number, patch: Partial<Item>) => setItems((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const remove = (key: number) =>
    setItems((list) => {
      const gone = list.find((x) => x.key === key);
      if (gone) URL.revokeObjectURL(gone.url);
      return list.filter((x) => x.key !== key);
    });

  const pending = items.filter((i) => i.status !== "done");
  const done = items.filter((i) => i.status === "done" && i.result);
  const finished = items.length > 0 && pending.length === 0;

  const copy = async (style: CopyStyle, images = done.map((i) => i.result!)) => {
    try {
      await writeText(copyText(images, style));
      setCopied(style);
    } catch (e) {
      toast(`无法写入剪贴板：${errorText(e)}`, "error");
    }
  };

  const upload = async () => {
    if (!shared || uploading || !pending.length || !ready) return;
    setUploading(true);
    const uploaded: ImageRecord[] = [];
    for (const item of pending) {
      update(item.key, { status: "uploading", error: null });
      try {
        const r = await api.uploadImage(
          item.blob,
          { fileName: item.fileName, name: item.name.trim(), description: item.description.trim(), postId: insertInto?.postId ?? null },
          conversionOf(item)!,
        );
        uploaded.push(r.image);
        update(item.key, { status: "done", result: r.image, existed: r.existed });
      } catch (e) {
        update(item.key, { status: "failed", error: errorText(e) });
      }
    }
    setUploading(false);
    onUploaded();
    if (!uploaded.length) return;
    if (insertInto) {
      insertInto.insert(uploaded);
      if (uploaded.length === pending.length) {
        toast(`已插入 ${uploaded.length} 张图片`);
        onClose();
      }
      return;
    }
    // Ready to paste wherever it is wanted.
    await copy(insertStyle, uploaded);
  };

  // Enter uploads, as the main button does (not in a text area, not while composing).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
      if (finished || viewing) return;
      e.preventDefault();
      void upload();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Escape closes the large view first, before it reaches the dialog.
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setViewing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [viewing]);

  const viewed = viewing ? items.find((i) => i.key === viewing.key) : null;
  const viewedPrepared = viewed?.prepared ?? null;
  const totalBefore = pending.reduce((n, i) => n + (i.prepared?.original.bytes ?? i.blob.size), 0);
  const totalAfter = pending.reduce((n, i) => n + (i.prepared?.output.bytes ?? 0), 0);
  // Until the profile's settings are read, nothing is converted yet.
  const allPrepared = !!shared && pending.every((i) => i.prepared && i.preparedFor === conversionKey(i.own ?? shared));
  const changedDefaults = shared && defaults && shared.format === "webp" && (shared.quality !== defaults.quality || shared.maxEdge !== defaults.maxEdge);

  return (
    <Dialog
      open={open}
      onClose={() => !uploading && onClose()}
      title={finished ? "已导入" : insertInto ? "导入图片并插入文章" : "导入图片"}
      description={finished ? undefined : "转换结果先在这里看：体积、尺寸、清晰度都合适再上传。"}
      className="max-w-[880px]"
      footer={
        finished ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <>
            <span className="mr-auto self-center text-[12px] text-muted">
              {pending.length} 张
              {totalAfter > 0 && allPrepared && (
                <>
                  {" · "}
                  {measure({ width: 0, height: 0, bytes: totalBefore })} → {measure({ width: 0, height: 0, bytes: totalAfter })}
                  <span className={cn("ml-1", totalAfter > totalBefore ? "text-warn" : "text-ok")}>{saving(totalBefore, totalAfter)}</span>
                </>
              )}
            </span>
            <Button variant="ghost" disabled={uploading} onClick={onAddMore}>
              <ImagePlus />
              再加几张
            </Button>
            <Button variant="outline" disabled={uploading} onClick={onClose}>
              取消
            </Button>
            <Button disabled={uploading || !ready || !pending.length} onClick={() => void upload()} title="回车">
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
              {uploading ? "上传中…" : insertInto ? `上传并插入${pending.length > 1 ? ` ${pending.length} 张` : ""}` : `上传${pending.length > 1 ? ` ${pending.length} 张` : ""}`}
            </Button>
          </>
        )
      }
    >
      {finished ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[13px]">
            {copied ? (
              <span className="flex items-center gap-1.5 text-ok">
                <Check className="h-4 w-4" />
                已复制 {COPY_STYLES.find((s) => s.value === copied)!.label} 写法到剪贴板，可以直接粘贴
              </span>
            ) : (
              <span className="text-fg-2">选一种写法复制：</span>
            )}
            <span className="flex-1" />
            {COPY_STYLES.map((s) => (
              <Button key={s.value} size="sm" variant={copied === s.value ? "default" : "outline"} onClick={() => void copy(s.value)}>
                <Copy />
                {s.label}
              </Button>
            ))}
          </div>
          <div className="space-y-1.5">
            {done.map((i) => (
              <div key={i.key} className="flex items-center gap-3 rounded-lg bg-card-2 px-3 py-2 shadow-card">
                <img src={i.url} alt="" className="h-10 w-14 shrink-0 rounded-md bg-pill object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {i.result!.name}
                    {i.existed && <span className="ml-2 rounded bg-pill px-1.5 text-[11px] font-normal text-muted">图库已有，未重复上传</span>}
                  </div>
                  <div className="selectable truncate font-mono text-[11.5px] text-muted">{i.result!.url}</div>
                </div>
                <Button size="sm" variant="ghost" title="复制这张的链接" onClick={() => void copy("url", [i.result!])}>
                  <Copy />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {ready === false && (
            <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] leading-5 text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              还没有可用的图片存储配置：在“图片”页新建一套并填好 AccessKey 后才能上传。这里仍可以先看转换效果。
            </div>
          )}
          {shared && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card-2 px-4 py-3 shadow-card">
              <ConversionControls value={shared} onChange={setShared} />
              {changedDefaults && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  title="写进当前存储配置，以后导入和编辑器上传都用它"
                  onClick={() =>
                    void api.setUploadEncoding(shared.quality, shared.maxEdge).then(
                      () => (setDefaults({ ...defaults!, quality: shared.quality, maxEdge: shared.maxEdge }), toast("已设为当前存储配置的默认值")),
                      (e) => toast(errorText(e), "error"),
                    )
                  }
                >
                  设为默认
                </Button>
              )}
            </div>
          )}
          <div className="space-y-2">
            {pending.map((item) => {
              const c = conversionOf(item);
              const p = item.prepared;
              const fresh = c && item.preparedFor === conversionKey(c);
              return (
                <div key={item.key} className="rounded-xl bg-card-2 p-3 shadow-card">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      title="看大图"
                      onClick={() => setViewing({ key: item.key, side: p?.preview ? "output" : "original" })}
                      className="relative h-[84px] w-[112px] shrink-0 overflow-hidden rounded-lg bg-pill active:!scale-100"
                    >
                      <img src={p?.preview ? `data:image/webp;base64,${p.preview}` : item.url} alt="" className="h-full w-full object-cover" />
                      {!fresh && !item.prepareError && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                          <Loader2 className="h-5 w-5 animate-spin text-white" />
                        </span>
                      )}
                    </button>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex gap-2">
                        <input
                          value={item.name}
                          onChange={(e) => update(item.key, { name: e.target.value })}
                          placeholder={defaultName(item.fileName, new Date())}
                          aria-label="名称"
                          className="field h-8 flex-1 font-medium"
                        />
                        <input
                          value={item.description}
                          onChange={(e) => update(item.key, { description: e.target.value })}
                          placeholder={insertInto ? "位置描述（默认“<文章标题> 内图”）" : "位置描述（可选）"}
                          aria-label="位置描述"
                          className="field h-8 flex-1"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                        {item.prepareError ? (
                          <span className="text-danger">无法转换：{item.prepareError}</span>
                        ) : p ? (
                          <>
                            <span>原图 {measure(p.original)}</span>
                            <span>→</span>
                            <span className={cn(fresh && "text-fg-2")}>
                              {p.format === "webp" ? "WebP" : "原图"} {measure(p.output)}
                            </span>
                            {p.format === "webp" && (
                              <span className={cn("font-medium", p.output.bytes > p.original.bytes ? "text-warn" : "text-ok")}>{saving(p.original.bytes, p.output.bytes)}</span>
                            )}
                            {p.format === "webp" && p.output.bytes > p.original.bytes && <span className="text-warn">比原图还大，可以降低质量或改用原图</span>}
                            {p.existing && <span className="rounded bg-brand-soft px-1.5 text-brand">图库已有：{p.existing.name}，不会重复上传</span>}
                          </>
                        ) : (
                          <span>正在转换…</span>
                        )}
                        {item.status === "uploading" && (
                          <span className="flex items-center gap-1 text-fg-2">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            上传中
                          </span>
                        )}
                        {item.status === "failed" && <span className="text-danger">上传失败：{item.error}</span>}
                        <span className="flex-1" />
                        <button
                          type="button"
                          onClick={() => setExpanded((k) => (k === item.key ? null : item.key))}
                          className={cn("flex items-center gap-0.5 rounded px-1.5 hover:bg-pill hover:text-fg", item.own && "text-brand")}
                        >
                          {item.own ? "单独设置中" : "单独设置"}
                          <ChevronDown className={cn("h-3 w-3 transition-transform", expanded === item.key && "rotate-180")} />
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="不导入这张"
                      title="不导入这张"
                      disabled={uploading}
                      onClick={() => remove(item.key)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-pill hover:text-danger"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {expanded === item.key && shared && (
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t-[0.5px] border-line-2 pt-3">
                      <ConversionControls value={item.own ?? shared} onChange={(own) => update(item.key, { own: sameConversion(own, shared) ? null : own })} compact />
                      {item.own && (
                        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => update(item.key, { own: null })}>
                          跟随统一设置
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {pending.length === 0 && <div className="py-8 text-center text-[13px] text-muted">没有要导入的图片</div>}
          </div>
        </div>
      )}

      {viewed && viewing && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/80 p-6" onClick={() => setViewing(null)}>
          <div className="mb-3 flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
            {viewedPrepared?.preview && (
              <div className="flex rounded-lg bg-white/10 p-0.5 text-[12.5px] text-white">
                {(["output", "original"] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    onClick={() => setViewing({ key: viewed.key, side })}
                    className={cn("h-7 rounded-md px-3 active:!scale-100", viewing.side === side ? "bg-white font-medium text-black" : "hover:bg-white/10")}
                  >
                    {side === "output" ? `压缩后 · ${measure(viewedPrepared.output)}` : `原图 · ${measure(viewedPrepared.original)}`}
                  </button>
                ))}
              </div>
            )}
            <button type="button" aria-label="关闭" onClick={() => setViewing(null)} className="flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10">
              <X className="h-4 w-4" />
            </button>
          </div>
          <img
            src={viewing.side === "output" && viewed.prepared?.preview ? `data:image/webp;base64,${viewed.prepared.preview}` : viewed.url}
            alt=""
            className="min-h-0 flex-1 object-contain"
          />
        </div>
      )}
    </Dialog>
  );
}
