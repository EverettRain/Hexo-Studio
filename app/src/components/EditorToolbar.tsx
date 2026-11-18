import {
  Blocks,
  Bold,
  Check,
  ChevronDown,
  Code,
  ImagePlus,
  Images,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Loader2,
  SquareCode,
  Strikethrough,
  Table,
  TextQuote,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ImageFormat } from "@/lib/api";
import {
  codeBlock,
  hexoBlock,
  link,
  rule,
  setHeading,
  table,
  toggleInline,
  toggleList,
  toggleQuote,
  type FormatState,
  type InlineMark,
  type ListKind,
  type MdCommand,
} from "@/lib/markdownCommands";
import { cn } from "@/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
/** `⌘B` on a Mac, `Ctrl+B` elsewhere, from CodeMirror's `Mod-b`. */
const keys = (k: string) =>
  k
    .split("-")
    .map((p) => (p === "Mod" ? (isMac ? "⌘" : "Ctrl+") : p === "Shift" ? (isMac ? "⇧" : "Shift+") : p.toUpperCase()))
    .join("");

const HEADINGS = [
  { level: 0, label: "正文", key: "Mod-0" },
  { level: 1, label: "标题 1", key: "Mod-1" },
  { level: 2, label: "标题 2", key: "Mod-2" },
  { level: 3, label: "标题 3", key: "Mod-3" },
  { level: 4, label: "标题 4", key: "Mod-4" },
];

const MARKS: { mark: InlineMark; icon: LucideIcon; label: string; key: string }[] = [
  { mark: "strong", icon: Bold, label: "加粗", key: "Mod-b" },
  { mark: "emphasis", icon: Italic, label: "斜体", key: "Mod-i" },
  { mark: "strike", icon: Strikethrough, label: "删除线", key: "Mod-Shift-x" },
  { mark: "code", icon: Code, label: "行内代码", key: "Mod-e" },
];

const LISTS: { kind: ListKind; icon: LucideIcon; label: string; key: string }[] = [
  { kind: "bullet", icon: List, label: "无序列表", key: "Mod-Shift-8" },
  { kind: "ordered", icon: ListOrdered, label: "有序列表", key: "Mod-Shift-7" },
  { kind: "task", icon: ListTodo, label: "任务列表", key: "Mod-Shift-9" },
];

/** Less frequent blocks: a rule, and the anzhiyu tag plugins this blog's posts use, written the way its posts write them. */
const INSERTS: { label: string; hint: string; cmd: MdCommand }[] = [
  { label: "分割线", hint: "---", cmd: rule },
  { label: "提示 · 信息", hint: "note info", cmd: hexoBlock("{% note info flat %}", "{% endnote %}", "内容") },
  { label: "提示 · 警告", hint: "note warning", cmd: hexoBlock("{% note warning flat %}", "{% endnote %}", "内容") },
  { label: "提示 · 危险", hint: "note danger", cmd: hexoBlock("{% note danger flat %}", "{% endnote %}", "内容") },
  { label: "公告", hint: "note blue", cmd: hexoBlock("{% note blue 'anzhiyufont anzhiyu-icon-bullhorn' flat %}", "{% endnote %}", "内容") },
  { label: "折叠块", hint: "folding", cmd: hexoBlock("{% folding 标题 %}", "{% endfolding %}", "内容") },
  {
    label: "标签页",
    hint: "tabs",
    cmd: hexoBlock("{% tabs 名称 %}\n<!-- tab 标签 1 -->", "<!-- endtab -->\n<!-- tab 标签 2 -->\n内容\n<!-- endtab -->\n{% endtabs %}", "内容"),
  },
];

// Pressing a toolbar control must not take the focus (and the selection's highlight) from the text.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function Tool({ icon: Icon, label, shortcut, active, onClick }: { icon: LucideIcon; label: string; shortcut?: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={shortcut ? `${label}  ${keys(shortcut)}` : label}
      aria-pressed={active}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={cn("flex h-7 w-[26px] shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-pill hover:text-fg active:!scale-100", active && "bg-pill text-fg")}
    >
      <Icon className="h-[15px] w-[15px]" strokeWidth={2.1} />
    </button>
  );
}

const Divider = () => <span className="mx-[3px] h-4 w-px shrink-0 bg-line" />;

