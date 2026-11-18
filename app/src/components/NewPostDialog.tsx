import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { api, errorText, type Run } from "@/lib/api";
import { cn } from "@/lib/utils";

interface NewPostDialogProps {
  open: boolean;
  onClose: () => void;
  /** The new post's id, to open it. */
  onCreated: (id: string) => void;
}

function failure(run: Run): string {
  const errors = run.lines.filter((l) => l.level === "error").map((l) => l.text);
  return errors.slice(-3).join("\n") || `${run.label}没有成功。`;
}

/** `hexo new draft|post <title>`, as on the command line, so the blog's scaffolds apply. */
export function NewPostDialog({ open, onClose, onCreated }: NewPostDialogProps) {
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api.runTaskAndWait({ kind: "new", title: title.trim(), draft });
      if (run.status === "succeeded" && run.created) {
        setTitle("");
        onCreated(run.created);
      } else if (run.status === "succeeded") {
        setError("Hexo 已执行，但没有找到新文件（可能已有同名文章）。");
      } else {
        setError(failure(run));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const choice = (value: boolean, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => setDraft(value)}
      className={cn("flex-1 rounded-lg px-3 py-2 text-left active:!scale-100", draft === value ? "bg-card shadow-[inset_0_0_0_1.5px_rgb(var(--brand))]" : "bg-pill hover:bg-pill-hover")}
    >
      <div className="text-[13px] font-medium">{label}</div>
      <div className="text-[11.5px] text-muted">{hint}</div>
    </button>
  );

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="新建"
      description="用博客的模板（scaffolds）创建，文件名由标题生成。"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void create()} disabled={busy || !title.trim()}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>标题</Label>
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void create()}
            placeholder="文章标题"
          />
        </div>
        <div className="flex gap-2">
          {choice(true, "草稿", "放在 _drafts，只在预览里可见")}
          {choice(false, "文章", "放在 _posts，下次部署就会发布")}
        </div>
        {error && <div className="selectable whitespace-pre-wrap text-[12.5px] text-danger">{error}</div>}
      </div>
    </Dialog>
  );
}
