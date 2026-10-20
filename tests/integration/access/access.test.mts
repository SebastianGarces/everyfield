import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
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
		: { kind, operation, subject: { kind: subjectKind, id: subjectId, owner: tenant } };

test("AC:WP006-IDN-029 AC:C0-SCOPE-001 AC:WP006-API-IDN-029 INV-tenancy: fresh session and one exact typed current seat; account identity is independent", async () => {
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
	await db.admin.execute(querySql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${s}`);
	assert.deepEqual(await load(p), unavailable);
	await seat(db.admin, a, o, "owner");
	assert.deepEqual(await load({ ...o, organizationKind: "network" }), unavailable);
	assert.equal((await load(o)).context.role, "owner");
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

test("AC:WP006-MUL-002 AC:WP006-API-MUL-002 INV-pipeline: exact organization duties, protected native notes and no resident internal access", async () => {
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
		querySql`INSERT INTO development_program_version(id,organization_id,program_id,version_number,rhythm,expected_months,revision) VALUES(${version},${o.id},${program},1,'Monthly',12,1)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO development_stage(id,organization_id,version_id,label,position,min_months,max_months,revision) VALUES(${developmentStage},${o.id},${version},'Private stage',0,1,2,1)`,
	);
	await db.admin.execute(
		querySql`INSERT INTO development_enrollment(id,organization_id,person_id,program_id,version_id,cohort_label,started_on,expected_end_on,status,current_stage_id,meeting_timezone,revision) VALUES(${id()},${o.id},${p},${program},${version},'Synthetic','2026-10-01','2027-10-01','active',${developmentStage},'UTC',1)`,
	);
	const note = id();
	await db.admin.execute(
		querySql`INSERT INTO person_note(id,tenant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES(${note},${o.id},${p},${admin.id},'PROTECTED-NOTE-CANARY',clock_timestamp(),clock_timestamp())`,
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
	await db.admin.execute(querySql`UPDATE person_note SET author_id=NULL WHERE id=${note}`);
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
	assert.deepEqual(
		await transaction(db.runtime, (tx) => readOrganizationNotes(tx, staff.session, o, { personId: p })),
		unavailable,
	);
});
