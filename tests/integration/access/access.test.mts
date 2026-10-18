import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "../../../packages/domain/node_modules/zod/index.js";
import {
	currentActor,
	accessPolicies,
	accessReader,
	plantAdministration,
	ordinarySeatAdministration,
	readPipelinePerson,
	readOrganizationNotes,
	readOwnResidency,
	readPlantAffiliation,
	readDiscoveryRelationship,
	readPlatformGrant,
	checkPrivateCare,
	readProjection,
} from "../../../packages/domain/src/access/index.ts";
import { database, transaction, id, account, plant, organization, seat, person } from "./support.mts";
let db;
before(async () => {
	db = await database();
});
after(async () => {
	await db?.close();
});
const unavailable = { status: "unavailable" };
const own = (a) => ({ kind: "account", id: a.id });
const checkInput = (
	operation,
	tenant,
	kind = "write",
	expectedRevision = "1",
	subjectKind = tenant.kind,
	subjectId = tenant.id,
) =>
	kind === "write"
		? { kind, operation, subject: { kind: subjectKind, id: subjectId, owner: tenant }, expectedRevision }
		: { kind, operation, subject: { kind: subjectKind, id: subjectId, owner: tenant }, purpose: "native" };

test("AC:WP006-API-IDN-029 INV-tenancy: fresh session and one exact typed current seat; account identity is independent", async () => {
	const a = await account(db.admin),
		p = await plant(db.admin),
		o = await organization(db.admin);
	const s = await seat(db.admin, a, p);
	const load = (selected) => transaction(db.runtime, (tx) => currentActor(tx, a.session, selected));
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
	await db.admin.query("UPDATE seat SET ended_at=clock_timestamp() WHERE id=$1", [s]);
	assert.deepEqual(await load(p), unavailable);
	await seat(db.admin, a, o, "owner");
	assert.deepEqual(await load({ ...o, organizationKind: "network" }), unavailable);
	assert.equal((await load(o)).context.role, "owner");
	await db.admin.query("DELETE FROM auth_session WHERE id=$1", [a.session]);
	assert.deepEqual(await load(o), unavailable);
	const pending = await account(db.admin, "pending_domain");
	await seat(db.admin, pending, p);
	assert.deepEqual(await transaction(db.runtime, (tx) => currentActor(tx, pending.session, p)), {
		status: "pending_domain",
		accountId: pending.id,
	});
	const expired = await account(db.admin);
	await db.admin.query("UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
		expired.session,
	]);
	assert.deepEqual(await transaction(db.runtime, (tx) => currentActor(tx, expired.session, own(expired))), unavailable);
});

