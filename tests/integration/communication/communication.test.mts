import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { scheduleAccepted, systemTemplates } from "../../../packages/contracts/src/communication/index.ts";
import {
	communicationWriter,
	replaceScheduled,
	withCommunicationWrite,
} from "../../../packages/domain/src/communication/index.ts";

let f, plant, other, owner, member, foreign;
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const write = (who, op, input) =>
	withCommunicationWrite(f.db, who.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
const read = (who, op, input) =>
	f.db.transaction((tx) =>
		input === undefined ? communicationWriter[op](tx, who.actor) : communicationWriter[op](tx, who.actor, input),
	);
const key = () => randomUUID();
const rows = async (query) => (await f.admin.execute(query)).rows;
const catalog = () => JSON.parse(JSON.stringify(systemTemplates));

async function counts() {
	const [row] = await rows(sql`SELECT
		(SELECT count(*)::int FROM communication WHERE plant_id = ${plant.id}) AS communications,
		(SELECT count(*)::int FROM mail WHERE tenant_id = ${plant.id} AND purpose = 'communication') AS intents,
		(SELECT count(*)::int FROM mail_attempt WHERE tenant_id = ${plant.id}) AS attempts`);
	return row;
}

async function person(name, fields = {}) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id)
		VALUES(${id},${fields.plant ?? plant.id},${fields.plant ?? plant.id},${name},${fields.email ?? null},'other',
		${fields.stage ?? "prospect"},'unknown','unknown',0,${fields.state ?? "live"},clock_timestamp(),${fields.account ?? null})`);
	return id;
}
async function team(state = "active", name = "Hospitality") {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${id},${plant.id},${name},${state},1)`,
	);
	return id;
}
async function role(teamId, leadership = false) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order) VALUES(${id},${plant.id},${teamId},${leadership ? "Lead" : "Member"},${leadership},1)`,
	);
	return id;
}
async function tenure(roleId, personId) {
	await f.admin.execute(
		sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on) VALUES(${randomUUID()},${plant.id},${roleId},${personId},'2026-01-01')`,
	);
}
async function meeting(title, w = other) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
			VALUES(${id},${w.id},'vision_meeting',${title},'2026-11-01','18:00','America/Chicago','2026-11-01T23:00:00Z','1','completed',1)`,
	);
	return id;
}
const emptyAudience = { groups: [], teamIds: [], personIds: [] };
const draft = (input) => write(owner, "saveDraft", { requestKey: key(), input });
const templateInput = (patch = {}) => ({
	name: "Custom note",
	description: null,
	category: "announcement",
	meetingType: null,
	subject: "Hello",
	bodyHtml: "<p>Hello</p>",
	...patch,
});

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	other = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone = 'America/Chicago' WHERE id IN (${plant.id},${other.id})`);
	const seated = async (w, roleName) => {
		const account = await f.account();
		await f.seat(account, w, roleName);
		return { ...account, actor: await f.actor(account.session) };
	};
	owner = await seated(plant, "owner");
	member = await seated(plant, "member");
	foreign = await seated(other, "owner");
});
after(() => f?.close());

