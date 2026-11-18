import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../identity/invitations-support.mts";
import { readFlags } from "../../../packages/domain/src/flags/index.ts";
import { dashboardReader } from "../../../packages/domain/src/dashboard/index.ts";
import { overviewSubtitle } from "../../../apps/web/src/features/overview/model.ts";
import { withFlag } from "../../support/flags.mts";

let f, plantA, plantB, ownerA, ownerB;

before(async () => {
	f = await fixture();
	plantA = await f.workspace();
	plantB = await f.workspace();
	const seated = async (w) => {
		const account = await f.account();
		await f.seat(account, w, "owner");
		return { ...account, actor: await f.actor(account.session) };
	};
	ownerA = await seated(plantA);
	ownerB = await seated(plantB);
});
after(() => f?.close());

const subtitle = async (who) => {
	const frame = await dashboardReader.readAvailableActions(f.db, who.actor);
	assert.equal(frame.status, "ok", JSON.stringify(frame));
	const flags = await readFlags(f.db, who.actor);
	return overviewSubtitle(frame.value, flags.value("overview-role-subtitle"));
};

test("the Overview subtitle names the viewer's role only while overview-role-subtitle is on for their church", async () => {
	const before = await subtitle(ownerA);
	assert.doesNotMatch(before, /Owner/);
	const during = await withFlag(
		f.db,
		{ flag: "overview-role-subtitle", scope: { kind: "workspace", id: plantA.id }, operator: ownerA.id },
		() => Promise.all([subtitle(ownerA), subtitle(ownerB)]),
	);
	assert.deepEqual(during, [`${before} · Owner`, await subtitle(ownerB)]);
	assert.doesNotMatch(during[1], /Owner/);
	assert.equal(await subtitle(ownerA), before);
});
