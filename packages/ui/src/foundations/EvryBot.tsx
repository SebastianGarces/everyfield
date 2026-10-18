import type { CSSProperties } from "react";
import { cn } from "./cn";

export type EvryBotSize = "xs" | "sm" | "md" | "lg" | "xl";
export type EvryMood = "idle" | "thinking" | "talking" | "happy";

/**
 * Evry's character: a brand-green blob with two ink eyes (foundations.md, Evry character). It replaces any generic AI
 * icon. CSS in product.css runs the shape, the blink and the four moods; reduced motion stops them. Pointer follow
 * belongs to the open Evry panel only and is not part of this component. `blinkOffset` (0 to 1) staggers the blink so
 * several bots on one page do not blink together, with the same markup on the server and the client.
 */
export function EvryBot({ size, mood = "idle", blinkOffset = 0, className }: { size: EvryBotSize; mood?: EvryMood; blinkOffset?: number; className?: string }) {
  const style = { "--blink": `${(3.8 + blinkOffset * 3).toFixed(2)}s`, "--blink-delay": `${(-blinkOffset * 4).toFixed(2)}s` } as CSSProperties;
  return (
    <span className={cn("evry-bot", className)} data-size={size} data-mood={mood} style={style} aria-hidden="true">
      <span className="eb-body" />
      <span className="eb-face">
        <span className="eb-eye" />
        <span className="eb-eye" />
        <span className="eb-mouth" />
      </span>
    </span>
  );
}
