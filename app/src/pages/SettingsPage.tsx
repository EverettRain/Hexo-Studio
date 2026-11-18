import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeftRight, CheckCircle2, FolderSearch, RotateCcw, XCircle } from "lucide-react";
import { Group, Row } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type AppInfo, type BlogStatus } from "@/lib/api";

interface SettingsPageProps {
  status: BlogStatus | null;
  info: AppInfo | null;
  onStatus: (s: BlogStatus) => void;
  onSwitchProject: () => void;
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className="flex items-start gap-1.5">
      {ok ? <CheckCircle2 className="mt-[2px] h-3.5 w-3.5 shrink-0 text-ok" /> : <XCircle className="mt-[2px] h-3.5 w-3.5 shrink-0 text-danger" />}
      <span className="selectable min-w-0 break-all">{children}</span>
    </span>
  );
}

export function SettingsPage({ status, info, onStatus, onSwitchProject }: SettingsPageProps) {
  const toast = useToast();
  const node = status?.node;
  const config = status?.config;

  const chooseNode = async () => {
    const picked = await open({ title: "选择 node 可执行文件", multiple: false, directory: false });
    if (typeof picked !== "string") return;
    try {
      onStatus(await api.setNodePath(picked));
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="view-in mx-auto w-full max-w-[760px] space-y-5 px-5 pb-10 pt-1">
        <Group label="项目">
          <Row
            label={config?.title ?? "博客"}
            hint={
              <span className="block space-y-0.5">
                <Check ok={!status?.error}>{status?.error ? `${status.dir}：${status.error}` : status?.dir}</Check>
                {status?.remote && <span className="selectable block pl-5 font-mono text-[11.5px]">origin {status.remote}</span>}
              </span>
            }
          >
            <Button variant="ghost" size="sm" title="在 Finder 中显示" onClick={() => void api.revealProject().catch((e) => toast(errorText(e), "error"))}>
              <FolderSearch />
            </Button>
            <Button variant="outline" size="sm" onClick={onSwitchProject}>
              <ArrowLeftRight />
              切换项目
            </Button>
          </Row>
          {status?.dir && !status.error && (
            <Row label="Hexo" hint={<Check ok={!status.hexoError}>{status.hexoError ?? "已安装在博客的 node_modules 里"}</Check>} />
          )}
          {config && (
            <Row
              label="站点配置"
              hint={
                <span className="selectable block space-y-0.5">
                  <span className="block">地址 {config.url}</span>
                  <span className="block">
                    文章路径 <span className="font-mono">{config.permalink}</span> · 时区 {config.timezone ?? "未设置（使用本机时区）"}
                  </span>
                  <span className="block">
                    部署{" "}
                    {config.deploy.length
                      ? config.deploy.map((d) => [d.kind, d.repo, d.branch].filter(Boolean).join(" · ")).join("；")
                      : "未配置"}
                  </span>
                </span>
              }
            />
          )}
        </Group>


        <Group label="Node">
          <Row
            label={node?.manual ? "Node（手动指定）" : "Node（自动查找）"}
            hint={node ? <Check ok={!node.error}>{node.error ?? `${node.path}${node.version ? ` · ${node.version}` : ""}`}</Check> : "读取中…"}
          >
            {node?.manual && (
              <Button variant="ghost" size="sm" title="改回自动查找" onClick={() => void api.setNodePath(null).then(onStatus)}>
                <RotateCcw />
                自动
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void chooseNode()}>
              指定…
            </Button>
          </Row>
          <div className="px-4 py-2.5 text-[12px] leading-[18px] text-muted">
            自动查找依次看登录 shell 的 PATH（nvm、fnm、Volta、Homebrew 都在这里设置）和常见安装位置。Hexo 一律用博客自己的 node_modules。
          </div>
        </Group>

        <Group label="关于">
          <Row label="版本" hint={info ? `Hexo-Studio ${info.version}` : undefined} />
          <Row label="数据目录" hint={<span className="selectable break-all">{info?.dataDir}</span>} />
        </Group>
      </div>
    </div>
  );
}
