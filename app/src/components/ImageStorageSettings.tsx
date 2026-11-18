import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, FolderOpen, Loader2, PlugZap } from "lucide-react";
import { useEffect, useState } from "react";
import { Group } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type ImageFormat, type ImageSettings, type InsertStyle, type Storage } from "@/lib/api";

type Kind = "none" | Storage["kind"];

const blank: Record<Storage["kind"], Storage> = {
  aliyunOss: { kind: "aliyunOss", bucket: "", area: "oss-cn-shanghai", path: "", customUrl: "" },
  s3: { kind: "s3", bucket: "", endpoint: "", region: "", path: "", publicUrl: "" },
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
      {hint && <div className="text-[11.5px] leading-4 text-muted">{hint}</div>}
    </div>
  );
}

/** Where a key would point, as a sample: `<prefix><project>/<uid>.webp`. */
function sampleUrl(storage: Storage, project: string): string {
  const prefix = storage.path.split("/").filter(Boolean).join("/");
  const key = `${prefix ? `${prefix}/` : ""}${project}/<uid>.webp`;
  const base =
    storage.kind === "aliyunOss"
      ? storage.customUrl.trim() || `https://${storage.bucket || "<桶>"}.${storage.area.startsWith("oss-") ? storage.area : `oss-${storage.area}`}.aliyuncs.com`
      : storage.publicUrl.trim() || "<公开访问地址>";
  return `${base.replace(/\/+$/, "")}/${key}`;
}

/**
 * The project's image store (PicGo-style fields), credentials for the keychain, and how images
 * are uploaded. Saved to `.hexostudio/settings.json`, except the keys and the backup folder.
 */
