import type { ImageRecord, LibraryImage } from "@/lib/api";

export function sizeText(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Whether a library image matches a search: name, description, uid, original file name. */
export function matchesImage(img: ImageRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [img.name, img.description, img.id, img.original.fileName].join("\n").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** The editor knows a post as `_posts/x.md`; the library lists files from the blog root. */
export const usesPost = (usedBy: string[], postId: string) => usedBy.some((f) => f.endsWith(`/${postId}`));

/** What the editor shows for an image instead of its address. */
export interface ImageInfo {
  /** The library's uid; null for an image the library does not hold. */
  id: string | null;
  name: string;
  thumb: string;
  width: number;
  height: number;
}

export type ImageIndex = ReadonlyMap<string, ImageInfo>;

/** An address without its query (`?x-oss-process=…`), as the library records addresses. */
const bare = (url: string) => url.split(/[?#]/)[0];

/** Library images by address, current and from before adoption. */
export function indexImages(images: LibraryImage[]): ImageIndex {
  const index = new Map<string, ImageInfo>();
  for (const img of images) {
    const info: ImageInfo = { id: img.id, name: img.name, thumb: img.thumb, width: img.width, height: img.height };
    for (const u of [img.url, ...img.legacyUrls]) index.set(bare(u), info);
  }
  return index;
}

/** The library's image at this address, or one named after the file for an image it does not hold. */
export function describeImage(index: ImageIndex, url: string): ImageInfo {
  const found = index.get(bare(url));
  if (found) return found;
  const file = bare(url).split("/").pop() ?? "";
  let name = file;
  try {
    name = decodeURIComponent(file);
  } catch {
    /* a malformed escape: keep it as written */
  }
  return { id: null, name: name || url, thumb: url, width: 0, height: 0 };
}
