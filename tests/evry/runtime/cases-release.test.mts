import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runDueImports } from "../../../apps/web/src/features/people/import-export/run-imports.ts";
import { SIGNAL_KEYS } from "../../../packages/contracts/src/intelligence/signals.ts";
import { approveProposal, retryUnresolvedEffects, type MailPort } from "../../../packages/evry/src/index.ts";
import type { Actor } from "../../support/fixture.mts";
import { touched } from "../../support/recorded.mts";
import {
	caseWorld,
	proposes,
	provider,
	reads,
	refusal,
	sql,
	type CaseWorld,
	type Church,
	type Play,
} from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("caserelease");
});
after(() => w?.close());

const JOURNEYS = ["invitation", "import", "own-task", "team", "intelligence", "notification", "commitment"] as const;
type Journey = (typeof JOURNEYS)[number];
const REPETITIONS = [1, 2, 3];
const GATES = ["privacy", "authority", "approval", "effect", "replay", "delivery"] as const;
type Gate = (typeof GATES)[number];
type Result = {
	journey: Journey;
	n: number;
	failed: Gate[];
	unauthorizedEffects: number;
	unauthorizedBody: string | null;
	replayEffects: number;
};
type Options = NonNullable<Parameters<CaseWorld["ask"]>[3]>;
type Scene = {
	as: Actor;
	said: string;
	play: Play;
	on?: Options;
	mail?: MailPort;
	after?: () => Promise<unknown>;
	effects: () => Promise<unknown>;
	before: unknown;
	done: unknown;
};

const read = async (q: ReturnType<typeof sql>) => (await w.rows(q)).map((r) => Object.values(r));

