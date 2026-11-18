import { AlertTriangle, ChevronRight, Code2, Clock } from "lucide-react";
import { useMemo, useState } from "react";
import { TagInput } from "@/components/TagInput";
import { Input, Label, Textarea } from "@/components/ui/input";
import { fromInputValue, nowIn, toInputValue } from "@/lib/date";
import { applyEdits, changed, readFrontMatter, type FieldValue } from "@/lib/frontmatter";
import { cn } from "@/lib/utils";

interface FrontMatterFormProps {
  yaml: string;
  onChange: (yaml: string) => void;
  onError: (message: string) => void;
  timezone: string | null;
  tagSuggestions: string[];
  categorySuggestions: string[];
  /** Folded to one summary line, out of the way of the body. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));
const names = (v: unknown): string[] => (Array.isArray(v) ? v.flat(Infinity).map(text).filter(Boolean) : v === null || v === undefined || v === "" ? [] : [text(v)]);

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** The fields that matter at a glance, on the folded line. */
function Summary({ values, error }: { values: Record<string, unknown>; error: boolean }) {
  if (error) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-danger">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        YAML 有误，展开修改
      </span>
    );
  }
  const title = text(values.title);
  const date = text(values.date);
  const cats = names(values.categories);
  const tags = names(values.tags);
  const cover = text(values.cover);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden whitespace-nowrap">
      <span className={cn("max-w-[55%] shrink-0 truncate font-medium", title ? "text-fg" : "text-faint")}>{title || "无标题"}</span>
      {date && <span className="shrink-0 tabular-nums text-muted">{date.replace(/:\d\d$/, "")}</span>}
      {cats.length > 0 && <span className="min-w-0 shrink truncate text-muted">{cats.join(" / ")}</span>}
      {tags.length > 0 && (
        <span className="flex min-w-0 flex-1 gap-1 overflow-hidden">
          {tags.map((t) => (
            <span key={t} className="shrink-0 rounded-[5px] bg-pill px-1.5 text-[11.5px] leading-[18px] text-fg-2">
              {t}
            </span>
          ))}
        </span>
      )}
      {cover && <img src={cover} alt="" className="ml-auto h-5 w-8 shrink-0 rounded-[3px] object-cover shadow-edge" />}
    </span>
  );
}

/**
 * The post's front-matter as a form. Each change rewrites only that key in the YAML text
 * (`applyEdits`); "源码" edits the text itself, which also holds the keys the form has no
 * control for. Unreadable YAML opens in source mode.
 */
