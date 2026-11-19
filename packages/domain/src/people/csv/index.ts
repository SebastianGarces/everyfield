import { owner, requestIdentity, type Owner } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { and, sql, type SQL } from "@everyfield/db/query";
import { readPrivateUpload, signPrivatePut, type PrivateStorage } from "@everyfield/db/schema";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import "server-only";
import { z } from "zod";
import { liveRead, writeVisibility, type RequestActor } from "../../access/session.ts";
import { declareWrite, finishAudit, prepareWrite, gatedTransaction } from "../../operations/writes.ts";
import {
	authorize,
	authorizeCachedWrite,
	deny,
	hash,
	lockOwner,
	parse,
	PeopleReadContext,
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

function readFile(bytes: Uint8Array): ReadFile {
	if (bytes.length > c.importLimits.bytes) deny("file_too_large");
	let text: string;
	try {
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

function rowPersonId(importId: string, row: number): string {
	const h = createHash("sha256").update(`${importId}/${row}`).digest("hex");
	const variant = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const savedPlan = z.object({
	fileDigest: z.string().optional(),
	rows: z.int(),
	skip: z.array(z.int()),
	invalid: z.array(z.object({ row: z.int(), problems: z.array(c.rowProblem) })),
	create: z.array(z.object({ row: z.int(), reviewWith: z.uuid().nullable() })),
});
type Plan = z.infer<typeof savedPlan>;
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
	const plan: Plan = { fileDigest: file.fileDigest, rows: file.rows.length, skip: [], invalid: [], create: [] };
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

const dropNulls = (_key: string, value: unknown) => (value === null ? undefined : value);

type Created = Map<number, { personId: string; reviewWith: string | null }>;
type Failed = Map<number, "row_write_failed">;
function receipt(importId: string, plan: Plan, created: Created, failed: Failed, running: boolean, kept: boolean) {
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
		fileKept: kept,
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

const importState = (importId: SQL) => sql`(SELECT jsonb_build_object('plan',sp.plan,
 'running',sj.state IN ('ready','claimed','retry_wait'),'kept',sp.upload IS NOT NULL,'failed',sp.failed,
 'created',coalesce((SELECT jsonb_agg(jsonb_build_object('row',(e.metadata->'import'->>'row')::int,'personId',e.subject_id,
  'reviewWith',e.metadata->'import'->'reviewWith')) FROM audit_event e WHERE e.command_id=si.id AND e.action='people.created'),'[]'::jsonb))
 FROM audit_event si JOIN person_import sp ON sp.id=si.id JOIN job sj ON sj.id=sp.job_id WHERE si.id=${importId})`;
const savedState = z.object({
	plan: z.unknown(),
	running: z.boolean(),
	kept: z.boolean(),
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
		kept: state.kept,
	};
}
const receiptOf = (importId: string, s: ReturnType<typeof loadState>) =>
	receipt(importId, s.plan, s.created, s.failed, s.running, s.kept);

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
	if (claim.kind === "replay") return receiptOf(claim.id, await stateOf(tx, sql`${claim.id}::uuid`));
	const people = match.parse(
		(await tx.execute(sql`SELECT ${existingPeople(plant, file.rows)} AS people`)).rows[0]?.people,
	);
	const { findings, reviewDigest } = findDuplicates(file, people);
	if (reviewDigest !== input.reviewDigest) deny("review_stale");
	const importId = claim.id,
		jobId = randomUUID();
	const plan = planImport(file, findings, choices, importId);
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
	const answer = receipt(importId, plan, new Map(), new Map(), true, true);
	await finishAudit(tx, claim, identity, answer);
	return answer;
}

async function stateOf(tx: Tx, importId: SQL) {
	return loadState(
		z.object({ state: z.unknown() }).parse((await tx.execute(sql`SELECT ${importState(importId)} AS state`)).rows[0])
			.state,
	);
}

export async function retryStoredImport(db: Database, storage: PrivateStorage, authority: RequestActor, raw: unknown) {
	const loaded = await readReply(async () => {
		const ctx = new PeopleReadContext(authority);
		authorizeCachedWrite(ctx);
		const { requestKey, uploadId } = parse(c.retryImportRequest, raw);
		return { requestKey, file: uploadId ? await storedFile(db, storage, ctx, uploadId) : null };
	});
	if (loaded.status !== "ok") return loaded;
	const { requestKey, file } = loaded.value;
	return withPeopleWrite(db, authority, (tx, ctx) => reply(tx, () => retryImport(tx, ctx, requestKey, file)));
}

async function retryImport(tx: Tx, ctx: WriteContext, requestKey: string, file: Uint8Array | null) {
	const plant = plantId(ctx);
	await declareWrite(tx, "established");
	await lockOwner(tx, ctx);
	const actorId = (await authorize(tx, ctx, true)).accountId;
	const found = z.object({ id: z.uuid().nullable(), state: z.unknown() }).parse(
		(
			await tx.execute(sql`SELECT a.id, ${importState(sql`a.id`)} AS state FROM (SELECT 1) seed
 LEFT JOIN audit_event a ON a.tenant_id=${plant}::uuid AND a.request_key=${requestKey} AND a.request_identity->>'operation'=${OPERATION}`)
		).rows[0],
	);
	if (!found.id || !found.state) deny();
	const prior = loadState(found.state);
	const answer = receiptOf(found.id, prior);
	if (answer.status !== "partial") return answer;
	if (file && createHash("sha256").update(file).digest("hex") !== prior.plan.fileDigest) deny("import_file_mismatch");
	const upload = file ? gzipSync(file).toString("base64") : null;
	const queued = await tx.execute(sql`WITH imported AS (UPDATE person_import SET failed='[]'::jsonb,
  upload=coalesce(${upload}::text,upload),actor_id=${actorId}::uuid
  WHERE id=${found.id}::uuid AND coalesce(${upload}::text,upload) IS NOT NULL RETURNING job_id)
 UPDATE job SET state='ready',eligible_at=clock_timestamp(),next_attempt_at=NULL,attempt_count=0,error_code=NULL,
  finished_at=NULL,revision=revision+1 FROM imported WHERE job.id=imported.job_id AND job.state IN ('succeeded','failed')
 RETURNING job.id`);
	if (!queued.rows.length) deny("import_file_expired");
	return receipt(found.id, prior.plan, prior.created, new Map(), true, true);
}

export async function deleteExpiredImportFiles(db: Database): Promise<number> {
	const result = await db.execute(sql`UPDATE person_import SET upload=NULL WHERE id IN (
 SELECT pi.id FROM person_import pi JOIN job j ON j.id=pi.job_id AND j.tenant_id=pi.tenant_id
 WHERE pi.upload IS NOT NULL AND j.state NOT IN ('ready','claimed','retry_wait')
  AND j.finished_at<=clock_timestamp()-make_interval(days=>${c.importFileKeptDays})
 LIMIT 500 FOR UPDATE OF pi SKIP LOCKED) RETURNING id`);
	return result.rows.length;
}

function actorAuthority(actorId: string, church: Owner): SQL {
	return sql`EXISTS(SELECT FROM seat s JOIN account acc ON acc.id=s.account_id WHERE s.account_id=${actorId}::uuid
 AND acc.registration_state='active' AND s.plant_id=${church.id}::uuid AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
 AND s.role<>'member' AND ${writeVisibility(actorId, church)})`;
}
type Lease = { id: string; tenant_id: string; lease_owner: string; claim_generation: string };
const holds = (lease: Lease) => sql`EXISTS(SELECT FROM job WHERE id=${lease.id}::uuid AND state='claimed'
 AND lease_owner=${lease.lease_owner} AND claim_generation=${lease.claim_generation}::bigint AND lease_until>clock_timestamp())`;

type SavedRow = { row: number; reviewWith: string | null; values: Values };
async function writeBatch(
	db: Database,
	lease: Lease,
	actorId: string,
	importId: string,
	batch: SavedRow[],
	clock: { next: number },
) {
	const plant = lease.tenant_id,
		church = owner.parse({ kind: "plant", id: plant }),
		start = Math.max(Date.now(), clock.next);
	clock.next = start + batch.length;
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

const BATCH = 500;
function rowFailure(error: unknown) {
	const cause = z
		.object({ cause: z.object({ code: z.string().regex(/^(22|23|P0)/), constraint: z.string().optional() }) })
		.safeParse(error);
	return cause.success ? { code: cause.data.cause.code, constraint: cause.data.cause.constraint ?? null } : null;
}
type FailedRow = { row: number; reason: "row_write_failed"; code: string; constraint: string | null };
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
	const actorId = loaded.actor_id;
	if (!actorId) return "lost";
	const file = readFile(gunzipSync(Buffer.from(loaded.upload, "base64")));
	const values = new Map(file.rows.flatMap((r) => (r.status === "valid" ? [[r.row, r.values] as const] : [])));
	const done = new Set([...loaded.created, ...loaded.failed.map((f) => f.row)]);
	const pending: SavedRow[] = savedPlan
		.parse(loaded.plan)
		.create.filter((r) => !done.has(r.row))
		.map((r) => ({ ...r, values: values.get(r.row)! }));
	const failed: FailedRow[] = [...loaded.failed];
	let lost = false;
	const clock = { next: 0 };
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
			if (!(await writeBatch(db, lease, actorId, loaded.id, batch, clock))) lost = true;
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

const uploadKey = (plant: string, uploadId: string) => `private/${plant}/${uploadId}`;
export async function signPeopleImport(db: Database, storage: PrivateStorage, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const ctx = new PeopleReadContext(authority);
		authorizeCachedWrite(ctx);
		const plant = plantId(ctx);
		const declared = (raw as { byteLength?: unknown } | null)?.byteLength;
		if (typeof declared === "number" && declared > c.importLimits.bytes) deny("file_too_large");
		const input = parse(c.signImportUploadRequest, raw);
		const id = randomUUID();
		const key = uploadKey(plant, id);
		const result = await db.execute(sql`WITH upload AS (
 INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
 SELECT ${id}::uuid,${plant}::uuid,'native_import',${key}::text,'text/csv',${String(input.byteLength)}::bigint,
  'pending',${"people-import/" + id}::text,0,clock_timestamp()+interval '1 hour'
 WHERE ${access(ctx, true)}
 RETURNING id,expires_at), cleanup AS (
 INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
 SELECT ${plant}::uuid,'object_cleanup',u.id,'people-import-upload/'||u.id,'ready',u.expires_at,0,4,0 FROM upload u
 ON CONFLICT DO NOTHING)
 SELECT id FROM upload`);
		if (!result.rows[0]) deny();
		const signed = await signPrivatePut(storage, key, "text/csv", input.byteLength).catch(() => deny());
		return c.importUpload.parse({ uploadId: id, ...signed });
	});
}
async function storedFile(db: Database, storage: PrivateStorage, ctx: PeopleReadContext, uploadId: string) {
	const plant = plantId(ctx),
		key = uploadKey(plant, uploadId);
	const found = z.object({ allowed: z.boolean(), staged: z.boolean() }).parse(
		(
			await db.execute(sql`SELECT ${access(ctx, true)} AS allowed, EXISTS(SELECT FROM file_object f
 WHERE f.id=${uploadId}::uuid AND f.tenant_id=${plant}::uuid AND f.purpose='native_import' AND f.opaque_key=${key}::text
 AND f.state='pending' AND f.expires_at>clock_timestamp()) AS staged`)
		).rows[0],
	);
	if (!found.allowed) deny();
	if (!found.staged) deny("file_changed");
	const object = await readPrivateUpload(storage, key, c.importLimits.bytes);
	if (object === "too_large") deny("file_too_large");
	if (object === "missing") deny("file_changed");
	return object.bytes;
}
export async function previewStoredImport(
	db: Database,
	storage: PrivateStorage,
	authority: RequestActor,
	raw: unknown,
) {
	const ctx = new PeopleReadContext(authority);
	const loaded = await readReply(async () => {
		authorizeCachedWrite(ctx);
		const input = parse(c.previewStoredImportRequest, raw);
		return storedFile(db, storage, ctx, input.uploadId);
	});
	if (loaded.status !== "ok") return loaded;
	return gatedTransaction(db, (tx) => peopleCsv.previewImport(tx, ctx, { file: loaded.value }));
}
export async function executeStoredImport(
	db: Database,
	storage: PrivateStorage,
	authority: RequestActor,
	raw: unknown,
) {
	const loaded = await readReply(async () => {
		const ctx = new PeopleReadContext(authority);
		authorizeCachedWrite(ctx);
		const { uploadId, ...input } = parse(c.executeStoredImportRequest, raw);
		return { ...input, file: await storedFile(db, storage, ctx, uploadId) };
	});
	if (loaded.status !== "ok") return loaded;
	return executeBulkImport(db, authority, loaded.value);
}

export const peopleCsv = {
	generateCsvTemplate() {
		return c.csvFile.parse({
			filename: "people-import-template.csv",
			mediaType: media,
			text: csvLine(c.importColumns),
		});
	},
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
			return receiptOf(row.id, loadState(row.state));
		});
	},
	async getLatestImportReceipt(tx: Tx, ctx: Context) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const row = z
				.object({
					allowed: z.boolean(),
					id: z.uuid().nullable(),
					request_key: z.string().nullable(),
					at: z.coerce.date().nullable(),
					state: z.unknown(),
				})
				.parse(
					(
						await tx.execute(sql`SELECT g.allowed,a.id,a.request_key,a.occurred_at AS at,${importState(sql`a.id`)} AS state
 FROM (SELECT ${access(ctx, true)} AS allowed) g LEFT JOIN LATERAL (SELECT e.id,e.request_key,e.occurred_at
  FROM person_import pi JOIN audit_event e ON e.id=pi.id AND e.tenant_id=pi.tenant_id
  WHERE g.allowed AND pi.tenant_id=${plant}::uuid ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) a ON true`)
					).rows[0],
				);
			if (!row.allowed) deny();
			if (!row.id || !row.state) return c.latestImportReceipt.parse({ status: "none" });
			return c.latestImportReceipt.parse({
				status: "available",
				requestKey: row.request_key,
				importedAt: row.at!.toISOString(),
				receipt: receiptOf(row.id, loadState(row.state)),
			});
		});
	},
	async saveBulkImport(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.executeBulkImportRequest, raw);
			const file = readFile(input.file);
			if (file.fileDigest !== input.fileDigest) deny("file_changed");
			return saveImport(tx, ctx, input, file);
		});
	},
	async exportPeople(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			plantId(ctx);
			const filters = parse(c.exportPeopleRequest, raw);
			const result = await tx.execute(sql`SELECT ${access(ctx)} AS allowed,
 coalesce((SELECT jsonb_agg(jsonb_build_array(export_first,export_last,email,phone,street,city,state_province,postal_code,
  country,stage,source,source_details,notes,tags,created) ORDER BY created_at,id) FROM (
  SELECT person.*,
  CASE WHEN person.first_name IS NULL AND person.last_name IS NULL
   THEN substring(btrim(person.display_name) from '^[^[:space:]]+') ELSE person.first_name END AS export_first,
  CASE WHEN person.first_name IS NULL AND person.last_name IS NULL
   THEN nullif(regexp_replace(btrim(person.display_name),'^[^[:space:]]+[[:space:]]*',''),'') ELSE person.last_name END AS export_last,
  to_char(person.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
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
				text: "\ufeff" + csvLine(c.exportColumns) + state.rows.map(csvLine).join(""),
				receipt: { filters, matched: state.rows.length, returned: state.rows.length, completeness: "complete" },
			});
		});
	},
	async countExport(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			plantId(ctx);
			const filters = parse(c.exportPeopleRequest, raw);
			const result = await tx.execute(sql`SELECT ${access(ctx)} AS allowed,
 (SELECT count(*)::int FROM person WHERE ${and(...peopleFilters(ctx, filters, access(ctx)))}) AS matched`);
			const state = z.object({ allowed: z.boolean(), matched: z.number().int() }).parse(result.rows[0]);
			if (!state.allowed) deny();
			return c.peopleExport.omit({ text: true }).parse({
				filename: `people-${new Date().toISOString().slice(0, 10)}.csv`,
				mediaType: media,
				receipt: { filters, matched: state.matched, returned: state.matched, completeness: "complete" },
			});
		});
	},
};
