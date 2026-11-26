import { AlertTriangle, CheckCircle2, FolderSearch, Loader2, RotateCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Field, type FieldContext } from "@/components/ConfigFields";
import { AsidePanel, CommentsPanel, DataFilePanel, PluginPanel, SearchPanel } from "@/components/ConfigPanels";
import { ImagePicker } from "@/components/ImagePicker";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type BlogStatus, type ConfigFile, type Plugin, type PreviewState } from "@/lib/api";
import { appendItem, getIn, HEXO_CORE_KEYS, merge, outline, pathKey, readConfig, removeItem, removeKey, renameKey, sameValue, setValue, type Path } from "@/lib/configYaml";
import { jsonEdits } from "@/lib/dataJson";
import { indexImages, type ImageIndex } from "@/lib/images";
import { pluginSections } from "@/lib/plugins";
import { SEARCH_PANEL, SEARCH_SERVICES, taskGroups } from "@/lib/themeGroups";
import { useOnShow } from "@/lib/pageActive";
import { cn } from "@/lib/utils";

type View = "site" | "plugins" | "theme" | "data";
/** A file the page edits: the site's or the theme's config, or a page data file (`data:link.yml`). */
type FileKey = Exclude<ConfigFile, "themeDefaults"> | `data:${string}`;
const dataName = (key: FileKey) => (key.startsWith("data:") ? key.slice(5) : null);

const yamlEdits = { setValue, appendItem, removeItem, removeKey, renameKey };
/** JSON data files are rewritten whole (in their own indent): YAML's in-place edits could write YAML. */
const editsFor = (key: FileKey) => (key.endsWith(".json") ? jsonEdits : yamlEdits);
/** How the theme's sections are listed: by what they are for, or by the theme file's own headers. */
type ThemeOrder = "task" | "file";

interface Loaded {
  path: string;
  /** What the page shows and edits; saved shortly after each change. */
  text: string;
  /** Of the text last read from or written to disk. */
  fingerprint: string;
}

const SAVE_DELAY = 400;
const HIDDEN = new Set([pathKey(["admin", "password_hash"]), pathKey(["admin", "secret"])]);
const ADDRESS_KEYS = new Set(["url", "root", "permalink", "permalink_defaults", "pretty_urls", "timezone"].map((k) => pathKey([k])));

/** A value in a few words, for a list row whose section has no comment to show. */
function brief(v: unknown): string {
  if (typeof v === "boolean") return v ? "开" : "关";
  if (Array.isArray(v)) return `${v.length} 项`;
  if (v !== null && typeof v === "object") return `${Object.keys(v).length} 项设置`;
  if (v === null || v === undefined || v === "") return "未设置";
  return String(v);
}

/** Every key name, comment hint and text value under a section, lower-cased, for search. */
function searchText(key: string, value: unknown, hints: Map<string, string>): string {
  const parts: string[] = [key];
  const walk = (v: unknown, p: Path) => {
    const h = hints.get(pathKey(p));
    if (h) parts.push(h);
    if (v !== null && typeof v === "object" && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) (parts.push(k), walk(x, [...p, Array.isArray(v) ? Number(k) : k]));
    else if (typeof v === "string") parts.push(v);
  };
  walk(value, [key]);
  return parts.join("\n").toLowerCase();
}

/**
 * The blog's config: the site's `_config.yml` (Hexo's own keys, and the plugins' sections) and
 * the theme's overrides, each value edited in place. The theme's defaults are read alongside to
 * mark what differs from them and to offer keys only they have.
 */
