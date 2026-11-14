// The seat, Settings, sharing, connection, account and organization evals (T-327) on the scripted model. Each case in
// settings.cases.json is asked the way the app asks it: a real turn (runTurn) in Hope Fellowship (golden-church.mts)
// with the real catalog, reads and review cards. A case with `approve` is then approved and its effect run through the
// WP-031 queue with the same native services the Settings screens use; its check reads the result back through those
// screens' own reads. No paid model, network or recording: the scripted model is deterministic.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import type { PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	readConversation,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { createSeatService } from "../../../packages/domain/src/identity/index.ts";
import { readPlantSharing } from "../../../packages/domain/src/organizations/index.ts";
import { nativePorts } from "./settings-ports.mts";
import { goldenChurch, NETWORK, PLANT, type GoldenChurch } from "./golden-church.mts";

type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	criterion: number;
	actor: "owner" | "member" | "network";
	ask: string;
	conversation?: string;
	attachPhoto?: true;
	operation?: string;
	noReview?: true;
	calls: string[];
	answer?: string[];
	proposal?: { operation: string; target: string; changes?: Change[]; notes?: string[]; refusal?: string | null };
	approve?: true;
};
const { cases } = JSON.parse(readFileSync(new URL("./settings.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

let church: GoldenChurch;
let db: Database;
/** Every email the native commands queued, in order: seat invitations and connection invitations. */
const mail: { to: string; purpose: string }[] = [];
const native: NativePorts = nativePorts(mail);
const objects = new Map<string, Buffer>();
const storage = {
	bucket: "synthetic-only",
	client: {
		async send(command: { constructor: { name: string }; input: { Key: string } }) {
			const body = objects.get(command.input.Key);
			if (command.constructor.name !== "GetObjectCommand" || !body) throw Error("unexpected provider call");
			return { ContentLength: body.length, Body: { transformToByteArray: async () => new Uint8Array(body) } };
		},
	},
} as never as PrivateStorage;
/** A 1x1 PNG. */
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);

const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

before(async () => {
	church = await goldenChurch({ seatNames: true });
	db = church.db;
});
after(() => church?.close());

/** One turn as the app runs it: submitted, claimed from the queue, run on the scripted model and finished. */
async function ask(actor: EvryActor, conversationId: string, text: string, references: unknown[] = []) {
	await submitTurn(db, actor, conversationId, { requestKey: randomUUID(), text, references });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const read = await readConversation(db, actor, conversationId);
	const start = read.events.findLastIndex((e) => e.kind === "user_message");
	const turn = read.events.slice(start + 1);
	const reads = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof e.body.operation === "string" && e.body.operation !== "evry.prepareProposal"
			? [e.body.operation]
			: [],
	);
	const answer = turn
		.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
		.join("");
	const ids = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof (e.body.result as { proposalId?: unknown })?.proposalId === "string"
			? [(e.body.result as { proposalId: string }).proposalId]
			: [],
	);
	const proposals = ids.map((id) => read.reviews[id]).filter((p): p is Proposal => Boolean(p));
	return { reads, answer, proposals };
}