test("AC:CASE-COM-003 preview keeps safe text and writes nothing", async () => {
	const before = await counts();
	const beforeCatalog = catalog();
	const stale = refused(
		await read(owner, "readPreview", {
			bodyHtml: "<p>Hello {{name}}</p><script>alert(1)</script>",
			merge: { name: "Alex" },
			audienceChangedAfterReview: true,
		}),
		"stale_review",
	);
	assert.equal(stale.details.previewBody, "<p>Hello Alex</p>");
	assert.equal(stale.details.scriptExecution, false);
	assert.equal(stale.details.providerCalls, 0);
	const preview = ok(
		await read(owner, "readPreview", {
			bodyHtml: "<p>Hello {{name}}</p><script>alert(1)</script>",
			merge: { name: "Alex" },
		}),
	);
	assert.equal(preview.previewBody, "<p>Hello Alex</p>");
	assert.equal(preview.scriptExecution, false);
	assert.equal(preview.providerCalls, 0);
	assert.equal(Object.hasOwn(preview, "communicationId"), false);
	refused(await read(owner, "readPreview", { bodyHtml: "<p>Hi</p>", communicationId: "not-an-id" }), "invalid_input");
	const foreignMeeting = await meeting("Other vision");
	const foreignTemplate = ok(
		await write(foreign, "createTemplate", { requestKey: key(), input: templateInput() }),
	).templateId;
	refused(await read(owner, "readPreview", { bodyHtml: "<p>Hi</p>", meetingId: foreignMeeting }), "invalid_subject");
	refused(await read(owner, "readPreview", { bodyHtml: "<p>Hi</p>", templateId: foreignTemplate }), "invalid_subject");
	refused(await read(member, "readPreview", { bodyHtml: "<p>Hi</p>" }), "access_denied");
	assert.deepEqual(await counts(), before);
	assert.deepEqual(catalog(), beforeCatalog);
});

test("AC:CASE-COM-004 audience resolution keeps distinct people and ignores the search cap", async () => {
	const ids = [];
	for (let n = 1; n <= 25; n++) {
		const name = `person-${n}`;
		ids.push(await person(name, { email: n === 25 ? null : `${name}@example.test` }));
	}
	const doubled = [ids[0], ...ids];
	const resolved = ok(await read(owner, "readAudience", { ...emptyAudience, personIds: doubled }));
	assert.equal(resolved.resolvedDistinctPeople, 25);
	assert.equal(resolved.eligibleRecipients, 24);
	assert.deepEqual(resolved.missingEmailExclusions, ["person-25"]);
	assert.equal(resolved.duplicateAddressesRemoved, 1);
	assert.equal(resolved.searchResultLimit, 20);
	assert.equal(resolved.searchLimitTruncatesAudience, false);

	const pausedPerson = await person("Paused guest", { email: "paused@example.test" });
	const paused = await team("paused", "Paused team");
	await tenure(await role(paused), pausedPerson);
	const pausedOnly = ok(await read(owner, "readAudience", { ...emptyAudience, teamIds: [paused] }));
	assert.equal(pausedOnly.resolvedDistinctPeople, 0);

	const retired = await person("Retired guest", { email: "retired@example.test", state: "retired" });
	const retiredOnly = ok(await read(owner, "readAudience", { ...emptyAudience, personIds: [retired] }));
	assert.equal(retiredOnly.resolvedDistinctPeople, 0);

	const unknown = ok(await read(owner, "readAudience", { ...emptyAudience, groups: ["not-a-group"] }));
	assert.equal(unknown.resolvedDistinctPeople, 0);

	const doubledRole = await person("Two roles", { email: "two-roles@example.test" });
	const active = await team("active", "Active team");
	await tenure(await role(active, true), doubledRole);
	await tenure(await role(active, false), doubledRole);
	const oneTeam = ok(await read(owner, "readAudience", { ...emptyAudience, teamIds: [active] }));
	assert.equal(oneTeam.resolvedDistinctPeople, 1);
	assert.equal(oneTeam.duplicateAddressesRemoved, 0);
	assert.equal(oneTeam.eligibleRecipients, 1);

	const finders = [];
	for (let n = 1; n <= 21; n++)
		finders.push(await person(`Finder ${String(n).padStart(2, "0")}`, { email: `finder${n}@example.test` }));
	const found = ok(await read(owner, "readRecipients", { query: "Finder" }));
	assert.equal(found.people.length, 20);
	assert.equal(found.limit, 20);
	const allFinders = ok(await read(owner, "readAudience", { ...emptyAudience, personIds: finders }));
	assert.equal(allFinders.resolvedDistinctPeople, 21);
	assert.equal(allFinders.eligibleRecipients, 21);
});

