/** The current time in `timeZone`, as the blog writes dates: `2025-11-24 01:14:20`. */
export function nowIn(timeZone: string | null, at: Date = new Date()): string {
  // Swedish formats dates as ISO, with a space before the time.
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timeZone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

export interface DateParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** A date written as the blog writes them (`2025-11-24 01:14:20`, seconds optional); null otherwise. */
export function parseWritten(written: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(written.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second = 0] = m.slice(1).map((v) => Number(v ?? 0));
  return { year, month, day, hour, minute, second };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Parts written as the blog writes dates; a day past the month's end becomes its last day. */
export function formatWritten(p: DateParts): string {
  const day = Math.min(p.day, daysIn(p.year, p.month));
  return `${p.year}-${pad(p.month)}-${pad(day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
  /** In the month shown, not the days before or after it that fill the weeks. */
  inMonth: boolean;
}

/** Six Monday-first weeks covering the month, as a calendar shows them. */
export function monthGrid(year: number, month: number): CalendarDay[] {
  // getUTCDay: 0 is Sunday; Monday-first puts Sunday last.
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), inMonth: d.getUTCMonth() + 1 === month };
  });
}
