// One tenancy test for every read operation. Church A holds real records; church B's owner calls each read with church
// A's ids and must get the read's own refusal, or an empty answer, with no church A id or value anywhere in the reply.
//
// The reads are found from the code, never from a hand-kept list. The rule, applied with the TypeScript checker:
//   1. Take every public entry point of @everyfield/domain: each file named in packages/domain/package.json "exports".
//   2. An operation is an exported function there, or a function-valued property of an exported object (one level),
//      named "<entry>:<export>" or "<entry>:<export>.<property>". Classes and re-exported types are not operations.
//   3. It takes a RequestActor when one parameter's type is RequestActor, has a RequestActor property, or accepts a
//      domain class that holds one (PeopleReadContext, OnboardingReadContext).
//   4. It writes nothing unless the first word of its name is in WRITE_VERBS. Any other name counts as a read, so a new
//      read fails here until it has a case; a new write verb fails here too until it is added to WRITE_VERBS.
// A found read must have a case below or be named in tenancy-baseline.json. The baseline only shrinks: an entry for a
// read that no longer exists, or that already has a case, fails the test (as tests/workflow/evry-evals-baseline.json).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import {
	assessments,
	checkForDuplicates,
	commitments,
	dismissDuplicatePair,
	executeBulkImport,
	getAccountLink,
	getCommitmentDownload,
	interviews,
	listDismissedDuplicatePairs,
	listDuplicatePairs,
	listedDuplicatePair,
	peopleCsv,
	peopleMerge,
	peopleReader,
	peopleUnmerge,
	peopleViewer,
	peopleWriter,
	personFields,
	previewStoredImport,
	readColumnOrders,
	readPersonPage,
	readPersonPhoto,
	readPersonPhotos,
	recordCorrections,
	retryStoredImport,
	searchPeople,
	withPeopleWrite,
} from "../../../packages/domain/src/people/index.ts";
import { PeopleReadContext } from "../../../packages/domain/src/people/core.ts";
import {
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	withMeetingsWrite,
} from "../../../packages/domain/src/meetings/index.ts";
import { readPipelineConsents } from "../../../packages/domain/src/organizations/index.ts";
import { runDueImports } from "../../../apps/web/src/server/people/run-imports.ts";
import { ok } from "../../support/fixture.mts";
import { accessCases, seedAccess } from "./tenancy-access.mts";
import { brandingCases, seedBranding } from "./tenancy-branding.mts";
import { deletedDocumentCases, documentsCases, seedDocuments } from "./tenancy-documents.mts";
import { followUpsCases, seedFollowUps } from "./tenancy-followups.mts";
import { meetingsCases, seedMeetings } from "./tenancy-meetings.mts";
import { onboardingCases, seedOnboarding } from "./tenancy-onboarding.mts";
import { organizationsCases, seedOrganizations } from "./tenancy-organizations.mts";
import { phasesCases, seedPhases } from "./tenancy-phases.mts";
import { seedSettings, settingsCases } from "./tenancy-settings.mts";
import { seedTasks, tasksCases } from "./tenancy-tasks.mts";
import { seedTeams, teamsCases } from "./tenancy-teams.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baselinePath = fileURLToPath(new URL("./tenancy-baseline.json", import.meta.url));

const WRITE_VERBS = new Set(
	`accept add appoint archive assign attest cancel change clear complete copy correct create delete designate dismiss dispatch
	edit end ensure execute finalize fork generate hand import initialize invite merge offer populate propagate
	reactivate recomplete reconcile record remove reorder replace request reschedule reset restore retire revoke save schedule
	send set sign unmerge update upload use with withdraw`.split(/\s+/),
);

