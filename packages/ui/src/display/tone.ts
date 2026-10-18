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

/** A tone's 500 step, for dots, swatches and chart marks. */
export const SOLID: Record<Tone, string> = {
	green: "bg-green-500",
	blue: "bg-blue-500",
	amber: "bg-amber-500",
	magenta: "bg-magenta-500",
	violet: "bg-violet-500",
	teal: "bg-teal-500",
	ink: "bg-ink",
};

/** The same 500 steps as CSS values, for SVG fills and the hatch utility's --hatch. */
export const HUE: Record<Tone, string> = {
	green: "var(--ef-green-500)",
	blue: "var(--ef-blue-500)",
	amber: "var(--ef-amber-500)",
	magenta: "var(--ef-magenta-500)",
	violet: "var(--ef-violet-500)",
	teal: "var(--ef-teal-500)",
	ink: "var(--ef-ink)",
};
