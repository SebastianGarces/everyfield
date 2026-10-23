import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { owner, sessionId } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { createNotificationProducer, issueEmailOptOutToken } from "../../../packages/domain/src/notifications/index.ts";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const ci =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!ci && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw new Error("Only approved development or disposable CI database allowed");
if (!ci) source.searchParams.set("sslmode", "verify-full");
const schema = "wp030_" + randomUUID().replaceAll("-", "");
const role = "wp030_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const clock = { at: new Date("2026-10-23T15:00:00Z") };
const optOutKey = randomBytes(32);
const api = createNotificationProducer({ optOutKey, now: () => clock.at });
const orgs = createOrganizationAdapter(
	{
		invitation: async () => {},
		notice: () => sql`UPDATE account SET id = id WHERE false`,
		invalidate: () => sql`UPDATE account SET id = id WHERE false`,
	},
	{ candidates: async () => [] },
);
let db;
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const denied = (r, code) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
};
const command = (input, expectedRevision = "1") => ({ requestKey: randomUUID(), expectedRevision, input });
async function actor(session) {
	const resolved = await RequestActor.resolve(db, sessionId.parse(session));
	if (!(resolved instanceof RequestActor)) throw new Error("session unavailable");
	return resolved;
}
async function identity(selected, seatRole = "owner") {
	const user = randomUUID(),
		account = randomUUID(),
		handle = randomUUID();
	const kind =
		selected?.kind === "plant"
			? "planter"
			: selected?.kind === "organization"
				? selected.organizationKind === "sending_church"
					? "sending_church"
					: "network"
				: "discovery";
	await admin.execute(
		sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES(${user},'Synthetic',${user + "@example.test"},true)`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${account},${user},'active',${kind})`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${handle},${user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	if (selected)
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at) VALUES(${account},${selected.kind === "plant" ? selected.id : null},${selected.kind === "organization" ? selected.id : null},${seatRole},clock_timestamp())`,
		);
	return { id: account, session: handle, selected: selected ?? owner.parse({ kind: "account", id: account }) };
}
async function plant(name = "Harvest") {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},${name},'America/Chicago',7,14,0,16,1,1)`,
	);
	return owner.parse({ kind: "plant", id });
}
async function organization(kind, name) {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${id},${kind},${name},'America/Chicago',1)`,
	);
	return owner.parse({ kind: "organization", id, organizationKind: kind });
}
async function task(plantId) {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date) VALUES(${id},${plantId},'Call','general','medium','not_started',clock_timestamp(),'date_only','2026-10-13')`,
	);
	return id;
}
async function notice(row) {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,safe_body,eligible_at,created_at,schedule_date,timezone)
			VALUES(${id},${row.tenant},${row.recipient},${row.category},${row.purpose},${row.key},${row.source},${row.revision ?? 1},${row.title},${row.body ?? null},${row.eligible},${row.created ?? sql`clock_timestamp()`},${row.due ?? null},${row.zone ?? "America/Chicago"})`,
	);
	return id;
}
const count = async (q) => Number((await admin.execute(q)).rows[0].n);
async function orgCall(name, person, input) {
	return db.transaction(async (tx) => {
		if (!(await RequestActor.claimWrite(tx, sessionId.parse(person.session), person.selected)))
			throw new Error("unavailable");
		return orgs[name](tx, sessionId.parse(person.session), person.selected, input);
	});
}

before(
	async () => {
		await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
		await migrate(admin, schema);
		const password = randomBytes(32).toString("hex");
		await admin.execute(
			sql.raw(
				`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
			),
		);
		await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
		const url = new URL(source);
		url.username = role;
		url.password = password;
		db = createDatabase({ connectionString: url.href, max: 4, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	},
	{ timeout: 180_000 },
);
after(async () => {
	if (db) await closeDatabase(db);
	await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
	await closeDatabase(admin);
});

