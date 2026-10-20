"use server";

import { z } from "zod";
import {
	connectionRevision,
	disclosureFor,
	idsIn,
	invitationFor,
	namesFor,
	pendingFor,
	readHistory,
	residencyRevision,
	runOperation,
	scopeOf,
	viewerOf,
	type Operation,
	type Reply,
} from "@/server/organizations";
import type { OrganizationOperations } from "@everyfield/contracts/organizations";

// The browser's only door to the organization mount (WP-007/ui ruling D11). Each action returns the typed contract
// value of its operation; the screens trust it. Every call re-reads the session and the current seat once.

const OPERATIONS = [
	"associations.invite",
	"associations.resendInvitation",
	"associations.revokeInvitation",
	"associations.end",
	"associations.respondInvitation",
	"associations.getHistory",
	"privacy.getSharing",
	"privacy.setSharing",
	"residency.readSharing",
	"residency.setSharing",
	"residency.leave",
	"pipelineSharing.readConsent",
	"pipelineSharing.setConsent",
	"pipelineSharing.checkAggregateAccess",
] as const satisfies readonly Operation[];
const operation = z.enum(OPERATIONS);
const refused: Reply<never> = { status: "refused", code: "unavailable" };

type Ops = OrganizationOperations;
export async function runOrganizationOperation<K extends Operation>(
	name: K,
	input: Ops[K]["input"],
): Promise<Reply<Ops[K]["output"]>> {
	const op = operation.safeParse(name);
	if (!op.success) return refused;
	const who = await viewerOf();
	if (who.kind !== "viewer") return refused;
	return runOperation(who.mount, who.viewer, op.data as K, input, who.authority);
}

/** One history page of this viewer's own scope, with the names it shows: two statements after the viewer. */
export async function loadHistoryPage(after: string | null) {
	const who = await viewerOf();
	if (who.kind !== "viewer") return { page: { status: "unavailable" as const }, names: {} };
	const page = await readHistory(who.mount.db, who.authority, { ...scopeOf(who.viewer), ...(after ? { after } : {}) });
	const names = page.status === "available" ? await namesFor(who.mount.db, who.viewer, idsIn(page)) : {};
	return { page, names };
}

/** The connections list: first history page, the requests still waiting, and their names. */
export async function loadConnections() {
	const who = await viewerOf();
	if (who.kind !== "viewer") return { history: { status: "unavailable" as const }, pending: [], names: {} };
	const [first, pending] = await Promise.all([loadHistoryPage(null), pendingFor(who.mount.db, who.viewer)]);
	const extra = await namesFor(
		who.mount.db,
		who.viewer,
		pending.map((p) => p.pair.organization.id),
	);
	return { history: first.page, pending, names: { ...first.names, ...extra } };
}

export async function loadDisclosure(pair: unknown) {
	const who = await viewerOf();
	if (who.kind !== "viewer") return null;
	return disclosureFor(who.mount, who.viewer, pair);
}

/** The request behind an emailed link, for a signed-in account. */
export async function loadInvitation(invitationId: string, proof: string) {
	const who = await viewerOf();
	if (who.kind === "signed_out") return { kind: "signed_out" as const };
	if (who.kind !== "viewer") return { kind: "unavailable" as const };
	const invitation = await invitationFor(who.mount, who.viewer, invitationId, proof);
	if (!invitation) return { kind: "unavailable" as const };
	const p = invitation.pair;
	const names = await namesFor(who.mount.db, who.viewer, [
		p.organization.id,
		p.kind === "discovery" ? p.accountId : p.subject.id,
	]);
	return { kind: "invitation" as const, invitation, names, zone: "UTC" };
}

/** One of this account's own residency links: the consent and the link revision a change must carry. */
export async function loadResidency(
	linkId: string,
): Promise<{ sharing: Ops["residency.readSharing"]["output"]; linkRevision: string }> {
	const unavailable = { sharing: { status: "unavailable" as const }, linkRevision: "0" };
	const who = await viewerOf();
	if (who.kind !== "viewer") return unavailable;
	const [reply, linkRevision] = await Promise.all([
		runOperation(who.mount, who.viewer, "residency.readSharing", { linkId }, who.authority),
		residencyRevision(who.mount.db, who.viewer, linkId),
	]);
	if (reply.status !== "ok" || linkRevision === null) return unavailable;
	return { sharing: reply.value, linkRevision };
}

/** One of this plant's own connections: what it shares and the connection revision a change must carry. */
export async function loadSharing(
	relationshipId: string,
	request: Ops["privacy.getSharing"]["input"],
): Promise<{ sharing: Ops["privacy.getSharing"]["output"]; relationshipRevision: string }> {
	const unavailable = { sharing: { status: "unavailable" as const }, relationshipRevision: "0" };
	const who = await viewerOf();
	if (who.kind !== "viewer") return unavailable;
	const [reply, relationshipRevision] = await Promise.all([
		runOperation(who.mount, who.viewer, "privacy.getSharing", request, who.authority),
		connectionRevision(who.mount.db, who.viewer, relationshipId),
	]);
	if (reply.status !== "ok" || relationshipRevision === null) return unavailable;
	return { sharing: reply.value, relationshipRevision };
}
