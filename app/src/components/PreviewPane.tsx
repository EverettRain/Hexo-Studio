import { AlertTriangle, Loader2, Play, RotateCw, ScrollText, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, onEvent, type LogLine, type PreviewState } from "@/lib/api";
import { cn } from "@/lib/utils";

interface PreviewPaneProps {
  preview: PreviewState;
  /** The page to show, under the site root (`/2025/11/24/x/`); null shows the home page. */
  path: string | null;
  /** Site root, shown when `path` is unknown or missing. */
  root: string;
  /** Changes when the page should load again (after Hexo re-rendered a save). */
  reloadKey: number;
  onStart: () => void;
}

export function LogView({ lines, className }: { lines: LogLine[]; className?: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines.length]);
  return (
    <div className={cn("selectable overflow-auto bg-card-2 px-3 py-2 font-mono text-[11.5px] leading-[18px]", className)}>
      {lines.length === 0 && <div className="text-muted">没有输出</div>}
      {lines.map((l, i) => (
        <div key={i} className={cn("whitespace-pre-wrap break-all", l.stream === "err" ? "text-warn" : "text-fg-2")}>
          {l.text || " "}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

/** The preview server's output, kept up to date while shown. */
export function usePreviewLog(enabled: boolean): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void api.previewLog().then((l) => alive && setLines(l));
    const off = onEvent<LogLine>("preview-log", (l) => setLines((v) => [...v.slice(-999), l]));
    return () => {
      alive = false;
      off();
    };
  }, [enabled]);
  return lines;
}

/**
 * The page as the theme renders it, from the local `hexo server`. Pages that 404 (an address
 * this app worked out differently from Hexo) fall back to the home page with a notice.
 */
export function PreviewPane({ preview, path, root, reloadKey, onStart }: PreviewPaneProps) {
  const [showLog, setShowLog] = useState(false);
  const [missing, setMissing] = useState(false);
  const [manualReload, setManualReload] = useState(0);
  const running = preview.state === "running";
  const log = usePreviewLog(showLog || preview.state !== "running");

  useEffect(() => {
    setMissing(false);
    if (!running || !path) return;
    let alive = true;
    api.previewProbe(path).then(
      (p) => alive && setMissing(p.status === 404),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [running, path, reloadKey]);

  const shown = path && !missing ? path : root;
  const src = running ? new URL(shown, `http://127.0.0.1:${preview.port}`).href : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b-[0.5px] border-line-2 px-2 text-[12px] text-muted">
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-[11.5px]" title={src ?? undefined}>
          {running ? decodeURI(shown) : "主题预览"}
        </span>
        {running && (
          <button title="刷新预览" onClick={() => setManualReload((n) => n + 1)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-pill hover:text-fg">
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
        <button title="预览日志" onClick={() => setShowLog((s) => !s)} className={cn("flex h-6 w-6 items-center justify-center rounded-md hover:bg-pill hover:text-fg", showLog && "bg-pill text-fg")}>
          <ScrollText className="h-3.5 w-3.5" />
        </button>
        {running && (
          <button title="停止预览服务器" onClick={() => void api.previewStop()} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-pill hover:text-fg">
            <Square className="h-3 w-3" />
          </button>
        )}
      </div>
      {running && missing && (
        <div className="flex shrink-0 items-center gap-1.5 bg-warn-soft px-3 py-1.5 text-[12px] text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          这篇文章的预览地址返回 404，先显示首页。保存后会再试。
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {src ? (
          <iframe key={`${src}#${reloadKey}#${manualReload}`} src={src} title="主题预览" className="h-full w-full border-0 bg-white" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            {preview.state === "starting" ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-muted" />
                <div className="text-[13px] text-fg-2">正在启动 hexo server…</div>
              </>
            ) : (
              <>
                {preview.state === "failed" && <div className="selectable max-w-md whitespace-pre-wrap text-[12.5px] text-danger">{preview.message}</div>}
                <Button variant="outline" onClick={onStart}>
                  <Play />
                  {preview.state === "failed" ? "重新启动预览" : "启动预览"}
                </Button>
                <div className="max-w-sm text-[12px] leading-5 text-muted">预览里欢迎语、音乐、访问统计等 /api 功能不可用，这是正常的：线上由 Vercel 函数提供。</div>
              </>
            )}
          </div>
        )}
      </div>
      {(showLog || (!running && log.length > 0)) && <LogView lines={log} className="h-40 shrink-0 border-t-[0.5px] border-line-2" />}
    </div>
  );
}
