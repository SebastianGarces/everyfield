import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { createNotificationService, type NoticeInput } from "../../../packages/domain/src/jobs/notifications.ts";
import { accountNotificationService } from "../../../packages/domain/src/jobs/seated-notifications.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { guestsWriter, meetingsReader, meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { createPhaseWriter } from "../../../packages/domain/src/phases/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { phaseNotices } from "../../../apps/web/src/features/phases/notices.ts";
import { ok, refused, refusedWith } from "../../support/fixture.mts";
import { NOTHING, recorded, untouched } from "../../support/recorded.mts";
import { caseOf, casesWorld, command, day, type CasesWorld } from "./cases-world.mts";

let w: CasesWorld;
beforeEach(async () => {
	w = await casesWorld("notice_cases", "2026-10-01T16:00:00Z");
});
afterEach(() => w?.close());

const noticesOf = (recipient: string) => sql`SELECT count(*)::int AS n FROM notice WHERE recipient_id=${recipient}`;
async function movement(plantId: string) {
	const [id, operation] = [randomUUID(), randomUUID()];
	await w.admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_token,action,kind,subject_type,subject_id)
		VALUES(${operation},${plantId},'synthetic','phase.transitioned','edit','plant',${plantId})`);
	await w.admin
		.execute(sql`INSERT INTO phase_transition(id,plant_id,kind,from_phase,to_phase,reason,occurred_at,recorded_at,operation_id)
		VALUES(${id},${plantId},'movement',1,2,'Synthetic',clock_timestamp(),clock_timestamp(),${operation})`);
	return id;
}
async function reseated(who: Awaited<ReturnType<typeof w.seated>>, workspace: Parameters<typeof w.seat>[1]) {
	await w.admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${who.id} AND ended_at IS NULL`,
	);
	await w.seat(who, workspace, "admin");
	const actor = await RequestActor.resolve(w.db, who.session);
	assert.ok(actor instanceof RequestActor);
	return { ...who, actor };
}
const unread = async (who: { actor: RequestActor }) => ok(await w.feed.readUnreadCount(w.db, who.actor, {})).count;
const feedOf = async (who: { actor: RequestActor }, input: object = {}) =>
	ok(await w.feed.readFeed(w.db, who.actor, input));

