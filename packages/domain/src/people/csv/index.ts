import { owner, requestIdentity, type Owner } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { and, sql, type SQL } from "@everyfield/db/query";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import "server-only";
import { z } from "zod";
import { liveRead, writeVisibility, type RequestActor } from "../../access/session.ts";
import { declareWrite, finishAudit, prepareWrite } from "../../operations/writes.ts";
import {
	authorize,
	deny,
	hash,
	lockOwner,
	parse,
	readReply,
	reply,
	withPeopleWrite,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import { contactSignals, personEmail, personPhone } from "../duplicates.ts";
import { plantId } from "../fields/shared.ts";
import { newPerson } from "../people.ts";
import { peopleFilters } from "../queries.ts";
import { csvLine, parseCsv } from "./format.ts";

// People CSV import (REQ-PPL-018) and export (REQ-PPL-019) for plant Owners and Admins.

/** C13/C32: the request's live access in each statement, without locking its session (live_session). */
const access = (ctx: { session: string; selected: Owner }, admin = false) =>
	liveRead({ session: ctx.session, owner: ctx.selected }, admin);

type ImportColumn = z.infer<typeof c.importColumn>;
type Problem = z.infer<typeof c.rowProblem>;
type Values = z.infer<typeof c.importValues>;
type FileRow =
	| { row: number; status: "valid"; values: Values; email: string | null; phone: string | null }
	| { row: number; status: "invalid"; problems: Problem[] };
type ReadFile = { fileDigest: string; used: ImportColumn[]; ignored: string[]; rows: FileRow[] };

const OPERATION = "people.executeBulkImport";
const media = "text/csv; charset=utf-8";

const fieldColumn: Record<string, ImportColumn | null> = {
	displayName: null,
	firstName: "first_name",
	lastName: "last_name",
	email: "email",
	phone: "phone",
	street: "street",
	city: "city",
	stateProvince: "state",
	postalCode: "postal_code",
	country: "country",
	source: "source",
	sourceDetails: "source_details",
	summaryNotes: "notes",
};
function problemOf(issue: z.core.$ZodIssue): Problem {
	const key = String(issue.path[0]),
		column = fieldColumn[key] ?? null;
	if (key === "displayName" && issue.code === "too_small") return { column, code: "name_required" };
	if (key === "email" && issue.code !== "too_big") return { column, code: "invalid_email" };
	if (key === "source") return { column, code: "invalid_source" };
	return { column, code: "too_long" };
}

/** One data record through the same normalizer and defaults as a Person created by hand. */
function readRow(row: number, header: string[], fields: string[]): FileRow {
	if (fields.length !== header.length)
		return { row, status: "invalid", problems: [{ column: null, code: "column_count" }] };
	const cell = (column: ImportColumn) => {
		const k = header.indexOf(column),
			v = k < 0 ? "" : fields[k]!.trim();
		return v === "" ? null : v;
	};
	const firstName = cell("first_name"),
		lastName = cell("last_name"),
		source = cell("source");
	const parsed = c.createPersonRequest.shape.input.safeParse({
		displayName: [firstName, lastName].filter((v) => v !== null).join(" "),
		firstName,
		lastName,
		email: cell("email"),
		phone: cell("phone"),
		street: cell("street"),
		city: cell("city"),
		stateProvince: cell("state"),
		postalCode: cell("postal_code"),
		country: cell("country"),
		source: source === null ? "other" : source.toLowerCase().replace(/[\s-]+/g, "_"),
		sourceDetails: cell("source_details"),
		summaryNotes: cell("notes"),
	});
	if (!parsed.success) {
		const problems = new Map(parsed.error.issues.map(problemOf).map((p) => [p.column, p]));
		return { row, status: "invalid", problems: [...problems.values()] };
	}
	const values = c.importValues.parse(parsed.data);
	return { row, status: "valid", values, ...contactSignals(values) };
}

/** The uploaded bytes themselves, within the size and row limits, before any database work. */
function readFile(bytes: Uint8Array): ReadFile {
	if (bytes.length > c.importLimits.bytes) deny("file_too_large");
	let text: string;
	try {
		// A leading byte order mark is removed; bytes that are not UTF-8 text are refused.
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		deny("unsupported_file_content");
	}
	if (text.includes("\0")) deny("unsupported_file_content");
	const [header, ...records] = parseCsv(text, c.importLimits.rows + 1);
	const names = (header?.fields ?? []).map((name) => name.trim().toLowerCase());
	const isColumn = (name: string): name is ImportColumn => c.importColumn.safeParse(name).success;
	const used = names.filter(isColumn);
	if (new Set(used).size !== used.length || !used.some((n) => n === "first_name" || n === "last_name"))
		deny("csv_header_invalid");
	return {
		fileDigest: createHash("sha256").update(bytes).digest("hex"),
		used,
		ignored: names.filter((name) => !isColumn(name)),
		rows: records.map((record, i) => readRow(i + 1, names, record.fields)),
	};
}

type Match = { id: string; displayName: string; email: string | null; phone: string };
const match = z.array(
	z.object({ id: z.uuid(), displayName: z.string(), email: z.string().nullable(), phone: z.string() }),
);
/**
 * Live people of this church who share an email or phone with a file row, as one scalar subquery. `unless` skips the
 * search, for an import that already froze its findings.
 */
function existingPeople(plant: string, rows: FileRow[], unless: SQL = sql`false`): SQL {
	const valid = rows.filter((r) => r.status === "valid");
	const emails = valid.flatMap((r) => (r.email ? [r.email] : [])),
		phones = valid.flatMap((r) => (r.phone ? [r.phone] : []));
	return sql`coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'displayName',p.display_name,'email',${personEmail},
 'phone',${personPhone}) ORDER BY p.created_at,p.id) FROM person p
 WHERE NOT ${unless} AND p.plant_id=${plant}::uuid AND p.state='live'
 AND (${personEmail} IN (SELECT unnest(${sql.param(emails)}::text[]))
 OR ${personPhone} IN (SELECT unnest(${sql.param(phones)}::text[])))),'[]'::jsonb)`;
}

type Finding = { existing: Match[]; earlier: number | null };
/** Existing and within-file duplicates per valid row, and the digest that freezes them for the import. */
function findDuplicates(file: ReadFile, people: Match[]) {
	const findings = new Map<number, Finding>(),
		first = new Map<string, number>(),
		known = new Map<string, Match[]>(),
		order = new Map(people.map((p, i) => [p, i]));
	for (const p of people)
		for (const signal of new Set([p.email && "e:" + p.email, p.phone && "p:" + p.phone]))
			if (signal) known.set(signal, [...(known.get(signal) ?? []), p]);
	for (const r of file.rows) {
		if (r.status !== "valid") continue;
		const signals = [r.email && "e:" + r.email, r.phone && "p:" + r.phone].filter((s) => !!s) as string[];
		// Each existing Person once, in search order.
		const existing = [...new Set(signals.flatMap((s) => known.get(s) ?? []))].sort(
			(a, b) => order.get(a)! - order.get(b)!,
		);
		const earlier = signals.flatMap((s) => (first.has(s) ? [first.get(s)!] : []));
		findings.set(r.row, { existing, earlier: earlier.length ? Math.min(...earlier) : null });
		for (const s of signals) if (!first.has(s)) first.set(s, r.row);
	}
	const reviewDigest = hash({
		fileDigest: file.fileDigest,
		findings: [...findings].map(([row, f]) => [row, f.existing.map((p) => p.id), f.earlier]),
	});
	return { findings, reviewDigest };
}

/** A stable Person ID for one import row, so a retried row conflicts with its earlier success instead of repeating it. */
function rowPersonId(importId: string, row: number): string {
	const h = createHash("sha256").update(`${importId}/${row}`).digest("hex");
	const variant = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The frozen import intent: what happens to every row. A retry resumes it instead of reading new choices. */
const savedPlan = z.object({
	rows: z.int(),
	skip: z.array(z.int()),
	invalid: z.array(z.object({ row: z.int(), problems: z.array(c.rowProblem) })),
	create: z.array(z.object({ row: z.int(), reviewWith: z.uuid().nullable() })),
});
type Plan = z.infer<typeof savedPlan>;
/** The reviewed choices: every valid row exactly once, and a review pair only where a duplicate exists. */
function planImport(
	file: ReadFile,
	findings: Map<number, Finding>,
	choices: z.infer<typeof c.executeBulkImportRequest>["choices"],
	importId: string,
): Plan {
	const byRow = new Map(choices.map((choice) => [choice.row, choice.choice]));
	const valid = file.rows.filter((r) => r.status === "valid");
	if (byRow.size !== choices.length || byRow.size !== valid.length || valid.some((r) => !byRow.has(r.row)))
		deny("invalid_input");
	const plan: Plan = { rows: file.rows.length, skip: [], invalid: [], create: [] };
	for (const r of file.rows) {
		if (r.status === "invalid") {
			plan.invalid.push({ row: r.row, problems: r.problems });
			continue;
		}
		const choice = byRow.get(r.row)!;
		if (choice === "skip") {
			plan.skip.push(r.row);
			continue;
		}
		const finding = findings.get(r.row)!;
		const earlier =
			finding.earlier !== null && byRow.get(finding.earlier) !== "skip" ? rowPersonId(importId, finding.earlier) : null;
		const reviewWith = choice === "create_and_review" ? (finding.existing[0]?.id ?? earlier) : null;
		if (choice === "create_and_review" && !reviewWith) deny("invalid_input");
		plan.create.push({ row: r.row, reviewWith });
	}
	return plan;
}

/** Absent keys load as NULL, so empty values stay out of the JSON a statement sends. */
const dropNulls = (_key: string, value: unknown) => (value === null ? undefined : value);

type Created = Map<number, { personId: string; reviewWith: string | null }>;
type Failed = Map<number, "row_write_failed">;
/** Every row's outcome from the saved plan, the rows whose Person exists and the rows the job could not write. */
function receipt(importId: string, plan: Plan, created: Created, failed: Failed, running: boolean) {
	const outcomes = new Map<number, unknown>();
	for (const row of plan.skip) outcomes.set(row, { row, status: "skipped" });
	for (const { row, problems } of plan.invalid)
		outcomes.set(row, { row, status: "failed", reason: "invalid", problems });
	const remaining: number[] = [];
	for (const { row } of plan.create) {
		const done = created.get(row);
		if (done) outcomes.set(row, { row, status: "created", ...done });
		else {
			remaining.push(row);
			const reason = failed.get(row);
			outcomes.set(row, reason ? { row, status: "failed", reason, problems: [] } : { row, status: "remaining" });
		}
	}
	const writeFailures = remaining.filter((row) => failed.has(row)).length;
	return c.importReceipt.parse({
		importId,
		status: running ? "in_progress" : remaining.length ? "partial" : "complete",
		rows: [...outcomes].sort(([a], [b]) => a - b).map(([, outcome]) => outcome),
		remaining,
		counts: {
			created: created.size,
			skipped: plan.skip.length,
			failed: plan.invalid.length + writeFailures,
			remaining: remaining.length,
		},
	});
}

/**
 * An import's saved state in one scalar subquery: the frozen plan, whether its job still runs, the rows the job could
 * not write and the rows created so far, from their people.created audit rows.
 */
const importState = (importId: SQL) => sql`(SELECT jsonb_build_object('plan',sp.plan,
 'running',sj.state IN ('ready','claimed','retry_wait'),'failed',sp.failed,
 'created',coalesce((SELECT jsonb_agg(jsonb_build_object('row',(e.metadata->'import'->>'row')::int,'personId',e.subject_id,
  'reviewWith',e.metadata->'import'->'reviewWith')) FROM audit_event e WHERE e.command_id=si.id AND e.action='people.created'),'[]'::jsonb))
 FROM audit_event si JOIN person_import sp ON sp.id=si.id JOIN job sj ON sj.id=sp.job_id WHERE si.id=${importId})`;
const savedState = z.object({
	plan: z.unknown(),
	running: z.boolean(),
	failed: z.array(z.object({ row: z.int(), reason: z.literal("row_write_failed") })),
	created: z.array(z.object({ row: z.int(), personId: z.uuid(), reviewWith: z.uuid().nullable() })),
});
function loadState(raw: unknown) {
	const state = savedState.parse(raw);
	return {
		plan: savedPlan.parse(state.plan),
		created: new Map(state.created.map((r) => [r.row, { personId: r.personId, reviewWith: r.reviewWith }])) as Created,
		failed: new Map(state.failed.map((f) => [f.row, f.reason])) as Failed,
		running: state.running,
	};
}

/**
 * Save the reviewed rows and queue the job that writes them, and return at once. The bytes are read before any
 * database work. The save is a People write (D70): the gate holds the importer's Owner/Admin seat until COMMIT, and
 * the shared request key answers a repeat. Repeating the request returns the import's current receipt; after a
 * partial import it queues the job again for the remaining rows.
 */
export async function executeBulkImport(db: Database, authority: RequestActor, raw: unknown) {
	const read = await readReply(async () => {
		const input = parse(c.executeBulkImportRequest, raw);
		const file = readFile(input.file);
		if (file.fileDigest !== input.fileDigest) deny("file_changed");
		return { input, file };
	});
	if (read.status !== "ok") return read;
	const { input, file } = read.value;
	return withPeopleWrite(db, authority, (tx, ctx) => reply(tx, () => saveImport(tx, ctx, input, file)));
}

async function saveImport(
	tx: Tx,
	ctx: WriteContext,
	input: z.infer<typeof c.executeBulkImportRequest>,
	file: ReadFile,
) {
	const plant = plantId(ctx);
	// The duplicate findings read the church's other people: the save runs in the gate's transaction (C88).
	await declareWrite(tx, "established");
	await lockOwner(tx, ctx);
	const actorId = (await authorize(tx, ctx, true)).accountId;
	const choices = [...input.choices].sort((a, b) => a.row - b.row);
	const identity = requestIdentity.parse({
		owner: ctx.selected,
		actorId,
		operation: OPERATION,
		requestKey: input.requestKey,
		digest: hash({ reviewDigest: input.reviewDigest, choices }),
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "conflict") deny("review_digest_conflict");
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "replay") return resumeImport(tx, claim.id);
	const people = match.parse(
		(await tx.execute(sql`SELECT ${existingPeople(plant, file.rows)} AS people`)).rows[0]?.people,
	);
	const { findings, reviewDigest } = findDuplicates(file, people);
	// The church's people may have changed since the preview; the review is only valid against today's findings.
	if (reviewDigest !== input.reviewDigest) deny("review_stale");
	const importId = claim.id,
		jobId = randomUUID();
	const plan = planImport(file, findings, choices, importId);
	// The job keeps the exact reviewed bytes, compressed; it parses them again rather than trusting saved rows.
	const upload = gzipSync(input.file).toString("base64");
	claim.events.push({
		id: importId,
		tenant_id: plant,
		actor_id: actorId,
		actor_token: hash([plant, actorId]),
		action: "people.updated",
		kind: "edit",
		subject_type: "command",
		subject_id: plant,
	});
	claim.writes.push(
		sql`INSERT INTO job(id,tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
 VALUES(${jobId}::uuid,${plant}::uuid,'people_import',${plant}::uuid,${"people-import/" + importId},'ready',clock_timestamp(),0,4,0)`,
		sql`INSERT INTO person_import(id,tenant_id,job_id,actor_id,plan,upload)
 VALUES(${importId}::uuid,${plant}::uuid,${jobId}::uuid,${actorId}::uuid,${JSON.stringify(plan)}::jsonb,${upload})`,
	);
	const answer = receipt(importId, plan, new Map(), new Map(), true);
	// The intent, the job and its payload in one statement with the audit row and its request key.
	await finishAudit(tx, claim, identity, answer);
	return answer;
}

/** A repeated import request: the import's current receipt, and a partial import queued again for its remaining rows. */
async function resumeImport(tx: Tx, importId: string) {
	const prior = loadState(
		z
			.object({ state: z.unknown() })
			.parse((await tx.execute(sql`SELECT ${importState(sql`${importId}::uuid`)} AS state`)).rows[0]).state,
	);
	const answer = receipt(importId, prior.plan, prior.created, prior.failed, prior.running);
	if (answer.status !== "partial") return answer;
	// Its last failures clear until the job reports again.
	await tx.execute(sql`WITH imported AS (UPDATE person_import SET failed='[]'::jsonb WHERE id=${importId}::uuid RETURNING job_id)
 UPDATE job SET state='ready',eligible_at=clock_timestamp(),next_attempt_at=NULL,attempt_count=0,error_code=NULL,
  finished_at=NULL,revision=revision+1 FROM imported WHERE job.id=imported.job_id AND job.state IN ('succeeded','failed')`);
	return receipt(importId, prior.plan, prior.created, new Map(), true);
}

/** The importing account's current Owner/Admin seat in this church, for a worker that has no request session. */
function actorAuthority(actorId: string, church: Owner): SQL {
	return sql`EXISTS(SELECT FROM seat s JOIN account acc ON acc.id=s.account_id WHERE s.account_id=${actorId}::uuid
 AND acc.registration_state='active' AND s.plant_id=${church.id}::uuid AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
 AND s.role<>'member' AND ${writeVisibility(actorId, church)})`;
}
/** The worker's claim is still the job's current lease. */
type Lease = { id: string; tenant_id: string; lease_owner: string; claim_generation: string };
const holds = (lease: Lease) => sql`EXISTS(SELECT FROM job WHERE id=${lease.id}::uuid AND state='claimed'
 AND lease_owner=${lease.lease_owner} AND claim_generation=${lease.claim_generation}::bigint AND lease_until>clock_timestamp())`;

type SavedRow = { row: number; reviewWith: string | null; values: Values };
/**
 * One batch in one statement: the lease and the importer's live Owner/Admin seat, the new people, one people.created
 * audit row each tied to the import, and the pipeline and church revisions. A Person an earlier run wrote is left alone.
 */
async function writeBatch(db: Database, lease: Lease, actorId: string, importId: string, batch: SavedRow[]) {
	const plant = lease.tenant_id,
		church = owner.parse({ kind: "plant", id: plant }),
		start = Date.now();
	// Rows keep file order in the directory: each is recorded one millisecond after the one before it.
	const people = batch.map((r, i) =>
		newPerson({ selected: church }, r.values, null, rowPersonId(importId, r.row), new Date(start + i)),
	);
	const links = batch.map((r, i) => ({ id: people[i]!.id, row: r.row, review_with: r.reviewWith }));
	const result =
		await db.execute(sql`WITH allowed AS (SELECT ${holds(lease)} AND ${actorAuthority(actorId, church)} AS ok),
 created AS (INSERT INTO person SELECT * FROM jsonb_populate_recordset(NULL::person,${JSON.stringify(people, dropNulls)}::jsonb)
  WHERE (SELECT ok FROM allowed) ON CONFLICT (id) DO NOTHING RETURNING id,stage),
 audit AS (INSERT INTO audit_event(tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,after_revision,after_value,command_id,metadata)
  SELECT ${plant}::uuid,${actorId}::uuid,${hash([plant, actorId])},'people.created','create','person',p.id,1,
  jsonb_build_object('stage',p.stage),${importId}::uuid,
  jsonb_build_object('import',jsonb_strip_nulls(jsonb_build_object('row',l.row,'reviewWith',l.review_with)))
  FROM created p JOIN jsonb_to_recordset(${JSON.stringify(links)}::jsonb) l(id uuid,row int,review_with uuid) ON l.id=p.id),
 pipeline AS (INSERT INTO people_column(plant_id,column_name,revision) SELECT ${plant}::uuid,'prospect',2 WHERE EXISTS(SELECT FROM created)
  ON CONFLICT (plant_id,column_name) DO UPDATE SET revision=people_column.revision+1),
 church AS (UPDATE plant SET material_revision=material_revision+1 WHERE id=${plant}::uuid AND EXISTS(SELECT FROM created))
 SELECT ok FROM allowed`);
	return z.boolean().parse(result.rows[0]?.ok);
}

/** Rows each import statement writes. Statements grow with batches, and with failures only while a batch is split. */
const BATCH = 500;
/**
 * Why the database refused a row's values: a data exception (22), a constraint (23) or a trigger's raise (P0). Any
 * other error, such as a lost connection or a serialization failure, is not the row's own: null.
 */
function rowFailure(error: unknown) {
	const cause = z
		.object({ cause: z.object({ code: z.string().regex(/^(22|23|P0)/), constraint: z.string().optional() }) })
		.safeParse(error);
	return cause.success ? { code: cause.data.cause.code, constraint: cause.data.cause.constraint ?? null } : null;
}
type FailedRow = { row: number; reason: "row_write_failed"; code: string; constraint: string | null };
/**
 * The people_import job: write every remaining reviewed row in batches of one statement each. A batch the database
 * refuses for a row's values is split in halves until each failing row stands alone, so one bad row never fails its
 * neighbours; the run saves each failed row with the database's code and constraint, never its values. Any other error
 * ends the run with the rows still remaining, for the job to try again. Failed rows are saved during the run, so a
 * resumed run starts after every row already created or failed. The run ends by saving the failed rows, or by clearing
 * the payload when every row exists. "lost" means the lease or the importer's authority ended; nothing more
 * was written.
 */
export async function runPeopleImport(db: Database, lease: Lease): Promise<"succeeded" | "lost"> {
	const loaded = z
		.object({
			id: z.uuid(),
			actor_id: z.uuid().nullable(),
			upload: z.string().nullable(),
			plan: z.unknown(),
			created: z.array(z.int()),
			failed: z.array(
				z.object({
					row: z.int(),
					reason: z.literal("row_write_failed"),
					code: z.string(),
					constraint: z.string().nullable(),
				}),
			),
		})
		.optional()
		.parse(
			(
				await db.execute(sql`SELECT pi.id,pi.actor_id,pi.upload,pi.plan,pi.failed,
 coalesce((SELECT jsonb_agg((e.metadata->'import'->>'row')::int) FROM audit_event e
  WHERE e.command_id=pi.id AND e.action='people.created'),'[]'::jsonb) AS created
 FROM person_import pi WHERE pi.job_id=${lease.id}::uuid AND pi.tenant_id=${lease.tenant_id}::uuid`)
			).rows[0],
		);
	if (!loaded?.upload) return "succeeded";
	// Account purge cleared the importer: nobody holds authority for the remaining rows.
	const actorId = loaded.actor_id;
	if (!actorId) return "lost";
	const file = readFile(gunzipSync(Buffer.from(loaded.upload, "base64")));
	const values = new Map(file.rows.flatMap((r) => (r.status === "valid" ? [[r.row, r.values] as const] : [])));
	// Rows an earlier run created or saved as failed are done, so a stopped run's retry moves past them.
	const done = new Set([...loaded.created, ...loaded.failed.map((f) => f.row)]);
	const pending: SavedRow[] = savedPlan
		.parse(loaded.plan)
		.create.filter((r) => !done.has(r.row))
		.map((r) => ({ ...r, values: values.get(r.row)! }));
	const failed: FailedRow[] = [...loaded.failed];
	let lost = false;
	// Failed rows are saved at least every 10 s while a batch is split, and saved progress starts a fresh retry budget,
	// as scanPage does: a run the platform stops never repeats saved rows, so even a file whose rows all fail finishes.
	let saved = failed.length,
		savedAt = Date.now();
	const save = async () => {
		const r = await db.execute(sql`WITH saved AS (
 UPDATE person_import SET failed=${JSON.stringify(failed)}::jsonb WHERE id=${loaded.id}::uuid AND ${holds(lease)} RETURNING id)
 UPDATE job SET attempt_count=0,revision=revision+1 WHERE id=${lease.id}::uuid AND EXISTS(SELECT FROM saved) RETURNING id`);
		if (!r.rows.length) lost = true;
		saved = failed.length;
		savedAt = Date.now();
	};
	const write = async (batch: SavedRow[]): Promise<void> => {
		if (lost || !batch.length) return;
		try {
			if (!(await writeBatch(db, lease, actorId, loaded.id, batch))) lost = true;
		} catch (error) {
			const why = rowFailure(error);
			if (!why) throw error;
			if (batch.length === 1) {
				failed.push({ row: batch[0]!.row, reason: "row_write_failed", ...why });
				if (Date.now() - savedAt > 10_000) await save();
			} else {
				const half = Math.ceil(batch.length / 2);
				await write(batch.slice(0, half));
				await write(batch.slice(half));
			}
		}
	};
	for (let i = 0; i < pending.length && !lost; i += BATCH) {
		await write(pending.slice(i, i + BATCH));
		if (!lost && failed.length > saved && i + BATCH < pending.length) await save();
	}
	if (lost) return "lost";
	const finished = await db.execute(sql`UPDATE person_import SET
 failed=${JSON.stringify(failed)}::jsonb,
 upload=CASE WHEN ${failed.length === 0} THEN NULL ELSE upload END
 WHERE id=${loaded.id}::uuid AND ${holds(lease)} RETURNING id`);
	return finished.rows.length ? "succeeded" : "lost";
}

export const peopleCsv = {
	/** The 12 import columns, header only. It holds no church data. */
	generateCsvTemplate() {
		return c.csvFile.parse({
			filename: "people-import-template.csv",
			mediaType: media,
			text: csvLine(c.importColumns),
		});
	},
	/** Read the file and show every row's outcome and duplicates. It writes nothing. */
	async previewImport(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const file = readFile(parse(c.previewImportRequest, raw).file);
			const state = z
				.object({ allowed: z.boolean(), people: match })
				.parse(
					(await tx.execute(sql`SELECT ${access(ctx, true)} AS allowed, ${existingPeople(plant, file.rows)} AS people`))
						.rows[0],
				);
			if (!state.allowed) deny();
			const { findings, reviewDigest } = findDuplicates(file, state.people);
			const rows = file.rows.map((r) => {
				if (r.status === "invalid") return r;
				const f = findings.get(r.row)!;
				return {
					row: r.row,
					status: r.status,
					values: r.values,
					existingDuplicates: f.existing.map((p) => ({ personId: p.id, displayName: p.displayName })),
					withinFileDuplicateOf: f.earlier,
					suggested: f.existing.length || f.earlier !== null ? "skip" : "create",
				};
			});
			const valid = rows.flatMap((r) => (r.status === "valid" && "existingDuplicates" in r ? [r] : []));
			return c.importPreview.parse({
				fileDigest: file.fileDigest,
				reviewDigest,
				columns: { used: file.used, ignored: file.ignored },
				rows,
				counts: {
					rows: rows.length,
					valid: valid.length,
					invalid: rows.length - valid.length,
					existingDuplicates: valid.filter((r) => r.existingDuplicates.length).length,
					withinFileDuplicates: valid.filter((r) => r.withinFileDuplicateOf !== null).length,
				},
			});
		});
	},
	/** The import's outcome for each row, read again after a lost reply or while its job runs. */
	async getImportReceipt(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(c.importReceiptRequest, raw);
			const row = z.object({ allowed: z.boolean(), id: z.uuid().nullable(), state: z.unknown() }).parse(
				(
					await tx.execute(sql`SELECT ${access(ctx, true)} AS allowed, a.id, ${importState(sql`a.id`)} AS state
 FROM (SELECT 1) seed LEFT JOIN audit_event a ON a.tenant_id=${plant}::uuid AND a.request_key=${input.requestKey}
  AND a.request_identity->>'operation'=${OPERATION}`)
				).rows[0],
			);
			if (!row.allowed || !row.id || !row.state) deny();
			const saved = loadState(row.state);
			return receipt(row.id, saved.plan, saved.created, saved.failed, saved.running);
		});
	},
	/**
	 * The directory's filtered people as formula-safe CSV, every matching row in one statement, with the exact filters and
	 * counts. Members may export what the directory shows them.
	 */
	async exportPeople(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			plantId(ctx);
			const filters = parse(c.exportPeopleRequest, raw);
			const result = await tx.execute(sql`SELECT ${access(ctx)} AS allowed,
 coalesce((SELECT jsonb_agg(jsonb_build_array(first_name,last_name,email,phone,street,city,state_province,postal_code,
  country,stage,source,source_details,notes,tags,created) ORDER BY created_at,id) FROM (
  SELECT person.*,to_char(person.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
  (SELECT string_agg(t.name,';' ORDER BY lower(t.name),t.id) FROM person_tag pt JOIN tag t ON t.id=pt.tag_id
   AND t.plant_id=pt.plant_id WHERE pt.person_id=person.id AND pt.plant_id=person.plant_id) AS tags
  FROM person WHERE ${and(...peopleFilters(ctx, filters, access(ctx)))}) x),'[]'::jsonb) AS rows`);
			const state = z
				.object({ allowed: z.boolean(), rows: z.array(z.array(z.string().nullable())) })
				.parse(result.rows[0]);
			if (!state.allowed) deny();
			return c.peopleExport.parse({
				filename: `people-${new Date().toISOString().slice(0, 10)}.csv`,
				mediaType: media,
				// The byte order mark lets spreadsheets read the UTF-8 names correctly.
				text: "\ufeff" + csvLine(c.exportColumns) + state.rows.map(csvLine).join(""),
				receipt: { filters, matched: state.rows.length, returned: state.rows.length, completeness: "complete" },
			});
		});
	},
};
