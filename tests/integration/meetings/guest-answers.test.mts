import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createFollowUpWriter, withFollowUpWrite } from "../../../packages/domain/src/followups/index.ts";
import {
	answerRsvpToken,
	describeRsvpToken,
	guestsWriter as guests,
	meetingsReader as reads,
	rosterReader,
	rosterWriter,
} from "../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { peopleMerge, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { teamsWriter, withTeamsWrite } from "../../../packages/domain/src/teams/index.ts";
import { ok, refused } from "../../support/fixture.mts";
import { effects, key, meetingsWorld, type MeetingsWorld } from "./meetings-world.mts";
import { issueRsvpToken } from "./rsvp-token.mts";

let w: MeetingsWorld;
before(async () => {
	w = await meetingsWorld("mtg_guests");
});
after(() => w?.close());

const RSVP = effects("meetings.rsvp_recorded");
const issue = async (meetingId: string, personId: string, plant = w.P.id) => {
	const token = await issueRsvpToken(w.admin, plant, meetingId, personId);
	assert.ok(token);
	return token;
};
const answer = (token: string, rsvp: string) => answerRsvpToken(w.db, { token, rsvp });
const look = async (token: string) => {
	const view = await describeRsvpToken(w.db, { token });
	return view.state === "unavailable" ? [view.state] : [view.state, view.rsvp];
};
const correct = async (
	meetingId: string,
	personId: string,
	rsvp: string | null,
	who?: "member" | "foreign" | "foreignMember",
) => w.change(guests.correctRsvp, (await w.guestOf(meetingId, personId)).revision, { meetingId, personId, rsvp }, who);
const row = (meetingId: string, personId: string) =>
	w.one(sql`SELECT (SELECT count(*)::int FROM participation x WHERE x.meeting_id=${meetingId} AND x.person_id=${personId}) AS invitations,
		rsvp, presence, card_response FROM participation WHERE meeting_id=${meetingId} AND person_id=${personId}`);
const stored = (rsvp: string) => ({ invitations: 1, rsvp, presence: "absent", card_response: null });
const said = (reply: unknown, code?: string) => {
	const { correlationId, ...error } = refused(reply, code);
	assert.ok(correlationId);
	return error;
};
const linked = async (name: string, account: string) => {
	const [found] = await w.rows<{ id: string }>(sql`SELECT id FROM person WHERE linked_account_id=${account}`);
	return found?.id ?? w.person(name, { account });
};

