import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../../packages/db/src/query.ts";
import { owner as ownerValue, personId } from "../../../../packages/contracts/src/common/index.ts";
import {
	liveAccess,
	liveRead,
	liveRows,
	readViewer,
	RequestActor,
} from "../../../../packages/domain/src/access/session.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import {
	assessments,
	getCommitmentDownload,
	peopleCsv,
	peopleReader,
	searchPeople,
} from "../../../../packages/domain/src/people/index.ts";
import { taskReader } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsReader } from "../../../../packages/domain/src/teams/index.ts";
import { meetingsReader } from "../../../../packages/domain/src/meetings/index.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import {
	createConversation,
	evryActor,
	observeConversation,
	readConversation,
	submitTurn,
} from "../../../../packages/evry/src/index.ts";
import { readPersonPage } from "../../../../apps/web/src/features/people/page-data.ts";
import { seeds, type Actor } from "../../../support/fixture.mts";
import { key, rolesWorld, type RolesWorld } from "./roles-world.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	expected: {
		result: { canary_bodies: string[]; existence_disclosed: boolean; actor_selected_trusted_scope: boolean };
	};
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "TEN-002") ?? assert.fail("no case TEN-002");

let w: RolesWorld;
let foreign: Actor, seatless: Actor;
let conversation: string;
const STREAM_CANARY = "CANARY-OWNER-STREAM";
before(async () => {
	w = await rolesWorld("tenancy_reads");
	const seed = seeds(w.admin);
	foreign = await seed.actor(w.hidden, "admin", { email: "casey@example.test" });
	seatless = await seed.actor(null);
	const object = key();
	await w.admin
		.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation)
		VALUES(${object},${w.plant.id},'commitment',${`private/${w.plant.id}/${object}`},'image/png',100,10,${"a".repeat(64)},'ready',${object},0)`);
	await w.admin.execute(sql`UPDATE commitment SET object_id=${object} WHERE id=${w.ids.commitment}`);
	await w.admin.execute(sql`UPDATE task SET team_id=${w.ids.welcome} WHERE id=${w.ids.tasks.lead}`);
	const owner = evryActor(await w.actor("owner"));
	conversation = (await createConversation(w.db, owner, { requestKey: key() })).id;
	await submitTurn(w.db, owner, conversation, { requestKey: key(), text: `${STREAM_CANARY} about Alma Reyes` });
});
after(() => w?.close());

const locked = <V,>(body: Parameters<typeof gatedTransaction<V>>[1]) => gatedTransaction(w.db, body);
const people = (a: RequestActor) => new PeopleReadContext(a);
const UNIQUE = /"(correlationId|requestId|asOf)":"[^"]*"/g;
async function settled(read: () => Promise<unknown>) {
	try {
		return JSON.stringify((await read()) ?? null).replace(UNIQUE, '"$1":"<unique>"');
	} catch (error) {
		const e = error as { code?: string; name?: string; message?: string };
		return JSON.stringify({ thrown: e.code ?? e.name, message: e.message });
	}
}
async function streamed(a: RequestActor, id: string) {
	const stop = new AbortController();
	const events: unknown[] = [];
	for await (const event of observeConversation(w.db, evryActor(a), id, 0, stop.signal)) {
		events.push(event);
		stop.abort();
	}
	return events;
}

type Who = "foreign" | "seatless" | "member" | "title-only";
const OUTSIDE: Who[] = ["foreign", "seatless"];
const EVERY: Who[] = ["foreign", "seatless", "member", "title-only"];
type Surface = {
	surface: (typeof SURFACES)[number];
	name: string;
	id: () => string;
	read: (a: RequestActor, id: string) => Promise<unknown>;
	canaries: string[];
	actors: Who[];
};
const SURFACES = ["get", "list", "count", "search", "export", "history", "RSC", "stream", "file"] as const;
const READS: Surface[] = [
	{
		surface: "get",
		name: "a person",
		id: () => w.ids.alma,
		read: (a, id) => locked((tx) => peopleReader.getPerson(tx, people(a), { personId: personId.parse(id) })),
		canaries: ["Alma Reyes", "alma@example.test", "555 0101"],
		actors: OUTSIDE,
	},
	{
		surface: "get",
		name: "a person's assessment",
		id: () => w.ids.ben,
		read: (a, id) => locked((tx) => assessments.getAssessments(tx, people(a), { personId: id })),
		canaries: ["Private assessment words", "Ben Cole"],
		actors: EVERY,
	},
	{
		surface: "get",
		name: "a church document",
		id: () => w.ids.policy,
		read: (a, id) => documentsWriter.readChurch(w.db, a, { documentId: id }),
		canaries: ["conflict", "Conflict"],
		actors: OUTSIDE,
	},
	{
		surface: "list",
		name: "a team's members",
		id: () => w.ids.welcome,
		read: (a, id) => teamsReader.listMembers(w.db, a, { teamId: id }),
		canaries: ["Max Member", "Welcome Team"],
		actors: OUTSIDE,
	},
	{
		surface: "list",
		name: "a meeting's guests",
		id: () => w.ids.planning,
		read: (a, id) => meetingsReader.listGuests(w.db, a, { meetingId: id }),
		canaries: ["Lena Lead", "Max Member", "Welcome planning"],
		actors: OUTSIDE,
	},
	{
		surface: "list",
		name: "a meeting's message context",
		id: () => w.ids.planning,
		read: (a, id) => meetingsReader.communicationContext(w.db, a, { meetingId: id }),
		canaries: ["Lena Lead", "Max Member", "lead@example.test", "member@example.test"],
		actors: EVERY,
	},
	{
		surface: "count",
		name: "a team's tasks",
		id: () => w.ids.welcome,
		read: (a, id) => locked((tx) => taskReader.count(tx, a, { teamId: id })),
		canaries: [],
		actors: OUTSIDE,
	},
	{
		surface: "count",
		name: "a filtered people export",
		id: () => "alma@example.test",
		read: (a, search) => locked((tx) => peopleCsv.countExport(tx, people(a), { search })),
		canaries: [],
		actors: OUTSIDE,
	},
	{
		surface: "search",
		name: "the people picker",
		id: () => "Alma Reyes",
		read: (a, term) => locked((tx) => searchPeople(tx, people(a), term, 8)),
		canaries: ["Alma Reyes", "alma@example.test"],
		actors: OUTSIDE,
	},
	{
		surface: "search",
		name: "message history",
		id: () => "Welcome letter",
		read: (a, query) => locked((tx) => communicationWriter.listHistory(tx, a, { query, limit: 10 })),
		canaries: ["Welcome letter", "Glad you came"],
		actors: OUTSIDE,
	},
	{
		surface: "export",
		name: "a saved document export",
		id: () => w.ids.exported,
		read: (a, id) => documentsWriter.readExportFile(w.db, a, { documentId: w.ids.policy, exportId: id }, w.storage),
		canaries: ["JVBER"],
		actors: OUTSIDE,
	},
	{
		surface: "export",
		name: "a church document file",
		id: () => w.ids.policy,
		read: (a, id) => documentsWriter.readChurchFile(w.db, a, { documentId: id, format: "pdf" }, w.storage),
		canaries: ["JVBER", "conflict"],
		actors: OUTSIDE,
	},
	{
		surface: "history",
		name: "a person's activity",
		id: () => w.ids.alma,
		read: (a, id) =>
			locked((tx) => peopleReader.getActivities(tx, people(a), { personId: personId.parse(id), limit: 20, page: 1 })),
		canaries: ["occurredAt", "Olivia Owner"],
		actors: OUTSIDE,
	},
	{
		surface: "history",
		name: "a task's status history",
		id: () => w.ids.tasks.lead,
		read: (a, id) => locked((tx) => taskReader.statusHistory(tx, a, { taskId: id })),
		canaries: ["not_started", "Olivia Owner"],
		actors: OUTSIDE,
	},
	{
		surface: "history",
		name: "another account's Evry conversation",
		id: () => conversation,
		read: (a, id) => readConversation(w.db, evryActor(a), id),
		canaries: [STREAM_CANARY, "Alma Reyes"],
		actors: EVERY,
	},
	{
		surface: "RSC",
		name: "the person page",
		id: () => w.ids.alma,
		read: (a, id) => readPersonPage(w.db, people(a), personId.parse(id)),
		canaries: ["Alma Reyes", "alma@example.test", "555 0101"],
		actors: OUTSIDE,
	},
	{
		surface: "stream",
		name: "another account's Evry stream",
		id: () => conversation,
		read: streamed,
		canaries: [STREAM_CANARY, "Alma Reyes"],
		actors: EVERY,
	},
	{
		surface: "file",
		name: "a signed commitment document",
		id: () => w.ids.commitment,
		read: (a, id) => getCommitmentDownload(w.db, w.storage, people(a), { commitmentId: id }),
		canaries: ["private/", "expiresInSeconds", "url"],
		actors: EVERY,
	},
];

test("AC:TEN-002 a foreign, seatless, Member or title-only actor that substitutes the church's ids on every read surface gets what a made-up id gets, with no body, and cannot choose a trusted scope", async () => {
	const execution = c.given.execution!;
	assert.deepEqual(execution.surfaces, [...SURFACES]);
	assert.deepEqual([execution.actor_tenant, execution.requested_tenant], ["P", "Q"]);
	assert.deepEqual(new Set(READS.map((r) => r.surface)), new Set(SURFACES), "every listed surface is tried");
	const actors: Record<Who, RequestActor> = {
		foreign: await w.as(foreign),
		seatless: await w.as(seatless),
		member: await w.actor("member"),
		"title-only": await w.actor("lead"),
	};
	const owner = await w.actor("owner");
	assert.deepEqual(
		(await teamsReader.listMembers(w.db, actors["title-only"], { teamId: w.ids.welcome })).status === "ok",
		true,
		"the title-only actor leads a team in the church but holds a Member seat",
	);
	const leaked: string[] = [];
	const disclosed: string[] = [];
	for (const r of READS) {
		const real = r.id();
		const made = () => (/^[0-9a-f-]{36}$/.test(real) ? randomUUID() : `zz${randomUUID()}`);
		const control = await settled(() => r.read(owner, real));
		assert.notEqual(control, await settled(() => r.read(owner, made())), `${r.surface} ${r.name}: the Owner finds it`);
		for (const canary of r.canaries.slice(0, 1))
			assert.ok(
				control.includes(canary),
				`${r.surface} ${r.name}: the church's Owner sees ${canary} in ${control.slice(0, 300)}`,
			);
		for (const who of r.actors) {
			const guess = made();
			const answer = (await settled(() => r.read(actors[who], real))).replaceAll(real, "<id>");
			const guessed = (await settled(() => r.read(actors[who], guess))).replaceAll(guess, "<id>");
			if (answer !== guessed) disclosed.push(`${r.surface} ${r.name} ${who}: ${answer} but ${guessed}`);
			for (const canary of r.canaries)
				if (answer.includes(canary)) leaked.push(`${r.surface} ${r.name} ${who}: ${canary}`);
		}
	}

	const plant = ownerValue.parse(w.plant);
	const trusted = async (session: string, selected: typeof plant) =>
		liveRows(
			w.db,
			liveRead({ session, owner: selected }),
			sql`SELECT display_name FROM person WHERE plant_id=${plant.id}`,
		);
	const subject = await w.actor("admin");
	assert.ok(((await trusted(subject.session, plant)) ?? []).length > 0, "the verified caller's subject actor reads P");
	const chosen = [] as boolean[];
	for (const who of EVERY.slice(0, 2)) {
		const a = actors[who];
		chosen.push((await trusted(a.session, plant)) !== null);
		chosen.push((await gatedTransaction(w.db, async (tx) => RequestActor.claimWrite(tx, a.session, plant))) !== null);
		const viewer = await readViewer(w.db, a.session);
		chosen.push(JSON.stringify(viewer?.authority?.actor.context.owner ?? null) === JSON.stringify(plant));
		chosen.push(JSON.stringify(liveAccess(a).owner) === JSON.stringify(plant));
	}
	assert.equal(actors.foreign.actor.context.owner.id, w.hidden.id, "B's scope is B's own seat");

	assert.deepEqual(disclosed, [], "a real id answers as a made-up one");
	assert.deepEqual(
		{
			canary_bodies: leaked,
			existence_disclosed: disclosed.length > 0,
			actor_selected_trusted_scope: chosen.some(Boolean),
		},
		c.expected.result,
	);
	assert.equal(c.given["caller-capability"]!.authority, "trusted_internal_application_caller");
});
