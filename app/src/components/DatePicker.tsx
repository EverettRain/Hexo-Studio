import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { formatWritten, monthGrid, nowIn, parseWritten, type DateParts } from "@/lib/date";
import { useDismiss } from "@/lib/useDismiss";
import { cn } from "@/lib/utils";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

/** Hours, minutes or seconds: typed, or stepped with the arrow keys and the wheel. */
function TimeField({ value, max, onChange, label }: { value: number; max: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const step = (d: number) => onChange((value + d + max + 1) % (max + 1));
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={text ?? String(value).padStart(2, "0")}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(-2);
        setText(digits);
        if (digits !== "" && Number(digits) <= max) onChange(Number(digits));
      }}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          setText(null);
          step(e.key === "ArrowUp" ? 1 : -1);
        }
      }}
      onWheel={(e) => {
        setText(null);
        step(e.deltaY < 0 ? 1 : -1);
      }}
      className="h-7 w-9 rounded-md bg-pill text-center font-mono text-[13px] tabular-nums outline-none focus:bg-card focus:shadow-[inset_0_0_0_1px_rgb(var(--brand))]"
    />
  );
}

interface DatePickerProps {
  /** As written in the front-matter (`2025-11-24 01:14:20`); empty when unset. */
  value: string;
  onChange: (written: string) => void;
  /** The blog's zone: "now" and "today" are there, not on this Mac. */
  timezone: string | null;
}

/**
 * The post's date: a calendar and a time, written back the way the blog writes dates. A date
 * written another way (with a zone, say) is shown as it is and only replaced when one is picked.
 */
export function DatePicker({ value, onChange, timezone }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const parts = parseWritten(value);
  const today = parseWritten(nowIn(timezone))!;
  const [shown, setShown] = useState({ year: today.year, month: today.month });
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);

  const toggle = () => {
    if (!open) setShown(parts ? { year: parts.year, month: parts.month } : { year: today.year, month: today.month });
    setOpen((o) => !o);
  };
  const base: DateParts = parts ?? { ...today };
  const set = (p: Partial<DateParts>) => onChange(formatWritten({ ...base, ...p }));
  const move = (d: number) => setShown(({ year, month }) => ({ year: year + Math.floor((month - 1 + d) / 12), month: ((month - 1 + d + 12) % 12) + 1 }));

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={toggle}
        className={cn("flex h-7 items-center rounded-md px-1.5 text-[13px] tabular-nums hover:bg-pill active:!scale-100", open && "bg-pill", value ? "text-fg" : "text-faint")}
      >
        {value || "未设置（按文件创建时间）"}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[264px] animate-pop-in rounded-xl bg-card p-3 shadow-pop">
          <div className="mb-2 flex items-center">
            <button type="button" aria-label="上个月" onClick={() => move(-1)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-pill hover:text-fg">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex-1 text-center text-[13px] font-medium tabular-nums">
              {shown.year} 年 {shown.month} 月
            </div>
            <button type="button" aria-label="下个月" onClick={() => move(1)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-pill hover:text-fg">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WEEK.map((w) => (
              <div key={w} className="pb-1 text-[11px] text-muted">
                {w}
              </div>
            ))}
            {monthGrid(shown.year, shown.month).map((d) => {
              const picked = parts?.year === d.year && parts.month === d.month && parts.day === d.day;
              const isToday = today.year === d.year && today.month === d.month && today.day === d.day;
              return (
                <button
                  key={`${d.month}-${d.day}`}
                  type="button"
                  onClick={() => {
                    set({ year: d.year, month: d.month, day: d.day });
                    if (!d.inMonth) setShown({ year: d.year, month: d.month });
                  }}
                  className={cn(
                    "h-8 rounded-md text-[12.5px] tabular-nums active:!scale-100",
                    picked ? "bg-fg font-medium text-card" : "hover:bg-pill",
                    !picked && (d.inMonth ? "text-fg" : "text-faint"),
                    !picked && isToday && "font-semibold text-brand",
                  )}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-1 border-t-[0.5px] border-line-2 pt-3">
            <TimeField label="时" value={base.hour} max={23} onChange={(hour) => set({ hour })} />
            <span className="text-muted">:</span>
            <TimeField label="分" value={base.minute} max={59} onChange={(minute) => set({ minute })} />
            <span className="text-muted">:</span>
            <TimeField label="秒" value={base.second} max={59} onChange={(second) => set({ second })} />
            <span className="flex-1" />
            <button type="button" title={`设为现在（${timezone ?? "本机时区"}）`} onClick={() => onChange(nowIn(timezone))} className="h-7 rounded-md px-2 text-[12px] text-fg-2 hover:bg-pill hover:text-fg">
              现在
            </button>
            {value && (
              <button type="button" onClick={() => (onChange(""), setOpen(false))} className="h-7 rounded-md px-2 text-[12px] text-muted hover:bg-pill hover:text-danger">
                清除
              </button>
            )}
          </div>
          {value && !parts && <p className="mt-2 text-[11.5px] leading-[17px] text-muted">原值“{value}”是另一种写法，选日期后会改写成“年-月-日 时:分:秒”。</p>}
        </div>
      )}
    </div>
  );
}
