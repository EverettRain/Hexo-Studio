import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, GitBranch, GitCommitHorizontal, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type ChangeKind, type SourceCommit, type SourceCommitDetail, type SourceStatus } from "@/lib/api";
import { useOnShow } from "@/lib/pageActive";
import { cn } from "@/lib/utils";

const PAGE = 30;

const kindBadge: Record<ChangeKind, { letter: string; label: string; className: string }> = {
  added: { letter: "A", label: "新增", className: "text-ok" },
  untracked: { letter: "U", label: "未跟踪的新文件", className: "text-ok" },
  modified: { letter: "M", label: "修改", className: "text-warn" },
  renamed: { letter: "R", label: "重命名", className: "text-warn" },
  deleted: { letter: "D", label: "删除", className: "text-danger" },
  conflicted: { letter: "!", label: "冲突", className: "text-danger" },
};

function Badge({ kind }: { kind: ChangeKind }) {
  const b = kindBadge[kind];
  return (
    <span title={b.label} className={cn("w-3 shrink-0 text-center font-mono font-semibold", b.className)}>
      {b.letter}
    </span>
  );
}

function when(seconds: number, long = false): string {
  return new Date(seconds * 1000).toLocaleString("zh-CN", {
    hour12: false,
    ...(long ? { year: "numeric" } : {}),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Where the branch stands against its remote, in words. */
function tracking(s: SourceStatus): string {
  if (!s.branch) return "不在任何分支上（HEAD 游离）";
  if (!s.upstream) return "还没有推送到远程";
  if (s.upstreamGone) return `${s.upstream} 在远程上不存在`;
  if (s.ahead === 0 && s.behind === 0) return `与 ${s.upstream} 同步`;
  return [s.ahead > 0 && `领先 ${s.upstream} ${s.ahead} 个提交`, s.behind > 0 && `落后 ${s.behind} 个提交`].filter(Boolean).join("，");
}

/** A commit's message and the files it changed, read when it is selected; shown in the changes box. */
function CommitView({ commit, unpushed }: { commit: SourceCommit; unpushed: boolean }) {
  const [detail, setDetail] = useState<SourceCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { hash } = commit;

  useEffect(() => {
    setDetail(null);
    setError(null);
    let alive = true;
    api.sourceCommitDetail(hash).then(
      (d) => alive && setDetail(d),
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [hash]);

  const totals = detail?.files.reduce((t, f) => ({ added: t.added + (f.added ?? 0), removed: t.removed + (f.removed ?? 0) }), { added: 0, removed: 0 });

  return (
    <div className="selectable flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1 border-b-[0.5px] border-line-2 px-3.5 pb-2.5 pt-3">
        <div className="text-[14px] font-semibold leading-5">{commit.subject}</div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted">
          <span className="font-mono">{hash.slice(0, 10)}</span>·<span>{detail ? `${commit.author} <${detail.email}>` : commit.author}</span>·<span>{when(commit.time, true)}</span>
          {unpushed && <span className="rounded bg-warn-soft px-1.5 text-warn">未推送</span>}
        </div>
      </div>
      {error ? (
        <div className="whitespace-pre-wrap px-3.5 py-3 text-[12.5px] text-danger">{error}</div>
      ) : !detail ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取…
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {detail.body && <div className="whitespace-pre-wrap border-b-[0.5px] border-line-2 px-3.5 py-3 text-[13px] leading-6">{detail.body}</div>}
          <div className="flex items-baseline gap-2 px-3.5 pb-1 pt-2.5 text-[11.5px] text-muted">
            {detail.files.length} 个文件
            {totals && (
              <span className="font-mono">
                <span className="text-ok">+{totals.added}</span> <span className="text-danger">−{totals.removed}</span>
              </span>
            )}
          </div>
          <div className="pb-1">
            {detail.files.length === 0 && <div className="px-3.5 py-1 text-[12px] text-muted">没有文件改动（空提交或合并）</div>}
            {detail.files.map((f) => (
              <div key={f.path} className="flex items-baseline gap-2.5 px-3.5 py-[3px] text-[12px] leading-5">
                <Badge kind={f.kind} />
                <span className="min-w-0 flex-1 break-all font-mono text-fg-2">
                  {f.path}
                  {f.from && <span className="text-muted"> ← {f.from}</span>}
                </span>
                <span className="shrink-0 font-mono text-[11.5px]">
                  {f.added === null ? (
                    <span className="text-muted">二进制</span>
                  ) : (
                    <>
                      <span className="text-ok">+{f.added}</span> <span className="text-danger">−{f.removed}</span>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The blog's own git repository (its sources, not the deploy repository): commit and push.
 * Nothing waits for git before the page appears: the status and the history load on their own,
 * what is already shown stays while it reads again, and a commit's details are read when opened.
 */
export function SourcePage() {
  const toast = useToast();
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [commits, setCommits] = useState<SourceCommit[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | "pull" | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  // The box on the left shows either the working changes or the commit picked in the history.
  const [picked, setPicked] = useState<SourceCommit | null>(null);
  const [showing, setShowing] = useState<"changes" | "commit">("changes");
  // Only the newest read may update the page; an older one that ends later is dropped.
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    setReading((n) => n + 2);
    const done = () => setReading((n) => n - 1);
    api.sourceStatus().then(
      (s) => {
        if (current()) {
          setStatus(s);
          setError(null);
        }
      },
      (e) => current() && setError(errorText(e)),
    ).finally(done);
    api.sourceCommits(0).then(
      (c) => {
        if (current()) {
          setCommits(c);
          setHasMore(c.length === PAGE);
        }
      },
      () => {},
    ).finally(done);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useOnShow(refresh);

  const loadMore = async () => {
    if (!commits) return;
    const mine = generation.current;
    setMoreBusy(true);
    try {
      const next = await api.sourceCommits(commits.length);
      if (mine !== generation.current) return;
      setCommits([...commits, ...next]);
      setHasMore(next.length === PAGE);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setMoreBusy(false);
    }
  };

  const act = async (kind: "commit" | "push" | "pull", run: () => Promise<void>, done: string) => {
    setBusy(kind);
    try {
      await run();
      toast(done, "success");
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const commit = () => void act("commit", () => api.sourceCommit(title, body), "已提交").then((ok) => ok && (setTitle(""), setBody("")));

  if (error && !status) {
    return <div className="flex h-full items-center justify-center px-8 text-center text-[13px] leading-6 text-fg-2">{error.includes("not a git repository") ? "这个博客文件夹不是 git 仓库。" : error}</div>;
  }

  const conflicted = status?.changes.some((c) => c.kind === "conflicted") ?? false;
  const canCommit = !!status && status.changes.length > 0 && title.trim() !== "" && !conflicted && busy === null;
  const needsPush = !!status && (status.ahead > 0 || !status.upstream || status.upstreamGone);
  const canPush = !!status?.branch && needsPush && status.behind === 0 && (commits?.length ?? 0) > 0 && busy === null;
  const target = status && status.upstream && !status.upstreamGone ? status.upstream : `origin/${status?.branch}`;
  const ahead = status?.ahead ?? 0;
  const pickedIndex = picked ? (commits?.findIndex((c) => c.hash === picked.hash) ?? -1) : -1;
  const viewingCommit = showing === "commit" && picked !== null;

  return (
    <div className="flex h-full min-h-0 flex-col px-5 pb-5">
      <div className="flex shrink-0 items-center gap-2 pb-4 pt-1">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] leading-5 text-fg-2">
          <GitBranch className="h-4 w-4 shrink-0 text-muted" />
          {status ? (
            <>
              <span className="font-mono text-[13px] font-medium text-fg">{status.branch ?? "HEAD"}</span>
              <span className="truncate">{tracking(status)}</span>
            </>
          ) : (
            <span className="text-muted">正在读取…</span>
          )}
        </div>
        <Button variant="ghost" size="icon" title="重新读取" disabled={busy !== null} onClick={refresh}>
          <RefreshCw className={cn(reading > 0 && "animate-spin")} />
        </Button>
        <Button
          variant="outline"
          disabled={!status?.upstream || status.upstreamGone || busy !== null}
          title="git pull --ff-only：只接受快进，不产生合并提交"
          onClick={() => void act("pull", api.sourcePull, "已拉取")}
        >
          {busy === "pull" ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
          拉取{status && status.behind > 0 ? `（${status.behind}）` : ""}
        </Button>
        <Button variant="brand" disabled={!canPush} onClick={() => setConfirmPush(true)}>
          {busy === "push" ? <Loader2 className="animate-spin" /> : <ArrowUpFromLine />}
          推送{ahead > 0 ? `（${ahead}）` : ""}
        </Button>
      </div>

      {status && status.behind > 0 && (
        <div className="mb-3 flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] leading-5 text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          远程有 {status.behind} 个本地还没有的提交，先拉取再推送。
        </div>
      )}
      {conflicted && (
        <div className="mb-3 flex gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] leading-5 text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          有文件处于冲突状态，在终端或编辑器里解决后才能提交。
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <Segmented
            value={viewingCommit ? "commit" : "changes"}
            onChange={setShowing}
            className="self-start"
            options={[
              { value: "changes", label: `改动${status ? `（${status.changes.length}）` : ""}`, title: "尚未提交的改动" },
              ...(picked ? [{ value: "commit" as const, label: `提交 ${picked.hash.slice(0, 7)}`, title: picked.subject }] : []),
            ]}
          />
          <div className="selectable min-h-0 flex-1 overflow-y-auto rounded-lg bg-card-2 py-1 shadow-card">
            {viewingCommit ? (
              <CommitView commit={picked} unpushed={pickedIndex >= 0 && pickedIndex < ahead} />
            ) : !status ? (
              <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在读取…
              </div>
            ) : status.changes.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[13px] text-muted">没有未提交的改动</div>
            ) : (
              status.changes.map((c) => (
                <div key={c.path} className="flex items-baseline gap-2.5 px-3 py-[3px] text-[12px] leading-5">
                  <Badge kind={c.kind} />
                  <span className="min-w-0 break-all font-mono text-fg-2">
                    {c.path}
                    {c.from && <span className="text-muted"> ← {c.from}</span>}
                  </span>
                </div>
              ))
            )}
          </div>
          {!viewingCommit && (
            <>
              <div className="shrink-0 space-y-2">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value.replace(/[\r\n]+/g, " "))}
                  placeholder="标题，例如：新文章《…》"
                  aria-label="提交标题"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
                      e.preventDefault();
                      commit();
                    }
                  }}
                />
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="说明（可选）：改了什么、为什么"
                  aria-label="提交说明"
                  className="min-h-[64px] font-sans text-[13px]"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
                      e.preventDefault();
                      commit();
                    }
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center justify-between gap-2">
                <span className="text-[11.5px] text-muted">会提交列出的全部改动（含新文件）。⌘↵ 提交。</span>
                <Button disabled={!canCommit} onClick={commit}>
                  {busy === "commit" ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}
                  提交全部改动
                </Button>
              </div>
            </>
          )}
        </section>

        <section className="flex w-[300px] shrink-0 flex-col gap-3">
          <div className="group-label">最近提交</div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {commits === null && (
              <div className="flex items-center gap-2 px-2 text-[13px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在读取…
              </div>
            )}
            {commits?.length === 0 && <div className="px-2 text-[13px] text-muted">还没有提交</div>}
            {commits?.map((c, i) => (
              <button
                key={c.hash}
                onClick={() => {
                  const same = viewingCommit && picked?.hash === c.hash;
                  setPicked(c);
                  setShowing(same ? "changes" : "commit");
                }}
                aria-pressed={viewingCommit && picked?.hash === c.hash}
                className={cn(
                  "block w-full rounded-control px-2 py-1.5 text-left active:!scale-100",
                  viewingCommit && picked?.hash === c.hash ? "bg-raised shadow-edge" : "hover:bg-pill",
                )}
              >
                <div className="line-clamp-2 text-[13px] leading-5">{c.subject}</div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
                  <span className="font-mono">{c.hash.slice(0, 7)}</span>
                  <span>·</span>
                  <span>{when(c.time)}</span>
                  {i < ahead && <span className="rounded bg-warn-soft px-1.5 text-warn">未推送</span>}
                </div>
              </button>
            ))}
            {hasMore && (
              <Button variant="ghost" size="sm" className="w-full" disabled={moreBusy} onClick={() => void loadMore()}>
                {moreBusy && <Loader2 className="animate-spin" />}
                加载更多
              </Button>
            )}
          </div>
        </section>
      </div>

      <Dialog
        open={confirmPush}
        onClose={() => setConfirmPush(false)}
        title="推送到远程？"
        description={
          <>
            将把 <span className="font-mono">{status?.branch}</span> 分支{ahead > 0 ? `的 ${ahead} 个提交` : ""}推送到 <span className="font-mono">{target}</span>
            {status?.upstream && !status.upstreamGone ? "" : "，并把它设为这个分支的上游"}。
          </>
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmPush(false)}>
              取消
            </Button>
            <Button
              variant="brand"
              onClick={() => {
                setConfirmPush(false);
                void act("push", api.sourcePush, "已推送");
              }}
            >
              <ArrowUpFromLine />
              推送
            </Button>
          </>
        }
      />
    </div>
  );
}
