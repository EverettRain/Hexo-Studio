import { cn } from "@/lib/utils";

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  className?: string;
}

/** A few mutually exclusive choices side by side, the selected one raised. */
export function Segmented<T extends string>({ value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div className={cn("inline-flex h-7 shrink-0 items-center rounded-control bg-pill p-0.5 text-[12px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
          className={cn("h-6 rounded-sm px-2.5 active:!scale-100", value === o.value ? "bg-raised-strong font-medium text-fg shadow-edge" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
