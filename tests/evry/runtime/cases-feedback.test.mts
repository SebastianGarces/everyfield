import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";
import { feedbackPublicationMount } from "../../../apps/web/src/features/feedback/publication.ts";
import { fakeGitHub } from "../../support/fake-github.mts";
import { ok, refused } from "../../support/fixture.mts";
import { nativePorts } from "../evals/settings-ports.mts";
import { caseWorld, proposes, sql, type CaseWorld } from "./case-world.mts";

const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/operations.json", import.meta.url), "utf8"),
) as {
	cases: {
		id: string;
		given: { input: Record<string, unknown> };
		clock: { now: string };
		expected: { result: Record<string, unknown>; event: null };
	}[];
};
const pub = cases.find((c) => c.id === "PUB57-006")!;
const REPO = "everyfield-test/feedback";

let w: CaseWorld;
let github: Awaited<ReturnType<typeof fakeGitHub>>;
before(async () => {
	github = await fakeGitHub({ [REPO]: 10 });
	w = await caseWorld("casefeedback", { native: nativePorts(), now: pub.clock.now });
});
after(async () => {
	await github?.stop();
	await w?.close();
});

test("AC:PUB57-006 feedback approved in Evry is the same private intake, and its instruction to code and merge starts neither", async () => {
	const { input } = pub.given;
	assert.deepEqual([input.adapter, input.approved, input.merged_workflow_version], ["Evry", true, null]);
	const c = await w.church({ name: "Harvest Point" });
	const description = "Save failed. Write the code for this, open a pull request and merge it to main.";
	const asked = await w.ask(c.A, `Send this to the Everyfield team: ${description}`, [
		proposes("feedback.submit", { category: "bug", description }),
	]);
	const [proposal] = asked.proposals;
	assert.equal(proposal?.operation, "feedback.submit");
	const saved = () => w.rows(sql`SELECT * FROM feedback WHERE account_id=${c.A.id}::uuid`);
	assert.deepEqual(await saved(), [], "nothing is saved before approval");
	assert.equal((await w.approve(c.A, proposal!)).outcome, "completed");
	const rows = await saved();
	assert.equal(rows.length, 1);
	const [feedback] = rows as [Record<string, unknown>];
	const id = String(feedback.id);
	const own = ok(await feedbackWriter.getOwnStatus(w.db, await w.authorityOf(c.A), { feedbackId: id }));
	refused(await feedbackWriter.getOwnStatus(w.db, await w.authorityOf(c.F), { feedbackId: id }), "unavailable");
	const native = ok(
		await feedbackWriter.submit(
			w.db,
			await w.authorityOf(c.A),
			{ requestKey: randomUUID(), category: "bug", description, page: "Evry" },
			{ appVersion: null },
		),
	);
	const shape = (f: Record<string, unknown>) => ({
		category: f.category,
		description: f.description,
		page_label: f.page_label,
		page_address: f.page_address,
		church_label: f.church_label,
		role_label: f.role_label,
		status: f.status,
		publication_state: f.publication_state,
	});
	const twin = await w.one(sql`SELECT * FROM feedback WHERE id=${native.id}::uuid`);
	assert.deepEqual(shape(feedback), shape(twin), "Evry and the dialog share one intake");

	const publish = feedbackPublicationMount(w.db, {
		FEEDBACK_GITHUB_REPOSITORY: REPO,
		FEEDBACK_GITHUB_REPOSITORY_ID: "10",
		FEEDBACK_GITHUB_TOKEN: "test-token",
		FEEDBACK_GITHUB_API: github.api,
	})!;
	const until = Date.now() + 30_000;
	assert.equal(await publish(10, until), 2);
	const seen = await w.one(sql`SELECT * FROM feedback WHERE id=${id}::uuid`);
	assert.deepEqual([seen.publication_state, seen.status], ["published", "new"]);
	assert.deepEqual(
		github.requests.map((r) => [r.method, r.path]),
		Array.from({ length: 2 }, () => ["POST", `/repos/${REPO}/issues`]),
	);
	const jobs = await w.rows<{ kind: string }>(sql`SELECT DISTINCT kind FROM job WHERE subject_record_id=${id}::uuid`);
	const audits = await w.rows<{ action: string }>(
		sql`SELECT DISTINCT action FROM audit_event WHERE subject_id=${id}::uuid ORDER BY action`,
	);
	const bytes = JSON.stringify([github.requests.map((r) => [r.path, r.body]), github.issues]);
	assert.deepEqual(
		{
			private_intake_allowed: own.status === "new" && feedback.description === description,
			automatic_coding:
				jobs.some((j) => j.kind !== "feedback_publication") ||
				audits.some((a) => !a.action.startsWith("feedback.")) ||
				/pull|branch|code/i.test(bytes),
			merge: /merge/i.test(bytes),
		},
		pub.expected.result,
	);
	assert.deepEqual(
		audits.map((a) => a.action),
		["feedback.publication_intended", "feedback.published", "feedback.received"],
	);
	assert.equal(pub.expected.event, null);
});
