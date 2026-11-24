import { connectionLink } from "../../../packages/domain/src/proofs.ts";
import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
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
	readLocationHistory,
} from "../../../packages/domain/src/oversight/index.ts";
import { owner, sessionId, tenantId, type Owner } from "../../../packages/contracts/src/common/index.ts";
import type { WriteTx } from "../../../packages/domain/src/access/index.ts";
import type { Workspace } from "../../support/fixture.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { plain, tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

const proofs = new Map<string, string>();
const api = createOrganizationAdapter(
	{
		async invitation(_tx, v) {
			proofs.set(
				v.invitationId,
				connectionLink("https://example.test", "/connections/respond", v.invitationId, v.proof).split("#")[1]!,
			);
		},
		invalidate: (_tx, v) =>
			sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,
				revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${v.sourceId}
				AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`,
	},
	{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
);

export async function seedOrganizations(t: Tenancy) {
	const { a, f, MARK, key } = t;
	a.network = key();
	await f.admin.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
		VALUES(${a.network},'sending_network',${`${MARK} network`},'UTC',1)`);
	const network = {
		kind: "organization" as const,
		id: tenantId.parse(a.network),
		organizationKind: "sending_network" as const,
	};
	const networkOwner = await f.account();
	await f.seat(networkOwner, network, "owner");
	const write = <V,>(
		actor: { session: string },
		workspace: Workspace,
		run: (tx: WriteTx, session: ReturnType<typeof sessionId.parse>, selected: Owner) => Promise<V>,
	) =>
		gatedTransaction(f.db, async (tx) => {
			const session = sessionId.parse(actor.session),
				selected = owner.parse(workspace);
			if (!(await RequestActor.claimWrite(tx, session, selected))) throw Error("unavailable");
			return run(tx, session, selected);
		});
	const [plant] = await t.rows<{ revision: string }>(sql`SELECT revision::text FROM plant WHERE id = ${t.plantA.id}`);
	const invitation = await write(t.ownerA, t.plantA, (tx, session, selected) =>
		api["associations.invite"](tx, session, selected, {
			requestKey: key(),
			expectedRevision: plant!.revision,
			input: {
				pair: { kind: "plant", subject: t.plantA, organization: network },
				recipientEmail: networkOwner.email,
			},
		}),
	);
	const accepted = await write(networkOwner, network, (tx, session, selected) =>
		api["associations.acceptInvitation"](tx, session, selected, {
			requestKey: key(),
			expectedRevision: "1",
			input: {
				invitationId: invitation.invitationId,
				proof: proofs.get(invitation.invitationId),
				decision: "accept",
			},
		}),
	);
	assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
	a.pair = invitation.pair;
}

export function organizationsCases(t: Tenancy, who: TenancyOwner) {
	const { a, MARK } = t;
	return [
		tenancyCase(
			"organizations:readHistory",
			() => plain(() => readHistory(t.f.db, who.actor, { plant: t.plantA, pair: a.pair })),
			{
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
		),
		tenancyCase("organizations:readPlantSharing", () => plain(() => readPlantSharing(t.f.db, who.actor, a.network)), {
			value: {},
			control: (value) => {
				const entries = Object.values(value);
				assert.equal(entries.length, 1);
				const [entry] = entries;
				assert.ok(entry && "organizationDisplayName" in entry.sharing, JSON.stringify(value));
				assert.equal(entry.sharing.organizationDisplayName, `${MARK} network`);
			},
		}),
		...(
			[
				["oversight:listPlants", () => listPlants(t.f.db, who.actor)],
				["oversight:getPlant", () => getPlant(t.f.db, who.actor, t.plantA.id)],
				["oversight:listSendingChurches", () => listSendingChurches(t.f.db, who.actor)],
				["oversight:getSendingChurch", () => getSendingChurch(t.f.db, who.actor, a.network)],
				["oversight:readIntelligence", () => readIntelligence(t.f.db, who.actor, { level: "portfolio", runId: null })],
				["oversight:readLocationHistory", () => readLocationHistory(t.f.db, who.actor, t.plantA.id)],
			] as const
		).map(([name, read]) => tenancyCase(name, () => plain<unknown>(read), { value: null, control: null })),
		tenancyCase("organizations:readReportingLocation", () => plain(() => readReportingLocation(t.f.db, who.actor)), {
			check: (value) => assert.equal(value!.region, null),
			control: (value) => assert.equal(value!.canEdit, true),
		}),
		tenancyCase(
			"organizations:suggestRegions",
			() => plain(() => suggestRegions(t.f.db, who.actor, { city: MARK, stateProvince: null, country: null })),
			{ value: [], control: null },
		),
	];
}
