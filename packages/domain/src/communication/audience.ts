import type { AudienceInput } from "@everyfield/contracts/communication";
import { audienceResult } from "@everyfield/contracts/communication";
import { sql, type SQL } from "@everyfield/db/query";
import { z } from "zod";
import { hash } from "../operations/canonical.ts";
import { effectiveAdultSql, plantTodaySql } from "../people/adult.ts";
import { guardianLinksSql } from "../people/households/guardians.ts";
import { optedOutAtSql, optedOutSql } from "./opt-out.ts";

const guardianRow = z.object({
	id: z.uuid(),
	displayName: z.string(),
	email: z.string().nullable(),
	optedOut: z.boolean(),
});
const personRow = z.object({
	id: z.uuid(),
	displayName: z.string(),
	email: z.string().nullable(),
	n: z.number().int(),
	optedOutAt: z.string().nullable(),
	child: z.boolean(),
	guardians: z.array(guardianRow),
});
type Person = z.infer<typeof personRow>;
export type Guardian = z.infer<typeof guardianRow> & { email: string };

export const childSql = (plantId: SQL, personId: SQL) =>
	sql`EXISTS (SELECT 1 FROM person cp WHERE cp.id = ${personId} AND cp.tenant_id = ${plantId}
		AND ${effectiveAdultSql(sql`cp.birth_date`, sql`cp.adult_classification`, plantTodaySql(sql`cp.plant_id`))} = 'child')`;

const reachable = (plantId: SQL) =>
	sql`btrim(coalesce(gad.email, '')) <> '' AND NOT ${optedOutSql(plantId, sql`gad.id`)}`;
export const linksOf = (plantId: SQL, childId: SQL, where: SQL = sql`true`, join: SQL = sql``) =>
	guardianLinksSql(sql`gcx.plant_id = ${plantId} AND gcx.child_person_id = ${childId} AND ${where}`, join);

export const guardiansSql = (plantId: SQL, childId: SQL) =>
	sql`coalesce((SELECT jsonb_agg(jsonb_build_object('id', gad.id, 'displayName', gad.display_name, 'email', gad.email,
		'optedOut', ${optedOutSql(plantId, sql`gad.id`)}) ORDER BY gad.display_name, gad.id)
		FROM ${linksOf(plantId, childId)}), '[]'::jsonb)`;

export const routedSql = (plantId: SQL, childId: SQL) =>
	sql`EXISTS (SELECT 1 FROM ${linksOf(plantId, childId, reachable(plantId))})`;

export const routedIdsSql = (plantId: SQL, childId: SQL) =>
	sql`(SELECT gad.id FROM ${linksOf(plantId, childId, reachable(plantId))})`;

export const routedNamesSql = (plantId: SQL, childId: SQL) =>
	sql`(SELECT string_agg(gad.display_name, ', ' ORDER BY gad.display_name, gad.id)
		FROM ${linksOf(plantId, childId, reachable(plantId))})`;

export const usable = (guardian: z.infer<typeof guardianRow>): guardian is Guardian =>
	!!guardian.email?.trim() && !guardian.optedOut;

export function routeChildren<T extends { id: string; child: boolean; guardians: z.infer<typeof guardianRow>[] }>(
	rows: readonly T[],
	reached: (guardian: Guardian) => boolean = () => true,
) {
	const children = rows.filter((row) => row.child);
	const routes = children.map((child) => ({
		child,
		guardians: child.guardians.filter(usable).filter(reached),
	}));
	return {
		routed: routes.filter((route) => route.guardians.length > 0),
		unrouted: routes.filter((route) => route.guardians.length === 0).map((route) => route.child),
	};
}

function guardianOnly(rows: readonly Person[], routed: ReturnType<typeof routeChildren<Person>>["routed"]) {
	const own = new Set(rows.filter((row) => !row.child).map((row) => row.id));
	const byId = new Map<string, Guardian & { children: string[] }>();
	for (const route of routed)
		for (const guardian of route.guardians) {
			if (own.has(guardian.id)) continue;
			const found = byId.get(guardian.id) ?? { ...guardian, email: guardian.email.trim(), children: [] };
			found.children.push(route.child.displayName);
			byId.set(guardian.id, found);
		}
	return [...byId.values()];
}

