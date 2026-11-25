import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { currentActor, readPipelinePerson, readOwnResidency } from "../../../packages/domain/src/access/index.ts";
import { pipelineWriter, readPipelinePersonRecord } from "../../../packages/domain/src/organizations/index.ts";
import { authorityOf } from "../people/people-support.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createSeatService } from "../../../packages/domain/src/identity/index.ts";
import { database, transaction, id, account, plant, organization, seat, person } from "./support.mts";
let db: Awaited<ReturnType<typeof database>>;
type Account = Awaited<ReturnType<typeof account>>;
type Selected = Parameters<typeof currentActor>[2];
before(async () => {
	db = await database();
});
after(async () => {
	await db?.close();
});
const unavailable = { status: "unavailable" };
const own = (a: Account) => ({ kind: "account" as const, id: a.id });

test("AC:TARGET-IDN-029 INV-tenancy: fresh session and one exact typed current seat; account identity is independent", async () => {
	const a = await account(db.admin),
		p = await plant(db.admin),
		o = await organization(db.admin);
	const s = await seat(db.admin, a, p);
	const load = (selected: Selected) => transaction(db.runtime, (tx) => currentActor(tx, a.session, selected));
	assert.deepEqual(await load(p), {
		status: "active",
		accountId: a.id,
		context: { kind: "seat", owner: p, seatId: s, role: "admin", revision: "1" },
	});
	assert.deepEqual(await load(own(a)), {
		status: "active",
		accountId: a.id,
		context: { kind: "account", owner: own(a) },
	});
	assert.deepEqual(await load(o), unavailable);
	await db.admin.execute(querySql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${s}`);
	assert.deepEqual(await load(p), unavailable);
	await seat(db.admin, a, o, "owner");
	assert.deepEqual(await load({ ...o, organizationKind: "sending_network" }), unavailable);
	const owned = await load(o);
	assert.ok(owned.status === "active" && owned.context.kind === "seat", JSON.stringify(owned));
	assert.equal(owned.context.role, "owner");
	await db.admin.execute(querySql`DELETE FROM auth_session WHERE id=${a.session}`);
	assert.deepEqual(await load(o), unavailable);
	const pending = await account(db.admin, "pending_domain");
	await seat(db.admin, pending, p);
	assert.deepEqual(await transaction(db.runtime, (tx) => currentActor(tx, pending.session, p)), {
		status: "pending_domain",
		accountId: pending.id,
	});
	const expired = await account(db.admin);
	await db.admin.execute(
		querySql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired.session}`,
	);
	assert.deepEqual(await transaction(db.runtime, (tx) => currentActor(tx, expired.session, own(expired))), unavailable);
});

const effects = async () =>
	(
		await db.admin.execute(querySql`SELECT (SELECT count(*)::int FROM audit_event) AS audits,
		(SELECT count(*)::int FROM job) AS jobs, (SELECT count(*)::int FROM mail) AS mail, (SELECT count(*)::int FROM notice) AS notices`)
	).rows[0];

test("AC:WP006-API-IDN-029 the current actor is the Admin of the one church seat; a foreign context or a revoked session is unavailable, and reading it records nothing", async () => {
	const a = await account(db.admin),
		p = await plant(db.admin),
		foreign = await plant(db.admin),
		organizationContext = await organization(db.admin);
	const seatId = await seat(db.admin, a, p, "admin");
	const other = await account(db.admin);
	await seat(db.admin, other, foreign, "owner");
	const before = await effects();
	const load = (selected: Selected, session = a.session) =>
		transaction(db.runtime, (tx) => currentActor(tx, session, selected));
	const active = {
		status: "active",
		accountId: a.id,
		context: { kind: "seat", owner: p, seatId, role: "admin", revision: "1" },
	};
	assert.deepEqual(await load(p), active);
	for (const selected of [foreign, organizationContext, own(other), { ...organizationContext, id: p.id }])
		assert.deepEqual(await load(selected), unavailable);
	assert.deepEqual(await load(p, other.session), unavailable);
	assert.deepEqual(await load(p), active);
	await db.admin.execute(querySql`DELETE FROM auth_session WHERE id=${a.session}`);
	for (const selected of [p, own(a), foreign]) assert.deepEqual(await load(selected), unavailable);
	assert.deepEqual(await effects(), before);
});

