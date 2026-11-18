import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, CheckCircle2, ChevronDown, Cloud, FolderOpen, Loader2, Pencil, PlugZap, Plus, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { api, errorText, type Profile, type Storage, type StorageSettings, type UploadSettings } from "@/lib/api";
import { useDismiss } from "@/lib/useDismiss";
import { cn } from "@/lib/utils";

const PROVIDERS: Record<Storage["kind"], string> = { aliyunOss: "阿里云 OSS", s3: "S3 兼容" };

const blank: Record<Storage["kind"], Storage> = {
  aliyunOss: { kind: "aliyunOss", bucket: "", area: "oss-cn-shanghai", path: "", customUrl: "" },
  s3: { kind: "s3", bucket: "", endpoint: "", region: "", path: "", publicUrl: "" },
};

const DEFAULT_UPLOAD: UploadSettings = { format: "webp", style: "image", quality: 82, maxEdge: 2560 };

/** Where a new image would land: `<base>/<prefix><project>/<uid>.webp`. */
function sampleUrl(storage: Storage, project: string): string {
  const prefix = storage.path.split("/").filter(Boolean).join("/");
  const key = `${prefix ? `${prefix}/` : ""}${project}/<uid>.webp`;
  const base =
    storage.kind === "aliyunOss"
      ? storage.customUrl.trim() || `https://${storage.bucket || "<桶>"}.${storage.area.startsWith("oss-") ? storage.area : `oss-${storage.area}`}.aliyuncs.com`
      : storage.publicUrl.trim() || "<公开访问地址>";
  return `${base.replace(/\/+$/, "")}/${key}`;
}

/** One line of a group: the name on the left, its control on the right (as in Hydra's dialogs). */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <div className="w-[92px] shrink-0 pt-[7px] text-[13px] leading-[18px] text-fg-2">{label}</div>
      <div className="min-w-0 flex-1">
        {children}
        {hint && <div className="mt-1 text-[11.5px] leading-4 text-muted">{hint}</div>}
      </div>
    </div>
  );
}

function Group({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section>
      <div className="group-label">{label}</div>
      <div className="list-card">{children}</div>
      {note && <div className="mt-1.5 px-1 text-[11.5px] leading-[17px] text-muted">{note}</div>}
    </section>
  );
}

/** A short line of what a profile does: bucket, format, how images are written. */
export function profileSummary(p: Pick<Profile, "storage" | "upload">): string {
  const format = p.upload.format === "webp" ? `WebP ${p.upload.quality}` : "原图";
  const style = p.upload.style === "image" ? "{% image %}" : "Markdown";
  const path = p.storage.path.split("/").filter(Boolean).join("/");
  return `${PROVIDERS[p.storage.kind]} · ${p.storage.bucket || "未填存储桶"}${path ? `/${path}` : ""} · ${format} · ${style}`;
}

interface ProfileDialogProps {
  open: boolean;
  /** null: a new profile. */
  profile: Profile | null;
  projectName: string;
  /** Whether it is the one new images go to (deleting it hands that to another). */
  active: boolean;
  onClose: () => void;
  onSaved: (s: StorageSettings) => void;
}