export function audiencePeople(plantId: string, audience: AudienceInput): SQL {
	const groups = JSON.stringify(audience.groups);
	const teamIds = JSON.stringify(audience.teamIds);
	const personIds = JSON.stringify(audience.personIds);
	return sql`coalesce((
		SELECT jsonb_agg(jsonb_build_object('id', id, 'displayName', display_name, 'email', email, 'n', n,
			'optedOutAt', ${optedOutAtSql(sql`${plantId}::uuid`, sql`counted.id`)},
			'child', ${childSql(sql`${plantId}::uuid`, sql`counted.id`)},
			'guardians', ${guardiansSql(sql`${plantId}::uuid`, sql`counted.id`)}))
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
	const all = z.array(personRow).parse(raw ?? []);
	const byName = (a: { displayName: string; id: string }, b: { displayName: string; id: string }) =>
		a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
	const { routed, unrouted } = routeChildren(all);
	const children = [...unrouted].sort(byName);
	const rows = all.filter((row) => !row.child);
	const missing = rows
		.filter((row) => !row.email?.trim())
		.map((row) => row.displayName)
		.sort((a, b) => a.localeCompare(b));
	const addressed = rows.flatMap((row) => {
		const email = row.email?.trim();
		return email ? [{ ...row, email }] : [];
	});
	const unsubscribed = addressed
		.flatMap((row) => (row.optedOutAt ? [{ ...row, optedOutAt: row.optedOutAt }] : []))
		.sort(byName);
	const withEmail = addressed.filter((row) => !row.optedOutAt);
	const extra = guardianOnly(all, routed);
	const reached = [...withEmail, ...extra.map((row) => ({ ...row, n: 1 }))];
	const named = [...reached].sort(byName);
	const emails = new Set(reached.map((row) => row.email.toLowerCase()));
	const occurrences = reached.reduce((sum, row) => sum + row.n, 0);
	return audienceResult.parse({
		resolvedDistinctPeople: all.length,
		eligibleRecipients: reached.length,
		missingEmailExclusions: missing,
		duplicateAddressesRemoved: occurrences - emails.size,
		eligibleEmails: [...emails].sort(),
		searchResultLimit: 20,
		searchLimitTruncatesAudience: false,
		recipients: named
			.slice(0, NAMED_CAP)
			.map((row) => ({ id: row.id, displayName: row.displayName, email: row.email })),
		complete: named.length <= NAMED_CAP,
		unsubscribedExclusions: unsubscribed
			.slice(0, NAMED_CAP)
			.map((row) => ({ id: row.id, displayName: row.displayName, unsubscribedAt: row.optedOutAt })),
		childExclusions: children.slice(0, NAMED_CAP).map((row) => ({ id: row.id, displayName: row.displayName })),
		guardianRoutes: [...routed]
			.sort((a, b) => byName(a.child, b.child))
			.slice(0, NAMED_CAP)
			.map((route) => ({
				id: route.child.id,
				displayName: route.child.displayName,
				guardians: route.guardians.map((guardian) => ({ id: guardian.id, displayName: guardian.displayName })),
			})),
	});
}

export function onlyChildren(raw: unknown): boolean {
	const rows = z.array(personRow).parse(raw ?? []);
	return (
		rows.some((row) => row.child) &&
		!rows.some((row) => !row.child && row.email?.trim()) &&
		routeChildren(rows).routed.length === 0
	);
}

export function reviewedParts(raw: unknown): { people: string[]; emails: string[] } {
	const all = z.array(personRow).parse(raw ?? []);
	const rows = all.flatMap((row) => {
		const email = row.email?.trim();
		return email ? [{ id: row.id, email }] : [];
	});
	const people = new Set(rows.map((row) => row.id));
	const emails = rows.map((row) => row.email.toLowerCase());
	for (const route of routeChildren(all).routed) {
		people.add(route.child.id);
		for (const guardian of route.guardians)
			if (!people.has(guardian.id)) {
				people.add(guardian.id);
				emails.push(guardian.email.trim().toLowerCase());
			}
	}
	return { people: [...people].sort(), emails: emails.sort() };
}

export const recipientsDigest = (raw: unknown) => hash(reviewedParts(raw));
