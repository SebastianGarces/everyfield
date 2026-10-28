import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { searchPeople } from "../../../packages/domain/src/people/index.ts";

// The shared person-search rule that the meetings pickers use (and Compose recipients will): the start of a name word
// or of the email local part, never the email domain; case and diacritics ignored; digits match a phone from three.

let f, plant, other, owner, member;
let statements = 0;
const rows = (name, email, phone = null, w = plant, state = "live") =>
	f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,phone,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${randomUUID()},${w.id},${w.id},${name},${email},${phone},
		'other','prospect','unknown','unknown',0,${state},clock_timestamp())`);
const search = async (query, who = owner, w = plant) => {
	const r = await f.db.transaction((tx) =>
		searchPeople(tx, { session: who.session, selected: { kind: "plant", id: w.id } }, query),
	);
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value.map((p) => p.name).sort();
};

before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			statements++;
			return Reflect.apply(query, this, args);
		};
	});
	plant = await f.workspace();
	other = await f.workspace();
	const seated = async (w, role) => {
		const a = await f.account();
		await f.seat(a, w, role);
		return a;
	};
	owner = await seated(plant, "owner");
	member = await seated(plant, "member");
	await rows("Daniel Reyes", "daniel.reyes@church.test");
	await rows("Maria Santos", "maria@example.test");
	await rows("Ana Lee", "ana@example.test");
	await rows("Rosa Bennett", "rosa@example.test");
	await rows("Sara Nunez", null);
	await rows("José Núñez-Pérez", "jose.n@example.test", "+1 (555) 010-2233");
	await rows("Retired Sam", "sam@example.test", null, plant, "retired");
	await rows("Sam Elsewhere", "sam@example.test", null, other);
});
after(() => f?.close());

test("AC:TARGET-MTG-011 a query word matches the start of a name word or the email local part, never the domain", async () => {
	assert.deepEqual(await search("s"), ["Maria Santos", "Sara Nunez"]);
	assert.deepEqual(await search("maria s"), ["Maria Santos"]);
	assert.deepEqual(await search("ros"), ["Rosa Bennett"]);
	assert.deepEqual(await search("ennett"), []);
	assert.deepEqual(await search("example"), []);
	assert.deepEqual(await search("test"), []);
	assert.deepEqual(await search("reyes"), ["Daniel Reyes"]);
	assert.deepEqual(await search("jose.n"), []);
	assert.deepEqual(await search("n"), ["José Núñez-Pérez", "Sara Nunez"]);
	assert.deepEqual(await search("   "), []);
});

test("AC:TARGET-MTG-011 case and diacritics are ignored, hyphens split name words, others' people and retired people are not found", async () => {
	assert.deepEqual(await search("jose"), ["José Núñez-Pérez"]);
	assert.deepEqual(await search("JOSÉ"), ["José Núñez-Pérez"]);
	assert.deepEqual(await search("nunez"), ["José Núñez-Pérez", "Sara Nunez"]);
	assert.deepEqual(await search("perez"), ["José Núñez-Pérez"]);
	assert.deepEqual(await search("sam"), []);
});

test("AC:TARGET-MTG-011 a phone query needs three digits and matches the phone digits", async () => {
	assert.deepEqual(await search("555"), ["José Núñez-Pérez"]);
	assert.deepEqual(await search("(555) 010"), ["José Núñez-Pérez"]);
	assert.deepEqual(await search("+1 555-010-2233"), ["José Núñez-Pérez"]);
	assert.deepEqual(await search("55"), []);
	assert.deepEqual(await search("0102233"), ["José Núñez-Pérez"]);
});

test("INV-access the search keeps the live access check, returns at most 8 and sends a fixed number of statements", async () => {
	const count = async (query) => {
		const before = statements;
		await search(query);
		return statements - before;
	};
	for (let i = 0; i < 12; i++) await rows(`Zed Person${i}`, `zed${i}@example.test`);
	assert.equal((await search("zed")).length, 8);
	const none = await count("qqqq"),
		many = await count("zed"),
		phone = await count("555");
	assert.equal(many, none);
	assert.equal(phone, none);
	// A member sees what main let a member see; a seat from another church is refused, not empty.
	const outsider = await f.account();
	const refused = await f.db.transaction((tx) =>
		searchPeople(tx, { session: outsider.session, selected: { kind: "plant", id: plant.id } }, "s"),
	);
	assert.equal(refused.status, "refused");
	void member;
});
