const WRITTEN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/;

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

/** A written date as a `datetime-local` value; null when it is written another way. */
export function toInputValue(written: string): string | null {
  const m = WRITTEN.exec(written.trim());
  return m ? `${m[1]}T${m[2]}${m[3] ?? ":00"}` : null;
}

/** A `datetime-local` value as the blog writes dates (the input drops `:00` seconds). */
export function fromInputValue(value: string): string {
  const [date, time = "00:00"] = value.split("T");
  return `${date} ${time.length === 5 ? `${time}:00` : time}`;
}