test("AC:CASE-NTF-001 two organizations each get their own notice of one occurrence, while a forged owner, a foreign source and a switched-off category get none", async () => {
	const c = caseOf("CASE-NTF-001");
	await w.at(c.clock.now);
	const second = c.given.execution.additional_calls[0];
	assert.deepEqual([c.action.arguments.occurrence, second.arguments.occurrence], ["event-1", "event-1"]);
	let A = await w.seated(w.tenant, "admin");
	const orgs = {
		S1: await w.organization("sending_church", "S1"),
		N1: await w.organization("sending_network", "N1"),
	};
	for (const org of Object.values(orgs)) await w.affiliate(w.plant.id, org.id);
	const source = await movement(w.plant.id);
	const services = {
		phase_milestone: accountNotificationService(w.mails.phases),
		other: accountNotificationService(w.mails.notifications),
	};
	const input = (organization: "S1" | "N1"): NoticeInput => ({
		owner: orgs[organization],
		recipient: A.id,
		source: { kind: "phase_transition", id: source, revision: "1" },
		category: "phase_milestone",
		occurrence: c.action.arguments.occurrence,
		title: "P moved to Phase 2",
		text: "P moved from Phase 1 to Phase 2.",
		operation: null,
		eligibleAt: "2026-10-13T16:00:00Z",
	});
	const enqueue = (value: NoticeInput) =>
		transaction(w.db, (tx) =>
			(value.category === "phase_milestone" ? services.phase_milestone : services.other).enqueue(tx, value),
		);
	const M1 = await w.schedule({
		date: "2026-10-20",
		time: "10:00",
		guests: [await w.person("A", { account: A.id })],
	});
	const meeting = (organization: boolean, recipient = A.id): NoticeInput => ({
		...input("S1"),
		owner: organization ? orgs.S1 : { kind: "plant", id: w.plant.id },
		recipient,
		source: { kind: "meeting", id: M1.id, revision: M1.revision },
		category: "meeting_reminder",
	});
	await untouched(w.admin, () =>
		assert.rejects(
			enqueue(meeting(true)),
			/notification_source_stale/,
			"a meeting is its plant's, never an organization's",
		),
	);
	const choices = ["meeting_announcement", "meeting_reminder"].flatMap((category) =>
		["in_app", "email"].map((channel) => ({ category, channel, enabled: false })),
	);
	assert.equal(c.given["case-input"].revoked_category, "meetings");
	ok(await w.feed.setPreferences(w.db, A.actor, command({ choices }, await w.revisionOf(A.id))));
	const revoked = await untouched(w.admin, () => enqueue(meeting(false)));
	assert.deepEqual(revoked, { notice: null, mail: null });
	const open = await recorded(w.admin, () => enqueue(meeting(false, w.adminActor.id)));
	assert.deepEqual([open.added.notices, open.added.mail], [1, 1], "a recipient who kept the category gets it");

	const calls = [c.action, second] as { operation: string; arguments: { organization: "S1" | "N1" } }[];
	for (const call of calls) {
		const organization = call.arguments.organization;
		A = await reseated(A, orgs[organization]);
		const { value, added } = await recorded(w.admin, () => enqueue(input(organization)));
		assert.deepEqual(added, { ...NOTHING, notices: 1, mail: 1, jobs: ["mail"] }, organization);
		const again = await untouched(w.admin, () => enqueue(input(organization)));
		assert.deepEqual(again, value, "the same occurrence at one organization stays one notice");
	}
	const intents = await w.rows<{ tenant: string; key: string }>(
		sql`SELECT tenant_id AS tenant, split_part(logical_key,'/',5) AS key FROM notice WHERE source_record_id=${source}`,
	);

	const foreign = await w.newPlant({ name: "Q" });
	const foreignSource = await movement(foreign.id);
	const answers = [];
	for (const id of [foreignSource, randomUUID()])
		for (const owner of [orgs.S1, { kind: "plant" as const, id: w.plant.id }])
			answers.push(
				await untouched(w.admin, () =>
					enqueue({
						...input("S1"),
						owner,
						occurrence: "event-2",
						source: { kind: "phase_transition", id, revision: "1" },
					}).then(
						() => "sent",
						(e: Error) => e.message,
					),
				),
			);
	const forged: [Partial<NoticeInput>, RegExp][] = [
		[{ owner: { ...orgs.S1, organizationKind: "sending_network" } }, /^notification_owner_mismatch$/],
		[{ owner: { ...orgs.S1, id: randomUUID() } }, /^notification_owner_mismatch$/],
		[{ owner: { kind: "plant", id: orgs.S1.id } }, /^notification_owner_mismatch$/],
		[{ owner: { ...orgs.S1, id: w.plant.id } }, /^notification_owner_mismatch$/],
		[{ source: { kind: "task", id: source, revision: "1" } }, /^notification_source_mismatch$/],
	];
	for (const [change, message] of forged)
		await untouched(w.admin, () =>
			assert.rejects(enqueue({ ...input("S1"), occurrence: "event-2", ...change }), (e: Error) =>
				message.test(e.message),
			),
		);

	assert.deepEqual(
		{
			logical_intents: intents.length,
			cross_org_deduplication: new Set(intents.map((i) => i.tenant)).size < intents.length,
			revoked_category_intents: await w.count(
				sql`SELECT count(*)::int AS n FROM notice WHERE recipient_id=${A.id} AND category='meeting'`,
			),
			foreign_anchor_disclosed: new Set(answers).size > 1 || answers.includes("sent"),
		},
		c.expected.result,
	);
	assert.deepEqual(new Set(answers), new Set(["notification_source_stale"]));
	assert.deepEqual(new Set(intents.map((i) => i.key)), new Set(["event-1"]));
});

