import { owner } from "@everyfield/contracts/common";
import type { RelationshipPair } from "@everyfield/contracts/organizations";
import { liveAccess } from "@everyfield/domain/access";
import { idsIn, linkInvitations, namesFor } from "@everyfield/domain/organizations";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";
import { anySeat, rowId } from "../../native.ts";

const KIND_TEXT = {
	plant: "church plant",
	sending_church: "sending church",
	sending_network: "network",
	discovery: "person exploring church planting",
} as const;

export const listInvitations: ReadAdapter<Record<string, never>> = {
	operation: "associations.listInvitations",
	description:
		"The pending link invitations this church, organization or Discovery space sent or received: the other side, sent or received, and when each expires. These ask a sending church or network to connect; seat invitations are seats.listInvitations.",
	input: z.strictObject({}),
	allowed: anySeat,
	async invoke(tx, actor): Promise<SourceResult> {
		actor.authority.observe(tx);
		const list = await linkInvitations(tx, actor.authority);
		return {
			operation: "associations.listInvitations",
			status: list.items.length ? "available" : "not_found",
			rows: list.items.map((i) => ({
				kind: "invitation",
				id: i.invitationId,
				label: i.other,
				fields: { direction: i.direction, otherSide: KIND_TEXT[i.otherKind], state: "pending", expiresAt: i.expiresAt },
			})),
			total: list.completeness === "complete" ? list.items.length : null,
			page: 1,
			next: null,
			completeness: list.completeness,
			exclusions: [],
		};
	},
};

const scopeOf = (actor: EvryActor) =>
	actor.owner.kind === "plant"
		? { plant: actor.owner }
		: actor.owner.kind === "organization"
			? { organization: actor.owner }
			: { discoveryAccountId: actor.owner.id };

function otherEnd(actor: EvryActor, pair: RelationshipPair) {
	const subject =
		pair.kind === "discovery"
			? { id: pair.accountId, kind: KIND_TEXT.discovery }
			: pair.kind === "plant"
				? { id: pair.subject.id, kind: KIND_TEXT.plant }
				: { id: pair.subject.id, kind: KIND_TEXT.sending_church };
	return pair.organization.id === actor.owner.id
		? subject
		: { id: pair.organization.id, kind: KIND_TEXT[pair.organization.organizationKind] };
}

const historyInput = z.strictObject({
	after: rowId.optional().describe("nextAfter from the result before, to read the entries after it"),
});
export const getHistory: ReadAdapter<z.infer<typeof historyInput>> = {
	operation: "associations.getHistory",
	description:
		"The links this church, organization or Discovery space has or had with another side: the current links, and each recorded approval and end with its date and the reason when one was recorded and this seat may read it. Only what is recorded: never add an entry, a date or a reason.",
	input: historyInput,
	allowed: anySeat,
	async invoke(tx, actor, input, native): Promise<SourceResult> {
		if (!native) throw new EvryRefusal("source_unavailable");
		actor.authority.observe(tx);
		const selected = owner.parse(actor.owner);
		const page = await native.organizations["associations.getHistory"](tx, actor.session, selected, {
			...scopeOf(actor),
			...(input.after && { after: input.after }),
		});
		const open = page.status === "available" ? page : null;
		const names = open
			? await namesFor(tx, { accountId: actor.accountId, selected, access: liveAccess(actor.authority) }, idsIn(open))
			: {};
		const row = (id: string, pair: RelationshipPair, fields: Record<string, string | null>) => {
			const other = otherEnd(actor, pair);
			return {
				kind: "relationship" as const,
				id,
				label: names[other.id] ?? `A ${other.kind}`,
				fields: { otherSide: other.kind, ...fields },
			};
		};
		const rows = open
			? [
					...(input.after
						? []
						: open.activeRelationships.map((a) => row(a.id, a.pair, { entry: "current link", on: a.acceptedAt }))),
					...[...open.items]
						.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
						.map((i) =>
							row(i.id, i.pair, {
								entry: i.event === "approved" ? "link approved" : "link ended",
								on: i.occurredAt,
								reason: i.reason.status === "available" ? i.reason.value : "only an Owner or Admin can read it",
							}),
						),
				]
			: [];
		const partial = open !== null && (open.next !== null || open.completeness === "partial");
		return {
			operation: "associations.getHistory",
			status: rows.length ? "available" : "not_found",
			rows,
			total: partial ? null : rows.length,
			page: 1,
			next: null,
			completeness: partial ? "partial" : "complete",
			exclusions: [],
			...(open?.next && { facts: { nextAfter: open.next } }),
		};
	},
};

export const CONNECTION_READS = [listInvitations, getHistory] as const;
