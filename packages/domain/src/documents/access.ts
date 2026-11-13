import { documentsError, type DocumentsError, type DocumentsReply } from "@everyfield/contracts/documents";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, writeVisibility, type RequestActor } from "../access/session.ts";
import type { MeetingRead } from "./meeting-read.ts";
import { meetingFactsSql, parseMeeting } from "./meeting-read.ts";
import { networkStatementSql } from "./network-statement.ts";
import { dataFromRow } from "../branding/kit.ts";
import type { BrandKitData } from "@everyfield/contracts/branding";

export type Reader = Pick<Database, "execute">;
type Code = DocumentsError["code"];

class Refusal extends Error {
	readonly code: Code;
	readonly details: object;
	constructor(code: Code, details: object = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function deny(code: Code = "unavailable", details: object = {}): never {
	throw new Refusal(code, details);
}
function refused(error: Refusal): DocumentsReply<never> {
	return {
		status: "refused",
		error: documentsError.parse({
			code: error.code,
			details: error.details,
			correlationId: randomUUID(),
			retry: error.code === "conflict" ? "refresh" : "never",
		}),
	};
}
export async function settle<T>(body: () => Promise<T>): Promise<DocumentsReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof Refusal) return refused(error);
		throw error;
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (found.success) return found.data;
	deny("invalid_input", {
		issues: found.error.issues
			.slice(0, 50)
			.map((issue) => ({ path: issue.path.join(".").slice(0, 200), problem: issue.message.slice(0, 200) })),
	});
}
export function rejectInput(path: string, problem: string): never {
	deny("invalid_input", { issues: [{ path: path.slice(0, 200), problem: problem.slice(0, 200) }] });
}

export type PlantViewer = {
	plantId: string;
	accountId: string;
	access: Parameters<typeof liveRead>[0];
};
export function plantViewer(authority: RequestActor): PlantViewer | null {
	const actor = authority.actor;
	if (actor.context.kind !== "seat" || actor.context.owner.kind !== "plant") return null;
	return {
		plantId: actor.context.owner.id,
		accountId: actor.accountId,
		access: {
			session: authority.session,
			owner: actor.context.owner,
			seatId: actor.context.seatId,
			role: actor.context.role,
		},
	};
}

/** Account-level live check. A seat is not required. The session and the claimed account match in this statement. */
export async function accountOpen(db: Reader, authority: RequestActor) {
	const accountId = authority.actor.accountId;
	const found = await db.execute(sql`SELECT EXISTS(SELECT FROM live_session(${authority.session}::uuid) i
		WHERE i.registration_state='active' AND i.account_id=${accountId}::uuid
		AND ${writeVisibility(sql`i.account_id`, { kind: "account", id: accountId })}) AS access_live`);
	return found.rows[0]?.access_live === true;
}

type PlantFacts = { churchName: string | null; pastorName: string | null; launchDate: string | null };
export type PlantRead =
	| { open: false }
	| { open: true; subjectOk: false }
	| ({ open: true; subjectOk: true } & PlantFacts & {
				/** The live meeting named as the subject, with its agenda and list; null for no meeting or a retired one. */
				meeting: MeetingRead | null;
				/** The sending network's statement of faith (D-108), read with the plant (D-417), or null. */
				statement: string | null;
				/** The plant's saved brand kit, or null when it has none (BRD-001 reset removes the row). */
				kit: BrandKitData | null;
			});

function asText(value: unknown) {
	if (typeof value === "string" && value.trim()) return value;
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
	return null;
}

/** The display name of the plant's current senior pastor, or null: a scalar subquery for a SELECT list. */
export const seniorPastorName = (plantId: string) =>
	sql`SELECT pe.display_name FROM team_tenure tt
		JOIN team_role tr ON tr.id=tt.role_id AND tr.plant_id=${plantId}::uuid
			AND tr.retired_at IS NULL AND tr.template_key='senior_pastor'
		JOIN team tm ON tm.id=tr.team_id AND tm.plant_id=${plantId}::uuid AND tm.archived_at IS NULL
		JOIN person pe ON pe.id=tt.person_id AND pe.tenant_id=${plantId}::uuid AND pe.state='live'
		WHERE tt.ended_on IS NULL AND tt.plant_id=${plantId}::uuid
		ORDER BY tt.started_on, pe.id
		LIMIT 1`;

