// Class strings shared by server markup and client leaves of the panels. A plain module: a "use client" module's
// non-component exports reach a Server Component only as client references, not as values.

/** The sharing switch: track and knob. */
export const SWITCH =
	"relative h-[22px] w-9 flex-none overflow-hidden bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]";
export const KNOB = "absolute top-[3px] left-[3px] size-4 rounded-full bg-white shadow-mk-knob will-change-transform";

/** A person chip that pops or drops in (meeting guests, the facts names, the teams' flying chip). */
export const CHIP = "inline-flex items-center bg-white font-semibold whitespace-nowrap text-ink shadow-mk-chip";
