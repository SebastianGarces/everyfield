import * as C from "@everyfield/contracts/organizations";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { csvLine } from "../people/csv/format.ts";
import { answer, one, parse, refuse, seatOf, write, type Executor } from "./seat.ts";

// Taking the pipeline out of Everyfield and removing a person on request (REQ-MUL-005). Only an exact-organization
// Owner or Admin does either. The export is one statement with the live check inside it; it reads no note, move
// reason, feedback body or conversation, nothing from a resident's own account, and a linked resident's milestone marks
// only while they share milestone progress. Removal runs the established way (C88) and keeps only what the
// organization needs without the person: completed enrollments as program completion counts, its activity record with
// values, reasons and actors scrubbed, and the removal record itself.

const NAME = "Former participant";
const COLUMNS = [
	"record",
	"person_id",
	"name",
	"first_name",
	"last_name",
	"email",
	"phone",
	"street",
	"city",
	"state_province",
	"postal_code",
	"country",
	"status",
	"stage",
	"date",
	"from_stage",
	"to_stage",
	"program",
	"program_kind",
	"cohort",
	"started_on",
	"expected_end_on",
	"program_stage",
	"milestone",
] as const;
type Column = (typeof COLUMNS)[number];
const line = (values: Partial<Record<Column, string | null>>) => csvLine(COLUMNS.map((c) => values[c] ?? null));

const text = z.string().nullable();
const exportRow = z.object({
	allowed: z.boolean(),
	org: z.object({ name: z.string(), timezone: z.string(), made: z.string(), day: z.string() }).nullable(),
	programs: z.array(z.object({ name: z.string(), kind: z.string() })),
	people: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			first: text,
			last: text,
			email: text,
			phone: text,
			street: text,
			city: text,
			region: text,
			postal: text,
			country: text,
			state: z.string(),
			stage: z.string(),
			moves: z.array(z.object({ on: z.string(), from: text, to: z.string() })),
			enrollments: z.array(
				z.object({
					program: z.string(),
					kind: z.string(),
					cohort: z.string(),
					status: z.string(),
					started: z.string(),
					expected: z.string(),
					stage: text,
					milestones: z.array(z.object({ title: z.string(), on: z.string() })),
				}),
			),
		}),
	),
});

/**
 * The pipeline as one CSV file: its first lines say whose pipeline it is, when it was made in the organization's time
 * zone, what it holds and what it leaves out; then one row per person, stage move, program, enrollment and milestone
 * completion. Live and retired people; a removed or merged one is not in it. A merged-in record's moves show on the
 * person it was merged into. Owner or Admin. One statement.
 */
export async function readPipelineExport(db: Executor, authority: RequestActor) {
	return answer(async () => {
		const seat = seatOf(authority) ?? refuse();
		if (!seat.administrator) refuse();
		const org = seat.organization;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed),
o AS (SELECT o.name,o.timezone,to_char(clock_timestamp() AT TIME ZONE o.timezone,'YYYY-MM-DD HH24:MI') AS made,
 (clock_timestamp() AT TIME ZONE o.timezone)::date::text AS day FROM organization o JOIN g ON g.allowed WHERE o.id=${org}::uuid),
x AS (SELECT pp.person_id,p.display_name,p.first_name,p.last_name,p.email,p.phone,p.street,p.city,p.state_province,
  p.postal_code,p.country,p.state,s.label AS stage,
  -- A linked resident's milestone marks are their progress: they export only while a current link shares it.
  (NOT EXISTS(SELECT FROM residency_link l WHERE l.person_id=pp.person_id AND l.organization_id=pp.organization_id)
   OR EXISTS(SELECT FROM residency_link l WHERE l.person_id=pp.person_id AND l.organization_id=pp.organization_id
    AND l.ended_at IS NULL AND l.share_milestones)) AS marks
 FROM pipeline_person pp JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id
 JOIN pipeline_stage s ON s.id=pp.stage_id AND s.organization_id=pp.organization_id
 WHERE EXISTS(SELECT FROM o) AND pp.organization_id=${org}::uuid AND p.state IN ('live','retired')
  AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id))
SELECT g.allowed,(SELECT to_jsonb(o) FROM o) AS org,
 coalesce((SELECT jsonb_agg(jsonb_build_object('name',dp.name,'kind',dp.kind) ORDER BY lower(dp.name),dp.id)
  FROM development_program dp WHERE EXISTS(SELECT FROM o) AND dp.organization_id=${org}::uuid),'[]'::jsonb) AS programs,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.person_id,'name',x.display_name,'first',x.first_name,
  'last',x.last_name,'email',x.email,'phone',x.phone,'street',x.street,'city',x.city,'region',x.state_province,
  'postal',x.postal_code,'country',x.country,'state',x.state,'stage',x.stage,
  'moves',coalesce((SELECT jsonb_agg(jsonb_build_object('on',(a.occurred_at AT TIME ZONE o.timezone)::date::text,
    'from',m.from_label,'to',m.to_label) ORDER BY a.occurred_at,a.id)
   FROM pipeline_person mp JOIN person mpp ON mpp.id=mp.person_id AND mpp.tenant_id=mp.organization_id
   JOIN pipeline_stage_move m ON m.pipeline_person_id=mp.id AND m.organization_id=mp.organization_id
   JOIN audit_event a ON a.id=m.id AND a.tenant_id=m.organization_id
   WHERE mp.organization_id=${org}::uuid AND (mpp.id=x.person_id OR mpp.merged_into_person_id=x.person_id)),'[]'::jsonb),
  'enrollments',coalesce((SELECT jsonb_agg(jsonb_build_object('program',dp.name,'kind',dp.kind,'cohort',e.cohort_label,
    'status',e.status,'started',e.started_on::text,'expected',e.expected_end_on::text,'stage',ds.label,
    'milestones',coalesce((SELECT jsonb_agg(jsonb_build_object('title',dm.title,'on',em.completed_on::text)
      ORDER BY em.completed_on,dm.position,dm.id)
     FROM enrollment_milestone em JOIN development_milestone dm ON dm.id=em.milestone_id AND dm.organization_id=em.organization_id
     WHERE x.marks AND em.enrollment_id=e.id AND em.organization_id=e.organization_id),'[]'::jsonb))
    ORDER BY e.started_on,e.id)
   FROM development_enrollment e JOIN development_program dp ON dp.id=e.program_id AND dp.organization_id=e.organization_id
   LEFT JOIN development_stage ds ON ds.id=e.current_stage_id
   WHERE e.organization_id=${org}::uuid AND e.person_id=x.person_id),'[]'::jsonb))
  ORDER BY lower(x.display_name),x.person_id) FROM x CROSS JOIN o),'[]'::jsonb) AS people
