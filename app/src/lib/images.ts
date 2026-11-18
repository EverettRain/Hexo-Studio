import type { ImageRecord } from "@/lib/api";

/** A small version for thumbnails when the store can scale (Aliyun), else the image itself. */
export function thumbUrl(url: string, thumbQuery: string | null): string {
  return thumbQuery ? `${url}${url.includes("?") ? "&" : "?"}${thumbQuery}` : url;
}

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