test("AC:CASE-NTF-003 AC:NOTIFY47-001 AC:NOTIFY47-010 the feed and mark stay inside one recipient", async () => {
	const church = await plant();
	const a = await identity(church);
	const b = await identity();
	const work = await task(church.id);
	const due = await notice({
		tenant: church.id,
		recipient: a.id,
		category: "task",
		purpose: "task_due",
		key: `${church.id}/task_due/${work}/1/due`,
		source: work,
		title: "Due today",
		eligible: "2026-10-13T22:00:00Z",
		due: "2026-10-13",
	});
	const future = await notice({
		tenant: church.id,
		recipient: a.id,
		category: "task",
		purpose: "task_due",
		key: `${church.id}/task_due/${work}/1/future`,
		source: work,
		title: "Later",
		eligible: "2026-10-25T16:00:00Z",
	});
	const foreign = await notice({
		tenant: church.id,
		recipient: b.id,
		category: "task",
		purpose: "task_due",
		key: `${church.id}/task_due/${work}/1/foreign`,
		source: work,
		title: "Other inbox",
		eligible: "2026-10-13T22:00:00Z",
	});
	const reader = await actor(a.session);
	const feed = ok(await api.readFeed(db, reader, { asOf: "2026-10-14T03:00:00Z" }));
	const item = feed.items.find((row) => row.id === due);
	assert.ok(item);
	assert.equal(item.dueLocalDate, "2026-10-13");
	assert.equal(item.overdue, false);
	assert.equal(
		feed.items.some((row) => row.id === future || row.id === foreign),
		false,
	);
	assert.equal(ok(await api.readUnreadCount(db, reader, {})).count, 1);
	denied(await api.markRead(db, reader, command({ noticeId: foreign })), "access_denied");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM notice WHERE id=${foreign} AND read_at IS NULL`), 1);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM task WHERE id=${work} AND status='not_started'`), 1);
	const marked = ok(await api.markAllVisibleRead(db, reader, command({})));
	assert.deepEqual(marked.markedIds, [due]);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM notice WHERE id=${future} AND read_at IS NULL`), 1);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM notice WHERE id=${foreign} AND read_at IS NULL`), 1);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM task WHERE id=${work} AND status='not_started'`), 1);
	assert.deepEqual(ok(await api.markRead(db, reader, command({ noticeId: due }, "1"))).markedIds, [due]);
	const selected = ok(await api.markSelectedRead(db, reader, command({ noticeIds: [due, foreign] }, "1")));
	assert.deepEqual(selected.markedIds, [due]);
	await admin.execute(sql`INSERT INTO notice(tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,eligible_at,created_at,timezone)
		SELECT ${church.id},${a.id},'task','task_due',${church.id} || '/task_due/' || ${work} || '/' || g::text || '/bulk',${work},g,'Bulk',clock_timestamp()-(g || ' minutes')::interval,clock_timestamp(),'America/Chicago'
		FROM generate_series(1,60) g`);
	const first = ok(await api.readFeed(db, reader, {}));
	const second = ok(await api.readFeed(db, reader, { cursor: first.nextCursor }));
	assert.equal(first.items.length, 50);
	assert.equal(second.items.length, 11);
	assert.equal(
		second.items.some((row) => row.id === first.items.at(-1).id),
		false,
	);
	assert.equal(ok(await api.readUnreadCount(db, reader, {})).count, 60);
	const meeting = randomUUID();
	await admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,creator_id,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${meeting},${church.id},'vision_meeting','Vision',${a.id},'2026-10-13','18:00','America/Chicago','2026-10-13T23:00:00Z','1','completed',1)`,
	);
	assert.deepEqual(
		ok(await api.readMeetingAudience(db, reader, { plantId: church.id, meetingId: meeting })).recipientIds,
		[a.id],
	);
	const upcoming = await notice({
		tenant: church.id,
		recipient: a.id,
		category: "task",
		purpose: "task_due",
		key: `${church.id}/task_due/${work}/2/upcoming`,
		source: work,
		revision: 2,
		title: "Upcoming",
		eligible: "2026-10-30T16:00:00Z",
	});
	const cancelled = ok(await api.cancelTaskReminders(db, reader, command({ plantId: church.id, taskId: work })));
	assert.deepEqual(cancelled.cancelledIds.sort(), [future, upcoming].sort());
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM notice WHERE id=${due} AND cancelled_at IS NULL`), 1);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM task WHERE id=${work} AND status='not_started'`), 1);
});

