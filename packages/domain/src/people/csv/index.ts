import * as c from "@everyfield/contracts/people";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { and, sql, type SQL } from "@everyfield/db/query";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../../access/session.ts";
import { deny, hash, parse, readReply, Refusal, type Context, type Tx } from "../core.ts";
import { plantId, readAuthority } from "../fields/shared.ts";
import { newPerson } from "../people.ts";
import { peopleFilters } from "../queries.ts";
import { csvLine, parseCsv } from "./format.ts";

// People CSV import (REQ-PPL-018) and export (REQ-PPL-019) for plant Owners and Admins.

type ImportColumn = z.infer<typeof c.importColumn>;
type Problem = z.infer<typeof c.rowProblem>;
type Values = z.infer<typeof c.importValues>;
type FileRow =
	| { row: number; status: "valid"; values: Values; email: string | null; phone: string | null }
	| { row: number; status: "invalid"; problems: Problem[] };
type ReadFile = { fileDigest: string; used: ImportColumn[]; ignored: string[]; rows: FileRow[] };

/**
 * Rows one import request writes, in one statement. A request stays under one second with a full 10,000-row file; the
 * caller repeats the request for the next batch.
 */
const BATCH = 500;
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
	const phone = values.phone?.replace(/\D/g, "") ?? "";
	return {
		row,
		status: "valid",
		values,
		email: values.email?.toLowerCase() ?? null,
		phone: phone.length >= 7 ? phone : null,
	};
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
	return sql`coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'displayName',p.display_name,'email',lower(btrim(p.email)),
 'phone',regexp_replace(coalesce(p.phone,''),'\\D','','g')) ORDER BY p.created_at,p.id) FROM person p
 WHERE NOT ${unless} AND p.plant_id=${plant}::uuid AND p.state='live' AND (lower(btrim(p.email))=ANY(${sql.param(emails)}::text[])
 OR regexp_replace(coalesce(p.phone,''),'\\D','','g')=ANY(${sql.param(phones)}::text[]))),'[]'::jsonb)`;
}

type Finding = { existing: Match[]; earlier: number | null };
/** Existing and within-file duplicates per valid row, and the digest that freezes them for the import. */
function findDuplicates(file: ReadFile, people: Match[]) {
	const findings = new Map<number, Finding>(),
		first = new Map<string, number>();
	for (const r of file.rows) {
		if (r.status !== "valid") continue;
		const signals = [r.email && "e:" + r.email, r.phone && "p:" + r.phone].filter((s) => !!s) as string[];
		const existing = people.filter((p) => (r.email && p.email === r.email) || (r.phone && p.phone === r.phone));
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

type Created = Map<number, { personId: string; reviewWith: string | null }>;
/** Every row's outcome from the saved plan, the rows whose Person exists and the rows this request failed to write. */
function receipt(importId: string, plan: Plan, created: Created, failed: ReadonlySet<number> = new Set()) {
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
			outcomes.set(
				row,
				failed.has(row)
					? { row, status: "failed", reason: "row_write_failed", problems: [] }
					: { row, status: "remaining" },
			);
		}
	}
	return c.importReceipt.parse({
		importId,
		status: remaining.length ? "partial" : "complete",
		rows: [...outcomes].sort(([a], [b]) => a - b).map(([, outcome]) => outcome),
		remaining,
		counts: {
			created: created.size,
			skipped: plan.skip.length,
			failed: plan.invalid.length + failed.size,
			remaining: remaining.length,
		},
	});
}
/** The rows an import has created so far, from their people.created audit rows. */
const createdRows = (
	importId: SQL,
) => sql`coalesce((SELECT jsonb_agg(jsonb_build_object('row',(e.metadata->'import'->>'row')::int,
 'personId',e.subject_id,'reviewWith',e.metadata->'import'->'reviewWith')) FROM audit_event e
 WHERE e.command_id=${importId} AND e.action='people.created'),'[]'::jsonb)`;
const createdList = z.array(z.object({ row: z.int(), personId: z.uuid(), reviewWith: z.uuid().nullable() }));
const createdMap = (rows: z.infer<typeof createdList>): Created =>
	new Map(rows.map((r) => [r.row, { personId: r.personId, reviewWith: r.reviewWith }]));

type BatchRow = { id: string; row: number; reviewWith: string | null; person: object };
/**
 * One batch in one statement: the live Owner/Admin check, the new people, one people.created audit row each tied to the
 * import, and the pipeline and church revisions. A Person that an earlier attempt already wrote is left alone.
 */
