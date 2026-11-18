/**
 * The ways this blog writes an image, read and written exactly as its renderer and theme parse
 * them: Markdown with markdown-it-imsize's `=WxH`, and the anzhiyu tags `image`, `inlineimage`
 * and `inlineImg` (themes/anzhiyu/scripts/tag/image.js, inlineImg.js).
 */

export type ImageStyle = "image" | "markdown" | "inlineimage" | "inlineImg";

export interface ImageMarkup {
  style: ImageStyle;
  url: string;
  /** The `image` tag shows it as a caption; Markdown's is only alt text. */
  alt: string;
  /** CSS lengths (`400px`, `50%`), empty when not set. */
  width: string;
  height: string;
  /** Placeholder background of the `image` tag. */
  bg: string;
  /** Markdown's `"title"`. */
  title: string;
  /** Tag arguments this app has no control for, kept as written. */
  extra: string[];
}

export interface FoundImage extends ImageMarkup {
  from: number;
  to: number;
  /** Alone on its line (a picture of its own rather than one inside a sentence). */
  block: boolean;
}

const blank = (m: Partial<ImageMarkup> & Pick<ImageMarkup, "style" | "url">): ImageMarkup => ({ alt: "", width: "", height: "", bg: "", title: "", extra: [], ...m });

// `![alt](url =WxH "title")`; imsize allows digits and `%` only, with nothing between `=` and the size.
const MARKDOWN = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+=([\d%]*)x([\d%]*))?(?:\s+"([^"\n]*)")?\s*\)/y;
const TAG = /\{%\s*(image|inlineimage|inlineImg)\s+([^\n]*?)\s*%\}/y;

/** `400` (imsize's pixels) as a CSS length. */
const fromImsize = (v: string) => (v === "" ? "" : v.endsWith("%") ? v : `${v}px`);
/** A CSS length as imsize can write it, or empty when it cannot (`2em`). */
const toImsize = (v: string) => {
  const t = v.trim();
  return /^\d+(px)?$/.test(t) ? t.replace(/px$/, "") : /^\d+%$/.test(t) ? t : "";
};

function parseTag(name: string, args: string): ImageMarkup | null {
  if (name === "inlineImg") {
    // Hexo splits tag arguments on spaces: `{% inlineImg src height %}`.
    const [url, height = "", ...rest] = args.split(/\s+/);
    return url ? blank({ style: "inlineImg", url, height, extra: rest }) : null;
  }
  // The theme joins the arguments and splits on ", " (comma and space) exactly.
  const [url, ...rest] = args.split(", ");
  if (!url?.trim()) return null;
  const m = blank({ style: name as ImageStyle, url: url.trim() });
  for (const raw of rest) {
    const a = raw.trim();
    // Same order of tests as the theme: an `alt` that mentions `width=` is still the alt.
    if (name === "image" && a.includes("alt=")) m.alt = a.slice(4);
    else if (name === "image" && a.includes("width=")) m.width = a.slice(6);
    else if (a.includes("height=")) m.height = a.slice(7);
    else if (name === "image" && a.includes("bg=")) m.bg = a.slice(3);
    else m.extra.push(a);
  }
  return m;
}

/** Ranges of fenced code blocks, where image syntax is only shown, not rendered. */
function fencedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { at: number; fence: string } | null = null;
  for (let m; (m = re.exec(text)); ) {
    const fence = m[1];
    if (!open) open = { at: m.index, fence };
    else if (fence[0] === open.fence[0] && fence.length >= open.fence.length && m[0].trim() === fence) {
      out.push([open.at, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) out.push([open.at, text.length]);
  return out;
}

/** Every image in the text, in order, outside fenced code. */
export function findImages(text: string): FoundImage[] {
  const fences = fencedRanges(text);
  const out: FoundImage[] = [];
  const starts = /!\[|\{%/g;
  let f = 0;
  for (let s; (s = starts.exec(text)); ) {
    const at = s.index;
    while (f < fences.length && fences[f][1] <= at) f++;
    if (f < fences.length && fences[f][0] <= at) {
      starts.lastIndex = fences[f][1];
      continue;
    }
    let found: ImageMarkup | null = null;
    let end = at;
    if (s[0] === "![") {
      MARKDOWN.lastIndex = at;
      const m = MARKDOWN.exec(text);
      if (m) {
        const url = m[2].startsWith("<") ? m[2].slice(1, -1) : m[2];
        found = blank({ style: "markdown", url, alt: m[1], width: fromImsize(m[3] ?? ""), height: fromImsize(m[4] ?? ""), title: m[5] ?? "" });
        end = at + m[0].length;
      }
    } else {
      TAG.lastIndex = at;
      const m = TAG.exec(text);
      if (m) {
        found = parseTag(m[1], m[2]);
        end = at + m[0].length;
      }
    }
    if (!found) continue;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const nl = text.indexOf("\n", end);
    const block = text.slice(lineStart, at).trim() === "" && text.slice(end, nl < 0 ? text.length : nl).trim() === "";
    out.push({ ...found, from: at, to: end, block });
    starts.lastIndex = end;
  }
  return out;
}

/** The image at `pos` (inside its markup), if any. */
export function imageAt(text: string, pos: number): FoundImage | null {
  return findImages(text).find((f) => f.from <= pos && pos < f.to) ?? null;
}

/**
 * The markup for an image. Values are cleaned so the theme reads them back the same: no ", " in
 * the `image` tag's values (it splits on that), nothing that ends the tag.
 */
export function renderImage(m: ImageMarkup): string {
  const clean = (v: string) => v.replace(/, /g, "，").replace(/%\}/g, "%").replace(/\n/g, " ").trim();
  switch (m.style) {
    case "markdown": {
      const w = toImsize(m.width);
      const h = toImsize(m.height);
      const size = w || h ? ` =${w}x${h}` : "";
      const title = m.title ? ` "${m.title.replace(/"/g, "'")}"` : "";
      const url = /[\s()]/.test(m.url) ? `<${m.url}>` : m.url;
      return `![${m.alt.replace(/[[\]\n]/g, "")}](${url}${size}${title})`;
    }
    case "image": {
      const args = [m.url];
      if (m.width.trim()) args.push(`width=${clean(m.width)}`);
      if (m.height.trim()) args.push(`height=${clean(m.height)}`);
      if (m.bg.trim()) args.push(`bg=${clean(m.bg)}`);
      if (m.alt.trim()) args.push(`alt=${clean(m.alt)}`);
      return `{% image ${[...args, ...m.extra].join(", ")} %}`;
    }
    case "inlineimage": {
      const args = [m.url];
      if (m.height.trim()) args.push(`height=${clean(m.height)}`);
      return `{% inlineimage ${[...args, ...m.extra].join(", ")} %}`;
    }
    case "inlineImg":
      return `{% inlineImg ${[m.url, m.height.trim().replace(/\s+/g, ""), ...m.extra].filter(Boolean).join(" ")} %}`;
  }
}

/** A new image in the given style, with nothing else set. */
export function newImage(url: string, style: ImageStyle): string {
  return renderImage(blank({ style, url }));
}

/** The same image in another style, keeping what that style can hold. */
export function restyle(m: ImageMarkup, style: ImageStyle): ImageMarkup {
  if (m.style === style) return m;
  // Arguments of another tag mean nothing here.
  return { ...m, style, extra: [] };
}
