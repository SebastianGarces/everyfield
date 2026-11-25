import "../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import * as Q from "../../../../packages/contracts/src/organizations/index.ts";
import type { Level } from "../../../../packages/contracts/src/oversight/health.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { authorizeDigestMail, createDigestWorker, planDigests } from "../../../../packages/domain/src/jobs/digest.ts";
import { createMailService } from "../../../../packages/domain/src/jobs/mail.ts";
import { authorizeNoticeMail } from "../../../../packages/domain/src/jobs/notice-mail.ts";
import { createNotificationService } from "../../../../packages/domain/src/jobs/notifications.ts";
import { claimDue } from "../../../../packages/domain/src/jobs/queue.ts";
import { seatedNotificationService } from "../../../../packages/domain/src/jobs/seated-notifications.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../../packages/domain/src/launch/index.ts";
import {
	createNotificationProducer,
	previewOversightDigest,
} from "../../../../packages/domain/src/notifications/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import {
	createOrganizationAdapter,
	geographyReference,
	installGeographyRelease,
	pipelineWriter,
	readPipelineBoard,
	readPipelineExport,
	readReportingLocation,
	suggestRegions,
} from "../../../../packages/domain/src/organizations/index.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
	readIntelligence,
	readLocationHistory,
	requestIntelligenceRefresh,
} from "../../../../packages/domain/src/oversight/index.ts";
import { peopleReader, searchPeople } from "../../../../packages/domain/src/people/index.ts";
import { authorizePhaseNotices, createPhaseWriter, phaseReader } from "../../../../packages/domain/src/phases/index.ts";
import { connectionLink } from "../../../../packages/domain/src/proofs.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { launchNotices } from "../../../../apps/web/src/features/launch/notices.ts";
import { phaseNotices } from "../../../../apps/web/src/features/phases/notices.ts";
import { ok, refused, waitingOnLock, type Actor } from "../../../support/fixture.mts";
import { church, type Church } from "../../intelligence/assessment-church.mts";

type Kind = "sending_church" | "sending_network";
type Side = "church" | "organization";
const SCENARIOS: [Kind, Side][] = [
	["sending_church", "church"],
	["sending_church", "organization"],
	["sending_network", "church"],
	["sending_network", "organization"],
];
const LEVELS: Level[] = ["region", "state", "country", "portfolio"];
const ZONES = [
	"Pacific/Honolulu",
	"America/Chicago",
	"America/Sao_Paulo",
	"Europe/Athens",
	"Asia/Dhaka",
	"Asia/Tokyo",
	"Pacific/Auckland",
];
const DAY = 86_400_000;
const key = () => randomUUID();
const json = (value: unknown) => JSON.stringify(value);

let ch: Church;
let zone: string;
const proofs = new Map<string, string>();
const sent: { to: string; subject: string; text: string }[] = [];
let mail: ReturnType<typeof createMailService>;
let digests: ReturnType<typeof createDigestWorker>;
let launches: ReturnType<typeof createLaunchWriter>;
let phases: ReturnType<typeof createPhaseWriter>;
let midMove: (tx: WriteTx) => Promise<void> = async () => {};
const launchReader = createLaunchReader();
const assessments = createAssessments();
const job = createAssessmentJob();
const feedApi = createNotificationProducer({ optOutKey: randomBytes(32), now: () => new Date() });
const api = createOrganizationAdapter(
	{
		async invitation(_tx: unknown, v: { invitationId: string; proof: never }) {
			proofs.set(
				v.invitationId,
				connectionLink("https://example.test", "/connections/respond", v.invitationId, v.proof).split("#")[1]!,
			);
		},
		invalidate: () => sql`UPDATE job SET state=state WHERE false`,
	} as never,
	geographyReference,
);

