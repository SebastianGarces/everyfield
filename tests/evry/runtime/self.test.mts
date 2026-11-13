// WP-059: Evry knows which person row is the signed-in user, marks it `you` in every person row a read returns, and
// tells the model never to suggest the user as a follow-up. Lists, counts and lookups still include the user.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { invokeRead } from "../../../packages/evry/src/index.ts";
import { resolveSelf } from "../../../packages/evry/src/context/self.ts";
import { personRow } from "../../../packages/evry/src/catalog/person-row.ts";
import { compileContext } from "../../../packages/evry/src/context/compile.ts";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { getPerson, listPeople } from "../../../packages/evry/src/adapters/people/reads/index.ts";
import { getPipelineData } from "../../../packages/evry/src/adapters/people-organization/reads/index.ts";
import { accounts, actor, admin, db, people, queries, setup, sql, teardown } from "./support.mts";

before(setup);
after(teardown);

const link = (who: "owner" | "member", personId: string | null) =>
	admin.execute(
		sql`UPDATE person SET linked_account_id=${personId ? accounts[who].id : null} WHERE id=${personId ?? people.alexRivera}`,
	);

test("INV-evry-self: resolveSelf returns the linked live person in the church, or none; the account context has none", async () => {
	const owner = await actor("owner");
	const member = await actor("member");
	assert.equal(await resolveSelf(db, owner), null, "unlinked: no row");
	await link("owner", people.alexRivera);
	assert.equal(await resolveSelf(db, owner), people.alexRivera);
	assert.equal(await resolveSelf(db, member), null, "another member's account is not this row");
	await admin.execute(
		sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${people.alexRivera}`,
	);
	assert.equal(await resolveSelf(db, owner), null, "a retired person is no row");
	await admin.execute(sql`UPDATE person SET state='live',retired_at=NULL WHERE id=${people.alexRivera}`);
	const orgOwner = await actor("orgOwner");
	assert.equal(await resolveSelf(db, orgOwner), null, "not a plant context");
	const start = queries.length;
	await resolveSelf(db, owner);
	assert.equal(queries.length - start, 1, "one statement");
});

test("INV-evry-self: only the user's own row carries you; the list and its total still include the user", async () => {
	await link("owner", people.alexRivera);
	const owner = { ...(await actor("owner")), selfPersonId: await resolveSelf(db, await actor("owner")) };
	const listed = await invokeRead(db, owner, listPeople, { limit: 100 });
	const mine = listed.rows.filter((r) => r.fields.you === true);
	assert.deepEqual(
		mine.map((r) => [r.id, r.label, r.fields]),
		[[people.alexRivera, "Alex Rivera", { city: "Chicago", stage: "prospect", you: true }]],
	);
	assert.ok(listed.rows.every((r) => r.id === people.alexRivera || !("you" in r.fields)));
	const everyone = await invokeRead(db, { ...owner, selfPersonId: null }, listPeople, { limit: 100 });
	assert.equal(listed.total, everyone.total, "the user stays in the total");
	assert.ok(everyone.rows.length > 0 && everyone.rows.every((r) => !("you" in r.fields)));

	const own = await invokeRead(db, owner, getPerson, { personId: people.alexRivera });
	assert.deepEqual(own.rows, [
		{
			kind: "person",
			id: people.alexRivera,
			label: "Alex Rivera",
			fields: { city: "Chicago", stage: "prospect", you: true },
		},
	]);
	const other = await invokeRead(db, owner, getPerson, { personId: people.alexChen });
	assert.deepEqual(other.rows[0]!.fields, { city: "Evanston", stage: "prospect" });

	const board = await invokeRead(db, owner, getPipelineData, { limit: 100 });
	const youRows = board.rows.filter((r) => r.fields.you === true);
	assert.deepEqual(
		youRows.map((r) => r.id),
		[people.alexRivera],
	);
	assert.ok(board.rows.every((r) => r.kind === "person" && (r.id === people.alexRivera || !("you" in r.fields))));
});

test("INV-evry-self: the shared row helper marks exactly the user's id", () => {
	assert.deepEqual(personRow({ selfPersonId: "a" }, "a", "A", { x: null }).fields, { x: null, you: true });
	assert.deepEqual(personRow({ selfPersonId: "a" }, "b", "B", { x: null }).fields, { x: null });
	assert.deepEqual(personRow({ selfPersonId: null }, "a", "A", {}).fields, {});
});

test("INV-evry-self: the compiled system prompt names the you marker and the never-suggest rule", async () => {
	const owner = await actor("owner");
	const { system } = compileContext({
		actor: owner,
		catalog: readCatalog(owner),
		history: [],
		text: "who should I follow up with?",
		references: [],
		now: new Date("2026-11-02T12:00:00Z"),
	});
	assert.match(system, /marked you: true is the signed-in user/);
	assert.match(system, /Never suggest the user as someone to follow up with, contact, visit or invite/);
	assert.match(system, /call it "you"/);
});
