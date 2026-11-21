import { AlertTriangle, CheckCircle2, CircleSlash, ExternalLink, Eraser, Hammer, Loader2, Rocket, Square, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { api, errorText, onEvent, type BlogConfigView, type Problem, type Run, type RunLine, type Task } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DeployPageProps {
  config: BlogConfigView | null;
}

/** Runs as the page shows them: the history kept by the app, updated by its events. */
function useRuns(): Run[] {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    void api.listRuns().then(setRuns).catch(() => {});
    const offs = [
      onEvent<Run>("run-started", (r) => setRuns((v) => [...v.filter((x) => x.id !== r.id), r].slice(-10))),
      onEvent<{ run: number; line: RunLine }>("run-line", ({ run, line }) =>
        setRuns((v) => v.map((r) => (r.id === run ? { ...r, lines: [...r.lines, line] } : r))),
      ),
      onEvent<Run>("run-finished", (r) => setRuns((v) => v.map((x) => (x.id === r.id ? r : x)))),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  return runs;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function duration(r: Run): string {
  const s = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

function StatusIcon({ run }: { run: Run }) {
  switch (run.status) {
    case "running":
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" />;
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />;
    case "failed":
      return <XCircle className="h-4 w-4 shrink-0 text-danger" />;
    default:
      return <CircleSlash className="h-4 w-4 shrink-0 text-muted" />;
  }
}

function ProblemCard({ problem }: { problem: Problem }) {
  const toast = useToast();
  const box = "space-y-1.5 rounded-lg bg-danger-soft px-3.5 py-3 text-[12.5px] leading-5 text-fg";
  switch (problem.kind) {
    case "pushProtection":
      return (
        <div className={box}>
          <div className="font-medium text-danger">GitHub 推送保护（GH013）拦下了这次部署</div>
          <div className="text-fg-2">
            GitHub 在生成的文件里认出了疑似密钥。博客以前遇到过：Twikoo 打包文件里的示例 SecretId 被误报。确认是误报后，打开下面的链接选择允许，再重新部署。
          </div>
          {problem.secrets.map((s, i) => (
            <div key={i} className="selectable font-mono text-[11.5px] text-fg-2">
              {s.kind}：{s.paths.join("，") || "（未列出文件）"}
            </div>
          ))}
          {problem.unblockUrls.map((u) => (
            <button key={u} onClick={() => void api.openUrl(u).catch((e) => toast(errorText(e), "error"))} className="flex max-w-full items-center gap-1 text-left text-accent hover:underline">
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{u}</span>
            </button>
          ))}
          {problem.unblockUrls.length === 0 && <div className="text-fg-2">输出里没有找到放行链接，请看下面完整日志里 GitHub 给出的地址。</div>}
        </div>
      );
    case "sshAuth":
      return (
        <div className={box}>
          <div className="font-medium text-danger">git 无法通过 SSH 登录 GitHub</div>
          <div className="text-fg-2">
            在“终端”里执行 <span className="selectable font-mono">ssh -T git@github.com</span> 看能否登录。密钥有口令时，先执行{" "}
            <span className="selectable font-mono">ssh-add --apple-use-keychain ~/.ssh/id_ed25519</span>（换成你的密钥）把口令存进钥匙串，再重新部署。
          </div>
        </div>
      );
    case "missingModules":
      return (
        <div className={box}>
          <div className="font-medium text-danger">博客缺少依赖</div>
          <div className="text-fg-2">
            在博客目录执行 <span className="selectable font-mono">npm install</span> 后再试。
          </div>
        </div>
      );
    case "gitIdentity":
      return (
        <div className={box}>
          <div className="font-medium text-danger">git 没有设置提交者</div>
          <div className="text-fg-2">
            在“终端”里执行 <span className="selectable font-mono">git config --global user.name "你的名字"</span> 和{" "}
            <span className="selectable font-mono">git config --global user.email "你的邮箱"</span>，再重新部署。
          </div>
        </div>
      );
  }
}

function RunLog({ run }: { run: Run }) {
  const end = useRef<HTMLDivElement>(null);
  // A block body: newer engines return a Promise from scrollIntoView, which React would take
  // for the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [run.lines.length, run.id]);
  return (
    <div className="selectable min-h-0 flex-1 overflow-auto rounded-lg bg-card-2 px-3 py-2 font-mono text-[11.5px] leading-[18px] shadow-card">
      {run.notes.map((n, i) => (
        <div key={`n${i}`} className="text-warn">
          {n}
        </div>
      ))}
      {run.lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre-wrap break-all",
            l.text.startsWith("$ ") ? "mt-1 font-semibold text-fg" : l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warn" : "text-fg-2",
          )}
        >
          {l.text || " "}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

export function DeployPage({ config }: DeployPageProps) {
  const toast = useToast();
  const runs = useRuns();
  const [selected, setSelected] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ changes: number | null } | null>(null);
  const running = runs.find((r) => r.status === "running");
  const shown = useMemo(() => runs.find((r) => r.id === selected) ?? runs[runs.length - 1] ?? null, [runs, selected]);
  const target = config?.deploy[0];

  const start = async (task: Task) => {
    try {
      setSelected(await api.runTask(task));
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const askDeploy = async () => {
    const changes = await api.blogGitChanges().catch(() => null);
    setConfirm({ changes });
  };

  return (
    <div className="flex h-full min-h-0 flex-col px-5 pb-5">
      <div className="flex shrink-0 items-center gap-2 pb-4 pt-1">
        <div className="min-w-0 flex-1 text-[12.5px] leading-5 text-fg-2">
          {target ? (
            <>
              部署到 <span className="selectable font-mono text-fg">{target.repo ?? target.kind}</span>
              {target.branch && (
                <>
                  {" "}
                  的 <span className="font-mono text-fg">{target.branch}</span> 分支
                </>
              )}
              ，与命令行 <span className="font-mono">hexo clean && hexo generate && hexo deploy</span> 相同。
            </>
          ) : (
            "_config.yml 里没有配置 deploy。"
          )}
        </div>
        {running ? (
          <Button variant="outline" onClick={() => void api.cancelRun()}>
            <Square />
            停止
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => void start({ kind: "clean" })} title="hexo clean：删除 db.json 和 public/">
              <Eraser />
              清理
            </Button>
            <Button variant="outline" onClick={() => void start({ kind: "generate" })} title="hexo generate：生成 public/">
              <Hammer />
              生成
            </Button>
            <Button variant="brand" disabled={!target} onClick={() => void askDeploy()}>
              <Rocket />
              部署
            </Button>
          </>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-center text-[13px] leading-6 text-muted">
          还没有运行记录。
          <br />
          清理、生成、部署时会先停止预览服务器，结束后自动恢复。
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="w-[200px] shrink-0 space-y-1 overflow-y-auto">
            <div className="group-label">最近运行</div>
            {[...runs].reverse().map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r.id)}
                className={cn("flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left active:!scale-100", shown?.id === r.id ? "bg-card shadow-edge dark:bg-white/[.07]" : "hover:bg-pill")}
              >
                <StatusIcon run={r} />
                <div className="min-w-0">
                  <div className="truncate text-[13px]">{r.label}</div>
                  <div className="text-[11.5px] text-muted">
                    {clock(r.startedAt)} · {duration(r)}
                  </div>
                </div>
              </button>
            ))}
          </div>
          {shown && (
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              {shown.problems.map((p, i) => (
                <ProblemCard key={i} problem={p} />
              ))}
              {shown.status === "failed" && shown.problems.length === 0 && (
                <div className="flex items-center gap-1.5 text-[12.5px] text-danger">
                  <AlertTriangle className="h-4 w-4" />
                  {shown.label}失败，红色的行是出错的地方。
                </div>
              )}
              <RunLog run={shown} />
            </div>
          )}
        </div>
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="部署到线上？"
        description={
          <>
            将执行 hexo clean、generate、deploy，把生成的网站推送到 <span className="font-mono">{target?.repo}</span>
            {target?.branch ? `（${target.branch}）` : ""}。
          </>
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              variant="brand"
              onClick={() => {
                setConfirm(null);
                void start({ kind: "deploy" });
              }}
            >
              <Rocket />
              部署
            </Button>
          </>
        }
      >
        {confirm?.changes ? (
          <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] leading-5 text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            博客源码仓库有 {confirm.changes} 个文件的改动还没有提交。部署不受影响，只是提醒你记得提交源码。
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
