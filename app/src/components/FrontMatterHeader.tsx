import { AlignLeft, CalendarDays, ChevronDown, Code2, FolderTree, Image as ImageIcon, PanelTop, Tags, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DatePicker } from "@/components/DatePicker";
import { TagInput } from "@/components/TagInput";
import { Segmented } from "@/components/ui/segmented";
import { applyEdits, changed, readFrontMatter, type FieldValue } from "@/lib/frontmatter";
import { describeImage, type ImageIndex } from "@/lib/images";
import { cn } from "@/lib/utils";

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));
const names = (v: unknown): string[] => (Array.isArray(v) ? v.flat(Infinity).map(text).filter(Boolean) : v === null || v === undefined || v === "" ? [] : [text(v)]);

/** A borderless text area that grows with its text, as the rest of the article does. */
function AutoText({ value, onChange, className, placeholder, onEnter }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; onEnter?: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(onEnter ? e.target.value.replace(/\n/g, "") : e.target.value)}
      onKeyDown={(e) => {
        if (onEnter && e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          onEnter();
        }
      }}
      className={cn("block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint", className)}
    />
  );
}

function Prop({ icon: Icon, label, hint, children }: { icon: typeof Tags; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex h-7 w-[92px] shrink-0 items-center gap-1.5 text-[12.5px] text-muted" title={hint}>
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {label}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const inputClass = "h-7 w-full rounded-md bg-transparent px-1.5 text-[13px] outline-none placeholder:text-faint hover:bg-pill focus:bg-pill";

/** An image property: its picture and library name; the address only when edited by hand. */
function ImageValue({ url, index, onPick, onChange }: { url: string; index: ImageIndex; onPick: () => void; onChange: (url: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!url && !editing) {
    return (
      <div className="flex h-7 items-center gap-1">
        <button type="button" onClick={onPick} className="h-7 rounded-md px-1.5 text-[13px] text-faint hover:bg-pill hover:text-fg">
          从图库选择…
        </button>
        <button type="button" onClick={() => setEditing(true)} className="h-7 rounded-md px-1.5 text-[12px] text-faint hover:bg-pill hover:text-fg">
          填写地址
        </button>
      </div>
    );
  }
  if (editing) {
    return <input autoFocus className={inputClass} defaultValue={url} placeholder="图片地址" onBlur={(e) => (onChange(e.target.value.trim()), setEditing(false))} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
  }
  const info = describeImage(index, url);
  return (
    <div className="group flex items-center gap-2.5 rounded-md p-0.5 hover:bg-pill">
      <button type="button" onClick={onPick} title="换一张" className="shrink-0 active:!scale-100">
        <img src={info.thumb} alt="" className="h-12 w-[76px] rounded-[5px] bg-pill object-cover shadow-edge" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{info.name}</div>
        <div className="text-[11.5px] text-muted">{info.id ? "图片库" : "不在图片库"}</div>
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
        <button type="button" onClick={onPick} className="h-6 rounded-[5px] px-1.5 text-[12px] text-muted hover:bg-card hover:text-fg">
          换一张
        </button>
        <button type="button" onClick={() => setEditing(true)} className="h-6 rounded-[5px] px-1.5 text-[12px] text-muted hover:bg-card hover:text-fg">
          地址
        </button>
        <button type="button" aria-label="清除" onClick={() => onChange("")} className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:bg-card hover:text-danger">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

interface FrontMatterHeaderProps {
  yaml: string;
  onChange: (yaml: string) => void;
  onError: (message: string) => void;
  timezone: string | null;
  tagSuggestions: string[];
  categorySuggestions: string[];
  images: ImageIndex;
  /** Opens the image library to choose the cover or the top image. */
  onPickImage: (key: "cover" | "top_img") => void;
  /** Enter in the title moves on to the body. */
  onEnterBody: () => void;
}

/**
 * The post's front-matter at the top of the article, scrolling away with it: the title, then one
 * line per property. Each change rewrites only that key in the YAML text (`applyEdits`) and is
 * saved like typing; "源码" edits the YAML itself, which also holds keys there is no control for.
 * Unreadable YAML opens as source.
 */
export function FrontMatterHeader({ yaml, onChange, onError, timezone, tagSuggestions, categorySuggestions, images, onPickImage, onEnterBody }: FrontMatterHeaderProps) {
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

  const topImg = values.top_img;
  const topMode = topImg === false ? "off" : text(topImg) ? "image" : "default";
  const headerButton = "flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted hover:bg-pill hover:text-fg";

  return (
    // Left edge on the body's text: CodeMirror's 24px content padding plus its 6px line padding.
    // The panel reaches 12px past it on each side, so the values inside line up with the text.
    <div className="max-w-[820px] pb-6 pl-[30px] pr-6 pt-7">
      {!showSource && (
        <AutoText value={text(values.title)} onChange={(v) => set("title", v)} onEnter={onEnterBody} placeholder="无标题" className="text-[26px] font-semibold leading-[1.3] tracking-[-0.015em]" />
      )}
      {/* A flat card on the window's gray, which is also the body's ground: no border or shadow. */}
      <section aria-label="文章属性" className={cn("-mx-3 rounded-xl bg-card px-3 pb-2.5 pt-1.5", !showSource && "mt-4")}>
        <div className="flex h-8 items-center gap-0.5">
          <span className="flex-1 text-[11.5px] font-medium tracking-[0.02em] text-muted">{showSource ? "front-matter 源码" : "文章属性"}</span>
          {showSource ? (
            parsed.values !== null && (
              <button type="button" onClick={() => setSource(false)} className={headerButton}>
                返回属性
              </button>
            )
          ) : (
            <>
              <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className={cn(headerButton, more && "text-fg")}>
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", more && "rotate-180")} />
                {more ? "收起" : "更多属性"}
              </button>
              <button type="button" onClick={() => setSource(true)} title="其他字段（如 swiper_index、abbrlink）在源码里修改；保存时原样保留" className={headerButton}>
                <Code2 className="h-3.5 w-3.5" />
                源码
              </button>
            </>
          )}
        </div>
        {showSource ? (
          <div className="space-y-1.5">
            <AutoText value={yaml} onChange={onChange} className="selectable rounded-lg bg-pill px-3 py-2 font-mono text-[12.5px] leading-5" />
            {parsed.error && <p className="text-[12px] text-danger">YAML 有误：{parsed.error}</p>}
          </div>
        ) : (
          <div className="space-y-0.5">
            <Prop icon={CalendarDays} label="日期" hint={`时区：${timezone ?? "本机"}`}>
              <DatePicker value={text(values.date)} onChange={(v) => set("date", v)} timezone={timezone} />
            </Prop>
            <Prop icon={FolderTree} label="分类" hint="多个分类是层级：前一个是后一个的上级">
              <TagInput hierarchy value={names(values.categories)} onChange={(v) => set("categories", v)} suggestions={categorySuggestions} placeholder="添加分类" />
            </Prop>
            <Prop icon={Tags} label="标签">
              <TagInput value={names(values.tags)} onChange={(v) => set("tags", v)} suggestions={tagSuggestions} placeholder="添加标签" />
            </Prop>
            <Prop icon={AlignLeft} label="描述">
              <AutoText value={text(values.description)} onChange={(v) => set("description", v)} placeholder="文章摘要，显示在列表和搜索结果里" className="rounded-md px-1.5 py-[3px] text-[13px] leading-[21px] hover:bg-pill focus:bg-pill" />
            </Prop>
            <Prop icon={ImageIcon} label="封面">
              <ImageValue url={text(values.cover)} index={images} onPick={() => onPickImage("cover")} onChange={(v) => set("cover", v)} />
            </Prop>
            {more && (
              <div className="!mt-2 space-y-0.5 border-t-[0.5px] border-line pt-2">
                <Prop icon={PanelTop} label="顶部图" hint="top_img">
                  <div className="space-y-1">
                    <Segmented
                      value={topMode}
                      options={[
                        { value: "default", label: "主题默认" },
                        { value: "image", label: "指定图片" },
                        { value: "off", label: "不显示" },
                      ]}
                      onChange={(m) => (m === "off" ? set("top_img", false) : m === "default" ? set("top_img", null) : onPickImage("top_img"))}
                    />
                    {topMode === "image" && <ImageValue url={text(topImg)} index={images} onPick={() => onPickImage("top_img")} onChange={(v) => set("top_img", v || null)} />}
                  </div>
                </Prop>
                <Prop icon={CalendarDays} label="过期提醒" hint="noticeOutdate">
                  <Segmented
                    value={values.noticeOutdate === true ? "on" : values.noticeOutdate === false ? "off" : "default"}
                    options={[
                      { value: "default", label: "主题默认" },
                      { value: "on", label: "开启" },
                      { value: "off", label: "关闭" },
                    ]}
                    onChange={(v) => set("noticeOutdate", v === "default" ? null : v === "on")}
                  />
                </Prop>
                <Prop icon={AlignLeft} label="版权作者" hint="copyright_author">
                  <input className={inputClass} value={text(values.copyright_author)} onChange={(e) => set("copyright_author", e.target.value)} placeholder="转载时填写原作者" />
                </Prop>
                <Prop icon={AlignLeft} label="原文链接" hint="copyright_url">
                  <input className={inputClass} value={text(values.copyright_url)} onChange={(e) => set("copyright_url", e.target.value)} placeholder="https://" />
                </Prop>
                <Prop icon={AlignLeft} label="版权声明" hint="copyright_info">
                  <AutoText value={text(values.copyright_info)} onChange={(v) => set("copyright_info", v)} placeholder="留空用主题默认" className="rounded-md px-1.5 py-[3px] text-[13px] leading-[21px] hover:bg-pill focus:bg-pill" />
                </Prop>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