/** Every public read that takes a RequestActor, by the rule in the header. */
function discoverReads() {
	const domain = path.join(root, "packages/domain");
	const ts = createRequire(path.join(domain, "package.json"))("typescript");
	const config = ts.getParsedCommandLineOfConfigFile(
		path.join(domain, "tsconfig.json"),
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic(d) {
				throw Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
			},
		},
	);
	const src = path.join(domain, "src") + path.sep;
	const files = config.fileNames.filter((f) => f.startsWith(src) && !/\.test\.tsx?$/.test(f));
	const program = ts.createProgram(files, { ...config.options, noEmit: true });
	const checker = program.getTypeChecker();
	const exportsOf = (file) => {
		const source = program.getSourceFile(file);
		const module = source && checker.getSymbolAtLocation(source);
		if (!module) throw Error(`No module for ${file}`);
		return checker
			.getExportsOfModule(module)
			.map((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s));
	};
	const typeOf = (symbol) => {
		const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
		return declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : null;
	};
	const requestActor = exportsOf(path.join(src, "access/session.ts")).find((s) => s.name === "RequestActor");
	const isActor = (type) => type.getSymbol() === requestActor || (type.isUnion() && type.types.some(isActor));
	const opaque = (type) => type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown);
	const holdsActor = (type) =>
		!opaque(type) &&
		(isActor(type) ||
			(type.isUnion() ? type.types : [type]).some((part) =>
				part.getProperties().some((p) => {
					const t = typeOf(p);
					return t !== null && isActor(t);
				}),
			));
	// Domain classes that carry a RequestActor, such as PeopleReadContext.
	const carriers = [];
	for (const file of files)
		for (const symbol of exportsOf(file))
			if (symbol.valueDeclaration && ts.isClassDeclaration(symbol.valueDeclaration)) {
				const instance = checker.getDeclaredTypeOfSymbol(symbol);
				if (holdsActor(instance)) carriers.push(instance);
			}
	const takesActor = (signature) =>
		signature.getParameters().some((parameter) => {
			const type = typeOf(parameter);
			if (!type || opaque(type)) return false;
			return (
				holdsActor(type) ||
				(type.getProperties().length > 0 && carriers.some((c) => checker.isTypeAssignableTo(c, type)))
			);
		});
	const reads = new Set();
	const consider = (name, type) => {
		if (!type?.getCallSignatures().some(takesActor)) return;
		const verb = name
			.split(/[:.]/)
			.pop()
			.match(/^[a-z]+/)?.[0];
		if (!WRITE_VERBS.has(verb)) reads.add(name);
	};
	const { exports } = JSON.parse(readFileSync(path.join(domain, "package.json"), "utf8"));
	for (const [entry, file] of Object.entries(exports)) {
		const area = entry.replace(/^\.\//, "");
		for (const symbol of exportsOf(path.join(domain, file))) {
			if (!symbol.valueDeclaration || ts.isClassDeclaration(symbol.valueDeclaration)) continue;
			const type = typeOf(symbol);
			if (!type) continue;
			if (type.getCallSignatures().length) consider(`${area}:${symbol.name}`, type);
			else if (symbol.flags & ts.SymbolFlags.Variable)
				for (const property of type.getProperties())
					consider(`${area}:${symbol.name}.${property.name}`, typeOf(property));
		}
	}
	return reads;
}

let f, plantA, plantB, ownerA, ownerB;
const a = {};
/** What an area's case module reads: the fixture, church A's ids in `a`, both owners and the shared helpers. */
let t;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const key = () => randomUUID();
const rows = async (query) => (await f.admin.execute(query)).rows;
const emptyAudience = { groups: [], teamIds: [], personIds: [] };
const day = 86_400_000;
const AT = new Date(Math.ceil((Date.now() + 7 * day) / 3_600_000) * 3_600_000).toISOString();
// A past date, so a record dated in the church's own time zone is never in its future.
const occurredOn = new Date(Date.now() - 30 * day).toISOString().slice(0, 10);
// Every church A value carries this mark, so a leaked name, email, subject or body is found in any reply.
const MARK = "ALPHA-TENANCY";
const AVERY_EMAIL = "alpha-tenancy-avery@example.test";

