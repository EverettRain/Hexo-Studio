import { ChevronRight, EyeOff, ImageIcon, Images, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { blankLike, joinLink, merge, pathKey, sameValue, splitLink, type Path } from "@/lib/configYaml";
import { describeImage, type ImageIndex } from "@/lib/images";
import { looksLikeImage } from "@/lib/themeGroups";
import { cn } from "@/lib/utils";

export interface FieldContext {
  hints: Map<string, string>;
  /** The theme's defaults, when editing the theme's overrides; undefined otherwise. */
  defaults?: unknown;
  /** Paths shown without their value and never edited. */
  hidden: Set<string>;
  /** Paths that change post addresses, flagged as such. */
  addressKeys: Set<string>;
  /** Paths a panel above already edits; not listed again. */
  skip: Set<string>;
  /** Library images by address, for thumbnails and names. */
  images: ImageIndex;
  /** Opens the image library; the chosen image's address goes to `path`. */
  pickImage: (path: Path) => void;
  set: (path: Path, value: unknown) => void;
  /** Several values in one save. */
  setMany: (changes: [Path, unknown][]) => void;
  append: (path: Path, value: unknown) => void;
  remove: (path: Path, index: number) => void;
  renameKey: (path: Path, name: string) => void;
  removeKey: (path: Path) => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
const at = (v: unknown, k: string | number): unknown => (v !== null && typeof v === "object" ? (v as Record<string | number, unknown>)[k] : undefined);
const fieldClass = "h-7 w-full rounded-md bg-pill px-2 text-[13px] outline-none placeholder:text-faint hover:bg-pill-hover focus:bg-card focus:shadow-[inset_0_0_0_1px_rgb(var(--brand))]";

function display(v: unknown): string {
  if (v === null || v === undefined) return "空";
  if (typeof v === "string") return v === "" ? "空字符串" : v;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Text that is committed on blur or Enter (⌘Enter in a long text), and reverted by Escape. */
function TextValue({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  const long = value.length > 60 || value.includes("\n") || draft.includes("\n");
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft, long]);
  const commit = () => draft !== value && onCommit(draft);
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      setDraft(value);
      e.currentTarget.blur();
    } else if (e.key === "Enter" && (!long || e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  return long ? (
    <textarea ref={area} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={keys} placeholder={placeholder} className={cn(fieldClass, "selectable block h-auto resize-none py-1 font-mono text-[12px] leading-5")} />
  ) : (
    <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={keys} placeholder={placeholder} className={fieldClass} />
  );
}

function NumberValue({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const valid = draft.trim() !== "" && Number.isFinite(Number(draft));
  return (
    <input
      value={draft}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (valid ? Number(draft) !== value && onCommit(Number(draft)) : setDraft(String(value)))}
      onKeyDown={(e) => (e.key === "Enter" ? e.currentTarget.blur() : e.key === "Escape" && (setDraft(String(value)), e.currentTarget.blur()))}
      className={cn(fieldClass, "w-32 font-mono tabular-nums", !valid && "shadow-[inset_0_0_0_1px_rgb(var(--danger))]")}
    />
  );
}

/** anzhiyu's `link || icon` value as two boxes; an empty icon writes the link alone. */
function LinkValue({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const { link, icon } = splitLink(value) ?? { link: value, icon: "" };
  return (
    <div className="flex gap-1.5">
      <div className="min-w-0 flex-1">
        <TextValue value={link} placeholder="链接，如 /archives/" onCommit={(v) => onCommit(joinLink(v, icon))} />
      </div>
      <div className="w-[42%] shrink-0 font-mono">
        <TextValue value={icon} placeholder="图标，如 anzhiyu-icon-github" onCommit={(v) => onCommit(joinLink(link, v))} />
      </div>
    </div>
  );
}

/** An image address: its picture and library name beside the address, and the library to pick from. */
function ImageValue({ path, value, ctx }: { path: Path; value: string; ctx: FieldContext }) {
  const info = value ? describeImage(ctx.images, value) : null;
  const loadable = /^https?:\/\//.test(value);
  return (
    <div className="flex items-start gap-2">
      <button type="button" title="从图库选图" onClick={() => ctx.pickImage(path)} className="shrink-0 active:!scale-100">
        {loadable ? (
          <img src={info!.thumb} alt="" className="h-[46px] w-[70px] rounded-sm bg-pill object-cover shadow-edge" />
        ) : (
          <span className="flex h-[46px] w-[70px] items-center justify-center rounded-sm bg-pill text-faint">
            <ImageIcon className="h-4 w-4" />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1 space-y-0.5">
        <TextValue value={value} placeholder="图片地址" onCommit={(v) => ctx.set(path, v === "" ? null : v)} />
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className="min-w-0 truncate">{!value ? "未设置" : info?.id ? `图片库：${info.name}` : loadable ? "不在图片库" : "站内路径，无法预览"}</span>
          <button type="button" onClick={() => ctx.pickImage(path)} className="flex shrink-0 items-center gap-1 rounded px-1 hover:bg-pill hover:text-fg">
            <Images className="h-3 w-3" />
            图库
          </button>
        </div>
      </div>
    </div>
  );
}

/** The control for one plain value, by its type; an empty value is edited as text. */
function Scalar({ path, value, ctx }: { path: Path; value: unknown; ctx: FieldContext }) {
  if (typeof value === "boolean") return <Switch checked={value} onChange={(on) => ctx.set(path, on)} label={String(path[path.length - 1])} />;
  if (typeof value === "number") return <NumberValue value={value} onCommit={(v) => ctx.set(path, v)} />;
  if (typeof value === "string" && splitLink(value)) return <LinkValue value={value} onCommit={(v) => ctx.set(path, v)} />;
  const inLibrary = typeof value === "string" && !!value && !!describeImage(ctx.images, value).id;
  if (looksLikeImage(path[path.length - 1], value, inLibrary)) return <ImageValue path={path} value={typeof value === "string" ? value : ""} ctx={ctx} />;
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  // An emptied value goes back to `key:` when it was empty, and stays an empty string when it was one.
  return <TextValue value={text} placeholder={value === null || value === undefined ? "空" : undefined} onCommit={(v) => ctx.set(path, v === "" && (value === null || value === undefined) ? null : v)} />;
}

/** What a list item is called: its name, title or date, the keys anzhiyu's lists use. */
export function itemTitle(item: unknown): string | null {
  if (!isObject(item)) return null;
  for (const k of ["class_name", "name", "title", "date", "label", "address"]) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function Label({ path, hint, changed, onlyDefault, address, summary }: { path: Path; hint?: string; changed: boolean; onlyDefault: boolean; address: boolean; summary?: string | null }) {
  const key = path[path.length - 1];
  return (
    <div className="min-w-0 pt-[5px]">
      <div className="flex items-center gap-1.5">
        <span className={cn("selectable truncate font-mono text-[12.5px]", onlyDefault ? "text-muted" : "text-fg")}>{typeof key === "number" ? `#${key + 1}` : key}</span>
        {summary && <span className="selectable min-w-0 truncate text-[12.5px] text-fg-2">{summary}</span>}
        {changed && <span title="与主题默认值不同" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
        {onlyDefault && <span className="shrink-0 rounded bg-pill px-1 text-[10.5px] text-muted">主题默认</span>}
        {address && (
          <span title="改了会改变文章地址，已发布文章的链接会失效" className="flex shrink-0 items-center gap-0.5 rounded bg-warn-soft px-1 text-[10.5px] text-warn">
            <TriangleAlert className="h-3 w-3" />
            影响文章地址
          </span>
        )}
      </div>
      {hint && (
        <div title={hint} className="line-clamp-2 text-[11.5px] leading-4 text-muted">
          {hint}
        </div>
      )}
    </div>
  );
}

/** One key or list item: a row for plain values, a nested block for maps and lists. */
export function Field({ path, value, def, ctx, inDefaultsOnly = false }: { path: Path; value: unknown; def: unknown; ctx: FieldContext; inDefaultsOnly?: boolean }) {
  const key = pathKey(path);
  const theme = ctx.defaults !== undefined;
  const onlyDefault = inDefaultsOnly || (theme && value === undefined && def !== undefined);
  const shown = onlyDefault ? def : value;
  const changed = theme && !onlyDefault && def !== undefined && !sameValue(value, def);
  const summary = typeof path[path.length - 1] === "number" ? itemTitle(shown) : null;
  const label = <Label path={path} hint={ctx.hints.get(key)} changed={changed} onlyDefault={onlyDefault} address={ctx.addressKeys.has(key)} summary={summary} />;

  if (ctx.skip.has(key)) return null;
  if (ctx.hidden.has(key)) {
    return (
      <Row label={label}>
        <span className="flex h-7 items-center gap-1.5 text-[12.5px] text-muted">
          <EyeOff className="h-3.5 w-3.5" />
          已隐藏（敏感信息，不在这里显示和修改）
        </span>
      </Row>
    );
  }
  if (isObject(shown) && !onlyDefault && linkMap(shown)) return <LinkMapField path={path} value={shown} def={def} ctx={ctx} label={label} />;
  if (isObject(shown) && !onlyDefault && menuMap(shown)) return <MenuField path={path} value={shown} def={def} ctx={ctx} label={label} />;
  if (isObject(shown)) return <MapField path={path} value={isObject(value) ? value : undefined} def={def} ctx={ctx} label={label} />;
  if (Array.isArray(shown)) return <ListField path={path} value={Array.isArray(value) ? value : []} def={def} ctx={ctx} label={label} />;
  return (
    <Row
      label={label}
      action={
        changed && !isObject(def) && !Array.isArray(def) ? (
          <button type="button" title={`恢复主题默认：${display(def)}`} onClick={() => ctx.set(path, def)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-pill hover:text-fg">
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null
      }
    >
      <Scalar path={path} value={shown} ctx={ctx} />
    </Row>
  );
}

function Row({ label, children, action }: { label: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(150px,230px)_minmax(0,1fr)_28px] items-start gap-4 py-2">
      {label}
      <div className="min-w-0 py-[1px]">{children}</div>
      <div>{action}</div>
    </div>
  );
}

function Nested({ label, count, children, open, onToggle }: { label: React.ReactNode; count: string; children: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <div className="py-1">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-1 rounded-md text-left hover:bg-pill/60 active:!scale-100">
        <ChevronRight className={cn("mt-[7px] h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">{label}</div>
        <span className="shrink-0 pr-2 pt-[5px] text-[11.5px] text-muted">{count}</span>
      </button>
      {open && <div className="ml-[7px] border-l-[0.5px] border-line pl-4">{children}</div>}
    </div>
  );
}

function MapField({ path, value, def, ctx, label }: { path: Path; value?: Record<string, unknown>; def: unknown; ctx: FieldContext; label: React.ReactNode }) {
  const [open, setOpen] = useState(path.length <= 1);
  const own = Object.keys(value ?? {});
  const extra = isObject(def) ? Object.keys(def).filter((k) => !own.includes(k)) : [];
  const body = (
    <>
      {own.map((k) => (
        <Field key={k} path={[...path, k]} value={value![k]} def={at(def, k)} ctx={ctx} />
      ))}
      {extra.map((k) => (
        <Field key={k} path={[...path, k]} value={undefined} def={at(def, k)} ctx={ctx} inDefaultsOnly />
      ))}
    </>
  );
  // A section's own keys are listed straight away; deeper maps fold.
  if (path.length === 1) return <div>{body}</div>;
  return (
    <Nested label={label} count={`${own.length + extra.length} 项`} open={open} onToggle={() => setOpen((o) => !o)}>
      {body}
    </Nested>
  );
}

function ListField({ path, value, def, ctx, label }: { path: Path; value: unknown[]; def: unknown; ctx: FieldContext; label: React.ReactNode }) {
  const [open, setOpen] = useState(path.length <= 1 || value.length <= 6);
  const objects = value.some(isObject) || (value.length === 0 && Array.isArray(def) && def.some(isObject));
  // Hexo merges a list with the defaults' one by position and never drops an item the defaults
  // have, so what the site gets can differ from what this file says: then it is shown.
  const merged = Array.isArray(def) ? (merge(def, value) as unknown[]) : value;
  const differs = !sameValue(merged, value);
  const like = value[value.length - 1] ?? (Array.isArray(def) ? def[def.length - 1] : undefined);

  const body = (
    <div className="space-y-1 py-1">
      {value.map((item, i) =>
        isObject(item) || Array.isArray(item) ? (
          <div key={i} className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <Field path={[...path, i]} value={item} def={at(def, i)} ctx={ctx} />
            </div>
            <RemoveButton onClick={() => ctx.remove(path, i)} />
          </div>
        ) : (
          <div key={i} className="flex items-center gap-1">
            <span className="w-6 shrink-0 text-right font-mono text-[11px] text-faint">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <Scalar path={[...path, i]} value={item} ctx={ctx} />
            </div>
            <RemoveButton onClick={() => ctx.remove(path, i)} />
          </div>
        ),
      )}
      {differs && (
        <div className="rounded-md bg-pill/70 px-2.5 py-1.5 text-[11.5px] leading-[18px] text-muted">
          Hexo 会把它和主题默认合并，网站实际用的是这 {merged.length} 项（合并列表时不会删掉默认里有的项，在这里删不掉）：
          {merged.map((x, i) => (
            <div key={i} className="selectable flex gap-1.5 font-mono">
              <span className="min-w-0 truncate">{display(x)}</span>
              {!value.some((v) => sameValue(v, x)) && <span className="shrink-0 font-sans text-faint">来自主题默认</span>}
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => ctx.append(path, like === undefined ? "" : objects ? blankLike(like) : typeof like === "boolean" ? false : typeof like === "number" ? 0 : "")}
        className="ml-6 flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted hover:bg-pill hover:text-fg"
      >
        <Plus className="h-3.5 w-3.5" />
        添加一项
      </button>
    </div>
  );
  return (
    <Nested label={label} count={`${value.length} 项`} open={open} onToggle={() => setOpen((o) => !o)}>
      {body}
    </Nested>
  );
}

function RemoveButton({ onClick, title = "删除这一项" }: { onClick: () => void; title?: string }) {
  return (
    <button type="button" aria-label={title} title={title} onClick={onClick} className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-pill hover:text-danger">
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

// ---- maps of links: anzhiyu's menu and social icons -----------------------------------------

/** Every value is text and at least one is a `link || icon`: names to links, which can be added, renamed and removed. */
const linkMap = (v: Record<string, unknown>) => {
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => typeof x === "string") && values.some((x) => splitLink(x as string));
};
/** Groups of link maps, as the menu is. */
const menuMap = (v: Record<string, unknown>) => {
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => isObject(x) && linkMap(x));
};

function freeName(taken: object, base: string): string {
  let name = base;
  for (let n = 2; name in taken; n++) name = `${base} ${n}`;
  return name;
}

/** A key's name, edited in place; renaming keeps its place in the file. */
function KeyName({ name, onRename, className }: { name: string; onRename: (v: string) => void; className?: string }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => (draft.trim() && draft.trim() !== name ? onRename(draft.trim()) : setDraft(name));
  return (
    <input
      value={draft}
      aria-label="名称"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => (e.key === "Enter" && !e.nativeEvent.isComposing ? e.currentTarget.blur() : e.key === "Escape" && (setDraft(name), e.currentTarget.blur()))}
      className={cn("h-7 w-full rounded-md bg-transparent px-1.5 text-[13px] outline-none hover:bg-pill focus:bg-card focus:shadow-[inset_0_0_0_1px_rgb(var(--brand))]", className)}
    />
  );
}

function LinkMapField({ path, value, def, ctx, label }: { path: Path; value: Record<string, unknown>; def: unknown; ctx: FieldContext; label: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const extra = isObject(def) ? Object.keys(def).filter((k) => !(k in value)) : [];
  const body = (
    <div className="space-y-1 py-1">
      <div className="grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)_24px] gap-1.5 px-0.5 text-[11px] text-muted">
        <span className="px-1.5">名称</span>
        <span>链接 · 图标</span>
      </div>
      {Object.entries(value).map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)_24px] items-start gap-1.5">
          <KeyName name={k} onRename={(n) => ctx.renameKey([...path, k], n)} />
          <LinkValue value={String(v ?? "")} onCommit={(nv) => ctx.set([...path, k], nv)} />
          <RemoveButton onClick={() => ctx.removeKey([...path, k])} />
        </div>
      ))}
      {extra.map((k) => (
        <Field key={k} path={[...path, k]} value={undefined} def={at(def, k)} ctx={ctx} inDefaultsOnly />
      ))}
      <button type="button" onClick={() => ctx.set([...path, freeName(value, "新项目")], "/ ||")} className="flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted hover:bg-pill hover:text-fg">
        <Plus className="h-3.5 w-3.5" />
        添加一项
      </button>
    </div>
  );
  // A section of its own, or a menu group's card: listed as is; deeper ones fold.
  if (path.length === 1 || label === null) return body;
  return (
    <Nested label={label} count={`${Object.keys(value).length} 项`} open={open} onToggle={() => setOpen((o) => !o)}>
      {body}
    </Nested>
  );
}

function MenuField({ path, value, def, ctx, label }: { path: Path; value: Record<string, unknown>; def: unknown; ctx: FieldContext; label: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const extra = isObject(def) ? Object.keys(def).filter((k) => !(k in value)) : [];
  const body = (
    <div className="space-y-2 py-1">
      {Object.entries(value).map(([group, links]) => (
        <div key={group} className="rounded-lg bg-card-2 px-2.5 py-2 shadow-card">
          <div className="mb-1 flex items-center gap-1">
            <KeyName name={group} onRename={(n) => ctx.renameKey([...path, group], n)} className="font-medium" />
            <span className="shrink-0 text-[11.5px] text-muted">{Object.keys(links as object).length} 项</span>
            <RemoveButton onClick={() => ctx.removeKey([...path, group])} title="删除这个分组" />
          </div>
          <LinkMapField path={[...path, group]} value={links as Record<string, unknown>} def={at(def, group)} ctx={ctx} label={null} />
        </div>
      ))}
      {extra.map((k) => (
        <Field key={k} path={[...path, k]} value={undefined} def={at(def, k)} ctx={ctx} inDefaultsOnly />
      ))}
      <button
        type="button"
        onClick={() => ctx.set([...path, freeName(value, "新分组")], { 新项目: "/ ||" })}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted hover:bg-pill hover:text-fg"
      >
        <Plus className="h-3.5 w-3.5" />
        添加分组
      </button>
    </div>
  );
  if (path.length === 1) return body;
  return (
    <Nested label={label} count={`${Object.keys(value).length} 组`} open={open} onToggle={() => setOpen((o) => !o)}>
      {body}
    </Nested>
  );
}
