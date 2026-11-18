import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AppInfo {
  version: string;
  dataDir: string;
}

export interface Deployer {
  kind: string;
  repo: string | null;
  branch: string | null;
}

export interface BlogConfigView {
  title: string;
  url: string;
  /** URL path the site is served under, with leading and trailing slashes. */
  root: string;
  permalink: string;
  timezone: string | null;
  deploy: Deployer[];
}

export interface NodeView {
  manual: string | null;
  path: string | null;
  version: string | null;
  error: string | null;
}

export interface BlogStatus {
  /** The open project; null on the welcome page. */
  dir: string | null;
  /** Why the folder is not usable as a blog. */
  error: string | null;
  config: BlogConfigView | null;
  /** Hexo is not installed in the blog. */
  hexoError: string | null;
  /** The `origin` git remote. */
  remote: string | null;
  node: NodeView;
}

export interface ProjectCard {
  path: string;
  name: string;
  remote: string | null;
  /** Unix seconds. */
  openedAt: number;
  /** Why it cannot be opened now. */
  error: string | null;
}

export type PostKind = "post" | "draft";

export interface PostSummary {
  /** Path under the source folder, e.g. `_posts/hello.md`. */
  id: string;
  kind: PostKind;
  fileName: string;
  title: string | null;
  date: string | null;
  tags: string[];
  categories: string[];
  /** Path of the page under the site root; null when it cannot be worked out. */
  urlPath: string | null;
  /** Unix seconds. */
  modified: number;
}

/** `prefix + yaml + suffix + body` is the file. */
export interface PostFile {
  summary: PostSummary;
  prefix: string;
  yaml: string;
  suffix: string;
  body: string;
  fingerprint: string;
}

export type WriteOutcome = { status: "saved"; summary: PostSummary; fingerprint: string } | { status: "conflict" };

export type PreviewState =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; port: number }
  | { state: "failed"; message: string };

export interface LogLine {
  stream: "out" | "err";
  text: string;
}

export interface PageProbe {
  status: number;
  hash: string;
}

export type Task =
  | { kind: "clean" }
  | { kind: "generate" }
  | { kind: "deploy" }
  | { kind: "new"; title: string; draft: boolean }
  | { kind: "publish"; slug: string };

export type Level = "info" | "warn" | "error";

export interface RunLine {
  stream: "out" | "err";
  level: Level;
  text: string;
}

export type Problem =
  | { kind: "pushProtection"; secrets: { kind: string; paths: string[] }[]; unblockUrls: string[] }
  | { kind: "sshAuth" }
  | { kind: "missingModules" }
  | { kind: "gitIdentity" };

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface Run {
  id: number;
  task: Task;
  label: string;
  status: RunStatus;
  /** Unix milliseconds. */
  startedAt: number;
  endedAt: number | null;
  lines: RunLine[];
  problems: Problem[];
  notes: string[];
  /** The post id a new / publish made. */
  created: string | null;
}

export type Storage =
  | { kind: "aliyunOss"; bucket: string; area: string; path: string; customUrl: string }
  | { kind: "s3"; bucket: string; endpoint: string; region: string; path: string; publicUrl: string };

export type ImageFormat = "webp" | "original";

export interface UploadSettings {
  format: ImageFormat;
  quality: number;
  maxEdge: number;
}

export interface ImageSettings {
  /** The name image paths use now. */
  projectName: string;
  /** Set by hand; null means the folder name. */
  name: string | null;
  storage: Storage | null;
  upload: UploadSettings;
  /** Saved in the keychain for this store; the secret is never sent back. */
  accessKeyId: string | null;
  backupDir: string;
}

export interface ImageSettingsInput {
  name: string | null;
  storage: Storage | null;
  upload: UploadSettings;
  accessKeyId: string | null;
  /** Empty keeps the saved secret. */
  accessKeySecret: string | null;
  backupDir: string | null;
}

export interface Uploaded {
  url: string;
  key: string;
  backup: string;
  format: ImageFormat;
  originalBytes: number;
  uploadedBytes: number;
}

export interface PlannedMove {
  oldUrl: string;
  oldKey: string;
  newKey: string;
  format: ImageFormat;
  files: string[];
}

export interface MigrationProgress {
  done: number;
  total: number;
  current: string;
}

export interface MigrationReport {
  moved: { oldKey: string; newUrl: string }[];
  failed: { oldKey: string; error: string }[];
  changedFiles: string[];
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  restartApp: () => invoke<void>("restart_app"),
  recentProjects: () => invoke<ProjectCard[]>("recent_projects"),
  openProject: (path: string) => invoke<BlogStatus>("open_project", { path }),
  closeProject: () => invoke<void>("close_project"),
  forgetProject: (path: string) => invoke<void>("forget_project", { path }),
  revealProject: () => invoke<void>("reveal_project"),
  blogStatus: () => invoke<BlogStatus>("blog_status"),
  setNodePath: (path: string | null) => invoke<BlogStatus>("set_node_path", { path }),
  listPosts: () => invoke<PostSummary[]>("list_posts"),
  readPost: (id: string) => invoke<PostFile>("read_post", { id }),
  writePost: (id: string, text: string, expected: string) => invoke<WriteOutcome>("write_post", { id, text, expected }),
  revealPost: (id: string) => invoke<void>("reveal_post", { id }),
  openPostExternally: (id: string) => invoke<void>("open_post_externally", { id }),
  previewStart: () => invoke<number>("preview_start"),
  previewStop: () => invoke<void>("preview_stop"),
  previewState: () => invoke<PreviewState>("preview_state"),
  previewLog: () => invoke<LogLine[]>("preview_log"),
  previewProbe: (path: string) => invoke<PageProbe>("preview_probe", { path }),
  previewAwaitChange: (path: string, before: PageProbe | null) => invoke<PageProbe>("preview_await_change", { path, before }),
  blogGitChanges: () => invoke<number | null>("blog_git_changes"),
  runTask: (task: Task) => invoke<number>("run_task", { task }),
  runTaskAndWait: (task: Task) => invoke<Run>("run_task_and_wait", { task }),
  cancelRun: () => invoke<void>("cancel_run"),
  listRuns: () => invoke<Run[]>("list_runs"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  imageSettings: () => invoke<ImageSettings>("image_settings"),
  saveImageSettings: (input: ImageSettingsInput) => invoke<ImageSettings>("save_image_settings", { input }),
  checkStorage: () => invoke<void>("check_storage"),
  migrationPlan: () => invoke<PlannedMove[]>("migration_plan"),
  runMigration: () => invoke<MigrationReport>("run_migration"),
  uploadImageFile: (postId: string, path: string, format: ImageFormat) => invoke<Uploaded>("upload_image_file", { postId, path, format }),
  /** Pasted bytes go as the raw request body; text travels in headers, percent-encoded. */
  /** `name` empty: a screenshot, named by the time it was pasted. */
  uploadImageBytes: async (postId: string, file: Blob, name: string, format: ImageFormat) =>
    invoke<Uploaded>("upload_image_bytes", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-post": encodeURIComponent(postId), "x-name": encodeURIComponent(name), "x-format": format },
    }),
};

export function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
  const un: Promise<UnlistenFn> = listen<T>(name, (e) => handler(e.payload));
  return () => void un.then((f) => f());
}

/** Messages from commands arrive as plain strings; anything else is shown as text. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