test("AC:CASE-NTF-003 the feed shows only due, live entries under current grants, a task due today is not overdue, and mark-all marks exactly the visible page", async () => {
	const c = caseOf("CASE-NTF-003");
	const { local_due, now, zone } = c.action.arguments;
	assert.equal(zone, c.clock.zone);
	const plant = await w.newPlant({ name: "P", timezone: zone });
	const Q = await w.newPlant({ name: "Q", timezone: "America/New_York" });
	await w.at("2026-10-12T13:00:00Z");
	const network = await w.organization("sending_network", "Revoked network");
	let A = await w.seated(network, "admin");
	const B = await w.seated(Q, "admin");
	await w.affiliate(plant.id, network.id);
	const source = await movement(plant.id);
	const service = accountNotificationService(w.mails.phases);
	await transaction(w.db, (tx) =>
		service.enqueue(tx, {
			owner: network,
			recipient: A.id,
			source: { kind: "phase_transition", id: source, revision: "1" },
			category: "phase_milestone",
			occurrence: "revoked",
			title: "Revoked organization",
			text: "Hidden.",
			operation: null,
			eligibleAt: "2026-10-12T13:00:00Z",
		}),
	);
	assert.deepEqual(
		(await feedOf(A)).items.map((i) => i.title),
		["Revoked organization"],
	);
	A = await reseated(A, plant);
	const assigneeIds = [A.id];
	const due = await w.task(A, { title: "Due", assigneeIds, due: day(local_due) });
	const read = await w.task(A, { title: "Read", assigneeIds, due: day(local_due) });
	const cancelled = await w.task(A, { title: "Cancelled", assigneeIds, due: day(local_due) });
	await w.task(B, { title: "Foreign", assigneeIds: [B.id], due: day(local_due) });
	const past = await w.task(A, { title: "Past", assigneeIds, due: day("2026-10-12") });
	await w.at(now);
	await w.change(A, "changeStatus", cancelled, { status: "no_longer_needed" });
	const entry = async (task: string) =>
		String((await w.one(sql`SELECT id FROM notice WHERE source_record_id=${task} ORDER BY eligible_at`)).id);
	ok(await w.feed.markRead(w.db, A.actor, command({ noticeId: await entry(read.id) }, await w.revisionOf(A.id))));
	const feed = await untouched(w.admin, () => feedOf(A));
	assert.deepEqual(feed.items.map((i) => [i.title, i.dueLocalDate, i.overdue, i.read]).sort(), [
		["Task due: Due", local_due, false, false],
		["Task due: Past", "2026-10-12", true, false],
		["Task due: Read", local_due, false, true],
		["Task overdue: Past", "2026-10-12", true, false],
	]);
	const item = feed.items.find((i) => i.title === "Task due: Due")!;
	assert.deepEqual({ due_local_date: item.dueLocalDate, overdue: item.overdue }, c.expected.result);
	assert.equal(await unread(A), 3, "future, cancelled, revoked and foreign entries are not counted");
	assert.equal((await feedOf(A, { unread: true })).items.length, 3);
	const control = c.action.arguments.foreign_control;
	assert.deepEqual([control.actor, control.context, control.subject], ["B", "Q", "P"]);
	assert.deepEqual(
		(await feedOf(B)).items.map((i) => i.title),
		["Task due: Foreign"],
		"another church's Admin sees none of P",
	);
	for (const noticeId of [item.id, randomUUID()])
		refusedWith({ details: {}, hidden: [item.id, "Due", plant.id] })(
			await untouched(w.admin, async () =>
				w.feed.markRead(w.db, B.actor, command({ noticeId }, await w.revisionOf(B.id))),
			),
			"access_denied",
		);
	const hidden = await w.rows<{ id: string }>(
		sql`SELECT id FROM notice WHERE recipient_id=${A.id} AND (eligible_at>${now}::timestamptz OR cancelled_at IS NOT NULL OR tenant_id=${network.id})`,
	);
	assert.equal(hidden.length, 5);
	for (const { id } of hidden)
		refused(
			await untouched(w.admin, async () =>
				w.feed.markRead(w.db, A.actor, command({ noticeId: id }, await w.revisionOf(A.id))),
			),
			"access_denied",
		);
	for (let n = 0; n < 51; n++) await w.task(A, { title: `Row ${n}`, assigneeIds, due: day("2026-10-13") });
	await w.admin.execute(
		sql`UPDATE notice SET eligible_at='2026-10-13T15:00:00Z' WHERE recipient_id=${A.id} AND title LIKE 'Task overdue: Row %'`,
	);
	const page = await feedOf(A, { unread: true });
	const rest = await feedOf(A, { unread: true, cursor: page.nextCursor });
	assert.deepEqual([page.items.length, rest.items.length, rest.nextCursor], [50, 4, null]);
	assert.equal(new Set([...page.items, ...rest.items].map((i) => i.id)).size, 54);
	const cutoff = page.items[0]!.eligibleAt;
	const marked = ok(
		await w.feed.markAllVisibleRead(w.db, A.actor, command({ cutoff }, await w.revisionOf(A.id))),
	).markedIds;
	assert.deepEqual([...marked].sort(), [...page.items, ...rest.items].map((i) => i.id).sort());
	assert.equal(await unread(A), 0);
	assert.equal(
		await w.count(
			sql`SELECT count(*)::int AS n FROM notice WHERE read_at IS NOT NULL AND (recipient_id=${B.id} OR id IN (${sql.join(
				hidden.map((h) => sql`${h.id}`),
				sql`,`,
			)}))`,
		),
		0,
	);
	assert.deepEqual(await w.rows(sql`SELECT DISTINCT status FROM task WHERE id IN (${due.id},${read.id},${past.id})`), [
		{ status: "not_started" },
	]);
	assert.equal(await unread(B), 1);
});

