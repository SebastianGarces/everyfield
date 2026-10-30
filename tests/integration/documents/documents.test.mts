import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { documentsReader } from "../../../packages/domain/src/documents/index.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import { renderEngineVersion, renderPreview, renderTemplatePdf } from "../../../packages/domain/src/documents/render.ts";
import { agendaMeetingOf } from "../../../packages/domain/src/documents/agenda-meeting.ts";
import { loadStarter, validateBundle } from "../../../packages/reference/src/index.ts";
import { referenceArtifactSha256 } from "../../../packages/reference/src/playbook.ts";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");

const schema = "wp036_" + randomUUID().replaceAll("-", "");
const roleName = "wp036_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 5 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
let db;
let canary: string;
let foreignMeeting: string;
let foreignTeam: string;
const editedTitle = "Tenant edited copy";

const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result.status === "refused" ? result.error : result.status));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const authority = async (who = 0) => {
	const actor = await RequestActor.resolve(db, actors[who].session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const countOf = async (table: string) =>
	Number((await admin.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0].n);
const counts = async () => {
	const tables = ["document", "document_revision", "file_object", "audit_event", "generated_document"];
	return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await countOf(table)])));
};
const previewInput = (templateId: string, format: string, extra = {}) => ({ templateId, format, ...extra });

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(
			`CREATE ROLE ${roleName} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${roleName}`));
	const url = new URL(source);
	url.username = roleName;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 4, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	for (const actor of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${actor.user},${actor.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${actor.id},${actor.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${actor.session},${actor.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
	}
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${P},'Harvest Point','America/Chicago',7,14,1,8,1,1)`,
	);
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${Q},'Other Plant','America/New_York',7,14,1,8,1,1)`,
	);
	for (const [index, plant, seatRole] of [
		[0, P, "owner"],
		[1, P, "member"],
		[2, P, "admin"],
		[3, Q, "admin"],
	] as const)
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[index].id},${plant},${seatRole},clock_timestamp())`,
		);
	const pastor = randomUUID();
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${pastor},${P},${P},'Pastor Ada','other','leader','adult','unknown',0,'live',clock_timestamp())`,
	);
	canary = randomUUID();
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${canary},${Q},${Q},'Quinn Canary','other','prospect','unknown','unknown',0,'live',clock_timestamp())`,
	);
	const team = randomUUID();
	const role = randomUUID();
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${P},'Leadership','active',0)`,
	);
	await admin.execute(
		sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,template_key) VALUES(${role},${P},${team},'Senior Pastor',true,0,'senior_pastor')`,
	);
	await admin.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${P},${role},${pastor},'2026-01-01')`,
	);
	await admin.execute(sql`INSERT INTO launch(plant_id,target_date,status) VALUES(${P},'2026-09-14','scheduled')`);
	foreignMeeting = randomUUID();
	foreignTeam = randomUUID();
	await admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
			VALUES(${foreignMeeting},${Q},'vision_meeting','Foreign','2026-03-10','18:00','America/New_York','2026-03-10T22:00:00Z','test','planning',1)`,
	);
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${foreignTeam},${Q},'Foreign team','active',0)`,
	);
	await admin.execute(sql`INSERT INTO document(tenant_id,kind,title) VALUES(${P},'native',${editedTitle})`);
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${roleName}`));
	} finally {
		await closeDatabase(admin);
	}
});

describe("WP-036/api document templates", { concurrency: 1 }, () => {
	test("CASE-DOC-001 the library lists 11 templates and 11 formats, and a retired id does not resolve", async () => {
		const owner = await authority(0);
		const discovery = await authority(4);
		assert.equal(discovery.actor.context.kind, "account");
		const page = ok(await documentsReader["templates.list"](db, owner, {}));
		const discovered = ok(await documentsReader["templates.list"](db, discovery, {}));
		assert.equal(page.templateCount, 11);
		assert.equal(page.formatCount, 11);
		assert.equal(discovered.templateCount, 11);
		assert.deepEqual(
			page.templates.map((template) => template.id),
			discovered.templates.map((template) => template.id),
		);
		const frozen = await loadStarter();
		assert.deepEqual(
			page.templates.map((template) => template.id),
			frozen.catalogs.documents.map((template) => template.id),
		);
		assert.equal(page.version, await referenceArtifactSha256());
		for (const template of page.templates) {
			assert.ok(template.outline.length >= 1);
			assert.equal(template.formats.length, 1);
			assert.equal(
				template.mergeFields.some((field) => field.key === "church_name" && field.required),
				true,
			);
		}
		const pdfIds = page.templates.filter((template) => template.formats.includes("pdf")).map((template) => template.id);
		for (const id of ["commitment-card", "response-card", "guest-sign-in-sheet"])
			assert.equal(pdfIds.includes(id), true);
		refused(await documentsReader["templates.get"](db, owner, { templateId: "old-template" }), "unavailable");
		const card = ok(await documentsReader["templates.get"](db, discovery, { templateId: "commitment-card" }));
		assert.equal(card.id, "commitment-card");
		assert.equal(card.wikiSlug, "core-group/commitment/the-three-key-documents");
		const unknown = ok(await documentsReader["templates.contextual"](db, owner, { wikiSlug: "preparing-leaders" }));
		assert.deepEqual(unknown.templates, []);
		const noFilter = ok(await documentsReader["templates.contextual"](db, owner, {}));
		assert.deepEqual(noFilter.templates, []);
		const linked = ok(
			await documentsReader["templates.contextual"](db, owner, {
				wikiSlug: "core-group/commitment/the-three-key-documents",
			}),
		);
		assert.deepEqual(
			linked.templates.map((template) => template.id),
			["commitment-card", "member-expectations", "launch-team-commitment"],
		);
		const commitment = ok(await documentsReader["templates.list"](db, owner, { category: "commitment" }));
		assert.equal(commitment.templateCount, 3);
		const phase = ok(await documentsReader["templates.list"](db, owner, { phase: 4 }));
		assert.deepEqual(
			phase.templates.map((template) => template.id),
			["launch-sunday-checklists"],
		);
		const meeting = randomUUID();
		await admin.execute(
			sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
				VALUES(${meeting},${P},'vision_meeting','Vision','2026-03-10','18:00','America/Chicago','2026-03-10T23:00:00Z','test','planning',1)`,
		);
		// A live Vision meeting offers its agenda (WP-036/api, agendas from the meeting).
		const byMeeting = ok(await documentsReader["templates.contextual"](db, owner, { meetingId: meeting }));
		assert.deepEqual(
			byMeeting.templates.map((template) => template.id),
			["vision-meeting-agenda"],
		);
		refused(await documentsReader["templates.list"](db, owner, { article: "g1" }), "invalid_input");
	});

	test("CASE-DOC-002 preview renders every format from the catalog and writes no rows", async () => {
		const owner = await authority(0);
		const member = await authority(1);
		const before = await counts();
		const { templates } = await library();
		assert.equal(
			templates.reduce((sum, template) => sum + template.formats.length, 0),
			11,
		);
		for (const template of templates) {
			for (const format of template.formats) {
				const input = previewInput(template.id, format, { overrides: { church_name: "Harvest Point" } });
				const first = ok(await documentsReader.preview(db, owner, input));
				const second = ok(await documentsReader.preview(db, member, input));
				assert.deepEqual(first, second);
				assert.equal(first.plantId, P);
				assert.equal(first.complete, true);
				assert.equal(first.missing.length, 0);
				assert.equal(first.engineVersion, renderEngineVersion());
				assert.equal(typeof first.artifact, "string");
				const bytes = Buffer.from(first.artifact, "base64");
				assert.equal(first.digest, createHash("sha256").update(bytes).digest("hex"));
				if (format === "pdf") {
					assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
					const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
					assert.equal(pdf.getTitle()?.includes("Harvest Point"), true);
					assert.equal(pdf.getPageCount(), template.pageCount);
					const size = pdf.getPage(0).getSize();
					const card = ["commitment-card", "response-card"].includes(template.id);
					assert.deepEqual([size.width, size.height], card ? [306, 396] : [612, 792]);
				} else {
					assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK");
					assert.equal(bytes.includes(Buffer.from("Harvest Point")), true);
					if (template.id === "first-year-budget") assert.equal(bytes.includes(Buffer.from("SUM(")), true);
					if (template.id === "budget-worksheet") assert.equal(bytes.includes(Buffer.from("B5*12")), true);
				}
			}
		}
		const agenda = ok(await documentsReader.resolveContext(db, member, previewInput("vision-meeting-agenda", "pdf")));
		assert.equal(agenda.fields.find((field) => field.key === "pastor_name").value, "Pastor Ada");
		assert.equal(agenda.fields.find((field) => field.key === "pastor_name").source, "pastor_name");
		assert.equal("artifact" in agenda, false);
		const launch = ok(await documentsReader.resolveContext(db, owner, previewInput("launch-sunday-checklists", "pdf")));
		assert.equal(launch.fields.find((field) => field.key === "launch_date").value, "2026-09-14");
		const kept = ok(
			await documentsReader.preview(
				db,
				owner,
				previewInput("commitment-card", "pdf", { overrides: { church_name: "   " } }),
			),
		);
		assert.equal(kept.fields.find((field) => field.key === "church_name").value, "Harvest Point");
		assert.equal(kept.fields.find((field) => field.key === "church_name").source, "church_name");
		refused(
			await documentsReader.preview(
				db,
				owner,
				previewInput("commitment-card", "pdf", { overrides: { church_name: "x".repeat(2001) } }),
			),
			"invalid_input",
		);
		const bulky = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, "x".repeat(2000)]));
		refused(
			await documentsReader.preview(db, owner, previewInput("commitment-card", "pdf", { overrides: bulky })),
			"invalid_input",
		);
		refused(
			await documentsReader.preview(
				db,
				owner,
				previewInput("commitment-card", "pdf", { overrides: { budget_total: "1" } }),
			),
			"invalid_input",
		);
		refused(
			await documentsReader.preview(
				db,
				owner,
				previewInput("commitment-card", "pdf", { overrides: { church_name: "A\u0000B" } }),
			),
			"render_failed",
		);
		refused(
			await documentsReader.preview(
				db,
				owner,
				previewInput("commitment-card", "pdf", { overrides: { church_name: "A\uD800B" } }),
			),
			"render_failed",
		);
		for (const subject of [{ personId: canary }, { meetingId: foreignMeeting }, { teamId: foreignTeam }]) {
			const foreign = await documentsReader.preview(db, owner, previewInput("commitment-card", "pdf", subject));
			refused(foreign, "invalid_subject");
			assert.equal(JSON.stringify(foreign).includes("Quinn Canary"), false);
			assert.equal(JSON.stringify(foreign).includes("Other Plant"), false);
		}
		const ownerActor = await authority(0);
		const forged = RequestActor.of(actors[3].session, ownerActor.actor);
		const calls = [
			() => documentsReader["templates.list"](db, forged, {}),
			() => documentsReader["templates.get"](db, forged, { templateId: "commitment-card" }),
			() =>
				documentsReader["templates.contextual"](db, forged, {
					wikiSlug: "core-group/commitment/the-three-key-documents",
				}),
			() => documentsReader.resolveContext(db, forged, previewInput("commitment-card", "pdf")),
			() => documentsReader.preview(db, forged, previewInput("commitment-card", "pdf")),
		];
		for (const call of calls) {
			const result = await call();
			refused(result, "unavailable");
			const body = JSON.stringify(result);
			assert.equal(body.includes("Harvest Point"), false);
			assert.equal(body.includes("Quinn Canary"), false);
			assert.equal(body.includes("commitment-card"), false);
		}
		const discovery = await authority(4);
		refused(await documentsReader.preview(db, discovery, previewInput("commitment-card", "pdf")), "unavailable");
		try {
			await admin.execute(sql`UPDATE seat SET role='admin' WHERE account_id=${actors[1].id}`);
			refused(await documentsReader.preview(db, member, previewInput("commitment-card", "pdf")), "unavailable");
		} finally {
			await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${actors[1].id}`);
		}
		assert.deepEqual(await counts(), before);
		const title = (await admin.execute(sql`SELECT title FROM document WHERE tenant_id=${P}`)).rows[0].title;
		assert.equal(title, editedTitle);
		assert.equal(await countOf("document"), 1);
	});

	test("GAP-REF-003 REF-CASE-003 the frozen catalog is the template source and a missing required field emits no bytes", async () => {
		const { templates, version } = await library();
		assert.equal(templates.length, 11);
		assert.equal(
			templates.reduce((sum, template) => sum + template.formats.length, 0),
			11,
		);
		assert.equal(version, await referenceArtifactSha256());
		const card = templates.find((template) => template.id === "commitment-card");
		assert.ok(card);
		const merged = resolveMerge(card, { churchName: null, pastorName: null, launchDate: null }, {});
		assert.equal(merged.ok, true);
		if (!merged.ok) return;
		assert.equal(merged.missing.includes("church_name"), true);
		assert.equal(await renderPreview(card, "pdf", merged), null);
		const finance = Number(
			(
				await admin.execute(
					sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=current_schema() AND table_name ILIKE '%finance%'`,
				)
			).rows[0].n,
		);
		assert.equal(finance, 0);
		const framework = (
			await admin.execute(sql`SELECT to_regclass('generic_file') AS generic_file, to_regclass('file') AS file`)
		).rows[0];
		assert.equal(framework.generic_file, null);
		assert.equal(framework.file, null);
		const report = validateBundle({ body: "SECRET-CANARY" }, {});
		assert.equal(report.ok, false);
		assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
		const reference = await import("../../../packages/reference/src/index.ts");
		assert.equal("activateGeneration" in reference, false);
		assert.equal("rollbackActivation" in reference, false);
	});

	test("CASE-DOC-007 CASE-DOC-011 agendas print from the meeting itself and only from a live meeting of their kind", async () => {
		const owner = await authority(0);
		const member = await authority(1);
		const outsider = await authority(3);
		const id = () => randomUUID();
		const person = async (name: string, state = "live") => {
			const pid = id();
			await admin.execute(
				sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
					VALUES(${pid},${P},${P},${name},'other','prospect','unknown','unknown',0,${state},clock_timestamp())`,
			);
			return pid;
		};
		const meeting = async (
			type: string,
			over: { team?: string; agenda?: object[]; venue?: boolean; retired?: boolean; number?: number } = {},
		) => {
			const mid = id();
			await admin.execute(
				sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision,
						agenda,venue_name,venue_address,team_id,vision_number,retired_at)
					VALUES(${mid},${P},${type},NULL,'2026-11-10','18:30','America/Chicago','2026-11-11T00:30:00Z','test','planning',1,
						${JSON.stringify(over.agenda ?? [])}::jsonb,${over.venue === false ? null : "Harbor Hall"},${over.venue === false ? null : "12 Dock Street"},
						${over.team ?? null},${over.number ?? null},${over.retired ? new Date().toISOString() : null})`,
			);
			return mid;
		};
		const guest = (mid: string, pid: string, rsvp: string | null, removed = false) =>
			admin.execute(
				sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,rsvp,presence,removed_at)
					VALUES(${P},${mid},${pid},false,${rsvp},'absent',${removed ? new Date().toISOString() : null})`,
			);
		const leadership = id();
		const other = id();
		await admin.execute(
			sql`INSERT INTO team(id,plant_id,name,state,sort_order,template_key) VALUES(${leadership},${P},'Leadership team','active',1,'leadership')`,
		);
		await admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${other},${P},'Worship team','active',2)`);
		const elderRole = id();
		await admin.execute(
			sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order) VALUES(${elderRole},${P},${leadership},'Elder',true,1)`,
		);
		const agenda = [
			{ id: "a", title: "Greeting", minutes: 10 },
			{ id: "b", title: "Story", minutes: 25 },
		];
		const vision = await meeting("vision_meeting", { agenda, number: 41 });
		const board = await meeting("team_meeting", { team: leadership, agenda: [], venue: false });
		const orientation = await meeting("orientation", { agenda });
		const worship = await meeting("team_meeting", { team: other, agenda });
		const retired = await meeting("vision_meeting", { agenda, retired: true, number: 42 });
		const ada = await person("Ada Brown");
		const ben = await person("Ben Cole");
		const gone = await person("Cy Declined");
		const removed = await person("Di Removed");
		const retiredPerson = await person("Eve Retired");
		for (const [pid, rsvp, drop] of [
			[ben, "pending", false],
			[ada, "confirmed", false],
			[gone, "declined", false],
			[removed, "confirmed", true],
			[retiredPerson, "confirmed", false],
		] as const)
			await guest(vision, pid, rsvp, drop);
		await admin.execute(sql`UPDATE person SET state='retired' WHERE id=${retiredPerson}`);
		await guest(board, ada, null);
		await admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${P},${elderRole},${ada},'2026-01-01')`);

		// Criterion 1: one template for a live Vision meeting and a live leadership team meeting; none for the rest.
		const offered = async (who, meetingId) =>
			ok(await documentsReader["templates.contextual"](db, who, { meetingId })).templates.map((template) => template.id);
		assert.deepEqual(await offered(owner, vision), ["vision-meeting-agenda"]);
		assert.deepEqual(await offered(member, vision), ["vision-meeting-agenda"]);
		assert.deepEqual(await offered(owner, board), ["board-meeting-agenda"]);
		for (const none of [orientation, worship, retired, foreignMeeting]) assert.deepEqual(await offered(owner, none), []);
		assert.deepEqual(await offered(outsider, vision), []);

		const expected = async (templateId: string, meetingId: string, over: Record<string, string> = {}) => {
			const row = (
				await admin.execute(
					sql`SELECT m.type, m.title, m.vision_number, m.local_date::text AS local_date, to_char(m.local_time,'HH24:MI') AS local_time,
						m.venue_name, m.venue_address, m.agenda FROM meeting m WHERE m.id=${meetingId}`,
				)
			).rows[0];
			return row;
		};
		const printed = async (who, meetingId: string) => ok(await documentsReader.printAgenda(db, who, { meetingId }));
		const before = await counts();
		const audit = await countOf("audit_event");

		// Criterion 2 and 11: preview and the print read the meeting; the bytes equal an engine render of its facts.
		const render = (id: string, facts) =>
			renderTemplatePdf(
				{ id },
				{ church_name: "Harvest Point", ...(id === "vision-meeting-agenda" ? { pastor_name: "Pastor Ada" } : {}), meeting_date: facts.date },
				undefined,
				facts,
			);
		const visionFacts = agendaMeetingOf(
			{
				type: "vision_meeting",
				title: null,
				visionNumber: 41,
				localDate: "2026-11-10",
				localTime: "18:30",
				venueName: "Harbor Hall",
				venueAddress: "12 Dock Street",
				agenda: agenda.map(({ title, minutes }) => ({ title, minutes })),
				leadership: false,
				attendees: [
					{ name: "Ada Brown", role: null },
					{ name: "Ben Cole", role: null },
				],
				attendeeTotal: 2,
			},
			new Date().getUTCFullYear(),
		);
		const mine = await render("vision-meeting-agenda", visionFacts);
		const viaPreview = ok(
			await documentsReader.preview(db, owner, previewInput("vision-meeting-agenda", "pdf", { meetingId: vision })),
		);
		assert.equal(viaPreview.digest, createHash("sha256").update(mine.bytes).digest("hex"));
		const dateField = viaPreview.fields.find((field) => field.key === "meeting_date");
		assert.deepEqual([dateField.value, dateField.source], [visionFacts.date, "meeting"]);
		const context = ok(
			await documentsReader.resolveContext(db, member, previewInput("vision-meeting-agenda", "pdf", { meetingId: vision })),
		);
		assert.equal(context.fields.find((field) => field.key === "meeting_date").source, "meeting");
		const over = ok(
			await documentsReader.preview(
				db,
				owner,
				previewInput("vision-meeting-agenda", "pdf", { meetingId: vision, overrides: { meeting_date: "Nov 11" } }),
			),
		);
		assert.deepEqual(
			[over.fields.find((field) => field.key === "meeting_date").value, over.fields.find((field) => field.key === "meeting_date").source],
			["Nov 11", "override"],
		);
		const print = await printed(member, vision);
		assert.equal(print.templateId, "vision-meeting-agenda");
		assert.equal(print.localDate, "2026-11-10");
		assert.equal(print.digest, viaPreview.digest);
		const boardPrint = await printed(owner, board);
		assert.equal(boardPrint.templateId, "board-meeting-agenda");
		// A leadership meeting: Role prints the person's current role on the team; no venue leaves Place blank.
		const boardFacts = agendaMeetingOf(
			{
				type: "team_meeting",
				title: null,
				visionNumber: null,
				localDate: "2026-11-10",
				localTime: "18:30",
				venueName: null,
				venueAddress: null,
				agenda: [],
				leadership: true,
				attendees: [{ name: "Ada Brown", role: "Elder" }],
				attendeeTotal: 1,
			},
			new Date().getUTCFullYear(),
		);
		assert.equal(boardPrint.digest, createHash("sha256").update((await render("board-meeting-agenda", boardFacts)).bytes).digest("hex"));

		// Refusals leak nothing: wrong kind, retired, another plant's meeting, a meeting of no agenda type.
		for (const [template, meetingId] of [
			["board-meeting-agenda", vision],
			["vision-meeting-agenda", board],
			["vision-meeting-agenda", retired],
			["vision-meeting-agenda", foreignMeeting],
			["board-meeting-agenda", worship],
			["vision-meeting-agenda", orientation],
		] as const) {
			const result = await documentsReader.preview(db, owner, previewInput(template, "pdf", { meetingId }));
			refused(result, "invalid_subject");
			const text = JSON.stringify(result);
			for (const leak of ["Harbor Hall", "Greeting", "Ada Brown", "artifact", "Foreign"]) assert.equal(text.includes(leak), false, leak);
		}
		for (const bad of [retired, orientation, worship, foreignMeeting, id()]) {
			const result = await documentsReader.printAgenda(db, owner, { meetingId: bad });
			refused(result, "invalid_subject");
		}
		refused(await documentsReader.printAgenda(db, outsider, { meetingId: vision }), "invalid_subject");
		const forged = RequestActor.of(actors[3].session, (await authority(0)).actor);
		refused(await documentsReader.printAgenda(db, forged, { meetingId: vision }), "unavailable");

		// Criterion 11: a print reads the meeting fresh. Reorder, rename and retime, then print again.
		await admin.execute(
			sql`UPDATE meeting SET agenda=${JSON.stringify([
				{ id: "b", title: "Story, retold", minutes: 30 },
				{ id: "a", title: "Greeting", minutes: 10 },
			])}::jsonb WHERE id=${vision}`,
		);
		const edited = await printed(owner, vision);
		assert.notEqual(edited.digest, print.digest);
		const editedFacts = {
			...visionFacts,
			sections: [
				{ title: "Story, retold", minutes: 30, start: "6:30 pm" },
				{ title: "Greeting", minutes: 10, start: "7:00 pm" },
			],
			totalMinutes: 40,
		};
		assert.equal(edited.digest, createHash("sha256").update((await render("vision-meeting-agenda", editedFacts)).bytes).digest("hex"));
		// An agenda that empties prints the blank run of show with the meeting's own header facts.
		await admin.execute(sql`UPDATE meeting SET agenda='[]'::jsonb WHERE id=${vision}`);
		const emptied = await printed(owner, vision);
		assert.equal(
			emptied.digest,
			createHash("sha256").update((await render("vision-meeting-agenda", { ...visionFacts, sections: [], totalMinutes: 0 })).bytes).digest("hex"),
		);
		// A removed list entry leaves the print at once; so does retiring the meeting.
		await admin.execute(sql`UPDATE participation SET removed_at=clock_timestamp() WHERE meeting_id=${vision} AND person_id=${ben}`);
		assert.notEqual((await printed(owner, vision)).digest, emptied.digest);
		await admin.execute(sql`UPDATE meeting SET retired_at=clock_timestamp() WHERE id=${vision}`);
		refused(await documentsReader.printAgenda(db, owner, { meetingId: vision }), "invalid_subject");
		assert.deepEqual(await offered(owner, vision), []);

		// Nothing stored: no generated document, audit row, file or document row.
		assert.deepEqual(await counts(), before);
		assert.equal(await countOf("audit_event"), audit);
		void expected;
	});
});
