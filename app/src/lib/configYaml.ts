import { Document, isCollection, isMap, isPair, isScalar, isSeq, parseDocument, type Node, type Pair, type YAMLMap, type YAMLSeq } from "yaml";

/**
 * Config files as the config page edits them: one value at a time, by its path, rewriting only
 * that value's text so every comment, key order and quoting choice elsewhere stays byte for
 * byte (as `frontmatter.ts` does for posts). Each edit is checked by reading the result back;
 * an edit whose result would mean something else is refused instead of written.
 */

export type Path = (string | number)[];

export interface ReadResult {
  /** The file as plain values; null when it cannot be read. */
  data: unknown;
  error: string | null;
}

export function readConfig(text: string): ReadResult {
  const doc = parseDocument(text);
  if (doc.errors.length) return { data: null, error: doc.errors[0].message };
  return { data: doc.toJS() ?? {}, error: null };
}

export const pathKey = (path: Path): string => JSON.stringify(path);

export function getIn(data: unknown, path: Path): unknown {
  let at: unknown = data;
  for (const k of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[k];
  }
  return at;
}

function setIn(data: unknown, path: Path, value: unknown): unknown {
  if (!path.length) return value;
  const [head, ...rest] = path;
  const base = data !== null && typeof data === "object" ? data : typeof head === "number" ? [] : {};
  const copy = (Array.isArray(base) ? [...base] : { ...(base as object) }) as Record<string | number, unknown>;
  copy[head] = setIn(copy[head], rest, value);
  return copy;
}

/** Plain values compared as the file means them (dates by their text). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : x)) ?? "undefined";
  return norm(a) === norm(b);
}

// ---- Hexo's merge -------------------------------------------------------------------------

const mergeable = (v: unknown): v is object => v !== null && typeof v === "object" && !(v instanceof Date) && !(v instanceof RegExp);
const clone = (v: unknown): unknown => (mergeable(v) ? merge(Array.isArray(v) ? [] : {}, v) : v);

/**
 * How Hexo 7 lays `_config.<theme>.yml` over the theme's defaults (`hexo-util`'s `deepMerge`, on
 * the `deepmerge` package): objects merge key by key; a list merges item by item by position,
 * and a plain item the defaults already hold anywhere is not added again, so a list can grow
 * but never lose an item the defaults have.
 */
export function merge(defaults: unknown, overrides: unknown): unknown {
  if (Array.isArray(overrides)) {
    if (!Array.isArray(defaults)) return overrides.map(clone);
    const out = defaults.map(clone);
    overrides.forEach((item, i) => {
      if (out[i] === undefined) out[i] = clone(item);
      else if (mergeable(item)) out[i] = merge(defaults[i], item);
      else if (!defaults.includes(item)) out.push(item);
    });
    return out;
  }
  if (mergeable(overrides) && mergeable(defaults) && !Array.isArray(defaults)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(defaults)) out[k] = clone(v);
    for (const [k, v] of Object.entries(overrides)) out[k] = k in defaults && mergeable(v) ? merge((defaults as Record<string, unknown>)[k], v) : clone(v);
    return out;
  }
  return clone(overrides);
}

// ---- hints from comments ------------------------------------------------------------------

const SEPARATOR = /^-{6,}$/;
/** A commented-out line of YAML (an example), not prose. */
const CODE_LINE = /^(-\s|[\w.-]+:(\s|$)|<)/;