export function ImageStorageSettings() {
  const toast = useToast();
  const [saved, setSaved] = useState<ImageSettings | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<ImageFormat>("webp");
  const [style, setStyle] = useState<InsertStyle>("image");
  const [quality, setQuality] = useState(82);
  const [maxEdge, setMaxEdge] = useState(2560);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [backupDir, setBackupDir] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [checked, setChecked] = useState(false);

  const fill = (s: ImageSettings) => {
    setSaved(s);
    setStorage(s.storage);
    setName(s.name ?? "");
    setFormat(s.upload.format);
    setStyle(s.upload.style);
    setQuality(s.upload.quality);
    setMaxEdge(s.upload.maxEdge);
    setKeyId(s.accessKeyId ?? "");
    setSecret("");
    setBackupDir(s.backupDir);
  };
  useEffect(() => {
    api.imageSettings().then(fill, (e) => toast(errorText(e), "error"));
  }, [toast]);

  if (!saved) return null;
  const kind: Kind = storage?.kind ?? "none";
  const set = (patch: Partial<Storage>) => {
    setChecked(false);
    setStorage((s) => (s ? ({ ...s, ...patch } as Storage) : s));
  };
  const project = name.trim() || saved.projectName;

  const save = async () => {
    setBusy("save");
    try {
      fill(
        await api.saveImageSettings({
          name: name.trim() || null,
          storage,
          upload: { format, style, quality, maxEdge },
          accessKeyId: keyId.trim() || null,
          accessKeySecret: secret.trim() || null,
          backupDir: backupDir.trim() || null,
        }),
      );
      setChecked(false);
      toast("已保存图片存储设置");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    try {
      await api.checkStorage();
      setChecked(true);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const chooseBackup = async () => {
    const dir = await open({ title: "母图保存位置", directory: true, multiple: false });
    if (typeof dir === "string") setBackupDir(dir);
  };

  const dirty =
    JSON.stringify(storage) !== JSON.stringify(saved.storage) ||
    (name.trim() || null) !== saved.name ||
    format !== saved.upload.format ||
    style !== saved.upload.style ||
    quality !== saved.upload.quality ||
    maxEdge !== saved.upload.maxEdge ||
    keyId.trim() !== (saved.accessKeyId ?? "") ||
    secret.trim() !== "" ||
    backupDir.trim() !== saved.backupDir;

  return (
    <Group label="图片存储">
      <div className="grid grid-cols-2 gap-x-3 gap-y-3 px-4 py-3.5">
        <Field label="存储">
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as Kind;
              setChecked(false);
              setStorage(k === "none" ? null : saved.storage?.kind === k ? saved.storage : blank[k]);
            }}
          >
            <option value="none">不使用</option>
            <option value="aliyunOss">阿里云 OSS</option>
            <option value="s3">S3 兼容（七牛、R2、MinIO、AWS…）</option>
          </Select>
        </Field>
        <Field label="项目名（图片路径用）" hint={`留空用文件夹名：${saved.name ? "" : saved.projectName}`}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={saved.name ? undefined : saved.projectName} />
        </Field>

        {storage?.kind === "aliyunOss" && (
          <>
            <Field label="存储桶（bucket）">
              <Input value={storage.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="hexo-image-storage" />
            </Field>
            <Field label="地域（area）">
              <Input value={storage.area} onChange={(e) => set({ area: e.target.value })} placeholder="oss-cn-shanghai" />
            </Field>
            <Field label="自定义域名（customUrl，可选）">
              <Input value={storage.customUrl} onChange={(e) => set({ customUrl: e.target.value })} placeholder="https://img.example.com" />
            </Field>
          </>
        )}
        {storage?.kind === "s3" && (
          <>
            <Field label="存储桶（bucket）">
              <Input value={storage.bucket} onChange={(e) => set({ bucket: e.target.value })} />
            </Field>
            <Field label="API 地址（endpoint）">
              <Input value={storage.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://s3.cn-east-1.qiniucs.com" />
            </Field>
            <Field label="区域（region，可选）">
              <Input value={storage.region} onChange={(e) => set({ region: e.target.value })} placeholder="auto" />
            </Field>
            <Field label="公开访问地址">
              <Input value={storage.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} placeholder="https://img.example.com" />
            </Field>
          </>
        )}
        {storage && (
          <>
            <Field label="路径前缀（path，可选）">
              <Input value={storage.path} onChange={(e) => set({ path: e.target.value })} placeholder="不填则从桶根目录开始" />
            </Field>
            <div className="col-span-2 rounded-md bg-pill px-2.5 py-1.5 font-mono text-[11.5px] text-fg-2">
              <span className="selectable break-all">{sampleUrl(storage, project)}</span>
            </div>
            <Field label="AccessKey ID">
              <Input value={keyId} onChange={(e) => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="AccessKey Secret" hint="只存在 macOS 钥匙串里，不写进任何文件。">
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={saved.accessKeyId ? "已保存，留空不修改" : ""} autoComplete="off" />
            </Field>
          </>
        )}

        <Field label="插入图片的写法" hint="文章里看到的都是图片和名称；点一张图可以单独改成别的写法、设宽度和说明。">
          <Segmented
            value={style}
            onChange={setStyle}
            options={[
              { value: "image", label: "主题图片标签 {% image %}" },
              { value: "markdown", label: "Markdown ![]()" },
            ]}
          />
        </Field>
        <Field label="默认上传格式">
          <Select value={format} onChange={(e) => setFormat(e.target.value as ImageFormat)}>
            <option value="webp">WebP（推荐）</option>
            <option value="original">原图</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="WebP 质量">
            <Input type="number" min={1} max={100} value={quality} disabled={format !== "webp"} onChange={(e) => setQuality(Number(e.target.value) || 82)} />
          </Field>
          <Field label="最长边（像素）">
            <Input type="number" min={0} step={10} value={maxEdge} disabled={format !== "webp"} onChange={(e) => setMaxEdge(Number(e.target.value) || 0)} />
          </Field>
        </div>
        <Field label="母图保存位置（本机）" hint="每张入库的图片都先把原文件原样存在这里：<项目名>/<uid>-<原文件名>。">
          <div className="flex gap-1.5">
            <Input value={backupDir} onChange={(e) => setBackupDir(e.target.value)} className="font-mono text-[12px]" />
            <Button variant="outline" size="icon" title="选择文件夹" onClick={() => void chooseBackup()}>
              <FolderOpen />
            </Button>
          </div>
        </Field>
        <div className="flex items-end justify-end gap-2">
          {storage && (
            <Button variant="outline" disabled={busy !== null || dirty || !saved.accessKeyId} onClick={() => void check()} title={dirty ? "先保存" : undefined}>
              {busy === "check" ? <Loader2 className="animate-spin" /> : checked ? <CheckCircle2 className="text-ok" /> : <PlugZap />}
              {checked ? "连接正常" : "测试连接"}
            </Button>
          )}
          <Button disabled={busy !== null || !dirty} onClick={() => void save()}>
            {busy === "save" ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </Group>
  );
}