export function FrontMatterForm({ yaml, onChange, onError, timezone, tagSuggestions, categorySuggestions, open, onOpenChange }: FrontMatterFormProps) {
  const parsed = useMemo(() => readFrontMatter(yaml), [yaml]);
  const [source, setSource] = useState(false);
  const [more, setMore] = useState(false);
  const values = parsed.values ?? {};
  const showSource = source || parsed.values === null;

  const set = (key: string, value: FieldValue) => {
    if (!changed(values[key], value)) return;
    try {
      onChange(applyEdits(yaml, { [key]: value }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const dateText = text(values.date);
  const dateInput = toInputValue(dateText);
  const topImg = values.top_img;

  const header = (
    <div className="flex h-9 items-center gap-2 text-[12.5px]">
      <button type="button" onClick={() => onOpenChange(!open)} title={open ? "收起文章信息" : "展开文章信息"} className="flex min-w-0 flex-1 items-center gap-1.5 text-left active:!scale-100">
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")} />
        <span className="shrink-0 font-medium text-muted">文章信息</span>
        {!open && <Summary values={values} error={parsed.values === null} />}
      </button>
      {open && (
        <>
          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            disabled={showSource}
            className={cn("flex h-6 items-center rounded-md px-2 text-[12px] text-muted hover:bg-pill hover:text-fg disabled:opacity-40", more && !showSource && "bg-pill text-fg")}
          >
            更多字段
          </button>
          <button
            type="button"
            onClick={() => setSource((s) => !s)}
            disabled={parsed.values === null}
            className={cn("flex h-6 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-pill hover:text-fg", showSource && "bg-pill text-fg")}
          >
            <Code2 className="h-3.5 w-3.5" />
            源码
          </button>
        </>
      )}
    </div>
  );

  if (!open) return header;

  return (
    <div className="space-y-2 pb-4">
      {header}

      {showSource ? (
        <div className="space-y-1">
          <Textarea value={yaml} onChange={(e) => onChange(e.target.value)} spellCheck={false} rows={Math.min(16, Math.max(6, yaml.split("\n").length + 1))} className="selectable" />
          {parsed.error && <div className="text-[12px] text-danger">YAML 有误：{parsed.error}</div>}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <Field label="标题" className="col-span-2">
            <Input value={text(values.title)} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="日期">
            <div className="flex gap-1.5">
              {dateInput !== null || !dateText ? (
                <Input type="datetime-local" step={1} value={dateInput ?? ""} onChange={(e) => set("date", e.target.value ? fromInputValue(e.target.value) : "")} />
              ) : (
                <Input value={dateText} onChange={(e) => set("date", e.target.value)} />
              )}
              <button
                type="button"
                title={`设为现在（${timezone ?? "本机时区"}）`}
                onClick={() => set("date", nowIn(timezone))}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-pill text-muted hover:bg-pill-hover hover:text-fg"
              >
                <Clock className="h-[15px] w-[15px]" />
              </button>
            </div>
          </Field>
          <Field label="分类">
            <TagInput value={names(values.categories)} onChange={(v) => set("categories", v)} suggestions={categorySuggestions} placeholder="回车添加" />
          </Field>
          <Field label="标签" className="col-span-2">
            <TagInput value={names(values.tags)} onChange={(v) => set("tags", v)} suggestions={tagSuggestions} placeholder="回车或逗号添加" />
          </Field>
          <Field label="描述" className="col-span-2">
            <Textarea value={text(values.description)} onChange={(e) => set("description", e.target.value)} rows={2} className="min-h-0 font-sans text-[13px]" />
          </Field>
          <Field label="封面" className="col-span-2">
            <div className="flex items-center gap-2">
              <Input value={text(values.cover)} onChange={(e) => set("cover", e.target.value)} placeholder="图片地址" />
              {text(values.cover) && <img src={text(values.cover)} alt="" className="h-8 w-12 shrink-0 rounded object-cover shadow-edge" />}
            </div>
          </Field>
          {more && (
            <>
              <Field label="顶部图（top_img）" className="col-span-2">
                <div className="flex items-center gap-2">
                  <Input value={topImg === false ? "" : text(topImg)} disabled={topImg === false} onChange={(e) => set("top_img", e.target.value)} placeholder={topImg === false ? "不显示顶部图" : "留空则用主题默认"} />
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-fg-2">
                    <input type="checkbox" checked={topImg === false} onChange={(e) => set("top_img", e.target.checked ? false : "")} />
                    不显示
                  </label>
                </div>
              </Field>
              <Field label="过期提醒（noticeOutdate）">
                <select className="field cursor-pointer pr-7" value={values.noticeOutdate === true ? "true" : values.noticeOutdate === false ? "false" : ""} onChange={(e) => set("noticeOutdate", e.target.value === "" ? null : e.target.value === "true")}>
                  <option value="">主题默认</option>
                  <option value="true">开启</option>
                  <option value="false">关闭</option>
                </select>
              </Field>
              <Field label="版权作者（copyright_author）">
                <Input value={text(values.copyright_author)} onChange={(e) => set("copyright_author", e.target.value)} />
              </Field>
              <Field label="原文链接（copyright_url）" className="col-span-2">
                <Input value={text(values.copyright_url)} onChange={(e) => set("copyright_url", e.target.value)} />
              </Field>
              <Field label="版权声明（copyright_info）" className="col-span-2">
                <Textarea value={text(values.copyright_info)} onChange={(e) => set("copyright_info", e.target.value)} rows={2} className="min-h-0 font-sans text-[13px]" />
              </Field>
              <div className="col-span-2 text-[11.5px] leading-[17px] text-muted">其他字段（如 swiper_index、abbrlink）在“源码”里修改；保存时原样保留。</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
