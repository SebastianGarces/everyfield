import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	approveProposal,
	flushTraces,
	observeConversation,
	readConversation,
	readReview,
	retryUnresolvedEffects,
} from "../../../packages/evry/src/index.ts";
import { registerTracing } from "../../../packages/evry/src/runtime/trace.ts";
import { scriptedModel } from "../../../packages/evry-scripted/src/index.ts";
import { readiness } from "../../../ops/maintenance/readiness.mts";
import { safeHref } from "../../../apps/web/src/components/markdown.ts";
import {
	caseWorld,
	propose,
	provider,
	reads,
	refusal,
	rowsOf,
	sql,
	type Call,
	type CaseWorld,
	type Church,
} from "./case-world.mts";
import { traceSink } from "./provider.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	expected: { result: Record<string, unknown> };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as {
	cases: Case[];
};
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
type Operation = { id: string; authority: { actors: string[] }[] };
const CATALOG: Operation[] = JSON.parse(
	readFileSync(new URL("../../../docs/catalog/operations.json", import.meta.url), "utf8"),
).operations;
const VIEW = new URL("../../../apps/web/src/features/evry/conversation/view.ts", import.meta.url).href;
const WEB = new URL("../../../apps/web/package.json", import.meta.url).href;
const RENDER = `import { createRequire } from "node:module";
import { renderMarkdown } from ${JSON.stringify(VIEW)};
const web = createRequire(${JSON.stringify(WEB)});
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement, Fragment } = web("react");
let text = "";
for await (const chunk of process.stdin) text += chunk;
process.stdout.write(renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(text))));`;
function rendered(text: string) {
	const out = spawnSync(process.execPath, ["--input-type=module", "-e", RENDER], { input: text, encoding: "utf8" });
	assert.equal(out.status, 0, out.stderr);
	return out.stdout;
}

let w: CaseWorld;
let c: Church;
let traces: Awaited<ReturnType<typeof traceSink>>;
before(async () => {
	traces = await traceSink();
	assert.ok(registerTracing(traces.env));
	w = await caseWorld("casesecurity");
	c = await w.church();
	await w.care(c.A);
});
after(async () => {
	traces?.close();
	await w?.close();
});

async function logged<T>(body: () => Promise<T>) {
	const lines: string[] = [];
	const keep = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
	const { error, log, warn, info } = console;
	Object.assign(console, { error: keep, log: keep, warn: keep, info: keep });
	try {
		const value = await body();
		await flushTraces();
		return { value, lines: lines.join("\n") };
	} finally {
		Object.assign(console, { error, log, warn, info });
	}
}

