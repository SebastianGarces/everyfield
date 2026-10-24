import { playbookTeam } from "@everyfield/reference/playbook";
import { sql, type SQL } from "@everyfield/db/query";
import { reviewDigest } from "../templates.ts";

/** WP-017 key with no source team. It gets no Playbook lines, same as a custom team. */
export const NO_PLAYBOOK_TEAM_KEY = "administration";

/**
 * team.template_key to the frozen catalog teamKey.
 * The source names the org-chart root senior_pastor. WP-017 stores that team as leadership.
 */
export const REFERENCE_TEAM_KEY = {
	leadership: "senior_pastor",
	worship: "worship",
	childrens_ministry: "childrens_ministry",
	assimilation: "assimilation",
	small_groups: "small_groups",
	facilities: "facilities",
	promotion: "promotion",
	technology: "technology",
	prayer: "prayer",
} as const;

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const MINISTRY_TEMPLATE_KIND = "ministry_template";

export type PlaybookLine = { key: string; text: string; sortOrder: number };
export type StoredLine = { sourceLine: string; text: string; removed: boolean };

export function referenceTeamKey(templateKey: string | null): string | null {
	if (templateKey === null || templateKey === NO_PLAYBOOK_TEAM_KEY) return null;
	if (!Object.hasOwn(REFERENCE_TEAM_KEY, templateKey)) return null;
	return REFERENCE_TEAM_KEY[templateKey as keyof typeof REFERENCE_TEAM_KEY];
}

/** Same split as docs/reference/ministry-role-templates.ts playbookResponsibilities. */
export function playbookLines(description: string | null): PlaybookLine[] {
	if (!description) return [];
	return description
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.map((item, index) => {
			const text = item.charAt(0).toUpperCase() + item.slice(1);
			return { key: text, text, sortOrder: index + 1 };
		});
}

export function linesForTemplate(templateKey: string | null): PlaybookLine[] {
	const referenceKey = referenceTeamKey(templateKey);
	if (!referenceKey) return [];
	return playbookLines(playbookTeam(referenceKey).description);
}

export function catalogSha(): string {
	return playbookTeam("").version;
}

/** The caller selects from team t. The CASE reads t.template_key. */
export function referenceKeySql(): SQL {
	const arms = Object.entries(REFERENCE_TEAM_KEY).map(
		([templateKey, referenceKey]) => sql`WHEN ${templateKey} THEN ${referenceKey}`,
	);
	return sql`CASE t.template_key ${sql.join(arms, sql` `)} ELSE NULL END`;
}

/** Latest installed ministry_template row for t.template_key. Line text does not come from this row. */
export const catalogVersion = () => sql`(SELECT v.id FROM reference_version v
	JOIN reference_item i ON i.id = v.item_id
	WHERE i.kind = ${MINISTRY_TEMPLATE_KIND} AND i.canonical_key = ${referenceKeySql()}
		AND i.tenant_id = ${GLOBAL}::uuid
	ORDER BY v.version_number DESC, v.id DESC
	LIMIT 1)`;

function byStoredLine(a: StoredLine, b: StoredLine) {
	const line = a.sourceLine.localeCompare(b.sourceLine);
	if (line !== 0) return line;
	return a.text.localeCompare(b.text);
}

/** Preview and offer share this digest. A declined offer shows no proposed lines. */
export function responsibilityReview(templateKey: string | null, stored: readonly StoredLine[], declined: boolean) {
	const catalog = linesForTemplate(templateKey);
	const storedKeys = new Set(stored.map((row) => row.sourceLine));
	const proposed = catalog.filter((line) => !storedKeys.has(line.key));
	const lines = declined ? [] : proposed;
	const customizations = [...stored].sort(byStoredLine);
	const templateVersion = catalogSha();
	return {
		catalog,
		lines,
		customizations,
		templateVersion,
		reviewDigest: reviewDigest({
			expectedVersion: templateVersion,
			mode: "responsibilities",
			selections: customizations,
			lines,
		}),
		proposedCount: lines.length,
	};
}