FROM g`);
		const row = exportRow.parse(r.rows[0]);
		if (!row.allowed || !row.org) refuse();
		const o = row.org!;
		let body = "";
		for (const p of row.people) {
			const who = { person_id: p.id, name: p.name };
			body += line({
				record: "person",
				...who,
				first_name: p.first,
				last_name: p.last,
				email: p.email,
				phone: p.phone,
				street: p.street,
				city: p.city,
				state_province: p.region,
				postal_code: p.postal,
				country: p.country,
				status: p.state,
				stage: p.stage,
			});
			for (const m of p.moves)
				body += line({ record: "stage_move", ...who, date: m.on, from_stage: m.from, to_stage: m.to });
			for (const e of p.enrollments) {
				const program = { program: e.program, program_kind: e.kind };
				body += line({
					record: "enrollment",
					...who,
					...program,
					status: e.status,
					cohort: e.cohort,
					started_on: e.started,
					expected_end_on: e.expected,
					program_stage: e.stage,
				});
				for (const m of e.milestones)
					body += line({ record: "milestone_completed", ...who, ...program, date: m.on, milestone: m.title });
			}
		}
		const programs = row.programs.map((p) => line({ record: "program", program: p.name, program_kind: p.kind })).join("");
		const preamble =
			csvLine([`${o.name} pipeline export`]) +
			csvLine(["Made", `${o.made} ${o.timezone}`]) +
			csvLine([
				"Contains",
				"Each pipeline person's contact details, stage history, programs, enrollments and milestone completions.",
			]) +
			csvLine([
				"Leaves out",
				"Notes, stage move reasons, conversations, feedback, anything from a resident's own account, and progress a resident does not share.",
			]) +
			"\r\n";
		return C.pipelineExport.parse({
			filename: `pipeline-${o.day}.csv`,
			mediaType: "text/csv; charset=utf-8",
			// The byte order mark lets spreadsheets read UTF-8 names correctly, as the People export does.
			text: "﻿" + preamble + csvLine(COLUMNS) + programs + body,
			people: row.people.length,
		});
	});
}

/**
 * Removes a live or retired pipeline person on their request (REQ-MUL-005). The first statement locks the person at
 * the confirmed revision, writes the removal witness, replaces every contact field and sets the name to "Former
 * participant", unlinks the account, ends any residency link at once and severs it from the account, revokes pending
 * residency invitations and deletes staff notes. The second runs remove_organization_person, which deletes the
 * pipeline rows the runtime role may not, scrubs the person's audit trail, and appends one body-free removal audit row
 * after it. Not retirement: nothing here can be restored. Owner or Admin.
 */
function removePerson(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.removePipelinePersonRequest, raw);
		const o = w.organization;
		const first = await one(
			w,
			z.object({
				found: z.boolean(),
				current: z.string().nullable(),
				removed: z.boolean(),
				notes: z.coerce.number(),
				link: z.boolean(),
				invitations: z.coerce.number(),
			}),
			sql`WITH x AS (SELECT pp.person_id,pp.revision FROM pipeline_person pp JOIN person p ON p.id=pp.person_id
  AND p.tenant_id=pp.organization_id WHERE pp.organization_id=${o}::uuid AND pp.person_id=${input.personId}::uuid
  AND p.state IN ('live','retired')
  AND NOT EXISTS(SELECT FROM organization_person_removal r WHERE r.person_record_id=p.id AND r.organization_id=p.tenant_id)
  FOR UPDATE OF pp,p),
