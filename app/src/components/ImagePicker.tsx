import { ImageIcon, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api, errorText, type Library, type LibraryImage } from "@/lib/api";
import { matchesImage, usesPost } from "@/lib/images";
import { cn } from "@/lib/utils";

/** What the chosen image is for: the dialog's title and main button follow it. */
export type PickPurpose = "insert" | "replace" | "cover" | "top_img" | "config";

const PURPOSE: Record<PickPurpose, { title: string; action: string }> = {
  insert: { title: "从图库选图", action: "插入到光标处" },
  replace: { title: "换一张图", action: "换成这张" },
  cover: { title: "选择封面", action: "设为封面" },
  top_img: { title: "选择顶部图", action: "设为顶部图" },
  config: { title: "从图库选图", action: "使用这张" },
};

interface ImagePickerProps {
  open: boolean;
  purpose: PickPurpose;
  onClose: () => void;
  /** The post being edited, e.g. `_posts/x.md`; null outside a post (the whole library). */
  postId: string | null;
  onPick: (img: LibraryImage) => void;
  /** Offered beside inserting: the same picture as the post's cover. */
  onCover?: (img: LibraryImage) => void;
}

/** Choosing an image from the project's library: this post's, or any other page's. */
export function ImagePicker({ open, purpose, onClose, postId, onPick, onCover }: ImagePickerProps) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"post" | "all">("post");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    api.imageLibrary().then(
      (l) => {
        setLibrary(l);
        setError(null);
        if (!postId || !l.images.some((i) => usesPost(i.usedBy, postId))) setScope("all");
      },
      (e) => setError(errorText(e)),
    );
  }, [open, postId]);

  const shown = useMemo(
    () => (library?.images ?? []).filter((i) => (scope === "all" || (!!postId && usesPost(i.usedBy, postId))) && matchesImage(i, query)),
    [library, scope, query, postId],
  );
  const chosen = shown.find((i) => i.id === picked) ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={PURPOSE[purpose].title}
      className="max-w-[820px]"
      footer={
        <>
          <span className="mr-auto self-center truncate text-[12px] text-muted">{chosen ? `${chosen.name} · ${chosen.width}×${chosen.height}` : "选一张图"}</span>
          {purpose === "insert" && onCover && (
            <Button variant="outline" disabled={!chosen} onClick={() => chosen && onCover(chosen)}>
              设为封面
            </Button>
          )}
          <Button disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            {PURPOSE[purpose].action}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          {postId && (
            <div className="flex h-8 items-center rounded-lg bg-pill p-0.5 text-[12.5px]">
              {(["post", "all"] as const).map((s) => (
                <button key={s} onClick={() => setScope(s)} className={cn("h-7 rounded-md px-3 active:!scale-100", scope === s ? "bg-card font-medium shadow-edge dark:bg-white/[.1]" : "text-muted hover:text-fg")}>
                  {s === "post" ? "本文" : "全部"}
                </button>
              ))}
            </div>
          )}
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称、位置描述、uid" className="field pl-8" />
          </div>
        </div>
        {error && <div className="text-[12.5px] text-danger">{error}</div>}
        {library && shown.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-[13px] text-muted">
            <ImageIcon className="h-6 w-6" />
            {scope === "post" ? "这篇文章还没有用图库里的图。" : "没有匹配的图片。"}
          </div>
        )}
        <div className="grid max-h-[52vh] grid-cols-4 gap-2 overflow-y-auto p-0.5">
          {shown.map((img) => (
            <button
              key={img.id}
              onClick={() => setPicked(img.id)}
              onDoubleClick={() => onPick(img)}
              title={`${img.name}\n${img.description}`}
              className={cn("overflow-hidden rounded-lg bg-card-2 text-left shadow-card active:!scale-100", picked === img.id && "ring-2 ring-brand")}
            >
              <img src={img.thumb} alt="" loading="lazy" className="aspect-[4/3] w-full bg-pill object-cover" />
              <div className="truncate px-2 py-1 text-[12px]">{img.name}</div>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
