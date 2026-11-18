import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

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
  { tag: [t.processingInstruction, t.meta, t.list], color: "rgb(var(--muted))" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "14px", backgroundColor: "transparent", color: "rgb(var(--fg))" },
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

/** What the editor page does to the text besides typing: image uploads in progress. */
export interface EditorHandle {
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
  handle?: Ref<EditorHandle>;
}

/**
 * CodeMirror 6 for the post body. The text is the editor's own after mounting; a `value` that
 * differs from it (a reload from disk) replaces it.
 */
export function MarkdownEditor({ value, onChange, onSave, onPasteImages, handle }: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave, onPasteImages });
  handlers.current = { onChange, onSave, onPasteImages };

  useImperativeHandle(
    handle,
    () => ({
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
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          markdown(),
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
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Created once; later values arrive through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="selectable h-full min-h-0" />;
}