// Church A's writes, through the public operations as its owner.
const communicate = (op, input) =>
	withCommunicationWrite(f.db, ownerA.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
const people = (body) => withPeopleWrite(f.db, ownerA.actor, body);
const personA = async (name, fields = {}) =>
	ok(
		await people((t, c) =>
			peopleWriter.createPerson(t, c, { requestKey: key(), input: { displayName: `${MARK} ${name}`, ...fields } }),
		),
	).person;
// A provider that accepts every message, as a local fake of the email service.
const transport = {
	async send(batch) {
		return { outcome: "ids", ids: batch.messages.map(() => `prov-${key()}`) };
	},
};
// Private storage that no cross-church read may reach.
let storageCalls = 0;
const storage = {
	bucket: "tenancy-only",
	client: {
		async send() {
			storageCalls += 1;
			throw Error("storage_reached");
		},
	},
};

async function seedChurchA() {
	await f.admin.execute(sql`UPDATE plant SET name = ${`${MARK} Church`}, timezone = 'America/Chicago'
		WHERE id = ${plantA.id}`);
	const avery = await personA("Avery", {
		firstName: `${MARK}-Avery`,
		email: AVERY_EMAIL,
		phone: "+1 555 0101",
		stage: "leader",
	});
	const blair = await personA("Blair", { email: "alpha-tenancy-blair@example.test" });
	const source = await personA("Casey", { email: "alpha-tenancy-casey@example.test" });
	const survivor = await personA("Casey Two", { email: "alpha-tenancy-casey2@example.test" });
	Object.assign(a, { avery: avery.id, blair: blair.id, source: source.id });

	ok(
		await people((t, c) =>
			peopleWriter.addNote(t, c, {
				requestKey: key(),
				expectedRevision: avery.revision,
				input: { personId: avery.id, body: `${MARK} private note` },
			}),
		),
	);
	const tag = ok(
		await people((t, c) => personFields.createTag(t, c, { requestKey: key(), input: { name: `${MARK} tag` } })),
	).tag;
	ok(
		await people((t, c) =>
			personFields.assignTag(t, c, { requestKey: key(), input: { personId: avery.id, tagId: tag.id } }),
		),
	);
	ok(
		await people((t, c) =>
			personFields.addSkill(t, c, {
				requestKey: key(),
				input: { personId: avery.id, name: `${MARK} skill`, category: "tech" },
			}),
		),
	);
	const household = ok(
		await people((t, c) =>
			personFields.createHouseholdWithHead(t, c, {
				requestKey: key(),
				expectedRevision: blair.revision,
				input: { name: `${MARK} household`, street: "1 Alpha St", city: "Alphaville", headPersonId: blair.id },
			}),
		),
	).result.household;
	a.household = household.id;
	const lens = { score: 4, notes: `${MARK} lens` };
	const assessment = ok(
		await people((t, c) =>
			assessments.createAssessment(t, c, {
				requestKey: key(),
				input: {
					personId: avery.id,
					occurredOn,
					committed: lens,
					compelled: lens,
					contagious: lens,
					courageous: lens,
				},
			}),
		),
	);
	const rated = { rating: "pass" };
	ok(
		await people((t, c) =>
			interviews.createInterview(t, c, {
				requestKey: key(),
				input: {
					personId: avery.id,
					occurredOn,
					maturity: { rating: "pass", notes: `${MARK} interview note` },
					gifted: rated,
					chemistry: rated,
					rightReasons: rated,
					season: rated,
					result: "qualified",
					nextSteps: `${MARK} next steps`,
				},
			}),
		),
	);
	const commitment = ok(
		await people((t, c) =>
			commitments.createCommitment(t, c, {
				requestKey: key(),
				input: { personId: avery.id, kind: "core_group", occurredOn },
			}),
		),
	);
	a.commitment = commitment.commitment.id;
	const recorded = assessment.assessment;
	ok(
		await people((t, c) =>
			recordCorrections.correctPersonRecord(t, c, {
				requestKey: key(),
				expectedRevision: recorded.revision,
				input: {
					recordType: "assessment",
					personId: avery.id,
					recordId: recorded.id,
					changes: { committed: { score: 5, notes: `${MARK} corrected` } },
					reason: `${MARK} reason`,
				},
			}),
		),
	);
	const review = ok(
		await f.db.transaction((t) =>
			peopleMerge.getMergeReview(t, new PeopleReadContext(ownerA.actor), {
				sourceId: source.id,
				survivorId: survivor.id,
			}),
		),
	);
	ok(
		await people((t, c) =>
			peopleMerge.mergePeople(t, c, {
				requestKey: key(),
				input: { sourceId: source.id, survivorId: survivor.id, reviewDigest: review.reviewDigest, fieldChoices: {} },
			}),
		),
	);
	a.merge = (await rows(sql`SELECT id FROM person_merge WHERE source_id = ${source.id}`))[0].id;

	// Rows 2 and 3 repeat row 1 and are added to review later, so church A has a pair for people.listDuplicatePairs and,
	// once row 3's pair is marked not a duplicate, one for people.listDismissedDuplicatePairs.
	const file = new TextEncoder().encode(
		`first_name,email\r\n${MARK}-Imported,alpha-tenancy-import@example.test\r\n${MARK}-Again,alpha-tenancy-import@example.test\r\n` +
			`${MARK}-Third,alpha-tenancy-import@example.test\r\n`,
	);
	const preview = ok(
		await f.db.transaction((t) => peopleCsv.previewImport(t, new PeopleReadContext(ownerA.actor), { file })),
	);
	a.importKey = key();
	ok(
		await executeBulkImport(f.db, ownerA.actor, {
			requestKey: a.importKey,
			file,
			fileDigest: preview.fileDigest,
			reviewDigest: preview.reviewDigest,
			choices: preview.rows
				.filter((r) => r.status === "valid")
				.map((r) => ({ row: r.row, choice: r.row === 1 ? "create" : "create_and_review" })),
		}),
	);
	await runDueImports(f.db, 10);
	const listedPairs = ok(
		await f.db.transaction((t) => listDuplicatePairs(t, new PeopleReadContext(ownerA.actor))),
	).items;
	// Row 2's pair stays listed, for the review's people.listedDuplicatePair (T-268).
	const again = listedPairs.find((p) => p.person.displayName === `${MARK}-Again`);
	a.listedPair = { a: again.with.id, b: again.person.id };
	const pairs = listedPairs.filter((p) => p.person.displayName === `${MARK}-Third`);
	ok(
		await people((t, c) =>
			dismissDuplicatePair(t, c, { personId: pairs[0].person.id, withPersonId: pairs[0].with.id }),
		),
	);

	// Teams come from their own area; rows here, as the communication suites seed them. This meeting row is the
	// communication cases' own; the meetings cases read the meetings seed (tenancy-meetings.mts).
	a.team = randomUUID();
	const role = randomUUID();
	await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order)
		VALUES(${a.team},${plantA.id},${`${MARK} team`},'active',1)`);
	await f.admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order)
		VALUES(${role},${plantA.id},${a.team},${`${MARK} role`},false,1)`);
	await f.admin.execute(sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on)
		VALUES(${randomUUID()},${plantA.id},${role},${avery.id},'2026-01-01')`);
	a.meeting = randomUUID();
	await f.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision)
		VALUES(${a.meeting},${plantA.id},'vision_meeting',${`${MARK} vision`},'2026-11-01','18:00','America/Chicago',
		'2026-11-01T23:00:00Z','1','completed',1)`);

	a.template = ok(
		await communicate("createTemplate", {
			requestKey: key(),
			input: {
				name: `${MARK} template`,
				description: null,
				category: "announcement",
				meetingType: null,
				subject: `${MARK} template subject`,
				bodyHtml: `<p>${MARK} template body</p>`,
			},
		}),
	).templateId;
	ok(await communicate("forkTemplate", { requestKey: key(), input: { sourceKey: "vision-meeting-invitation" } }));
	a.draft = ok(
		await communicate("saveDraft", {
			requestKey: key(),
			input: {
				subject: `${MARK} draft`,
				bodyHtml: `<p>${MARK} draft body</p>`,
				audience: { ...emptyAudience, personIds: [avery.id] },
			},
		}),
	).communicationId;
	const sent = ok(
		await communicate("saveDraft", {
			requestKey: key(),
			input: {
				subject: `${MARK} sent`,
				bodyHtml: `<p>${MARK} sent body</p>`,
				audience: { ...emptyAudience, personIds: [avery.id, blair.id] },
				meetingId: a.meeting,
			},
		}),
	);
	a.sent = sent.communicationId;
	const scheduled = ok(
		await communicate("scheduleReviewed", {
			requestKey: key(),
			expectedRevision: sent.revision,
			input: { communicationId: a.sent, scheduledAt: AT },
		}),
	);
	ok(
		await communicationWriter.sendReviewed(
			f.db,
			ownerA.actor,
			{ requestKey: key(), expectedRevision: scheduled.revision, input: { communicationId: a.sent } },
			transport,
			keys,
		),
	);
	// Account links come from invitations; set one here so the account-link reads have something to find.
	await f.admin.execute(sql`UPDATE person SET linked_account_id = ${ownerA.id} WHERE id = ${avery.id}`);
}