test("AC:WP006-API-KNOW-116 INV-policy: Owner/Admin parity, Owner-only workspace deletion, real operation kind, exact revision and protected Owner", async () => {
	const p = await plant(db.admin),
		foreign = await plant(db.admin);
	const actors = {};
	for (const role of ["owner", "admin", "member"]) {
		actors[role] = await account(db.admin);
		actors[role].seat = await seat(db.admin, actors[role], p, role);
	}
	const policy = accessReader([
		plantAdministration("plant.updateProfile", ["plant"]),
		plantAdministration("churches.requestWorkspaceDeletion", ["plant"]),
		...["launch.addGuestAttendance", "launch.saveDebriefDraft", "launch.publishDebriefSummary"].map((op) =>
			plantAdministration(op, ["plant"]),
		),
		ordinarySeatAdministration,
		{
			operation: "people.getPerson",
			subjectKinds: ["person"],
			async authorize(_tx, actor) {
				return actor.context.kind === "seat";
			},
		},
	]);
	const check = (a, input, selected = p) =>
		transaction(db.runtime, (tx) => policy.checkOperation(tx, a.session, selected, input));
	for (const operation of [
		"plant.updateProfile",
		"launch.addGuestAttendance",
		"launch.saveDebriefDraft",
		"launch.publishDebriefSummary",
	]) {
		for (const role of ["owner", "admin", "member"])
			assert.deepEqual(
				await check(actors[role], checkInput(operation, p)),
				role === "member" ? unavailable : { status: "allowed" },
			);
		assert.deepEqual(await check(actors.admin, checkInput(operation, p, "write", "2")), unavailable);
		assert.deepEqual(await check(actors.admin, checkInput(operation, foreign), foreign), unavailable);
	}
	assert.deepEqual(await check(actors.owner, checkInput("churches.requestWorkspaceDeletion", p)), {
		status: "allowed",
	});
	assert.deepEqual(await check(actors.admin, checkInput("churches.requestWorkspaceDeletion", p)), unavailable);
	assert.deepEqual(
		await check(actors.admin, checkInput("seats.changeOrdinaryRole", p, "write", "1", "seat", actors.owner.seat)),
		unavailable,
	);
	assert.deepEqual(
		await check(actors.admin, checkInput("seats.changeOrdinaryRole", p, "write", "1", "seat", actors.member.seat)),
		{ status: "allowed" },
	);
	const personId = await person(db.admin, p);
	assert.deepEqual(await check(actors.member, checkInput("people.getPerson", p, "read", "1", "person", personId)), {
		status: "allowed",
	});
	assert.deepEqual(
		await check(actors.admin, checkInput("people.getPerson", p, "write", "1", "person", personId)),
		unavailable,
	);
	assert.deepEqual(await check(actors.admin, checkInput("privateCare.save", p)), unavailable);
	assert.deepEqual(
		await check(actors.admin, { ...checkInput("plant.updateProfile", p), actorId: actors.owner.id, approval: true }),
		unavailable,
	);
	await db.admin.query("UPDATE seat SET ended_at=clock_timestamp() WHERE id=$1", [actors.admin.seat]);
	assert.deepEqual(await check(actors.admin, checkInput("launch.saveDebriefDraft", p)), unavailable);
	assert.deepEqual((await db.admin.query("SELECT count(*)::int n FROM event")).rows, [{ n: 0 }]);
});

