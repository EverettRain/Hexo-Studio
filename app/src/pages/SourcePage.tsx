import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, GitBranch, GitCommitHorizontal, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type ChangeKind, type SourceView } from "@/lib/api";
import { useOnShow } from "@/lib/pageActive";
import { cn } from "@/lib/utils";

const kindBadge: Record<ChangeKind, { letter: string; label: string; className: string }> = {
  added: { letter: "A", label: "新增", className: "text-ok" },
  untracked: { letter: "U", label: "未跟踪的新文件", className: "text-ok" },
  modified: { letter: "M", label: "修改", className: "text-warn" },
  renamed: { letter: "R", label: "重命名", className: "text-warn" },
  deleted: { letter: "D", label: "删除", className: "text-danger" },
  conflicted: { letter: "!", label: "冲突", className: "text-danger" },
};

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Where the branch stands against its remote, in words. */
function tracking(s: SourceView["status"]): string {
  if (!s.branch) return "不在任何分支上（HEAD 游离）";
  if (!s.upstream) return "还没有推送到远程";
  if (s.upstreamGone) return `${s.upstream} 在远程上不存在`;
  if (s.ahead === 0 && s.behind === 0) return `与 ${s.upstream} 同步`;
  return [s.ahead > 0 && `领先 ${s.upstream} ${s.ahead} 个提交`, s.behind > 0 && `落后 ${s.behind} 个提交`].filter(Boolean).join("，");
}

/** The blog's own git repository (its sources, not the deploy repository): commit and push. */
export function SourcePage() {
  const toast = useToast();
  const [view, setView] = useState<SourceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | "pull" | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setView(await api.sourceOverview());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useOnShow(() => void refresh());

  const act = async (kind: "commit" | "push" | "pull", run: () => Promise<SourceView>, done: string) => {
    setBusy(kind);
    try {
      setView(await run());
      setError(null);
      toast(done, "success");
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      void refresh();
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (error && !view) {
    return <div className="flex h-full items-center justify-center px-8 text-center text-[13px] leading-6 text-fg-2">{error.includes("not a git repository") ? "这个博客文件夹不是 git 仓库。" : error}</div>;
  }
  if (!view) return null;

  const { status, commits } = view;
  const conflicted = status.changes.some((c) => c.kind === "conflicted");
  const canCommit = status.changes.length > 0 && message.trim() !== "" && !conflicted && busy === null;
  const needsPush = status.ahead > 0 || !status.upstream || status.upstreamGone;
  const canPush = !!status.branch && needsPush && status.behind === 0 && commits.length > 0 && busy === null;
  const target = status.upstream && !status.upstreamGone ? status.upstream : `origin/${status.branch}`;

  return (
    <div className="flex h-full min-h-0 flex-col px-5 pb-5">
      <div className="flex shrink-0 items-center gap-2 pb-4 pt-1">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] leading-5 text-fg-2">
          <GitBranch className="h-4 w-4 shrink-0 text-muted" />
          <span className="font-mono text-[13px] font-medium text-fg">{status.branch ?? "HEAD"}</span>
          <span className="truncate">{tracking(status)}</span>
        </div>
        <Button variant="ghost" size="icon" title="重新读取" disabled={busy !== null} onClick={() => void refresh()}>
          <RefreshCw />
        </Button>
        <Button
          variant="outline"
          disabled={!status.upstream || status.upstreamGone || busy !== null}
          title="git pull --ff-only：只接受快进，不产生合并提交"
          onClick={() => void act("pull", api.sourcePull, "已拉取")}
        >
          {busy === "pull" ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
          拉取{status.behind > 0 ? `（${status.behind}）` : ""}
        </Button>
        <Button variant="brand" disabled={!canPush} onClick={() => setConfirmPush(true)}>
          {busy === "push" ? <Loader2 className="animate-spin" /> : <ArrowUpFromLine />}
          推送{status.ahead > 0 ? `（${status.ahead}）` : ""}
        </Button>
      </div>

      {status.behind > 0 && (
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
          <div className="group-label">改动（{status.changes.length}）</div>
          <div className="selectable min-h-0 flex-1 overflow-y-auto rounded-lg bg-card-2 py-1 shadow-card">
            {status.changes.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[13px] text-muted">没有未提交的改动</div>
            ) : (
              status.changes.map((c) => (
                <div key={c.path} className="flex items-baseline gap-2.5 px-3 py-[3px] text-[12px] leading-5">
                  <span title={kindBadge[c.kind].label} className={cn("w-3 shrink-0 text-center font-mono font-semibold", kindBadge[c.kind].className)}>
                    {kindBadge[c.kind].letter}
                  </span>
                  <span className="min-w-0 break-all font-mono text-fg-2">
                    {c.path}
                    {c.from && <span className="text-muted"> ← {c.from}</span>}
                  </span>
                </div>
              ))
            )}
          </div>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="提交说明，第一行是标题，例如：新文章《…》"
            className="shrink-0 font-sans text-[13px]"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
                e.preventDefault();
                void act("commit", () => api.sourceCommit(message), "已提交").then((ok) => ok && setMessage(""));
              }
            }}
          />
          <div className="flex shrink-0 items-center justify-between gap-2">
            <span className="text-[11.5px] text-muted">会提交列出的全部改动（含新文件）。⌘↵ 提交。</span>
            <Button
              disabled={!canCommit}
              onClick={() => void act("commit", () => api.sourceCommit(message), "已提交").then((ok) => ok && setMessage(""))}
            >
              {busy === "commit" ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}
              提交全部改动
            </Button>
          </div>
        </section>

        <section className="flex w-[300px] shrink-0 flex-col gap-3">
          <div className="group-label">最近提交</div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {commits.length === 0 && <div className="px-2 text-[13px] text-muted">还没有提交</div>}
            {commits.map((c, i) => (
              <div key={c.hash} className="rounded-[7px] px-2 py-1.5">
                <div className="selectable text-[13px] leading-5">{c.subject}</div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
                  <span className="font-mono">{c.hash.slice(0, 7)}</span>
                  <span>·</span>
                  <span>{when(c.time)}</span>
                  {i < status.ahead && <span className="rounded bg-warn-soft px-1.5 text-warn">未推送</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Dialog
        open={confirmPush}
        onClose={() => setConfirmPush(false)}
        title="推送到远程？"
        description={
          <>
            将把 <span className="font-mono">{status.branch}</span> 分支{status.ahead > 0 ? `的 ${status.ahead} 个提交` : ""}推送到 <span className="font-mono">{target}</span>
            {status.upstream && !status.upstreamGone ? "" : "，并把它设为这个分支的上游"}。
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
