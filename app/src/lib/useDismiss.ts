import { useEffect, type RefObject } from "react";

/**
 * Closes a popup on a press outside `box` or on Escape. Escape is taken here only when no dialog
 * is open, so the image picker over a popup closes first.
 */
export function useDismiss(box: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    // A popup opened from a mousedown is mounted (React flushes it in a microtask) while that same
    // press is still bubbling up to the window: it must not count as a press outside.
    const since = performance.now();
    const away = (e: MouseEvent) => {
      if (e.timeStamp >= since && !box.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[data-dialog-layer]")) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [box, open, onClose]);
}
