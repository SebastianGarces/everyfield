import * as C from "@everyfield/contracts/organizations";
import { normalizedEmail } from "@everyfield/contracts/identity";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { createHash } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import { readSheet, SheetRefused, type Sheet } from "../people/csv/sheet.ts";
import { eligibleSeat, insertStarters, startersJson } from "./pipeline.ts";
import { answer, one, parse, refuse, seatOf, write, type Executor } from "./seat.ts";

// Importing pipeline people from a CSV or a form's Excel export (T-363) for an Owner or Admin. Columns match fields by
// their title, ignoring case, spacing and punctuation, and an organization remembers the choice made for each title, so
// a reordered or repeated export lines up without choosing again. An answer that matches no field is kept as one note
// on the new person, with the ordinary note audience (REQ-MUL-009); a background-check question is never kept
// (REQ-PPL-002). Possible duplicates by email are the person's to skip or add; nothing is merged and no existing person
// changes (REQ-MUL-017). The server reads the uploaded bytes itself for the preview and again for the import, which
// runs as one write (C88, established): everyone is added or no one is, and a repeat of the same import adds no one.

type Choice = C.PipelineColumnChoice;
type Field = Exclude<Choice, "answer" | "skip">;
type RowProblem = z.infer<typeof C.pipelineImportRowProblem>;

/** A title as it is compared: case, spacing and punctuation removed. */
export const titleKey = (title: string) =>
	title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");

/** The titles each field matches, best first: "Full name" beats a form's own "Name" column. */
const SYNONYMS: Record<Field, string[]> = {
	name: ["fullname", "name", "yourfullname", "yourname", "applicantname", "applicantsname"],
	email: ["emailaddress", "email", "youremailaddress", "youremail"],
	stage: ["stage", "pipelinestage"],
};
const FIELDS = Object.keys(SYNONYMS) as Field[];
const isField = (c: Choice): c is Field => c !== "answer" && c !== "skip";
/** A background-check question (REQ-PPL-002): skipped in every import, never kept or matched. */
const isBackgroundCheck = (key: string) => key.includes("backgroundcheck") || key.includes("backgroundscreening");

/**
 * Each column's choice when the person has not chosen: the organization's remembered choice for the title, else the
 * best title match for each field, else "answer". A field goes to one column only; another column that also names it
 * is skipped, and a column with no title is skipped.
 */
function defaultChoices(header: string[], remembered: Record<string, unknown>): Choice[] {
	const keys = header.map(titleKey);
	const known = keys.map((k) => {
		const r = C.pipelineColumnChoice.safeParse(k ? remembered[k] : undefined);
		return r.success ? r.data : null;
	});
	const choices: (Choice | null)[] = keys.map((k) => (isBackgroundCheck(k) || k === "" ? "skip" : null));
	const taken = new Set<Field>();
	keys.forEach((_, i) => {
		const r = known[i] ?? null;
		if (choices[i] !== null || r === null) return;
		if (isField(r) && taken.has(r)) choices[i] = "skip";
		else {
			choices[i] = r;
			if (isField(r)) taken.add(r);
		}
	});
	for (const field of FIELDS) {
		if (taken.has(field)) continue;
		let best: number | null = null;
		keys.forEach((k, i) => {
			const rank = SYNONYMS[field].indexOf(k);
			if (choices[i] === null && rank >= 0 && (best === null || rank < SYNONYMS[field].indexOf(keys[best]!))) best = i;
		});
		if (best !== null) {
			choices[best] = field;
			taken.add(field);
		}
	}
	return choices.map((c, i) => c ?? (FIELDS.some((f) => SYNONYMS[f].includes(keys[i]!)) ? "skip" : "answer"));
}

/** The person's own choices, checked: one per column, a field on one column at most, a background check skipped. */
function checkedChoices(header: string[], choices: Choice[]): Choice[] {
	if (choices.length !== header.length) refuse({ code: "invalid_input", field: "columns" });
	const seen = new Set<Field>();
	choices.forEach((c, i) => {
		if (isBackgroundCheck(titleKey(header[i]!)) && c !== "skip")
			refuse({ code: "invalid_input", field: `columns.${i}` });
		if (isField(c)) {
			if (seen.has(c)) refuse({ code: "invalid_input", field: `columns.${i}` });
			seen.add(c);
		}
	});
	return choices;
}

