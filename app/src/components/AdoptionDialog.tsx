import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api, errorText, onEvent, type AdoptionCandidate, type AdoptionProgress, type AdoptionReport } from "@/lib/api";

type Phase =
  | { kind: "loading" }
  | { kind: "plan"; list: AdoptionCandidate[] }
  | { kind: "running"; progress: AdoptionProgress }
  | { kind: "done"; report: AdoptionReport }
  | { kind: "error"; message: string };

/**
 * Taking the store's existing images into the library: shows what would be taken in (and, with
 * the checklist CSV, the names it gives them) before anything changes, then progress and result.
 */
export function AdoptionDialog({ open, onClose }: { open: boolean; onClose: (changed: boolean) => void }) {
  const [checklist, setChecklist] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const load = useCallback((csv: string | null) => {
    setPhase({ kind: "loading" });
    api.adoptionPlan(csv).then(
      (list) => setPhase({ kind: "plan", list }),
      (e) => setPhase({ kind: "error", message: errorText(e) }),
    );
  }, []);

  useEffect(() => {
    if (open) load(checklist);
    // The checklist is chosen inside the dialog; it reloads the plan itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  const chooseChecklist = async () => {
    const picked = await openDialog({ title: "选择图片核对清单（CSV）", multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof picked !== "string") return;
    setChecklist(picked);
    load(picked);
  };

  const start = async (total: number) => {
    setPhase({ kind: "running", progress: { done: 0, total, current: "" } });
    const off = onEvent<AdoptionProgress>("adoption-progress", (progress) => setPhase((p) => (p.kind === "running" ? { kind: "running", progress } : p)));
    try {
      setPhase({ kind: "done", report: await api.runAdoption(checklist) });
    } catch (e) {
      setPhase({ kind: "error", message: errorText(e) });
    } finally {
      off();
    }
  };

  const running = phase.kind === "running";
  const close = () => !running && onClose(phase.kind === "done");
  const files = phase.kind === "plan" ? new Set(phase.list.flatMap((c) => c.files)).size : 0;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="接管旧图"
      className="max-w-[720px]"
      description="把存储里还不在图片库的图（博客引用的、清单里列的）读出来：原图存到本机母图目录，转成 WebP 放到 <项目名>/<uid>.webp，记入图片库，再把博客里的地址换成新地址。旧对象不删除。"
      footer={
        phase.kind === "plan" ? (
          <>
            <Button variant="outline" onClick={close}>
              取消
            </Button>
            <Button variant="brand" disabled={phase.list.length === 0} onClick={() => void start(phase.list.length)}>
              接管 {phase.list.length} 张图片
            </Button>
          </>
        ) : (
          <Button disabled={running} onClick={close}>
            {phase.kind === "done" ? "完成" : "关闭"}
          </Button>
        )
      }
    >
      {(phase.kind === "plan" || phase.kind === "loading") && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-pill px-3 py-2 text-[12.5px]">
          <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted" />
          {checklist ? (
            <>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={checklist}>
                {checklist.split("/").pop()}
              </span>
              <button title="不用清单" onClick={() => (setChecklist(null), load(null))} className="text-muted hover:text-fg">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <span className="flex-1 text-fg-2">可选：用你的图片核对清单（CSV）带入名称、位置描述、是否正常、上传日期和备用图床。</span>
          )}
          <Button size="sm" variant="outline" onClick={() => void chooseChecklist()}>
            {checklist ? "换一个" : "选择清单…"}
          </Button>
        </div>
      )}
      {phase.kind === "loading" && (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在扫描博客里的图片地址…
        </div>
      )}
      {phase.kind === "error" && <div className="selectable whitespace-pre-wrap text-[12.5px] text-danger">{phase.message}</div>}
      {phase.kind === "plan" &&
        (phase.list.length === 0 ? (
          <div className="py-4 text-[13px] text-muted">没有要接管的图：博客里这个存储的图片都已经在图片库里了。</div>
        ) : (
          <div className="space-y-2">
            {files > 0 && (
              <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12px] leading-5 text-warn">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                会改写 {files} 个文件里的图片地址（只替换地址本身）。建议先提交博客源码，接管后检查预览，再部署。
              </div>
            )}
            <div className="max-h-[44vh] overflow-y-auto rounded-lg bg-card-2 shadow-card">
              {phase.list.map((c) => (
                <div key={c.oldKey} className="border-b-[0.5px] border-line-2 px-3 py-1.5 last:border-0">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-mono text-[11.5px] text-fg">{c.oldKey}</span>
                    {c.name && <span className="shrink-0 text-[12px] text-fg-2">「{c.name}」</span>}
                  </div>
                  <div className="truncate text-[11px] text-muted">{c.files.length ? c.files.join("，") : c.description || "只在清单里，博客没有引用"}</div>
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
            已接管 {phase.report.adopted.length} 张，改写了 {phase.report.changedFiles.length} 个文件。旧对象仍在存储里，确认网站正常后可再清理。
          </div>
          {phase.report.failed.length > 0 && (
            <div className="selectable max-h-40 overflow-y-auto rounded-lg bg-danger-soft px-3 py-2 text-danger">
              <div className="font-medium">{phase.report.failed.length} 张没有接管（博客里仍是旧地址）：</div>
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
