import { ImageIcon, RefreshCw, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { restyle, type ImageMarkup, type ImageStyle } from "@/lib/imageMarkup";
import type { ImageInfo } from "@/lib/images";
import { useDismiss } from "@/lib/useDismiss";
import { cn } from "@/lib/utils";

const STYLES: { value: "image" | "markdown" | "inline"; label: string; title: string }[] = [
  { value: "image", label: "图片", title: "主题的 {% image %}：可设宽高、图片说明、占位底色" },
  { value: "markdown", label: "Markdown", title: "![](地址 =宽x高)：markdown-it-imsize 设宽高" },
  { value: "inline", label: "行内", title: "主题的 {% inlineimage %}：嵌在一行文字里" },
];

/** Widths this blog's posts use most. */
const WIDTHS = ["400px", "500px", "700px", "100%"];
const INLINE_HEIGHTS = ["20px", "1.5em", "40px"];

function Field({ label, value, onChange, placeholder, presets }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; presets?: string[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[52px] shrink-0 text-[12.5px] text-fg-2">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="field h-7 min-w-0 flex-1 text-[12.5px]" spellCheck={false} />
      {presets && (
        <div className="flex shrink-0 gap-0.5">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(value === p ? "" : p)}
              className={cn("h-6 rounded-sm px-1.5 font-mono text-[11px] active:!scale-100", value === p ? "bg-primary text-primary-fg" : "text-muted hover:bg-pill hover:text-fg")}
            >
              {p.replace("px", "")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ImageStylePopoverProps {
  markup: ImageMarkup;
  info: ImageInfo;
  /** The image's card on screen, to sit next to. */
  anchor: DOMRect;
  onChange: (markup: ImageMarkup) => void;
  onReplace: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/** How one image in the post is written; each change rewrites its markup at once. */
export function ImageStylePopover({ markup, info, anchor, onChange, onReplace, onRemove, onClose }: ImageStylePopoverProps) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, true, onClose);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6 });

  // Below the card, or above it when there is no room; always inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const below = anchor.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below;
    setPos({ left, top });
  }, [anchor]);

  const group = markup.style === "inlineimage" || markup.style === "inlineImg" ? "inline" : markup.style;
  const pick = (g: (typeof STYLES)[number]["value"]) => {
    if (g === group) return;
    const style: ImageStyle = g === "inline" ? "inlineimage" : g;
    onChange(restyle(markup, style));
  };
  const set = (p: Partial<ImageMarkup>) => onChange({ ...markup, ...p });

  return (
    <div ref={box} style={{ left: pos.left, top: pos.top }} className="fixed z-40 w-[360px] animate-pop-in rounded-xl bg-card shadow-pop" role="dialog" aria-label="图片样式">
      <div className="flex items-center gap-3 p-3 pb-2">
        {info.thumb ? <img src={info.thumb} alt="" className="h-12 w-16 shrink-0 rounded-md bg-pill object-cover shadow-edge" /> : <ImageIcon className="h-6 w-6 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{info.name}</div>
          <div className="truncate text-[11.5px] text-muted" title={markup.url}>
            {info.id ? `图片库 · ${info.width}×${info.height}` : "不在图片库（外部图片）"}
          </div>
        </div>
      </div>
      <div className="space-y-2 px-3 pb-3">
        <Segmented value={group} options={STYLES} onChange={pick} className="w-full [&>button]:flex-1" />
        {markup.style === "image" && (
          <>
            <Field label="宽度" value={markup.width} onChange={(width) => set({ width })} placeholder="原始宽度" presets={WIDTHS} />
            <Field label="高度" value={markup.height} onChange={(height) => set({ height })} placeholder="按比例" />
            <Field label="图片说明" value={markup.alt} onChange={(alt) => set({ alt })} placeholder="显示在图片下方" />
            <Field label="占位底色" value={markup.bg} onChange={(bg) => set({ bg })} placeholder="如 #1D0C04，加载前显示" />
          </>
        )}
        {markup.style === "markdown" && (
          <>
            <Field label="宽度" value={markup.width} onChange={(width) => set({ width })} placeholder="原始宽度（像素或 %）" presets={WIDTHS} />
            <Field label="高度" value={markup.height} onChange={(height) => set({ height })} placeholder="按比例" />
            <Field label="替代文字" value={markup.alt} onChange={(alt) => set({ alt })} placeholder="图片加载失败时显示" />
          </>
        )}
        {group === "inline" && <Field label="高度" value={markup.height} onChange={(height) => set({ height })} placeholder="默认与文字同高" presets={INLINE_HEIGHTS} />}
      </div>
      <div className="flex items-center gap-1 border-t-[0.5px] border-line-2 px-2 py-1.5">
        <button type="button" onClick={onReplace} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-2 hover:bg-pill hover:text-fg">
          <RefreshCw className="h-3.5 w-3.5" />
          换一张
        </button>
        <button type="button" onClick={onRemove} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-2 hover:bg-danger-soft hover:text-danger">
          <Trash2 className="h-3.5 w-3.5" />
          移除
        </button>
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="h-7 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-fg hover:bg-primary/85">
          完成
        </button>
      </div>
    </div>
  );
}
