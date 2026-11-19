import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import {
	createOrganizationAdapter,
	readHistory,
	readPlantSharing,
	readReportingLocation,
	suggestRegions,
} from "../../../packages/domain/src/organizations/index.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
	readIntelligence,
} from "../../../packages/domain/src/oversight/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const proofs = new Map();
const api = createOrganizationAdapter(
	{
		async invitation(_tx, v) {
			proofs.set(v.invitationId, v.proof);
		},
		notice: (tx, v) =>
			queueJobs(tx, [
				{
					tenant: v.pair.kind === "plant" ? v.pair.subject.id : v.pair.organization.id,
					kind: "notification",
					subject: v.relationshipId,
					key: `${v.kind}/${v.eventId}`,
					revision: v.revision,
					eligibleAt: new Date().toISOString(),
				},
			]),
		invalidate: (_tx, v) =>
			sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,
				revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${v.sourceId}
				AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`,
	},
	{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
);

export async function seedOrganizations(t) {
	const { a, f, MARK, key } = t;
	a.network = key();
	await f.admin.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
		VALUES(${a.network},'sending_network',${`${MARK} network`},'UTC',1)`);
	const network = { kind: "organization", id: a.network, organizationKind: "sending_network" };
	const networkOwner = await f.account();
	await f.seat(networkOwner, network, "owner");
	const write = (session, selected, name, expectedRevision, input) =>
		gatedTransaction(f.db, async (tx) => {
			if (!(await RequestActor.claimWrite(tx, session, selected))) throw Error("unavailable");
			return api[name](tx, session, selected, { requestKey: key(), expectedRevision, input });
		});
	const [plant] = await t.rows(sql`SELECT revision::text FROM plant WHERE id = ${t.plantA.id}`);
	const invitation = await write(t.ownerA.session, t.plantA, "associations.invite", plant.revision, {
		pair: { kind: "plant", subject: t.plantA, organization: network },
		recipientEmail: networkOwner.email,
	});
	const accepted = await write(networkOwner.session, network, "associations.acceptInvitation", "1", {
		invitationId: invitation.invitationId,
		proof: proofs.get(invitation.invitationId),
		decision: "accept",
	});
	assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
	a.pair = invitation.pair;
}

export function organizationsCases(t, who) {
	const { a, MARK } = t;
	const plain = async (body) => ({ status: "ok", value: await body() });
	return [
		[
			"organizations:readHistory",
			{
				run: () => plain(() => readHistory(t.f.db, who.actor, { plant: t.plantA, pair: a.pair })),
				expected: {
					value: { status: "unavailable" },
					control: (value) => {
						assert.equal(value.status, "available");
						assert.deepEqual(
							value.activeRelationships.map((r) => r.pair.organization.id),
							[a.network],
						);
						assert.ok(value.items.some((item) => item.event === "approved"));
					},
				},
			},
		],
		[
			"organizations:readPlantSharing",
			{
				run: () => plain(() => readPlantSharing(t.f.db, who.actor, a.network)),
				expected: {
					value: {},
					control: (value) => {
						const entries = Object.values(value);
						assert.equal(entries.length, 1);
						assert.equal(entries[0].sharing.organizationDisplayName, `${MARK} network`);
					},
				},
			},
		],
		...(
			[
				["oversight:listPlants", () => listPlants(t.f.db, who.actor)],
				["oversight:getPlant", () => getPlant(t.f.db, who.actor, t.plantA.id)],
				["oversight:listSendingChurches", () => listSendingChurches(t.f.db, who.actor)],
				["oversight:getSendingChurch", () => getSendingChurch(t.f.db, who.actor, a.network)],
				["oversight:readIntelligence", () => readIntelligence(t.f.db, who.actor, { level: "portfolio", runId: null })],
			] as const
		).map(([name, read]) => [name, { run: () => plain(read), expected: { value: null, control: null } }]),
		[
			"organizations:readReportingLocation",
			{
				run: () => plain(() => readReportingLocation(t.f.db, who.actor)),
				expected: {
					check: (value) => assert.equal(value.region, null),
					control: (value) => assert.equal(value.canEdit, true),
				},
			},
		],
		[
			"organizations:suggestRegions",
			{
				run: () => plain(() => suggestRegions(t.f.db, who.actor, { city: MARK, stateProvince: null, country: null })),
				expected: { value: [], control: null },
			},
		],
	];
}
