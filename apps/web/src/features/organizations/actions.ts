"use server";

import {
	command,
	disclosureFor,
	idsIn,
	invitationFor,
	namesFor,
	pendingFor,
	query,
	readHistory,
	readPlantSharing,
	residencyRevision,
	residentOwner,
	scopeOf,
	viewerOf,
	type Reply,
} from "@/server/organizations";
import { residencySharingRequest, type OrganizationOperations as Ops } from "@everyfield/contracts/organizations";

// The browser's only door to the organization mount (WP-007/ui ruling D11): one typed server action per operation.
// Each names its concrete adapter method, so the input and output types are the operation's own and the screens trust
// the value. Every call reads the session and the current seat once; commands bind that actor to their transaction,
// reads take no lock.

const refused: Reply<never> = { status: "refused", code: "unavailable" };
type Input<K extends keyof Ops> = Ops[K]["input"];

/** The viewer of this request, or a refusal. */
async function who() {
	const w = await viewerOf();
	return w.kind === "viewer" ? w : null;
}

export async function inviteAssociation(input: Input<"associations.invite">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.invite"](tx, s, o, input),
	);
}
export async function resendAssociationInvitation(input: Input<"associations.resendInvitation">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.resendInvitation"](tx, s, o, input),
	);
}
export async function revokeAssociationInvitation(input: Input<"associations.revokeInvitation">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.revokeInvitation"](tx, s, o, input),
	);
}
/** Used only by endConnection, which also answers with the history. */
async function endAssociation(input: Input<"associations.end">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.end"](tx, s, o, input),
	);
}
export async function respondAssociationInvitation(input: Input<"associations.respondInvitation">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.respondInvitation"](tx, s, o, input),
	);
}
export async function getAssociationHistory(input: Input<"associations.getHistory">) {
	const w = await who();
	if (!w) return refused;
	return { status: "ok", value: await readHistory(w.mount.db, w.authority, input) } as const;
}
export async function getSharing(input: Input<"privacy.getSharing">) {
	const w = await who();
	if (!w) return refused;
	return query(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["privacy.getSharing"](tx, s, o, input),
	);
}
/** Used only by saveSharing, which also answers with the sharing as saved. */
async function setSharing(input: Input<"privacy.setSharing">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["privacy.setSharing"](tx, s, o, input),
	);
}
export async function readResidencySharing(input: Input<"residency.readSharing">) {
	const w = await who();
	if (!w) return refused;
	return query(w.mount, w.authority, residentOwner(w.viewer), (tx, s, o) =>
		w.mount.adapter["residency.readSharing"](tx, s, o, input),
	);
}
export async function setResidencySharing(input: Input<"residency.setSharing">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, residentOwner(w.viewer), (tx, s, o) =>
		w.mount.adapter["residency.setSharing"](tx, s, o, input),
	);
}
export async function leaveResidency(input: Input<"residency.leave">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, residentOwner(w.viewer), (tx, s, o) =>
		w.mount.adapter["residency.leave"](tx, s, o, input),
	);
}
export async function readPipelineConsent(input: Input<"pipelineSharing.readConsent">) {
	const w = await who();
	if (!w) return refused;
	return query(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["pipelineSharing.readConsent"](tx, s, o, input),
	);
}
export async function setPipelineConsent(input: Input<"pipelineSharing.setConsent">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["pipelineSharing.setConsent"](tx, s, o, input),
	);
}
export async function checkPipelineAggregateAccess(input: Input<"pipelineSharing.checkAggregateAccess">) {
	const w = await who();
	if (!w) return refused;
	return query(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["pipelineSharing.checkAggregateAccess"](tx, s, o, input),
	);
}

/** One history page of this viewer's own scope, with the names it shows: two statements after the viewer. */
export async function loadHistoryPage(after: string | null) {
	const w = await who();
	if (!w) return { page: { status: "unavailable" as const }, names: {} };
	const page = await readHistory(w.mount.db, w.authority, { ...scopeOf(w.viewer), ...(after ? { after } : {}) });
	const names = page.status === "available" ? await namesFor(w.mount.db, w.viewer, idsIn(page)) : {};
	return { page, names };
}

/** The connections list: first history page, the requests still waiting, what each connection sees, and names. */
export async function loadConnections() {
	const w = await who();
	if (!w) return { history: { status: "unavailable" as const }, pending: [], sharing: {}, names: {} };
	const [first, pending, sharing] = await Promise.all([
		loadHistoryPage(null),
		pendingFor(w.mount.db, w.viewer),
		readPlantSharing(w.mount.db, w.authority),
	]);
	const extra = await namesFor(
		w.mount.db,
		w.viewer,
		pending.map((p) => p.pair.organization.id),
	);
	return { history: first.page, pending, sharing, names: { ...first.names, ...extra } };
}

export async function loadDisclosure(pair: unknown) {
	const w = await who();
	if (!w) return null;
	return disclosureFor(w.mount, w.authority, w.viewer, pair);
}

/** The request behind an emailed link, for a signed-in account. */
export async function loadInvitation(invitationId: string, proof: string) {
	const w = await viewerOf();
	if (w.kind === "signed_out") return { kind: "signed_out" as const };
	if (w.kind !== "viewer") return { kind: "unavailable" as const };
	const invitation = await invitationFor(w.mount, w.authority, w.viewer, invitationId, proof);
	if (!invitation) return { kind: "unavailable" as const };
	const p = invitation.pair;
	const names = await namesFor(w.mount.db, w.viewer, [
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
	const w = await who();
	if (!w) return unavailable;
	const [reply, linkRevision] = await Promise.all([
		readResidencySharing(residencySharingRequest.parse({ linkId })),
		residencyRevision(w.mount.db, w.viewer, linkId),
	]);
	if (reply.status !== "ok" || linkRevision === null) return unavailable;
	return { sharing: reply.value, linkRevision };
}

/** One of this plant's own connections: what it shares and the connection revision a change must carry. One statement. */
export async function loadSharing(
	relationshipId: string,
	request: Ops["privacy.getSharing"]["input"],
): Promise<{ sharing: Ops["privacy.getSharing"]["output"]; relationshipRevision: string }> {
	const w = await who();
	const row = w ? (await readPlantSharing(w.mount.db, w.authority, request.organization.id))[relationshipId] : null;
	return row ?? { sharing: { status: "unavailable" as const }, relationshipRevision: "0" };
}

/**
 * Ends one connection, then reads the first history page as it is now, in the same request: the list drops the
 * connection and shows its history entry without reading everything again.
 */
export async function endConnection(input: Input<"associations.end">) {
	const reply = await endAssociation(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, history: null };
	return { reply, history: await loadHistoryPage(null) };
}

/**
 * Saves one sharing choice, then reads that connection's sharing as saved, in the same request: the card shows the
 * choice and both revisions the next change must carry, and the list takes the connection's new revision.
 */
export async function saveSharing(input: Input<"privacy.setSharing">) {
	const reply = await setSharing(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, row: null };
	const { plant, organization, relationshipId } = input.input;
	return { reply, row: await loadSharing(relationshipId, { plant, organization }) };
}
