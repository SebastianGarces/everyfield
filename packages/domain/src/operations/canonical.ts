import { createHash } from "node:crypto";

/**
 * A value as JSON with its object keys sorted, so equal values give equal text. Stored request identities compare
 * digests of this text (prepareWrite), so every module uses this one function and its bytes never change.
 */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
	if (value !== null && typeof value === "object")
		return (
			"{" +
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
				.join(",") +
			"}"
		);
	return JSON.stringify(value);
}
/** The SHA-256 hex digest of a value's canonical JSON. */
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
