import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { Icon } from "../Icon";

// Product-visual parts for the marketing panels, cards and vignettes (the dashboard kit, scaled for the marketing page).
// No hooks and no "use client": the same parts render on the server (vignettes, cards) and inside client panels.

/** Display numbers in the product visuals: Bricolage 500, tight tracking, never wrapped. */
export const NUM = "font-display font-medium tracking-[-0.03em] [font-stretch:100%] whitespace-nowrap";

export type Tone = "green" | "blue" | "magenta" | "amber" | "violet" | "teal" | "ink";
/** Tinted background and strong text of a tone (icon circles, stage chips, tags, avatars). */
export const TONE: Record<Tone, string> = {
  green: "bg-green-100 text-green-700",
  blue: "bg-blue-100 text-blue-600",
  magenta: "bg-magenta-100 text-magenta-600",
  amber: "bg-amber-100 text-amber-600",
  violet: "bg-violet-100 text-violet-600",
  teal: "bg-teal-100 text-teal-600",
  ink: "bg-surface-2 text-ink-2",
};

/** A round tinted icon. size and glyph are in px (38 and 18 in a dashboard card). */
export function CardIcon({ tone, icon, size = 38, glyph = 18, className }: { tone: Tone; icon: IconSvgElement; size?: number; glyph?: number; className?: string }) {
  return (
    <span className={cn("grid flex-none place-items-center rounded-full", TONE[tone], className)} style={{ width: size, height: size }}>
      <Icon icon={icon} size={glyph} />
    </span>
  );
}

/** A people stage: tinted pill with a dot. */
export function StageChip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-[9px] text-[11.5px] font-semibold whitespace-nowrap before:size-1.5 before:rounded-full before:bg-current before:content-['']",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type Status = "positive" | "measured" | "risk" | "attention" | "unknown";
const DOT: Record<Status, string> = {
  positive: "before:bg-green-500",
  measured: "before:bg-blue-500",
  risk: "before:bg-magenta-500",
  attention: "before:bg-amber-500",
  unknown: "before:bg-transparent before:shadow-[inset_0_0_0_1.5px_var(--color-text-3)]",
};
/** A status badge: white pill, coloured dot. */
export function Badge({ status, size = "md", children, className }: { status: Status; size?: "sm" | "md"; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-white font-semibold whitespace-nowrap text-text shadow-mk-badge before:size-[7px] before:rounded-full before:content-['']",
        size === "sm" ? "h-[22px] px-2 text-[11.5px]" : "h-[26px] px-2.5 text-[12.5px]",
        DOT[status],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Initials in a small green circle (inside person chips). */
/** small: 20 px (meeting guests, names); who: 20 px amber (the assignee). */
export function Av({ children, small, who }: { children: ReactNode; small?: boolean; who?: boolean }) {
  return (
    <span className={cn("grid flex-none place-items-center rounded-full font-bold tracking-[.02em]", who ? "size-5 bg-amber-100 text-[8.5px] text-amber-600" : small ? "size-5 bg-green-100 text-[9px] text-green-700" : "size-[22px] bg-green-100 text-[9.5px] text-green-700")}>
      {children}
    </span>
  );
}

/** A dashboard avatar (34 px, tone tint; small is 32 px). */
export function Avatar({ tone, small, children }: { tone: Tone; small?: boolean; children: ReactNode }) {
  return <span className={cn("grid flex-none place-items-center rounded-full font-semibold", small ? "size-8 text-[11px]" : "size-[34px] text-[12px]", TONE[tone])}>{children}</span>;
}

/** A small dashboard button (not interactive: product visuals are pictures of the app). */
export function UiButton({ variant, size = "md", children }: { variant: "primary" | "ghost" | "light" | "glass"; size?: "md" | "sm" | "action"; children: ReactNode }) {
  const V = {
    primary: "bg-ink text-on-ink shadow-pill",
    ghost: "bg-transparent text-ink",
    light: "bg-ink text-cream shadow-[0_8px_18px_-10px_rgba(24,29,25,.6)]",
    glass: "bg-[var(--pill-bg)] text-[var(--on)] shadow-[0_0_0_1px_var(--pill-edge)_inset]",
  };
  return <span className={cn("inline-flex items-center justify-center gap-1.5 rounded-[12px] leading-none font-semibold whitespace-nowrap", size === "sm" ? "h-8 px-3 text-[12.5px]" : size === "action" ? "h-[34px] px-3.5 text-[13px]" : "h-9 px-3.5 text-[13px]", V[variant])}>{children}</span>;
}

/** A thin rounded track (white with a hairline) and its fill; the caller styles and moves the fill. */
export function Meter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-white shadow-[inset_0_0_0_1px_var(--color-line)]", className)}>{children}</div>;
}
