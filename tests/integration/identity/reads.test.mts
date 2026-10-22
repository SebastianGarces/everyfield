import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./invitations-support.mts";
import { sql } from "../../../packages/db/src/query.ts";
import {
	currentActor,
	readOwnResidency,
	readRequestViewer,
	readViewer,
} from "../../../packages/domain/src/access/index.ts";
import {
	readHistory,
	readPlantSharing,
	readSharingDisclosure,
} from "../../../packages/domain/src/organizations/index.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import { signedSessionToken } from "../../../packages/domain/src/identity/index.ts";
import { createHmac } from "node:crypto";
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

test("INV-reads: viewer, roster, invitation list, sharing history, sharing choices and disclosure read without locks", async (t) => {
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
	const sharing = await count(() => readPlantSharing(f.db, authority));
	assert.equal(sharing.statements.length, 1);
	const relationshipId = history.value.activeRelationships[0].id;
	assert.equal(sharing.value[relationshipId].sharing.view, "plant_administration");
	assert.deepEqual(sharing.value[relationshipId].sharing.choices.people, false);
	assert.equal(sharing.value[relationshipId].relationshipRevision, "1");
	const disclosure = await count(() =>
		f.db.transaction((tx) =>
			readSharingDisclosure(tx, authority.session, s.w, {
				kind: "plant",
				subject: s.w,
				organization: { kind: "organization", id: network.id, organizationKind: "sending_church" },
			}),
		),
	);
	assert.equal(disclosure.value.kind, "existing_consent");
	// A read transaction that observed the request actor answers currentActor without a statement (D59).
	const observed = await count(() =>
		f.db.transaction(async (tx) => {
			authority.observe(tx);
			return [
				await currentActor(tx, authority.session, s.w),
				await currentActor(tx, authority.session, { kind: "account", id: s.sender.id }),
			];
		}),
	);
	assert.deepEqual(observed.value[0], authority.actor);
	assert.deepEqual(observed.value[1], {
		status: "active",
		accountId: s.sender.id,
		context: { kind: "account", owner: { kind: "account", id: s.sender.id } },
	});
	assert.deepEqual(
		observed.statements.map((q) => q.trim().split(" ")[0].toUpperCase()),
		["BEGIN", "COMMIT"],
	);
	const all = [viewer, roster, invitations, history, sharing, disclosure, observed].flatMap((r) => r.statements);
	t.diagnostic(
		JSON.stringify({
			viewer: 1,
			roster: 1,
			invitations: 1,
			history: 2,
			sharing: 1,
			disclosure: disclosure.statements.length,
		}),
	);
	assert.equal(
		all.some((q) => /for\s+(update|share)/i.test(q)),
		false,
		"page reads must not lock rows",
	);
});

test("RT-1: one lock-free statement reads the request session, its user and the viewer; a revoked session reads nothing", async () => {
	const s = await f.setup();
	const [{ token }] = (await f.admin.execute(sql`SELECT token FROM auth_session WHERE id=${s.sender.session}`)).rows;
	const request = await count(() => readRequestViewer(f.db, token));
	assert.equal(request.statements.length, 1);
	assert.doesNotMatch(request.statements[0], /access_session|for\s+(update|share)/i);
	assert.equal(request.value.session.id, s.sender.session);
	assert.deepEqual(request.value.user, { name: "Synthetic person", email: s.sender.email, emailVerified: true });
	const viewer = await readViewer(f.db, sessionId.parse(s.sender.session));
	const plain = (v) => ({ ...v, authority: v.authority.actor });
	assert.deepEqual(plain(request.value.viewer), plain(viewer));
	assert.equal(await readRequestViewer(f.db, token + "0"), null);
	await f.admin.execute(sql`DELETE FROM auth_session WHERE id=${s.sender.session}`);
	assert.equal(await readRequestViewer(f.db, token), null);
});

test("BUG-RT1-cookie: only Better Auth's exact signed session cookie yields a token; malformed values are refused, never thrown", () => {
	const secret = "s".repeat(32),
		token = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
	const signature = createHmac("sha256", secret).update(token).digest("base64");
	// The value as Next.js cookies() hands it over: already percent-decoded.
	assert.equal(signedSessionToken(`${token}.${signature}`, secret), token);
	for (const bad of [
		`${token}.${signature}!`,
		`${token}.${signature.slice(0, -1)}`,
		`${token}.${signature.replace("=", "")}`,
		`${token}.!${signature.slice(1)}`,
		`${token}.${createHmac("sha256", "t".repeat(32)).update(token).digest("base64")}`,
		encodeURIComponent(`${token}.${signature}`),
		"%",
		"%25",
		"%E0%A4%A",
		`${token}.${signature.slice(0, -1)}%`,
		signature,
		"",
	])
		assert.equal(signedSessionToken(bad, secret), null, JSON.stringify(bad.slice(-6)));
	assert.equal(signedSessionToken(undefined, secret), null);
});

test("INV-reads: a resident's own residency read reuses the observed actor and takes no lock", async (t) => {
	const s = await f.setup("sending_network"),
		person = await f.resident(s.w),
		i = await f.invitation(s, person);
	const accepted = await f.invitations.respondResident(s.recipient.session, {
		...i.claim,
		input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: false, shareMilestones: false } },
	});
	assert.equal(accepted.status, "accepted");
	const viewer = await readViewer(f.db, sessionId.parse(s.recipient.session));
	assert.equal(viewer.authority.actor.context.kind, "account");
	const authority = viewer.authority;
	const residency = await count(() =>
		f.db.transaction((tx) => {
			authority.observe(tx);
			return readOwnResidency(tx, authority.session, s.w, { personId: person });
		}),
	);
	assert.equal(residency.value?.personId, person);
	assert.equal(residency.value?.organization.id, s.w.id);
	t.diagnostic(JSON.stringify({ residency: residency.statements.length }));
	assert.ok(residency.statements.length <= 4, `residency read: ${residency.statements.length} statements`);
	assert.equal(
		residency.statements.some((q) => /for\s+(update|share)|access_session|invitation_identity/i.test(q)),
		false,
		"the residency read must not lock or resolve the actor again",
	);
});
