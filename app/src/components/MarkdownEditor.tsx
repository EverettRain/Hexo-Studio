import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { imageOpener, imageWidgets, setImageDisplay, type ImageDisplay } from "@/components/imageWidgets";
import type { FoundImage } from "@/lib/imageMarkup";
import { formatAt, link, setHeading, toggleInline, toggleList, toggleQuote, type FormatState, type MdCommand } from "@/lib/markdownCommands";

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "650", color: "rgb(var(--fg))" },
  { tag: t.heading1, fontSize: "1.18em" },
  { tag: t.heading2, fontSize: "1.1em" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "rgb(var(--accent))" },
  { tag: t.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "rgb(var(--fg-2))" },
  { tag: [t.quote, t.contentSeparator], color: "rgb(var(--muted))" },
  // Marks (`#`, `-`, `>`, `**`) are processingInstruction; `t.list` would grey out whole list items.
  { tag: [t.processingInstruction, t.meta], color: "rgb(var(--muted))" },
]);

const theme = EditorView.theme({
  // No height of its own: the page scrolls the article header and the body together.
  "&": { fontSize: "14px", backgroundColor: "transparent", color: "rgb(var(--fg))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.75", padding: "8px 0 40vh" },
  ".cm-content": { maxWidth: "820px", padding: "0 24px", caretColor: "rgb(var(--fg))" },
  ".cm-cursor": { borderLeftColor: "rgb(var(--fg))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgb(var(--brand) / 0.22) !important" },
  ".cm-selectionMatch": { backgroundColor: "rgb(var(--brand) / 0.12)" },
  ".cm-panels": { backgroundColor: "rgb(var(--card))", color: "rgb(var(--fg))", borderColor: "rgb(var(--line))" },
  ".cm-panels input, .cm-panels button": { fontSize: "12px" },
  ".cm-placeholder": { color: "rgb(var(--faint))" },
});

/** Only the part between the common start and end changes, so the cursor and the scroll position
 *  stay where they were when the text is replaced from outside (a reload). */
export function changedRange(before: string, after: string): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/** A toolbar edit as a key binding. */
const bind = (key: string, cmd: MdCommand) => ({
  key,
  preventDefault: true,
  run: (v: EditorView) => {
    const spec = cmd(v.state);
    if (spec) v.dispatch({ ...spec, scrollIntoView: true });
    return true;
  },
});

/** Typora's and Google Docs' shortcuts, which writers already know. */
const FORMAT_KEYS = [
  bind("Mod-b", toggleInline("strong")),
  bind("Mod-i", toggleInline("emphasis")),
  bind("Mod-Shift-x", toggleInline("strike")),
  bind("Mod-e", toggleInline("code")),
  bind("Mod-k", link),
  bind("Mod-0", setHeading(0)),
  ...[1, 2, 3, 4].map((n) => bind(`Mod-${n}`, setHeading(n))),
  bind("Mod-Shift-7", toggleList("ordered")),
  bind("Mod-Shift-8", toggleList("bullet")),
  bind("Mod-Shift-9", toggleList("task")),
  bind("Mod-Shift-.", toggleQuote),
];

/** What the editor page does to the text besides typing: the toolbar, image uploads in progress. */
export interface EditorHandle {
  /** Applies a toolbar edit and puts the focus back in the text. */
  run: (cmd: MdCommand) => void;
  openSearch: () => void;
  /** Puts the cursor at the start of the body. */
  focusStart: () => void;
  /** Replaces a range (an image's markup) without moving the cursor or the focus. */
  replaceRange: (from: number, to: number, text: string) => void;
  /** Inserts text at the cursor (on a line of its own) and focuses the editor. */
  insert: (text: string) => void;
  /** Replaces the first occurrence of `from`; false when it is gone (deleted meanwhile). */
  replace: (from: string, to: string) => boolean;
}

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Image files pasted into the editor. */
  onPasteImages?: (files: File[]) => void;
  /** The formatting at the cursor, whenever it may have changed. */
  onFormat?: (format: FormatState) => void;
  /** How images are shown, and the library that names them. */
  images: ImageDisplay;
  onImageOpen?: (found: FoundImage, rect: DOMRect) => void;
  handle?: Ref<EditorHandle>;
}

/**
 * CodeMirror 6 for the post body. The text is the editor's own after mounting; a `value` that
 * differs from it (a reload from disk) replaces it.
 */
export function MarkdownEditor({ value, onChange, onSave, onPasteImages, onFormat, images, onImageOpen, handle }: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave, onPasteImages, onFormat, onImageOpen });
  handlers.current = { onChange, onSave, onPasteImages, onFormat, onImageOpen };

  useImperativeHandle(
    handle,
    () => ({
      run: (cmd) => {
        const v = view.current;
        if (!v) return;
        const spec = cmd(v.state);
        if (spec) v.dispatch({ ...spec, scrollIntoView: true });
        v.focus();
      },
      openSearch: () => {
        if (view.current) openSearchPanel(view.current);
      },
      focusStart: () => {
        const v = view.current;
        if (!v) return;
        v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
        v.focus();
      },
      replaceRange: (from, to, text) => {
        view.current?.dispatch({ changes: { from, to, insert: text } });
      },
      insert: (text) => {
        const v = view.current;
        if (!v) return;
        const { from, to } = v.state.selection.main;
        const line = v.state.doc.lineAt(from);
        const before = from === line.from ? "" : "\n";
        const after = to === v.state.doc.lineAt(to).to ? "" : "\n";
        const insert = `${before}${text}${after}`;
        v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true });
        v.focus();
      },
      replace: (from, to) => {
        const v = view.current;
        if (!v) return false;
        const at = v.state.doc.toString().indexOf(from);
        if (at < 0) return false;
        v.dispatch({ changes: { from: at, to: at + from.length, insert: to } });
        return true;
      },
    }),
    [],
  );

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (handlers.current.onSave(), true) },
            ...FORMAT_KEYS,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          markdown({ base: markdownLanguage }),
          imageWidgets,
          imageOpener.of((found, rect) => handlers.current.onImageOpen?.(found, rect)),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholder("正文…"),
          theme,
          EditorView.domEventHandlers({
            paste: (e) => {
              const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
              if (!files.length || !handlers.current.onPasteImages) return false;
              e.preventDefault();
              handlers.current.onPasteImages(files);
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) handlers.current.onFormat?.(formatAt(u.state));
          }),
        ],
      }),
    });
    view.current = v;
    handlers.current.onFormat?.(formatAt(v.state));
    v.dispatch({ effects: setImageDisplay.of(images) });
    return () => v.destroy();
    // Created once; later values arrive through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: setImageDisplay.of(images) });
  }, [images]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: changedRange(v.state.doc.toString(), value) });
  }, [value]);

  return <div ref={host} className="selectable" />;
}