test("AC:TARGET-MTG-007 a ministry import lists a person with two roles once, a later member waits for the next import, and a retry adds nobody", async () => {
	const alex = await w.person("Alex");
	const casey = await w.person("Casey");
	const admin = await w.authority("admin");
	const team = async <R,>(op: Parameters<typeof withTeamsWrite<R>>[2]) => ok(await withTeamsWrite(w.db, admin, op));
	const { team: ministry } = await team((tx, ctx) =>
		teamsWriter.create(tx, ctx, { requestKey: key(), input: { name: "Welcome" } }),
	);
	const join = async (personId: string, name: string) => {
		const { role } = await team((tx, ctx) =>
			teamsWriter.createRole(tx, ctx, { requestKey: key(), input: { teamId: ministry.id, name } }),
		);
		await team((tx, ctx) =>
			teamsWriter.assignRole(tx, ctx, {
				requestKey: key(),
				expectedRevision: role.revision,
				input: { roleId: role.id, teamId: ministry.id, personId },
			}),
		);
	};
	const m = await w.schedule({ type: "team_meeting", teamId: ministry.id });
	assert.deepEqual(await w.guestsOf(m.id), []);
	await join(alex, "Greeter");
	await join(alex, "Usher");
	const preview = () => w.read(rosterReader.previewRosterImport, { meetingId: m.id });
	const shown = ok(await w.unchanged(preview));
	assert.deepEqual([shown.add.map((p) => p.personId), shown.remove, shown.kept], [[alex], [], []]);
	const request = { requestKey: "TARGET-MTG-007-request-1", input: { meetingId: m.id, add: [alex], remove: [] } };
	for (const who of ["member", "foreign", "foreignMember"] as const) {
		refused(await w.unchanged(() => w.write(rosterWriter.copyTeamRoster, request, who)));
		refused(await w.unchanged(() => w.read(rosterReader.previewRosterImport, { meetingId: m.id }, who)));
	}
	const copied = await w.changes(() => w.write(rosterWriter.copyTeamRoster, request));
	assert.deepEqual(
		ok(copied.value).added.map((g) => [g.person.personId, g.rsvp, g.presence, g.inviter]),
		[[alex, "pending", "absent", null]],
	);
	assert.deepEqual(copied.added, effects("meetings.changed"));
	assert.deepEqual(copied.tables.sort(), ["audit_event", "participation", "plant", "record"]);
	assert.deepEqual(await w.unchanged(() => w.write(rosterWriter.copyTeamRoster, request)), copied.value);
	await join(casey, "Host");
	const listed = async () => (await w.guestsOf(m.id)).map((g) => [g.person.personId, g.presence]);
	assert.deepEqual(await w.unchanged(listed), [[alex, "absent"]], "Casey is not added by joining");
	refused(await w.unchanged(() => w.write(rosterWriter.copyTeamRoster, { ...request, requestKey: key() })), "conflict");
	assert.deepEqual(
		ok(await preview()).add.map((p) => p.personId),
		[casey],
	);
	for (const who of ["foreign", "foreignMember"] as const)
		refused(await w.unchanged(() => w.read(reads.listGuests, { meetingId: m.id }, who)));
	assert.deepEqual(await listed(), [[alex, "absent"]]);

	const invite = (personId: string, inviterPersonId: string | null) =>
		w.create(guests.inviteGuest, { meetingId: m.id, personId, inviterPersonId });
	const foreigner = await w.person("Foreign inviter", { plant: w.Q.id });
	refused(await w.unchanged(() => invite(casey, casey)), "invalid_input");
	refused(await w.unchanged(() => invite(casey, foreigner)), "invalid_subject");
	refused(await w.unchanged(() => invite(foreigner, null)), "invalid_subject");
	assert.equal(ok(await invite(casey, alex)).guest.inviter?.personId, alex);
	const caseyGuest = await w.guestOf(m.id, casey);
	for (const [inviterPersonId, code] of [
		[casey, "invalid_input"],
		[foreigner, "invalid_subject"],
	] as const)
		refused(
			await w.unchanged(() =>
				w.change(guests.setInviter, caseyGuest.revision, { meetingId: m.id, personId: casey, inviterPersonId }),
			),
			code,
		);
});

