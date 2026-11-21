import { check, type Update } from "@tauri-apps/plugin-updater";
import { ArrowDownToLine, Check, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorText } from "@/lib/api";

type Phase =
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; done: number; total: number }
  | { kind: "ready"; update: Update }
  | { kind: "error"; message: string };

const mb = (n: number) => (n / 1048576).toFixed(1);

/** The version line (welcome page, settings' About): checks GitHub Releases once, offers to install a newer one. */
export function UpdateCard({ version }: { version: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  const run = useCallback(async () => {
    setPhase({ kind: "checking" });
    try {
      const update = await check({ timeout: 15000 });
      setPhase(update ? { kind: "available", update } : { kind: "latest" });
    } catch (e) {
      setPhase({ kind: "error", message: errorText(e) });
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const install = async (update: Update) => {
    let done = 0;
    let total = 0;
    setPhase({ kind: "downloading", update, done, total });
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") done += e.data.chunkLength;
        setPhase({ kind: "downloading", update, done, total });
      });
      setPhase({ kind: "ready", update });
    } catch (e) {
      setPhase({ kind: "error", message: errorText(e) });
    }
  };

  const line = (() => {
    switch (phase.kind) {
      case "checking":
        return (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在检查更新…
          </span>
        );
      case "latest":
        return (
          <span className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-ok" />
            已是最新版本
          </span>
        );
      case "available":
        return <span className="font-medium text-brand">v{phase.update.version} 可更新</span>;
      case "downloading":
        return <span>{phase.total ? `正在下载 ${mb(phase.done)} / ${mb(phase.total)} MB` : "正在准备下载…"}</span>;
      case "ready":
        return <span className="text-ok">v{phase.update.version} 已安装，重启后生效</span>;
      case "error":
        return <span title={phase.message}>无法检查更新（离线或还没有发布版本）</span>;
    }
  })();

  return (
    <div className="space-y-2">
      <div className="space-y-0.5 text-[12px] text-muted">
        <div className="font-mono">v{version ?? "…"}</div>
        <div>{line}</div>
      </div>
      {phase.kind === "available" && (
        <div className="space-y-2 rounded-lg bg-brand-soft px-3 py-2.5">
          {phase.update.body && <div className="selectable max-h-28 overflow-y-auto whitespace-pre-wrap text-[12px] leading-5 text-fg-2">{phase.update.body}</div>}
          <Button size="sm" variant="brand" onClick={() => void install(phase.update)}>
            <ArrowDownToLine />
            下载并更新
          </Button>
        </div>
      )}
      {phase.kind === "ready" && (
        <Button size="sm" onClick={() => void api.restartApp()}>
          重启 Hexo-Studio
        </Button>
      )}
      {(phase.kind === "error" || phase.kind === "latest") && (
        <button onClick={() => void run()} className="flex items-center gap-1 text-[12px] text-muted hover:text-fg">
          <RotateCw className="h-3 w-3" />
          再检查一次
        </button>
      )}
    </div>
  );
}
