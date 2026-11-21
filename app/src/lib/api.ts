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

/** The site's `_config.yml`, the theme's overrides `_config.<theme>.yml`, the theme's own defaults (read only). */
export type ConfigFile = "site" | "theme" | "themeDefaults";

export interface ConfigText {
  /** From the blog root. */
  path: string;
  /** A missing file reads as empty text; the first save creates it. */
  exists: boolean;
  text: string;
  fingerprint: string;
}

export interface Plugin {
  name: string;
  /** The version range package.json asks for. */
  wanted: string;
  /** Installed version; null when it is not in node_modules (Hexo then skips it). */
  version: string | null;
  description: string | null;
  /** Its source on GitHub. */
  repo: string | null;
  /** Listed by the theme's package.json, not the blog's. */
  fromTheme: boolean;
}

export type ConfigWrite = { status: "saved"; fingerprint: string } | { status: "conflict" };

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface SourceChange {
  path: string;
  from: string | null;
  kind: ChangeKind;
}

export interface SourceStatus {
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  changes: SourceChange[];
}

export interface SourceCommit {
  hash: string;
  subject: string;
  author: string;
  /** Unix seconds. */
  time: number;
}

export interface SourceFile {
  path: string;
  from: string | null;
  kind: ChangeKind;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

export interface SourceCommitDetail extends SourceCommit {
  email: string;
  /** The message after its title line. */
  body: string;
  files: SourceFile[];
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

/** How a new image is written into a post (see `lib/imageMarkup`). */
export type InsertStyle = "image" | "markdown";

export interface UploadSettings {
  format: ImageFormat;
  style: InsertStyle;
  quality: number;
  maxEdge: number;
}

/** One complete way of storing images: a store and how images are uploaded to it. */
export interface Profile {
  id: string;
  name: string;
  storage: Storage;
  upload: UploadSettings;
  /** Saved in the keychain for this store; the secret is never sent back. */
  accessKeyId: string | null;
  /** Library images whose addresses are in this store. */
  images: number;
}

export interface StorageSettings {
  /** The name image paths use now. */
  projectName: string;
  /** Set by hand; null means the folder name. */
  name: string | null;
  profiles: Profile[];
  /** The profile new images go to. */
  active: string | null;
  /** Where originals are kept on this Mac. */
  backupDir: string;
}

export interface ProfileInput {
  /** null creates a profile. */
  id: string | null;
  name: string;
  storage: Storage;
  upload: UploadSettings;
  accessKeyId: string | null;
  /** Empty keeps the saved secret. */
  accessKeySecret: string | null;
}

export interface Mirror {
  label: string;
  url: string;
  date: string;
}

/** One image of the project's library (`.hexostudio/images.json`). */
export interface ImageRecord {
  id: string;
  name: string;
  description: string;
  /** 是否正常, marked by hand. */
  ok: boolean | null;
  key: string;
  url: string;
  uploadedAt: string;
  mirrors: Mirror[];
  format: ImageFormat;
  bytes: number;
  width: number;
  height: number;
  original: { fileName: string; bytes: number; backup: string };
  legacyUrls: string[];
}

export interface ImageCheck {
  /** Unix seconds. */
  at: number;
  ok: boolean;
  message: string;
}

export interface LibraryImage extends ImageRecord {
  /** Files that use it, from the blog root. */
  usedBy: string[];
  check: ImageCheck | null;
  backupPath: string | null;
  /** A small version (scaled by the store when it can), else the image itself. */
  thumb: string;
  /** The profile whose store holds it; null when none does any more. */
  profile: string | null;
}

export interface Library {
  images: LibraryImage[];
  /** Images of the store the blog uses that are not in the library yet. */
  unadopted: number;
  /** Titles of posts and pages by file. */
  titles: Record<string, string>;
}

export interface Ingested {
  image: ImageRecord;
  /** The library had this picture already: nothing was uploaded. */
  existed: boolean;
  originalBytes: number;
}

export interface AdoptionCandidate {
  oldKey: string;
  oldUrl: string;
  files: string[];
  name: string | null;
  description: string | null;
}

export interface AdoptionProgress {
  done: number;
  total: number;
  current: string;
}

export interface AdoptionReport {
  adopted: string[];
  failed: { oldKey: string; error: string }[];
  changedFiles: string[];
}

export interface ImportReport {
  updated: number;
  unmatched: string[];
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
  /** Hexo reads its config only when it starts. */
  previewRestart: () => invoke<number>("preview_restart"),
  previewStop: () => invoke<void>("preview_stop"),
  previewState: () => invoke<PreviewState>("preview_state"),
  previewLog: () => invoke<LogLine[]>("preview_log"),
  previewProbe: (path: string) => invoke<PageProbe>("preview_probe", { path }),
  previewAwaitChange: (path: string, before: PageProbe | null) => invoke<PageProbe>("preview_await_change", { path, before }),
  blogGitChanges: () => invoke<number | null>("blog_git_changes"),
  listPlugins: () => invoke<Plugin[]>("list_plugins"),
  configRead: (file: ConfigFile) => invoke<ConfigText>("config_read", { file }),
  configWrite: (file: ConfigFile, text: string, expected: string) => invoke<ConfigWrite>("config_write", { file, text, expected }),
  sourceStatus: () => invoke<SourceStatus>("source_status"),
  /** One page of the history, newest first, after the `skip` commits already loaded. */
  sourceCommits: (skip: number) => invoke<SourceCommit[]>("source_commits", { skip }),
  sourceCommitDetail: (hash: string) => invoke<SourceCommitDetail>("source_commit_detail", { hash }),
  sourceCommit: (title: string, body: string) => invoke<void>("source_commit", { title, body }),
  sourcePush: () => invoke<void>("source_push"),
  sourcePull: () => invoke<void>("source_pull"),
  runTask: (task: Task) => invoke<number>("run_task", { task }),
  runTaskAndWait: (task: Task) => invoke<Run>("run_task_and_wait", { task }),
  cancelRun: () => invoke<void>("cancel_run"),
  listRuns: () => invoke<Run[]>("list_runs"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  storageProfiles: () => invoke<StorageSettings>("storage_profiles"),
  saveProfile: (input: ProfileInput) => invoke<StorageSettings>("save_profile", { input }),
  deleteProfile: (id: string) => invoke<StorageSettings>("delete_profile", { id }),
  activateProfile: (id: string) => invoke<StorageSettings>("activate_profile", { id }),
  saveLibrarySettings: (input: { name: string | null; backupDir: string | null }) => invoke<StorageSettings>("save_library_settings", { input }),
  /** Tries the form's values before saving; an empty secret uses the saved one. */
  checkStorage: (storage: Storage, accessKeyId: string | null, accessKeySecret: string | null) => invoke<void>("check_storage", { storage, accessKeyId, accessKeySecret }),
  imageLibrary: () => invoke<Library>("image_library"),
  updateImage: (id: string, patch: { name: string; description: string; ok: boolean | null; mirrors: Mirror[] }) =>
    invoke<ImageRecord>("update_image", { id, patch }),
  deleteImage: (id: string) => invoke<void>("delete_image", { id }),
  checkImages: () => invoke<Record<string, ImageCheck>>("check_images"),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  adoptionPlan: (checklist: string | null) => invoke<AdoptionCandidate[]>("adoption_plan", { checklist }),
  runAdoption: (checklist: string | null) => invoke<AdoptionReport>("run_adoption", { checklist }),
  importChecklist: (path: string) => invoke<ImportReport>("import_checklist", { path }),
  exportChecklist: (path: string) => invoke<void>("export_checklist", { path }),
  /** `postId` null: added on the image page, not for a post. */
  uploadImageFile: (postId: string | null, path: string, format: ImageFormat) => invoke<Ingested>("upload_image_file", { postId, path, format }),
  /** Pasted bytes go as the raw request body; text travels in headers, percent-encoded. */
  /** `name` empty: a screenshot, named by the time it was pasted. */
  uploadImageBytes: async (postId: string | null, file: Blob, name: string, format: ImageFormat) =>
    invoke<Ingested>("upload_image_bytes", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-post": encodeURIComponent(postId ?? ""), "x-name": encodeURIComponent(name), "x-format": format },
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
