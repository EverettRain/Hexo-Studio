import { cn } from "@/lib/utils";

/** An on / off switch, for settings that take effect as soon as they flip. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full active:!scale-100 disabled:opacity-40",
        checked ? "bg-ok" : "bg-pill-hover",
      )}
    >
      <span className={cn("h-[14px] w-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform duration-150", checked ? "translate-x-[14px]" : "translate-x-[2px]")} />
    </button>
  );
}
