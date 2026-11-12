import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { PeopleReadContext, readPersonPhotos } from "../../../packages/domain/src/people/index.ts";
import { ok, refused } from "../../support/fixture.mts";

// T-274: Evry's result cards ask for the current photos of the person rows they show, by person id, apart from Evry.
// The lookup applies the People list rule and reads the photos as they are now on every call.

let f, plant, other, viewer;
async function account(w = plant, role = "member") {
	const a = await f.account();
	if (w) await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
/** The account's photo is now a new version, as Settings' finalize leaves it. */
async function setAvatar(a) {
	const versionId = randomUUID();
	await f.admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,
		sha256,state,upload_key,claim_generation) VALUES(${versionId},${a.id},'avatar',${`private/${a.id}/${versionId}`},
		'image/png',1,1,${"0".repeat(64)},'ready',${versionId},0)`);
	await f.admin.execute(sql`UPDATE account SET avatar_object_id=${versionId} WHERE id=${a.id}`);
	return { accountId: a.id, versionId };
}
async function person(name, linked = null, w = plant) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${id},${w.id},${w.id},${name},'other',
		'prospect','unknown','unknown',0,'live',clock_timestamp(),${linked?.id ?? null})`);
	return id;
}
const lookup = async (personIds, who = viewer) =>
	readPersonPhotos(f.db, new PeopleReadContext(who.actor), { personIds });
const photos = async (personIds, who) =>
	Object.fromEntries(ok(await lookup(personIds, who)).photos.map((p) => [p.personId, p.photo]));

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	other = await f.workspace();
	viewer = await account(plant, "member");
});
after(() => f?.close());

test("AC:TARGET-IDN-006 T-274 Done 4-5: the photos of the asked people as they are now, by the People list rule", async () => {
	const holder = await account(),
		bare = await account();
	const first = await setAvatar(holder);
	const h = await person("Holder", holder),
		b = await person("Bare", bare),
		u = await person("Unlinked"),
		foreign = await person("Foreign", await account(other), other);
	assert.deepEqual(await photos([h, b, u, foreign]), { [h]: { kind: "account", ...first } });

	// A replaced photo shows its new version on the next call; a removed one or an ended seat shows none.
	const replaced = await setAvatar(holder);
	assert.deepEqual(await photos([h]), { [h]: { kind: "account", ...replaced } });
	await f.admin.execute(sql`UPDATE account SET avatar_object_id=NULL WHERE id=${holder.id}`);
	assert.deepEqual(await photos([h]), {});
	await setAvatar(holder);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${holder.id}`);
	assert.deepEqual(await photos([h]), {});
});

test("AC:TARGET-IDN-006 T-274: a reader whose seat ended gets a refusal, and a request past one page is refused", async () => {
	const leaving = await account();
	const holder = await account();
	await setAvatar(holder);
	const h = await person("Holder", holder);
	assert.equal(Object.keys(await photos([h], leaving)).length, 1);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${leaving.id}`);
	refused(await lookup([h], leaving));
	refused(await lookup(Array.from({ length: 101 }, () => randomUUID())), "invalid_input");
});