/** A button opening a list of choices below it; closes on a choice, a click elsewhere or Escape. */
function Menu({ trigger, title, className, align = "left", children }: { trigger: React.ReactNode; title: string; className?: string; align?: "left" | "right"; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        title={title}
        onMouseDown={keepFocus}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[12.5px] text-fg-2 hover:bg-pill hover:text-fg active:!scale-100", open && "bg-pill text-fg", className)}
      >
        {trigger}
        <ChevronDown className="h-3 w-3 text-muted" />
      </button>
      {open && (
        <div className={cn("absolute top-8 z-30 w-max min-w-[160px] animate-pop-in whitespace-nowrap rounded-lg bg-card p-1 shadow-pop", align === "left" ? "left-0" : "right-0")} onMouseDown={keepFocus}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, hint, checked, onClick }: { label: string; hint?: string; checked?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-pill active:!scale-100">
      {checked !== undefined && <Check className={cn("h-3.5 w-3.5 shrink-0", checked ? "text-fg" : "invisible")} />}
      <span className="flex-1">{label}</span>
      {hint && <span className="pl-3 font-mono text-[11px] text-muted">{hint}</span>}
    </button>
  );
}

interface EditorToolbarProps {
  format: FormatState | null;
  run: (cmd: MdCommand) => void;
  onUpload: () => void;
  onLibrary: () => void;
  imageFormat: ImageFormat;
  onImageFormat: (f: ImageFormat) => void;
  uploading: number;
}

/** Formatting for the post body: each control edits the Markdown text, as typing it would. */
export function EditorToolbar({ format, run, onUpload, onLibrary, imageFormat, onImageFormat, uploading }: EditorToolbarProps) {
  const heading = format?.heading ?? 0;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-y-1 border-b-[0.5px] border-line px-2 py-1">
      <Menu title="段落样式" className="w-[66px] justify-between" trigger={<span>{HEADINGS.find((h) => h.level === heading)?.label ?? `标题 ${heading}`}</span>}>
        {(close) =>
          HEADINGS.map((h) => (
            <MenuItem
              key={h.level}
              label={h.label}
              hint={keys(h.key)}
              checked={h.level === heading}
              onClick={() => {
                close();
                run(setHeading(h.level));
              }}
            />
          ))
        }
      </Menu>
      <Divider />
      {MARKS.map((m) => (
        <Tool key={m.mark} icon={m.icon} label={m.label} shortcut={m.key} active={format?.marks.includes(m.mark)} onClick={() => run(toggleInline(m.mark))} />
      ))}
      <Tool icon={Link} label="链接" shortcut="Mod-k" onClick={() => run(link)} />
      <Divider />
      <Tool icon={TextQuote} label="引用" shortcut="Mod-Shift-." active={format?.quote} onClick={() => run(toggleQuote)} />
      {LISTS.map((l) => (
        <Tool key={l.kind} icon={l.icon} label={l.label} shortcut={l.key} active={format?.list === l.kind} onClick={() => run(toggleList(l.kind))} />
      ))}
      <Divider />
      <Tool icon={SquareCode} label="代码块" onClick={() => run(codeBlock)} />
      <Tool icon={Table} label="表格" onClick={() => run(table)} />
      <Menu title="插入：分割线、主题标签插件（anzhiyu）" align="right" trigger={<Blocks className="h-[15px] w-[15px]" strokeWidth={2.1} />}>
        {(close) =>
          INSERTS.map((p) => (
            <MenuItem
              key={p.label}
              label={p.label}
              hint={p.hint}
              onClick={() => {
                close();
                run(p.cmd);
              }}
            />
          ))
        }
      </Menu>
      <Divider />
      <Tool icon={ImagePlus} label="上传图片（也可以直接粘贴或拖进来）" onClick={onUpload} />
      <Tool icon={Images} label="从图库选图（本文或其他页面的）" onClick={onLibrary} />
      <button
        type="button"
        title="上传格式，点击切换（默认值在设置里改）"
        onMouseDown={keepFocus}
        onClick={() => onImageFormat(imageFormat === "webp" ? "original" : "webp")}
        className="ml-0.5 h-[22px] shrink-0 rounded-[5px] bg-pill px-1.5 text-[11px] font-medium text-fg-2 hover:bg-pill-hover hover:text-fg active:!scale-100"
      >
        {imageFormat === "webp" ? "WebP" : "原图"}
      </button>
      {uploading > 0 && (
        <span className="ml-1.5 flex shrink-0 items-center gap-1 text-[11.5px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          上传中 {uploading}
        </span>
      )}
    </div>
  );
}
