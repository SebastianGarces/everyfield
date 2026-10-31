import { MERGE_BYTES_MAX } from "@everyfield/contracts/documents";
import type { CatalogTemplate } from "./catalog.ts";

export type FieldSources = {
	churchName: string | null;
	pastorName: string | null;
	launchDate: string | null;
	/** The date of the meeting a render is built from, as the meeting screen words it. */
	meetingDate?: string | null;
};
export type ResolvedField = {
	key: string;
	label: string;
	required: boolean;
	value: string | null;
	source: "override" | "church_name" | "pastor_name" | "launch_date" | "meeting" | "absent";
};
type Problem = { ok: false; path: string; problem: string };
export type ResolvedMerge = Problem | { ok: true; fields: ResolvedField[]; missing: string[]; complete: boolean };

/** Drop blank overrides. Reject the raw map when its values exceed the combined byte cap. */
export function cleanOverrides(
	raw: Record<string, string> | undefined,
): Problem | { ok: true; values: Record<string, string> } {
	const values: Record<string, string> = {};
	let bytes = 0;
	for (const [key, value] of Object.entries(raw ?? {})) {
		bytes += Buffer.byteLength(value, "utf8");
		const trimmed = value.trim();
		if (trimmed.length > 0) values[key] = trimmed;
	}
	if (bytes > MERGE_BYTES_MAX) return { ok: false, path: "overrides", problem: "Combined merge fields exceed 16KiB." };
	return { ok: true, values };
}

function autoValue(
	key: string | undefined,
	sources: FieldSources,
): { value: string; source: ResolvedField["source"] } | null {
	if (key === "church_name" && sources.churchName?.trim())
		return { value: sources.churchName.trim(), source: "church_name" };
	if (key === "pastor_name" && sources.pastorName?.trim())
		return { value: sources.pastorName.trim(), source: "pastor_name" };
	if (key === "launch_date" && sources.launchDate?.trim())
		return { value: sources.launchDate.trim(), source: "launch_date" };
	if (key === "meeting_date" && sources.meetingDate?.trim())
		return { value: sources.meetingDate.trim(), source: "meeting" };
	return null;
}

/** Closed catalog keys only. A blank override is not an override. Unknown auto-fill adds no invented default. */
export function resolveMerge(
	template: CatalogTemplate,
	sources: FieldSources,
	overrides: Record<string, string>,
): ResolvedMerge {
	const known = new Set(template.mergeFields.map((field) => field.key));
	const foreign = Object.keys(overrides).find((key) => !known.has(key));
	if (foreign) return { ok: false, path: `overrides.${foreign}`, problem: "Unknown merge field." };
	const fields: ResolvedField[] = [];
	const missing: string[] = [];
	for (const field of template.mergeFields) {
		const explicit = overrides[field.key];
		if (explicit !== undefined) {
			fields.push({
				key: field.key,
				label: field.label,
				required: field.required,
				value: explicit,
				source: "override",
			});
			continue;
		}
		// meeting_date has no autoFill in the frozen catalog row; a render from a meeting fills it by key.
		const filled = autoValue(field.autoFill ?? (field.key === "meeting_date" ? "meeting_date" : undefined), sources);
		if (filled) {
			fields.push({
				key: field.key,
				label: field.label,
				required: field.required,
				value: filled.value,
				source: filled.source,
			});
			continue;
		}
		if (field.required) missing.push(field.key);
		fields.push({ key: field.key, label: field.label, required: field.required, value: null, source: "absent" });
	}
	return { ok: true, fields, missing, complete: missing.length === 0 };
}