test("AC:NOTIFY47-001 mark-all marks the visible notice only, completes no task, shows no other inbox and a cadence change marks nothing", async () => {
	const c = caseOf("NOTIFY47-001");
	const { rows: given, mark_all } = c.action.arguments;
	assert.equal(mark_all, true);
	await w.at("2026-10-12T13:00:00Z");
	const plant = await w.newPlant({ name: "Inbox" });
	const A = await w.seated(plant, "admin");
	const B = await w.seated(plant, "member");
	const t = await w.task(A, { title: "T", assigneeIds: [A.id], due: day("2026-10-13") });
	const gone = await w.task(A, { title: "Gone", assigneeIds: [A.id], due: day("2026-10-13") });
	await w.task(A, { title: "Theirs", assigneeIds: [B.id], due: day("2026-10-13") });
	await w.at(c.clock.now);
	await w.change(A, "changeStatus", gone, { status: "no_longer_needed" });
	const stored = async (task: string) =>
		(await w.rows<{ id: string }>(sql`SELECT id FROM notice WHERE source_record_id=${task} ORDER BY eligible_at`)).map(
			(n) => n.id,
		);
	const [n1, n2] = await stored(t.id);
	const hidden = [n2!, ...(await stored(gone.id))];
	const label = new Map<string, string>([[n1!, "N1"], ...hidden.map((id) => [id, "N2"] as const)]);
	assert.deepEqual(
		given.map((r: { id: string; visible: boolean }) => [r.id, r.visible]),
		[
			["N1", true],
			["N2", false],
		],
	);
	assert.deepEqual(
		(await feedOf(A)).items.map((i) => label.get(i.id)),
		["N1"],
	);
	ok(
		await w.feed.setDigestCadence(
			w.db,
			A.actor,
			command({ plantId: plant.id, cadence: "weekly" }, await w.revisionOf(A.id)),
		),
	);
	assert.equal(await unread(A), 1, "changing the cadence marks nothing");
	const cutoff = (await feedOf(A)).items[0]!.eligibleAt;
	const request = command({ cutoff }, await w.revisionOf(A.id));
	const { value, added } = await recorded(w.admin, () => w.feed.markAllVisibleRead(w.db, A.actor, request));
	assert.deepEqual(added, { ...NOTHING, audits: ["settings.changed"] });
	const isRead = async (ids: string[]) =>
		(await w.count(
			sql`SELECT count(*)::int AS n FROM notice WHERE read_at IS NOT NULL AND id IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`,`,
			)})`,
		)) > 0;
	const theirs = (await feedOf(B)).items;
	assert.deepEqual(
		theirs.map((i) => [i.title, i.read]),
		[["Task due: Theirs", false]],
	);
	const shownTo = async (who: typeof A) =>
		JSON.stringify([await feedOf(who), await unread(who)]).includes(theirs[0]!.id) ? theirs : null;
	assert.deepEqual(
		{
			marked_ids: ok(value).markedIds.map((id) => label.get(id)),
			N2_read: await isRead(hidden),
			task_complete: (await w.one(sql`SELECT status FROM task WHERE id=${t.id}`)).status === "complete",
			foreign_inbox: await shownTo(A),
		},
		c.expected.result,
	);
	assert.deepEqual([await unread(A), await unread(B)], [0, 1]);
	refused(
		await w.feed.markSelectedRead(
			w.db,
			A.actor,
			command({ noticeIds: hidden, recipientId: B.id }, await w.revisionOf(A.id)),
		),
		"invalid_input",
	);
	const none = ok(
		await w.feed.markSelectedRead(
			w.db,
			A.actor,
			command({ noticeIds: [...hidden, theirs[0]!.id] }, await w.revisionOf(A.id)),
		),
	);
	assert.deepEqual([none.markedIds, await isRead(hidden), await unread(B)], [[], false, 1]);
});

