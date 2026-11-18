import { Document, isMap, isScalar, isSeq, parseDocument, type Node, type Pair } from "yaml";

/** A value the form can set: text, a switch, or a list of names. `null` / "" / [] empty the key. */
export type FieldValue = string | boolean | string[] | null;
export type Edits = Record<string, FieldValue>;

export interface Parsed {
  /** The front-matter as plain values; null when it cannot be read. */
  values: Record<string, unknown> | null;
  error: string | null;
}

export function readFrontMatter(yaml: string): Parsed {
  const doc = parseDocument(yaml);
  if (doc.errors.length) return { values: null, error: doc.errors[0].message };
  if (doc.contents !== null && !isMap(doc.contents)) return { values: null, error: "front-matter 不是键值表" };
  return { values: (doc.toJS() as Record<string, unknown> | null) ?? {}, error: null };
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function equalValues(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equalValues(x, b[i]));
  if (a instanceof Date || b instanceof Date) return String(a) === String(b);
  return a === b;
}

/** Whether a form value differs from what the front-matter holds. */
export function changed(original: unknown, next: FieldValue): boolean {
  return !equalValues(original, next);
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

/** `key: value` for one changed key, keeping the old value's flow / quote / indent style. */
function renderPair(key: string, value: FieldValue, old: Node | null | undefined, source: string): string {
  if (isEmptyValue(value)) return `${new Document(key).toString().trimEnd()}:`;
  const doc = new Document({});
  const node = doc.createNode(value);
  if (isSeq(old) && isSeq(node)) node.flow = !!old.flow;
  // Quotes the author chose are kept; quotes the old value only had because it needed them (a
  // trailing space while typing, say) are not carried over to a value that does not.
  if (isScalar(old) && isScalar(node) && typeof value === "string" && (old.type === "QUOTE_SINGLE" || old.type === "QUOTE_DOUBLE")) {
    const neededQuotes = /^["']/.test(new Document(old.value).toString());
    if (!neededQuotes) node.type = old.type;
  }
  doc.set(key, node);
  const indentSeq = !(isSeq(old) && !old.flow && old.range && old.range[0] === lineStart(source, old.range[0]));
  return doc.toString({ lineWidth: 0, indentSeq }).replace(/\n+$/, "");
}

/** Where the text of a key's value ends: after its last character, never past its line. */
function pairEnd(pair: Pair, source: string): number {
  const key = pair.key as Node;
  const value = pair.value as Node | null;
  let end = value?.range ? value.range[1] : -1;
  if (end < 0 || end <= key.range![1]) {
    // An empty value: end after the colon (and any spaces before it).
    end = source.indexOf(":", key.range![1]) + 1;
  }
  while (end > key.range![1] && (source[end - 1] === "\n" || source[end - 1] === "\r")) end--;
  return end;
}

/**
 * Applies the changed keys to a front-matter block. Only the text of those keys is rewritten;
 * every other line (unknown keys, their order, comments, trailing spaces, how dates are written)
 * stays byte for byte. Keys not yet there are added at the end; emptying a key leaves `key:`.
 * Throws when the block cannot be read, or the result would not mean what the edits ask.
 */
export function applyEdits(yaml: string, edits: Edits): string {
  const keys = Object.keys(edits);
  if (keys.length === 0) return yaml;
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new Error(`front-matter 有语法错误：${doc.errors[0].message}`);
  const map = doc.contents;
  if (map !== null && !isMap(map)) throw new Error("front-matter 不是键值表");

  const splices: { start: number; end: number; text: string }[] = [];
  const added: string[] = [];
  for (const key of keys) {
    const pair = map?.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
    const value = edits[key];
    if (pair) {
      const start = (pair.key as Node).range![0];
      splices.push({ start, end: pairEnd(pair, yaml), text: renderPair(key, value, pair.value as Node | null, yaml) });
    } else if (!isEmptyValue(value)) {
      added.push(renderPair(key, value, null, yaml));
    }
  }

  let out = yaml;
  for (const s of splices.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  if (added.length) {
    if (out.length && !out.endsWith("\n")) out += "\n";
    out += `${added.join("\n")}\n`;
  }

  const expected: Record<string, unknown> = { ...((doc.toJS() as Record<string, unknown> | null) ?? {}) };
  for (const key of keys) {
    if (key in expected || !isEmptyValue(edits[key])) expected[key] = isEmptyValue(edits[key]) ? null : edits[key];
  }
  const result = parseDocument(out);
  const got = (result.toJS() as Record<string, unknown> | null) ?? {};
  const same =
    !result.errors.length &&
    Object.keys(expected).length === Object.keys(got).length &&
    Object.keys(expected).every((k) => equalValues(expected[k], got[k]) || JSON.stringify(expected[k]) === JSON.stringify(got[k]));
  if (!same) throw new Error("无法在保留原格式的前提下写入 front-matter，请切换到源码模式修改。");
  return out;
}