test("AC:INH-COMMUNICATION-05 a preview drops a missing email and a repeated address", async () => {
	const before = await counts();
	const alex = await person("Alex", { email: "alex@example.test" });
	const casey = await person("Casey", { email: "casey@example.test" });
	const jamie = await person("Jamie");
	const preview = ok(
		await read(owner, "readPreview", {
			bodyHtml: "<p>Hello</p>",
			audience: { ...emptyAudience, personIds: [alex, alex, casey, jamie] },
		}),
	);
	assert.deepEqual(preview.eligibleEmails, ["alex@example.test", "casey@example.test"]);
	assert.deepEqual(preview.excludedMissingEmail, ["Jamie"]);
	assert.equal(preview.duplicateAddressesRemoved, 1);
	assert.equal(preview.providerCalls, 0);
	const after = await counts();
	assert.equal(after.communications, before.communications);
	assert.equal(after.intents, before.intents);
	assert.equal(after.attempts, before.attempts);
});

test("AC:CASE-COM-007 a plant fork replaces one system source and keeps referenced history", async () => {
	const beforeCatalog = catalog();
	const [first, second] = await Promise.all([
		write(owner, "forkTemplate", { requestKey: key(), input: { sourceKey: "general-announcement" } }),
		write(owner, "forkTemplate", { requestKey: key(), input: { sourceKey: "general-announcement" } }),
	]);
	ok(first);
	ok(second);
	const forks = await rows(
		sql`SELECT count(*)::int AS n FROM message_template WHERE plant_id = ${plant.id} AND source_key = 'general-announcement'`,
	);
	assert.equal(forks[0].n, 1);
	assert.deepEqual(catalog(), beforeCatalog);

	const systemMeeting = ok(await read(owner, "readMeetingTemplate", { meetingType: "vision_meeting" }));
	assert.equal(systemMeeting.origin, "system");
	assert.equal(systemMeeting.sourceKey, "vision-meeting-invitation");
	const vision = ok(
		await write(owner, "forkTemplate", { requestKey: key(), input: { sourceKey: "vision-meeting-invitation" } }),
	);
	const replaced = ok(await read(owner, "readMeetingTemplate", { meetingType: "vision_meeting" }));
	assert.equal(replaced.origin, "plant");
	assert.equal(replaced.templateId, vision.templateId);
	ok(
		await write(owner, "archiveTemplate", {
			requestKey: key(),
			expectedRevision: vision.revision,
			input: { templateId: vision.templateId },
		}),
	);
	const fallback = ok(await read(owner, "readMeetingTemplate", { meetingType: "vision_meeting" }));
	assert.equal(fallback.origin, "system");
	assert.equal(fallback.sourceKey, "vision-meeting-invitation");

	const orientation = ok(
		await write(owner, "forkTemplate", { requestKey: key(), input: { sourceKey: "orientation-invitation" } }),
	);
	const guest = await person("Orientation guest", { email: "orientation@example.test" });
	const linked = ok(
		await draft({
			subject: "Orientation",
			bodyHtml: "<p>Please come</p>",
			templateId: orientation.templateId,
			audience: { ...emptyAudience, personIds: [guest] },
		}),
	);
	const archived = ok(
		await write(owner, "archiveTemplate", {
			requestKey: key(),
			expectedRevision: orientation.revision,
			input: { templateId: orientation.templateId },
		}),
	);
	assert.equal(archived.archived, true);
	const stillThere = await rows(
		sql`SELECT archived_at IS NOT NULL AS archived FROM message_template WHERE id = ${orientation.templateId}`,
	);
	assert.equal(stillThere[0].archived, true);
	refused(
		await write(owner, "deleteTemplate", {
			requestKey: key(),
			expectedRevision: archived.revision,
			input: { templateId: orientation.templateId },
		}),
		"referenced",
	);
	const kept = await rows(sql`SELECT template_id FROM communication WHERE id = ${linked.communicationId}`);
	assert.equal(kept[0].template_id, orientation.templateId);

	const announcementFork = ok(first);
	ok(
		await write(owner, "deleteTemplate", {
			requestKey: key(),
			expectedRevision: announcementFork.revision,
			input: { templateId: announcementFork.templateId },
		}),
	);
	const listed = ok(await read(owner, "listTemplates"));
	const announcement = listed.templates.find((template) => template.sourceKey === "general-announcement");
	assert.equal(announcement.origin, "system");

	const teamSource = ok(
		await write(owner, "forkTemplate", { requestKey: key(), input: { sourceKey: "team-meeting-invitation" } }),
	);
	const scheduled = ok(
		await draft({
			subject: "Team night",
			bodyHtml: "<p>Team night</p>",
			templateId: teamSource.templateId,
			audience: { ...emptyAudience, personIds: [guest] },
		}),
	);
	const accepted = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: scheduled.revision,
			input: {
				communicationId: scheduled.communicationId,
				scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
			},
		}),
	);
	ok(
		await write(owner, "updateTemplate", {
			requestKey: key(),
			expectedRevision: teamSource.revision,
			input: {
				templateId: teamSource.templateId,
				patch: templateInput({
					name: teamSource.name,
					category: "meeting_invitation",
					meetingType: "team_meeting",
					subject: "Changed template subject",
					bodyHtml: "<p>Changed template</p>",
				}),
			},
		}),
	);
	const [unchanged] = await rows(
		sql`SELECT state, subject, body_html FROM communication WHERE id = ${scheduled.communicationId}`,
	);
	assert.equal(unchanged.state, "scheduled");
	assert.equal(unchanged.subject, "Team night");
	assert.equal(unchanged.body_html, "<p>Team night</p>");
	assert.equal(accepted.state, "scheduled");

	refused(await read(foreign, "getTemplate", { id: orientation.templateId }), "not_found");
	refused(
		await write(foreign, "updateTemplate", {
			requestKey: key(),
			expectedRevision: archived.revision,
			input: { templateId: orientation.templateId, patch: templateInput({ subject: "Foreign edit" }) },
		}),
		"not_found",
	);
	const [name] = await rows(sql`SELECT subject FROM message_template WHERE id = ${orientation.templateId}`);
	assert.notEqual(name.subject, "Foreign edit");
	refused(
		await write(member, "forkTemplate", { requestKey: key(), input: { sourceKey: "general-announcement" } }),
		"access_denied",
	);
	assert.deepEqual(catalog(), beforeCatalog);
});

