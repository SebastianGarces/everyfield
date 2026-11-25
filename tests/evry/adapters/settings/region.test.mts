import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../packages/db/src/query.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/index.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	installGeographyRelease,
	readReportingLocation,
	suggestRegions,
} from "../../../../packages/domain/src/organizations/index.ts";
import { regionLabel } from "../../../../packages/contracts/src/oversight/index.ts";
import { invokeRead, readCatalog, type EvryActor } from "../../../../packages/evry/src/index.ts";
import { listReportingRegionCandidates } from "../../../../packages/evry/src/adapters/settings/reads/index.ts";
import { goldenChurch, PLANT, type GoldenChurch } from "../../evals/golden-church.mts";
import { nativePorts } from "../../evals/settings-ports.mts";
import { completed, refusedAs, reviews } from "../review-support.mts";

const OPERATION = "organizations.correctReportingLocation";
const native = nativePorts();
let church: GoldenChurch;
let r: ReturnType<typeof reviews>;
let owner: EvryActor;
before(async () => {
	church = await goldenChurch({ seatNames: true });
	r = reviews(church.db, native);
	owner = church.actors.owner;
	await installGeographyRelease(church.admin);
});
after(() => church?.close());

const location = async () => (await readReportingLocation(church.db, owner.authority))!;
const rows = async () =>
	(
		await church.admin.execute(
			sql`SELECT g.id,g.city,g.state_province,g.country,i.canonical_key AS region,g.supersedes_id,g.effective_at
				FROM plant_geography g LEFT JOIN reference_item i ON i.id=g.region_item_id WHERE g.plant_id=${PLANT} ORDER BY g.effective_at`,
		)
	).rows;
const list = (input: object = {}) => invokeRead(church.db, owner, listReportingRegionCandidates as never, input);
const FORT_WORTH = { city: "Fort Worth", stateProvince: "TX", country: "US" };
const ROUND_ROCK = { city: "Round Rock", stateProvince: "TX", country: "US" };
const audits = async () =>
	(
		await church.admin.execute(
			sql`SELECT action,kind,before_revision::int AS before,after_revision::int AS after FROM audit_event
				WHERE tenant_id=${PLANT} AND action='plant.profile_changed' ORDER BY occurred_at`,
		)
	).rows;

test("AC:LI-001 the Region candidates are the ones Settings suggests for the saved or stated place", async () => {
	for (const place of [FORT_WORTH, ROUND_ROCK, { city: "Springfield", stateProvince: null, country: "US" }]) {
		const settings = (await suggestRegions(church.db, owner.authority, place))!;
		const got = await list(place.stateProvince ? place : { city: place.city, country: "US" });
		assert.deepEqual(
			got.rows.map((x) => [x.id, x.label]),
			settings.map((s) => [s.regionItemId, regionLabel(s.area)]),
			place.city,
		);
	}
	const saved = (await location()).locality;
	const settings = (await suggestRegions(church.db, owner.authority, saved))!;
	assert.deepEqual(
		(await list()).rows.map((x) => x.id),
		settings.map((s) => s.regionItemId),
	);
	assert.ok((await list({ city: "Springfield", country: "US" })).rows.length > 1, "more than one match");
	const none = await list({ city: "Nowhereville", stateProvince: "TX", country: "US" });
	assert.deepEqual([none.rows, none.facts?.place], [[], "Nowhereville, TX, US"]);
});

test("AC:LI-007 an approved correction saves the place and Region as Settings does, keeps the history and refuses a stale card or a Region outside the candidates", async () => {
	const [candidate] = (await list(FORT_WORTH)).rows;
	const input = { ...FORT_WORTH, regionItemId: candidate!.id };
	const before = await location();
	const card = await r.prepare(owner, OPERATION, input);
	assert.deepEqual(card.review.changes, [
		{
			field: "reportingPlace",
			before:
				[before.locality.city, before.locality.stateProvince, before.locality.country].filter(Boolean).join(", ") ||
				"No location",
			after: "Fort Worth, TX, US",
		},
		{ field: "reportingRegion", before: null, after: candidate!.label },
	]);
	const stale = await r.prepare(owner, OPERATION, input);
	assert.deepEqual(await rows(), [], "nothing is saved before approval");
	const audited = (await audits()).length;
	completed(await r.approve(owner, card));
	assert.equal(await r.replayed(owner, card), true);
	const saved = await location();
	assert.deepEqual(
		[saved.locality, saved.region && regionLabel(saved.region), saved.revision],
		[FORT_WORTH, candidate!.label, String(Number(before.revision) + 1)],
	);
	refusedAs(await r.approve(owner, stale), "stale_revision");

	const [next] = (await list(ROUND_ROCK)).rows;
	const plant = { kind: "plant" as const, id: PLANT };
	await gatedTransaction(church.db, async (tx) => {
		await RequestActor.claimWrite(tx, owner.session, plant as never);
		await native.organizations[OPERATION](tx, owner.session, plant as never, {
			requestKey: randomUUID(),
			expectedRevision: saved.revision,
			input: {
				plant,
				locality: ROUND_ROCK,
				referenceVersionId: saved.referenceVersionId,
				regionItemId: next!.id,
			},
		});
	});
	const back = await r.prepare(owner, OPERATION, input);
	completed(await r.approve(owner, back));
	const [first, screen, third] = await rows();
	assert.deepEqual(
		[first, screen, third].map((x) => [x!.city, x!.region, x!.supersedes_id]),
		[
			["Fort Worth", first!.region, null],
			["Round Rock", screen!.region, first!.id],
			["Fort Worth", first!.region, screen!.id],
		],
		"each correction keeps the earlier place",
	);
	const written = (await audits()).slice(audited);
	assert.deepEqual(
		written.map((a) => [a.kind, Number(a.after) - Number(a.before)]),
		[
			["correct", 1],
			["correct", 1],
			["correct", 1],
		],
		"the same audit as Settings writes",
	);

	await r.refusedCard(
		owner,
		OPERATION,
		input,
		"The reporting place and Region are already this, so nothing would change.",
	);
	await r.refuses(owner, OPERATION, { ...FORT_WORTH, regionItemId: next!.id }, "invalid_input");
	await r.refuses(owner, OPERATION, { ...FORT_WORTH, regionItemId: randomUUID() }, "invalid_input");
	await r.refuses(church.actors.admin, OPERATION, { ...ROUND_ROCK, regionItemId: randomUUID() }, "invalid_input");
	for (const who of ["member", "org", "network"] as const) {
		await r.refuses(church.actors[who], OPERATION, input, "access_denied");
		const offered = readCatalog(church.actors[who]).domains.flatMap((d) =>
			d.operations.map((o) => String(o.operation)),
		);
		assert.ok(!offered.includes(listReportingRegionCandidates.operation), who);
	}
});