test("AC:WP006-API-MUL-002 INV-pipeline: exact organization duties, protected native notes and no resident internal access", async () => {
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
	await db.admin.query(
		"INSERT INTO pipeline_stage(id,organization_id,stable_kind,label,position,revision) VALUES($1,$2,'potential_leader','Private stage',0,1)",
		[stage, o.id],
	);
	await db.admin.query(
		"INSERT INTO pipeline_person(id,organization_id,person_id,stage_id,responsible_seat_id,revision) VALUES($1,$2,$3,$4,$5,1)",
		[pipeline, o.id, p, stage, staffSeat],
	);
	await db.admin.query(
		"INSERT INTO development_program(id,organization_id,kind,name,director_seat_id,revision) VALUES($1,$2,'residency','Synthetic',$3,1)",
		[program, o.id, directorSeat],
	);
	await db.admin.query(
		"INSERT INTO development_program_version(id,organization_id,program_id,version_number,rhythm,expected_months,revision) VALUES($1,$2,$3,1,'Monthly',12,1)",
		[version, o.id, program],
	);
	await db.admin.query(
		"INSERT INTO development_stage(id,organization_id,version_id,label,position,min_months,max_months,revision) VALUES($1,$2,$3,'Private stage',0,1,2,1)",
		[developmentStage, o.id, version],
	);
	await db.admin.query(
		"INSERT INTO development_enrollment(id,organization_id,person_id,program_id,version_id,cohort_label,started_on,expected_end_on,status,current_stage_id,meeting_timezone,revision) VALUES($1,$2,$3,$4,$5,'Synthetic','2026-10-01','2027-10-01','active',$6,'UTC',1)",
		[id(), o.id, p, program, version, developmentStage],
	);
	const note = id();
	await db.admin.query(
		"INSERT INTO person_note(id,tenant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES($1,$2,$3,$4,'PROTECTED-NOTE-CANARY',clock_timestamp(),clock_timestamp())",
		[note, o.id, p, admin.id],
	);
	const read = (a, selected = o) =>
		transaction(db.runtime, (tx) => readPipelinePerson(tx, a.session, selected, { personId: p }));
	for (const [a, kind, notes] of [
		[admin, "organization_administration", true],
		[staff, "responsible_staff", true],
		[director, "program_director", false],
	]) {
		assert.deepEqual(await read(a), {
			status: "allowed",
			organization: o,
			personId: p,
			duties: [{ kind, canReadStaffNotes: notes }],
		});
		const result = await transaction(db.runtime, (tx) => readOrganizationNotes(tx, a.session, o, { personId: p }));
		if (notes) {
			assert.equal(result.status, "allowed");
			assert.equal(result.notes[0].body, "PROTECTED-NOTE-CANARY");
			assert.deepEqual(result.notes[0].author, { kind: "account", accountId: admin.id });
		} else assert.deepEqual(result, unavailable);
	}
	await db.admin.query("UPDATE person_note SET author_id=NULL WHERE id=$1", [note]);
	const retained = await transaction(db.runtime, (tx) => readOrganizationNotes(tx, admin.session, o, { personId: p }));
	assert.equal(retained.status, "allowed");
	assert.deepEqual(retained.notes[0].author, { kind: "removed" });
	assert.equal(retained.notes[0].body, "PROTECTED-NOTE-CANARY");
	for (const a of [resident, unrelated]) assert.deepEqual(await read(a), unavailable);
	assert.deepEqual(await read(admin, other), unavailable);
	assert.deepEqual(await read(admin, { ...o, organizationKind: "network" }), unavailable);
	const inv = id(),
		aff = id(),
		link = id();
	await db.admin.query(
		"INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,accepted_account_id,resident_person_id) VALUES($1,$2,'residency_link','synthetic@example.test',$3,'accepted',clock_timestamp(),$4,$5)",
		[inv, o.id, id(), resident.id, p],
	);
	await db.admin.query(
		"INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES($1,$2,$3,clock_timestamp(),false,false,false,false,false,false,false)",
		[aff, resident.id, o.id],
	);
	await db.admin.query(
		"INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,accepted_at,consent_revision,share_foundations,share_milestones,revision) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),1,true,false,1)",
		[link, o.id, p, resident.id, aff, inv],
	);
	assert.deepEqual(await transaction(db.runtime, (tx) => readOwnResidency(tx, resident.session, o, { personId: p })), {
		organization: o,
		personId: p,
		linkId: link,
		revision: "1",
	});
	assert.equal(await transaction(db.runtime, (tx) => readOwnResidency(tx, admin.session, o, { personId: p })), null);
	await db.admin.query("UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=$1", [aff]);
	assert.equal(await transaction(db.runtime, (tx) => readOwnResidency(tx, resident.session, o, { personId: p })), null);
	await db.admin.query("UPDATE seat SET ended_at=clock_timestamp() WHERE id=$1", [staffSeat]);
	assert.deepEqual(await read(staff), unavailable);
	assert.deepEqual(
		await transaction(db.runtime, (tx) => readOrganizationNotes(tx, staff.session, o, { personId: p })),
		unavailable,
	);
});

test("INV-grants: affiliations and sharing are independent exact pairs; platform grants confer no tenant/private authority", async () => {
	const p = await plant(db.admin),
		q = await plant(db.admin),
		o = await organization(db.admin),
		other = await organization(db.admin, "sending_network");
	const a = await account(db.admin);
	await seat(db.admin, a, o);
	const first = id(),
		second = id();
	await db.admin.query(
		"INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES($1,$2,$3,clock_timestamp(),true,false,false,false,false,false,false),($4,$2,$5,clock_timestamp(),false,false,false,false,false,false,false)",
		[first, p.id, o.id, second, other.id],
	);
	const grant = await transaction(db.runtime, (tx) => readPlantAffiliation(tx, a.session, o, p));
	assert.deepEqual(grant, {
		kind: "plant_affiliation",
		id: first,
		revision: "1",
		acceptedAt: grant.acceptedAt,
		plant: p,
		organization: o,
		sharing: {
			people: true,
			meetings: false,
			tasks: false,
			ministry: false,
			wiki: false,
			activity: false,
			findings: false,
		},
	});
	assert.equal(await transaction(db.runtime, (tx) => readPlantAffiliation(tx, a.session, other, p)), null);
	assert.equal(await transaction(db.runtime, (tx) => readPlantAffiliation(tx, a.session, o, q)), null);
	assert.deepEqual(await transaction(db.runtime, (tx) => currentActor(tx, a.session, p)), unavailable);
	await db.admin.query("UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=$1", [first]);
	assert.equal(await transaction(db.runtime, (tx) => readPlantAffiliation(tx, a.session, o, p)), null);
	const relationship = id();
	await db.admin.query(
		"INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES($1,$2,$3,clock_timestamp(),false,false,false,false,false,false,false)",
		[relationship, a.id, other.id],
	);
	assert.equal(
		(await transaction(db.runtime, (tx) => readDiscoveryRelationship(tx, a.session, own(a), other))).id,
		relationship,
	);
	assert.deepEqual(await transaction(db.runtime, (tx) => currentActor(tx, a.session, other)), unavailable);
	const platform = id();
	await db.admin.query("INSERT INTO platform_grant(id,account_id,capability) VALUES($1,$2,'recovery_operator')", [
		platform,
		a.id,
	]);
	assert.deepEqual(
		await transaction(db.runtime, (tx) => readPlatformGrant(tx, a.session, own(a), "recovery_operator")),
		{
			kind: "platform",
			id: platform,
			revision: "1",
			accountId: a.id,
			capability: "recovery_operator",
			expiresAt: null,
		},
	);
	assert.deepEqual(await transaction(db.runtime, (tx) => currentActor(tx, a.session, p)), unavailable);
	await db.admin.query("UPDATE platform_grant SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
		platform,
	]);
	assert.equal(
		await transaction(db.runtime, (tx) => readPlatformGrant(tx, a.session, own(a), "recovery_operator")),
		null,
	);
});