type Stage = { id: string; label: string };
type Read = {
	row: number;
	name: string | null;
	email: string | null;
	stageId: string | null;
	body: string | null;
	/** The kept questions' titles, in file order, as their lines in the body read (T-385). */
	questions: string[];
	problems: RowProblem[];
};
const email = normalizedEmail.pipe(z.string().max(320));
/** The kept answers' note body has the ordinary note's length limit. */
const NOTE_MAX = 5000;

/** One data row through the chosen columns. Kept answers become the note body, titled with the file and the day. */
function readRow(
	row: number,
	cells: string[],
	header: string[],
	choices: Choice[],
	stages: Stage[],
	title: string,
): Read {
	const problems: RowProblem[] = [];
	if (cells.slice(header.length).some((v) => v.trim() !== "")) problems.push("column_count");
	const cell = (field: Field) => {
		const i = choices.indexOf(field);
		const v = i < 0 ? "" : (cells[i] ?? "").trim();
		return v === "" ? null : v;
	};
	const name = cell("name");
	if (name === null) problems.push("name_required");
	else if (name.length > 255) problems.push("name_too_long");
	let address = cell("email");
	if (address !== null) {
		const parsed = email.safeParse(address);
		if (parsed.success) address = parsed.data;
		else problems.push("invalid_email");
	}
	const label = cell("stage");
	let stageId: string | null = null;
	if (label !== null) {
		stageId = stages.find((s) => titleKey(s.label) === titleKey(label))?.id ?? null;
		if (stageId === null) problems.push("unknown_stage");
	}
	const kept = choices.flatMap((c, i) => {
		const v = (cells[i] ?? "").trim();
		return c === "answer" && v !== "" ? [{ question: (header[i] || `Column ${i + 1}`).trim(), answer: v }] : [];
	});
	const body = kept.length ? [title, ...kept.map((k) => `${k.question}\n${k.answer}`)].join("\n\n") : null;
	if (body !== null && body.length > NOTE_MAX) problems.push("answers_too_long");
	return {
		row,
		name,
		email: problems.includes("invalid_email") ? null : address,
		stageId,
		body,
		questions: kept.map((k) => k.question),
		problems,
	};
}

type Existing = { id: string; name: string; email: string };
/** The rows with their duplicate findings by email: the pipeline's people, and the file's other rows. */
function review(reads: Read[], existing: Existing[]) {
	const valid = reads.filter((r) => r.problems.length === 0);
	const byEmail = new Map<string, number[]>();
	for (const r of valid) if (r.email) byEmail.set(r.email, [...(byEmail.get(r.email) ?? []), r.row]);
	return reads.map((r) => {
		const ok = r.problems.length === 0;
		const found = ok && r.email ? existing.filter((p) => p.email === r.email) : [];
		const sameAs = ok && r.email ? byEmail.get(r.email)!.filter((n) => n !== r.row) : [];
		const status = !ok ? "invalid" : found.length || sameAs.length ? "duplicate" : "ready";
		return { ...r, status, existing: found.map((p) => ({ personId: p.id, name: p.name })), sameAs } as const;
	});
}
const digestOf = (fileDigest: string, choices: Choice[], rows: ReturnType<typeof review>) =>
	hash({ fileDigest, choices, findings: rows.map((r) => [r.row, r.existing.map((p) => p.personId), r.sameAs]) });

/** The file's table, or the refusal that says why it cannot be read. */
async function sheetOf(fileName: string, file: Uint8Array): Promise<Sheet> {
	try {
		return await readSheet(file, fileName, C.pipelineImportLimits);
	} catch (error) {
		if (error instanceof SheetRefused) refuse({ code: "file_refused", problem: error.problem });
		throw error;
	}
}
/** Every cell that could be an email, for the one statement that finds the pipeline's people who share one. */
const candidates = (sheet: Sheet) => [
	...new Set(sheet.rows.flatMap((r) => r.flatMap((v) => (v.includes("@") ? [v.trim().toLowerCase()] : [])))),
];

