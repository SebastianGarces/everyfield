import type { Tone } from "../controls";

export type { Tone };

/** A tone's 100 tint behind its 600 or 700 mark (foundations.md, Color roles), as in the prototype's .tone-* classes. */
export const TINT: Record<Tone, string> = {
	green: "bg-green-100 text-green-700",
	blue: "bg-blue-100 text-blue-600",
	amber: "bg-amber-100 text-amber-600",
	magenta: "bg-magenta-100 text-magenta-600",
	violet: "bg-violet-100 text-violet-600",
	teal: "bg-teal-100 text-teal-600",
	ink: "bg-surface-2 text-ink-2",
};
