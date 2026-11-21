import type { UserView } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The user's picture, or the first letter of their name on a tinted disc. */
export function Avatar({ user, className }: { user: UserView | null; className?: string }) {
  const name = user?.name ?? "";
  if (user?.avatar) return <img src={user.avatar} alt="" draggable={false} className={cn("shrink-0 rounded-full object-cover", className)} />;
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full bg-brand-soft font-semibold text-brand", className)}>
      {[...name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}
