import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
	CANDIDATE_EMAIL,
	CARE_NOTE,
	CONTACT,
	KINDS,
	world,
	type Kind,
	type Viewer,
	type World,
} from "./private-support.mts";

type Surface = Record<string, unknown>;
let w: World;
before(async () => {
	w = await world("private_counts");
});
after(() => w?.close());

const READS: Record<Viewer, number> = {
	author: 100,
	admin: 100,
	member: 100,
	lead: 100,
	director: 60,
	staff: 60,
	foreign: 100,
};
async function everything(viewers: readonly Viewer[], kinds: readonly Kind[] = KINDS) {
	const out = new Map<Viewer, Surface>();
	for (const v of viewers) {
		const seen = await w.surface(v, kinds);
		if (kinds === KINDS) assert.ok(Object.keys(seen).length >= READS[v], `${v} reads ${Object.keys(seen).length}`);
		out.set(v, seen);
	}
	return out;
}
const changed = (a: Surface, b: Surface) =>
	[...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

async function unmoved(
	viewers: readonly Viewer[],
	allowed: Viewer,
	add: () => Promise<unknown>,
	remove: () => Promise<unknown>,
	control: readonly string[],
) {
	const start = await everything(viewers);
	const mine = await w.surface(allowed, KINDS);
	await add();
	const during = await w.surface(allowed, KINDS);
	for (const v of viewers)
		assert.deepEqual(changed(start.get(v)!, await w.surface(v, KINDS)), [], `${v} while it exists`);
	const moved = changed(mine, during);
	for (const route of control) assert.ok(moved.includes(route), `${allowed} ${route} in ${moved.join(", ")}`);
	await remove();
	for (const v of viewers)
		assert.deepEqual(changed(start.get(v)!, await w.surface(v, KINDS)), [], `${v} after it is gone`);
	assert.ok(changed(during, await w.surface(allowed, KINDS)).length > 0, `${allowed} sees it go`);
}

test("INV-privacy: two readings of every count and summary with nothing between them are the same", async () => {
	const viewers = ["member", "director", "foreign"] as const;
	const start = await everything(viewers);
	assert.deepEqual(await everything(viewers), start);
});

test("INV-privacy: a care note, its correction and its removal move no count, summary, trend, assessment or digest that anyone but its author can read", async () => {
	const others = ["admin", "member", "lead", "director", "staff", "foreign"] as const;
	const trend = ["direct: care.readCurrent", "direct: care.readHistory", "summary: care.trends"];
	await unmoved(others, "author", () => w.actions.writeCare("author", CARE_NOTE), w.actions.clearCare, trend);
	const start = await everything(others);
	await w.actions.purgeCare();
	assert.deepEqual(await everything(others), start);
});

test("INV-privacy: an assessment the planter has not opened moves no count, summary, trend or digest that a Member, a team lead, the sending church or another church can read", async () => {
	await unmoved(
		["member", "lead", "director", "staff", "foreign"],
		"admin",
		w.actions.assess,
		w.actions.dropAssessment,
		["direct: intelligence.readAssessment", "evry: intelligence.readAssessment all", "summary: intelligence.trends"],
	);
});

test("INV-privacy: a draft message moves no count or summary that the sending church or another church can read", async () => {
	let revision = "";
	await unmoved(
		["director", "staff", "foreign"],
		"member",
		async () => {
			revision = (await w.actions.draft()).revision;
		},
		() => w.actions.removeDraft(revision),
		[
			"direct: communication.forPerson",
			"evry: communication.list all",
			"summary: communication.listDrafts",
			"summary: communication.listHistory",
		],
	);
});

test("INV-privacy: a person's contact details move no count or summary that the sending church or another church can read", async () => {
	await w.actions.shareActivity(false);
	await unmoved(
		["director", "staff", "foreign"],
		"member",
		() => w.actions.contact(CONTACT),
		() => w.actions.contact({ email: null, phone: null, street: null }),
		["direct: people.getPerson", "search: people.search email", "export: people.export", "summary: people.listPeople"],
	);
	await w.actions.shareActivity(true);
});

test("INV-privacy: with activity shared, the sending church's digest counts adding and removing contact details exactly as it counts a changed name", async () => {
	const total = async () => {
		const digest = (await w.read("director", "digest"))["digest.oversight mail"] as { title: string; lines: string[] };
		const [, n] = /^Oversight digest: (\d+) activities, /.exec(digest.title)!;
		assert.equal(digest.lines.length, 1);
		assert.ok(digest.lines[0]!.startsWith(`Harbor Plant: ${n} activities on `), digest.lines[0]);
		return Number(n);
	};
	const start = await total();
	const added = async (change: () => Promise<unknown>) => {
		const before = await total();
		await change();
		return (await total()) - before;
	};
	assert.deepEqual(
		[
			await added(() => w.actions.rename("Dana Quieter")),
			await added(() => w.actions.contact(CONTACT)),
			await added(() => w.actions.contact({ email: null, phone: null, street: null })),
			await added(() => w.actions.rename("Dana Quiet")),
		],
		[1, 1, 1, 1],
	);
	assert.equal(await total(), start + 4);
	const others = await everything(["staff", "foreign"], ["digest", "notification"]);
	await w.actions.contact(CONTACT);
	assert.deepEqual(await everything(["staff", "foreign"], ["digest", "notification"]), others);
});

test("INV-privacy: a candidate's contact details move no count or summary that the church, another church or staff without the duty can read", async () => {
	await unmoved(
		["author", "admin", "member", "lead", "staff", "foreign"],
		"director",
		() => w.actions.candidateEmail(CANDIDATE_EMAIL),
		() => w.actions.candidateEmail(null),
		[
			"direct: pipeline.personRecord",
			"search: pipeline.board email",
			"export: pipeline.export",
			"summary: pipeline.board",
		],
	);
});

test("INV-privacy: a Network Intelligence snapshot taken while an assessment is unopened reads the same as before it, and the opened one is then carried", async () => {
	const groups = async () => {
		const run = await w.refreshNetwork();
		assert.equal(run.status, "ok", JSON.stringify(run));
		return w.networkGroups();
	};
	const start = await groups();
	assert.ok(start.length > 0);
	await w.actions.assess();
	assert.deepEqual(await groups(), start);
	const listed = await w.directoryHealth();
	assert.equal(listed, "not_assessed");
	await w.actions.release();
	assert.equal(await w.directoryHealth(), "watch");
});