test("AC:CASE-NTF-006 a moved, then completed meeting sends none of its old reminders, a removed guest none of the new ones, and a contact with only an address gets nothing", async () => {
	const c = caseOf("CASE-NTF-006");
	await w.at("2026-10-12T16:00:00Z");
	w.outbox.length = 0;
	const guest = await w.seated(w.tenant, "member");
	const removed = await w.seated(w.tenant, "member");
	const people = {
		guest: await w.person("Guest", { account: guest.id }),
		removed: await w.person("Removed guest", { account: removed.id }),
		contact: await w.person("CRM only", { email: "crm-only@example.test" }),
	};
	await w.admin.execute(sql`DELETE FROM notification_preference WHERE account_id=${w.adminActor.id}`);
	const m = await w.schedule({ date: "2026-10-20", time: "10:00", guests: Object.values(people) });
	assert.equal(m.startsAt, new Date(c.given.M.starts_at).toISOString());
	const queued = async (state = "ready") =>
		(
			await w.rows<{ key: string; at: string }>(
				sql`SELECT split_part(producer_key,'/',2) AS key, to_char(eligible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
					FROM job WHERE kind='notification' AND subject_record_id=${m.id} AND state=${state}
					AND producer_key<>'meeting/announcement' ORDER BY eligible_at`,
			)
		).map((j) => [j.key, j.at]);
	const old = [
		["day_7", "2026-10-13T15:00:00Z"],
		["day_3", "2026-10-17T15:00:00Z"],
		["day_1", "2026-10-19T15:00:00Z"],
	];
	assert.deepEqual(await queued(), old, "the seven-day reminder is queued before the move");
	const moved = ok(
		await w.meetings(
			meetingsWriter.edit,
			command({ meetingId: m.id, patch: { date: "2026-10-21", time: "10:00" } }, m.revision),
		),
	).meeting;
	assert.deepEqual([await queued("superseded"), (await queued())[0]], [old, ["day_7", "2026-10-14T15:00:00Z"]]);
	await w.tick(c.clock.now);
	const reminders = () =>
		w.rows<{ slot: string; recipient: string; state: string }>(
			sql`SELECT split_part(n.logical_key,'/',5) AS slot, n.recipient_id AS recipient, m.state FROM notice n
				LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${m.id} ORDER BY n.eligible_at, n.recipient_id`,
		);
	assert.deepEqual(await reminders(), [], "nothing goes out at the old seven-day time");
	const listed = ok(await w.meetingRead(meetingsReader.listGuests, { meetingId: m.id })).guests.find(
		(g) => g.person.personId === people.removed,
	)!;
	ok(
		await w.meetings(guestsWriter.removeGuest, command({ meetingId: m.id, personId: people.removed }, listed.revision)),
	);
	const audience = [w.adminActor.id, guest.id].sort();
	await w.tick("2026-10-14T15:00:00Z");
	assert.deepEqual(
		await reminders(),
		audience.map((recipient) => ({ slot: "day_7", recipient, state: "accepted" })),
	);
	assert.deepEqual(w.outbox.map((p) => p.to).sort(), [w.adminActor.email, guest.email].sort());

	await w.at("2026-10-18T15:00:00Z");
	await w.worker.run(w.db, new Date().toISOString());
	assert.deepEqual(
		(await reminders()).slice(2),
		audience.map((recipient) => ({ slot: "day_3", recipient, state: "pending" })),
		"the three-day reminder waits for handoff",
	);
	const claims = await claimDue(w.db, ["mail"], 100);
	assert.equal(claims.length, 2);
	const before = w.outbox.length;
	let revision = moved.revision;
	for (const to of ["in_progress", "completed"])
		revision = ok(await w.meetings(meetingsWriter.changeStatus, command({ meetingId: m.id, to }, revision))).meeting
			.revision;
	for (const claim of claims) await w.mail.dispatch(claim);
	for (const at of ["2026-10-19T15:00:00Z", "2026-10-20T15:00:00Z", "2026-10-21T15:00:00Z"]) await w.tick(at);
	assert.deepEqual(await queued(), []);
	assert.equal((await reminders()).length, 4);
	const accounts = new Set([...audience, removed.id]);
	const rows = await reminders();
	assert.deepEqual(
		{
			CRM_only_recipients:
				rows.filter((r) => !accounts.has(r.recipient)).length +
				w.outbox.filter((p) => p.to === "crm-only@example.test").length +
				(await w.count(sql`SELECT count(*)::int AS n FROM mail WHERE recipient_person_id IS NOT NULL`)),
			obsolete_reminders_sent: w.outbox.length - before,
			removed_guest_account_notified:
				rows.some((r) => r.recipient === removed.id) || w.outbox.some((p) => p.to === removed.email),
		},
		c.expected.result,
	);
	assert.deepEqual(
		rows.slice(2).map((r) => r.state),
		["cancelled", "cancelled"],
	);
	assert.equal(await w.count(noticesOf(removed.id)), 0);
});