async function writeBatch(
	db: Database,
	ctx: PeopleContext,
	actor: { id: string; token: string },
	importId: string,
	batch: BatchRow[],
): Promise<boolean> {
	const plant = ctx.selected.id;
	// Absent keys load as NULL, so empty values are left out of the payload.
	const people = JSON.stringify(
			batch.map((b) => b.person),
			(_key, value) => (value === null ? undefined : value),
		),
		links = JSON.stringify(batch.map((b) => ({ id: b.id, row: b.row, review_with: b.reviewWith })));
	const result = await db.execute(sql`WITH allowed AS (SELECT ${readAuthority(ctx, true)} AS ok),
 created AS (INSERT INTO person SELECT * FROM jsonb_populate_recordset(NULL::person,${people}::jsonb)
  WHERE (SELECT ok FROM allowed) ON CONFLICT (id) DO NOTHING RETURNING *),
 audit AS (INSERT INTO audit_event(tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,after_revision,after_value,command_id,metadata)
  SELECT ${plant}::uuid,${actor.id}::uuid,${actor.token},'people.created','create','person',p.id,1,
  jsonb_strip_nulls(to_jsonb(p)-'revision'),${importId}::uuid,
  jsonb_build_object('import',jsonb_strip_nulls(jsonb_build_object('row',l.row,'reviewWith',l.review_with)))
  FROM created p JOIN jsonb_to_recordset(${links}::jsonb) l(id uuid,row int,review_with uuid) ON l.id=p.id),
 pipeline AS (INSERT INTO people_column(plant_id,column_name,revision) SELECT ${plant}::uuid,'prospect',2 WHERE EXISTS(SELECT FROM created)
  ON CONFLICT (plant_id,column_name) DO UPDATE SET revision=people_column.revision+1),
 church AS (UPDATE plant SET material_revision=material_revision+1 WHERE id=${plant}::uuid AND EXISTS(SELECT FROM created))
 SELECT ok FROM allowed`);
	return z.boolean().parse(result.rows[0]?.ok);
}

/**
 * Save the reviewed rows, one batch per request. The first request saves the import intent with its frozen review; each
 * request then writes the next batch of rows not created yet and returns every row's outcome. The caller repeats the
 * same request while rows remain. A failed batch leaves earlier batches saved and is named in the receipt.
 */
