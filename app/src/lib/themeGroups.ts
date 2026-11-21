/**
 * The anzhiyu theme's sections grouped by what they are for (design 14.3), instead of the
 * theme file's own headers. Written for anzhiyu 1.6.14 as EverettBlog uses it; sections not
 * listed here still show, under "其他", and every key stays editable in the generic fields.
 */

export interface TaskGroup {
  title: string;
  /** Top-level keys, or a panel id (`search`) that edits several sections at once. */
  items: string[];
}

export const SEARCH_PANEL = "@search";

export const THEME_GROUPS: TaskGroup[] = [
  { title: "首页与外观", items: ["home_top", "subtitle", "index_img", "default_top_img", "disable_top_img", "cover", "theme_color", "mainTone", "font", "blog_title_font", "display_mode", "darkmode", "article_double_row", "index_post_content", "index_site_info_top", "index_top_img_height", "category_ui", "tag_ui", "favicon", "avatar", "error_img", "error_404"] },
  { title: "导航", items: ["menu", "nav", "social", "rightClickMenu", "centerConsole", "rightside_item_order", "rightside-bottom", "translate", "readmode", "console", "shortcutKey", "accesskey"] },
  { title: "侧边栏", items: ["aside", "author_status", "busuanzi", "runtimeshow", "newest_comments", "sidebar"] },
  { title: "文章页", items: ["post_meta", "toc", "post_copyright", "related_post", "post_pagination", "noticeOutdate", "wordcount", "ptool", "reward", "post_edit", "post_head_ai_description", "highlight_theme", "highlight_copy", "highlight_lang", "highlight_shrink", "highlight_height_limit", "code_word_wrap", "copy", "anchor", "photofigcaption", "h2Divider", "table_interlaced_discoloration", "medium_zoom", "fancybox", "note", "sharejs", "addtoany"] },
  { title: "评论", items: ["comments", "twikoo", "waline", "valine", "artalk", "giscus", "comment_barrage_config"] },
  { title: "在线聊天", items: ["chat_btn", "chat_hide_show", "chatra", "tidio", "daovoice", "crisp"] },
  { title: "搜索与公式", items: [SEARCH_PANEL, "algolia_search", "local_search", "docsearch", "mathjax", "katex", "mermaid"] },
  { title: "页脚", items: ["footer", "footer_bg"] },
  { title: "友链与页面", items: ["friends_vue", "linkPageTop", "visitorMail", "agreementPopup"] },
  { title: "音乐", items: ["nav_music", "music_page", "aplayerInject"] },
  {
    title: "特效",
    items: ["preloader", "canvas_ribbon", "canvas_fluttering_ribbon", "canvas_nest", "activate_power_mode", "fireworks", "click_heart", "ClickShowText", "peoplecanvas", "universe", "bubble", "mourn", "beautify", "hr_icon", "dynamicEffect", "greetingBox", "diytitle"],
  },
  { title: "统计、验证与广告", items: ["baidu_analytics", "google_analytics", "cnzz_analytics", "cloudflare_analytics", "microsoft_clarity", "LA", "site_verification", "google_adsense"] },
  { title: "高级", items: ["inject", "CDN", "pjax", "lazyload", "pwa", "icons", "instantpage", "snackbar", "pangu", "Open_Graph_meta", "css_prefix", "pageThumbnailSuffix"] },
];

/** The search services the theme can use; it takes the first enabled one, in this order. */
export const SEARCH_SERVICES = [
  { key: "algolia_search", label: "Algolia" },
  { key: "local_search", label: "本地搜索" },
  { key: "docsearch", label: "DocSearch" },
] as const;

/** Comment services by the name `comments.use` takes, and the section holding each one's settings. */
export const COMMENT_SERVICES = [
  { name: "Twikoo", key: "twikoo" },
  { name: "Waline", key: "waline" },
  { name: "Valine", key: "valine" },
  { name: "Artalk", key: "artalk" },
  { name: "Giscus", key: "giscus" },
] as const;

/** What `comments.use` names, in order (the theme reads a comma list or a list, any case). */
export function commentServices(use: unknown): string[] {
  const names = Array.isArray(use) ? use.map(String) : typeof use === "string" ? use.split(",") : [];
  return names
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => COMMENT_SERVICES.find((s) => s.name.toLowerCase() === n.toLowerCase())?.name ?? n);
}

/** `comments.use` for these services, in the form the file already uses. */
export function writeCommentServices(old: unknown, names: string[]): unknown {
  if (Array.isArray(old)) return names;
  return names.length ? names.join(",") : null;
}

export const ASIDE_CARDS: Record<string, string> = {
  card_author: "作者",
  card_announcement: "公告",
  card_weixin: "微信",
  card_recent_post: "最近文章",
  card_categories: "分类",
  card_tags: "标签",
  card_archives: "归档",
  card_webinfo: "网站信息",
};

/** The groups for this file: listed sections that are there, then the rest under "其他". */
export function taskGroups(keys: string[]): TaskGroup[] {
  const present = new Set(keys);
  const listed = new Set(THEME_GROUPS.flatMap((g) => g.items));
  const groups = THEME_GROUPS.map((g) => ({ ...g, items: g.items.filter((k) => k === SEARCH_PANEL || present.has(k)) })).filter((g) => g.items.length);
  const rest = keys.filter((k) => !listed.has(k));
  return rest.length ? [...groups, { title: "其他", items: rest }] : groups;
}

/**
 * Whether a key holds an image address: its value is a picture file or a library image, or its
 * name says so (anzhiyu's `img`, `avatar`, `cover`…; not `icon`, which is mostly a font class).
 */
const IMAGE_KEY = /(img|image|avatar|cover|background|bg|face|logo|favicon|qrcode|qr_code|poster|banner)$/i;
const IMAGE_VALUE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)([?#].*)?$/i;

export function looksLikeImage(key: string | number, value: unknown, inLibrary: boolean): boolean {
  if (typeof value !== "string" && value !== null && value !== undefined) return false;
  const text = typeof value === "string" ? value.trim() : "";
  if (text.includes("||") || text.includes("<") || /\s/.test(text)) return false;
  return inLibrary || IMAGE_VALUE.test(text) || (typeof key === "string" && IMAGE_KEY.test(key));
}
