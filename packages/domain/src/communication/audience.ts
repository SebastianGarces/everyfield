import type { AudienceInput } from "@everyfield/contracts/communication";
import { audienceResult } from "@everyfield/contracts/communication";
import { defaultChannelEnabled, notificationCategory } from "@everyfield/contracts/settings";
import { sql, type SQL } from "@everyfield/db/query";
import { z } from "zod";
import { hash } from "../operations/canonical.ts";

const personRow = z.object({
	id: z.uuid(),
	displayName: z.string(),
	email: z.string().nullable(),
	n: z.number().int(),
});

/** One set-based audience. Duplicate person ids stay. Paused teams and unknown groups add nobody. */
export function audiencePeople(plantId: string, audience: AudienceInput): SQL {
	const groups = JSON.stringify(audience.groups);
	const teamIds = JSON.stringify(audience.teamIds);
	const personIds = JSON.stringify(audience.personIds);
	return sql`coalesce((
		SELECT jsonb_agg(jsonb_build_object('id', id, 'displayName', display_name, 'email', email, 'n', n))
		FROM (
			SELECT id, display_name, email, count(*)::int AS n
			FROM (
				SELECT p.id, p.display_name, p.email
				FROM jsonb_array_elements_text(${personIds}::jsonb) AS e(value)
				JOIN person p ON p.id = e.value::uuid
				WHERE p.plant_id = ${plantId}::uuid AND p.tenant_id = ${plantId}::uuid AND p.state = 'live'
				UNION ALL
				SELECT DISTINCT p.id, p.display_name, p.email
				FROM person p
				WHERE p.plant_id = ${plantId}::uuid AND p.tenant_id = ${plantId}::uuid AND p.state = 'live'
				AND (
					EXISTS (SELECT 1 FROM jsonb_array_elements_text(${groups}::jsonb) g(value) WHERE g.value = 'all')
					OR (p.stage = 'core_group' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${groups}::jsonb) g(value) WHERE g.value = 'core_group'))
					OR (p.stage = 'launch_team' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${groups}::jsonb) g(value) WHERE g.value = 'launch_team'))
					OR (p.stage = 'prospect' AND p.linked_account_id IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${groups}::jsonb) g(value) WHERE g.value = 'prospects'))
					OR (
						EXISTS (SELECT 1 FROM jsonb_array_elements_text(${groups}::jsonb) g(value) WHERE g.value = 'leaders')
						AND (
							p.stage = 'leader'
							OR EXISTS (
								SELECT 1 FROM team t
								WHERE t.plant_id = ${plantId}::uuid AND t.leader_person_id = p.id
								AND t.state IN ('active', 'forming') AND t.archived_at IS NULL
							)
							OR EXISTS (
								SELECT 1 FROM team_tenure tn
								JOIN team_role r ON r.id = tn.role_id AND r.plant_id = tn.plant_id
								JOIN team t ON t.id = r.team_id AND t.plant_id = r.plant_id
								WHERE tn.person_id = p.id AND tn.plant_id = ${plantId}::uuid AND tn.ended_on IS NULL
								AND r.leadership IS TRUE AND r.retired_at IS NULL
								AND t.state IN ('active', 'forming') AND t.archived_at IS NULL
							)
						)
					)
				)
				UNION ALL
				SELECT DISTINCT p.id, p.display_name, p.email
				FROM person p
				JOIN team_tenure tn ON tn.person_id = p.id AND tn.plant_id = p.plant_id AND tn.ended_on IS NULL
				JOIN team_role r ON r.id = tn.role_id AND r.plant_id = tn.plant_id AND r.retired_at IS NULL
				JOIN team t ON t.id = r.team_id AND t.plant_id = r.plant_id
				WHERE p.plant_id = ${plantId}::uuid AND p.tenant_id = ${plantId}::uuid AND p.state = 'live'
				AND t.state IN ('active', 'forming') AND t.archived_at IS NULL
				AND t.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${teamIds}::jsonb) s(value))
			) picked
			GROUP BY id, display_name, email
		) counted
	), '[]'::jsonb)`;
}

const NAMED_CAP = 200;

export function summarizeAudience(raw: unknown) {
	const rows = z.array(personRow).parse(raw ?? []);
	const missing = rows
		.filter((row) => !row.email?.trim())
		.map((row) => row.displayName)
		.sort((a, b) => a.localeCompare(b));
	const withEmail = rows.filter((row) => row.email?.trim());
	const named = [...withEmail].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
	const emails = new Set(withEmail.map((row) => row.email!.trim().toLowerCase()));
	const occurrences = withEmail.reduce((sum, row) => sum + row.n, 0);
	return audienceResult.parse({
		resolvedDistinctPeople: rows.length,
		eligibleRecipients: withEmail.length,
		missingEmailExclusions: missing,
		duplicateAddressesRemoved: occurrences - emails.size,
		eligibleEmails: [...emails].sort(),
		searchResultLimit: 20,
		searchLimitTruncatesAudience: false,
		recipients: named
			.slice(0, NAMED_CAP)
			.map((row) => ({ id: row.id, displayName: row.displayName, email: row.email!.trim() })),
		complete: named.length <= NAMED_CAP,
	});
}

export function eligibleIds(raw: unknown): string[] {
	return reviewedParts(raw).people;
}

/** Person ids and addresses a review freezes. Both lists are sorted the same way at schedule and at handoff. */
export function reviewedParts(raw: unknown): { people: string[]; emails: string[] } {
	const rows = z
		.array(personRow)
		.parse(raw ?? [])
		.filter((row) => row.email?.trim());
	return {
		people: rows.map((row) => row.id).sort(),
		emails: rows.map((row) => row.email!.trim().toLowerCase()).sort(),
	};
}

/** The people and addresses of one resolved audience: a review saves it, and the schedule compares it. */
export const recipientsDigest = (raw: unknown) => hash(reviewedParts(raw));

/** The email categories a person can switch, each with its state for a person who never saved a choice. */
const UPDATE_CATEGORIES = notificationCategory.options.filter((name) => name !== "wiki_upstream_review");
const UPDATE_DEFAULTS = UPDATE_CATEGORIES.map((name) => defaultChannelEnabled(name, "email"));
/**
 * True for a person whose linked account has every email category it can switch turned off, by the same rule Settings
 * shows: a saved choice, else the default. Settings offers the oversight digest only to an account with an organization
 * seat. Planter email skips these people at handoff, and a review names them, so a review shows what the handoff does.
 */
export function updatesOff(person: SQL): SQL {
	return sql`EXISTS (
		SELECT 1 FROM person up WHERE up.id = ${person} AND up.linked_account_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM unnest(${sql.param(UPDATE_CATEGORIES)}::text[], ${sql.param(UPDATE_DEFAULTS)}::boolean[]) c(category, by_default)
			LEFT JOIN notification_preference np
				ON np.account_id = up.linked_account_id AND np.category = c.category AND np.channel = 'email'
			WHERE coalesce(np.enabled, c.by_default)
				AND (c.category <> 'oversight_digest' OR EXISTS (
					SELECT 1 FROM seat s WHERE s.account_id = up.linked_account_id AND s.ended_at IS NULL AND s.organization_id IS NOT NULL
				))
		)
	)`;
}
