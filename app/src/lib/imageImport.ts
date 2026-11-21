import type { ImageRecord } from "@/lib/api";
import { sizeText } from "@/lib/images";
import { newImage } from "@/lib/imageMarkup";

/** Files the import panel takes, by extension (what the image crate and macOS's sips can read). */
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg"];
export const isImagePath = (p: string) => IMAGE_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? "");
export const baseName = (p: string) => p.split("/").pop() ?? p;

/** Pasted screenshots arrive as `image.png`: they have no name of their own. */
export const ownFileName = (name: string) => (/^image\.\w+$/i.test(name) ? null : name);

/** The name the library gives an image left unnamed: its file's, or a screenshot's time (as `image_key::screenshot_stem`). */
export function defaultName(fileName: string | null, now: Date): string {
  if (fileName) return fileName.replace(/\.[^.]+$/, "");
  const p = (n: number) => String(n).padStart(2, "0");
  return `image-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Longest-edge choices; 0 keeps the size. */
export const MAX_EDGES = [0, 1280, 1920, 2560, 3840];
export const edgeLabel = (e: number) => (e === 0 ? "原尺寸" : `${e}px`);

/** `3024×4032 · 4.2 MB`. */
export const measure = (m: { width: number; height: number; bytes: number }) => (m.width ? `${m.width}×${m.height} · ${sizeText(m.bytes)}` : sizeText(m.bytes));

/** How much smaller the upload is: `−91%`, `+4%`, or empty when about the same. */
export function saving(original: number, output: number): string {
  if (!original) return "";
  const change = Math.round((output / original - 1) * 100);
  return change === 0 ? "" : change < 0 ? `−${-change}%` : `+${change}%`;
}

/** What "copy" puts on the clipboard for uploaded images. */
export type CopyStyle = "image" | "markdown" | "url";
export const COPY_STYLES: { value: CopyStyle; label: string }[] = [
  { value: "image", label: "{% image %}" },
  { value: "markdown", label: "Markdown" },
  { value: "url", label: "链接" },
];

export function copyText(images: ImageRecord[], style: CopyStyle): string {
  return images.map((img) => (style === "url" ? img.url : newImage(img.url, style))).join("\n");
}