before(async () => {
	ch = await church("linkend", { max: 12 });
	await ch.release("methodology-2026.11");
	await installGeographyRelease(ch.admin);
	zone = ZONES.find((z) => {
		const hour = Number(new Intl.DateTimeFormat("en", { timeZone: z, hour: "2-digit", hourCycle: "h23" }).format());
		return hour >= 9 && hour <= 16;
	})!;
	assert.ok(zone);
	const config: Omit<Parameters<typeof createMailService>[0], "authorize"> = {
		db: ch.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "links@example.test",
		unsubscribe: { origin: "https://everyfield.test", keys: { current: randomBytes(32) } },
		transport: {
			async send(payload) {
				sent.push({ to: payload.to, subject: payload.subject, text: payload.text });
				return { kind: "accepted", id: key() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	};
	mail = createMailService({
		...config,
		authorize: async (tx, list) => {
			const digest = await authorizeDigestMail(tx, list);
			return digest.size === list.length ? digest : new Set([...digest, ...(await authorizeNoticeMail(tx, list))]);
		},
	});
	const phaseMail = createMailService({ ...config, authorize: authorizePhaseNotices });
	const launchMail = createMailService({ ...config, authorize: authorizeLaunchNotices });
	digests = createDigestWorker({ mail, origin: "https://everyfield.test" });
	launches = createLaunchWriter({ notices: launchNotices(seatedNotificationService(launchMail)) });
	const notices = phaseNotices((eligible) => createNotificationService({ mail: phaseMail, eligible }));
	phases = createPhaseWriter({
		async notices(tx, advance) {
			await midMove(tx as WriteTx);
			await notices(tx, advance);
		},
	});
});
after(() => ch?.database.close());

async function authority(who: Pick<Actor, "session">) {
	const found = await RequestActor.resolve(ch.db, who.session);
	assert.ok(found instanceof RequestActor);
	return found;
}
async function call(name: keyof typeof api, who: Actor, input: unknown, during?: (tx: WriteTx) => Promise<void>) {
	return gatedTransaction(ch.db, async (tx) => {
		assert.ok(await RequestActor.claimWrite(tx, who.session, who.selected as never));
		const result: unknown = await api[name](tx, who.session, who.selected as never, input as never);
		await during?.(tx);
		return result;
	});
}
const read = (name: keyof typeof api, who: Actor, input: unknown) =>
	gatedTransaction(ch.db, async (tx): Promise<unknown> =>
		api[name](tx, who.session, who.selected as never, input as never),
	);
const command = (input: unknown, expectedRevision = "1") => ({ requestKey: key(), expectedRevision, input });
const revisionOf = async (plant: { id: string }) =>
	String((await ch.one(sql`SELECT revision::text AS r FROM plant WHERE id=${plant.id}`)).r);

type Plant = Awaited<ReturnType<Church["plant"]>>;
const ownerOf = (p: Plant): Actor => p.owner;

async function join(p: Plant, o: { id: string; organizationKind: Kind; director: Actor }) {
	const pair = {
		kind: "plant",
		subject: { kind: "plant", id: p.id },
		organization: { kind: "organization", id: o.id, organizationKind: o.organizationKind },
	};
	const i = Q.invitationResult.parse(
		await call(
			"associations.invite",
			ownerOf(p),
			command({ pair, recipientEmail: o.director.email }, await revisionOf(p)),
		),
	);
	assert.ok(i.status === "pending");
	const accepted = Q.acceptedInvitationResult.parse(
		await call(
			"associations.acceptInvitation",
			o.director,
			command({ invitationId: i.invitationId, proof: proofs.get(i.invitationId), decision: "accept" }),
		),
	);
	assert.ok(accepted.status === "accepted");
	return { id: accepted.relationship.id, revision: accepted.relationship.revision, pair };
}
async function organization(kind: Kind, name: string) {
	const org = await ch.database.organization(kind, { name, timezone: zone });
	const director = await ch.database.actor(org, "admin");
	await ch.admin
		.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES(${director.id},'oversight_digest','email',true,0)`);
	const board = ok(await readPipelineBoard(ch.db, await authority(director), {}));
	ok(
		await pipelineWriter.addPerson(ch.db, await authority(director), {
			personId: key(),
			displayName: `${name} Resident`,
			email: null,
			responsibleSeatId: null,
			stageId: board.stages[0]!.id,
		}),
	);
	return { ...org, name, director, seat: () => ch.database.actor(org, "admin") };
}
type Org = Awaited<ReturnType<typeof organization>>;

const planOf = async (p: Plant) => ok(await launchReader.readPlan(ch.db, p.actor)).plan;
const publish = async (p: Plant, body: string) => {
	const plan = await planOf(p);
	ok(
		await launches.publishDebriefSummary(ch.db, p.actor, {
			requestKey: key(),
			expectedRevision: plan.summary!.draft?.revision ?? "0",
			input: { draftId: plan.summary!.draft?.id ?? null, body },
		}),
	);
};
const move = async (p: Plant, toPhase: number) =>
	phases.transition(ch.db, p.actor, {
		requestKey: key(),
		expectedRevision: await revisionOf(p),
		input: { toPhase, reason: "The next phase began" },
	});
const AUSTIN = { city: "Austin", stateProvince: null, country: "US" };
async function locate(p: Plant, code: string) {
	const current = (await readReportingLocation(ch.db, p.actor))!;
	const region = (await suggestRegions(ch.db, p.actor, AUSTIN))!.find((c) => c.area.code === code)!;
	await call(
		"organizations.correctReportingLocation",
		ownerOf(p),
		command(
			{
				plant: { kind: "plant", id: p.id },
				locality: AUSTIN,
				referenceVersionId: current.referenceVersionId,
				regionItemId: region.regionItemId,
			},
			current.revision,
		),
	);
}
async function assess(p: Plant) {
	ok(await assessments.requestRefresh(ch.db, p.actor, { requestId: key() }));
	await runAssessmentBatch(job, ch.db, scriptedAssessmentDrafter(), 20);
	const current = ok(await assessments.readAssessment(ch.db, p.actor, {})).current!;
	ok(await assessments.markAssessmentSeen(ch.db, p.actor, { runId: current.runId }));
	return current;
}
async function plant(name: string) {
	const p = await ch.plant(name, { phase: 2 });
	const adults = [];
	for (let i = 1; i <= 3; i++) adults.push(await ch.committed(p, `${name} Adult ${i}`));
	await ch.vision(p, 6, adults.slice(0, 2));
	await ch.role(p, "worship", adults[0]!);
	await locate(p, "12420");
	const planned = ch.day(-3);
	const before = ok(await launchReader.readPlan(ch.db, p.actor)).plan;
	ok(
		await launches.schedule(ch.db, p.actor, {
			requestKey: key(),
			expectedRevision: before.revision,
			input: { date: planned, reason: null },
		}),
	);
	ok(
		await launches.recordOutcome(ch.db, p.actor, {
			requestKey: key(),
			expectedRevision: (await planOf(p)).revision,
			input: { actualDate: planned, attendance: 40, decisions: 6, note: null },
		}),
	);
	ok(
		await launches.submitDebrief(ch.db, p.actor, {
			requestKey: key(),
			expectedRevision: "0",
			input: {
				draftId: null,
				answers: {
					wentWell: null,
					toChange: null,
					operations: null,
					followUpPlan: null,
					supportNeeded: null,
					missingNames: "no",
					missingCount: null,
				},
			},
		}),
	);
	await publish(p, `${name} held its first service.`);
	await assess(p);
	return p;
}
const startDigests = async () => {
	await planDigests(ch.db, new Date().toISOString());
};
const digestAt = () => new Date(Date.now() + DAY).toISOString();

let worlds = 0;
async function world(kind: Kind) {
	const n = String(++worlds);
	const org = await organization(kind, `Ending Org ${n}`);
	const watcher = await organization("sending_network", `Watching Org ${n}`);
	const leaving = await plant(`Leaving Church ${n}`);
	const staying = await plant(`Staying Church ${n}`);
	const link = await join(leaving, org);
	await join(staying, org);
	await join(leaving, watcher);
	await startDigests();
	for (const o of [org, watcher])
		for (let i = 0; i < 2; i++)
			ok(await requestIntelligenceRefresh(ch.db, await authority(o.director), { runId: key() }));
	return { org, watcher, leaving, staying, link };
}
type World = Awaited<ReturnType<typeof world>>;

const endInput = (w: World) =>
	command({ relationshipId: w.link.id, pair: w.link.pair, confirmed: true, reason: null }, w.link.revision);
const end = (w: World, side: Side, during?: (tx: WriteTx) => Promise<void>) =>
	call("associations.end", side === "church" ? ownerOf(w.leaving) : w.org.director, endInput(w), during);

async function previewed(o: Org, viewer: Actor) {
	const value = ok(
		await previewOversightDigest(ch.db, await authority(viewer), { organizationId: o.id }, () => new Date()),
	) as { next: { items: { plant: string }[] } | null };
	return [...new Set(value.next!.items.map((l) => l.plant))];
}
async function routes(o: Org, p: Plant, runId: string | null, viewer = o.director) {
	const who = await authority(viewer);
	const levels: Record<string, unknown> = {};
	for (const level of LEVELS) levels[level] = (await readIntelligence(ch.db, who, { level, runId: null }))!.groups;
	const past = runId ? (await readIntelligence(ch.db, who, { level: "portfolio", runId }))!.groups : null;
	const digest = ok(
		await feedApi.readOversightDigest(ch.db, who, {
			organizationId: o.id,
			organizationKind: o.organizationKind,
			period: "current",
		}),
	);
	return {
		home: (await listPlants(ch.db, who))!.plants,
		page: await getPlant(ch.db, who, p.id),
		summary: await launchReader.readPublishedSummary(ch.db, who, p.id),
		...levels,
		past,
		places: await readLocationHistory(ch.db, who, p.id),
		digest: digest.plants,
		sharing: await read("privacy.getSharing", viewer, {
			plant: { kind: "plant", id: p.id },
			organization: { kind: "organization", id: o.id, organizationKind: o.organizationKind },
		}),
		audience: await feedApi.readAssociationAudience(ch.db, who, {
			organizationId: o.id,
			discoveryAccountId: p.owner.id,
		}),
		search: await gatedTransaction(ch.db, (tx) =>
			searchPeople(tx, { session: viewer.session, selected: { kind: "plant", id: p.id } } as never, "Adult"),
		),
		export: await readPipelineExport(ch.db, who),
	};
}
type Routes = Awaited<ReturnType<typeof routes>>;
const ROUTES_NAMING_THE_CHURCH = ["home", "page", "summary", ...LEVELS, "past", "places", "digest", "sharing"] as const;
const names = (value: unknown, p: Plant) => json(value).includes(p.name) || json(value).includes(p.id);
const volatile = (r: Routes) => json({ ...r, export: null, search: null });

const feed = async (who: Actor) => {
	const value = ok(await feedApi.readFeed(ch.db, await authority(who), {})) as {
		items: { category: string; title: string; body: string | null }[];
	};
	return value.items;
};
async function dispatchAll() {
	for (let claim = (await claimDue(ch.db, ["mail"]))[0]; claim; claim = (await claimDue(ch.db, ["mail"]))[0])
		await mail.dispatch(claim);
}
async function records(p: { id: string }) {
	const columns = await ch.rows<{ t: string; c: string }>(sql`SELECT c.relname AS t,
		(SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('plant_id','tenant_id') AND NOT a.attisdropped
			ORDER BY a.attname LIMIT 1) AS c
		FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY 1`);
	const kept: Record<string, Record<string, unknown>[]> = {};
	const skipped = new Set(["affiliation", "audit_event", "job", "notice", "mail"]);
	for (const { t, c } of columns)
		if (c && !skipped.has(t)) {
			const found = await ch.rows(
				sql`SELECT to_jsonb(x) AS row FROM ${sql.identifier(t)} x WHERE x.${sql.identifier(c)}=${p.id} ORDER BY to_jsonb(x)::text`,
			);
			if (found.length) kept[t] = found.map((r) => r.row as Record<string, unknown>);
		}
	kept.plant = (await ch.rows(sql`SELECT to_jsonb(x) AS row FROM plant x WHERE id=${p.id}`)).map(
		(r) => r.row as Record<string, unknown>,
	);
	return kept;
}
async function planterReads(p: Plant) {
	const ctx = p.ctx as never;
	return {
		people: ok(await gatedTransaction(ch.db, (tx) => peopleReader.listPeople(tx, ctx, {} as never))),
		search: ok(await gatedTransaction(ch.db, (tx) => searchPeople(tx, ctx, "Adult"))),
		launch: await planOf(p),
		phase: ok(await phaseReader.readHistory(ch.db, p.actor)),
		assessment: ok(await assessments.readAssessment(ch.db, p.actor, {})),
		location: await readReportingLocation(ch.db, p.actor),
	};
}
const shared = {
	people: true,
	meetings: true,
	tasks: true,
	ministry_teams: true,
	wiki: true,
	activity: true,
	shared_findings: true,
};

async function inTransit<T>(hold: (held: () => Promise<void>) => Promise<unknown>, body: () => Promise<T>) {
	let reached!: () => void;
	const atHold = new Promise<void>((resolve) => (reached = resolve));
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	const holding = hold(async () => {
		reached();
		await released;
	});
	await Promise.race([atHold, holding]);
	let result: T;
	try {
		result = await body();
	} finally {
		release();
		await holding;
	}
	return result;
}

for (const [kind, side] of SCENARIOS) {
	const label = `${kind === "sending_church" ? "sending church" : "network"} link ended by the ${side}`;
	test(`AC:AF-026 AC:ORG55-003 INV-link-end: ${label}: the director sees what came before and nothing after, by every route, while the planter keeps every record`, async () => {
		const w = await world(kind);
		const { org, watcher, leaving, staying } = w;
		const director = await authority(org.director);

		ok(await move(leaving, 3));
		await planDigests(ch.db, digestAt());
		await digests.run(ch.db, digestAt());
		const second = await org.seat();
		await startDigests();
		await planDigests(ch.db, digestAt());
		const queued = await ch.one(
			sql`SELECT count(*)::int AS n FROM job WHERE kind='digest' AND state='ready' AND subject_record_id=${second.id}`,
		);
		const third = await org.seat();
		const churchAdmin = await ch.database.actor({ kind: "plant", id: leaving.id }, "admin");
		assert.equal(queued.n, 1, "the second director's digest waits in the queue");

		const runId = (await readIntelligence(ch.db, director, { level: "portfolio", runId: null }))!.history[1]!.runId;
		const before = await routes(org, leaving, runId, third);
		for (const route of ROUTES_NAMING_THE_CHURCH)
			assert.ok(
				route === "summary"
					? json(before.summary).includes("held its first service")
					: names((before as Record<string, unknown>)[route], leaving),
				`${route} shows the linked church`,
			);
		assert.deepEqual(
			before.home.map((r) => r.name),
			[leaving.name, staying.name],
		);
		assert.ok(before.page!.sections.people.status === "shared");
		assert.equal(before.page!.sections.people.counts.total, 3);
		assert.deepEqual(before.summary && { ...before.summary, publishedAt: null }, {
			version: 1,
			body: `${leaving.name} held its first service.`,
			publishedAt: null,
		});
		assert.deepEqual([...before.digest].sort(), [leaving.id, staying.id].sort());
		assert.deepEqual(await previewed(org, third), [leaving.name, staying.name]);
		assert.equal((before.sharing as { view: string }).view, "organization");
		assert.deepEqual((before.sharing as { availability: unknown }).availability, shared);
		ok(before.audience as never);
		refused(before.search);
		const kept = { records: await records(leaving), reads: json(await planterReads(leaving)) };
		const pastFeed = json(await feed(org.director));
		const feedBefore = await feed(org.director);
		assert.deepEqual(feedBefore.map((n) => n.category).sort(), ["oversight_digest", "phase_milestone"]);
		assert.ok(feedBefore.every((n) => names(n, leaving)));
		const runBefore = json(before.past);
		const stayingRow = (r: Routes) =>
			(r.past as { rows: { name: string }[] }[])[0]!.rows.find((x) => x.name === staying.name);
		const stayingBefore = json(stayingRow(before));

		const racing = { runId: key() };
		const rivals = await inTransit(
			(held) => end(w, side, held),
			async () => {
				assert.equal(
					volatile(await routes(org, leaving, runId, third)),
					volatile(before),
					"a read before the end commits",
				);
				const digest = digests.run(ch.db, digestAt());
				await waitingOnLock(ch.db, { count: 1 });
				const preview = previewed(org, third);
				await waitingOnLock(ch.db, { count: 2 });
				const refresh = requestIntelligenceRefresh(ch.db, director, racing);
				await waitingOnLock(ch.db, { count: 3 });
				const advance = move(leaving, 4);
				await waitingOnLock(ch.db, { count: 4 });
				const share = call(
					"privacy.setSharing",
					churchAdmin,
					command(
						{
							plant: { kind: "plant", id: leaving.id },
							organization: w.link.pair.organization,
							relationshipId: w.link.id,
							category: "people",
							enabled: false,
							expectedConsentRevision: "1",
						},
						w.link.revision,
					),
				).then(
					() => "changed",
					(e: Error) => e.message,
				);
				await waitingOnLock(ch.db, { count: 5 });
				return { digest, preview, refresh, advance, share };
			},
		);
		await rivals.digest;
		assert.deepEqual(await rivals.preview, [staying.name]);
		ok(await rivals.refresh);
		ok(await rivals.advance);
		assert.match(await rivals.share, /^(unavailable|stale_revision)$/);

		const line = (p: Plant) => `${p.name}: `;
		const [delivered] = (await feed(second)).filter((n) => n.category === "oversight_digest");
		assert.ok(delivered!.body!.startsWith(line(staying)), delivered!.body!);
		assert.ok(!names(delivered, leaving), "the queued digest carries nothing of the church after the end");
		assert.deepEqual(
			(await ch.rows(sql`SELECT plant_id FROM network_intelligence_plant WHERE run_id=${racing.runId}`)).map(
				(r) => r.plant_id,
			),
			[staying.id],
		);
		assert.equal(json(await feed(org.director)), pastFeed, "the racing phase move tells the director nothing");
		const moved = (who: Actor) =>
			ch.one(sql`SELECT count(*)::int AS n FROM notice WHERE recipient_id=${who.id} AND category='phase'`);
		assert.equal((await moved(org.director)).n, 1);
		assert.equal((await moved(second)).n, 0);
		assert.equal((await moved(watcher.director)).n, 2, "the other linked organization is told of both moves");
		const stored = await ch.one(
			sql`SELECT ended_at IS NOT NULL AS ended, share_people FROM affiliation WHERE id=${w.link.id}`,
		);
		assert.deepEqual(stored, { ended: true, share_people: true });

		const afterRecords = await records(leaving);
		const unmoved = (row: Record<string, unknown>) =>
			json({ ...row, phase: null, revision: null, material_revision: null });
		for (const [table, rows] of Object.entries(kept.records)) {
			const now = new Set(afterRecords[table]!.map((r) => (table === "plant" ? unmoved(r) : json(r))));
			const lost = rows.filter((r) => !now.has(table === "plant" ? unmoved(r) : json(r)));
			assert.deepEqual(lost, [], `every ${table} row the church had is unchanged`);
		}
		assert.deepEqual(
			[kept.records.person!.length, kept.records.meeting!.length, kept.records.launch_summary!.length],
			[3, 1, 1],
		);
		assert.equal(afterRecords.phase_transition!.length, 2);
		const readsAfter = await planterReads(leaving);
		const readsBefore = JSON.parse(kept.reads);
		for (const part of ["people", "search", "launch"] as const)
			assert.equal(json(readsAfter[part]), json(readsBefore[part]), `the planter still reads ${part}`);

		await ch.committed(leaving, `${leaving.name} Newcomer`);
		await publish(leaving, `${leaving.name} corrected its summary.`);
		await locate(leaving, "12380");
		await assess(leaving);

		const later = await routes(org, leaving, runId, third);
		for (const route of ROUTES_NAMING_THE_CHURCH)
			assert.ok(!names((later as Record<string, unknown>)[route], leaving), `${route} no longer shows the church`);
		assert.deepEqual(
			later.home.map((r) => r.name),
			[staying.name],
		);
		assert.equal(later.page, null);
		assert.equal(later.summary, null);
		assert.equal(later.places, null);
		assert.deepEqual(later.digest, [staying.id]);
		assert.deepEqual(await previewed(org, third), [staying.name]);
		assert.deepEqual(later.sharing, { status: "unavailable" });
		refused(later.audience as never, "access_denied");
		refused(later.search);
		for (const level of [...LEVELS, "past"] as const)
			assert.ok(names((later as Record<string, unknown>)[level], staying), `${level} still shows the other church`);
		for (const r of [before, later]) {
			assert.ok(json(r.export).includes(`${org.name} Resident`));
			assert.ok(!names(r.export, leaving));
		}

		const seen = await routes(watcher, leaving, null);
		assert.equal(seen.summary!.body, `${leaving.name} corrected its summary.`);
		assert.equal(seen.page!.plant.phase, 4);
		assert.ok(
			seen.page!.sections.people.status === "shared" && seen.page!.sections.people.counts.total === 4,
			"the other linked organization sees the new count",
		);
		const planter = await planterReads(leaving);
		assert.ok(json(planter.people).includes(`${leaving.name} Newcomer`));
		assert.equal(planter.launch.summary!.published.length, 2);

		assert.equal(json(await feed(org.director)), pastFeed, "past digests and phase notices stay as they were");
		assert.equal(json(stayingRow(later)), stayingBefore, "the past run shows the other church as it did");
		const from = sent.length;
		await dispatchAll();
		const after = sent.slice(from);
		assert.deepEqual(
			after.filter((m) => [org.director.email, second.email].includes(m.to) && names(m, leaving)),
			[],
			"no email queued before the end is sent after it",
		);
		assert.ok(after.some((m) => m.to === watcher.director.email && names(m, leaving)));
		const day7 = new Date(Date.now() + 2 * DAY).toISOString();
		await planDigests(ch.db, day7);
		await digests.run(ch.db, day7);
		assert.equal(json(await feed(org.director)), pastFeed);

		const back = await join(leaving, org);
		assert.equal(back.id, w.link.id);
		const returned = await routes(org, leaving, runId, third);
		assert.equal(json(returned.past), runBefore, "after a new approval the past run shows what it showed at the time");
		assert.equal(returned.summary!.version, 2);
	});
}

test("INV-link-end: a phase move that committed first tells the director once, and the organization's end waits for it", async () => {
	for (const [kind] of [SCENARIOS[1]!, SCENARIOS[3]!]) {
		const w = await world(kind);
		let ending: Promise<unknown> | undefined;
		const startEnd = AsyncResource.bind(async () => {
			ending ??= end(w, "organization");
			await waitingOnLock(ch.db);
		});
		midMove = () => startEnd();
		try {
			ok(await move(w.leaving, 3));
		} finally {
			midMove = async () => {};
		}
		await ending;
		const past = json(await feed(w.org.director));
		assert.deepEqual(
			(await feed(w.org.director)).map((n) => [n.title, n.body]),
			[[`${w.leaving.name} moved to Phase 3`, `${w.leaving.name} moved from Phase 2 to Phase 3 in Everyfield.`]],
		);
		ok(await move(w.leaving, 2));
		ok(await move(w.leaving, 4));
		assert.equal(json(await feed(w.org.director)), past);
		assert.equal(
			(await feed(w.watcher.director)).filter((n) => n.category === "phase_milestone").length,
			2,
			"the other linked organization is told of both moves forward",
		);
	}
});

test("INV-link-end: a digest already being delivered keeps the end waiting, and stays as it was after the end", async () => {
	for (const [kind, side] of SCENARIOS) {
		const w = await world(kind);
		await planDigests(ch.db, digestAt());
		const kept = json(await planterReads(w.leaving));
		const keptRows = await records(w.leaving);
		const { running, ending } = await inTransit(
			(held) =>
				ch.admin.transaction(async (tx) => {
					await tx.execute(sql`SELECT FROM tenant WHERE id=${w.org.id} FOR UPDATE`);
					await held();
				}),
			async () => {
				const running = digests.run(ch.db, digestAt());
				await waitingOnLock(ch.db, { count: 1 });
				const ending = end(w, side);
				await waitingOnLock(ch.db, { count: 2 });
				return { running, ending };
			},
		);
		await running;
		await ending;
		assert.equal(json(await planterReads(w.leaving)), kept, "the end changes nothing the planter reads");
		const nowRows = await records(w.leaving);
		delete keptRows.record;
		delete nowRows.record;
		assert.ok(keptRows.person!.length === 3 && keptRows.assessment_run!.length === 1);
		assert.deepEqual(nowRows, keptRows, "nor any row the church holds");
		const items = await feed(w.org.director);
		assert.equal(items.length, 1);
		assert.ok(names(items[0], w.leaving) && names(items[0], w.staying));
		await ch.committed(w.leaving, "Person After");
		const next = new Date(Date.now() + 2 * DAY).toISOString();
		await planDigests(ch.db, next);
		await digests.run(ch.db, next);
		assert.equal(json(await feed(w.org.director)), json(items));
	}
});

test("INV-link-end: a sending church or its network ending their link takes the church off the network's roster and page at once", async () => {
	for (const side of ["church", "organization"] as const) {
		const w = await world("sending_church");
		const pair = {
			kind: "sending_church",
			subject: { kind: "organization", id: w.org.id, organizationKind: "sending_church" },
			organization: { kind: "organization", id: w.watcher.id, organizationKind: "sending_network" },
		};
		const invited = Q.invitationResult.parse(
			await call(
				"associations.invite",
				w.org.director,
				command(
					{ pair, recipientEmail: w.watcher.director.email },
					String((await ch.one(sql`SELECT revision::text AS r FROM organization WHERE id=${w.org.id}`)).r),
				),
			),
		);
		assert.ok(invited.status === "pending");
		const accepted = Q.acceptedInvitationResult.parse(
			await call(
				"associations.acceptInvitation",
				w.watcher.director,
				command({ invitationId: invited.invitationId, proof: proofs.get(invited.invitationId), decision: "accept" }),
			),
		);
		assert.ok(accepted.status === "accepted");
		const who = await authority(w.watcher.director);
		const through = async () => (await listPlants(ch.db, who))!.plants.map((p) => [p.name, p.provenance]);
		assert.deepEqual(await listSendingChurches(ch.db, who), {
			pendingInvitations: 0,
			churches: [{ organizationId: w.org.id, name: w.org.name, plants: 1 }],
		});
		assert.deepEqual(
			(await getSendingChurch(ch.db, who, w.org.id))!.plants.map((p) => p.name),
			[w.leaving.name],
		);
		assert.deepEqual(await through(), [[w.leaving.name, { kind: "through", sendingChurches: [w.org.name] }]]);
		await call(
			"associations.end",
			side === "church" ? w.org.director : w.watcher.director,
			command({ relationshipId: accepted.relationship.id, pair, confirmed: true, reason: null }),
		);
		assert.deepEqual(await listSendingChurches(ch.db, who), { pendingInvitations: 0, churches: [] });
		assert.equal(await getSendingChurch(ch.db, who, w.org.id), null);
		assert.deepEqual(await through(), [[w.leaving.name, { kind: "direct" }]]);
		assert.deepEqual(
			(await listPlants(ch.db, await authority(w.org.director)))!.plants.map((p) => p.name),
			[w.leaving.name, w.staying.name],
			"the sending church keeps its own churches",
		);
	}
});
