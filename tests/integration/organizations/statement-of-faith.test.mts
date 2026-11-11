// DOC-020, D-107: a sending network's Owner or Admin writes its statement of faith through the one organization
// profile write. A church row cannot hold one, and every other seat is refused.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as S from "./support.mts";
import * as Q from "../../../packages/contracts/src/organizations/index.ts";
after(S.teardown);

const statementOf = async (id: string) =>
	(
		await S.db.execute(
			sql`SELECT statement_of_faith AS s, revision::text AS r FROM organization WHERE id=${sql.param(id)}`,
		)
	).rows[0] as { s: string | null; r: string };
const readBack = async (actor: S.Actor, organization: unknown) => {
	const profile = Q.organizationProfileResult.parse(await S.call("organizations.getProfile", actor, { organization }));
	if (profile.status !== "available") throw Error("profile unavailable");
	return profile;
};
/** The database's own check refuses the row. */
const checkFails = (error: { cause?: { constraint?: string } }) =>
	error.cause?.constraint === "organization_statement_of_faith";
const TEXT = "We hold to these words.\n\nA second paragraph,\nwith a line break.";

test("DOC-020: a network's Owner and Admin save, change and clear its statement of faith, read back each time", async () => {
	const network = await S.tenant("sending_network"),
		ownerSeat = await S.identity(network, "owner"),
		adminSeat = await S.identity(network, "admin"),
		member = await S.identity(network, "member");

	assert.equal((await readBack(member, network)).profile.statementOfFaith, null, "a new network has none");

	await S.call(
		"organizations.updateProfile",
		ownerSeat,
		S.command({ organization: network, patch: { statementOfFaith: `  ${TEXT}\n` } }, "1"),
	);
	let profile = await readBack(member, network);
	assert.equal(profile.profile.statementOfFaith, TEXT, "saved, with only the outer whitespace trimmed");
	assert.equal(profile.revision, "2");

	await S.call(
		"organizations.updateProfile",
		adminSeat,
		S.command({ organization: network, patch: { statementOfFaith: "Changed words." } }, "2"),
	);
	profile = await readBack(ownerSeat, network);
	assert.equal(profile.profile.statementOfFaith, "Changed words.");
	assert.equal(profile.revision, "3");

	// The existing revision check holds.
	await assert.rejects(
		S.call(
			"organizations.updateProfile",
			ownerSeat,
			S.command({ organization: network, patch: { statementOfFaith: "stale" } }, "2"),
		),
		/stale_revision/,
	);
	assert.equal((await statementOf(network.id)).s, "Changed words.");

	// Whitespace-only text is a clear.
	await S.call(
		"organizations.updateProfile",
		ownerSeat,
		S.command({ organization: network, patch: { statementOfFaith: " \n\n\t " } }, "3"),
	);
	profile = await readBack(ownerSeat, network);
	assert.equal(profile.profile.statementOfFaith, null);
	assert.deepEqual(await statementOf(network.id), { s: null, r: "4" });

	await S.call(
		"organizations.updateProfile",
		ownerSeat,
		S.command({ organization: network, patch: { statementOfFaith: "Again." } }, "4"),
	);
	await S.call(
		"organizations.updateProfile",
		ownerSeat,
		S.command({ organization: network, patch: { statementOfFaith: null } }, "5"),
	);
	assert.deepEqual(await statementOf(network.id), { s: null, r: "6" }, "null clears too");

	// Each change is audited through the profile envelope.
	const events = await S.db.execute(
		sql`SELECT action, after_value->>'statement_of_faith' AS after FROM audit_event WHERE subject_id=${sql.param(network.id)} ORDER BY recorded_at, id`,
	);
	assert.deepEqual(
		events.rows.map((row) => row.action),
		Array(5).fill("organization.profile_changed"),
	);
	assert.deepEqual(
		events.rows.map((row) => row.after),
		[TEXT, "Changed words.", null, "Again.", null],
	);
});

test("DOC-020: the statement is at most 10,000 characters", async () => {
	const network = await S.tenant("sending_network"),
		ownerSeat = await S.identity(network, "owner");
	await assert.rejects(
		S.call(
			"organizations.updateProfile",
			ownerSeat,
			S.command({ organization: network, patch: { statementOfFaith: "a".repeat(10_001) } }),
		),
	);
	await S.call(
		"organizations.updateProfile",
		ownerSeat,
		S.command({ organization: network, patch: { statementOfFaith: "a".repeat(10_000) } }),
	);
	assert.equal((await statementOf(network.id)).s?.length, 10_000);
	await assert.rejects(
		S.db.execute(
			sql`UPDATE organization SET statement_of_faith=${sql.param("a".repeat(10_001))} WHERE id=${sql.param(network.id)}`,
		),
		checkFails,
	);
});

test("DOC-020: a sending church row cannot store a statement of faith", async () => {
	const church = await S.tenant("sending_church"),
		ownerSeat = await S.identity(church, "owner");
	await assert.rejects(
		S.call(
			"organizations.updateProfile",
			ownerSeat,
			S.command({ organization: church, patch: { statementOfFaith: "Ours." } }),
		),
		/unavailable/,
	);
	assert.deepEqual(await statementOf(church.id), { s: null, r: "1" });
	await assert.rejects(
		S.db.execute(sql`UPDATE organization SET statement_of_faith='Ours.' WHERE id=${sql.param(church.id)}`),
		checkFails,
	);
	// A church's profile reads with no statement, and saving its other fields still works.
	await S.call(
		"organizations.updateProfile",
		ownerSeat,
		S.command({ organization: church, patch: { city: "Austin" } }),
	);
	const profile = await readBack(ownerSeat, church);
	assert.equal(profile.profile.statementOfFaith, null);
	assert.equal(profile.profile.city, "Austin");
});