test("AC:NOTIFY47-007 completing, cancelling or rescheduling a task or meeting while its reminder waits for handoff stops that reminder", async () => {
	const c = caseOf("NOTIFY47-007");
	await w.at(c.clock.now);
	w.outbox.length = 0;
	const plant = await w.newPlant({ name: "Reminders", digest_cadence: "off" });
	const A = await w.seated(plant, "admin");
	const due = day("2026-10-14");
	const tasks = new Map<string, Awaited<ReturnType<typeof w.task>>>();
	for (const id of c.given.input.old_reminders) tasks.set(id, await w.task(A, { title: id, assigneeIds: [A.id], due }));
	const old = new Map<string, string[]>();
	for (const [id, t] of tasks)
		old.set(
			id,
			(await w.rows<{ id: string }>(sql`SELECT id FROM notice WHERE source_record_id=${t.id}`)).map((n) => n.id),
		);
	assert.deepEqual(
		[...old.values()].map((ids) => ids.length),
		[2, 2, 2],
	);
	const [finished, [rescheduled]] = [c.given.input.tasks.slice(0, 2), c.given.input.tasks.slice(2)];
	await w.change(A, "edit", tasks.get(rescheduled.id)!, { patch: { due: day(rescheduled.due) } });
	await w.at("2026-10-14T14:00:00Z");
	const claims = await claimDue(w.db, ["mail"], 100);
	assert.equal(claims.length, finished.length, "the old due reminders are claimed and not yet handed over");
	for (const { id, status } of finished)
		if (status === "complete") await w.change(A, "complete", tasks.get(id)!);
		else await w.change(A, "changeStatus", tasks.get(id)!, { status });
	for (const claim of claims) await w.mail.dispatch(claim);
	for (const at of ["2026-10-14T14:00:00Z", "2026-10-15T14:00:00Z"]) await w.tick(at);
	const cancelled = [];
	for (const [id, ids] of old) {
		const left = await w.count(
			sql`SELECT count(*)::int AS n FROM notice n JOIN mail m ON m.notice_id=n.id WHERE n.id IN (${sql.join(
				ids.map((n) => sql`${n}`),
				sql`,`,
			)}) AND NOT (n.cancelled_at IS NOT NULL AND m.state='cancelled')`,
		);
		if (left === 0) cancelled.push(id);
	}
	assert.deepEqual(
		{
			old_reminders_canceled: cancelled,
			obsolete_sends: w.outbox.filter((p) => /T[123]$/.test(p.subject)).length,
		},
		c.expected.result,
	);
	assert.deepEqual((await feedOf(A)).items, []);
	await w.tick("2026-10-19T23:00:00Z");
	await w.tick("2026-10-20T14:00:00Z");
	assert.deepEqual(
		w.outbox.map((p) => [p.to, p.subject]),
		[[A.email, "Task due: T3"]],
	);
	await w.change(A, "complete", { id: tasks.get("T3")!.id, revision: "2" });

	for (const [name, act] of [
		["cancelled", { to: ["cancelled"] }],
		["completed", { to: ["in_progress", "completed"] }],
		["rescheduled", { date: "2026-12-01" }],
	] as const) {
		await w.at("2026-10-22T16:00:00Z");
		w.outbox.length = 0;
		const m = await w.schedule({ date: "2026-10-30", time: "10:00" });
		await w.at("2026-10-23T15:00:00Z");
		await w.worker.run(w.db, new Date().toISOString());
		const waiting = await claimDue(w.db, ["mail"], 100);
		assert.equal(waiting.length, 1, name);
		w.outbox.length = 0;
		let revision = m.revision;
		if ("date" in act)
			ok(
				await w.meetings(
					meetingsWriter.edit,
					command({ meetingId: m.id, patch: { date: act.date, time: "10:00" } }, revision),
				),
			);
		else
			for (const to of act.to)
				revision = ok(await w.meetings(meetingsWriter.changeStatus, command({ meetingId: m.id, to }, revision))).meeting
					.revision;
		for (const claim of waiting) await w.mail.dispatch(claim);
		for (const at of ["2026-10-23T15:00:00Z", "2026-10-27T15:00:00Z", "2026-10-29T15:00:00Z"]) await w.tick(at);
		assert.deepEqual(w.outbox, [], name);
		assert.deepEqual(
			await w.rows(sql`SELECT m.state FROM mail m JOIN notice n ON n.id=m.notice_id WHERE n.source_record_id=${m.id}`),
			[{ state: "cancelled" }],
			name,
		);
	}
});