test("AC:CASE-NTF-004 AC:CASE-NTF-012 AC:NOTIFY47-002 AC:NOTIFY47-004 AC:TARGET-IDN-012 preferences do not send mail or change another account", async () => {
	const church = await plant();
	const a = await identity(church);
	const b = await identity();
	const reader = await actor(a.session);
	const other = await actor(b.session);
	const prefs = ok(await api.getPreferences(db, reader, {}));
	assert.equal(prefs.suppression, "unavailable");
	assert.equal(prefs.explicitEmail.includes("wiki_upstream_review"), false);
	assert.deepEqual(
		prefs.choices.find((choice) => choice.category === "wiki_upstream_review"),
		{ category: "wiki_upstream_review", channel: "in_app", enabled: true },
	);
	assert.equal(
		prefs.choices.find((choice) => choice.category === "task_due" && choice.channel === "email").enabled,
		true,
	);
	assert.equal(
		prefs.choices.find((choice) => choice.category === "planter_digest" && choice.channel === "in_app").enabled,
		false,
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM notification_preference WHERE account_id=${a.id}`), 0);
	const beforeMail = await count(sql`SELECT count(*)::int AS n FROM mail`);
	const saved = ok(
		await api.setPreference(
			db,
			reader,
			command({ choice: { category: "task_due", channel: "email", enabled: false } }),
		),
	);
	assert.equal(saved.changed, true);
	assert.equal(ok(await api.getPreferences(db, other, {})).revision, "1");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM notification_preference WHERE account_id=${b.id}`), 0);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM mail`), beforeMail);
	const again = ok(
		await api.setPreference(
			db,
			reader,
			command({ choice: { category: "task_due", channel: "email", enabled: false } }, saved.revision),
		),
	);
	assert.equal(again.changed, false);
	assert.equal(again.revision, saved.revision);
	ok(
		await api.setPreferences(
			db,
			reader,
			command(
				{
					choices: [
						{ category: "task_due", channel: "in_app", enabled: true },
						{ category: "planter_digest", channel: "email", enabled: true },
					],
				},
				saved.revision,
			),
		),
	);
	const discovery = await actor((await identity()).session);
	denied(
		await api.setDigestCadence(db, discovery, command({ plantId: church.id, cadence: "weekly" })),
		"access_denied",
	);
	const cadence = ok(await api.setDigestCadence(db, reader, command({ plantId: church.id, cadence: "weekly" }, "3")));
	assert.equal(cadence.cadence, "weekly");
	const after = ok(await api.getPreferences(db, reader, {}));
	assert.equal(after.planterCadence, "weekly");
	assert.equal(
		after.choices.find((choice) => choice.category === "planter_digest" && choice.channel === "in_app").enabled,
		false,
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM mail`), beforeMail);
	const wall = { plantId: church.id, wall: "2026-10-18T16:00:00", zone: "America/Chicago" };
	const first = ok(await api.readPlanterDigest(db, reader, wall));
	const second = ok(await api.readPlanterDigest(db, reader, wall));
	assert.equal(Date.parse(first.sendAt), Date.parse("2026-10-18T21:00:00Z"));
	assert.equal(second.sendAt, first.sendAt);
	assert.equal(first.logicalIntents, 1);
	assert.equal(first.inAppDigest, false);
	assert.equal(first.mailIntents, 0);
	ok(await api.readPlanterDigest(db, reader, { plantId: church.id }));
	const exp = "2026-10-13T16:00:00Z";
	clock.at = new Date(exp);
	const expired = issueEmailOptOutToken(optOutKey, {
		purpose: "disable",
		accountId: a.id,
		category: "phase_milestone",
		exp,
		unsubscribeRevision: "0",
	});
	const described = ok(await api.describeEmailOptOut(db, reader, { token: expired }));
	assert.equal(described.expired, true);
	assert.equal(described.changed, false);
	assert.equal(described.inAppEnabled, true);
	const refused = ok(await api.applyEmailOptOut(db, { token: expired, oneClick: true }));
	assert.equal(refused.changed, false);
	assert.equal(refused.emailEnabled, true);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM account WHERE id=${a.id} AND revision::text=${after.revision}`),
		1,
	);
	clock.at = new Date("2026-10-14T00:00:00Z");
	const token = issueEmailOptOutToken(optOutKey, {
		purpose: "disable",
		accountId: a.id,
		category: "meeting_announcement",
		exp: "2027-04-11T00:00:00Z",
		unsubscribeRevision: "0",
	});
	const applied = ok(await api.applyEmailOptOut(db, { token, oneClick: true }));
	assert.equal(applied.changed, true);
	assert.equal(applied.emailEnabled, false);
	assert.equal(applied.inAppEnabled, true);
	assert.ok(applied.undoToken);
	const repeat = ok(await api.applyEmailOptOut(db, { token }));
	assert.equal(repeat.changed, false);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM notification_preference WHERE account_id=${a.id} AND category='meeting_announcement' AND channel='email' AND enabled=false`,
		),
		1,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM notification_preference WHERE account_id=${a.id} AND category='meeting_announcement' AND channel='in_app'`,
		),
		0,
	);
	const undone = ok(await api.undoEmailOptOut(db, { token: applied.undoToken }));
	assert.equal(undone.emailEnabled, true);
	assert.equal(undone.changed, true);
	denied(await api.describeEmailOptOut(db, reader, { token: "not-a-token" }), "access_denied");
});

test("AC:AF-030 AC:AF-032 AC:AF-033 AC:CASE-NTF-008 AC:NOTIFY47-005 AC:TARGET-IDN-022 oversight counts shared activity only", async () => {
	const church = await plant("Planter");
	const planter = await identity(church);
	const south = await organization("sending_church", "South");
	const north = await organization("sending_network", "North");
	const southOwner = await identity(south);
	const northOwner = await identity(north);
	const link = async (org, activity) => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${id},${church.id},${org.id},clock_timestamp(),false,false,false,false,false,${activity},false)`);
		return id;
	};
	const southLink = await link(south, true);
	const northLink = await link(north, true);
	const plantActor = await actor(planter.session);
	const changed = await orgCall(
		"privacy.setSharing",
		planter,
		command({
			plant: church,
			organization: south,
			relationshipId: southLink,
			expectedConsentRevision: "1",
			category: "activity",
			enabled: false,
		}),
	);
	assert.equal(changed.status, "committed");
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM affiliation WHERE id=${southLink} AND share_activity=false AND shared_findings=false`,
		),
		1,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM affiliation WHERE id=${northLink} AND share_activity=true AND ended_at IS NULL`,
		),
		1,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE action='sharing.changed' AND subject_id=${southLink}`,
		),
		1,
	);
	await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
		VALUES(${church.id},${planter.id},'tasks.changed','edit','record',${church.id},jsonb_build_object('secret','PRIVATE-CARE-MARKER'))`);
	await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,reason,metadata)
		VALUES(${church.id},${planter.id},'note_correction','correct','record',${church.id},'PRIVATE-CARE-MARKER',jsonb_build_object('body','PRIVATE-CARE-MARKER'))`);
	const northReader = await actor(northOwner.session);
	const preview = ok(
		await api.readOversightDigest(db, northReader, {
			organizationId: north.id,
			organizationKind: "sending_network",
			period: "current",
		}),
	);
	assert.equal(preview.mailIntents, 0);
	assert.deepEqual(preview.plants, [church.id]);
	assert.equal(preview.lines.length, 1);
	assert.equal(JSON.stringify(preview).includes("PRIVATE-CARE-MARKER"), false);
	assert.equal(preview.lines[0].count, 1);
	const quiet = ok(
		await api.readOversightDigest(db, await actor(southOwner.session), {
			organizationId: south.id,
			organizationKind: "sending_church",
			period: "owed_catchup",
		}),
	);
	assert.deepEqual(quiet.lines, []);
	assert.deepEqual(quiet.plants, []);
	assert.equal(quiet.mailIntents, 0);
	denied(
		await api.readOversightDigest(db, northReader, {
			organizationId: south.id,
			organizationKind: "sending_church",
			period: "current",
		}),
		"access_denied",
	);
	const revision = (await admin.execute(sql`SELECT revision::text AS revision FROM affiliation WHERE id=${southLink}`))
		.rows[0].revision;
	const ended = await orgCall(
		"associations.end",
		southOwner,
		command(
			{
				relationshipId: southLink,
				pair: { kind: "plant", subject: church, organization: south },
				confirmed: true,
				reason: "Ended in the notification test",
			},
			revision,
		),
	);
	assert.equal(ended.status, "committed");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM affiliation WHERE id=${southLink} AND ended_at IS NOT NULL`),
		1,
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM affiliation WHERE id=${northLink} AND ended_at IS NULL`),
		1,
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM plant WHERE id=${church.id}`), 1);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${planter.id} AND ended_at IS NULL`),
		1,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE action='affiliation.ended' AND subject_id=${southLink}`,
		),
		1,
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM notice WHERE purpose='relationship_decision'`), 0);
	ok(
		await api.setOversightDigestCadence(
			db,
			northReader,
			command({ organizationId: north.id, organizationKind: "sending_network", cadence: "daily" }),
		),
	);
	assert.equal(ok(await api.getPreferences(db, northReader, {})).oversightCadence, "daily");
	void plantActor;
});

test("AC:CASE-NTF-014 AC:NOTIFY47-009 AC:WIKI52-002 wiki notices stay in the app for current editors", async () => {
	const network = await organization("sending_network", "Editors");
	const editor = await identity(network);
	const revoked = await identity(network, "admin");
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${revoked.id}`);
	const article = randomUUID(),
		state = randomUUID();
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article',${"synthetic-" + article},'00000000-0000-0000-0000-000000000000')`,
	);
	await admin.execute(
		sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,revision) VALUES(${state},${network.id},${article},'published',1)`,
	);
	const reader = await actor(editor.session);
	const publish = (revision, title) =>
		api.publishWikiUpstream(
			db,
			reader,
			command({
				organizationId: network.id,
				organizationKind: "sending_network",
				sourceId: article,
				sourceRevision: revision,
				title,
			}),
		);
	const typo = ok(await publish("1", "Typo"));
	const meaningful = ok(await publish("2", "Meaningful update"));
	assert.equal(typo.emailIntents, 0);
	assert.equal(meaningful.autoAdoptions, 0);
	assert.deepEqual(typo.recipientIds, [editor.id]);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM mail WHERE tenant_id=${network.id}`), 0);
	assert.deepEqual(
		(await admin.execute(sql`SELECT state,revision::text AS revision FROM article_editor_state WHERE id=${state}`))
			.rows[0],
		{ state: "published", revision: "1" },
	);
	const feed = ok(await api.readFeed(db, reader, {}));
	assert.deepEqual(feed.items.map((item) => item.title).sort(), ["Meaningful update", "Typo"]);
	const hidden = ok(await api.readFeed(db, await actor(revoked.session), {}));
	assert.deepEqual(hidden.items, []);
	const producers = ok(
		await api.readProducers(db, reader, { requested: ["team_health", "snooze", "NeedsYou", "Wiki_upstream"] }),
	);
	assert.equal(producers.implementedNewProducer, "Wiki_upstream");
	assert.equal(producers.genericRulesEngine, false);
	assert.equal(producers.unusedHelpersEnabled, false);
	assert.equal(producers.producers.includes("wiki_upstream_review"), true);
	assert.equal(producers.excluded.includes("NeedsYou"), true);
	const plantsBefore = await count(sql`SELECT count(*)::int AS n FROM plant`);
	const audience = ok(
		await api.readAssociationAudience(db, reader, { organizationId: network.id, discoveryAccountId: editor.id }),
	);
	assert.deepEqual(audience.recipientIds, [editor.id]);
	assert.equal(audience.phantomPlantCreated, false);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM plant`), plantsBefore);
	const adminSeat = await identity();
	await admin.execute(
		sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${adminSeat.id},${network.id},'admin',clock_timestamp())`,
	);
	const operation = randomUUID();
	await admin.execute(sql`INSERT INTO mail(tenant_id,recipient_account_id,purpose,logical_key,payload_hash,audience_hash,state,created_at)
		VALUES(${editor.id},${editor.id},'discovery_receipt',${"association/" + operation + "/once/" + editor.id},'hash','audience','refused',clock_timestamp())`);
	const receipt = ok(
		await api.readAssociationReceipt(db, reader, { organizationId: network.id, operationId: operation }),
	);
	assert.deepEqual(receipt.recipients, [{ accountId: editor.id, state: "refused" }]);
	assert.equal(JSON.stringify(receipt).includes("hash"), false);
	const seen = ok(
		await api.readAssociationAudience(db, reader, { organizationId: network.id, discoveryAccountId: editor.id }),
	);
	assert.equal(seen.recipientIds.includes(adminSeat.id), false);
});
