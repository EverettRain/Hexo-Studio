import { ExternalLink, Loader2, Play, Square } from "lucide-react";
import { useState } from "react";
import { LogView, usePreviewLog } from "@/components/PreviewPane";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type PreviewState } from "@/lib/api";
import { usePageActive } from "@/lib/pageActive";

/** The `hexo server` of this blog, started and stopped here instead of in a terminal. */
export function PreviewPage({ preview }: { preview: PreviewState }) {
  const toast = useToast();
  const active = usePageActive();
  const log = usePreviewLog(active);
  const [busy, setBusy] = useState(false);
  const address = preview.state === "running" ? `http://127.0.0.1:${preview.port}/` : null;

  const start = async () => {
    setBusy(true);
    try {
      await api.previewStart();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.previewStop();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col px-5 pb-5">
      <div className="flex shrink-0 items-center gap-2 pb-4 pt-1">
        <div className="min-w-0 flex-1 text-[12.5px] leading-5 text-fg-2">
          {address ? (
            <>
              <span className="selectable font-mono text-fg">{address}</span> · 只有这台 Mac 能访问，保存文章后页面自动更新。
            </>
          ) : preview.state === "starting" ? (
            "正在启动 hexo server --draft…"
          ) : (
            "hexo server --draft：按主题真实渲染博客，草稿也会显示。欢迎语、音乐、访问统计等 /api 功能在预览里不可用，线上由 Vercel 函数提供。"
          )}
        </div>
        {address && (
          <Button variant="outline" onClick={() => void api.openUrl(address).catch((e) => toast(errorText(e), "error"))}>
            <ExternalLink />
            在浏览器打开
          </Button>
        )}
        {preview.state === "stopped" || preview.state === "failed" ? (
          <Button variant="brand" disabled={busy} onClick={() => void start()}>
            <Play />
            {preview.state === "failed" ? "重新启动" : "启动"}
          </Button>
        ) : (
          <Button variant="outline" disabled={busy || preview.state === "starting"} onClick={() => void stop()}>
            {preview.state === "starting" ? <Loader2 className="animate-spin" /> : <Square />}
            停止
          </Button>
        )}
      </div>
      {preview.state === "failed" && <div className="selectable mb-3 whitespace-pre-wrap rounded-lg bg-danger-soft px-3.5 py-3 text-[12.5px] leading-5 text-danger">{preview.message}</div>}
      <LogView lines={log} className="min-h-0 flex-1 rounded-lg shadow-card" />
    </div>
  );
}
