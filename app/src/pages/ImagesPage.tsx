import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Download, FileUp, FolderSearch, ImagePlus, Inbox, Loader2, Plus, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdoptionDialog } from "@/components/AdoptionDialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { api, errorText, onEvent, type ImageFormat, type Library, type LibraryImage, type Mirror } from "@/lib/api";
import { matchesImage, sizeText, thumbUrl } from "@/lib/images";
import { usePageActive } from "@/lib/pageActive";
import { cn } from "@/lib/utils";

type Filter = "all" | "unused" | "problem";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg"];

const hasProblem = (i: LibraryImage) => i.ok === false || i.check?.ok === false;

function StatusDot({ img }: { img: LibraryImage }) {
  const bad = hasProblem(img);
  const good = !bad && (img.check?.ok || img.ok === true);
  const title = img.check && !img.check.ok ? img.check.message : img.ok === false ? "手工标记为不正常" : good ? "正常" : "还没有检查";
  return <span title={title} className={cn("h-2 w-2 shrink-0 rounded-full", bad ? "bg-danger" : good ? "bg-ok" : "bg-faint")} />;
}

/** The hand-kept fields of one image, edited in the side panel. */
function Details({ img, library, onSaved, onDeleted, onOpenPost }: { img: LibraryImage; library: Library; onSaved: () => void; onDeleted: () => void; onOpenPost: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(img.name);
  const [description, setDescription] = useState(img.description);
  const [ok, setOk] = useState<boolean | null>(img.ok);
  const [mirrors, setMirrors] = useState<Mirror[]>(img.mirrors);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = name !== img.name || description !== img.description || ok !== img.ok || JSON.stringify(mirrors) !== JSON.stringify(img.mirrors);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateImage(img.id, { name, description, ok, mirrors });
      onSaved();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteImage(img.id);
      setConfirmDelete(false);
      toast(`已删除 ${img.name}（本机原图保留）`);
      onDeleted();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast("已复制"));
  const setMirror = (i: number, patch: Partial<Mirror>) => setMirrors((m) => m.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const postId = (file: string) => file.replace(/^[^/]+\//, "");
  const isPost = (file: string) => /^[^/]+\/_(posts|drafts)\//.test(file);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <a href={img.url} target="_blank" rel="noreferrer" onClick={(e) => (e.preventDefault(), void api.openUrl(img.url).catch(() => {}))} className="block overflow-hidden rounded-lg bg-pill shadow-card">
          <img src={thumbUrl(img.url, library.thumbQuery)} alt="" className="max-h-56 w-full object-contain" />
        </a>
        <div className="space-y-1">
          <Label>图片名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>图片位置描述</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="min-h-0 font-sans text-[13px]" />
        </div>
        <div className="flex items-center gap-2">
          <Label className="shrink-0">是否正常</Label>
          <Select value={ok === null ? "" : String(ok)} onChange={(e) => setOk(e.target.value === "" ? null : e.target.value === "true")} className="w-32">
            <option value="">未标记</option>
            <option value="true">正常</option>
            <option value="false">不正常</option>
          </Select>
          {img.check && <span className={cn("truncate text-[11.5px]", img.check.ok ? "text-ok" : "text-danger")}>{img.check.ok ? "自动检查通过" : img.check.message}</span>}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>备用图床</Label>
            <button onClick={() => setMirrors((m) => [...m, { label: "", url: "", date: "" }])} className="flex items-center gap-0.5 text-[12px] text-muted hover:text-fg">
              <Plus className="h-3 w-3" />
              添加
            </button>
          </div>
          {mirrors.map((m, i) => (
            <div key={i} className="space-y-1 rounded-md bg-card-2 p-1.5 shadow-card">
              <div className="flex gap-1">
                <Input value={m.label} onChange={(e) => setMirror(i, { label: e.target.value })} placeholder="图床名称" className="h-7 text-[12px]" />
                <Input value={m.date} onChange={(e) => setMirror(i, { date: e.target.value })} placeholder="日期" className="h-7 w-28 text-[12px]" />
                <button title="移除" onClick={() => setMirrors((x) => x.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-fg">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <Input value={m.url} onChange={(e) => setMirror(i, { url: e.target.value })} placeholder="https://" className="h-7 font-mono text-[11.5px]" />
            </div>
          ))}
        </div>

        <div className="space-y-1 rounded-lg bg-card-2 px-3 py-2 text-[12px] leading-5 text-fg-2 shadow-card">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={img.url}>
              {img.url}
            </span>
            <button title="复制地址" onClick={() => copy(img.url)} className="text-muted hover:text-fg">
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          <div>
            uid <span className="selectable font-mono">{img.id}</span> · 上传 {img.uploadedAt || "—"}
          </div>
          <div>
            {img.format === "webp" ? "WebP" : "原图"} · {img.width}×{img.height} · {sizeText(img.bytes)}
          </div>
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate">
              原图 {img.original.fileName} · {sizeText(img.original.bytes)}
            </span>
            {img.backupPath ? (
              <button title="在 Finder 中显示本机原图" onClick={() => void api.revealPath(img.backupPath!)} className="text-muted hover:text-fg">
                <FolderSearch className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="text-[11px] text-warn">本机没有</span>
            )}
          </div>
          {img.legacyUrls.length > 0 && (
            <div className="truncate text-[11px] text-muted" title={img.legacyUrls.join("\n")}>
              旧地址 {img.legacyUrls.map((u) => u.split("/").pop()).join("，")}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label>被这些页面使用（{img.usedBy.length}）</Label>
          {img.usedBy.length === 0 && <div className="text-[12px] text-muted">没有页面使用这张图。</div>}
          {img.usedBy.map((f) =>
            isPost(f) ? (
              <button key={f} onClick={() => onOpenPost(postId(f))} className="block w-full truncate rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-pill" title={f}>
                {library.titles[f] ?? f}
              </button>
            ) : (
              <div key={f} className="truncate px-2 py-1 text-[12.5px] text-fg-2" title={f}>
                {library.titles[f] ?? f}
              </div>
            ),
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t-[0.5px] border-line-2 px-4 py-2.5">
        <Button variant="ghost" size="sm" disabled={busy || img.usedBy.length > 0} title={img.usedBy.length ? "还有页面在用，不能删除" : "删除存储上的对象和图库记录"} onClick={() => setConfirmDelete(true)}>
          <Trash2 />
          删除
        </Button>
        <span className="flex-1" />
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          保存
        </Button>
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`删除「${img.name}」？`}
        description="从存储上删除这个对象，并从图片库移除；本机的原图保留。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              删除
            </Button>
          </>
        }
      />
    </div>
  );
}

interface ImagesPageProps {
  onOpenSettings: () => void;
  onOpenPost: (id: string) => void;
}

/** The project's image library: every image, where it is used, its hand-kept fields. */
export function ImagesPage({ onOpenSettings, onOpenPost }: ImagesPageProps) {
  const toast = useToast();
  const active = usePageActive();
  const [library, setLibrary] = useState<Library | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [checking, setChecking] = useState<[number, number] | null>(null);
  const [uploading, setUploading] = useState(0);
  const [adopting, setAdopting] = useState(false);
  const [format, setFormat] = useState<ImageFormat>("webp");
  const [storageReady, setStorageReady] = useState<boolean | null>(null);

  const load = useCallback(() => {
    api.imageLibrary().then(setLibrary, (e) => toast(errorText(e), "error"));
  }, [toast]);
  useEffect(() => {
    if (active && storageReady) load();
  }, [active, storageReady, load]);
  // Read again whenever the page is shown: the store may have been set up in settings meanwhile.
  useEffect(() => {
    if (!active) return;
    api.imageSettings().then(
      (s) => {
        setFormat(s.upload.format);
        setStorageReady(!!s.storage && !!s.accessKeyId);
      },
      () => setStorageReady(false),
    );
  }, [active]);

  const images = library?.images ?? [];
  const counts = { all: images.length, unused: images.filter((i) => !i.usedBy.length).length, problem: images.filter(hasProblem).length };
  const shown = useMemo(
    () => images.filter((i) => (filter === "all" || (filter === "unused" ? !i.usedBy.length : hasProblem(i))) && matchesImage(i, query)),
    [images, filter, query],
  );
  const current = images.find((i) => i.id === selected) ?? null;

  const upload = async () => {
    const picked = await openDialog({ title: "添加图片到图库", multiple: true, filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }] });
    const paths = picked ? (Array.isArray(picked) ? picked : [picked]) : [];
    if (!paths.length) return;
    setUploading(paths.length);
    for (const p of paths) {
      try {
        const r = await api.uploadImageFile(null, p, format);
        toast(r.existed ? `图库里已有这张图：${r.image.name}` : `已入库 ${r.image.name}`);
        setSelected(r.image.id);
      } catch (e) {
        toast(`${p.split("/").pop()} 入库失败：${errorText(e)}`, "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
    load();
  };

  const check = async () => {
    setChecking([0, images.length]);
    const off = onEvent<[number, number]>("image-check-progress", (p) => setChecking(p));
    try {
      const results = await api.checkImages();
      const bad = Object.values(results).filter((c) => !c.ok).length;
      toast(bad ? `${bad} 张图有问题` : "全部正常", bad ? "error" : "success");
      load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      off();
      setChecking(null);
    }
  };

  const importChecklist = async () => {
    const path = await openDialog({ title: "导入图片核对清单", multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof path !== "string") return;
    try {
      const r = await api.importChecklist(path);
      toast(`已更新 ${r.updated} 张图${r.unmatched.length ? `；${r.unmatched.length} 行不在图库里（可用“接管旧图”带入）` : ""}`);
      load();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const exportChecklist = async () => {
    const path = await saveDialog({ title: "导出图片核对清单", defaultPath: "图片核对清单.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await api.exportChecklist(path);
      toast("已导出");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  if (storageReady === null) return null;
  if (!storageReady) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-fg-2">
        <ImagePlus className="h-7 w-7 text-muted" />
        先在设置里配置图片存储（阿里云 OSS 或 S3 兼容），图片库才能上传和检查图片。
        <Button onClick={onOpenSettings}>去设置</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-5 pb-3 pt-1">
          <div className="relative min-w-[110px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称、位置描述、uid" className="field pl-8" />
          </div>
          <div className="flex h-8 items-center rounded-lg bg-pill p-0.5 text-[12.5px]">
            {(
              [
                ["all", "全部"],
                ["unused", "未使用"],
                ["problem", "有问题"],
              ] as const
            ).map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f)} className={cn("h-7 rounded-md px-2.5 active:!scale-100", filter === f ? "bg-card font-medium shadow-edge dark:bg-white/[.1]" : "text-muted hover:text-fg")}>
                {label} {counts[f]}
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={() => void check()} disabled={checking !== null || !images.length} title="确认存储里有对象、公开地址能访问">
            {checking ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            {checking ? `检查 ${checking[0]}/${checking[1]}` : "检查"}
          </Button>
          <Button variant="outline" onClick={() => setAdopting(true)} title="把存储里还不在图库的旧图接管进来">
            <Inbox />
            接管旧图{library && library.unadopted > 0 ? ` ${library.unadopted}` : ""}
          </Button>
          <Button variant="ghost" size="icon" title="导入图片核对清单（CSV）" onClick={() => void importChecklist()}>
            <FileUp />
          </Button>
          <Button variant="ghost" size="icon" title="导出图片核对清单（CSV）" onClick={() => void exportChecklist()}>
            <Download />
          </Button>
          <Button onClick={() => void upload()} disabled={uploading > 0}>
            <ImagePlus />
            {uploading ? `入库中 ${uploading}` : "添加图片"}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          {library === null ? (
            <div className="py-10 text-center text-[13px] text-muted">读取中…</div>
          ) : shown.length === 0 ? (
            <div className="py-12 text-center text-[13px] leading-6 text-muted">
              {images.length === 0 ? (
                <>
                  图库还是空的。
                  <br />
                  博客里已有的图可以用“接管旧图”一次带进来；新图在文章里粘贴、拖入，或点“添加图片”。
                </>
              ) : (
                "没有符合条件的图片。"
              )}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {shown.map((img) => (
                <button
                  key={img.id}
                  onClick={() => setSelected(img.id)}
                  className={cn("overflow-hidden rounded-xl bg-card text-left shadow-card active:!scale-100", selected === img.id && "ring-2 ring-brand")}
                >
                  <img src={thumbUrl(img.url, library.thumbQuery)} alt="" loading="lazy" className="aspect-[4/3] w-full bg-pill object-cover" />
                  <div className="space-y-0.5 px-2.5 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <StatusDot img={img} />
                      <span className="truncate text-[12.5px] font-medium">{img.name}</span>
                    </div>
                    <div className="truncate text-[11px] text-muted">{img.usedBy.length ? `${img.usedBy.length} 处使用` : "未使用"} · {sizeText(img.bytes)}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {current && library && (
        <aside className="flex w-[340px] shrink-0 flex-col border-l-[0.5px] border-line bg-card">
          <div className="flex h-9 shrink-0 items-center justify-between border-b-[0.5px] border-line-2 pl-4 pr-2 text-[12.5px] font-medium">
            图片详情
            <button title="关闭" onClick={() => setSelected(null)} className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-pill hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <Details key={current.id + current.name + current.description + String(current.ok)} img={current} library={library} onSaved={load} onDeleted={() => (setSelected(null), load())} onOpenPost={onOpenPost} />
        </aside>
      )}
      <AdoptionDialog
        open={adopting}
        onClose={(changed) => {
          setAdopting(false);
          if (changed) load();
        }}
      />
    </div>
  );
}
