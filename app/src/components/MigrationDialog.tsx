import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api, errorText, onEvent, type MigrationProgress, type MigrationReport, type PlannedMove } from "@/lib/api";

type Phase = { kind: "loading" } | { kind: "plan"; moves: PlannedMove[] } | { kind: "running"; progress: MigrationProgress } | { kind: "done"; report: MigrationReport } | { kind: "error"; message: string };

/**
 * Moving the old, flat images to `<project>/<page>/<name>.webp`: shows the plan first (nothing
 * changes until confirmed), then progress, then what moved and which files were rewritten.
 */
export function MigrationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: "loading" });
    api.migrationPlan().then(
      (moves) => setPhase({ kind: "plan", moves }),
      (e) => setPhase({ kind: "error", message: errorText(e) }),
    );
  }, [open]);

  const start = async (total: number) => {
    setPhase({ kind: "running", progress: { done: 0, total, current: "" } });
    const off = onEvent<MigrationProgress>("migration-progress", (progress) => setPhase((p) => (p.kind === "running" ? { kind: "running", progress } : p)));
    try {
      setPhase({ kind: "done", report: await api.runMigration() });
    } catch (e) {
      setPhase({ kind: "error", message: errorText(e) });
    } finally {
      off();
    }
  };

  const running = phase.kind === "running";
  const footer =
    phase.kind === "plan" ? (
      <>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button variant="brand" disabled={phase.moves.length === 0} onClick={() => void start(phase.moves.length)}>
          迁移 {phase.moves.length} 张图片
        </Button>
      </>
    ) : (
      <Button disabled={running} onClick={onClose}>
        {phase.kind === "done" ? "完成" : "关闭"}
      </Button>
    );

  return (
    <Dialog
      open={open}
      onClose={() => !running && onClose()}
      title="迁移旧图片"
      className="max-w-[680px]"
      description="把桶里平铺的旧图读出来，原图存一份到本机母图目录，转成 WebP 后放到 <项目名>/<页面名>/，再把博客里的地址改成新地址。旧对象不会删除。"
      footer={footer}
    >
      {phase.kind === "loading" && (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在扫描博客里的图片地址…
        </div>
      )}
      {phase.kind === "error" && <div className="selectable whitespace-pre-wrap text-[12.5px] text-danger">{phase.message}</div>}
      {phase.kind === "plan" &&
        (phase.moves.length === 0 ? (
          <div className="py-4 text-[13px] text-muted">没有需要迁移的图片：博客里这个存储的图片都已经在项目目录下了。</div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12px] leading-5 text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              会改写 {new Set(phase.moves.flatMap((m) => m.files)).size} 个文件里的图片地址（只替换地址本身）。建议先提交博客源码，迁移后检查预览，再部署。
            </div>
            <div className="max-h-[46vh] overflow-y-auto rounded-lg bg-card-2 shadow-card">
              {phase.moves.map((m) => (
                <div key={m.oldKey} className="border-b-[0.5px] border-line-2 px-3 py-1.5 last:border-0">
                  <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
                    <span className="truncate text-fg-2">{m.oldKey}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted" />
                    <span className="truncate text-fg">{m.newKey}</span>
                  </div>
                  <div className="truncate text-[11px] text-muted">{m.files.join("，")}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      {phase.kind === "running" && (
        <div className="space-y-2 py-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-pill">
            <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${phase.progress.total ? (phase.progress.done / phase.progress.total) * 100 : 0}%` }} />
          </div>
          <div className="truncate text-[12px] text-muted">
            {phase.progress.done} / {phase.progress.total} {phase.progress.current}
          </div>
        </div>
      )}
      {phase.kind === "done" && (
        <div className="space-y-2 text-[12.5px] leading-5">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-ok" />
            已迁移 {phase.report.moved.length} 张，改写了 {phase.report.changedFiles.length} 个文件。旧对象仍在桶里，确认网站正常后可再删除。
          </div>
          {phase.report.failed.length > 0 && (
            <div className="selectable max-h-40 overflow-y-auto rounded-lg bg-danger-soft px-3 py-2 text-danger">
              <div className="font-medium">{phase.report.failed.length} 张没有迁移（博客里仍是旧地址）：</div>
              {phase.report.failed.map((f) => (
                <div key={f.oldKey} className="font-mono text-[11.5px]">
                  {f.oldKey}：{f.error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
