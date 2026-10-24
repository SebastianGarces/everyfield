import type { AudienceInput } from "@everyfield/contracts/communication";
import { audienceResult } from "@everyfield/contracts/communication";
import { sql, type SQL } from "@everyfield/db/query";
import { z } from "zod";

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

export function summarizeAudience(raw: unknown) {
	const rows = z.array(personRow).parse(raw ?? []);
	const missing = rows
		.filter((row) => !row.email?.trim())
		.map((row) => row.displayName)
		.sort((a, b) => a.localeCompare(b));
	const withEmail = rows.filter((row) => row.email?.trim());
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
