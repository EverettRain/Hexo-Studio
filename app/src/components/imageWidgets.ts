import { Facet, RangeSetBuilder, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { findImages, imageAt, type FoundImage } from "@/lib/imageMarkup";
import { describeImage, type ImageIndex, type ImageInfo } from "@/lib/images";

export interface ImageDisplay {
  index: ImageIndex;
  /** Images as thumbnails and names; off shows their markup, for the rare edit by hand. */
  cards: boolean;
}

export const setImageDisplay = StateEffect.define<ImageDisplay>();

/** Called with the image pressed and where its card is on screen. */
export const imageOpener = Facet.define<(found: FoundImage, rect: DOMRect) => void, ((found: FoundImage, rect: DOMRect) => void) | null>({
  combine: (all) => all[0] ?? null,
});

/** Placeholders the editor puts in while an upload runs: `![上传中：x…](#id)`. */
const isUploading = (f: FoundImage) => f.url.startsWith("#");

/** A short note of how the image is written, on its card. */
function styleNote(f: FoundImage): string {
  const size = [f.width && `宽 ${f.width}`, f.height && `高 ${f.height}`].filter(Boolean).join(" ");
  const kind = f.style === "image" ? "图片" : f.style === "markdown" ? "Markdown" : "行内";
  return [kind, size, f.style === "image" && f.alt ? "有说明" : ""].filter(Boolean).join(" · ");
}

class ImageWidget extends WidgetType {
  constructor(
    readonly found: FoundImage,
    readonly info: ImageInfo,
  ) {
    super();
  }

  /** Same picture, written the same way: the card stays, wherever the text around it moves. */
  eq(o: ImageWidget) {
    const a = this.found;
    const b = o.found;
    return (
      a.url === b.url && a.style === b.style && a.alt === b.alt && a.width === b.width && a.height === b.height && a.bg === b.bg && a.block === b.block && this.info.name === o.info.name && this.info.thumb === o.info.thumb
    );
  }

  toDOM(view: EditorView) {
    const f = this.found;
    const el = document.createElement("span");
    el.className = `cm-image ${f.block ? "cm-image-block" : "cm-image-inline"}${this.info.id ? "" : " cm-image-external"}`;
    if (isUploading(f)) {
      el.classList.add("cm-image-uploading");
      el.textContent = f.alt || "上传中…";
      return el;
    }
    const img = document.createElement("img");
    img.src = this.info.thumb;
    img.alt = "";
    img.loading = "lazy";
    img.draggable = false;
    img.onerror = () => img.classList.add("cm-image-broken");
    const text = document.createElement("span");
    text.className = "cm-image-text";
    const name = document.createElement("span");
    name.className = "cm-image-name";
    name.textContent = this.info.name;
    text.append(name);
    if (f.block) {
      const note = document.createElement("span");
      note.className = "cm-image-note";
      note.textContent = this.info.id ? styleNote(f) : `${styleNote(f)} · 不在图片库`;
      text.append(note);
      if (f.style === "image" && f.alt) {
        const cap = document.createElement("span");
        cap.className = "cm-image-caption";
        cap.textContent = f.alt;
        text.append(cap);
      }
    }
    el.append(img, text);
    el.title = this.info.id ? `${this.info.name}（点击设置样式）` : `${f.url}（不在图片库；点击设置样式）`;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const open = view.state.facet(imageOpener);
      // Positions move as text is typed before the image: read where it is now.
      const at = imageAt(view.state.doc.toString(), view.posAtDOM(el));
      if (open && at) open(at, el.getBoundingClientRect());
    });
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState, display: ImageDisplay): DecorationSet {
  if (!display.cards) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  for (const f of findImages(state.doc.toString())) {
    b.add(f.from, f.to, Decoration.replace({ widget: new ImageWidget(f, describeImage(display.index, f.url)) }));
  }
  return b.finish();
}

const imageField = StateField.define<{ display: ImageDisplay; decorations: DecorationSet }>({
  create: (state) => {
    const display = { index: new Map(), cards: true };
    return { display, decorations: build(state, display) };
  },
  update(value, tr) {
    let display = value.display;
    for (const e of tr.effects) if (e.is(setImageDisplay)) display = e.value;
    if (display === value.display && !tr.docChanged) return value;
    return { display, decorations: build(tr.state, display) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (v) => v.decorations),
    // The cursor steps over an image as one character; Backspace removes it whole.
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

const theme = EditorView.baseTheme({
  ".cm-image": {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    verticalAlign: "middle",
    borderRadius: "8px",
    cursor: "pointer",
    backgroundColor: "rgb(var(--card))",
    boxShadow: "var(--card-edge)",
    userSelect: "none",
  },
  ".cm-image:hover": { boxShadow: "var(--card-edge), 0 0 0 2px rgb(var(--brand) / 0.35)" },
  ".cm-image img": { objectFit: "cover", backgroundColor: "rgb(var(--pill))", flexShrink: "0" },
  ".cm-image img.cm-image-broken": { visibility: "hidden" },
  ".cm-image-inline": { padding: "1px 8px 1px 2px", margin: "0 2px", lineHeight: "1.4", maxWidth: "260px" },
  ".cm-image-inline img": { width: "22px", height: "22px", borderRadius: "5px" },
  ".cm-image-block": { padding: "6px 14px 6px 6px", margin: "4px 0", maxWidth: "100%" },
  ".cm-image-block img": { width: "112px", height: "72px", borderRadius: "5px" },
  ".cm-image-text": { display: "flex", flexDirection: "column", minWidth: "0", lineHeight: "1.45" },
  ".cm-image-name": { fontSize: "13px", fontWeight: "550", color: "rgb(var(--fg))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ".cm-image-inline .cm-image-name": { fontWeight: "450", fontSize: "12.5px" },
  ".cm-image-note": { fontSize: "11.5px", color: "rgb(var(--muted))", whiteSpace: "nowrap" },
  ".cm-image-caption": { fontSize: "12px", color: "rgb(var(--fg-2))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "460px" },
  ".cm-image-external .cm-image-name": { color: "rgb(var(--fg-2))" },
  ".cm-image-uploading": { padding: "4px 12px", fontSize: "12.5px", color: "rgb(var(--muted))", cursor: "default" },
});

export const imageWidgets = [imageField, theme];
