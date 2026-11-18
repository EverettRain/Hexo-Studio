import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type ChangeSpec, type EditorState, type Line, type SelectionRange, type TransactionSpec } from "@codemirror/state";

/** Toolbar and shortcut edits: each takes the state and returns the edit, or null when there is nothing to do. */
export type MdCommand = (state: EditorState) => TransactionSpec | null;

export type InlineMark = "strong" | "emphasis" | "strike" | "code";
export type ListKind = "bullet" | "ordered" | "task";

const MARKER: Record<InlineMark, string> = { strong: "**", emphasis: "*", strike: "~~", code: "`" };
const NODE: Record<InlineMark, string> = { strong: "StrongEmphasis", emphasis: "Emphasis", strike: "Strikethrough", code: "InlineCode" };

const HEADING = /^(#{1,6})[ \t]+/;
const LIST = /^(\s*)(?:[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/;
const TASK = /^\s*[-*+][ \t]+\[[ xX]\][ \t]/;
const BULLET = /^\s*[-*+][ \t]/;
const ORDERED = /^\s*\d+[.)][ \t]/;
const QUOTE = /^(\s*)>[ \t]?/;

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

function tree(state: EditorState, upto: number) {
  // A large post may not be parsed this far yet; the parse is cheap enough to finish here.
  return ensureSyntaxTree(state, upto, 200) ?? syntaxTree(state);
}

/** The `name` node holding the range: strictly around an empty cursor, so a cursor just after `**b**` is not in it. */
function enclosing(state: EditorState, range: SelectionRange, name: string): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree(state, range.to).resolveInner(range.from, range.empty ? -1 : 1); n; n = n.parent) {
    if (n.name !== name) continue;
    if (range.empty ? n.from < range.from && range.from < n.to : n.from <= range.from && range.to <= n.to) return n;
  }
  return null;
}

/** Bold, italic, strikethrough or inline code: removed when the selection is already in one, else added around it. */
export function toggleInline(mark: InlineMark): MdCommand {
  return (state) =>
    state.changeByRange((range) => {
      const node = enclosing(state, range, NODE[mark]);
      const open = node?.firstChild;
      const close = node?.lastChild;
      if (node && open && close && open !== close) {
        const shift = (pos: number) => (pos <= open.from ? pos : pos <= open.to ? open.from : pos <= close.from ? pos - (open.to - open.from) : close.from - (open.to - open.from));
        return {
          changes: [
            { from: open.from, to: open.to },
            { from: close.from, to: close.to },
          ],
          range: EditorSelection.range(shift(range.anchor), shift(range.head)),
        };
      }
      const m = MARKER[mark];
      // `**word **` is not bold: a closing mark must not follow whitespace, nor an opening one precede it.
      const text = state.sliceDoc(range.from, range.to);
      const from = range.from + (text.length - text.trimStart().length);
      const to = Math.max(from, range.to - (text.length - text.trimEnd().length));
      return {
        changes: [
          { from, insert: m },
          { from: to, insert: m },
        ],
        range: EditorSelection.range(from + m.length, to + m.length),
      };
    });
}

