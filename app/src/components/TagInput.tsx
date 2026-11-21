import { ChevronRight, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  /** Names used elsewhere in the blog, offered while typing. */
  suggestions?: string[];
  placeholder?: string;
  /** Hexo's categories list is a path (`[A, B]` is A › B), so the chips are joined as one. */
  hierarchy?: boolean;
}

const SPLIT = /[,，、]/;

/**
 * Names as chips. Enter, Tab, a comma or leaving the field turns what was typed into a chip, never
 * while an input method is still composing (Enter there only confirms the Chinese text);
 * Backspace on an empty field removes the last chip. Suggestions are its own list, not the
 * browser's, so picking one always makes a chip.
 */
export function TagInput({ value, onChange, suggestions = [], placeholder, hierarchy }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const names = raw
      .split(SPLIT)
      .map((n) => n.trim())
      .filter((n, i, all) => n && !value.includes(n) && all.indexOf(n) === i);
    if (names.length) onChange([...value, ...names]);
    setDraft("");
    setActive(-1);
  };

  const shown = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return suggestions.filter((s) => !value.includes(s) && (!q || s.toLowerCase().includes(q))).slice(0, 8);
  }, [suggestions, value, draft]);
  const listOpen = focused && shown.length > 0 && (draft.trim() !== "" || active >= 0);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // WebKit sends the Enter that confirms a composition with keyCode 229 and, in Safari, after compositionend.
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || (e.key === "Tab" && draft.trim())) {
      e.preventDefault();
      add(listOpen && active >= 0 ? shown[active] : draft);
    } else if (e.key === "ArrowDown" && shown.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % shown.length);
    } else if (e.key === "ArrowUp" && shown.length) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? shown.length - 1 : a - 1));
    } else if (e.key === "Escape" && listOpen) {
      e.stopPropagation();
      setActive(-1);
      setDraft("");
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="relative">
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            input.current?.focus();
          }
        }}
        className={cn("flex min-h-7 cursor-text flex-wrap items-center gap-1 rounded-md px-1.5 py-[3px] hover:bg-pill", focused && "bg-pill")}
      >
        {value.map((t, i) => (
          <span key={t} className="flex items-center gap-1">
            {hierarchy && i > 0 && <ChevronRight className="h-3 w-3 text-faint" />}
            {/* Flat chips one shade under the field's own hover fill, so they show on both. */}
            <span className="group flex h-[22px] items-center rounded-[5px] bg-pill-hover pl-2 pr-0.5 text-[12.5px] text-fg">
              {t}
              <button
                type="button"
                aria-label={`移除 ${t}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange(value.filter((x) => x !== t))}
                className="ml-0.5 flex h-[18px] w-[18px] items-center justify-center rounded text-muted hover:bg-card hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </span>
        ))}
        <input
          ref={input}
          value={draft}
          placeholder={value.length ? (focused ? "" : undefined) : placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (draft.trim()) add(draft);
          }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false;
            const v = e.currentTarget.value;
            if (SPLIT.test(v)) add(v);
          }}
          onChange={(e) => {
            const v = e.target.value;
            setActive(-1);
            if (!composing.current && SPLIT.test(v)) add(v);
            else setDraft(v);
          }}
          onKeyDown={onKeyDown}
          // Takes room only while typing, so a full row of chips does not wrap onto an empty line.
          className={cn("h-[22px] bg-transparent px-0.5 text-[13px] outline-none placeholder:text-faint", focused || !value.length ? "min-w-[72px] flex-1" : "w-3 min-w-0")}
        />
      </div>
      {listOpen && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[180px] animate-pop-in rounded-lg bg-card p-1 shadow-pop">
          {shown.map((s, i) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => add(s)}
              className={cn("flex h-7 w-full items-center rounded-md px-2 text-left text-[12.5px] active:!scale-100", i === active && "bg-pill")}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