test("AC:ADR1-002 AC:WP006-API-MUL-002 INV-pipeline: exact organization duties and no resident internal access", async () => {
	const o = await organization(db.admin),
		other = await organization(db.admin);
	const admin = await account(db.admin),
		staff = await account(db.admin),
		director = await account(db.admin),
		resident = await account(db.admin),
		unrelated = await account(db.admin);
	await seat(db.admin, admin, o);
	const staffSeat = await seat(db.admin, staff, o, "member"),
		directorSeat = await seat(db.admin, director, o, "member");
	await seat(db.admin, unrelated, o, "member");
	const p = await person(db.admin, o, resident.id),
		stage = id(),
		pipeline = id(),
		program = id(),
		version = id(),
		developmentStage = id();
	await db.admin.execute(
		querySql`INSERT INTO pipeline_stage(id,organization_id,stable_kind,label,position,revision) VALUES(${stage},${o.id},'potential_leader','Private stage',0,1)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO pipeline_person(id,organization_id,person_id,stage_id,responsible_seat_id,revision) VALUES(${pipeline},${o.id},${p},${stage},${staffSeat},1)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO development_program(id,organization_id,kind,name,director_seat_id,revision) VALUES(${program},${o.id},'residency','Synthetic',${directorSeat},1)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO development_program_version(id,organization_id,program_id,version_number,rhythm,expected_months,revision) VALUES(${version},${o.id},${program},1,'monthly',12,1)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO development_stage(id,organization_id,version_id,label,position,min_months,max_months,revision) VALUES(${developmentStage},${o.id},${version},'Private stage',0,1,2,1)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO development_enrollment(id,organization_id,person_id,program_id,version_id,cohort_label,started_on,expected_end_on,status,current_stage_id,meeting_timezone,revision) VALUES(${id()},${o.id},${p},${program},${version},'Synthetic','2026-10-01','2027-10-01','active',${developmentStage},'UTC',1)`,
	);
	const NOTE = "Staff note about the launch budget";
	const written = await pipelineWriter.addNote(db.runtime, await authorityOf(db.runtime, admin), {
		personId: p,
		noteId: id(),
		body: NOTE,
	});
	assert.equal(written.status, "ok", JSON.stringify(written));
	const before = await effects();
	const read = (a: Account, selected: Selected = o) =>
		transaction(db.runtime, (tx) => readPipelinePerson(tx, a.session, selected, { personId: p }));
	const record = async (a: Account) =>
		readPipelinePersonRecord(db.runtime, await authorityOf(db.runtime, a), { personId: p });
	for (const a of [admin, staff]) {
		const shown = await record(a);
		assert.ok(shown.status === "ok", JSON.stringify(shown));
		assert.deepEqual(
			shown.value.notes.map((n) => n.state === "current" && n.body),
			[NOTE],
		);
		assert.equal(JSON.stringify(await read(a)).includes(NOTE), false);
	}
	for (const a of [director, resident, unrelated])
		assert.deepEqual(await record(a), { status: "refused", refusal: { code: "unavailable" } });
	for (const a of [director, resident]) assert.equal(JSON.stringify(await read(a)).includes(NOTE), false);
	for (const [a, kind, notes] of [
		[admin, "organization_administration", true],
		[staff, "responsible_staff", true],
		[director, "program_director", false],
	] as const) {
		assert.deepEqual(await read(a), {
			status: "allowed",
			organization: o,
			personId: p,
			duties: [{ kind, canReadStaffNotes: notes }],
		});
	}
	for (const a of [resident, unrelated]) assert.deepEqual(await read(a), unavailable);
	assert.deepEqual(await read(admin, other), unavailable);
	for (const status of ["completed", "withdrawn"]) {
		await db.admin.execute(querySql`UPDATE development_enrollment SET status=${status} WHERE person_id=${p}`);
		assert.deepEqual(await read(director), unavailable, `directing only a ${status} enrollment gives no record access`);
		assert.equal((await read(admin)).status, "allowed");
		assert.equal((await read(staff)).status, "allowed");
	}
	await db.admin.execute(querySql`UPDATE development_enrollment SET status='active' WHERE person_id=${p}`);
	assert.deepEqual(await read(admin, { ...o, organizationKind: "sending_network" }), unavailable);
	assert.deepEqual(await effects(), before, "reading records nothing");
	const inv = id(),
		aff = id(),
		link = id();
	await db.admin.execute(
		querySql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,accepted_account_id,resident_person_id) VALUES(${inv},${o.id},'residency_link','synthetic@example.test',${id()},'accepted',clock_timestamp(),${resident.id},${p})`,
	);
	await db.admin.execute(
		querySql`INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES(${querySql.param(aff)},${querySql.param(resident.id)},${querySql.param(o.id)},clock_timestamp(),false,false,false,false,false,false,false)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,accepted_at,consent_revision,share_foundations,share_milestones,revision) VALUES(${link},${o.id},${p},${resident.id},${aff},${inv},clock_timestamp(),1,true,false,1)`,
	);
	assert.deepEqual(await transaction(db.runtime, (tx) => readOwnResidency(tx, resident.session, o, { personId: p })), {
		organization: o,
		personId: p,
		linkId: link,
		revision: "1",
	});
	assert.equal(await transaction(db.runtime, (tx) => readOwnResidency(tx, admin.session, o, { personId: p })), null);
	await db.admin.execute(querySql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${aff}`);
	assert.equal(await transaction(db.runtime, (tx) => readOwnResidency(tx, resident.session, o, { personId: p })), null);
	await db.admin.execute(querySql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${staffSeat}`);
	assert.deepEqual(await read(staff), unavailable);
});

test("AC:TARGET-IDN-005 a Member stays a Member whatever role the client claims, and every other context holds only its own authority", async () => {
	const p = await plant(db.admin),
		q = await plant(db.admin),
		o = await organization(db.admin);
	const who = async (tenant?: typeof p | typeof o, role: "owner" | "admin" | "member" = "member") => {
		const a = await account(db.admin);
		return { ...a, seat: tenant ? await seat(db.admin, a, tenant, role) : null };
	};
	const [owner, administrator, member, overseer, outsider] = [
		await who(p, "owner"),
		await who(p, "admin"),
		await who(p, "member"),
		await who(o, "owner"),
		await who(q, "owner"),
	];
	const [seatless, discovery, platform, former] = [await who(), await who(), await who(), await who(p, "admin")];
	await db.admin.execute(querySql`INSERT INTO discovery(account_id) VALUES(${discovery.id})`);
	await db.admin.execute(
		querySql`INSERT INTO platform_grant(account_id,capability) VALUES(${platform.id},'feedback_triage')`,
	);
	await db.admin.execute(querySql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${former.seat}`);
	await db.admin.execute(
		querySql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES(${p.id},${o.id},clock_timestamp(),true,true,true,true,true,true,true)`,
	);
	const load = (a: Account, selected: object) =>
		transaction(db.runtime, (tx) => currentActor(tx, a.session, selected as Selected));
	const role = async (a: Account, selected: object = p) => {
		const actor = await load(a, selected);
		return actor.status === "active" && actor.context.kind === "seat" ? actor.context.role : actor.status;
	};
	const before = await effects();
	assert.deepEqual([await role(owner), await role(administrator), await role(member)], ["owner", "admin", "member"]);
	for (const claimed of [
		{ ...p, role: "owner" },
		{ ...p, admin: true },
		{ ...p, capabilities: ["admin"] },
		{ ...p, seatId: administrator.seat },
		{ kind: "plant", id: "not-an-id" },
	])
		assert.equal(await role(member, claimed), "unavailable", JSON.stringify(claimed));
	for (const a of [overseer, outsider, seatless, discovery, platform, former]) {
		assert.equal(await role(a), "unavailable");
		for (const claimed of [{ ...p, role: "owner" }]) assert.equal(await role(a, claimed), "unavailable");
	}
	for (const a of [seatless, discovery, platform, former])
		assert.deepEqual(await load(a, own(a)), {
			status: "active",
			accountId: a.id,
			context: { kind: "account", owner: own(a) },
		});
	assert.deepEqual([await role(overseer, o), await role(outsider, q)], ["owner", "owner"]);
	for (const a of [seatless, discovery, platform, former, member]) assert.equal(await role(a, o), "unavailable");

	const seats = createSeatService(db.runtime);
	const promote = async (actor: RequestActor, target: string) =>
		seats.appointAdmin(actor, p, {
			requestKey: id(),
			expectedRevision: "1",
			input: { seatId: target, expectedRole: "member", to: "admin" },
		});
	const refused = (attempt: Promise<unknown>) =>
		assert.rejects(attempt, (error) => {
			assert.equal(error instanceof Error && "code" in error && error.code, "invitation_unavailable");
			return true;
		});
	for (const a of [member, overseer, outsider, seatless, discovery, platform, former])
		await refused(promote(await authorityOf(db.runtime, a), member.seat!));
	const stale = await authorityOf(db.runtime, administrator);
	const forged = RequestActor.of(member.session, stale.actor);
	await refused(promote(forged, member.seat!));
	assert.deepEqual(await effects(), before);
	await db.admin.execute(querySql`UPDATE seat SET role='member' WHERE id=${administrator.seat}`);
	await refused(promote(stale, member.seat!));
	assert.equal(await role(member), "member");
	assert.deepEqual(await effects(), before);
});