/**
 * One statement. Names stay null unless the live session, the claimed account, the seat, and the subject all match.
 * launch_date comes from the launch row, not from a plant column. The network's statement of faith is read here too, so
 * a preview or a saved file prints the text as it stands when the action runs (D-109, D-417).
 */
export async function readPlant(
	db: Reader,
	viewer: PlantViewer,
	subject: { personId: string | null; meetingId: string | null; teamId: string | null },
): Promise<PlantRead> {
	const found =
		await db.execute(sql`SELECT a.access_live, q.subject_ok, q.church_name, q.pastor_name, q.launch_date, q.meeting, q.statement, q.kit
		FROM (SELECT ${liveRead(viewer.access, false)} AND EXISTS(SELECT FROM live_session(${viewer.access.session}::uuid) s
			WHERE s.registration_state='active' AND s.account_id=${viewer.accountId}::uuid) AS access_live) a
		LEFT JOIN LATERAL (
			SELECT g.subject_ok,
				CASE WHEN g.subject_ok THEN p.name END AS church_name,
				CASE WHEN g.subject_ok THEN (${seniorPastorName(viewer.plantId)}) END AS pastor_name,
				CASE WHEN g.subject_ok THEN launch.day END AS launch_date,
				CASE WHEN g.subject_ok THEN mt.facts END AS meeting,
				CASE WHEN g.subject_ok THEN (${networkStatementSql(viewer.plantId)}) END AS statement,
				to_jsonb(k) AS kit
			FROM (SELECT (
				(${subject.personId}::uuid IS NULL AND ${subject.meetingId}::uuid IS NULL AND ${subject.teamId}::uuid IS NULL)
				OR (${subject.personId}::uuid IS NOT NULL AND EXISTS(SELECT FROM person pe
					WHERE pe.id=${subject.personId}::uuid AND pe.tenant_id=${viewer.plantId}::uuid AND pe.state='live'))
				OR (${subject.meetingId}::uuid IS NOT NULL AND EXISTS(SELECT FROM meeting m
					WHERE m.id=${subject.meetingId}::uuid AND m.plant_id=${viewer.plantId}::uuid))
				OR (${subject.teamId}::uuid IS NOT NULL AND EXISTS(SELECT FROM team tm
					WHERE tm.id=${subject.teamId}::uuid AND tm.plant_id=${viewer.plantId}::uuid AND tm.archived_at IS NULL))
			) AS subject_ok) g
			LEFT JOIN plant p ON g.subject_ok AND p.id=${viewer.plantId}::uuid
			LEFT JOIN church_brand_kit k ON g.subject_ok AND k.tenant_id=${viewer.plantId}::uuid
			LEFT JOIN LATERAL (
				SELECT coalesce(l.target_date, l.actual_date)::text AS day FROM launch l
				WHERE l.plant_id=${viewer.plantId}::uuid AND l.status<>'postponed'
			) launch ON g.subject_ok
			LEFT JOIN LATERAL (${subject.meetingId ? meetingFactsSql(viewer.plantId, subject.meetingId) : sql`SELECT NULL::jsonb AS facts`}) mt ON g.subject_ok
		) q ON a.access_live`);
	const row = found.rows[0] as
		| {
				access_live?: unknown;
				subject_ok?: unknown;
				church_name?: unknown;
				pastor_name?: unknown;
				launch_date?: unknown;
				meeting?: unknown;
				statement?: unknown;
				kit?: Record<string, unknown> | null;
		  }
		| undefined;
	if (!row || row.access_live !== true) return { open: false };
	if (row.subject_ok !== true) return { open: true, subjectOk: false };
	return {
		open: true,
		subjectOk: true,
		churchName: asText(row.church_name),
		pastorName: asText(row.pastor_name),
		launchDate: asText(row.launch_date),
		meeting: parseMeeting(row.meeting),
		statement: asText(row.statement),
		kit: row.kit ? dataFromRow(row.kit) : null,
	};
}
