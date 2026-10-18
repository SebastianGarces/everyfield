import { createHash } from "node:crypto";
export const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
	return (
		"{" +
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b, "en"))
			.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
			.join(",") +
		"}"
	);
}
export function stableId(key: string): string {
	const h = hash("everyfield-reference-v1:" + key);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// PostgreSQL vector stores float32. Hash that representation, not a provider's JSON spelling.
export function vectorHash(values: readonly number[]): string {
	const bytes = Buffer.alloc(values.length * 4);
	values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
	return hash(bytes);
}
