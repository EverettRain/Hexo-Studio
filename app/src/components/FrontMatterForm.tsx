import { AlertTriangle, ChevronDown, Code2, Clock, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TagInput } from "@/components/TagInput";
import { Input, Textarea } from "@/components/ui/input";
import { fromInputValue, nowIn, toInputValue } from "@/lib/date";
import { applyEdits, changed, readFrontMatter, type FieldValue } from "@/lib/frontmatter";
import { cn } from "@/lib/utils";

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));
const names = (v: unknown): string[] => (Array.isArray(v) ? v.flat(Infinity).map(text).filter(Boolean) : v === null || v === undefined || v === "" ? [] : [text(v)]);

/** The post's front-matter folded to one line above the body; pressing it opens the panel. */
export function FrontMatterBar({ yaml, open, onOpenChange }: { yaml: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const parsed = useMemo(() => readFrontMatter(yaml), [yaml]);
  const values = parsed.values ?? {};
  const title = text(values.title);
  const date = text(values.date);
  const cats = names(values.categories);
  const tags = names(values.tags);
  const cover = text(values.cover);
  return (
    <button
      type="button"
      onClick={() => onOpenChange(!open)}
      title={open ? "收起文章信息" : "编辑文章信息"}
      className={cn("flex h-9 w-full min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap px-4 text-left text-[12.5px] hover:bg-pill/60 active:!scale-100", open && "bg-pill/60")}
    >
      <span className="shrink-0 font-medium text-muted">文章信息</span>
      {parsed.values === null ? (
        <span className="flex min-w-0 items-center gap-1 text-danger">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          YAML 有误，点开修改
        </span>
      ) : (
        <>
          <span className={cn("max-w-[55%] shrink-0 truncate font-medium", title ? "text-fg" : "text-faint")}>{title || "无标题"}</span>
          {date && <span className="shrink-0 tabular-nums text-muted">{date.replace(/:\d\d$/, "")}</span>}
          {cats.length > 0 && <span className="min-w-0 shrink truncate text-muted">{cats.join(" / ")}</span>}
          <span className="flex min-w-0 flex-1 gap-1 overflow-hidden">
            {tags.map((t) => (
              <span key={t} className="shrink-0 rounded-[5px] bg-pill px-1.5 text-[11.5px] leading-[18px] text-fg-2">
                {t}
              </span>
            ))}
          </span>
          {cover && <img src={cover} alt="" className="h-5 w-8 shrink-0 rounded-[3px] object-cover shadow-edge" />}
        </>
      )}
      <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
    </button>
  );
}

/** One line of a group: the name on the left, its control on the right (as in Hydra's dialogs). */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <div className="w-[68px] shrink-0 pt-[7px] text-[13px] leading-[18px] text-fg-2" title={hint}>
        {label}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

interface FrontMatterPanelProps {
  yaml: string;
  onChange: (yaml: string) => void;
  onError: (message: string) => void;
  timezone: string | null;
  tagSuggestions: string[];
  categorySuggestions: string[];
  onClose: () => void;
  className?: string;
}

/**
 * The front-matter as a panel floating over the body. Each change rewrites only that key in the
 * YAML text (`applyEdits`) and is saved like typing; "源码" edits the text itself, which also holds
 * the keys the form has no control for. Unreadable YAML opens in source mode.
 */
export function FrontMatterPanel({ yaml, onChange, onError, timezone, tagSuggestions, categorySuggestions, onClose, className }: FrontMatterPanelProps) {
  const parsed = useMemo(() => readFrontMatter(yaml), [yaml]);
  const [source, setSource] = useState(false);
  const values = parsed.values ?? {};
  const showSource = source || parsed.values === null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open dialog (the image picker) takes its own Escape.
      if (e.key === "Escape" && !document.querySelector("[data-dialog-layer]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  const cover = text(values.cover);

  return (
    <div className={cn("z-20 animate-fade-in", className)}>
      <div className="absolute inset-0 bg-black/[.12] dark:bg-black/40" onClick={onClose} />
      <div role="dialog" aria-label="文章信息" className="relative mx-3 mt-2 flex max-h-[calc(100%-1rem)] animate-pop-in flex-col rounded-2xl bg-bg shadow-pop">
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold tracking-[-0.01em]">文章信息</h2>
            <div className="text-[11.5px] text-muted">修改即时保存，只改动改过的字段</div>
          </div>
          <button
            type="button"
            onClick={() => setSource((s) => !s)}
            disabled={parsed.values === null}
            className={cn("flex h-[26px] items-center gap-1 rounded-[7px] px-2 text-[12px] text-muted hover:bg-pill hover:text-fg", showSource && "bg-pill text-fg")}
          >
            <Code2 className="h-3.5 w-3.5" />
            源码
          </button>
          <button type="button" aria-label="关闭" onClick={onClose} className="-mr-1.5 flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-muted hover:bg-pill hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-1">
          {showSource ? (
            <section>
              <div className="list-card p-3">
                <Textarea
                  value={yaml}
                  onChange={(e) => onChange(e.target.value)}
                  spellCheck={false}
                  rows={Math.min(18, Math.max(8, yaml.split("\n").length + 1))}
                  className="selectable"
                  autoFocus
                />
              </div>
              {parsed.error && <p className="mt-1.5 px-1 text-[11.5px] text-danger">YAML 有误：{parsed.error}</p>}
            </section>
          ) : (
            <>
              <section>
                <div className="group-label">基本</div>
                <div className="list-card">
                  <Row label="标题">
                    <Input value={text(values.title)} onChange={(e) => set("title", e.target.value)} />
                  </Row>
                  <Row label="日期" hint={`时区：${timezone ?? "本机"}`}>
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
                  </Row>
                  <Row label="分类">
                    <TagInput value={names(values.categories)} onChange={(v) => set("categories", v)} suggestions={categorySuggestions} placeholder="回车添加" />
                  </Row>
                  <Row label="标签">
                    <TagInput value={names(values.tags)} onChange={(v) => set("tags", v)} suggestions={tagSuggestions} placeholder="回车或逗号添加" />
                  </Row>
                  <Row label="描述">
                    <Textarea value={text(values.description)} onChange={(e) => set("description", e.target.value)} rows={2} className="min-h-0 font-sans text-[13px]" />
                  </Row>
                  <Row label="封面">
                    <Input value={cover} onChange={(e) => set("cover", e.target.value)} placeholder="图片地址，或在工具栏“图库”里设为封面" />
                    {cover && <img src={cover} alt="" className="mt-2 h-24 max-w-full rounded-md object-cover shadow-edge" />}
                  </Row>
                </div>
              </section>

              <section>
                <div className="group-label">主题选项</div>
                <div className="list-card">
                  <Row label="顶部图" hint="top_img">
                    <div className="flex items-center gap-2">
                      <Input value={topImg === false ? "" : text(topImg)} disabled={topImg === false} onChange={(e) => set("top_img", e.target.value)} placeholder={topImg === false ? "不显示顶部图" : "留空则用主题默认"} />
                      <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-fg-2">
                        <input type="checkbox" checked={topImg === false} onChange={(e) => set("top_img", e.target.checked ? false : "")} />
                        不显示
                      </label>
                    </div>
                  </Row>
                  <Row label="过期提醒" hint="noticeOutdate">
                    <select className="field cursor-pointer pr-7" value={values.noticeOutdate === true ? "true" : values.noticeOutdate === false ? "false" : ""} onChange={(e) => set("noticeOutdate", e.target.value === "" ? null : e.target.value === "true")}>
                      <option value="">主题默认</option>
                      <option value="true">开启</option>
                      <option value="false">关闭</option>
                    </select>
                  </Row>
                  <Row label="版权作者" hint="copyright_author">
                    <Input value={text(values.copyright_author)} onChange={(e) => set("copyright_author", e.target.value)} />
                  </Row>
                  <Row label="原文链接" hint="copyright_url">
                    <Input value={text(values.copyright_url)} onChange={(e) => set("copyright_url", e.target.value)} />
                  </Row>
                  <Row label="版权声明" hint="copyright_info">
                    <Textarea value={text(values.copyright_info)} onChange={(e) => set("copyright_info", e.target.value)} rows={2} className="min-h-0 font-sans text-[13px]" />
                  </Row>
                </div>
                <p className="mt-1.5 px-1 text-[11.5px] leading-[17px] text-muted">其他字段（如 swiper_index、abbrlink）在“源码”里修改；保存时原样保留。</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