// Every id church A holds after the seed, from each table keyed by church, with its owner and every marked value.
async function churchASecrets() {
	const tables = await rows(sql`SELECT table_name AS name,
			array_agg(column_name::text) FILTER (WHERE column_name <> 'id') AS owners
		FROM information_schema.columns
		WHERE table_schema = current_schema() AND column_name IN ('id', 'plant_id', 'tenant_id')
		GROUP BY table_name HAVING bool_or(column_name = 'id') AND count(*) > 1`);
	const ids = new Set([plantA.id, ownerA.id, a.importKey]);
	for (const table of tables) {
		const owned = sql.join(
			table.owners.map((column) => sql`${sql.identifier(column)} = ${plantA.id}::uuid`),
			sql` OR `,
		);
		for (const row of await rows(sql`SELECT id::text AS id FROM ${sql.identifier(table.name)} WHERE ${owned}`))
			ids.add(row.id);
	}
	return [...ids, ownerA.email, MARK, MARK.toLowerCase()];
}

// Each case calls one read as `who`: church B's owner for the tenancy check, church A's owner for the control.
// `refused` is the read's own refusal code. `value` is its exact empty answer; `partial` names the fields of an answer
// that also carries a clock or system rows, and `check` asserts the rest. As church A's owner the same call must
// return church A data, which proves the ids are live; `control` replaces that check where the read has nothing of
// church A's to show its own church, and `control: null` names a read the seed cannot make answer.
const plain = async (body) => ({ status: "ok", value: await body() });