export async function executeBulkImport(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const ctx: PeopleContext = { session: authority.session, selected: authority.actor.context.owner };
		const plant = plantId(ctx),
			actorId = authority.actor.accountId;
		const input = parse(c.executeBulkImportRequest, raw);
		const file = readFile(input.file);
		if (file.fileDigest !== input.fileDigest) deny("file_changed");
		const choices = [...input.choices].sort((a, b) => a.row - b.row);
		const identity = {
			owner: ctx.selected,
			actorId,
			operation: OPERATION,
			requestKey: input.requestKey,
			digest: hash({ reviewDigest: input.reviewDigest, choices }),
		};
		const state = z
			.object({
				allowed: z.boolean(),
				prior: z.object({ id: z.uuid(), identity: z.unknown(), plan: z.unknown(), created: createdList }).nullable(),
				people: match,
			})
			.parse(
				(
					await db.execute(sql`SELECT ${readAuthority(ctx, true)} AS allowed,
 (SELECT jsonb_build_object('id',a.id,'identity',a.request_identity,'plan',a.result,'created',${createdRows(sql`a.id`)}) FROM audit_event a
  WHERE a.tenant_id=${plant}::uuid AND a.request_key=${input.requestKey}) AS prior,
 ${existingPeople(plant, file.rows, sql`EXISTS(SELECT FROM audit_event a WHERE a.tenant_id=${plant}::uuid AND a.request_key=${input.requestKey})`)} AS people`)
				).rows[0],
			);
		if (!state.allowed) deny();
		let importId: string, plan: Plan;
		if (state.prior) {
			// A retry resumes the frozen plan; people it already created do not become new duplicates.
			if (hash(state.prior.identity) !== hash(identity)) deny("review_digest_conflict");
			importId = state.prior.id;
			plan = savedPlan.parse(state.prior.plan);
		} else {
			const { findings, reviewDigest } = findDuplicates(file, state.people);
			// The church's people may have changed since the preview; the review is only valid against today's findings.
			if (reviewDigest !== input.reviewDigest) deny("review_stale");
			importId = randomUUID();
			plan = planImport(file, findings, choices, importId);
			const inserted =
				await db.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,actor_token,action,kind,subject_type,
 subject_id,command_id,request_key,request_identity,result)
 SELECT ${importId}::uuid,${plant}::uuid,${actorId}::uuid,${hash([plant, actorId])},'people.updated','edit','command',
 ${plant}::uuid,${importId}::uuid,${input.requestKey},${JSON.stringify(identity)}::jsonb,${JSON.stringify(plan)}::jsonb
 WHERE ${readAuthority(ctx, true)} ON CONFLICT (tenant_id,request_key) DO NOTHING RETURNING id`);
			// A lost seat refuses; so does a concurrent first attempt that won the key. A retry then resumes it.
			if (!inserted.rows.length) deny("conflict");
		}
		const created = createdMap(state.prior?.created ?? []);
		const values = new Map(file.rows.flatMap((r) => (r.status === "valid" ? [[r.row, r.values] as const] : [])));
		const start = Date.now();
		const batch: BatchRow[] = plan.create
			.filter((r) => !created.has(r.row))
			.slice(0, BATCH)
			.map((r, i) => {
				const id = rowPersonId(importId, r.row);
				// Rows keep file order in the directory: each is recorded one millisecond after the one before it.
				const person = newPerson(ctx, values.get(r.row)!, null, id, new Date(start + i));
				return { id, row: r.row, reviewWith: r.reviewWith, person };
			});
		const failed = new Set<number>();
		if (batch.length) {
			const actor = { id: actorId, token: hash([plant, actorId]) };
			try {
				if (!(await writeBatch(db, ctx, actor, importId, batch))) deny();
				for (const b of batch) created.set(b.row, { personId: b.id, reviewWith: b.reviewWith });
			} catch (error) {
				if (error instanceof Refusal) throw error;
				// The batch rolled back as a whole. Its rows are named and stay remaining for the next request.
				for (const b of batch) failed.add(b.row);
			}
		}
		return receipt(importId, plan, created, failed);
	});
}

const savedImport = z.object({
	allowed: z.boolean(),
	id: z.uuid().nullable(),
	plan: z.unknown(),
	created: createdList,
});

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
					(
						await tx.execute(
							sql`SELECT ${readAuthority(ctx, true)} AS allowed, ${existingPeople(plant, file.rows)} AS people`,
						)
					).rows[0],
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
	/** The import's saved outcome for each row, read again after a lost reply. */
	async getImportReceipt(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(c.importReceiptRequest, raw);
			const row = savedImport.parse(
				(
					await tx.execute(sql`SELECT ${readAuthority(ctx, true)} AS allowed, a.id, a.result AS plan,
 ${createdRows(sql`a.id`)} AS created
 FROM (SELECT 1) seed LEFT JOIN audit_event a ON a.tenant_id=${plant}::uuid AND a.request_key=${input.requestKey}
  AND a.request_identity->>'operation'=${OPERATION}`)
				).rows[0],
			);
			if (!row.allowed || !row.id) deny();
			return receipt(row.id, savedPlan.parse(row.plan), createdMap(row.created));
		});
	},
	/** The directory's filtered people as formula-safe CSV, with the exact filters and count. */
	async exportPeople(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			plantId(ctx);
			const filters = parse(c.exportPeopleRequest, raw);
			const result = await tx.execute(sql`SELECT ${readAuthority(ctx, true)} AS allowed,
 coalesce((SELECT jsonb_agg(jsonb_build_array(first_name,last_name,email,phone,street,city,state_province,postal_code,
  country,stage,source,source_details,notes,tags,created) ORDER BY created_at,id) FROM (
  SELECT person.*,to_char(person.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
  (SELECT string_agg(t.name,';' ORDER BY lower(t.name),t.id) FROM person_tag pt JOIN tag t ON t.id=pt.tag_id
   AND t.plant_id=pt.plant_id WHERE pt.person_id=person.id AND pt.plant_id=person.plant_id) AS tags
  FROM person WHERE ${and(...peopleFilters(ctx, filters))} AND ${readAuthority(ctx, true)}
  ORDER BY person.created_at,person.id LIMIT ${c.exportRowLimit + 1}) x),'[]'::jsonb) AS rows`);
			const state = z
				.object({ allowed: z.boolean(), rows: z.array(z.array(z.string().nullable())) })
				.parse(result.rows[0]);
			if (!state.allowed) deny();
			if (state.rows.length > c.exportRowLimit) deny("export_too_large");
			return c.peopleExport.parse({
				filename: `people-${new Date().toISOString().slice(0, 10)}.csv`,
				mediaType: media,
				// The byte order mark lets spreadsheets read the UTF-8 names correctly.
				text: "﻿" + csvLine(c.exportColumns) + state.rows.map(csvLine).join(""),
				receipt: { filters, count: state.rows.length },
			});
		});
	},
};