/** A whole profile: name, store, keys and how images are uploaded and written. */
export function ProfileDialog({ open, profile, projectName, active, onClose, onSaved }: ProfileDialogProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [storage, setStorage] = useState<Storage>(blank.aliyunOss);
  const [upload, setUpload] = useState<UploadSettings>(DEFAULT_UPLOAD);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "delete" | null>(null);
  const [checked, setChecked] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? "");
    setStorage(profile?.storage ?? blank.aliyunOss);
    setUpload(profile?.upload ?? DEFAULT_UPLOAD);
    setKeyId(profile?.accessKeyId ?? "");
    setSecret("");
    setChecked(false);
    setConfirmDelete(false);
  }, [open, profile]);

  const set = (patch: Partial<Storage>) => {
    setChecked(false);
    setStorage((s) => ({ ...s, ...patch }) as Storage);
  };
  const setUp = (patch: Partial<UploadSettings>) => setUpload((u) => ({ ...u, ...patch }));
  const moved = profile !== null && profile.images > 0 && JSON.stringify(storage) !== JSON.stringify(profile.storage);

  const save = async () => {
    setBusy("save");
    try {
      const s = await api.saveProfile({ id: profile?.id ?? null, name, storage, upload, accessKeyId: keyId.trim() || null, accessKeySecret: secret.trim() || null });
      toast(profile ? `已保存“${name.trim()}”` : `已新建“${name.trim()}”`);
      onSaved(s);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    try {
      await api.checkStorage(storage, keyId.trim() || null, secret.trim() || null);
      setChecked(true);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!profile) return;
    setBusy("delete");
    try {
      const s = await api.deleteProfile(profile.id);
      toast(`已删除“${profile.name}”`);
      onSaved(s);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => busy === null && onClose()}
      title={profile ? "编辑存储配置" : "新建存储配置"}
      description="一套配置是一个存储桶加上传方式。可以建多套（比如两个桶，或同一个桶的 WebP 与原图），在图片页随时切换；新图片传到当前那套。"
      className="max-w-[600px] bg-bg"
      footer={
        <>
          {profile &&
            (confirmDelete ? (
              <div className="mr-auto flex items-center gap-2 text-[12px] text-danger">
                {profile.images > 0 ? `其中 ${profile.images} 张图仍在桶里、网站照常显示，但不能再在这里检查和删除。` : "确定删除？"}
                <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void remove()}>
                  删除
                </Button>
              </div>
            ) : (
              <Button variant="ghost" className="mr-auto text-danger hover:text-danger" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
                删除这套配置
              </Button>
            ))}
          <Button variant="outline" disabled={busy !== null} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy !== null || !name.trim()} onClick={() => void save()}>
            {busy === "save" ? "保存中…" : profile ? "保存" : "新建"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Group label="配置">
          <Row label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：阿里云主图床" autoFocus={!profile} />
          </Row>
          <Row label="存储">
            <Segmented
              value={storage.kind}
              onChange={(k) => {
                setChecked(false);
                setStorage(profile?.storage.kind === k ? profile.storage : blank[k]);
              }}
              options={[
                { value: "aliyunOss", label: "阿里云 OSS" },
                { value: "s3", label: "S3 兼容", title: "七牛、Cloudflare R2、MinIO、AWS 等" },
              ]}
            />
          </Row>
        </Group>

        <Group
          label="存储桶"
          note={
            moved ? (
              <span className="text-warn">这套配置下有 {profile?.images} 张图。改了存储桶或地址后，它们会找不到所属的配置（网站不受影响），除非另有一套配置指向原来的桶。</span>
            ) : undefined
          }
        >
          {storage.kind === "aliyunOss" ? (
            <>
              <Row label="存储桶">
                <Input value={storage.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="hexo-image-storage" spellCheck={false} />
              </Row>
              <Row label="地域">
                <Input value={storage.area} onChange={(e) => set({ area: e.target.value })} placeholder="oss-cn-shanghai" spellCheck={false} />
              </Row>
              <Row label="自定义域名" hint="可选；绑定了 CDN 域名时填写，图片地址用它。">
                <Input value={storage.customUrl} onChange={(e) => set({ customUrl: e.target.value })} placeholder="https://img.example.com" spellCheck={false} />
              </Row>
            </>
          ) : (
            <>
              <Row label="存储桶">
                <Input value={storage.bucket} onChange={(e) => set({ bucket: e.target.value })} spellCheck={false} />
              </Row>
              <Row label="API 地址">
                <Input value={storage.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://s3.cn-east-1.qiniucs.com" spellCheck={false} />
              </Row>
              <Row label="区域" hint="可选；R2 填 auto。">
                <Input value={storage.region} onChange={(e) => set({ region: e.target.value })} placeholder="auto" spellCheck={false} />
              </Row>
              <Row label="公开访问地址">
                <Input value={storage.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} placeholder="https://img.example.com" spellCheck={false} />
              </Row>
            </>
          )}
          <Row label="路径前缀" hint="可选；不填则从桶根目录开始。">
            <Input value={storage.path} onChange={(e) => set({ path: e.target.value })} placeholder="如 img/" spellCheck={false} />
          </Row>
          <Row label="图片地址">
            <div className="selectable break-all rounded-md bg-pill px-2.5 py-1.5 font-mono text-[11.5px] text-fg-2">{sampleUrl(storage, projectName)}</div>
          </Row>
        </Group>

        <Group label="密钥" note="只存在 macOS 钥匙串里，不写进任何文件；同一个桶的几套配置共用。">
          <Row label="AccessKey ID">
            <Input value={keyId} onChange={(e) => (setKeyId(e.target.value), setChecked(false))} autoComplete="off" spellCheck={false} />
          </Row>
          <Row label="Secret">
            <div className="flex gap-1.5">
              <Input
                type="password"
                value={secret}
                onChange={(e) => (setSecret(e.target.value), setChecked(false))}
                placeholder={profile?.accessKeyId ? "已保存，留空不修改" : ""}
                autoComplete="off"
              />
              <Button variant="outline" disabled={busy !== null || !storage.bucket.trim()} onClick={() => void check()} title="只读不写：确认存储桶和密钥可用">
                {busy === "check" ? <Loader2 className="animate-spin" /> : checked ? <CheckCircle2 className="text-ok" /> : <PlugZap />}
                {checked ? "连接正常" : "测试连接"}
              </Button>
            </div>
          </Row>
        </Group>

        <Group label="上传">
          <Row label="格式" hint="GIF、SVG 等转了会坏的格式总是传原图；原图都先存一份到本机。">
            <Segmented
              value={upload.format}
              onChange={(format) => setUp({ format })}
              options={[
                { value: "webp", label: "WebP（推荐）" },
                { value: "original", label: "原图" },
              ]}
            />
          </Row>
          {upload.format === "webp" && (
            <Row label="WebP 质量">
              <div className="flex items-center gap-3">
                <input type="range" min={40} max={100} value={upload.quality} onChange={(e) => setUp({ quality: Number(e.target.value) })} className="flex-1 accent-[rgb(var(--fg))]" />
                <span className="w-8 text-right font-mono text-[12.5px] tabular-nums">{upload.quality}</span>
              </div>
            </Row>
          )}
          {upload.format === "webp" && (
            <Row label="最长边" hint="更大的图按比例缩到这个像素数；0 表示不缩放。">
              <Input
                inputMode="numeric"
                value={String(upload.maxEdge)}
                onChange={(e) => setUp({ maxEdge: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                className="w-28 font-mono"
              />
            </Row>
          )}
          <Row label="插入写法" hint="文章里看到的都是图片和名称；点一张图可以单独改写法。">
            <Segmented
              value={upload.style}
              onChange={(style) => setUp({ style })}
              options={[
                { value: "image", label: "主题图片标签 {% image %}" },
                { value: "markdown", label: "Markdown" },
              ]}
            />
          </Row>
        </Group>
        {active && profile && <p className="px-1 text-[11.5px] text-muted">这是当前配置：新图片传到这里。</p>}
      </div>
    </Dialog>
  );
}

/** What every profile of the blog shares: its name in image paths and the originals' folder. */
export function LibrarySettingsDialog({ open, settings, onClose, onSaved }: { open: boolean; settings: StorageSettings; onClose: () => void; onSaved: (s: StorageSettings) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [backupDir, setBackupDir] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(settings.name ?? "");
    setBackupDir(settings.backupDir);
  }, [open, settings]);

  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.saveLibrarySettings({ name: name.trim() || null, backupDir: backupDir.trim() || null }));
      toast("已保存图库设置");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    const dir = await openDialog({ title: "母图保存位置", directory: true, multiple: false });
    if (typeof dir === "string") setBackupDir(dir);
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="图库设置"
      description="所有存储配置共用。"
      className="max-w-[560px] bg-bg"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Group label="本博客" note="已上传的图不受影响；只改之后新图的路径。">
          <Row label="项目名" hint={`图片路径 <项目名>/<uid>.webp 用它；留空用文件夹名“${settings.projectName}”。`}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={settings.name ? undefined : settings.projectName} />
          </Row>
        </Group>
        <Group label="本机" note="每张入库的图片都先把原文件原样存在这里：<项目名>/<uid>-<原文件名>，即使存储出问题也不会丢。">
          <Row label="母图位置">
            <div className="flex gap-1.5">
              <Input value={backupDir} onChange={(e) => setBackupDir(e.target.value)} className="font-mono text-[12px]" spellCheck={false} />
              <Button variant="outline" size="icon" title="选择文件夹" onClick={() => void choose()}>
                <FolderOpen />
              </Button>
            </div>
          </Row>
        </Group>
      </div>
    </Dialog>
  );
}

interface ProfileSwitcherProps {
  settings: StorageSettings;
  onSwitch: (id: string) => void;
  onEdit: (profile: Profile) => void;
  onCreate: () => void;
  onLibrarySettings: () => void;
}

/** The profile new images go to, and the others to switch to, above the library. */
export function ProfileSwitcher({ settings, onSwitch, onEdit, onCreate, onLibrarySettings }: ProfileSwitcherProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);
  const active = settings.profiles.find((p) => p.id === settings.active) ?? null;

  return (
    <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-1">
      <div ref={box} className="relative min-w-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn("flex h-9 min-w-0 items-center gap-2.5 rounded-lg bg-card pl-2.5 pr-2 text-left shadow-card hover:bg-card-2 active:!scale-100", open && "bg-card-2")}
        >
          <Cloud className="h-4 w-4 shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium leading-4">{active?.name ?? "没有存储配置"}</span>
            <span className="block truncate text-[11px] leading-[14px] text-muted">{active ? profileSummary(active) : "新建一套才能上传"}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
        </button>
        {open && (
          <div className="absolute left-0 top-10 z-30 w-[380px] animate-pop-in rounded-xl bg-card p-1 shadow-pop">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted">新图片传到选中的那套</div>
            {settings.profiles.map((p) => (
              <div key={p.id} className="group flex items-center rounded-lg hover:bg-pill">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (p.id !== settings.active) onSwitch(p.id);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left active:!scale-100"
                >
                  <Check className={cn("h-3.5 w-3.5 shrink-0", p.id === settings.active ? "text-fg" : "invisible")} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{p.name}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {profileSummary(p)}
                      {p.images ? ` · ${p.images} 张图` : ""}
                      {p.accessKeyId ? "" : " · 未填密钥"}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  title="编辑"
                  onClick={() => {
                    setOpen(false);
                    onEdit(p);
                  }}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 hover:bg-card hover:text-fg group-hover:opacity-100"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="my-1 h-px bg-line-2" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] hover:bg-pill active:!scale-100"
            >
              <Plus className="h-3.5 w-3.5" />
              新建存储配置…
            </button>
          </div>
        )}
      </div>
      {active && (
        <Button variant="ghost" size="sm" onClick={() => onEdit(active)}>
          <Pencil />
          编辑
        </Button>
      )}
      <span className="flex-1" />
      <Button variant="ghost" size="sm" onClick={onLibrarySettings} title="项目名、本机母图位置">
        <Settings2 />
        图库设置
      </Button>
    </div>
  );
}
