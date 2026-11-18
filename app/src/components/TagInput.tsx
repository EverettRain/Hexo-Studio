import { X } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  /** Names used elsewhere in the blog, offered while typing. */
  suggestions?: string[];
  placeholder?: string;
}

/** A list of names as chips; Enter or a comma adds what was typed, Backspace on empty removes the last. */
export function TagInput({ value, onChange, suggestions = [], placeholder }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const add = (raw: string) => {
    const name = raw.trim();
    if (name && !value.includes(name)) onChange([...value, name]);
    setDraft("");
  };
  return (
    <div className="field flex h-auto min-h-8 flex-wrap items-center gap-1 py-1 focus-within:bg-card focus-within:shadow-[inset_0_0_0_1px_rgb(var(--brand))]">
      {value.map((t) => (
        <span key={t} className="flex h-[22px] items-center gap-0.5 rounded-[5px] bg-card pl-2 pr-0.5 text-[12px] shadow-edge dark:bg-white/[.08]">
          {t}
          <button type="button" aria-label={`移除 ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="flex h-[18px] w-[18px] items-center justify-center rounded text-muted hover:text-fg">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={draft}
        placeholder={value.length ? undefined : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,，]$/.test(v)) add(v.slice(0, -1));
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft && add(draft)}
        className={cn("h-[22px] min-w-[80px] flex-1 bg-transparent text-[13px] outline-none")}
      />
      <datalist id={listId}>
        {suggestions.filter((s) => !value.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