const SCENES: Record<Journey, (c: Church) => Promise<Scene>> = {
	async invitation(c) {
		const email = provider("ids");
		const venue = randomUUID();
		await w.admin.execute(
			sql`UPDATE plant SET street='12 Mill Road',city='Austin',country='United States' WHERE id=${c.P.id}`,
		);
		await w.admin.execute(sql`UPDATE person SET email=id||'@example.test' WHERE id IN(${c.rivera},${c.casey})`);
		await w.admin.execute(
			sql`INSERT INTO venue(id,plant_id,name,address) VALUES(${venue},${c.P.id},'Hall','1 Main St')`,
		);
		return {
			as: c.A,
			said: "Invite Alex Rivera and Casey to a vision night on October 27 at 7pm",
			play: [
				proposes("evry.prepareMeetingInvitation", {
					meeting: { type: "vision_meeting", date: "2026-10-27", time: "19:00", venueId: venue },
					audience: { personIds: [c.rivera, c.casey] },
				}),
			],
			mail: email.port,
			effects: async () => [
				...(await read(
					sql`SELECT (SELECT count(*)::int FROM meeting WHERE plant_id=${c.P.id}),(SELECT count(*)::int FROM participation WHERE plant_id=${c.P.id}) AS g`,
				)),
				email.sent.flat().sort(),
			],
			before: [[0, 0], []],
			done: [[1, 2], [c.rivera, c.casey].map((p) => `${p}@example.test`).sort()],
		};
	},
	async import(c) {
		const conversation = await w.converse(c.Aa);
		const file = await c.attach(
			c.A,
			conversation,
			"people.csv",
			"first_name,last_name,email\nJamie,Lane,jamie@example.test\nPat,Bad,bad-email\n",
		);
		const on = { conversation, storage: w.files.storage, attachments: [{ id: file.id, name: file.name }] };
		await w.ask(c.A, "Check this file", [reads("people.previewImport", { attachmentId: file.id })], on);
		const { digest } = await w.one<{ digest: string }>(
			sql`SELECT body->'result'->'rows'->0->'fields'->>'fileDigest' AS digest FROM conversation_event WHERE conversation_id=${conversation} AND body->>'operation'='people.previewImport'`,
		);
		return {
			as: c.A,
			said: "import it",
			play: [proposes("people.executeBulkImport", { attachmentId: file.id, fileDigest: digest })],
			on: { conversation, storage: w.files.storage },
			after: () => runDueImports(w.db),
			effects: () =>
				read(sql`SELECT display_name FROM person WHERE plant_id=${c.P.id} AND display_name IN('Jamie Lane','Pat Bad')`),
			before: [],
			done: [["Jamie Lane"]],
		};
	},
	async "own-task"(c) {
		const M = await w.seated(c.P, "member");
		const [own, other] = [randomUUID(), randomUUID()];
		for (const [id, title, owner] of [
			[own, "Own task", M.id],
			[other, "Own task", c.A.id],
		]) {
			await w.admin
				.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
				VALUES(${id},${c.P.id},${title},'general','medium','not_started',clock_timestamp(),'date_only','2026-10-13')`);
			await w.admin.execute(
				sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${c.P.id},${id},${owner})`,
			);
		}
		return {
			as: M,
			said: "Finish my task due today",
			play: [proposes("tasks.complete", { taskId: own })],
			effects: () => read(sql`SELECT id,status FROM task WHERE plant_id=${c.P.id} AND status='complete'`),
			before: [],
			done: [[own, "complete"]],
		};
	},
	async team(c) {
		const [team, role] = [randomUUID(), randomUUID()];
		await w.admin.execute(
			sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${c.P.id},'Hospitality','active',1)`,
		);
		await w.admin.execute(
			sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order) VALUES(${role},${c.P.id},${team},'Greeter',false,1)`,
		);
		return {
			as: c.A,
			said: "Put Casey in the greeter role",
			play: [proposes("teams.assignRole", { roleId: role, personId: c.casey })],
			effects: () => read(sql`SELECT role_id,person_id FROM team_tenure WHERE plant_id=${c.P.id}`),
			before: [],
			done: [[role, c.casey]],
		};
	},
	async intelligence(c) {
		return {
			as: c.A,
			said: "Record our weekly rhythm signal as in place",
			play: [
				reads("signals.listDefinitions", {}),
				proposes("signals.attest", {
					key: SIGNAL_KEYS[0],
					value: "yes",
					asOf: "2026-10-12",
					detail: "Every Tuesday",
				}),
			],
			effects: () => read(sql`SELECT count(*)::int FROM attestation_revision WHERE plant_id=${c.P.id}`),
			before: [[0]],
			done: [[1]],
		};
	},
	async notification(c) {
		const ids: string[] = [];
		for (let n = 1; n <= 4; n++) {
			const [id, source] = [randomUUID(), randomUUID()];
			await w.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind)
				VALUES(${source},${c.P.id},${`Notice ${n}`},'general','medium','not_started',clock_timestamp(),'undated')`);
			await w.admin
				.execute(sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,eligible_at,created_at,timezone)
				VALUES(${id},${c.P.id},${c.A.id},'task','task_due',${`${c.P.id}/task_due/${id}`},${source},1,${`Notice ${n}`},${`2026-10-13T15:0${n}:00Z`},clock_timestamp(),'America/Chicago')`);
			ids.push(id);
		}
		return {
			as: c.A,
			said: "Mark the first three read",
			play: [
				reads("notifications.feed", { unread: true }),
				proposes("notifications.markSelectedRead", { noticeIds: ids.slice(0, 3) }),
			],
			effects: () =>
				read(sql`SELECT id FROM notice WHERE recipient_id=${c.A.id} AND read_at IS NULL ORDER BY eligible_at`),
			before: ids.map((id) => [id]),
			done: [[ids[3]]],
		};
	},
	async commitment(c) {
		return {
			as: c.A,
			said: "Casey signed the core group commitment on October 8",
			play: [proposes("people.createCommitment", { personId: c.casey, kind: "core_group", occurredOn: "2026-10-08" })],
			effects: () => read(sql`SELECT person_id,kind,signed_on::text FROM commitment WHERE plant_id=${c.P.id}`),
			before: [],
			done: [[c.casey, "core_group", "2026-10-08"]],
		};
	},
};

