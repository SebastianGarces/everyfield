/** Joins class names and drops empty ones. Callers do not pass conflicting utilities, so no merge step is needed. */
export function cn(...parts: (string | false | null | undefined)[]): string {
	return parts.filter(Boolean).join(" ");
}