test("INV-privacy: native care requires original author and current exact plant administration; projections select closed DTOs", async () => {
	const p = await plant(db.admin),
		a = await account(db.admin),
		b = await account(db.admin),
		member = await account(db.admin);
	const seatA = await seat(db.admin, a, p, "admin");
	await seat(db.admin, b, p, "owner");
	await seat(db.admin, member, p, "member");
	const week = id();
	await db.admin.query(
		"INSERT INTO private_week(id,plant_id,author_id,ordinal,monday,timezone,starts_at,ends_at,note) VALUES($1,$2,$3,1,'2026-10-12','UTC','2026-10-12Z','2026-10-19Z','PRIVATE-CARE-CANARY')",
		[week, p.id, a.id],
	);
	assert.equal(await transaction(db.runtime, (tx) => checkPrivateCare(tx, a.session, p, week)), true);
	for (const actor of [b, member])
		assert.equal(await transaction(db.runtime, (tx) => checkPrivateCare(tx, actor.session, p, week)), false);
	const personId = await person(db.admin, p);
	await db.admin.query("UPDATE person SET notes='PRIVATE-PERSON-CANARY',email='private@example.test' WHERE id=$1", [
		personId,
	]);
	const policy = accessPolicies([
		{
			operation: "people.getPerson",
			subjectKinds: ["person"],
			async authorize() {
				return true;
			},
		},
	]);
	const read = readProjection(policy, {
		operation: "people.getPerson",
		purpose: "export",
		schema: z.strictObject({ id: z.uuid(), displayName: z.string() }),
		async load(tx, subject) {
			const row = (
				await tx.query("SELECT id,display_name FROM person WHERE id=$1 AND tenant_id=$2", [
					subject.id,
					subject.owner.id,
				])
			).rows[0];
			return { id: row.id, displayName: row.display_name };
		},
	});
	const input = { ...checkInput("people.getPerson", p, "read", "1", "person", personId), purpose: "export" };
	assert.deepEqual(await transaction(db.runtime, (tx) => read(tx, a.session, p, input)), {
		id: personId,
		displayName: "Synthetic",
	});
	assert.equal(await transaction(db.runtime, (tx) => read(tx, a.session, p, { ...input, purpose: "model" })), null);
	assert.equal(
		await transaction(db.runtime, (tx) =>
			read(tx, a.session, p, { ...input, subject: { kind: "private_week", id: week, owner: p } }),
		),
		null,
	);
	await db.admin.query("UPDATE seat SET ended_at=clock_timestamp() WHERE id=$1", [seatA]);
	assert.equal(await transaction(db.runtime, (tx) => checkPrivateCare(tx, a.session, p, week)), false);
	assert.equal(await transaction(db.runtime, (tx) => read(tx, a.session, p, input)), null);
});