/** The trusted approval of the exact revision shown, then the effect run once through the WP-031 queue. */
async function approveAndRun(actor: EvryActor, proposal: Proposal) {
	await approveProposal(db, actor, proposal.id, { revision: proposal.revision, digest: proposal.digest }, storage);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the effect is queued");
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
		null,
		native,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

// What Settings shows, read through the Settings screens' own native reads or the columns they show.
const seatsScreen = async (actor: EvryActor) =>
	(await createSeatService(db).list(actor.authority, { workspace: actor.owner })).items
		.filter((s) => s.status === "active")
		.map((s) => [s.displayName, s.role])
		.sort();
const invitationsScreen = async (actor: EvryActor) =>
	(await native.invitations(db).list(actor.authority, { workspace: actor.owner })).items
		.map((i) => [i.recipientEmail, i.subject.purpose === "seat" ? i.subject.role : null])
		.sort();
const sharingScreen = async (actor: EvryActor) =>
	Object.values(await readPlantSharing(db, actor.authority)).map(({ sharing }) => [
		"organizationDisplayName" in sharing ? sharing.organizationDisplayName : null,
		"choices" in sharing ? Object.entries(sharing.choices).flatMap(([c, on]) => (on ? [c] : [])) : null,
	]);
const row = async (query: ReturnType<typeof sql>) =>
	(await church.db.execute(query)).rows[0] as Record<string, unknown>;

/** What each approved case changes, read back as Settings shows it; `before` runs before approval. */
const SETTLED: Record<string, { before?: (a: EvryActor) => Promise<void>; after: (a: EvryActor) => Promise<void> }> = {
	"SET-04": {
		before: async (a) => assert.deepEqual(await invitationsScreen(a), [["jordan@example.test", "member"]]),
		after: async (a) => {
			assert.deepEqual(await invitationsScreen(a), [
				["ana@example.test", "admin"],
				["jordan@example.test", "member"],
			]);
			assert.deepEqual(mail.at(-1), { to: "ana@example.test", purpose: "seat_invitation" });
		},
	},
	"SET-05": {
		after: async () => {
			assert.deepEqual(mail.at(-1), { to: "jordan@example.test", purpose: "seat_invitation" });
			const i = await row(
				sql`SELECT revision::int AS revision, resent_at IS NOT NULL AS resent FROM invitation WHERE recipient_email='jordan@example.test'`,
			);
			assert.deepEqual(i, { revision: 2, resent: true });
		},
	},
	"SET-06": {
		before: async (a) => assert.equal((await invitationsScreen(a)).length, 2),
		after: async (a) => assert.deepEqual(await invitationsScreen(a), [["jordan@example.test", "member"]]),
	},
	"SET-08": {
		before: async (a) =>
			assert.deepEqual(await seatsScreen(a), [
				["Lena Park", "admin"],
				["Nate Ellis", "owner"],
				["Priya Shah", "member"],
			]),
		after: async (a) =>
			assert.deepEqual(await seatsScreen(a), [
				["Lena Park", "admin"],
				["Nate Ellis", "owner"],
				["Priya Shah", "admin"],
			]),
	},
	"SET-09": {
		after: async (a) =>
			assert.deepEqual(await seatsScreen(a), [
				["Nate Ellis", "owner"],
				["Priya Shah", "admin"],
			]),
	},
	"SET-10": {
		before: async () =>
			assert.deepEqual(await row(sql`SELECT timezone FROM plant WHERE id=${PLANT}`), { timezone: "America/Chicago" }),
		after: async () =>
			assert.deepEqual(await row(sql`SELECT timezone FROM plant WHERE id=${PLANT}`), { timezone: "America/New_York" }),
	},
	"SET-12": {
		before: async (a) => assert.deepEqual(await sharingScreen(a), [["Hill Country Network", ["people", "meetings"]]]),
		after: async (a) => assert.deepEqual(await sharingScreen(a), [["Hill Country Network", ["people"]]]),
	},
	"SET-13": {
		before: async () =>
			assert.deepEqual(
				await row(sql`SELECT count(*)::int AS n FROM invitation WHERE tenant_id=${PLANT} AND purpose<>'seat'`),
				{ n: 0 },
			),
		after: async () => {
			assert.deepEqual(
				await row(
					sql`SELECT i.state, i.recipient_email FROM invitation i WHERE i.tenant_id=${PLANT} AND i.purpose<>'seat'`,
				),
				{ state: "pending", recipient_email: "connect@graceaustin.example.test" },
			);
			assert.deepEqual(mail.at(-1), { to: "connect@graceaustin.example.test", purpose: "relationship_invitation" });
		},
	},
	"SET-14": {
		after: async (a) => assert.deepEqual(await sharingScreen(a), []),
	},
	"SET-15": {
		before: async (a) =>
			assert.deepEqual(await row(sql`SELECT avatar_object_id FROM account WHERE id=${a.accountId}`), {
				avatar_object_id: null,
			}),
		after: async (a) =>
			assert.deepEqual(await row(sql`SELECT avatar_object_id FROM account WHERE id=${a.accountId}`), {
				avatar_object_id: photo,
			}),
	},
	"SET-20": {
		before: async () => assert.deepEqual(await row(sql`SELECT city FROM plant WHERE id=${PLANT}`), { city: "Austin" }),
		after: async () =>
			assert.deepEqual(await row(sql`SELECT city FROM plant WHERE id=${PLANT}`), { city: "Round Rock" }),
	},
	"SET-22": {
		after: async () =>
			assert.deepEqual(await row(sql`SELECT description FROM organization WHERE id=${NETWORK}`), {
				description: "We help churches plant churches across Central Texas.",
			}),
	},
};

/** The Owner's staged photo upload, as the panel's attach control leaves it (Settings' requestAvatarUpload and bytes). */
let photo: string | null = null;
async function stagePhoto(actor: EvryActor) {
	photo = randomUUID();
	const key = `private/${actor.accountId}/${photo}`;
	objects.set(key, png);
	await church.db
		.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation,expires_at)
		VALUES(${photo},${actor.accountId},'avatar',${key},'image/png',${png.length},${png.length},${createHash("sha256").update(png).digest("hex")},'ready',${photo},0,clock_timestamp()+interval '15 minutes')`);
	return [{ kind: "photo", id: photo }];
}

test("INV-evry-settings: every seat, Settings, sharing, connection, account and organization case passes on the scripted model, and each approved change reads back in Settings", async () => {
	const conversations = new Map<string, string>();
	for (const c of cases) {
		const actor = church.actors[c.actor];
		const key = c.conversation ?? c.id;
		if (!conversations.has(key))
			conversations.set(key, (await createConversation(db, actor, { requestKey: randomUUID() })).id);
		const references = c.attachPhoto ? await stagePhoto(actor) : [];
		await SETTLED[c.id]?.before?.(actor);
		const turn = await ask(actor, conversations.get(key)!, c.ask, references);
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, `${c.id} prepares no review`);
			continue;
		}
		assert.equal(turn.proposals.length, 1, `${c.id} prepares one review: ${turn.answer}`);
		const [proposal] = turn.proposals as [Proposal];
		const expected = c.proposal;
		assert.equal(proposal.operation, expected.operation, c.id);
		assert.equal(proposal.status, "pending", `${c.id}: nothing runs before approval`);
		assert.equal(proposal.review.target?.label, expected.target, `${c.id} target`);
		if (expected.changes) assert.deepEqual(proposal.review.changes, expected.changes, `${c.id} changes`);
		for (const line of expected.notes ?? [])
			assert.ok(
				proposal.review.notes?.some((n) => n.includes(line)),
				`${c.id} notes ${JSON.stringify(proposal.review.notes)} have ${line}`,
			);
		if (expected.refusal !== undefined)
			assert.equal(proposal.review.refusal ?? null, expected.refusal, `${c.id} refusal`);
		// Still nothing changed: the review is only a card.
		await SETTLED[c.id]?.before?.(actor);
		if (!c.approve) continue;
		assert.equal(await approveAndRun(actor, proposal), "completed", `${c.id} runs once approved`);
		await SETTLED[c.id]!.after(actor);
	}
});