function commentLines(raw: string | null | undefined): string[] {
  return (raw ?? "").split("\n").map((l) => l.replace(/^\s*#*\s?/, "").trim());
}

/** The comment paragraph right above a key: after the last blank or separator line. */
function ownParagraph(raw: string | null | undefined): string {
  const lines = commentLines(raw);
  let from = 0;
  lines.forEach((l, i) => {
    if (!l || SEPARATOR.test(l)) from = i + 1;
  });
  return lines
    .slice(from)
    .filter((l) => !CODE_LINE.test(l))
    .slice(0, 3)
    .join(" ");
}

/** The comment on the same line as a scalar value, e.g. `light # darker / pale night / …`. */
function inlineComment(node: Node | null | undefined, text: string): string {
  if (!isScalar(node) || !node.comment || !node.range) return "";
  const lineEnd = text.indexOf("\n", node.range[1]);
  return text.slice(node.range[1], lineEnd < 0 ? text.length : lineEnd).includes("#") ? commentLines(node.comment)[0] ?? "" : "";
}

export interface Outline {
  /** Comment hints by `pathKey`. */
  hints: Map<string, string>;
  /** Top-level keys under the file's own section headers (a comment line over `# ------`). */
  groups: { title: string; keys: string[] }[];
}

export function outline(text: string): Outline {
  const doc = parseDocument(text);
  const hints = new Map<string, string>();
  const groups: Outline["groups"] = [];
  const walk = (node: unknown, path: Path) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue;
        const p = [...path, String(pair.key.value)];
        const hint = [ownParagraph(pair.key.commentBefore), inlineComment(pair.value as Node, text)].filter(Boolean).join(" · ");
        if (hint) hints.set(pathKey(p), hint);
        walk(pair.value, p);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, [...path, i]));
    }
  };
  walk(doc.contents, []);

  // Headers are found in the text itself: after a nested block the parser hands such a comment
  // to that block, not to the key below it.
  if (isMap(doc.contents)) {
    const headers: { at: number; title: string }[] = [];
    const lines = text.split("\n");
    let offset = 0;
    lines.forEach((line, i) => {
      if (/^#\s*-{6,}\s*$/.test(line)) {
        let top = i;
        while (top > 0 && /^#/.test(lines[top - 1]) && !/^#\s*-{6,}\s*$/.test(lines[top - 1])) top--;
        const title = top < i ? lines[top].replace(/^#+\s*/, "").trim() : "";
        if (title) headers.push({ at: offset, title });
      }
      offset += line.length + 1;
    });
    let h = 0;
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key) || !pair.key.range) continue;
      let title: string | null = null;
      while (h < headers.length && headers[h].at < pair.key.range[0]) title = headers[h++].title;
      if (title !== null || !groups.length) groups.push({ title: title ?? "", keys: [] });
      groups[groups.length - 1].keys.push(String(pair.key.value));
    }
  }
  return { hints, groups };
}

// ---- edits --------------------------------------------------------------------------------

const lineStart = (t: string, at: number) => t.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (t: string, at: number) => {
  const n = t.indexOf("\n", at);
  return n < 0 ? t.length : n;
};
const column = (t: string, at: number) => at - lineStart(t, at);
/** The end of a node's own text: before the newlines and spaces block nodes end with. */
const contentEnd = (t: string, node: Node) => {
  let e = node.range![1];
  while (e > node.range![0] && /\s/.test(t[e - 1])) e--;
  return e;
};

function parse(text: string): Document.Parsed {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`配置文件有语法错误：${doc.errors[0].message}`);
  return doc;
}

interface Slot {
  /** The collection holding the value. */
  parent: YAMLMap | YAMLSeq;
  pair: Pair | null;
  index: number;
  node: Node | null;
}

function find(doc: Document.Parsed, path: Path): Slot | null {
  let node: unknown = doc.contents;
  let slot: Slot | null = null;
  for (const k of path) {
    if (isMap(node) && typeof k === "string") {
      const index = node.items.findIndex((p) => isScalar(p.key) && String(p.key.value) === k);
      if (index < 0) return null;
      const pair = node.items[index];
      slot = { parent: node, pair, index, node: (pair.value as Node | null) ?? null };
    } else if (isSeq(node) && typeof k === "number" && k < node.items.length) {
      slot = { parent: node, pair: null, index: k, node: (node.items[k] as Node | null) ?? null };
    } else {
      return null;
    }
    node = slot.node;
  }
  return slot;
}

/** Inside a flow collection (`[a, b]`, `{a: 1}`), where `,` and brackets end a plain value. */
const inFlow = (slot: Slot) => !!slot.parent.flow;

