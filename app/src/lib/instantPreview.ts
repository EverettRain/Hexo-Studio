import MarkdownIt from "markdown-it";
import { fencedRanges, findImages, type FoundImage } from "@/lib/imageMarkup";

/**
 * The body as HTML while it is typed, without Hexo: markdown-it (this blog's renderer) with the
 * options Hexo's renderers default to, the blog's image tags drawn as images, and the theme's
 * other tag plugins as labelled boxes, since only the theme can draw those (the theme preview does).
 */
const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: true });

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function imageHtml(m: FoundImage, resolve: (url: string) => string): string {
  const size = [m.width && `width:${m.width}`, m.height && `height:${m.height}`].filter(Boolean).join(";");
  const img = `<img src="${escape(resolve(m.url))}" alt="${escape(m.alt)}"${m.title ? ` title="${escape(m.title)}"` : ""}${size ? ` style="${escape(size)}"` : ""}>`;
  if (!m.block) return img;
  // The image tag shows its alt text as a caption; Markdown's is only alt text.
  const caption = m.style === "image" && m.alt ? `<figcaption>${escape(m.alt)}</figcaption>` : "";
  return `\n\n<figure>${img}${caption}</figure>\n\n`;
}

/** Tags with an `{% endX %}` wrap the text between them; the rest stand alone. */
function tagPlugins(text: string): string {
  const fences = fencedRanges(text);
  const inFence = (at: number) => fences.some(([a, b]) => at >= a && at < b);
  const blocks = new Set([...text.matchAll(/\{%\s*end(\w+)\s*%\}/g)].map((m) => m[1]));
  return text.replace(/\{%\s*(\w+)([^%]*?)\s*%\}/g, (all, name: string, args: string, at: number) => {
    if (inFence(at)) return all;
    if (name.startsWith("end") && blocks.has(name.slice(3))) return "\n\n</div>\n\n";
    const label = escape(`${name}${args ? ` ${args.trim()}` : ""}`);
    if (blocks.has(name)) return `\n\n<div class="md-tag"><div class="md-tag-head">${label}</div>\n\n`;
    return `<span class="md-tag-inline">${label}</span>`;
  });
}

/** `resolve` turns an image address into one the page can load (site paths go to the preview server). */
export function renderInstant(body: string, resolve: (url: string) => string = (u) => u): string {
  let text = body;
  for (const m of findImages(body).reverse()) text = text.slice(0, m.from) + imageHtml(m, resolve) + text.slice(m.to);
  return md.render(tagPlugins(text));
}