test("AC:SEC-11 credentials, private care and markup never reach errors, logs, traces or the page as anything but inert text, and no operator inspection is open without an exact grant", async () => {
	const k = caseOf("SEC-11");
	const input = k.given["case-input"]!;
	const { result } = k.expected;
	const CANARY = String(input.credential);
	const credential = `sk-${CANARY}-0123456789abcdef`;
	const CARE = String(input.note);
	const html = String(input.html);
	assert.equal(k.given["private-A"]!.note, "CARE-CANARY-SEC-11");
	traces.take();

	const said = `Find Casey. My key is ${credential}. ${html}`;
	const answer = `Casey Reed is a leader. ${html} [open](javascript:alert(1))`;
	const asked = await logged(() => w.ask(c.A, said, [reads("people.listPeople", { search: "Casey" }), () => answer]));
	const turn = asked.value;
	assert.equal(turn.status.state, "completed");
	assert.ok(rowsOf(turn.replies[0]).some((r) => r.label === "Casey Reed"));
	const down = async (): Promise<never> => {
		throw Object.assign(new Error(`upstream refused ${credential} for ${CARE}`), { code: credential });
	};
	const failed = await logged(() =>
		w.ask(c.A, `Try again with ${credential}`, [], { model: { ...scriptedModel(), doGenerate: down, doStream: down } }),
	);
	assert.deepEqual([failed.value.outcome, failed.value.status.error.code], ["failed", "model_unavailable"]);
	const errorText = JSON.stringify(failed.value.status);
	assert.equal(errorText.includes(CANARY) ? CANARY : null, result.error_secret, "the saved error holds a code only");

	const { events } = await w.eventsOf(c.Aa, turn.conversation);
	const page = JSON.stringify(events.filter((e) => e.kind !== "user_message"));
	const sent = traces.take();
	const logs = [asked.lines, failed.lines].join("\n");
	assert.ok(sent.length > 0, "the turns were traced");
	for (const [where, text] of [
		["model input", JSON.stringify([turn.prompts, failed.value.prompts])],
		["saved answer and status", page + errorText],
		["trace", sent],
		["log", logs],
	] as const) {
		assert.equal(text.includes(CANARY) ? CANARY : null, where === "log" ? result.log_secret : null, where);
		assert.equal(text.includes(CARE) ? CARE : null, where === "trace" ? result.trace_private_metadata : null, where);
	}
	assert.ok(sent.includes("[removed]"), "the trace holds the scrubbed text");

	const user = events.find((e) => e.kind === "user_message")!.body.text as string;
	assert.equal(user.includes(html), true, "the markup is kept as the words that were typed");
	for (const text of [user, turn.text]) {
		const markup = rendered(text);
		assert.equal(/<script|<a |href=/i.test(markup), result.script_executed);
		assert.ok(markup.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), markup);
	}
	assert.equal(safeHref("javascript:alert(1)"), null);

	assert.equal(input.operator_grant, null);
	const operator = CATALOG.filter((o) => o.authority.some((a) => a.actors.some((actor) => /operator/.test(actor)))).map(
		(o) => o.id,
	);
	const care = CATALOG.filter((o) => o.id.startsWith("privateCare.")).map((o) => o.id);
	assert.ok(operator.length > 40 && care.length > 0, `${operator.length} operator operations`);
	const owner = await w.seated(c.P, "owner");
	const opened: string[] = [];
	for (const operations of [...operator, ...care].reduce<string[][]>(
		(all, id, n) => (n % 6 ? all.at(-1)!.push(id) : all.push([id]), all),
		[],
	)) {
		const calls = operations.flatMap((operation): Call[] => [
			{ tool: "people_read", input: { operation, input: { plantId: c.Q.id } } },
			{ tool: "compose_reads", input: { reads: [{ operation, input: {} }] } },
			propose(operation, { plantId: c.Q.id }),
		]);
		const probe = await w.quiet(() => w.ask(owner, "Inspect every church", [() => calls], { onError: "go_on" }));
		for (const operation of operations)
			if ([...probe.offered, ...probe.tools].includes(operation)) opened.push(`${operation} offered`);
		probe.replies.forEach((reply, n) => {
			if (reply.error !== (calls[n]!.tool === "compose_reads" ? "not_a_read" : "not_offered"))
				opened.push(`${calls[n]!.tool} answered ${JSON.stringify(reply).slice(0, 160)}`);
		});
		if (probe.cards.length + probe.proposals.length) opened.push(`${operations.join(",")} carded`);
	}
	assert.equal(opened.length > 0, result.unscoped_operator_read, opened.join("\n"));
	for (const capability of [
		input.operator_grant,
		{ authority: "plant_owner", verified: true, operation_ids: ["ops.readiness"], environment: "isolated-test" },
		{
			authority: "explicit_scoped_operator",
			verified: false,
			operation_ids: ["ops.readiness"],
			environment: "isolated-test",
		},
		{
			authority: "explicit_scoped_operator",
			verified: true,
			operation_ids: ["ops.backup"],
			environment: "isolated-test",
		},
	])
		assert.deepEqual(readiness({ capability, evidence: {}, now: new Date(k.clock.now) }), {
			refusal: "operator_unavailable",
		});
});

const cityOf = async (person: string) => (await w.one(sql`SELECT city FROM person WHERE id=${person}`)).city;
const effectJobs = () => w.count(sql`SELECT count(*)::int AS n FROM job WHERE kind='evry_effect'`);
const allJobs = () => w.rows(sql`SELECT id,kind,state,attempt_count FROM job ORDER BY id`);

