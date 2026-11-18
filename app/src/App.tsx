import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, type PageId } from "@/components/AppShell";
import { NewPostDialog } from "@/components/NewPostDialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { api, errorText, onEvent, type AppInfo, type BlogStatus, type PostSummary, type PreviewState } from "@/lib/api";
import { PageSlot } from "@/lib/pageActive";
import { useTheme } from "@/lib/theme";
import { DeployPage } from "@/pages/DeployPage";
import { EditorPage } from "@/pages/EditorPage";
import { ImagesPage } from "@/pages/ImagesPage";
import { PostsPage } from "@/pages/PostsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WelcomePage } from "@/pages/WelcomePage";
import { Plus } from "lucide-react";

const titles: Record<PageId, string> = { posts: "文章", images: "图片", deploy: "部署", settings: "设置" };

/** The welcome page until a project is open, then the project's window. */
export default function App() {
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<BlogStatus | null>(null);

  useEffect(() => {
    void api.appInfo().then(setInfo).catch(() => {});
    void api.blogStatus().then(setStatus).catch((e) => toast(errorText(e), "error"));
  }, [toast]);

  if (!status) return null;
  if (!status.dir) return <WelcomePage version={info?.version ?? null} theme={theme} onThemeChange={setTheme} onOpened={setStatus} />;
  return (
    <ProjectWindow
      key={status.dir}
      status={status}
      info={info}
      theme={theme}
      onThemeChange={setTheme}
      onStatus={setStatus}
      onClose={async () => {
        try {
          await api.closeProject();
          setStatus(await api.blogStatus());
        } catch (e) {
          toast(errorText(e), "error");
        }
      }}
    />
  );
}

interface ProjectWindowProps {
  status: BlogStatus;
  info: AppInfo | null;
  theme: ReturnType<typeof useTheme>[0];
  onThemeChange: ReturnType<typeof useTheme>[1];
  onStatus: (s: BlogStatus) => void;
  onClose: () => void;
}

function ProjectWindow({ status, info, theme, onThemeChange, onStatus, onClose }: ProjectWindowProps) {
  const toast = useToast();
  const [page, setPage] = useState<PageId>("posts");
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ state: "stopped" });
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const flush = useRef<(() => Promise<void>) | null>(null);
  const leave = async () => {
    await flush.current?.();
    onClose();
  };

  const refreshPosts = useCallback(async () => {
    try {
      setPosts(await api.listPosts());
    } catch (e) {
      toast(errorText(e), "error");
    }
  }, [toast]);

  useEffect(() => {
    void api.previewState().then(setPreview).catch(() => {});
    void refreshPosts();
    return onEvent<PreviewState>("preview-state", setPreview);
  }, [refreshPosts]);

  const onSaved = useCallback((s: PostSummary) => setPosts((list) => list?.map((p) => (p.id === s.id ? s : p)) ?? list), []);
  const openPost = useCallback(
    async (id: string) => {
      await refreshPosts();
      setEditing(id);
      setPage("posts");
    },
    [refreshPosts],
  );

  const config = status.config;
  const editingPost = editing ? posts?.find((p) => p.id === editing) : undefined;
  const title =
    page === "posts" && editing ? (
      <>
        <span className="text-muted">文章 /</span>
        <span className="truncate">{editingPost?.title || editing}</span>
      </>
    ) : (
      titles[page]
    );

  return (
    <AppShell
      activePage={page}
      onPageChange={setPage}
      theme={theme}
      onThemeChange={onThemeChange}
      preview={preview}
      title={title}
      project={{ name: config?.title ?? status.dir ?? "", path: status.dir ?? "" }}
      onSwitchProject={() => void leave()}
    >
      <PageSlot active={page === "posts"}>
        {status.error || !config ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-fg-2">
            {status.error ?? "无法读取博客配置。"}
            <Button variant="outline" onClick={() => void leave()}>
              回到欢迎页
            </Button>
          </div>
        ) : editing ? (
          <EditorPage
            key={editing}
            id={editing}
            config={config}
            preview={preview}
            posts={posts ?? []}
            onClose={() => {
              setEditing(null);
              void refreshPosts();
            }}
            onSaved={onSaved}
            onPublished={(id) => void openPost(id)}
            flushRef={flush}
          />
        ) : (
          <PostsPage
            posts={posts}
            onOpen={setEditing}
            onRefresh={() => void refreshPosts()}
            actions={
              <Button onClick={() => setCreating(true)}>
                <Plus />
                新建
              </Button>
            }
          />
        )}
      </PageSlot>
      <PageSlot active={page === "images"}>
        <ImagesPage onOpenPost={(id) => void openPost(id)} />
      </PageSlot>
      <PageSlot active={page === "deploy"}>
        <DeployPage config={config} />
      </PageSlot>
      <PageSlot active={page === "settings"}>
        <SettingsPage status={status} info={info} onStatus={onStatus} onSwitchProject={() => void leave()} />
      </PageSlot>
      <NewPostDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          void openPost(id);
        }}
      />
    </AppShell>
  );
}