async function repetition(journey: Journey, n: number, broken?: (c: Church) => Promise<unknown>): Promise<Result> {
	const c = await w.church();
	await w.care(c.A);
	const scene = await SCENES[journey](c);
	const failed = new Set<Gate>();
	const gate = (name: Gate, held: boolean) => held || failed.add(name);
	const same = async (expected: unknown) => JSON.stringify(await scene.effects()) === JSON.stringify(expected);
	const mails = async () => JSON.stringify(await read(sql`SELECT id,state FROM mail ORDER BY id`));
	const noMail = await mails();

	const asked = await w.ask(scene.as, scene.said, scene.play, scene.on);
	const [card] = asked.proposals;
	assert.ok(card, `${journey} ${JSON.stringify(asked.replies)}`);
	const told = JSON.stringify([asked.prompts, asked.saved, card]);
	gate("privacy", !/CARE-CANARY|Foreign Member/.test(told));
	gate("approval", (await same(scene.before)) && (await w.effect(scene.mail ?? null)) === null);
	let unauthorizedEffects = 0;
	let unauthorizedBody: string | null = null;
	for (const other of [c.F, await w.seated(c.P, "member")]) {
		const who = await w.actorOf(other);
		const answer = await approveProposal(w.db, who, card.id, w.witness(card), null).catch((e: { code?: string }) => e);
		if (!("code" in answer)) unauthorizedBody = JSON.stringify(answer);
		else gate("authority", answer.code === "not_found");
		if ((await w.effect(scene.mail ?? null)) !== null || !(await same(scene.before))) unauthorizedEffects++;
	}
	gate("authority", unauthorizedEffects === 0 && unauthorizedBody === null);
	const wrong = { ...w.witness(card), digest: "0".repeat(64) };
	gate(
		"approval",
		(await refusal(approveProposal(w.db, await w.actorOf(scene.as), card.id, wrong, null))) === "review_changed",
	);

	const { outcome, review } = await w.approve(scene.as, card, scene.mail ?? null);
	await scene.after?.();
	gate("effect", outcome === "completed" && review.outcome === "completed" && (await same(scene.done)));
	gate("delivery", scene.mail ? review.receipt?.report?.confirmation === "confirmed" : (await mails()) === noMail);
	const replay = await touched(w.admin, async () => {
		const again = await approveProposal(w.db, await w.actorOf(scene.as), card.id, w.witness(card), null);
		gate("replay", again.replayed && again.proposal.outcome === "completed");
		const retried = await retryUnresolvedEffects(w.db, await w.actorOf(scene.as), card.id);
		gate("replay", !retried.retried);
		gate("replay", (await w.effect(scene.mail ?? null)) === null);
		await broken?.(c);
	});
	const replayEffects = replay.tables.length;
	gate("replay", replayEffects === 0 && (await same(scene.done)));
	return { journey, n, failed: [...failed], unauthorizedEffects, unauthorizedBody, replayEffects };
}

function released(results: Result[]) {
	const missing = JOURNEYS.flatMap((journey) =>
		REPETITIONS.filter((n) => results.filter((r) => r.journey === journey && r.n === n).length !== 1).map(
			(n) => `${journey} repetition ${n} not run`,
		),
	);
	const failures = results.flatMap((r) => r.failed.map((g) => `${r.journey} repetition ${r.n} ${g}`));
	const wanted = JOURNEYS.length * REPETITIONS.length;
	return {
		rate: (100 * results.filter((r) => !r.failed.length).length) / wanted,
		unauthorized_effects: results.reduce((n, r) => n + r.unauthorizedEffects, 0),
		unauthorized_body: results.find((r) => r.unauthorizedBody !== null)?.unauthorizedBody ?? null,
		replay_additional_effects: results.reduce((n, r) => n + r.replayEffects, 0),
		blockers: [...missing, ...failures],
	};
}

const SAID = "Run future independent evaluation three repetitions per critical flow";
test("AC:EVRY-EVALUATION-RELEASE three repetitions of each critical journey pass every hard gate through the real effects, and one broken or missing repetition blocks release", async () => {
	const results: Result[] = [];
	for (const journey of JOURNEYS) for (const n of REPETITIONS) results.push(await repetition(journey, n));
	assert.equal(results.length, 21);
	assert.deepEqual(released(results), {
		rate: 100,
		unauthorized_effects: 0,
		unauthorized_body: null,
		replay_additional_effects: 0,
		blockers: [],
	});

	const broken = await repetition("commitment", 3, (c) =>
		w.admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at)
			VALUES(${randomUUID()},${c.P.id},${c.chen},'core_group','2026-10-09',clock_timestamp())`),
	);
	const withBroken = released([...results.slice(0, -1), broken]);
	assert.ok(withBroken.rate < 100 && withBroken.replay_additional_effects > 0);
	assert.deepEqual(withBroken.blockers, ["commitment repetition 3 replay"]);
	const missing = released(results.slice(0, -1));
	assert.deepEqual([missing.rate < 100, missing.blockers], [true, ["commitment repetition 3 not run"]]);

	const c = await w.church();
	const scenes = await SCENES.team(c);
	const prepared = await w.ask(scenes.as, scenes.said, scenes.play);
	await c.foreignReview(prepared.proposals[0]!);
	const look: Play = [
		reads("people.getPerson", { personId: c.casey }),
		reads("teams.list", {}),
		reads("notifications.feed", {}),
		reads("tasks.list", {}),
	];
	await c.foreign(SAID, look, { secrets: ["Hospitality", "Greeter"], on: { onError: "go_on" } });
	await c.foreign(scenes.said, scenes.play, { secrets: ["Hospitality", "Greeter"] });
	for (const [play, table] of [
		[[reads("people.listPeople", {})], "person"],
		[[reads("tasks.list", {})], "task"],
		[[reads("teams.list", {})], "team"],
		[[reads("notifications.feed", {})], "notice"],
	] as [Play, string][])
		await c.outage(SAID, play, table);
});
