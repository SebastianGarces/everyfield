import { createHash } from "node:crypto";

/** UTF-16 code unit order: the same on every machine, unlike `localeCompare`, which follows the process's LANG/ICU. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A value as JSON with its object keys sorted by UTF-16 code unit, so equal values give equal text on every machine.
 * Stored request identities compare digests of this text (prepareWrite), so every module uses this one function and its
 * bytes never change. A locale-aware sort would let a server's LANG/ICU settings change those bytes.
 */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
	if (value !== null && typeof value === "object")
		return (
			"{" +
			Object.entries(value)
				.sort(([a], [b]) => byCodeUnit(a, b))
				.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
				.join(",") +
			"}"
		);
	return JSON.stringify(value);
}
/** The SHA-256 hex digest of a value's canonical JSON. */
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