test("AC:TARGET-MTG-007 removing a guest clears the card and link, and keeps the follow-up already done for that Person", async () => {
	const alex = await w.person("Alex");
	const first = await w.schedule({ date: "2026-10-10" });
	await w.invite(first.id, alex);
	const finalize = {
		requestKey: key(),
		expectedRevision: "1",
		input: { meetingId: first.id, attendeeIds: [alex] },
	};
	const { work } = ok(await w.write(w.attendance.finalizeAttendance, finalize));
	const taskId = work.find((x) => x.kind === "first_vision_follow_up")?.taskId;
	assert.ok(taskId);
	const { revision } = await w.one<{ revision: string }>(sql`SELECT revision::text FROM task WHERE id=${taskId}`);
	const followUps = createFollowUpWriter({ reminders: async () => {} });
	ok(
		await withFollowUpWrite(w.db, await w.authority("admin"), (tx, ctx) =>
			followUps.recordOutcome(tx, ctx, {
				requestKey: key(),
				input: {
					target: { kind: "task", taskId, expectedRevision: revision },
					outcome: "contacted",
					completeTask: true,
					occurredAt: "2026-10-12T15:00:00Z",
				},
			}),
		),
	);
	const m = await w.schedule();
	await w.invite(m.id, alex);
	const token = await issue(m.id, alex);
	const card = { meetingId: m.id, personId: alex, response: "interested" };
	ok(await w.change(guests.recordCard, (await w.guestOf(m.id, alex)).revision, card));
	const performed = () =>
		Promise.all(
			["contact_outcome", "task", "obligation", "person", "commitment", "person_note"].map((name) =>
				w.rows(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t ORDER BY 1::text`),
			),
		);
	const before = await performed();
	assert.equal(before[0]!.length, 1);
	const g = await w.guestOf(m.id, alex);
	const remove = { requestKey: key(), expectedRevision: g.revision, input: { meetingId: m.id, personId: alex } };
	refused(await w.unchanged(() => w.write(guests.removeGuest, remove, "member")));
	refused(await w.unchanged(() => w.write(guests.removeGuest, remove, "foreign")));
	const removed = await w.changes(() => w.write(guests.removeGuest, remove));
	assert.equal(ok(removed.value).guest.hasCard, false);
	assert.deepEqual(
		[removed.added, removed.tables.sort()],
		[effects("meetings.changed"), ["audit_event", "participation", "plant", "record"]],
	);
	assert.deepEqual(await w.guestsOf(m.id), []);
	assert.deepEqual(ok(await w.read(reads.listCards, { meetingId: m.id })).cards, []);
	assert.deepEqual(
		await w.one(sql`SELECT before_value, after_value FROM audit_event WHERE subject_id=${g.id} AND kind='remove'`),
		{ before_value: { card: "interested", removed: false }, after_value: { card: null, removed: true } },
	);
	assert.deepEqual([await look(token), await performed()], [["unavailable"], before], "performed work stays");
	refused(await w.unchanged(() => answer(token, "confirmed")), "token_closed");
	assert.deepEqual(await w.unchanged(() => w.write(guests.removeGuest, remove)), removed.value);
	assert.deepEqual(await row(m.id, alex), stored("pending"));
	assert.equal((await w.invite(m.id, alex)).hasCard, false, "a removed card does not come back with the guest");
	assert.equal((await w.guestOf(m.id, alex)).hasCard, false);
	assert.deepEqual(await look(token), ["answered", "pending"], "nor does the old link reopen");
	refused(await w.unchanged(() => answer(token, "confirmed")), "token_closed");
	const held = await w.guestOf(first.id, alex);
	refused(
		await w.unchanged(() => w.change(guests.removeGuest, held.revision, { meetingId: first.id, personId: alex })),
		"status_transition",
	);
	assert.equal(held.presence, "attended");
});

test("AC:GAP-MTG-008 AC:TARGET-MTG-008 an Admin sets Yes, No or Pending on the one invitation, the link still opens on that answer and no longer takes one", async () => {
	const alex = await w.person("Alex Rivera", { stage: "prospect" });
	const m = await w.schedule({ guests: [alex] });
	const token = await issue(m.id, alex);
	assert.deepEqual([await row(m.id, alex), await look(token)], [stored("pending"), ["pending", "pending"]]);
	const start = await w.guestOf(m.id, alex);
	const request = {
		requestKey: key(),
		expectedRevision: start.revision,
		input: { meetingId: m.id, personId: alex, rsvp: "confirmed" },
	};
	const missing = said(
		await w.change(guests.correctRsvp, "1", { meetingId: randomUUID(), personId: alex, rsvp: "confirmed" }, "foreign"),
	);
	for (const who of ["foreign", "foreignMember", "member"] as const)
		assert.deepEqual(said(await w.unchanged(() => w.write(guests.correctRsvp, request, who))), missing);
	for (const [table, event] of [
		["participation", "UPDATE"],
		["audit_event", "INSERT"],
	] as const)
		await w.unchanged(() =>
			w.failing(table, event, async () => refused(await w.write(guests.correctRsvp, request), "required_write_failed")),
		);
	assert.deepEqual([await row(m.id, alex), await look(token)], [stored("pending"), ["pending", "pending"]]);

	for (const [rsvp, shown] of [
		["confirmed", "confirmed"],
		["declined", "declined"],
		[null, "pending"],
	] as const) {
		const input =
			rsvp === "confirmed"
				? request
				: {
						...request,
						requestKey: key(),
						expectedRevision: (await w.guestOf(m.id, alex)).revision,
						input: { ...request.input, rsvp },
					};
		const saved = await w.changes(() => w.write(guests.correctRsvp, input));
		const { guest } = ok(saved.value);
		assert.deepEqual([guest.rsvp, guest.rsvpSource, guest.presence, guest.hasCard], [shown, "admin", "absent", false]);
		assert.deepEqual([saved.added, saved.tables.sort()], [RSVP, ["audit_event", "participation", "plant", "record"]]);
		assert.deepEqual(await row(m.id, alex), stored(shown));
		assert.deepEqual(await look(token), ["answered", shown], "the link opens and shows the current answer");
		refused(await w.unchanged(() => answer(token, "declined")), "token_closed");
		assert.deepEqual(await w.unchanged(() => w.write(guests.correctRsvp, input)), saved.value, "a retry adds nothing");
	}
	refused(await w.unchanged(() => w.write(guests.correctRsvp, { ...request, requestKey: key() })), "conflict");
	const history = await w.rows(
		sql`SELECT before_value->>'rsvp' AS before, after_value->>'rsvp' AS after, actor_id FROM audit_event
			WHERE subject_id=${start.id} AND action='meetings.rsvp_recorded' ORDER BY occurred_at`,
	);
	const by = { actor_id: w.actors.admin.id };
	assert.deepEqual(history, [
		{ before: "pending", after: "confirmed", ...by },
		{ before: "confirmed", after: "declined", ...by },
		{ before: "declined", after: "pending", ...by },
	]);
	const renewed = await issue(m.id, alex);
	refused(await w.unchanged(() => answer(token, "declined")), "token_closed");
	assert.deepEqual(ok(await answer(renewed, "declined")).rsvp, "declined", "a reviewed new invitation takes an answer");
	refused(await w.unchanged(() => answer(renewed, "confirmed")), "token_closed");
	assert.equal(
		ok(await correct(m.id, alex, "confirmed")).guest.rsvp,
		"confirmed",
		"an Admin can correct an answered link",
	);
	assert.deepEqual(await look(renewed), ["answered", "confirmed"]);

	const foreigner = await w.person("Foreign guest", { plant: w.Q.id });
	const theirs = await w.schedule({ type: "orientation", guests: [foreigner] }, "foreign");
	const theirLink = await issue(theirs.id, foreigner, w.Q.id);
	for (const meetingId of [theirs.id, m.id])
		refused(
			await w.unchanged(() => w.change(guests.correctRsvp, "1", { meetingId, personId: foreigner, rsvp: "confirmed" })),
		);
	const own = { meetingId: theirs.id, personId: foreigner, rsvp: "confirmed" };
	assert.equal(ok(await w.change(guests.correctRsvp, "2", own, "foreign")).guest.rsvp, "confirmed");
	refused(await w.unchanged(() => answer(theirLink, "declined")), "token_closed");
});

test("AC:TARGET-MTG-008 AC:TARGET-MTG-009 link, own and Admin replies that arrive together leave one answer, and a link never overwrites one saved first", async () => {
	const account = w.actors.member.id;
	const personId = await linked("Morgan Guest", account);
	type Name = "token" | "own" | "admin";
	const cases: { order: Name[]; admin?: string | null; results: Record<Name, string>; final: [string, string] }[] = [
		{
			order: ["token", "own", "admin"],
			results: { token: "ok", own: "ok", admin: "conflict" },
			final: ["confirmed", "own"],
		},
		{
			order: ["own", "token", "admin"],
			results: { token: "token_closed", own: "ok", admin: "conflict" },
			final: ["confirmed", "own"],
		},
		{
			order: ["admin", "token", "own"],
			results: { token: "token_closed", own: "ok", admin: "ok" },
			final: ["confirmed", "own"],
		},
		{
			order: ["admin", "token"],
			results: { token: "token_closed", own: "", admin: "ok" },
			final: ["confirmed", "admin"],
		},
		{
			order: ["admin", "token"],
			admin: null,
			results: { token: "token_closed", own: "", admin: "ok" },
			final: ["pending", "admin"],
		},
		{ order: ["token", "admin"], results: { token: "ok", own: "", admin: "conflict" }, final: ["declined", "token"] },
	];
	for (const { order, admin = "confirmed", results, final } of cases) {
		const m = await w.schedule({ type: "orientation", guests: [personId] });
		const token = await issue(m.id, personId);
		const { revision } = await w.guestOf(m.id, personId);
		const starts: Record<Name, () => Promise<{ status: string; error?: { code: string } }>> = {
			token: () => answer(token, "declined"),
			own: () => w.create(guests.saveOwnRsvp, { meetingId: m.id, rsvp: "confirmed" }, "member"),
			admin: () => w.change(guests.correctRsvp, revision, { meetingId: m.id, personId, rsvp: admin }),
		};
		const { value, added, tables } = await w.changes(() =>
			w.queued(
				sql`SELECT FROM participation WHERE meeting_id=${m.id} FOR UPDATE`,
				order.map((name) => starts[name]),
			),
		);
		const codes = (value as { status: string; error?: { code: string } }[]).map((r) => r.error?.code ?? r.status);
		const label = order.join(" then ");
		assert.deepEqual(
			codes,
			order.map((name) => results[name]),
			label,
		);
		const saved = codes.filter((code) => code === "ok").length;
		assert.deepEqual(added, effects(...Array(saved).fill("meetings.rsvp_recorded")), label);
		assert.equal(tables.includes("commitment"), false);
		const g = await w.guestOf(m.id, personId);
		assert.deepEqual([g.rsvp, g.rsvpSource], final, label);
		assert.deepEqual(await row(m.id, personId), stored(final[0]), label);
		refused(await w.unchanged(() => answer(token, "declined")), "token_closed");
	}
});

test("AC:TARGET-MTG-009 opening a link writes nothing, and an expired, used, malformed or wrong reply is refused and changes nothing", async () => {
	const personId = await linked("Morgan Guest", w.actors.member.id);
	const alex = await w.person("Alex Rivera");
	const m = await w.schedule({ guests: [personId, alex] });
	const token = await issue(m.id, alex);
	assert.deepEqual(await w.unchanged(() => look(token)), ["pending", "pending"]);
	assert.deepEqual(Object.keys(await describeRsvpToken(w.db, { token })).sort(), [
		"guestFirstName",
		"meeting",
		"rsvp",
		"state",
	]);
	const expire = (at: string) =>
		w.admin.execute(
			sql`UPDATE participation SET rsvp_token_expires_at=${at}::timestamptz WHERE meeting_id=${m.id} AND person_id=${alex}`,
		);
	await expire("2026-10-13T15:00:00Z");
	assert.deepEqual(await w.unchanged(() => look(token)), ["expired", "pending"]);
	refused(await w.unchanged(() => answer(token, "confirmed")), "token_closed");
	assert.deepEqual(await row(m.id, alex), stored("pending"));
	for (const raw of [
		{ token, rsvp: "pending" },
		{ token, rsvp: "maybe" },
		{ token: "bad", rsvp: "confirmed" },
		{ token, rsvp: "confirmed", personId: alex },
		{ rsvp: "confirmed" },
		{},
	])
		refused(await w.unchanged(() => answerRsvpToken(w.db, raw)), "invalid_input");
	refused(await w.unchanged(() => answer("x".repeat(43), "confirmed")), "token_closed");
	await expire("2026-10-13T17:00:00Z");
	const used = await w.changes(() => answer(token, "confirmed"));
	assert.equal(ok(used.value).rsvp, "confirmed", "the same link answers while it lasts");
	assert.deepEqual([used.added, used.tables.sort()], [RSVP, ["audit_event", "participation", "record"]]);
	assert.deepEqual(await row(m.id, alex), stored("confirmed"));
	assert.deepEqual(await w.unchanged(() => look(token)), ["answered", "confirmed"]);
	for (const rsvp of ["declined", "confirmed"]) refused(await w.unchanged(() => answer(token, rsvp)), "token_closed");

	const own = { requestKey: key(), input: { meetingId: m.id, rsvp: "confirmed" } };
	const view = () => w.read(reads.getOwnRsvp, { meetingId: m.id }, "member");
	assert.deepEqual([ok(await w.unchanged(view)).rsvp, ok(await view()).responseAllowed], ["pending", true]);
	for (const input of [
		{ meetingId: "not-an-id", rsvp: "confirmed" },
		{ meetingId: m.id, rsvp: "maybe" },
		{ meetingId: m.id, rsvp: "pending" },
		{ meetingId: m.id, rsvp: "confirmed", name: "   " },
		{ meetingId: m.id, rsvp: "confirmed", personId: alex },
		{ meetingId: m.id, rsvp: "confirmed", accountId: w.actors.admin.id },
	])
		refused(await w.unchanged(() => w.create(guests.saveOwnRsvp, input, "member")), "invalid_input");
	for (const raw of [{ meetingId: "not-an-id" }, { meetingId: m.id, personId: alex }, { meetingId: m.id, name: "   " }])
		refused(await w.unchanged(() => w.read(reads.getOwnRsvp, raw, "member")), "invalid_input");
	for (const who of ["admin", "foreign", "foreignMember"] as const) {
		refused(await w.unchanged(() => w.write(guests.saveOwnRsvp, own, who)));
		refused(await w.unchanged(() => w.read(reads.getOwnRsvp, { meetingId: m.id }, who)));
	}
	assert.equal((await RequestActor.resolve(w.db, sessionId.parse(randomUUID()))) instanceof RequestActor, false);
	const other = await w.schedule({ guests: [alex] });
	for (const meetingId of [other.id, randomUUID()]) {
		refused(await w.unchanged(() => w.create(guests.saveOwnRsvp, { meetingId, rsvp: "confirmed" }, "member")));
		refused(await w.unchanged(() => w.read(reads.getOwnRsvp, { meetingId }, "member")));
	}
	const saved = await w.changes(() => w.write(guests.saveOwnRsvp, own, "member"));
	assert.deepEqual([ok(saved.value).guest.person.personId, ok(saved.value).guest.rsvp], [personId, "confirmed"]);
	assert.deepEqual(saved.added, RSVP);
	assert.deepEqual(await w.unchanged(() => w.write(guests.saveOwnRsvp, own, "member")), saved.value);
	assert.deepEqual([await row(m.id, personId), await row(m.id, alex)], [stored("confirmed"), stored("confirmed")]);

	const guest = await w.guestOf(m.id, personId);
	ok(await w.change(guests.removeGuest, guest.revision, { meetingId: m.id, personId }));
	refused(await w.unchanged(() => w.create(guests.saveOwnRsvp, { meetingId: m.id, rsvp: "declined" }, "member")));
	refused(await w.unchanged(view));
	const foreigner = await w.person("Foreign guest", { plant: w.Q.id });
	const theirs = await w.schedule({ type: "orientation", guests: [foreigner] }, "foreign");
	const theirLink = await issue(theirs.id, foreigner, w.Q.id);
	assert.equal(await issueRsvpToken(w.admin, w.P.id, theirs.id, foreigner), null, "a church mints no foreign link");
	const before = [await row(m.id, alex), await look(token)];
	assert.equal(ok(await answer(theirLink, "declined")).rsvp, "declined");
	assert.deepEqual([await row(m.id, alex), await look(token)], before, "a link answers for its own guest only");
});

test("AC:TARGET-MTG-011 a single-name guest is one Person and one guest or nothing, whether the guest row fails, the meeting is foreign or the request repeats", async () => {
	const m = await w.schedule();
	const theirs = await w.schedule({ type: "orientation" }, "foreign");
	const facts = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM person) AS people, (SELECT count(*)::int FROM participation) AS guests,
			(SELECT count(*)::int FROM participation WHERE presence='attended') AS attended`);
	const start = await facts();
	const contact = { displayName: "Jamie" };
	const ways = [
		["createGuestContact", { meetingId: m.id, ...contact }, 0],
		["createWalkInContact", { meetingId: m.id, ...contact }, 1],
		["addGuests", { meetingId: m.id, contacts: [contact] }, 0],
	] as const;
	let people = 0,
		attended = 0;
	for (const [op, input, walkedIn] of ways) {
		const request = { requestKey: `guest-1-${op}`, input };
		const save = (raw: unknown, who?: "member" | "foreign" | "foreignMember") => w.write<unknown>(guests[op], raw, who);
		for (let repeat = 0; repeat < 2; repeat++)
			await w.unchanged(() =>
				w.failing("participation", "INSERT", async () => refused(await save(request), "required_write_failed")),
			);
		await w.unchanged(() =>
			w.failing("audit_event", "INSERT", async () => refused(await save(request), "required_write_failed")),
		);
		for (const meetingId of [theirs.id, randomUUID()])
			refused(await w.unchanged(() => save({ requestKey: key(), input: { ...input, meetingId } })));
		for (const who of ["member", "foreign", "foreignMember"] as const)
			refused(await w.unchanged(() => save(request, who)));
		for (const name of ["   ", ""]) {
			const bad =
				op === "addGuests" ? { ...input, contacts: [{ displayName: name }] } : { ...input, displayName: name };
			refused(await w.unchanged(() => save({ requestKey: key(), input: bad })), "invalid_input");
		}
		assert.deepEqual(await facts(), {
			people: Number(start.people) + people,
			guests: Number(start.guests) + people,
			attended: Number(start.attended) + attended,
		});
		const saved = await w.changes(() => save(request));
		ok(saved.value);
		people++;
		attended += walkedIn;
		assert.deepEqual(saved.added, effects(...(op === "addGuests" ? ["meetings.changed"] : []), "people.created"));
		assert.deepEqual(
			saved.tables.sort(),
			["audit_event", ...(walkedIn ? ["meeting"] : []), "participation", "people_column", "person", "plant", "record"],
			"no login, consent, adulthood or commitment row",
		);
		for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(await w.unchanged(() => save(request)), saved.value);
	}
	const jamies = (await w.guestsOf(m.id)).filter((g) => g.person.displayName === "Jamie");
	assert.deepEqual(jamies.map((g) => g.presence).sort(), ["absent", "absent", "attended"]);
	assert.equal(new Set(jamies.map((g) => g.person.personId)).size, 3, "a shared name never merges");
	assert.deepEqual(
		await w.rows(sql`SELECT DISTINCT source, stage, adult_classification, commitment_state, linked_account_id, last_name
			FROM person WHERE display_name='Jamie'`),
		[
			{
				source: "meeting_guest_list",
				stage: "prospect",
				adult_classification: "unknown",
				commitment_state: "unknown",
				linked_account_id: null,
				last_name: null,
			},
		],
	);
	const alex = await w.person("Alex");
	refused(
		await w.unchanged(() => w.create(guests.addGuests, { meetingId: m.id, people: [alex, alex] })),
		"invalid_input",
	);
	const first = await w.invite(m.id, alex);
	const again = await w.changes(() => w.create(guests.inviteGuest, { meetingId: m.id, personId: alex }));
	assert.deepEqual([ok(again.value).outcome, ok(again.value).guest.id], ["noop", first.id]);
	assert.equal(again.tables.includes("participation"), false);
	const chosen = ok(await w.create(guests.addGuests, { meetingId: m.id, people: [alex] }));
	assert.deepEqual([chosen.outcome, chosen.guests.map((g) => g.id)], ["noop", [first.id]]);
	assert.equal((await row(m.id, alex)).invitations, 1);
	const foreigner = await w.person("Foreign", { plant: w.Q.id });
	refused(
		await w.unchanged(() => w.create(guests.inviteGuest, { meetingId: m.id, personId: foreigner })),
		"invalid_subject",
	);
});

test("AC:TARGET-MTG-019 invitation attribution keeps the stored inviter and the current reply through retirement and merge, and has no older tree", async () => {
	const [alex, casey, twin, spare] = [
		await w.person("Alex"),
		await w.person("Casey"),
		await w.person("Alex Twin"),
		await w.person("Casey Twin"),
	];
	const m = await w.schedule();
	await w.invite(m.id, alex, casey);
	await w.invite(m.id, twin, spare);
	const tokens = { alex: await issue(m.id, alex), twin: await issue(m.id, twin) };
	ok(await answer(tokens.alex, "confirmed"));
	const attribution = (who?: "member" | "foreign" | "foreignMember") =>
		w.read(reads.invitationAttribution, { meetingId: m.id }, who);
	const shown = async () =>
		ok(await w.unchanged(() => attribution("member"))).guests.map((g) => [
			g.person.personId,
			g.inviter?.personId ?? null,
			g.inviter?.state ?? null,
			g.rsvp,
			g.rsvpSource,
		]);
	const confirmed = [alex, casey, "live", "confirmed", "token"];
	assert.deepEqual(await shown(), [confirmed, [twin, spare, "live", "pending", null]]);
	const people = () => w.rows(sql`SELECT id FROM person ORDER BY id`);
	const everyone = await people();
	for (const raw of [
		{ meetingId: m.id, person: alex, request_old_invitation_tree: true },
		{ meetingId: m.id, tree: true },
	])
		refused(await w.unchanged(() => w.read(reads.invitationAttribution, raw)), "invalid_input");
	for (const who of ["foreign", "foreignMember"] as const) refused(await w.unchanged(() => attribution(who)));

	const inviter = async (personId: string, inviterPersonId: string | null) =>
		w.change(guests.setInviter, (await w.guestOf(m.id, personId)).revision, {
			meetingId: m.id,
			personId,
			inviterPersonId,
		});
	refused(await w.unchanged(() => inviter(alex, alex)), "invalid_input");
	assert.equal(ok(await inviter(twin, alex)).guest.inviter?.personId, alex);
	refused(await w.unchanged(() => inviter(alex, twin)), "invalid_subject");
	assert.equal(ok(await inviter(twin, spare)).guest.inviter?.personId, spare);

	const merge = async (sourceId: string, survivorId: string) => {
		const ctx = w.context("admin");
		const { reviewDigest } = ok(
			await gatedTransaction(w.db, (tx) => peopleMerge.getMergeReview(tx, ctx, { sourceId, survivorId })),
		);
		return ok(
			await gatedTransaction(w.db, (tx) =>
				peopleMerge.mergePeople(tx, ctx, {
					requestKey: key(),
					input: { sourceId, survivorId, reviewDigest, fieldChoices: {} },
				}),
			),
		);
	};
	assert.deepEqual(await look(tokens.twin), ["pending", "pending"]);
	await merge(twin, alex);
	assert.deepEqual(await shown(), [confirmed], "one guest keeps Alex's inviter and answer");
	assert.deepEqual([await look(tokens.twin), await look(tokens.alex)], [["unavailable"], ["answered", "confirmed"]]);
	for (const token of Object.values(tokens))
		refused(await w.unchanged(() => answer(token, "declined")), "token_closed");
	await merge(casey, spare);
	assert.deepEqual(await shown(), [[alex, spare, "live", "confirmed", "token"]], "the inviter follows the merge");

	const p = await w.one<{ r: string; plant: string }>(sql`SELECT revision::text AS r,
		(SELECT material_revision::text FROM plant WHERE id=${w.P.id}) AS plant FROM person WHERE id=${spare}`);
	ok(
		await gatedTransaction(w.db, (tx) =>
			peopleWriter.retirePerson(
				tx,
				w.context("admin"),
				{
					requestKey: key(),
					expectedRevision: p.r,
					input: { personId: spare, reason: "Moved away", reviewRevision: p.plant, handoffs: [] },
				},
				async () => {},
			),
		),
	);
	assert.deepEqual(
		await shown(),
		[[alex, spare, "retired", "confirmed", "token"]],
		"the stored inviter stays readable",
	);
	const jamie = await w.person("Jamie");
	await w.invite(m.id, jamie);
	refused(await w.unchanged(() => inviter(jamie, spare)), "invalid_subject");

	await w.admin.execute(
		sql`UPDATE participation SET rsvp='declined', rsvp_source='invitation', rsvp_at='2025-05-01T12:00:00Z'
			WHERE meeting_id=${m.id} AND person_id=${jamie}`,
	);
	const legacy = async () => (await shown()).find(([id]) => id === jamie);
	assert.deepEqual(
		await legacy(),
		[jamie, null, null, "declined", "invitation"],
		"a recognized older reply stays readable",
	);
	assert.equal((await w.guestOf(m.id, jamie)).presence, "absent");
	ok(await correct(m.id, jamie, "confirmed"));
	assert.deepEqual(await legacy(), [jamie, null, null, "confirmed", "admin"], "and does not replace the current reply");

	await merge(jamie, alex);
	const self = await w.person("Robin");
	const robin = await w.person("Robin Twin");
	const second = await w.schedule();
	await w.invite(second.id, self, robin);
	await merge(robin, self);
	const guestsNow = ok(await w.read(reads.invitationAttribution, { meetingId: second.id })).guests;
	assert.deepEqual(
		guestsNow.map((g) => [g.person.personId, g.inviter]),
		[[self, null]],
		"a merge leaves no self referral",
	);
	assert.deepEqual(
		(await people())
			.filter(({ id }) => !everyone.some((e) => e.id === id))
			.map(({ id }) => id)
			.sort(),
		[jamie, self, robin].sort(),
		"reading and merging invent nobody",
	);
});
