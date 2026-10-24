import * as c from "@everyfield/contracts/teams/responsibilities";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { AuditWrite } from "../../operations/writes.ts";
import { command, deny, next, parse, reply, type TeamsContext, type Tx, type Writer } from "../core.ts";
import {
	catalogVersion,
	insertCustom,
	insertOfferLines,
	markRemoved,
	saveCompleted,
	saveText,
	stampOffer,
	type OfferLine,
} from "./store.ts";

const id = z.string().uuid();
const lineRow = z.object({ id, line: z.string(), removed: z.boolean(), text: z.string() });
const teamLock = z.object({
	id,
	revision: z.string(),
	offer: z.enum(["accepted", "declined"]).nullable(),
	offerVersion: id.nullable(),
	archived: z.boolean(),
	versionId: id.nullable(),
	nextSort: z.coerce.number().int(),
	lines: z.array(lineRow),
});
const rowLock = z.object({
	id,
	teamId: id,
	revision: z.string(),
	text: z.string(),
	sourceLine: z.string(),
	completedOn: z.string().nullable(),
	removed: z.boolean(),
	archived: z.boolean(),
	today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
type TeamLock = z.infer<typeof teamLock>;
type RowLock = z.infer<typeof rowLock>;

function expectRevision(actual: string, expected: string) {
	if (actual !== expected) deny("conflict");
}
async function oneRow(tx: Tx, query: ReturnType<typeof sql>) {
	const found = await tx.execute(query);
	return found.rows[0] as Record<string, unknown> | undefined;
}
async function lockTeam(tx: Tx, w: Writer, teamId: string): Promise<TeamLock> {
	const row = await oneRow(
		tx,
		sql`SELECT t.id, t.revision::text AS revision, t.responsibility_offer AS offer,
			t.responsibility_offer_version_id AS "offerVersion",
			(t.archived_at IS NOT NULL) AS archived,
			${catalogVersion()} AS "versionId",
			coalesce((SELECT max(r.sort_order) FROM responsibility r
				WHERE r.team_id = t.id AND r.plant_id = t.plant_id), 0) + 1 AS "nextSort",
			coalesce((SELECT json_agg(json_build_object(
				'id', r.id, 'line', r.source_line, 'removed', (r.removed_at IS NOT NULL), 'text', r.text
			)) FROM responsibility r WHERE r.team_id = t.id AND r.plant_id = t.plant_id), '[]'::json) AS lines
			FROM team t
			WHERE t.id = ${teamId}::uuid AND t.plant_id = ${w.plant.id}::uuid
			FOR UPDATE OF t`,
	);
	if (!row) deny("access_denied");
	return teamLock.parse(row);
}
async function lockRow(tx: Tx, w: Writer, responsibilityId: string): Promise<RowLock> {
	const row = await oneRow(
		tx,
		sql`SELECT r.id, r.team_id AS "teamId", r.revision::text AS revision, r.text,
			r.source_line AS "sourceLine", r.completed_on::text AS "completedOn",
			(r.removed_at IS NOT NULL) AS removed, (t.archived_at IS NOT NULL) AS archived,
			(clock_timestamp() AT TIME ZONE p.timezone)::date::text AS today
			FROM responsibility r
			JOIN team t ON t.id = r.team_id AND t.plant_id = r.plant_id
			JOIN plant p ON p.id = r.plant_id
			WHERE r.id = ${responsibilityId}::uuid AND r.plant_id = ${w.plant.id}::uuid
			FOR UPDATE OF r, t`,
	);
	if (!row) deny("access_denied");
	return rowLock.parse(row);
}
function teamOf(responsibilityId: string) {
	return async (tx: Tx, w: Writer) => {
		const found = await oneRow(
			tx,
			sql`SELECT team_id AS "teamId" FROM responsibility
				WHERE id = ${responsibilityId}::uuid AND plant_id = ${w.plant.id}::uuid`,
		);
		return typeof found?.teamId === "string" ? found.teamId : undefined;
	};
}
function freshLines(team: TeamLock, active: ReadonlySet<string>): OfferLine[] {
	const stored = new Set(team.lines.map((line) => line.line));
	return c.RESPONSIBILITY_LINES.filter((line) => !stored.has(line.key)).map((line) => ({
		id: randomUUID(),
		key: line.key,
		text: line.text,
		sortOrder: line.sortOrder,
		active: active.has(line.key),
	}));
}
function offerValue(
	audit: AuditWrite,
	outcome: "changed" | "noop",
	teamId: string,
	decision: "accept" | "decline",
	revision: string,
	createdIds: string[],
) {
	return c.offerResult.parse({ receiptId: audit.id, outcome, teamId, decision, revision, createdIds });
}

export const responsibilityWriter = {
	async offerResponsibilities(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.offerRequest, raw);
			return command(tx, ctx, "teams.offerResponsibilities", input, async (w, audit) => {
				const team = await lockTeam(tx, w, input.input.teamId);
				if (team.archived) deny("access_denied");
				expectRevision(team.revision, input.expectedRevision);
				if (!team.versionId) deny("unavailable");
				const selected = [...new Set(input.input.selected)];
				if (selected.some((key) => !c.RESPONSIBILITY_LINES.some((line) => line.key === key))) deny("access_denied");
				if (team.offer === "declined") {
					return {
						value: offerValue(audit, "noop", team.id, "decline", team.revision, []),
						subject: team.id,
						subjectType: "team" as const,
						kind: "offer_answer" as const,
						outcome: "noop" as const,
						before: { offer: "declined" },
						after: { offer: "declined" },
						revision: { before: team.revision, after: team.revision },
					};
				}
				if (input.input.decision === "decline" && team.offer === "accepted") deny("conflict");
				const versionId = team.versionId;
				const lines = freshLines(team, input.input.decision === "accept" ? new Set(selected) : new Set());
				const same = input.input.decision === "accept" && team.offer === "accepted" && team.offerVersion === versionId;
				if (same && lines.length === 0) {
					return {
						value: offerValue(audit, "noop", team.id, "accept", team.revision, []),
						subject: team.id,
						subjectType: "team" as const,
						kind: "offer_answer" as const,
						outcome: "noop" as const,
						before: { offer: team.offer, version: team.offerVersion },
						after: { offer: "accepted", version: versionId },
						revision: { before: team.revision, after: team.revision },
					};
				}
				const inserted = insertOfferLines(w.plant.id, team.id, versionId, lines);
				if (inserted) audit.writes.push(inserted);
				const decision = input.input.decision === "accept" ? "accepted" : "declined";
				audit.writes.push(stampOffer(w.plant.id, team.id, decision, versionId, team.revision));
				const revision = next(team.revision);
				return {
					value: offerValue(
						audit,
						"changed",
						team.id,
						input.input.decision,
						revision,
						lines.map((line) => line.id),
					),
					subject: team.id,
					subjectType: "team" as const,
					kind: "offer_answer" as const,
					before: { offer: team.offer, version: team.offerVersion },
					after: { offer: decision, version: versionId },
					revision: { before: team.revision, after: revision },
				};
			});
		});
	},
	async addResponsibility(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.addRequest, raw);
			return command(
				tx,
				ctx,
				"teams.addResponsibility",
				input,
				async (w, audit) => {
					const team = await lockTeam(tx, w, input.input.teamId);
					if (team.archived) deny("access_denied");
					expectRevision(team.revision, input.expectedRevision);
					if (!team.versionId) deny("unavailable");
					const responsibilityId = randomUUID();
					const sourceLine = `custom:${responsibilityId}`;
					audit.writes.push(
						insertCustom(
							w.plant.id,
							team.id,
							team.versionId,
							responsibilityId,
							sourceLine,
							input.input.text,
							team.nextSort,
						),
					);
					return {
						value: c.addResult.parse({
							receiptId: audit.id,
							outcome: "changed",
							id: responsibilityId,
							teamId: team.id,
							revision: "1",
							sourceLine,
							text: input.input.text,
						}),
						subject: responsibilityId,
						subjectType: "responsibility" as const,
						kind: "create" as const,
						before: null,
						after: { text: input.input.text, sourceLine },
					};
				},
				input.input.teamId,
			);
		});
	},
	async editResponsibility(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.editRequest, raw);
			return command(
				tx,
				ctx,
				"teams.editResponsibility",
				input,
				async (w, audit) => {
					const row = await lockRow(tx, w, input.input.responsibilityId);
					if (row.archived) deny("access_denied");
					if (row.removed) deny("conflict");
					expectRevision(row.revision, input.expectedRevision);
					const same = row.text === input.input.text;
					if (!same) audit.writes.push(saveText(w.plant.id, row.id, input.input.text));
					const revision = same ? row.revision : next(row.revision);
					return {
						value: c.editResult.parse({
							receiptId: audit.id,
							outcome: same ? "noop" : "changed",
							id: row.id,
							revision,
							text: input.input.text,
						}),
						subject: row.id,
						subjectType: "responsibility" as const,
						kind: "edit" as const,
						outcome: same ? ("noop" as const) : ("changed" as const),
						before: { text: row.text },
						after: { text: input.input.text },
						revision: { before: row.revision, after: revision },
					};
				},
				teamOf(input.input.responsibilityId),
			);
		});
	},
	async completeResponsibility(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.completeRequest, raw);
			return command(
				tx,
				ctx,
				"teams.completeResponsibility",
				input,
				async (w, audit) => {
					const row = await lockRow(tx, w, input.input.responsibilityId);
					if (row.archived) deny("access_denied");
					if (row.removed) deny("conflict");
					expectRevision(row.revision, input.expectedRevision);
					const done = input.input.done;
					const same = done ? row.completedOn !== null : row.completedOn === null;
					const completedOn = same ? row.completedOn : done ? row.today : null;
					if (!same) audit.writes.push(saveCompleted(w.plant.id, row.id, done, row.today));
					const revision = same ? row.revision : next(row.revision);
					return {
						value: c.completeResult.parse({
							receiptId: audit.id,
							outcome: same ? "noop" : "changed",
							id: row.id,
							revision,
							completedOn,
						}),
						subject: row.id,
						subjectType: "responsibility" as const,
						kind: (done ? "tick" : "untick") as "tick" | "untick",
						outcome: same ? ("noop" as const) : ("changed" as const),
						before: { completedOn: row.completedOn },
						after: { completedOn },
						revision: { before: row.revision, after: revision },
					};
				},
				teamOf(input.input.responsibilityId),
			);
		});
	},
	async deleteResponsibility(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.deleteRequest, raw);
			return command(
				tx,
				ctx,
				"teams.deleteResponsibility",
				input,
				async (w, audit) => {
					const row = await lockRow(tx, w, input.input.responsibilityId);
					if (row.archived) deny("access_denied");
					if (row.removed) deny("conflict");
					expectRevision(row.revision, input.expectedRevision);
					audit.writes.push(markRemoved(w.plant.id, row.id));
					const revision = next(row.revision);
					return {
						value: c.deleteResult.parse({ receiptId: audit.id, outcome: "changed", id: row.id, revision }),
						subject: row.id,
						subjectType: "responsibility" as const,
						kind: "remove" as const,
						before: { removed: false },
						after: { removed: true },
						revision: { before: row.revision, after: revision },
					};
				},
				teamOf(input.input.responsibilityId),
			);
		});
	},
};