/**
 * The organization's live state an import reads, in one statement: its stages (the starters before any is saved), its
 * remembered choices, today as a note title says it, and its live and retired pipeline people with an email the file
 * holds. A removed or merged person is not a duplicate.
 */
const stateRow = z.object({
	allowed: z.boolean(),
	remembered: z.record(z.string(), z.unknown()).nullable(),
	today: z.string().nullable(),
	stages: z.array(z.object({ id: z.string(), label: z.string() })),
	existing: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
});
const stateSql = (
	live: ReturnType<typeof sql>,
	org: string,
	emails: string[],
) => sql`WITH g AS (SELECT ${live} AS allowed),
o AS (SELECT o.pipeline_import_columns AS remembered,
 to_char((clock_timestamp() AT TIME ZONE o.timezone)::date,'FMMon FMDD, YYYY') AS today FROM organization o JOIN g ON g.allowed
 WHERE o.id=${org}::uuid),
st AS (
 SELECT s.id,s.label,s.position FROM pipeline_stage s WHERE s.organization_id=${org}::uuid AND s.removed_at IS NULL
  AND EXISTS(SELECT FROM o)
 UNION ALL
 SELECT x.id,x.label,x.position FROM jsonb_to_recordset(${startersJson(org)}::jsonb) x(id uuid,label text,position int)
  WHERE EXISTS(SELECT FROM o) AND NOT EXISTS(SELECT FROM pipeline_stage s WHERE s.organization_id=${org}::uuid))
SELECT g.allowed,(SELECT remembered FROM o) AS remembered,(SELECT today FROM o) AS today,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',st.id,'label',st.label) ORDER BY st.position,st.label,st.id) FROM st),'[]'::jsonb) AS stages,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'email',lower(btrim(p.email)))
   ORDER BY lower(p.display_name),p.id)
  FROM pipeline_person pp JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id
  WHERE EXISTS(SELECT FROM o) AND pp.organization_id=${org}::uuid AND p.state IN ('live','retired')
   AND lower(btrim(p.email))=ANY(${sql.param(emails)}::text[])
   AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id)),
  '[]'::jsonb) AS existing
FROM g`;

const digestFile = (file: Uint8Array) => createHash("sha256").update(file).digest("hex");
const noteTitle = (fileName: string, today: string) => `Answers from ${fileName}, ${today}`;

/**
 * The preview: each column with its choice (the person's, else the remembered or default match) and each row as ready,
 * invalid with its problems, or a possible duplicate. It writes nothing. Owner or Admin. One statement.
 */
export async function previewPipelineImport(db: Executor, authority: RequestActor, raw: unknown) {
	return answer<C.PipelineImportPreview, C.PipelineImportRefusal>(async () => {
		const seat = seatOf(authority) ?? refuse();
		if (!seat.administrator) refuse();
		const input = parse(C.pipelineImportPreviewRequest, raw);
		const sheet = await sheetOf(input.fileName, input.file);
		const state = stateRow.parse((await db.execute(stateSql(seat.live, seat.organization, candidates(sheet)))).rows[0]);
		if (!state.allowed || state.today === null) refuse();
		const choices = input.columns
			? checkedChoices(sheet.header, input.columns)
			: defaultChoices(sheet.header, state.remembered ?? {});
		const title = noteTitle(input.fileName, state.today!);
		const reads = sheet.rows.map((cells, i) => readRow(i + 1, cells, sheet.header, choices, state.stages, title));
		const rows = review(reads, state.existing);
		const fileDigest = digestFile(input.file);
		return C.pipelineImportPreview.parse({
			fileName: input.fileName,
			fileDigest,
			reviewDigest: digestOf(fileDigest, choices, rows),
			columns: sheet.header.map((t, i) => ({
				title: t,
				choice: choices[i],
				locked: isBackgroundCheck(titleKey(t)),
			})),
			rows: rows.map((r) => ({
				row: r.row,
				status: r.status,
				name: r.name,
				email: r.email,
				stageId: r.stageId,
				problems: r.problems,
				existing: r.existing,
				sameAs: r.sameAs,
			})),
			counts: {
				rows: rows.length,
				ready: rows.filter((r) => r.status === "ready").length,
				invalid: rows.filter((r) => r.status === "invalid").length,
				duplicates: rows.filter((r) => r.status === "duplicate").length,
			},
		});
	});
}

