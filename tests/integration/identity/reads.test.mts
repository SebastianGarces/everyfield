import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./invitations-support.mts";
import { sql } from "../../../packages/db/src/query.ts";
import { readViewer } from "../../../packages/domain/src/access/index.ts";
import { readHistory } from "../../../packages/domain/src/organizations/index.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
let f;
let recording = false;
let statements = [];
before(async () => {
	f = await fixture();
	const instrumented = new WeakSet();
	f.db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
});
after(async () => {
	await f?.close();
});
async function count(body) {
	statements = [];
	recording = true;
	try {
		const value = await body();
		return { value, statements: [...statements] };
	} finally {
		recording = false;
	}
}

test("INV-reads: viewer, roster, invitation list and sharing history use one or two statements without locks", async (t) => {
	const s = await f.setup();
	const network = await f.workspace("sending_church");
	await f.admin.execute(
		sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${s.w.id},${network.id},clock_timestamp(),false,false,false,false,false,false,false)`,
	);
	const viewer = await count(() => readViewer(f.db, sessionId.parse(s.sender.session)));
	assert.equal(viewer.statements.length, 1);
	assert.equal(viewer.value.registration, "active");
	assert.deepEqual(viewer.value.authority.actor.context.owner, s.w);
	assert.equal(viewer.value.person, null);
	const authority = viewer.value.authority;
	const roster = await count(() => f.seats.list(authority, { workspace: s.w }));
	assert.equal(roster.statements.length, 1);
	assert.deepEqual(
		roster.value.items.map((i) => [i.role, i.isSelf, i.joined.source]),
		[["owner", true, "original_account_fallback"]],
	);
	const invitations = await count(() => f.invitations.list(authority, { workspace: s.w }));
	assert.equal(invitations.statements.length, 1);
	assert.deepEqual(invitations.value.items, []);
	const history = await count(() => readHistory(f.db, authority, { plant: s.w }));
	assert.equal(history.statements.length, 2);
	assert.equal(history.value.status, "available");
	assert.deepEqual(
		history.value.activeRelationships.map((r) => r.pair.organization.id),
		[network.id],
	);
	const all = [viewer, roster, invitations, history].flatMap((r) => r.statements);
	t.diagnostic(JSON.stringify({ viewer: 1, roster: 1, invitations: 1, history: 2 }));
	assert.equal(
		all.some((q) => /for\s+(update|share)/i.test(q)),
		false,
		"page reads must not lock rows",
	);
});