test("AC:CASE-NTF-009 an advance tells each connected organization once, a declaration and a backward move tell nobody, and ending one link keeps the other", async () => {
	const c = caseOf("CASE-NTF-009");
	const service = (eligible: Parameters<typeof createNotificationService>[0]["eligible"]) =>
		createNotificationService({ mail: w.mails.phases, eligible });
	const emit = phaseNotices(service);
	const phases = createPhaseWriter({ notices: emit });
	const adapter = createOrganizationAdapter(
		{ invitation: async () => {}, invalidate: () => sql`UPDATE account SET id = id WHERE false` },
		{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
	);
	const revision = async (plantId: string) =>
		String((await w.one(sql`SELECT revision::text AS r FROM plant WHERE id=${plantId}`)).r);
	async function church(phase: number) {
		const plant = await w.newPlant({ name: "Harvest", phase });
		const planter = await w.seated(plant, "owner");
		const linked = async (kind: "sending_church" | "sending_network", name: string) => {
			const org = await w.organization(kind, name);
			return { org, leader: await w.seated(org, "owner"), link: await w.affiliate(plant.id, org.id) };
		};
		return { plant, planter, S1: await linked("sending_church", "S1"), N1: await linked("sending_network", "N1") };
	}
	type Church = Awaited<ReturnType<typeof church>>;
	const advanceNotices = (organization: Church["N1"]) =>
		w.count(
			sql`SELECT count(*)::int AS n FROM notice WHERE tenant_id=${organization.org.id} AND purpose='phase_transition' AND cancelled_at IS NULL`,
		);
	const revoked = async ({ N1 }: Church) =>
		(await w.count(sql`SELECT count(*)::int AS n FROM affiliation WHERE id=${N1.link} AND ended_at IS NULL`)) !== 1;
	const outcome = async (p: Church) => ({ advance_notices: await advanceNotices(p.N1), N1_revoked: await revoked(p) });

	await w.at("2026-10-13T15:00:00Z");
	const main = await church(c.given["phase-advance"].from_phase);
	const moveRequest = command(
		{ toPhase: c.given["phase-advance"].to_phase, reason: "The team is forming" },
		await revision(main.plant.id),
	);
	const advance = () => phases.transition(w.db, main.planter.actor, moveRequest);
	const first = await recorded(w.admin, advance);
	assert.deepEqual([first.added.notices, first.added.mail], [2, 2], "one notice and one email for each organization");
	await w.at(c.clock.now);
	for (let n = 1; n < c.given.execution.repeat; n++)
		assert.deepEqual(ok(await untouched(w.admin, advance)), ok(first.value));
	assert.deepEqual(await outcome(main), c.expected.result);
	assert.equal(await advanceNotices(main.S1), 1);
	assert.deepEqual(
		(await feedOf(main.N1.leader)).items.map((i) => [i.category, i.title]),
		[["phase_milestone", "Harvest moved to Phase 2"]],
	);

	for (const sub of c.subcases!) {
		const fact = sub.given[`phase-${sub.name}`];
		await w.at(sub.clock.now);
		const p = await church(fact.from_phase);
		const request =
			sub.name === "declaration"
				? command({ phase: fact.to_phase }, await revision(p.plant.id))
				: command({ toPhase: fact.to_phase, reason: "Back to the core group" }, await revision(p.plant.id));
		const act = async () =>
			ok<{ entry: { id: string } }>(
				sub.name === "declaration"
					? await phases.declare(w.db, p.planter.actor, request)
					: ((await phases.transition(w.db, p.planter.actor, request)) as { status: string }),
			);
		const { value, added } = await recorded(w.admin, act);
		assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []], sub.name);
		await untouched(w.admin, act);
		const [stored] = await w.rows<{ id: string }>(
			sql`SELECT id,from_phase,to_phase FROM phase_transition WHERE plant_id=${p.plant.id}`,
		);
		assert.deepEqual(stored, { id: value.entry.id, from_phase: fact.from_phase, to_phase: fact.to_phase });
		await untouched(w.admin, () =>
			assert.rejects(
				transaction(w.db, (tx) =>
					emit(tx, {
						plantName: "Harvest",
						transitionId: value.entry.id,
						fromPhase: fact.from_phase,
						toPhase: fact.to_phase,
						recipients: [
							{
								organizationId: p.N1.org.id,
								organizationKind: "sending_network",
								accountId: p.N1.leader.id,
								address: p.N1.leader.email,
							},
						],
					}),
				),
				/notification_source_stale/,
			),
		);
		assert.deepEqual(await outcome(p), sub.expected.result, sub.name);
		assert.deepEqual((await feedOf(p.N1.leader)).items, [], sub.name);
	}

	assert.deepEqual(c.given["behavior-inputs"].events.at(-1), "end_S1");
	const end = command({
		relationshipId: main.S1.link,
		pair: { kind: "plant", subject: main.plant, organization: main.S1.org },
		confirmed: true,
		reason: null,
	});
	const endS1 = () =>
		gatedTransaction(w.db, async (tx) => {
			assert.ok(await RequestActor.claimWrite(tx, main.planter.session, main.plant as never));
			return adapter["associations.end"](tx, main.planter.session, main.plant as never, end);
		});
	assert.deepEqual(await endS1(), { status: "committed" });
	assert.deepEqual(await untouched(w.admin, endS1), { status: "committed" });
	await w.tick();
	await w.tick();
	assert.deepEqual(
		(await feedOf(main.planter)).items.map((i) => [i.category, i.title]),
		[["relationship_milestone", "Connection ended: S1"]],
	);
	assert.deepEqual(await outcome(main), c.expected.result);
	assert.equal((await feedOf(main.N1.leader)).items.length, 1);
	ok(
		await phases.transition(
			w.db,
			main.planter.actor,
			command({ toPhase: 3, reason: "Training starts" }, await revision(main.plant.id)),
		),
	);
	assert.deepEqual([await advanceNotices(main.N1), await advanceNotices(main.S1)], [2, 1], "only the survivor is told");
});