test("AC:CASE-COM-012 drafts save and a reviewed schedule stays inside thirty days", async () => {
	const now = new Date("2026-10-13T16:00:00Z");
	assert.equal(scheduleAccepted(now, new Date("2026-11-12T16:00:00Z")), true);
	assert.equal(scheduleAccepted(now, new Date("2026-11-13T16:00:00Z")), false);

	const before = await counts();
	const incomplete = ok(await draft({ subject: null, bodyHtml: null }));
	assert.equal(incomplete.state, "draft");
	assert.equal(incomplete.subject, null);
	const loaded = ok(await read(owner, "getDraft", { id: incomplete.communicationId }));
	assert.equal(loaded.communicationId, incomplete.communicationId);
	assert.equal(loaded.state, "draft");
	ok(
		await write(owner, "deleteDraft", {
			requestKey: key(),
			expectedRevision: loaded.revision,
			input: { communicationId: loaded.communicationId },
		}),
	);
	refused(await read(owner, "getDraft", { id: incomplete.communicationId }), "not_found");

	const guest = await person("Schedule guest", { email: "schedule@example.test" });
	const saved = ok(
		await draft({
			subject: "Hold the date",
			bodyHtml: "<p>Hold the date</p>",
			audience: { ...emptyAudience, personIds: [guest] },
		}),
	);
	const mailBefore = await counts();
	refused(
		await write(owner, "saveDraft", {
			requestKey: key(),
			expectedRevision: "9",
			input: { communicationId: saved.communicationId, subject: "Stale" },
		}),
		"conflict",
	);
	const mailAfter = await counts();
	assert.equal(mailAfter.intents, mailBefore.intents);
	assert.equal(mailAfter.attempts, mailBefore.attempts);
	const [still] = await rows(sql`SELECT subject, state FROM communication WHERE id = ${saved.communicationId}`);
	assert.equal(still.subject, "Hold the date");
	assert.equal(still.state, "draft");

	const unsafe = ok(
		await draft({
			subject: "Unsafe",
			bodyHtml: "<script>alert(1)</script>",
			audience: { ...emptyAudience, personIds: [guest] },
		}),
	);
	refused(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: unsafe.revision,
			input: { communicationId: unsafe.communicationId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
		}),
		"invalid_input",
	);
	const missing = await person("No email");
	const unreachable = ok(
		await draft({
			subject: "Nobody",
			bodyHtml: "<p>Nobody</p>",
			audience: { ...emptyAudience, personIds: [missing] },
		}),
	);
	refused(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: unreachable.revision,
			input: {
				communicationId: unreachable.communicationId,
				scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
			},
		}),
		"invalid_input",
	);
	const [unsent] = await rows(sql`SELECT state FROM communication WHERE id = ${unreachable.communicationId}`);
	assert.equal(unsent.state, "draft");

	const soon = new Date(Date.now() + 86_400_000).toISOString();
	const accepted = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: soon },
		}),
	);
	assert.equal(accepted.scheduleStatus, "accepted");
	assert.equal(accepted.scheduleSent, false);
	assert.equal(accepted.draftIntents, 0);
	assert.equal(accepted.replacementIntents, 0);
	assert.equal(accepted.state, "scheduled");
	const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
	const moved = ok(
		await write(owner, "rescheduleReviewed", {
			requestKey: key(),
			expectedRevision: accepted.revision,
			input: { communicationId: saved.communicationId, scheduledAt: later },
		}),
	);
	assert.equal(moved.scheduleSent, false);
	assert.equal(moved.draftIntents, 0);
	const [kept] = await rows(
		sql`SELECT state, subject, body_html FROM communication WHERE id = ${saved.communicationId}`,
	);
	assert.equal(kept.state, "scheduled");
	assert.equal(kept.subject, "Hold the date");
	assert.equal(kept.body_html, "<p>Hold the date</p>");
	refused(
		await write(owner, "deleteDraft", {
			requestKey: key(),
			expectedRevision: moved.revision,
			input: { communicationId: saved.communicationId },
		}),
		"conflict",
	);

	const edgeGuest = await person("Edge guest", { email: "edge@example.test" });
	const edge = ok(
		await draft({
			subject: "Edge",
			bodyHtml: "<p>Edge</p>",
			audience: { ...emptyAudience, personIds: [edgeGuest] },
		}),
	);
	ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: edge.revision,
			input: {
				communicationId: edge.communicationId,
				scheduledAt: new Date(Date.now() + 30 * 86_400_000 - 5_000).toISOString(),
			},
		}),
	);
	const late = ok(
		await draft({
			subject: "Late",
			bodyHtml: "<p>Late</p>",
			audience: { ...emptyAudience, personIds: [edgeGuest] },
		}),
	);
	const window = refused(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: late.revision,
			input: {
				communicationId: late.communicationId,
				scheduledAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
			},
		}),
		"schedule_window_exceeded",
	);
	assert.equal(window.details.providerHandoffs, 0);
	const replaced = replaceScheduled();
	assert.equal(replaced.status, "refused");
	assert.equal(replaced.error.code, "cancel_unconfirmed");
	assert.equal(replaced.error.details.replacementIntents, 0);
	const after = await counts();
	assert.equal(after.intents, before.intents);
	assert.equal(after.attempts, before.attempts);
});
