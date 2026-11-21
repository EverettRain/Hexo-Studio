import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AppInfo {
  version: string;
  dataDir: string;
}

/** The person using the app (one for now). */
export interface UserView {
  name: string;
  /** A data: URL; null shows the name's first letter. */
  avatar: string | null;
}

export type ThemeMode = "system" | "light" | "dark";

/** What only the interface reads and writes, kept in the user's preferences. */
export interface UiPreferences {
  mode: ThemeMode;
  /** A theme id from `lib/theme`'s THEMES; anything else shows the default. */
  theme: string;
  /** The editor's preview column as a share of its width; null until dragged. */
  previewShare: number | null;
  /** Values kept in the WebView's storage before preferences existed were brought over. */
  webStorageMigrated: boolean;
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

/** Who made a template (or Hexo) and where to read about it. */
export interface Credits {
  author: string;
  /** The author's own site. */
  authorUrl: string;
  /** The official site, with a live preview for a theme. */
  website: string;
  docs: string;
  repo: string;
  license: string;
}

/** Hexo's base plus one theme, to start a new blog from. */
export interface BlogTemplate {
  id: string;
  name: string;
  description: string;
  theme: string;
  /** The theme on npm. */
  package: string;
  plugins: string[];
  credits: Credits;
}

export interface NewBlogForm {
  templates: BlogTemplate[];
  /** Shown with plain Hexo. */
  hexo: Credits;
  /** Where the last opened blog is, else the home folder. */
  parent: string;
  /** git's user.name; empty without one. */
  author: string;
}

export interface NewBlog {
  /** Null makes a plain Hexo blog, as `hexo init` does. */
  template: string | null;
  parent: string;
  folder: string;
  title: string;
  author: string;
}

export type CreateStep = "files" | "theme" | "install" | "git";

/** A step begins (those before it are done), or a line of npm's output. */
export type CreateProgress = { kind: "step"; step: CreateStep } | { kind: "line"; text: string };

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
  userProfile: () => invoke<UserView>("user_profile"),
  setUserName: (name: string) => invoke<UserView>("set_user_name", { name }),
  setUserAvatar: (path: string) => invoke<UserView>("set_user_avatar", { path }),
  clearUserAvatar: () => invoke<UserView>("clear_user_avatar"),
  uiPreferences: () => invoke<UiPreferences>("ui_preferences"),
  saveUiPreferences: (ui: UiPreferences) => invoke<void>("save_ui_preferences", { ui }),
  recentProjects: () => invoke<ProjectCard[]>("recent_projects"),
  openProject: (path: string) => invoke<BlogStatus>("open_project", { path }),
  closeProject: () => invoke<void>("close_project"),
  forgetProject: (path: string) => invoke<void>("forget_project", { path }),
  newBlogForm: () => invoke<NewBlogForm>("new_blog_form"),
  /** Makes the blog (progress as `create-progress` events) and returns its folder. */
  createBlog: (blog: NewBlog) => invoke<string>("create_blog", { blog }),
  cancelCreate: () => invoke<void>("cancel_create"),
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
  /** Page data files in source/_data, by name. */
  dataFiles: () => invoke<string[]>("data_files"),
  dataRead: (name: string) => invoke<ConfigText>("data_read", { name }),
  dataWrite: (name: string, text: string, expected: string) => invoke<ConfigWrite>("data_write", { name, text, expected }),
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
  /** An image file dropped on the window or chosen in a dialog, as bytes. */
  readImageFile: async (path: string) => new Blob([await invoke<ArrayBuffer>("read_image_file", { path })]),
  /** How an image would be uploaded with these settings, worked out without uploading it. */
  prepareImage: async (image: Blob, fileName: string | null, conversion: Conversion) =>
    invoke<PreparedImage>("prepare_image", new Uint8Array(await image.arrayBuffer()), { headers: imageHeaders({ "x-file": fileName ?? "", ...conversionHeaders(conversion) }) }),
  /** Takes an image into the library through the active profile. */
  uploadImage: async (image: Blob, meta: UploadMeta, conversion: Conversion) =>
    invoke<Ingested>("upload_image_bytes", new Uint8Array(await image.arrayBuffer()), {
      headers: imageHeaders({ "x-file": meta.fileName ?? "", "x-name": meta.name, "x-description": meta.description, "x-post": meta.postId ?? "", ...conversionHeaders(conversion) }),
    }),
  /** Makes a WebP quality and longest edge the active profile's defaults. */
  setUploadEncoding: (quality: number, maxEdge: number) => invoke<StorageSettings>("set_upload_encoding", { quality, maxEdge }),
};

/** How an image is converted on the way in. */
export interface Conversion {
  format: ImageFormat;
  quality: number;
  maxEdge: number;
}

export interface UploadMeta {
  /** The file's own name; null for a screenshot (named by the time). */
  fileName: string | null;
  /** The library's name for it; empty takes the file's. */
  name: string;
  /** Where it is used; empty takes "<post> 内图" for a post. */
  description: string;
  postId: string | null;
}

export interface Measured {
  bytes: number;
  width: number;
  height: number;
}

export interface PreparedImage {
  id: string;
  /** The library holds this picture already. */
  existing: ImageRecord | null;
  original: Measured;
  /** What would be uploaded: WebP, or the original (asked for, or a GIF / SVG). */
  format: ImageFormat;
  output: Measured;
  /** The converted image, base64 WebP; null when the original is kept. */
  preview: string | null;
}

const conversionHeaders = (c: Conversion) => ({ "x-format": c.format, "x-quality": String(c.quality), "x-max-edge": String(c.maxEdge) });

/** Text for raw-body commands travels in headers, percent-encoded. */
function imageHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, encodeURIComponent(v)]));
}

export function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
  const un: Promise<UnlistenFn> = listen<T>(name, (e) => handler(e.payload));
  return () => void un.then((f) => f());
}

/** Messages from commands arrive as plain strings; anything else is shown as text. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