test("AC:NOTIFY47-009 of the requested alerts only the Wiki upstream review has a producer; the rest have no operation, category, choice or notice", async () => {
	const c = caseOf("NOTIFY47-009");
	const { catalog, case_scope } = c.action.arguments;
	const { operations } = JSON.parse(readFileSync(new URL(`../../../${catalog}`, import.meta.url), "utf8")) as {
		operations: { id: string; case_ids: string[]; feature_ids: string[] }[];
	};
	const scoped = operations.filter((o) => o.case_ids.includes(case_scope));
	const producers = scoped
		.map((o) => /^notifications\.emit(\w+)$/.exec(o.id)?.[1])
		.filter((name) => name !== undefined);
	assert.deepEqual(producers.sort(), [
		"LaunchMilestone",
		"PhaseMilestone",
		"RelationshipMilestone",
		"SharingMilestone",
		"WikiUpstreamReview",
	]);
	const network = await w.organization("sending_network", "Editors");
	const editor = await w.seated(network, "owner");
	const service = accountNotificationService(w.mails.phases);
	const category: Record<string, string> = {
		team_health: "team_health",
		snooze: "snooze",
		NeedsYou: "needs_you",
		Wiki_upstream: "wiki_upstream_review",
	};
	const choices = ok(await w.feed.getPreferences(w.db, editor.actor)).choices;
	const article = randomUUID(),
		state = randomUUID();
	await w.admin.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
		VALUES(${article},'article',${`catalog-${article}`},'00000000-0000-0000-0000-000000000000')`);
	await w.admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,revision)
		VALUES(${state},${network.id},${article},'published',1)`);
	const attempt = (name: string) =>
		transaction(w.db, (tx) =>
			service.enqueue(tx, {
				owner: network,
				recipient: editor.id,
				source: { kind: "article_editor_state", id: state, revision: "1" },
				category: name as NoticeInput["category"],
				occurrence: name,
				title: "Synthetic alert",
				text: "Synthetic alert.",
				operation: null,
				eligibleAt: new Date().toISOString(),
			}),
		);
	const enabled = [];
	for (const alert of c.given.input.requested_alerts as string[]) {
		const name = category[alert]!;
		if (name === "wiki_upstream_review") {
			const { value, added } = await recorded(w.admin, () => attempt(name));
			assert.deepEqual([value.mail, added], [null, { ...NOTHING, notices: 1 }]);
			enabled.push(alert);
			continue;
		}
		await untouched(w.admin, () => assert.rejects(attempt(name), /Invalid option/));
		for (const channel of ["in_app", "email"])
			refused(
				await untouched(w.admin, async () =>
					w.feed.setPreference(
						w.db,
						editor.actor,
						command({ choice: { category: name, channel, enabled: true } }, await w.revisionOf(editor.id)),
					),
				),
				"invalid_input",
			);
		assert.equal(
			choices.some((choice) => choice.category === name),
			false,
		);
	}
	const named = (pattern: RegExp) => operations.filter((o) => pattern.test(o.id)).map((o) => o.id);
	const unused = named(/^notifications\..*(team|health|training|assessment|welcome|snooze|needsYou)/i);
	const rules = named(/(alert|notification)s?\..*(rule|snooze|custom)|^(rules|alerts)\./i);
	assert.deepEqual([unused, rules], [[], []]);
	for (const kind of ["team_welcome", "training_reminder", "assessment_ready", "rule"])
		await untouched(w.admin, () => assert.rejects(attempt(kind), /Invalid option/));
	assert.deepEqual(
		{
			implemented_new_producer: enabled.join(","),
			generic_rules_engine: rules.length > 0,
			unused_helpers_enabled: unused.length > 0,
		},
		c.expected.result,
	);
});