function renderScalar(value: unknown, old: Node | null, flow: boolean): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return String(value);
  if (value.includes("\n")) return JSON.stringify(value);
  if (isScalar(old) && (old.type === "QUOTE_SINGLE" || old.type === "QUOTE_DOUBLE")) {
    const doc = new Document(value);
    (doc.contents as { type?: string }).type = old.type;
    return doc.toString({ lineWidth: 0 }).trimEnd();
  }
  const plain = new Document(value).toString({ lineWidth: 0 }).trimEnd();
  if (/^[|>]/.test(plain) || (flow && !/^["']/.test(plain) && /[,[\]{}#]/.test(plain))) return JSON.stringify(value);
  return plain;
}

/** A collection as block lines at `indent` columns, or in flow / empty form on its line. */
function renderBlock(value: unknown, indent: number): string {
  const body = new Document(value).toString({ lineWidth: 0 }).trimEnd();
  return `\n${body
    .split("\n")
    .map((l) => (l ? " ".repeat(indent) + l : l))
    .join("\n")}`;
}

function renderFlow(value: unknown): string {
  const doc = new Document(value);
  if (isCollection(doc.contents)) doc.contents.flow = true;
  // `[a, b]`, as config files write flow lists, not the library's padded `[ a, b ]`.
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
}

const isPlainCollection = (v: unknown) => v !== null && typeof v === "object" && !(v instanceof Date);
const isEmptyCollection = (v: unknown) => (Array.isArray(v) ? v.length === 0 : isPlainCollection(v) && Object.keys(v as object).length === 0);

/** Right after a key's colon, where its value's text begins. */
function afterColon(text: string, pair: Pair): number {
  return text.indexOf(":", (pair.key as Node).range![1]) + 1;
}

/** The splice that gives `slot` the value `value`. */
function replaceSlot(text: string, slot: Slot, value: unknown): { start: number; end: number; with: string } {
  const old = slot.node;
  const flowParent = inFlow(slot);
  const collection = isPlainCollection(value);

  if (!collection && (!old || isScalar(old))) {
    const rendered = renderScalar(value, old, flowParent);
    if (old?.range && old.range[1] > old.range[0]) {
      let start = old.range[0];
      // Emptying a value leaves `key:`, as the files write empty values.
      if (!rendered) while (start > 0 && text[start - 1] === " ") start--;
      return { start, end: old.range[1], with: rendered };
    }
    if (slot.pair) {
      const at = afterColon(text, slot.pair);
      return { start: at, end: at, with: rendered ? ` ${rendered}` : "" };
    }
    throw new Error("无法改写这一项");
  }

  if (!slot.pair) throw new Error("无法改写列表里的整项，请逐个修改");
  const start = afterColon(text, slot.pair);
  const end = old?.range ? contentEnd(text, old) : start;
  if (flowParent || (isCollection(old) && old.flow) || isEmptyCollection(value) || !collection) {
    const rendered = collection ? renderFlow(value) : renderScalar(value, old, flowParent);
    return { start, end, with: rendered ? ` ${rendered}` : "" };
  }
  const keyColumn = column(text, (slot.pair.key as Node).range![0]);
  let indent = keyColumn + 2;
  if (isCollection(old) && old.items.length) {
    const first = old.items[0] as Node | Pair;
    const firstNode = (isPair(first) ? first.key : first) as Node;
    const ls = lineStart(text, firstNode.range![0]);
    indent = text.slice(ls).search(/\S/);
  }
  return { start, end, with: renderBlock(value, indent) };
}

function splice(text: string, s: { start: number; end: number; with: string }): string {
  return text.slice(0, s.start) + s.with + text.slice(s.end);
}

function checked(before: unknown, path: Path, expectedAt: unknown, out: string): string {
  const result = parseDocument(out);
  const expected = setIn(before, path, expectedAt);
  if (result.errors.length || !sameValue(result.toJS() ?? {}, expected)) {
    throw new Error("无法在保留原有格式的前提下写入这一项。");
  }
  return out;
}

/**
 * Sets the value at `path`, adding the keys on the way when they are not there (a key only the
 * theme's defaults have, say). Throws when the file cannot be read or the edit would not mean
 * what it asks.
 */
export function setValue(text: string, path: Path, value: unknown): string {
  const doc = parse(text);
  const before = doc.toJS() ?? {};
  const slot = find(doc, path);
  // Nothing to write; also keeps a long value folded over several lines as it is.
  if (slot && sameValue(getIn(before, path), value)) return text;
  if (slot) return checked(before, path, value, splice(text, replaceSlot(text, slot, value)));

  // Missing: find the deepest map along the path and add the rest of it there.
  let depth = path.length - 1;
  while (depth > 0 && !find(doc, path.slice(0, depth))) depth--;
  const owner = depth > 0 ? find(doc, path.slice(0, depth))! : null;
  const ownerNode = owner ? owner.node : (doc.contents as Node | null);
  const rest = path.slice(depth);
  if (rest.some((k) => typeof k !== "string")) throw new Error("无法在列表里新加这一项");
  const added = rest.reduceRight<unknown>((v, k) => ({ [k as string]: v }), value);

  if (isMap(ownerNode) && !ownerNode.flow && ownerNode.items.length) {
    const firstKey = ownerNode.items[0].key as Node;
    const indent = column(text, firstKey.range![0]);
    const at = lineEnd(text, contentEnd(text, ownerNode));
    return checked(before, path, value, splice(text, { start: at, end: at, with: renderBlock(added, indent) }));
  }
  if (!owner) {
    if (ownerNode !== null && !(isScalar(ownerNode) && ownerNode.value === null) && !isMap(ownerNode)) throw new Error("配置文件的最外层不是键值表");
    if (isMap(ownerNode) && ownerNode.items.length) {
      return setValue(text, [], merge(before, added));
    }
    const body = new Document(added).toString({ lineWidth: 0 });
    return checked(before, path, value, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${body}`);
  }
  if (isMap(ownerNode) || ownerNode === null || (isScalar(ownerNode) && ownerNode.value === null)) {
    const current = isMap(ownerNode) ? (getIn(before, path.slice(0, depth)) as object) : {};
    return checked(before, path, value, splice(text, replaceSlot(text, owner, { ...current, ...(added as object) })));
  }
  throw new Error("上一级不是键值表，无法加入这一项");
}

function seqAt(doc: Document.Parsed, path: Path): { slot: Slot; seq: YAMLSeq } {
  const slot = find(doc, path);
  if (!slot || !isSeq(slot.node)) throw new Error("这一项不是列表");
  return { slot, seq: slot.node };
}

/** Removes item `index` of the list at `path`. */
export function removeItem(text: string, path: Path, index: number): string {
  const doc = parse(text);
  const before = doc.toJS() ?? {};
  const list = getIn(before, path) as unknown[];
  const next = list.filter((_, i) => i !== index);
  const { slot, seq } = seqAt(doc, path);
  if (seq.flow || seq.items.length === 1) return checked(before, path, next, splice(text, replaceSlot(text, slot, next)));
  const item = seq.items[index] as Node;
  const start = lineStart(text, item.range![0]);
  const end = lineEnd(text, contentEnd(text, item));
  return checked(before, path, next, text.slice(0, start) + text.slice(Math.min(end + 1, text.length)));
}

/** Adds `value` at the end of the list at `path` (making the list when there is none). */
export function appendItem(text: string, path: Path, value: unknown): string {
  const doc = parse(text);
  const before = doc.toJS() ?? {};
  const current = getIn(before, path);
  const next = [...(Array.isArray(current) ? current : []), value];
  const slot = find(doc, path);
  if (!slot || !isSeq(slot.node) || slot.node.flow || !slot.node.items.length) return setValue(text, path, next);
  const items = slot.node.items as Node[];
  const first = items[0];
  const ls = lineStart(text, first.range![0]);
  const dash = text.indexOf("-", ls) - ls;
  const at = lineEnd(text, contentEnd(text, items[items.length - 1]));
  return checked(before, path, next, splice(text, { start: at, end: at, with: renderBlock([value], dash) }));
}

/** An empty item shaped like `like`: the same keys, blank values (for "add" on a list of objects). */
export function blankLike(like: unknown): unknown {
  if (Array.isArray(like)) return [];
  if (isPlainCollection(like)) return Object.fromEntries(Object.entries(like as object).map(([k, v]) => [k, blankLike(v)]));
  if (typeof like === "boolean") return false;
  if (typeof like === "number") return 0;
  return "";
}

/**
 * Hexo's own `_config.yml` keys (Hexo 7's `default_config`, plus the site keys its docs list);
 * the rest belong to plugins, `index_generator` included (hexo-generator-index).
 */
export const HEXO_CORE_KEYS = new Set(
  "title subtitle description keywords author email language timezone url root permalink permalink_defaults pretty_urls source_dir public_dir tag_dir archive_dir category_dir code_dir i18n_dir skip_render new_post_name default_layout titlecase external_link filename_case render_drafts post_asset_folder relative_link future syntax_highlighter highlight prismjs use_filename_as_post_title default_category category_map tag_map date_format time_format updated_option per_page pagination_dir theme theme_config server deploy include exclude ignore meta_generator".split(" "),
);
