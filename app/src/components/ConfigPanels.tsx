import { ExternalLink, Info, TriangleAlert } from "lucide-react";
import { Field, type FieldContext } from "@/components/ConfigFields";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { api, errorText } from "@/lib/api";
import { getIn, pathKey, type Path } from "@/lib/configYaml";
import type { PluginView } from "@/lib/plugins";
import { ASIDE_CARDS, COMMENT_SERVICES, commentServices, SEARCH_SERVICES, writeCommentServices } from "@/lib/themeGroups";
import { cn } from "@/lib/utils";

/** Panels for the theme's sections that are easier to set as a whole than key by key. */

interface PanelProps {
  /** The theme overrides file, as plain values. */
  data: Record<string, unknown>;
  /** The theme's defaults. */
  defaults: Record<string, unknown>;
  ctx: FieldContext;
}

/** The value Hexo ends up with: the override when the file has the key, else the default. */
const effective = (data: unknown, defaults: unknown, path: Path) => {
  const own = getIn(data, path);
  return own === undefined ? getIn(defaults, path) : own;
};

const skipping = (ctx: FieldContext, paths: Path[]): FieldContext => ({ ...ctx, skip: new Set([...ctx.skip, ...paths.map(pathKey)]) });

/** A heading inside a panel; `top` for the panel's first, which needs no space above. */
function PanelHeader({ title, top = false, children }: { title: string; top?: boolean; children?: React.ReactNode }) {
  return (
    <div className={cn("mb-1 flex items-center gap-2 border-b-[0.5px] border-line-2 pb-1.5", !top && "mt-5")}>
      <span className="text-[12.5px] font-semibold">{title}</span>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5 rounded-md bg-pill/70 px-2.5 py-1.5 text-[11.5px] leading-[18px] text-muted">
      <Info className="mt-[2px] h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Up to two comment services (the first shown by default), then only their settings. */
export function CommentsPanel({ data, defaults, ctx }: PanelProps) {
  const use = getIn(data, ["comments", "use"]);
  const chosen = commentServices(use);
  const [first = "", second = ""] = chosen;
  const write = (names: string[]) => ctx.set(["comments", "use"], writeCommentServices(use, names.filter(Boolean)));
  const options = (except: string) => [
    { value: "", label: "不用" },
    ...COMMENT_SERVICES.filter((s) => s.name !== except).map((s) => ({ value: s.name, label: s.name })),
  ];
  return (
    <div>
      <PanelHeader title="评论服务" top />
      <div className="space-y-2 py-1.5">
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-[12.5px] text-fg-2">默认显示</span>
          <Segmented value={first} options={options(second)} onChange={(v) => write(v ? [v, second] : [])} />
        </div>
        {first && (
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-[12.5px] text-fg-2">第二个</span>
            <Segmented value={second} options={options(first)} onChange={(v) => write([first, v])} />
          </div>
        )}
        <Note>主题最多同时用两个评论服务，读者可以在文章底部切换。这里改的是 comments.use。</Note>
      </div>
      <PanelHeader title="评论区" />
      <Field path={["comments"]} value={data.comments} def={defaults.comments} ctx={skipping(ctx, [["comments", "use"]])} />
      {chosen.map((name) => {
        const key = COMMENT_SERVICES.find((s) => s.name === name)?.key;
        if (!key) return null;
        return (
          <div key={name}>
            <PanelHeader title={`${name} 设置`}>
              <span className="font-mono text-[11.5px] text-muted">{key}</span>
            </PanelHeader>
            <Field path={[key]} value={data[key]} def={defaults[key]} ctx={ctx} />
          </div>
        );
      })}
    </div>
  );
}

/** One search service: the theme takes the first enabled one, so choosing turns the others off. */
export function SearchPanel({ data, defaults, ctx }: PanelProps) {
  const current = SEARCH_SERVICES.find((s) => effective(data, defaults, [s.key, "enable"]) === true)?.key ?? "";
  const choose = (key: string) =>
    ctx.setMany(
      SEARCH_SERVICES.filter((s) => (effective(data, defaults, [s.key, "enable"]) === true) !== (s.key === key)).map((s) => [[s.key, "enable"], s.key === key] as [Path, unknown]),
    );
  return (
    <div>
      <PanelHeader title="搜索服务" top />
      <div className="space-y-2 py-1.5">
        <Segmented value={current} options={[{ value: "", label: "不用" }, ...SEARCH_SERVICES.map((s) => ({ value: s.key, label: s.label }))]} onChange={choose} />
        <Note>主题只用一个搜索服务（同时开着几个时按 Algolia、本地搜索、DocSearch 的顺序取第一个），选一个会关掉其他的。本地搜索需要博客装了 hexo-generator-search。</Note>
      </div>
      {current && (
        <>
          <PanelHeader title={`${SEARCH_SERVICES.find((s) => s.key === current)!.label} 设置`}>
            <span className="font-mono text-[11.5px] text-muted">{current}</span>
          </PanelHeader>
          <Field path={[current]} value={data[current]} def={defaults[current]} ctx={skipping(ctx, [[current, "enable"]])} />
        </>
      )}
    </div>
  );
}

/** The sidebar's cards as switches, then the rest of `aside`. */
export function AsidePanel({ data, defaults, ctx }: PanelProps) {
  const own = (data.aside ?? {}) as Record<string, unknown>;
  const fallback = (defaults.aside ?? {}) as Record<string, unknown>;
  const cards = [...new Set([...Object.keys(own), ...Object.keys(fallback)])].filter((k) => k.startsWith("card_"));
  return (
    <div>
      <PanelHeader title="侧栏卡片" top />
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 py-1.5">
        {cards.map((k) => {
          const on = effective(data, defaults, ["aside", k, "enable"]) === true;
          return (
            <label key={k} className="flex h-8 items-center gap-2.5 rounded-md px-1.5 hover:bg-pill/60">
              <Switch checked={on} onChange={(v) => ctx.set(["aside", k, "enable"], v)} label={ASIDE_CARDS[k] ?? k} />
              <span className="text-[13px]">{ASIDE_CARDS[k] ?? k}</span>
              <span className="font-mono text-[11px] text-faint">{k}</span>
            </label>
          );
        })}
      </div>
      <Note>卡片的先后顺序由主题模板决定，配置里改不了（各卡片的 sort_order 主题没有用到）。</Note>
      <PanelHeader title="侧栏与各卡片设置" />
      <Field path={["aside"]} value={data.aside} def={defaults.aside} ctx={skipping(ctx, cards.map((k) => ["aside", k, "enable"]))} />
    </div>
  );
}

function LinkButton({ url, label, onError }: { url: string; label: string; onError: (message: string) => void }) {
  return (
    <button type="button" onClick={() => void api.openUrl(url).catch((e) => onError(errorText(e)))} className="flex items-center gap-1 rounded px-1.5 text-accent hover:bg-pill">
      <ExternalLink className="h-3 w-3" />
      {label}
    </button>
  );
}

/** A plugin: what is installed, where to read about it, and its sections of `_config.yml`. */
export function PluginPanel({ view, data, ctx, onError }: { view: PluginView; data: Record<string, unknown>; ctx: FieldContext; onError: (message: string) => void }) {
  const { plugin, keys } = view;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 text-[12px] text-muted">
        {plugin.version ? (
          <span>
            已安装 <span className="font-mono text-fg-2">{plugin.version}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded bg-warn-soft px-1.5 text-warn">
            <TriangleAlert className="h-3 w-3" />
            没有安装，Hexo 会跳过它：在博客目录执行 npm install
          </span>
        )}
        <span>
          package.json 要求 <span className="font-mono text-fg-2">{plugin.wanted || "任意版本"}</span>
        </span>
        {plugin.fromTheme && <span className="rounded bg-pill px-1.5">主题依赖</span>}
        <span className="flex-1" />
        <LinkButton url={`https://www.npmjs.com/package/${plugin.name}`} label="npm" onError={onError} />
        {plugin.repo && <LinkButton url={plugin.repo} label="GitHub" onError={onError} />}
      </div>
      {keys.length === 0 ? (
        <Note>_config.yml 里没有这个插件的设置，它按自己的默认值工作。需要改的话，照它的说明在 _config.yml 里加上对应的段，加好后会出现在这里。</Note>
      ) : (
        keys.map((k, i) => (
          <div key={k}>
            <PanelHeader title={k} top={i === 0} />
            <Field path={[k]} value={data[k]} def={undefined} ctx={ctx} />
          </div>
        ))
      )}
    </div>
  );
}