test("AC:SEC-12 an effect cut before commit leaves nothing and keeps the old receipt, an unknown provider answer stays unknown and is never resent, a reconnect starts no worker, and a changed review or a revoked actor runs nothing", async () => {
	const k = caseOf("SEC-12");
	const input = k.given["case-input"]!;
	const { result } = k.expected;
	const s = await w.church();
	const earlier = await w.eventsOf(s.Aa, s.C);
	const [old] = Object.values(earlier.reviews);
	assert.ok(old?.receipt, "the earlier change has a receipt");
	const city = (to: string) => w.prepare(s.A, "people.updatePerson", { personId: s.rivera, patch: { city: to } });

	const cut = await city("Joliet");
	const changes = () =>
		w.count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${s.rivera} AND action='people.updated'`);
	const first = await changes();
	const done = await s.failedWrite(cut, "person");
	assert.equal((await changes()) - first - 1, result.new_effects, "the cut write left no effect of its own");
	assert.equal(done.outcome, "completed", "a deliberate retry after the cut completes once");
	const kept = await readReview(w.db, s.Aa, old.id);
	assert.equal(
		kept.outcome === old.outcome && JSON.stringify(kept.receipt) === JSON.stringify(old.receipt),
		result.old_receipt_retained,
		"the old receipt is retained",
	);

	await w.admin.execute(
		sql`UPDATE plant SET street='12 Mill Road',city='Austin',country='United States' WHERE id=${s.P.id}`,
	);
	await w.admin.execute(sql`UPDATE person SET email='casey@example.test' WHERE id=${s.casey}`);
	const venue = randomUUID();
	await w.admin.execute(sql`INSERT INTO venue(id,plant_id,name,address) VALUES(${venue},${s.P.id},'Hall','1 Main St')`);
	const invitation = await w.prepare(s.A, "evry.prepareMeetingInvitation", {
		meeting: { type: "vision_meeting", date: "2026-10-27", time: "19:00", venueId: venue },
		audience: { personIds: [s.casey] },
	});
	const email = provider("unknown");
	const sent = await w.approve(s.A, invitation, email.port);
	assert.equal(input.provider_outcome, result.provider_status);
	assert.deepEqual(
		[sent.outcome, sent.review.receipt?.report?.confirmation, email.sent.length],
		["completed", "not_confirmed", 1],
		"the provider took it and its answer is told as not confirmed",
	);
	for (let n = 0; n < 2; n++) {
		assert.equal((await approveProposal(w.db, s.Aa, invitation.id, w.witness(invitation), null)).replayed, true);
		assert.equal((await retryUnresolvedEffects(w.db, s.Aa, invitation.id)).retried, result.unknown_blind_retry);
		assert.equal(await w.effect(email.port), null);
	}
	assert.equal(email.sent.length, 1, "an unknown send is never repeated blindly");
	assert.equal((await readReview(w.db, s.Aa, invitation.id)).receipt?.report?.confirmation, "not_confirmed");

	const jobs = await allJobs();
	const known = (await w.eventsOf(s.Aa, s.C)).events.length;
	const reconnect = new AbortController();
	let seen = 0;
	for await (const event of observeConversation(w.db, s.Aa, s.C, 0, reconnect.signal, 20))
		if (event.sequence && ++seen === known) reconnect.abort();
	await readConversation(w.db, s.Aa, s.C);
	await readReview(w.db, s.Aa, invitation.id);
	await readReview(w.db, s.Aa, cut.id);
	assert.deepEqual(
		[JSON.stringify(await allJobs()) !== JSON.stringify(jobs), await w.effect(email.port)],
		[result.new_worker_from_reconnect, null],
		"reading again or reconnecting starts no worker",
	);

	assert.notEqual(input.saved_digest, input.resumed_digest);
	const changed = await city("Naperville");
	const before = await effectJobs();
	assert.equal(
		await refusal(
			approveProposal(
				w.db,
				s.Aa,
				changed.id,
				{
					revision: changed.revision,
					digest: createHash("sha256").update(String(input.resumed_digest)).digest("hex"),
				},
				null,
			),
		),
		"review_changed",
	);
	assert.deepEqual([await effectJobs(), await cityOf(s.rivera)], [before, "Joliet"], "a changed review starts nothing");

	const moved = await city("Aurora");
	await approveProposal(w.db, s.Aa, moved.id, w.witness(moved), null);
	await w.admin.execute(sql`UPDATE person SET city='Elgin',revision=revision+1 WHERE id=${s.rivera}`);
	const stale = await w.effect();
	const again = await readReview(w.db, s.Aa, moved.id);
	assert.deepEqual(
		[stale, again.status, again.outcome, again.receipt, await cityOf(s.rivera)],
		["reviewing", "pending", null, null, "Elgin"],
		"a target changed since review is shown for review again and nothing runs",
	);
	assert.notEqual(again.digest, moved.digest);
	assert.equal(await refusal(approveProposal(w.db, s.Aa, moved.id, w.witness(moved), null)), "review_changed");
	assert.deepEqual([await w.effect(), await cityOf(s.rivera)], [null, "Elgin"]);

	assert.equal(input.actor_revoked, true);
	const revoked = await city("Wheaton");
	await approveProposal(w.db, s.Aa, revoked.id, w.witness(revoked), null);
	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${s.A.id}`);
	try {
		assert.equal(await w.effect(), "refused");
	} finally {
		await w.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${s.A.id}`);
	}
	const after = await readReview(w.db, s.Aa, revoked.id);
	assert.deepEqual([after.outcome, after.receipt?.code, await cityOf(s.rivera)], ["refused", "access_denied", "Elgin"]);
	assert.equal(await refusal(retryUnresolvedEffects(w.db, s.Aa, revoked.id)), "review_closed");
	assert.equal(await w.effect(), null);
});