function cases(who) {
	const comms = (op, input, deliveryKeys) =>
		f.db.transaction((tx) =>
			input === undefined
				? communicationWriter[op](tx, who.actor)
				: communicationWriter[op](tx, who.actor, input, deliveryKeys),
		);
	const reads = (body) => f.db.transaction((tx) => body(tx, new PeopleReadContext(who.actor)));
	const comm = (name, run, expected) => [`communication:communicationWriter.${name}`, { run, expected }];
	const ppl = (name, run, expected) => [`people:${name}`, { run, expected }];
	// A meetings read this file's own seed meeting covers.
	const area = (name, run, expected) => [name, { run, expected }];
	const unavailable = { refused: "unavailable" };
	return new Map([
		area(
			"meetings:meetingsReader.pageGuests",
			() => f.db.transaction((t) => meetingsReader.pageGuests(t, who.actor, { meetingId: a.meeting })),
			unavailable,
		),
		comm("readPreview", () => comms("readPreview", { bodyHtml: "<p>Hi</p>", meetingId: a.meeting }), {
			refused: "invalid_subject",
		}),
		comm("readAudience", () => comms("readAudience", { ...emptyAudience, personIds: [a.avery], teamIds: [a.team] }), {
			value: {
				resolvedDistinctPeople: 0,
				eligibleRecipients: 0,
				missingEmailExclusions: [],
				unsubscribedExclusions: [],
				duplicateAddressesRemoved: 0,
				eligibleEmails: [],
				searchResultLimit: 20,
				searchLimitTruncatesAudience: false,
				recipients: [],
				complete: true,
			},
		}),
		comm("readRecipients", () => comms("readRecipients", { query: MARK }), { value: { people: [], limit: 20 } }),
		comm(
			"readMergeFields",
			() => comms("readMergeFields", { bodyHtml: "<p>Hi {{name}}</p>", merge: { name: "Bea" } }),
			{
				value: { bodyHtml: "<p>Hi Bea</p>", bodyText: "Hi Bea" },
				// It renders only the merge values the caller sends; it reads no church record.
				control: (value) => assert.deepEqual(value, { bodyHtml: "<p>Hi Bea</p>", bodyText: "Hi Bea" }),
			},
		),
		comm("readMeetingTemplate", () => comms("readMeetingTemplate", { meetingType: "vision_meeting" }), {
			partial: { origin: "system", sourceKey: "vision-meeting-invitation" },
		}),
		comm("get", () => comms("get", { id: a.draft }), { refused: "not_found" }),
		comm("getDraft", () => comms("getDraft", { id: a.draft }), { refused: "not_found" }),
		comm("listDrafts", () => comms("listDrafts"), { value: { drafts: [] } }),
		comm("readChurchName", () => comms("readChurchName"), { value: { churchName: "Synthetic plant" } }),
		comm("listAudienceTeams", () => comms("listAudienceTeams"), { value: { teams: [] } }),
		comm("listTemplates", () => comms("listTemplates"), {
			check: (value) => assert.deepEqual(new Set(value.templates.map((t) => t.origin)), new Set(["system"])),
		}),
		comm("getTemplate", () => comms("getTemplate", { id: a.template }), { refused: "not_found" }),
		comm("listForSelf", () => communicationWriter.listForSelf(f.db, who.actor, { address: ownerA.email }, keys), {
			refused: "access_denied",
		}),
		comm("listHistory", () => comms("listHistory", { limit: 100 }), {
			partial: { items: [], visibleCount: 0, foreignRows: [], complete: true },
		}),
		comm("getDetail", () => comms("getDetail", { id: a.sent }, keys), { refused: "not_found" }),
		comm("getDeliveryTotals", () => comms("getDeliveryTotals", { communicationId: a.sent }), { refused: "not_found" }),
		comm("listForPerson", () => comms("listForPerson", { personId: a.avery, limit: 10 }), { refused: "not_found" }),
		comm("listForMeeting", () => comms("listForMeeting", { meetingId: a.meeting }), { refused: "not_found" }),
		comm("listHistoryRecipients", () => comms("listHistoryRecipients", { communicationId: a.sent, limit: 10 }, keys), {
			refused: "not_found",
		}),
		comm("listMeetingTracking", () => comms("listMeetingTracking", { meetingId: a.meeting }), { refused: "not_found" }),
		comm("getExecutionResult", () => comms("getExecutionResult", { communicationId: a.sent }), {
			refused: "not_found",
		}),
		comm("listResendCandidates", () => comms("listResendCandidates", { communicationId: a.sent }), {
			refused: "not_found",
		}),

		ppl("getAccountLink", () => reads((t, c) => getAccountLink(t, c, { personId: a.avery })), unavailable),
		ppl("peopleViewer", () => plain(() => peopleViewer(who.actor, null)), {
			partial: { accountId: ownerB.id, selected: plantB, role: "owner" },
		}),
		ppl("readColumnOrders", () => reads((t, c) => plain(() => readColumnOrders(t, c, ["prospect", "core_group"]))), {
			value: [
				{ column: "prospect", revision: "1", personIds: [], personRevisions: {} },
				{ column: "core_group", revision: "1", personIds: [], personRevisions: {} },
			],
		}),
		ppl("readPersonPage", () => reads((t, c) => readPersonPage(t, c, { personId: a.avery }, 50)), unavailable),
		ppl(
			"checkForDuplicates",
			() => reads((t, c) => checkForDuplicates(t, c, { displayName: `${MARK} Avery`, email: AVERY_EMAIL })),
			{ value: { items: [], completeness: "complete" } },
		),
		ppl("listDuplicatePairs", () => reads((t, c) => listDuplicatePairs(t, c)), {
			value: { items: [], completeness: "complete" },
		}),
		ppl("listedDuplicatePair", () => reads((t, c) => listedDuplicatePair(t, c, a.listedPair)), { value: null }),
		ppl("listDismissedDuplicatePairs", () => reads((t, c) => listDismissedDuplicatePairs(t, c)), {
			// The church's own time zone is its only field: church B's, which is no church A value.
			check: (value) => assert.deepEqual({ ...value, zone: "" }, { zone: "", items: [], completeness: "complete" }),
		}),
		ppl("searchPeople", () => reads((t, c) => searchPeople(t, c, MARK)), { value: [] }),
		ppl("readPersonPhotos", () => readPersonPhotos(f.db, new PeopleReadContext(who.actor), { personIds: [a.avery] }), {
			value: { photos: [] },
			// Avery links to church A's owner, whose seeded avatar church A sees on its own Person.
			control: (value) =>
				assert.deepEqual(value, {
					photos: [{ personId: a.avery, photo: { kind: "account", accountId: ownerA.id, versionId: a.avatar } }],
				}),
		}),
		ppl("peopleReader.getPipelineData", () => reads((t, c) => peopleReader.getPipelineData(t, c, {})), {
			check: (value) => {
				assert.deepEqual(value.owner, plantB);
				assert.deepEqual(
					value.groups.filter((g) => g.total !== 0 || g.cards.length !== 0),
					[],
				);
			},
		}),
		ppl(
			"peopleReader.getStatusWarnings",
			() => reads((t, c) => peopleReader.getStatusWarnings(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl(
			"peopleReader.getPerson",
			() => reads((t, c) => peopleReader.getPerson(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl("peopleReader.listPeople", () => reads((t, c) => peopleReader.listPeople(t, c, { search: MARK })), {
			value: { owner: plantB, items: [], photos: [], next: null, completeness: "complete", total: 0 },
		}),
		ppl(
			"peopleReader.getActivities",
			() => reads((t, c) => peopleReader.getActivities(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl("peopleReader.getOwnAccountPerson", () => reads((t, c) => peopleReader.getOwnAccountPerson(t, c, {})), {
			value: { status: "unlinked" },
		}),
		ppl(
			"peopleMerge.getMergeReview",
			() => reads((t, c) => peopleMerge.getMergeReview(t, c, { sourceId: a.avery, survivorId: a.blair })),
			unavailable,
		),
		ppl(
			"peopleMerge.mergedPersonDestination",
			() => reads((t, c) => peopleMerge.mergedPersonDestination(t, c, { personId: a.source })),
			unavailable,
		),
		ppl(
			"peopleMerge.findDuplicates",
			() => reads((t, c) => peopleMerge.findDuplicates(t, c, { personId: a.avery })),
			// An organization read: a church's own owner is refused it too, so no church can show a control.
			{ refused: "unavailable", control: null },
		),
		ppl(
			"peopleUnmerge.previewUnmerge",
			() => reads((t, c) => peopleUnmerge.previewUnmerge(t, c, { mergeId: a.merge })),
			unavailable,
		),
		ppl(
			"recordCorrections.listRecordCorrections",
			() => reads((t, c) => recordCorrections.listRecordCorrections(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl(
			"personFields.getPersonPhoto",
			() => reads((t, c) => personFields.getPersonPhoto(t, c, { personId: a.avery })),
			// The seed stores no photo: church A reads its live Person's absent photo where church B is refused.
			{ refused: "unavailable", control: (value) => assert.deepEqual(value, { status: "absent" }) },
		),
		ppl("personFields.listTags", () => reads((t, c) => personFields.listTags(t, c, {})), { value: { items: [] } }),
		ppl(
			"personFields.getPersonTags",
			() => reads((t, c) => personFields.getPersonTags(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl(
			"personFields.getPersonSkills",
			() => reads((t, c) => personFields.getPersonSkills(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl("personFields.listHouseholds", () => reads((t, c) => personFields.listHouseholds(t, c, {})), {
			value: { items: [], next: null, total: 0 },
		}),
		ppl(
			"personFields.getHousehold",
			() => reads((t, c) => personFields.getHousehold(t, c, { personId: a.blair })),
			unavailable,
		),
		ppl(
			"personFields.getHouseholdMembers",
			() => reads((t, c) => personFields.getHouseholdMembers(t, c, { householdId: a.household })),
			unavailable,
		),
		ppl(
			"readPersonPhoto",
			() => readPersonPhoto(f.db, storage, new PeopleReadContext(who.actor), { personId: a.avery, versionId: key() }),
			// The seed stores no photo object, so church A has nothing to read back either.
			{ refused: "unavailable", control: null },
		),
		ppl(
			"assessments.getAssessments",
			() => reads((t, c) => assessments.getAssessments(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl(
			"interviews.getInterviews",
			() => reads((t, c) => interviews.getInterviews(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl(
			"commitments.getCommitments",
			() => reads((t, c) => commitments.getCommitments(t, c, { personId: a.avery })),
			unavailable,
		),
		ppl(
			"getCommitmentDownload",
			() => getCommitmentDownload(f.db, storage, new PeopleReadContext(who.actor), { commitmentId: a.commitment }),
			// The seed stores no signed document, so church A has no download either.
			{ refused: "unavailable", control: null },
		),
		ppl(
			"previewStoredImport",
			() => previewStoredImport(f.db, storage, who.actor, { uploadId: key() }),
			// An upload id names a staged file of the caller's own church only; the seed stages none.
			{ refused: "file_changed", control: null },
		),
		ppl(
			"peopleCsv.previewImport",
			() =>
				reads((t, c) =>
					peopleCsv.previewImport(t, c, {
						file: new TextEncoder().encode(`first_name,email\r\n${MARK}-Avery,${AVERY_EMAIL}\r\n`),
					}),
				),
			{
				partial: { counts: { existingDuplicates: 0 }, rows: [{ row: 1, status: "valid", existingDuplicates: [] }] },
				echo: [`${MARK}-Avery`, AVERY_EMAIL],
			},
		),
		ppl(
			"peopleCsv.getImportReceipt",
			() => reads((t, c) => peopleCsv.getImportReceipt(t, c, { requestKey: a.importKey })),
			unavailable,
		),
		ppl(
			"retryStoredImport",
			// Church A's request key from church B names no import; church A's owner gets its complete receipt back.
			() => retryStoredImport(f.db, storage, who.actor, { requestKey: a.importKey }),
			unavailable,
		),
		ppl("peopleCsv.exportPeople", () => reads((t, c) => peopleCsv.exportPeople(t, c, {})), {
			partial: {
				text: "\ufefffirst_name,last_name,email,phone,street,city,state,postal_code,country,status,source,source_details,notes,tags,created_at\r\n",
				receipt: { matched: 0, returned: 0, completeness: "complete" },
			},
		}),
		ppl("peopleCsv.countExport", () => reads((t, c) => peopleCsv.countExport(t, c, {})), {
			partial: { receipt: { matched: 0, returned: 0, completeness: "complete" } },
			control: (value) => assert.ok(value.receipt.matched > 0),
		}),
		// Only a sending church's own Owner or Admin has pipeline choices; a church's owner, even naming a church A id as
		// the connection, gets none, and church A has no sending-church connection for the control to read.
		[
			"organizations:readPipelineConsents",
			{
				run: () => plain(() => readPipelineConsents(f.db, who.actor, a.avery)),
				expected: { value: [], control: null },
			},
		],
		...meetingsCases(t, who),
		...followUpsCases(t, who),
		...documentsCases(t, who),
		...teamsCases(t, who),
		...tasksCases(t, who),
		...phasesCases(t, who),
		...organizationsCases(t, who),
		...accessCases(t, who),
		...onboardingCases(t, who),
		...brandingCases(t, who),
		...settingsCases(t, who),
	]);
}

before(async () => {
	f = await fixture();
	plantA = await f.workspace();
	plantB = await f.workspace();
	const seated = async (w) => {
		const account = await f.account();
		await f.seat(account, w, "owner");
		return { ...account, actor: await f.actor(account.session) };
	};
	ownerA = await seated(plantA);
	ownerB = await seated(plantB);
	await seedChurchA();
	t = { f, a, MARK, key, ok, rows, occurredOn, personA, storage, plantA, ownerA };
	await seedMeetings(t);
	await seedFollowUps(t);
	await seedDocuments(t);
	await seedTeams(t);
	await seedTasks(t);
	await seedPhases(t);
	await seedOrganizations(t);
	await seedAccess(t);
	await seedOnboarding(t);
	await seedBranding(t);
	await seedSettings(t);
});
after(() => f?.close());

test("INV-tenancy: a church cannot read another church's data through any read operation", async () => {
	const reads = discoverReads();
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	const covered = cases(ownerB);
	assert.deepEqual(
		[...reads].filter((name) => !covered.has(name) && !baseline.includes(name)).sort(),
		[],
		"reads with no tenancy case: add a case, never a baseline entry",
	);
	assert.deepEqual(
		baseline.filter((name) => !reads.has(name) || covered.has(name)).sort(),
		[],
		"stale baseline entries: remove them",
	);
	assert.deepEqual(
		[...covered.keys()].filter((name) => !reads.has(name)).sort(),
		[],
		"cases for operations that are not reads",
	);

	const secrets = await churchASecrets();
	// A reply may repeat what the caller itself sent (a CSV preview shows the uploaded file); that is not a leak.
	const found = (reply, echo = []) => {
		const text = echo.reduce((t, own) => t.split(own).join(""), JSON.stringify(reply));
		return { text, leaked: secrets.filter((secret) => text.includes(secret)) };
	};
	const failures = [];
	for (const [name, { run, expected }] of covered) {
		const reply = await run();
		const { text, leaked } = found(reply, expected.echo);
		if (leaked.length) failures.push(`${name} returned church A data ${JSON.stringify(leaked)}: ${text.slice(0, 400)}`);
		else if ("refused" in expected) {
			if (reply.status !== "refused" || reply.error.code !== expected.refused)
				failures.push(`${name} expected refusal ${expected.refused}: ${text.slice(0, 400)}`);
		} else {
			try {
				const value = ok(reply);
				if ("value" in expected) assert.deepEqual(value, expected.value);
				if ("partial" in expected) assert.partialDeepStrictEqual(value, expected.partial);
				expected.check?.(value);
			} catch (error) {
				failures.push(`${name}: ${error.message.slice(0, 600)}`);
			}
		}
	}
	assert.deepEqual(failures, [], "church B read church A data or got another answer");
	assert.equal(storageCalls, 0, "a cross-church read reached private storage");

	const blind = [];
	for (const [name, { run, expected }] of cases(ownerA)) {
		if (expected.control === null) continue;
		const reply = await run();
		try {
			if (expected.control) expected.control(ok(reply));
			else assert.notDeepEqual(found(ok(reply), expected.echo).leaked, []);
		} catch {
			blind.push(`${name}: ${JSON.stringify(reply).slice(0, 300)}`);
		}
	}
	assert.deepEqual(blind, [], "church A's own owner must see the seeded data, or the case proves nothing");
});

// T-189: a deleted Church Document's export link and page tell its own church it was deleted, and answer another church
// exactly as an unknown id does, with no read of private storage.
test("INV-tenancy: a deleted Church Document and its saved export answer another church as an unknown id", async () => {
	const before = storageCalls;
	const code = (reply) => (reply.status === "refused" ? reply.error.code : reply.status);
	for (const c of deletedDocumentCases(t, ownerB)) {
		const [deleted, unknown] = [await c.deleted(), await c.unknown()];
		assert.equal(code(deleted), "unavailable", c.name);
		assert.equal(code(deleted), code(unknown), `${c.name} answers church B as an unknown id`);
	}
	const own = Object.fromEntries(
		await Promise.all(deletedDocumentCases(t, ownerA).map(async (c) => [c.name, code(await c.deleted())])),
	);
	assert.deepEqual(own, { readExportFile: "deleted", listExports: "deleted", readChurch: "unavailable" });
	assert.equal(storageCalls, before, "no read of private storage");
});

// T-232: Add guest's one write takes a meeting and People only from the writer's own church.
test("INV-tenancy: meetings.addGuests refuses another church's meeting and adds no Person of another church", async () => {
	const add = (input) =>
		withMeetingsWrite(f.db, ownerB.actor, (tx, c) => guestsWriter.addGuests(tx, c, { requestKey: key(), input }));
	const guests = (meetingId) =>
		rows(sql`SELECT person_id, removed_at FROM participation WHERE meeting_id=${meetingId} ORDER BY person_id`);
	const people = async () => (await rows(sql`SELECT count(*)::int AS n FROM person`))[0].n;
	const aGuests = await guests(a.vision);
	const before = await people();
	// Church B's owner names church A's meeting, with church A's People and a new contact.
	const onA = await add({ meetingId: a.vision, people: [a.avery, a.blair], contacts: [{ displayName: `${MARK} B` }] });
	assert.deepEqual([onA.status, onA.status === "refused" && onA.error.code], ["refused", "unavailable"]);
	// Church B's own meeting with only church A's People: none of them is a Person of church B.
	const own = ok(
		await withMeetingsWrite(f.db, ownerB.actor, (tx, c) =>
			meetingsWriter.schedule(tx, c, {
				requestKey: key(),
				input: { type: "orientation", date: occurredOn, time: "18:00" },
			}),
		),
	).meeting;
	const onB = await add({ meetingId: own.id, people: [a.avery, a.blair] });
	assert.deepEqual([onB.status, onB.status === "refused" && onB.error.code], ["refused", "invalid_subject"]);
	assert.deepEqual(await guests(a.vision), aGuests);
	assert.deepEqual(await guests(own.id), []);
	assert.equal(await people(), before);
});
