/** One version's notes, from `docs/releases/<tag>.md` (the same file the GitHub release shows). */
export interface Release {
  version: string;
  blocks: Block[];
}

export type Block = { kind: "heading"; text: string } | { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

/** Newest first; `v1.10.0` after `v1.9.0`. */
export function releases(files: Record<string, string>): Release[] {
  const key = (v: string) => v.split(".").map((n) => Number(n) || 0);
  return Object.entries(files)
    .map(([path, text]) => ({ version: (path.split("/").pop() ?? "").replace(/^v|\.md$/g, ""), blocks: parse(text) }))
    .filter((r) => r.version)
    .sort((a, b) => {
      const [x, y] = [key(a.version), key(b.version)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    });
}

/** The little Markdown release notes use: `#` headings, `-` lists, paragraphs. */
export function parse(text: string): Block[] {
  const blocks: Block[] = [];
  // A blank line ends a paragraph; lines right under each other are one.
  let gap = true;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const last = blocks[blocks.length - 1];
    const after = gap;
    gap = !line;
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) blocks.push({ kind: "heading", text: line.replace(/^#+\s+/, "") });
    else if (/^[-*]\s/.test(line)) {
      const item = line.slice(2).trim();
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
    } else if (last?.kind === "paragraph" && !after) last.text += line;
    else blocks.push({ kind: "paragraph", text: line });
  }
  return blocks;
}

/** Inline `code` and **bold**, as text runs. */
export function inline(text: string): { text: string; style: "plain" | "code" | "bold" }[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((t) => (t.startsWith("`") ? { text: t.slice(1, -1), style: "code" } : t.startsWith("**") ? { text: t.slice(2, -2), style: "bold" } : { text: t, style: "plain" }));
}

const files = import.meta.glob<string>("../../../docs/releases/*.md", { query: "?raw", import: "default", eager: true });

/** Every release this build knows, newest first. */
export const RELEASES = releases(files);