/** An ID fixed by the import and its row, so a repeat of the same import conflicts instead of adding again. */
function derivedId(seed: string) {
	const h = createHash("sha256").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** What the import's own audit row keeps to answer a repeat: its digest and the outcome by row number, no values. */
const stored = z.object({ digest: z.string(), result: C.pipelineImportResult });
/** The most titles an organization remembers; past it, only the latest import's titles are kept. */
const REMEMBERED_MAX = 500;

/**
 * Adds the reviewed rows to the pipeline at the chosen stage (or the stage a Stage column names) with the chosen
 * responsible staff, each with a people.created audit row and a first placement, and one note of kept answers by the
 * importer. A possible duplicate is added only when the person chose "add". Remembers the choice for each column title.
 * Refused when the bytes differ from the reviewed file or the pipeline's duplicate findings changed since the preview.
 * Owner or Admin.
 */
async function importPeople(db: Database, authority: RequestActor, raw: unknown) {
	const seat = seatOf(authority);
	if (!seat?.administrator) return { status: "refused" as const, refusal: { code: "unavailable" as const } };
	const read = await answer<{ input: z.infer<typeof C.pipelineImportRequest>; sheet: Sheet }, C.PipelineImportRefusal>(
		async () => {
			const input = parse(C.pipelineImportRequest, raw);
			const sheet = await sheetOf(input.fileName, input.file);
			if (digestFile(input.file) !== input.fileDigest) refuse({ code: "file_changed" });
			return { input, sheet };
		},
	);
	if (read.status !== "ok") return read;
	const { input, sheet } = read.value;
	return write<C.PipelineImportResult, C.PipelineImportRefusal>(db, authority, true, async (w) => {
		const o = w.organization;
		const command = derivedId(`pipeline-import:${o}:${input.importId}`);
		const choices = checkedChoices(sheet.header, input.columns);
		// The reviewed request without its bytes (the file digest names them): a repeat must match it exactly.
		const digest = hash({
			fileName: input.fileName,
			fileDigest: input.fileDigest,
			reviewDigest: input.reviewDigest,
			columns: input.columns,
			stageId: input.stageId,
			responsibleSeatId: input.responsibleSeatId,
			duplicates: [...input.duplicates].sort((a, b) => a.row - b.row),
		});
		const r = await one(
			w,
			stateRow.extend({ prior: z.unknown(), seat: z.boolean() }),
			sql`WITH s AS (${stateSql(sql`true`, o, candidates(sheet))})
SELECT s.*,(SELECT a.metadata FROM audit_event a WHERE a.id=${command}::uuid AND a.tenant_id=${o}::uuid) AS prior,
 ${eligibleSeat(w, input.responsibleSeatId)} AS seat FROM s`,
		);
		// A repeat of this import answers as the first did and adds no one.
		if (r.prior) {
			const prior = stored.parse(r.prior);
			if (prior.digest !== digest) refuse({ code: "conflict" });
			return prior.result;
		}
		if (!r.stages.some((s) => s.id === input.stageId)) refuse({ code: "invalid_input", field: "stageId" });
		if (!r.seat) refuse({ code: "invalid_input", field: "responsibleSeatId" });
		const title = noteTitle(input.fileName, r.today!);
		const reads = sheet.rows.map((cells, i) => readRow(i + 1, cells, sheet.header, choices, r.stages, title));
		const rows = review(reads, r.existing);
		if (digestOf(input.fileDigest, choices, rows) !== input.reviewDigest) refuse({ code: "review_stale" });
		// Every possible duplicate is decided, and nothing else is.
		const decided = new Map(input.duplicates.map((d) => [d.row, d.choice]));
		const duplicates = rows.filter((x) => x.status === "duplicate");
		if (decided.size !== input.duplicates.length || decided.size !== duplicates.length)
			refuse({ code: "invalid_input", field: "duplicates" });
		if (duplicates.some((x) => !decided.has(x.row))) refuse({ code: "invalid_input", field: "duplicates" });
		const adding = rows.filter((x) => x.status === "ready" || decided.get(x.row) === "add");
		const id = (kind: string, row: number) => derivedId(`pipeline-import:${o}:${input.importId}:${row}:${kind}`);
		const people = adding.map((x) => ({
			row: x.row,
			person: id("person", x.row),
			entry: id("entry", x.row),
			event: id("event", x.row),
			note: x.body === null ? null : id("note", x.row),
			name: x.name,
			email: x.email,
			stage: x.stageId ?? input.stageId,
			body: x.body,
			// A send for review names at most 200 questions of a note (T-385); a note with more cannot be sent.
			questions: x.questions.length && x.questions.length <= 200 ? x.questions : null,
		}));
		const result = C.pipelineImportResult.parse({
			added: people.map((p) => ({ row: p.row, personId: p.person })),
			skipped: duplicates.filter((x) => decided.get(x.row) === "skip").map((x) => x.row),
			refused: rows.filter((x) => x.status === "invalid").map((x) => ({ row: x.row, problems: x.problems })),
		});
		const remembered = Object.fromEntries(
			sheet.header.flatMap((t, i) => {
				const k = titleKey(t);
				return k && !isBackgroundCheck(k) ? [[k, choices[i]]] : [];
			}),
		);
		await w.tx.execute(sql`WITH starters AS (${insertStarters(o)} RETURNING id,label),
dest AS (SELECT id,label FROM pipeline_stage WHERE organization_id=${o}::uuid AND removed_at IS NULL
 UNION ALL SELECT id,label FROM starters),
r AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(people)}::jsonb) r(row int,person uuid,entry uuid,event uuid,
 note uuid,name text,email text,stage uuid,body text,questions text[])),
p AS (INSERT INTO person (id,tenant_id,organization_id,display_name,email,source,created_at,state,revision)
 SELECT r.person,${o}::uuid,${o}::uuid,r.name,r.email,'other',clock_timestamp(),'live',1 FROM r RETURNING id),
pp AS (INSERT INTO pipeline_person (id,organization_id,person_id,stage_id,responsible_seat_id,revision)
 SELECT r.entry,${o}::uuid,p.id,r.stage,${input.responsibleSeatId}::uuid,1 FROM r JOIN p ON p.id=r.person RETURNING id),
a AS (${w.audit({ id: sql`r.event`, action: "people.created", kind: "create", subject: sql`r.person`, after: sql`1`, metadata: { category: "pipeline_import" } })}
 FROM r JOIN p ON p.id=r.person RETURNING id),
m AS (INSERT INTO pipeline_stage_move (id,organization_id,pipeline_person_id,to_stage_id,to_label)
 SELECT a.id,${o}::uuid,r.entry,dest.id,dest.label FROM a JOIN r ON r.event=a.id JOIN pp ON pp.id=r.entry JOIN dest ON dest.id=r.stage RETURNING id),
n AS (INSERT INTO person_note (id,tenant_id,person_id,author_id,body,occurred_at,recorded_at,revision,questions)
 SELECT r.note,${o}::uuid,p.id,${w.actor}::uuid,r.body,clock_timestamp(),clock_timestamp(),1,r.questions FROM r JOIN p ON p.id=r.person
 WHERE r.note IS NOT NULL RETURNING id,person_id),
na AS (${w.audit({ id: sql`gen_random_uuid()`, action: "people.updated", kind: "create", subject: sql`n.person_id`, metadata: sql`jsonb_build_object('category','note','noteId',n.id)` })}
 FROM n RETURNING id),
cols AS (UPDATE organization SET pipeline_import_columns=CASE
  WHEN (SELECT count(*) FROM jsonb_object_keys(pipeline_import_columns||${JSON.stringify(remembered)}::jsonb))>${REMEMBERED_MAX}
  THEN ${JSON.stringify(remembered)}::jsonb ELSE pipeline_import_columns||${JSON.stringify(remembered)}::jsonb END
 WHERE id=${o}::uuid RETURNING id),
c AS (${w.audit({ id: command, action: "people.updated", kind: "edit", subjectType: "command", subject: sql`${o}::uuid`, metadata: { category: "pipeline_import", digest, result } })} RETURNING id)
SELECT (SELECT count(*) FROM m) AS placed,(SELECT count(*) FROM na) AS noted,(SELECT count(*) FROM cols) AS remembered`);
		return result;
	});
}

export const pipelineImportWriter = { importPeople };
