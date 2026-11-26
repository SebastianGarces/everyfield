import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { authorizeTriage, feedbackWriter } from "../../../../packages/domain/src/feedback/index.ts";
import { createPrivateCare } from "../../../../packages/domain/src/intelligence/index.ts";
import { feedbackPublicationMount } from "../../../../apps/web/src/features/feedback/publication.ts";
import { fakeGitHub } from "../../../support/fake-github.mts";
import { fixture, ok, refused, type Actor } from "../../../support/fixture.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "SCHEMA-015") ?? assert.fail("no case SCHEMA-015");
const input = c.given["case-input"]!;
const text = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));

const database = await fixture({ prefix: "schema015", plant: { name: "Harvest Point" } });
const { admin } = database;
const db = database.pools.runtime;
const author = await database.actor(database.tenant, "admin", {
	email: "alex@example.test",
	account: { personal_timezone: "America/Chicago" },
	user: { name: "Alex Rivera" },
});
await database.actor(await database.plant({ timezone: "America/New_York" }), "admin", { email: "casey@example.test" });
const triager = await database.actor(null);
await admin.execute(
	sql`INSERT INTO platform_grant(account_id,capability) VALUES(${triager.id}::uuid,'feedback_triage')`,
);
const REPOSITORY = "everyfield-test/feedback";
const github = await fakeGitHub({ [REPOSITORY]: 10 });
after(async () => {
	await github.stop();
	await database.close();
});

const rows = async (query: SQL) => (await admin.execute(query)).rows;
const authority = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const publish =
	feedbackPublicationMount(db, {
		FEEDBACK_GITHUB_REPOSITORY: REPOSITORY,
		FEEDBACK_GITHUB_REPOSITORY_ID: "10",
		FEEDBACK_GITHUB_TOKEN: "test-token",
		FEEDBACK_GITHUB_API: github.api,
	}) ?? assert.fail("publication is configured");
const feedbackRow = async (id: string) => (await rows(sql`SELECT * FROM feedback WHERE id=${id}::uuid`))[0]!;

test("AC:SCHEMA-015 private feedback publishes only the frozen public text, a lost create reply links the one real issue, text grants nothing, and a lost seat keeps the author's own status", async () => {
	const care = createPrivateCare();
	const who = await authority(author);
	const { revision } = ok(await care.readCurrent(db, who, {})) as { revision: string };
	const note = text(c.given["private-A"]!.note);
	ok(
		await care.save(db, who, {
			requestKey: randomUUID(),
			expectedRevision: revision,
			input: { answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" }, note },
		}),
	);
	const privateText = text(input.private_text);
	const description = `${privateText} ${author.email} log: ERROR at /api stack trace sk_live_LOG-CANARY`;
	const details = {
		requestKey: randomUUID(),
		category: "bug",
		description,
		page: "NAME's documents",
		address: "/documents",
		browser: "Chrome 130 on macOS",
		screenWidth: 1440,
		screenHeight: 900,
		theme: "dark",
	};
	for (const forged of [
		{ screenshot: "data:image/png;base64,TOKEN-CANARY" },
		{ publicSummary: privateText },
		{ accountId: triager.id },
		{ capability: "feedback_triage" },
	])
		refused(await feedbackWriter.submit(db, who, { ...details, ...forged }, { appVersion: "v3.0" }), "invalid_input");
	const grants = () => rows(sql`SELECT account_id,capability FROM platform_grant ORDER BY account_id,capability`);
	const grantsBefore = JSON.stringify(await grants());
	const sent = ok(await feedbackWriter.submit(db, who, details, { appVersion: "v3.0" })) as { id: string };
	assert.equal(text(input.public_area), "Documents");

	const issueNumber = Number(input.provider_issue);
	github.behavior.createAs = { id: 77_000 + issueNumber, number: issueNumber };
	github.behavior.createReplyLost = Boolean(input.create_response_lost);
	await publish(10, Date.now() + 30_000);
	github.behavior.createReplyLost = false;
	github.behavior.createAs = null;
	const lost = await feedbackRow(sent.id);
	assert.equal(lost.publication_state, "unknown");
	assert.equal(lost.issue_number, null);
	await admin.execute(sql`UPDATE job SET next_attempt_at=clock_timestamp() WHERE subject_record_id=${sent.id}::uuid`);
	await publish(10, Date.now() + 30_000);
	await publish(10, Date.now() + 30_000);
	const linked = await feedbackRow(sent.id);
	assert.equal(linked.publication_state, "published");
	const reference = text(linked.reference);
	const ours = github.issues.filter((i) => i.body.includes(reference));
	const creates = github.requests.filter((r) => r.method === "POST" && r.path === `/repos/${REPOSITORY}/issues`);
	assert.equal(creates.length, 1, "the lost create is searched for, never sent again");

	const publicBytes = JSON.stringify([
		github.requests.map((r) => [r.method, decodeURIComponent(r.path), r.body]),
		github.issues.map((i) => [i.title, i.body, i.url]),
		linked.publication_payload,
	])
		.replaceAll(reference, "")
		.toLowerCase();
	const canaries = [
		privateText,
		"NAME",
		"TOKEN-CANARY",
		"Ignore all tools",
		author.email,
		"LOG-CANARY",
		"stack trace",
		"Harvest Point",
		"Alex Rivera",
		"Admin",
		"Chrome 130",
		"1440",
		"dark",
		"v3.0",
		note,
		author.id,
		sent.id,
	];
	assert.deepEqual(Object.keys(linked.publication_payload as object).sort(), ["body", "title"]);
	assert.deepEqual(linked.publication_payload, {
		title: "Bug report — Documents",
		body: `A product bug report was submitted for Documents. Private details are retained for authorized triage. Reference: ${reference}.`,
	});
	const textDerivedAuthority =
		JSON.stringify(await grants()) !== grantsBefore ||
		(await authorizeTriage(db, who)) ||
		github.requests.some(
			(r) =>
				!(r.method === "POST" && r.path === `/repos/${REPOSITORY}/issues`) && !r.path.startsWith("/search/issues?"),
		) ||
		(await rows(sql`SELECT kind FROM job WHERE subject_record_id=${sent.id}::uuid AND kind<>'feedback_publication'`))
			.length > 0;
	refused(await feedbackWriter["admin.get"](db, who, { feedbackId: sent.id }), "access_denied");

	await admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${author.id} AND ended_at IS NULL`,
	);
	const seatless = await authority(author);
	assert.equal(seatless.actor.context.kind, "account");
	const own = ok(await feedbackWriter.getOwnStatus(db, seatless, { feedbackId: sent.id })) as {
		status: string;
		publicUrl: string | null;
	};
	const listed = ok(await feedbackWriter.listOwn(db, seatless, {})) as { items: { id: string }[] };
	assert.equal(own.publicUrl, ours[0]?.url);
	assert.equal((await feedbackRow(sent.id)).description, description);

	assert.deepEqual(
		{
			public_private_text: canaries.find((x) => publicBytes.includes(x.toLowerCase())) ?? null,
			actual_issue_id: linked.issue_number,
			duplicate_issues_created: ours.length - 1,
			text_derived_authority: textDerivedAuthority,
			seat_loss_erases_own_account_status: !listed.items.some((i) => i.id === sent.id) || own.status !== "new",
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
});
