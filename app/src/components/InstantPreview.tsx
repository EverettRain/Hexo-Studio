import { useDeferredValue, useMemo } from "react";
import { renderInstant } from "@/lib/instantPreview";

interface InstantPreviewProps {
  title: string;
  body: string;
  /** The preview server's address, for images under the site (`/img/a.jpg`); null when it is not running. */
  origin: string | null;
}

/** The Markdown as it is typed, before it is saved; tag plugins are only labelled (see lib/instantPreview). */
export function InstantPreview({ title, body, origin }: InstantPreviewProps) {
  // Rendering a long post on every key would make typing lag; React renders this when it has time.
  const text = useDeferredValue(body);
  const html = useMemo(() => renderInstant(text, (u) => (origin && u.startsWith("/") && !u.startsWith("//") ? origin + u : u)), [text, origin]);
  return (
    <div
      className="selectable h-full overflow-y-auto bg-card px-7 py-6"
      // Links would replace the app's page: they only show where they go.
      onClick={(e) => (e.target as HTMLElement).closest("a") && e.preventDefault()}
    >
      <article className="md-preview mx-auto max-w-[760px]">
        {title && <h1>{title}</h1>}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </div>
  );
}