ok AS (SELECT person_id FROM x WHERE x.revision=${input.expectedRevision}::bigint),
wit AS (INSERT INTO organization_person_removal (id,organization_id,person_record_id,removed_at,requested_by,witness_checkpoint,revision)
 SELECT gen_random_uuid(),${o}::uuid,ok.person_id,clock_timestamp(),${w.actor}::uuid,1,1 FROM ok RETURNING person_record_id),
p AS (UPDATE person SET display_name=${NAME},first_name=NULL,last_name=NULL,email=NULL,phone=NULL,street=NULL,city=NULL,
  state_province=NULL,postal_code=NULL,country=NULL,source_details=NULL,notes=NULL,birth_date=NULL,photo_object_id=NULL,
  linked_account_id=NULL,state='retired',retired_at=coalesce(retired_at,clock_timestamp()),revision=revision+1
 FROM wit WHERE person.id=wit.person_record_id AND person.tenant_id=${o}::uuid RETURNING person.id),
cur AS (SELECT l.id,l.ended_at IS NULL AS active FROM residency_link l JOIN ok ON l.person_id=ok.person_id
 WHERE l.organization_id=${o}::uuid AND (l.ended_at IS NULL OR l.account_id IS NOT NULL) FOR UPDATE OF l),
l AS (UPDATE residency_link l SET ended_at=coalesce(l.ended_at,clock_timestamp()),account_id=NULL,share_foundations=false,
  share_milestones=false,consent_revision=l.consent_revision+1,revision=l.revision+1
 FROM cur WHERE l.id=cur.id RETURNING l.id),
mat AS (UPDATE organization SET material_revision=material_revision+1 WHERE id=${o}::uuid AND EXISTS(SELECT FROM cur WHERE cur.active)
 RETURNING id),
i AS (UPDATE invitation SET state='revoked',acted_at=clock_timestamp(),revision=revision+1 FROM ok
 WHERE invitation.tenant_id=${o}::uuid AND invitation.resident_person_id=ok.person_id AND invitation.state='pending'
 RETURNING invitation.id),
n AS (DELETE FROM person_note n USING ok WHERE n.tenant_id=${o}::uuid AND n.person_id=ok.person_id RETURNING n.id)
SELECT EXISTS(SELECT FROM x) AS found,(SELECT revision::text FROM x) AS current,EXISTS(SELECT FROM p) AS removed,
 (SELECT count(*) FROM n) AS notes,EXISTS(SELECT FROM cur WHERE cur.active) AND EXISTS(SELECT FROM l) AS link,
 (SELECT count(*) FROM i) AS invitations`,
		);
		if (!first.found) refuse();
		if (!first.removed) refuse({ code: "conflict" });
		const second = await one(
			w,
			z.object({
				r: z.object({
					stageMoves: z.number(),
					conversations: z.number(),
					milestoneMarks: z.number(),
					feedback: z.number(),
					enrollments: z.number(),
					programCompletions: z.number(),
				}),
			}),
			sql`WITH f AS (SELECT remove_organization_person(${o}::uuid,${input.personId}::uuid) AS r),
a AS (${w.audit({ action: "people.removed", kind: "remove", subject: sql`${input.personId}::uuid`, before: sql`${first.current}` })}
 FROM f RETURNING id)
SELECT f.r FROM f WHERE EXISTS(SELECT FROM a)`,
		);
		const r = second.r;
		return C.pipelineRemovalReport.parse({
			personId: input.personId,
			removed: {
				stageMoves: r.stageMoves,
				notes: first.notes,
				conversations: r.conversations,
				enrollments: r.enrollments,
				milestoneMarks: r.milestoneMarks,
				feedback: r.feedback,
				residencyLinkEnded: first.link,
				invitationsRevoked: first.invitations,
			},
			kept: [
				...(r.programCompletions ? [{ category: "program_completion_count", count: r.programCompletions }] : []),
				{ category: "activity_record", count: null },
				{ category: "removal_record", count: null },
			],
			attribution: NAME,
			retentionDeadline: null,
		});
	});
}

/** The export and removal writes. The statement census measures the removal as `pipeline.removePerson`. */
export const pipelineDataWriter = { removePerson };