/** The lines the selection touches; a selection ending at the start of a line leaves that line out. */
function linesOf(state: EditorState): Line[] {
  const seen = new Map<number, Line>();
  for (const r of state.selection.ranges) {
    const last = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(last).number; n++) seen.set(n, state.doc.line(n));
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

/** Applies per-line changes: a cursor ends up after a prefix added where it stood, a selection takes the prefixes in. */
function editLines(state: EditorState, changes: ChangeSpec[]): TransactionSpec | null {
  if (!changes.length) return null;
  const set = state.changes(changes);
  const ranges = state.selection.ranges.map((r) => {
    if (r.empty) return EditorSelection.cursor(set.mapPos(r.head, 1));
    const forward = r.anchor < r.head;
    return EditorSelection.range(set.mapPos(r.anchor, forward ? -1 : 1), set.mapPos(r.head, forward ? 1 : -1));
  });
  return { changes: set, selection: EditorSelection.create(ranges, state.selection.mainIndex) };
}

/** The heading level of a line, 0 for none. */
export function headingLevel(text: string): number {
  return HEADING.exec(text)?.[1].length ?? 0;
}

/** Makes the lines headings of `level` (0: plain paragraphs); lines already at that level go back to paragraphs. */
export function setHeading(level: number): MdCommand {
  return (state) => {
    const lines = linesOf(state);
    const target = level > 0 && lines.every((l) => headingLevel(l.text) === level) ? 0 : level;
    const prefix = target > 0 ? `${"#".repeat(target)} ` : "";
    return editLines(
      state,
      lines.map((l) => ({ from: l.from, to: l.from + (HEADING.exec(l.text)?.[0].length ?? 0), insert: prefix })),
    );
  };
}

function listKind(text: string): ListKind | null {
  return TASK.test(text) ? "task" : BULLET.test(text) ? "bullet" : ORDERED.test(text) ? "ordered" : null;
}

/** Bullet, numbered or task list: removed when every line already is one, else each line becomes an item (replacing another kind). */
export function toggleList(kind: ListKind): MdCommand {
  return (state) => {
    const all = linesOf(state);
    const lines = all.length > 1 ? all.filter((l) => l.text.trim() !== "") : all;
    const remove = lines.every((l) => listKind(l.text) === kind);
    return editLines(
      state,
      lines.map((l, i) => {
        const found = LIST.exec(l.text);
        const indent = found?.[1] ?? "";
        const end = l.from + (found?.[0].length ?? 0);
        if (remove) return { from: l.from + indent.length, to: end, insert: "" };
        const marker = kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${i + 1}. `;
        return { from: l.from + indent.length, to: end, insert: marker };
      }),
    );
  };
}

/** Quotes the lines, or unquotes them when they all are. */
export const toggleQuote: MdCommand = (state) => {
  const lines = linesOf(state);
  const remove = lines.every((l) => QUOTE.test(l.text));
  return editLines(
    state,
    lines.map((l) => {
      const found = QUOTE.exec(l.text);
      if (remove && found) return { from: l.from + found[1].length, to: l.from + found[0].length, insert: "" };
      return { from: l.from, insert: l.text.trim() === "" ? ">" : "> " };
    }),
  );
};

/** Puts `text` in a paragraph of its own at the selection (blank lines around it), selecting `select` (offsets into `text`) or placing the cursor after it. */
export function insertBlock(text: string, select?: [number, number]): MdCommand {
  return (state) =>
    state.changeByRange((range) => {
      const doc = state.doc;
      const startLine = doc.lineAt(range.from);
      const endLine = doc.lineAt(range.to);
      const blank = (n: number) => n < 1 || n > doc.lines || doc.line(n).text.trim() === "";
      const before = range.from > startLine.from ? "\n\n" : blank(startLine.number - 1) ? "" : "\n";
      const after = range.to < endLine.to ? "\n\n" : blank(endLine.number + 1) ? "" : "\n";
      const at = range.from + before.length;
      const sel = select ? EditorSelection.range(at + select[0], at + select[1]) : EditorSelection.cursor(at + text.length);
      return { changes: { from: range.from, to: range.to, insert: `${before}${text}${after}` }, range: sel };
    });
}

/** A fenced code block around the selected lines, or an empty one with the cursor inside. */
export const codeBlock: MdCommand = (state) => {
  const r = state.selection.main;
  if (r.empty) return insertBlock("```\n\n```", [4, 4])(state);
  const from = state.doc.lineAt(r.from).from;
  const to = state.doc.lineAt(r.to).to;
  const inner = state.doc.sliceString(from, to);
  return { changes: { from, to, insert: `\`\`\`\n${inner}\n\`\`\`` }, selection: EditorSelection.cursor(from + 3) };
};

const TABLE = "| 列 1 | 列 2 |\n| --- | --- |\n|  |  |";
/** A two-column table with the first header selected. */
export const table: MdCommand = insertBlock(TABLE, [2, 5]);

/** A thematic break; on its own paragraph, so the line above does not become a heading. */
export const rule: MdCommand = insertBlock("---");

/** `[text](url)`: a selected address goes in the parentheses, other selected text in the brackets. */
export const link: MdCommand = (state) =>
  state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^https?:\/\/\S+$/.test(text)) {
      return { changes: { from: range.from, to: range.to, insert: `[](${text})` }, range: EditorSelection.cursor(range.from + 1) };
    }
    const insert = `[${text}]()`;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length - 1) };
  });

/** A block tag (`{% name … %}…{% endname %}`) around the selected lines, or with `placeholder` selected as its content. */
export function hexoBlock(open: string, close: string, placeholder: string): MdCommand {
  return (state) => {
    const r = state.selection.main;
    if (r.empty) return insertBlock(`${open}\n${placeholder}\n${close}`, [open.length + 1, open.length + 1 + placeholder.length])(state);
    const from = state.doc.lineAt(r.from).from;
    const to = state.doc.lineAt(r.to).to;
    const inner = state.doc.sliceString(from, to);
    return insertBlock(`${open}\n${inner}\n${close}`)(state.update({ selection: EditorSelection.range(from, to) }).state);
  };
}

/** What the toolbar shows as on at the cursor. */
export interface FormatState {
  heading: number;
  marks: InlineMark[];
  list: ListKind | null;
  quote: boolean;
  line: number;
  column: number;
}

export function formatAt(state: EditorState): FormatState {
  const r = state.selection.main;
  const line = state.doc.lineAt(r.head);
  return {
    heading: headingLevel(line.text),
    marks: (Object.keys(NODE) as InlineMark[]).filter((m) => enclosing(state, r, NODE[m]) !== null),
    list: listKind(line.text),
    quote: QUOTE.test(line.text),
    line: line.number,
    column: r.head - line.from + 1,
  };
}

/** Characters of CJK text plus words of other scripts, as Chinese editors count; markup and addresses are left out. */
export function wordCount(markdown: string): number {
  const text = markdown
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\{%[^%]*%\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const words = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)?.length ?? 0;
  return cjk + words;
}