export function ConfigPage({ preview, onStatus }: { preview: PreviewState; onStatus: (s: BlogStatus) => void }) {
  const toast = useToast();
  const [files, setFiles] = useState<Partial<Record<FileKey, Loaded>>>({});
  const [defaults, setDefaults] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("theme");
  const [selected, setSelected] = useState<Partial<Record<View, string>>>({});
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<"idle" | "pending" | "saving" | "error">("idle");
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [order, setOrder] = useState<ThemeOrder>("task");
  const [images, setImages] = useState<ImageIndex>(new Map());
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [picking, setPicking] = useState<{ file: FileKey; path: Path } | null>(null);
  const timers = useRef<Partial<Record<FileKey, number>>>({});
  const latest = useRef(files);
  latest.current = files;

  const load = useCallback(async () => {
    try {
      const [site, theme, themeDefaults, names] = await Promise.all([
        api.configRead("site"),
        api.configRead("theme").catch(() => null),
        api.configRead("themeDefaults").catch(() => null),
        api.dataFiles().catch(() => [] as string[]),
      ]);
      const next: Partial<Record<FileKey, Loaded>> = { site: { path: site.path, text: site.text, fingerprint: site.fingerprint } };
      if (theme) next.theme = { path: theme.path, text: theme.text, fingerprint: theme.fingerprint };
      const data = await Promise.all(names.map((n) => api.dataRead(n).then((d) => [n, d] as const, () => null)));
      for (const d of data) if (d) next[`data:${d[0]}`] = { path: d[1].path, text: d[1].text, fingerprint: d[1].fingerprint };
      setFiles(next);
      setDefaults(themeDefaults?.exists ? themeDefaults.text : null);
      // Thumbnails only: the page works without the library.
      api.imageLibrary().then((l) => setImages(indexImages(l.images)), () => {});
      api.listPlugins().then(setPlugins, () => {});
      setError(null);
      if (!theme) setView((v) => (v === "theme" ? "site" : v));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Back on the page: read again, unless a change is still on its way to disk.
  useOnShow(() => {
    if (!Object.values(timers.current).some(Boolean)) void load();
  });

  const save = useCallback(
    async (file: FileKey) => {
      timers.current[file] = undefined;
      const f = latest.current[file];
      if (!f) return;
      setSaving("saving");
      const name = dataName(file);
      try {
        const r = name ? await api.dataWrite(name, f.text, f.fingerprint) : await api.configWrite(file as ConfigFile, f.text, f.fingerprint);
        if (r.status === "conflict") {
          toast(`${f.path} 在别处被改过，已重新读取；刚才的改动没有保存。`, "error");
          await load();
          setSaving("idle");
          return;
        }
        setFiles((all) => ({ ...all, [file]: { ...all[file]!, fingerprint: r.fingerprint } }));
        setSaving("idle");
        // Hexo reads its config only when it starts; page data it watches like posts.
        if (!name) setNeedsRestart(true);
        // The rest of the app reads the site's title, addresses and time zone from it.
        if (file === "site") void api.blogStatus().then(onStatus, () => {});
      } catch (e) {
        setSaving("error");
        toast(errorText(e), "error");
      }
    },
    [load, onStatus, toast],
  );

  const edit = useCallback(
    (file: FileKey, change: (text: string) => string) => {
      const f = latest.current[file];
      if (!f) return;
      let text: string;
      try {
        text = change(f.text);
      } catch (e) {
        toast(errorText(e), "error");
        return;
      }
      if (text === f.text) return;
      const next = { ...latest.current, [file]: { ...f, text } };
      latest.current = next;
      setFiles(next);
      setSaving("pending");
      window.clearTimeout(timers.current[file]);
      timers.current[file] = window.setTimeout(() => void save(file), SAVE_DELAY);
    },
    [save, toast],
  );

  // Changes still waiting when the page goes away are written at once.
  useEffect(
    () => () => {
      for (const file of Object.keys(timers.current) as FileKey[]) {
        if (timers.current[file]) {
          window.clearTimeout(timers.current[file]);
          void save(file);
        }
      }
    },
    [save],
  );

  // In the data view the file is the one chosen; worked out here, before the page reads it, the
  // same way `section` is below.
  const q = query.trim().toLowerCase();
  const dataNames = (Object.keys(files) as FileKey[]).map(dataName).filter((n): n is string => n !== null);
  const dataShown = dataNames.filter((n) => !q || `${n}\n${files[`data:${n}`]!.text}`.toLowerCase().includes(q));
  const dataSection = selected.data && dataShown.includes(selected.data) ? selected.data : dataShown[0];
  const file: FileKey = view === "data" ? `data:${dataSection ?? ""}` : view === "theme" ? "theme" : "site";
  const current = files[file];
  const parsed = useMemo(() => (current ? readConfig(current.text) : null), [current]);
  const defaultsData = useMemo(() => (defaults ? readConfig(defaults).data : undefined), [defaults]);
  const info = useMemo(() => (current ? outline(current.text) : null), [current]);
  const defaultHints = useMemo(() => (defaults ? outline(defaults).hints : new Map<string, string>()), [defaults]);
  const hints = useMemo(() => new Map([...defaultHints, ...(info?.hints ?? [])]), [defaultHints, info]);

  const data = (parsed?.data ?? {}) as Record<string, unknown>;
  const themeDefaults = view === "theme" ? ((defaultsData ?? {}) as Record<string, unknown>) : undefined;

  // In the plugins view, items are plugins by package name, and keys no plugin claims.
  const sections = useMemo(() => pluginSections(Object.keys(data), plugins), [data, plugins]);
  const pluginViews = sections.plugins;
  const pluginView = (k: string) => pluginViews.find((v) => v.plugin.name === k);

  // The sections of this view, under the file's own headers (the theme's) or as one list.
  const groups = useMemo(() => {
    if (view === "data") return [{ title: "", keys: dataNames }];
    if (!info) return [];
    if (view === "theme") {
      const extra = Object.keys(themeDefaults ?? {}).filter((k) => !(k in data));
      if (order === "task") return taskGroups([...Object.keys(data), ...extra]).map((g) => ({ title: g.title, keys: g.items }));
      return extra.length ? [...info.groups, { title: "仅在主题默认里", keys: extra }] : info.groups;
    }
    if (view === "plugins") {
      const withKeys = pluginViews.filter((v) => v.keys.length).map((v) => v.plugin.name);
      const without = pluginViews.filter((v) => !v.keys.length).map((v) => v.plugin.name);
      return [
        { title: "有设置", keys: withKeys },
        { title: "没有设置", keys: without },
        { title: "没有对应插件的设置", keys: sections.unclaimed },
      ].filter((g) => g.keys.length);
    }
    return [{ title: "", keys: Object.keys(data).filter((k) => HEXO_CORE_KEYS.has(k)) }];
  }, [info, view, data, themeDefaults, order, sections, pluginViews, dataNames.join("\n")]);

  const sectionText = (k: string) =>
    view === "data"
      ? `${k}\n${files[`data:${k}`]?.text ?? ""}`.toLowerCase()
      : k === SEARCH_PANEL
      ? `搜索 search ${SEARCH_SERVICES.map((s) => searchText(s.key, data[s.key] ?? themeDefaults?.[s.key], hints)).join("\n")}`
      : view === "plugins" && pluginView(k)
        ? [k, pluginView(k)!.plugin.description ?? "", ...pluginView(k)!.keys.map((key) => searchText(key, data[key], hints))].join("\n").toLowerCase()
        : searchText(k, data[k] ?? themeDefaults?.[k], hints);
  const shownGroups = useMemo(
    () =>
      q
        ? groups
            .map((g) => (g.title.toLowerCase().includes(q) ? g : { ...g, keys: g.keys.filter((k) => sectionText(k).includes(q)) }))
            .filter((g) => g.keys.length)
        : groups,
    [groups, q, data, themeDefaults, hints, files],
  );
  const allKeys = shownGroups.flatMap((g) => g.keys);
  const section = selected[view] && allKeys.includes(selected[view]!) ? selected[view]! : allKeys[0];

  const ops = editsFor(file);
  const ctx: FieldContext = {
    hints,
    defaults: themeDefaults,
    hidden: view === "theme" ? new Set() : HIDDEN,
    addressKeys: view === "site" ? ADDRESS_KEYS : new Set(),
    skip: new Set(),
    images,
    pickImage: (path) => setPicking({ file, path }),
    set: (path, value) => edit(file, (t) => ops.setValue(t, path, value)),
    setMany: (changes) => edit(file, (t) => changes.reduce((acc, [path, value]) => ops.setValue(acc, path, value), t)),
    renameKey: (path, name) => edit(file, (t) => ops.renameKey(t, path, name)),
    removeKey: (path) => edit(file, (t) => ops.removeKey(t, path)),
    append: (path, value) => edit(file, (t) => ops.appendItem(t, path, value)),
    remove: (path, index) => {
      const list = getIn(data, path) as unknown[];
      const item = list[index];
      edit(file, (t) => ops.removeItem(t, path, index));
      const def = themeDefaults ? getIn(themeDefaults, path) : undefined;
      if (Array.isArray(def) && (merge(def, list.filter((_, i) => i !== index)) as unknown[]).some((x) => sameValue(x, item))) {
        toast("已从覆盖文件删除，但主题默认里也有这一项，Hexo 合并后它仍会出现。", "error");
      }
    },
  };

  const restart = async () => {
    setRestarting(true);
    try {
      await api.previewRestart();
      setNeedsRestart(false);
      toast("预览服务器已重启，新配置已生效");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setRestarting(false);
    }
  };

  if (error) return <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-fg-2">{error}</div>;
  if (!files.site) return null;
  const shownPath = current?.path ?? (view === "data" ? "source/_data" : "");

  const themeName = files.theme?.path.replace(/^_config\.|\.yml$/g, "");
  const changedFromDefault = (k: string): boolean =>
    k === SEARCH_PANEL
      ? SEARCH_SERVICES.some((s) => changedFromDefault(s.key))
      : view === "theme" && themeDefaults !== undefined && k in data && k in themeDefaults && !sameValue(data[k], themeDefaults[k]);
  const sectionTitle = (k: string) => (k === SEARCH_PANEL ? "搜索" : k);
  const panelProps = { data, defaults: themeDefaults ?? {}, ctx };

  return (
    <div className="flex h-full min-h-0 flex-col px-5 pb-5">
      <div className="flex shrink-0 items-center gap-3 pb-4 pt-1">
        <div role="tablist" className="flex items-center gap-1">
          {(
            [
              { value: "site", label: "站点", title: "_config.yml 里 Hexo 自己的设置" },
              { value: "plugins", label: "插件", title: "_config.yml 里各插件的设置" },
              ...(files.theme ? [{ value: "theme" as const, label: `主题 · ${themeName}`, title: `${files.theme.path}（Hexo 把它合并到主题默认值上）` }] : []),
              { value: "data", label: "页面数据", title: "source/_data 里友链、相册、装备等页面用的数据" },
            ] as { value: View; label: string; title: string }[]
          ).map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={view === t.value}
              title={t.title}
              onClick={() => setView(t.value)}
              className={cn(
                "h-8 rounded-lg px-3.5 text-[13px] active:!scale-100",
                view === t.value ? "bg-primary font-semibold text-primary-fg shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-fg-2 hover:bg-pill hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={shownPath}>
          {shownPath}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
          {saving === "saving" || saving === "pending" ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              保存中
            </>
          ) : saving === "error" ? (
            <span className="text-danger">保存失败</span>
          ) : (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" />
              已保存
            </>
          )}
        </span>
        <Button variant="ghost" size="icon" title="在 Finder 中显示博客文件夹" onClick={() => void api.revealProject().catch((e) => toast(errorText(e), "error"))}>
          <FolderSearch />
        </Button>
      </div>

      {needsRestart && preview.state === "running" && (
        <div className="mb-3 flex shrink-0 items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">配置已保存。Hexo 只在启动时读取配置，预览服务器重启后才会生效。</span>
          <Button size="sm" variant="outline" disabled={restarting} onClick={() => void restart()}>
            {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />}
            重启预览
          </Button>
        </div>
      )}

      {parsed?.error && view !== "data" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-[13px] text-fg-2">
          <div className="text-danger">{shownPath} 不是有效的 YAML，无法按项编辑：</div>
          <div className="selectable font-mono text-[12px]">{parsed.error}</div>
          <div className="text-muted">请在编辑器里修好后回到这里。</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-5">
          <aside className="flex w-[268px] shrink-0 flex-col gap-2.5">
            {view === "theme" && (
              <Segmented
                value={order}
                onChange={setOrder}
                className="self-start"
                options={[
                  { value: "task", label: "按用途", title: "按要做的事分组" },
                  { value: "file", label: "按文件", title: "按主题配置文件里原有的段落" },
                ]}
              />
            )}
            <div className="relative shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索键名、说明、值" className="field h-9 rounded-lg pl-8 text-[13px]" />
            </div>
            <nav className="-mr-1 min-h-0 flex-1 overflow-y-auto pb-3 pr-1">
              {shownGroups.length === 0 && <div className="px-2 py-3 text-[12.5px] text-muted">{q ? "没有匹配的设置" : "这里没有设置"}</div>}
              {shownGroups.map((g, gi) => (
                <div key={gi} className="space-y-0.5 pb-4">
                  {g.title && (
                    <div className="group-label truncate px-2.5 pb-1.5 pt-1" title={g.title}>
                      {g.title}
                    </div>
                  )}
                  {g.keys.map((k) => {
                    const p = view === "plugins" ? pluginView(k)?.plugin : undefined;
                    const d = view === "data" ? readConfig(files[`data:${k}`]?.text ?? "").data : undefined;
                    const hint =
                      view === "data"
                        ? Array.isArray(d) ? `${d.length} 组` : brief(d)
                        : k === SEARCH_PANEL
                          ? "Algolia、本地搜索、DocSearch 三选一"
                          : p
                            ? p.version ? `${p.version} · ${p.description ?? ""}` : "没有安装"
                            : hints.get(pathKey([k])) || brief(data[k] ?? themeDefaults?.[k]);
                    const active = k === section;
                    // Every row has two lines (name, then its note or a word on its value), so the list is even.
                    return (
                      <button
                        key={k}
                        onClick={() => setSelected((s) => ({ ...s, [view]: k }))}
                        aria-current={active ? "true" : undefined}
                        className={cn(
                          "flex h-list w-full items-center gap-2 rounded-lg px-3 text-left active:!scale-100",
                          active ? "bg-brand-soft" : "hover:bg-pill",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-[13px] leading-5", k !== SEARCH_PANEL && "font-mono", active ? "font-semibold text-brand" : "text-fg")}>{sectionTitle(k)}</span>
                          <span className={cn("block truncate text-[11.5px] leading-4", active ? "text-brand/75" : "text-muted")}>{hint}</span>
                        </span>
                        {changedFromDefault(k) && <span title="与主题默认值不同" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          </aside>

          <section className="list-card min-h-0 min-w-0 flex-1 overflow-y-auto px-7 py-6">
            {section ? (
              <div key={`${view}:${section}`} className="view-in">
                <div className="mb-4 border-b-[0.5px] border-line-2 pb-4">
                  <div className="flex items-center gap-2">
                    <h2 className={cn("selectable text-[17px] font-semibold", section !== SEARCH_PANEL && "font-mono")}>{sectionTitle(section)}</h2>
                    {changedFromDefault(section) && <span className="rounded bg-brand-soft px-1.5 text-[11px] text-brand">已改动</span>}
                    {view === "theme" && section !== SEARCH_PANEL && !(section in data) && <span className="rounded bg-pill px-1.5 text-[11px] text-muted">仅在主题默认里，修改会写进 {files.theme?.path}</span>}
                  </div>
                  {view === "plugins" && pluginView(section) ? (
                    pluginView(section)!.plugin.description && <div className="mt-0.5 text-[12px] text-muted">{pluginView(section)!.plugin.description}</div>
                  ) : (
                    hints.get(pathKey([section])) && <div className="mt-0.5 text-[12px] text-muted">{hints.get(pathKey([section]))}</div>
                  )}
                </div>
                {view === "data" && parsed?.error ? (
                  <div className="space-y-1 text-[13px]">
                    <div className="text-danger">这个文件有语法错误，无法按项编辑：</div>
                    <div className="selectable font-mono text-[12px] text-fg-2">{parsed.error}</div>
                  </div>
                ) : view === "data" ? (
                  <DataFilePanel name={section} data={parsed?.data} ctx={ctx} />
                ) : view === "plugins" && pluginView(section) ? (
                  <PluginPanel view={pluginView(section)!} data={data} ctx={ctx} onError={(m) => toast(m, "error")} />
                ) : view === "theme" && section === SEARCH_PANEL ? (
                  <SearchPanel {...panelProps} />
                ) : view === "theme" && section === "comments" ? (
                  <CommentsPanel {...panelProps} />
                ) : view === "theme" && section === "aside" ? (
                  <AsidePanel {...panelProps} />
                ) : (
                  <Field path={[section]} value={data[section]} def={themeDefaults?.[section]} ctx={ctx} />
                )}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-muted">选择左边的一项</div>
            )}
          </section>
        </div>
      )}
      <ImagePicker
        open={picking !== null}
        purpose="config"
        postId={null}
        onClose={() => setPicking(null)}
        onPick={(img) => {
          if (picking) edit(picking.file, (t) => editsFor(picking.file).setValue(t, picking.path, img.url));
          setPicking(null);
        }}
      />
    </div>
  );
}
