import { RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PostSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

interface PostsPageProps {
  posts: PostSummary[] | null;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  /** Extra actions in the toolbar (new post, ...). */
  actions?: React.ReactNode;
}

const byDate = (a: PostSummary, b: PostSummary) => (b.date ?? "").localeCompare(a.date ?? "") || b.modified - a.modified;

function matches(p: PostSummary, q: string): boolean {
  if (!q) return true;
  const hay = [p.title ?? "", p.fileName, ...p.tags, ...p.categories].join("\n").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function PostRow({ post, onOpen }: { post: PostSummary; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-4 px-4 py-item text-left hover:bg-pill/60 active:!scale-100">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium">{post.title || <span className="text-muted">（无标题）{post.fileName}</span>}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          {post.categories.length > 0 && <span className="shrink-0 text-fg-2">{post.categories.join(" / ")}</span>}
          {post.tags.length > 0 && <span className="truncate">{post.tags.map((t) => `#${t}`).join(" ")}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted">{post.date ? post.date.slice(0, 16) : "无日期"}</div>
    </button>
  );
}

export function PostsPage({ posts, onOpen, onRefresh, actions }: PostsPageProps) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const shown = (posts ?? []).filter((p) => matches(p, query.trim()));
    return [
      { label: "草稿", items: shown.filter((p) => p.kind === "draft").sort(byDate) },
      { label: "已发布", items: shown.filter((p) => p.kind === "post").sort(byDate) },
    ];
  }, [posts, query]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="view-in mx-auto w-full max-w-[860px] px-5 pb-10">
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-bg pb-3 pt-1">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索标题、标签、分类" className="field pl-8" />
          </div>
          <Button variant="outline" size="icon" title="刷新" onClick={onRefresh}>
            <RefreshCw />
          </Button>
          {actions}
        </div>
        {posts === null ? (
          <div className="py-10 text-center text-[13px] text-muted">读取中…</div>
        ) : (
          groups.map(
            (g) =>
              g.items.length > 0 && (
                <section key={g.label} className="mb-5">
                  <div className="group-label">
                    {g.label} · {g.items.length}
                  </div>
                  <div className={cn("list-card")}>
                    {g.items.map((p) => (
                      <PostRow key={p.id} post={p} onOpen={() => onOpen(p.id)} />
                    ))}
                  </div>
                </section>
              ),
          )
        )}
        {posts !== null && groups.every((g) => g.items.length === 0) && (
          <div className="py-10 text-center text-[13px] text-muted">{query ? "没有匹配的文章" : "还没有文章"}</div>
        )}
      </div>
    </div>
  );
}
