"use server";

import {
	command,
	disclosureFor,
	idsIn,
	namesFor,
	pendingFor,
	readHistory,
	readPipelineConsents,
	readPlantSharing,
	residencyLinks,
	residentOwner,
	scopeOf,
	viewerOf,
	type Reply,
} from "@/server/organizations";
import type { OrganizationOperations as Ops } from "@everyfield/contracts/organizations";
import type { ResidencyRow } from "./Residency";

// The browser's only door to the organization mount (WP-007/ui ruling D11): one typed server action per operation.
// Each names its concrete adapter method, so the input and output types are the operation's own and the screens trust
// the value. Every call reads the session and the current seat once; commands bind that actor to their transaction,
// reads take no lock. A relationship invitation's proof never comes here: its read and its answer go through
// POST /api/connections/invitation (invitation/handler.ts, the D54 clarification of 2026-11-10).

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
/** Used only by saveSharing, which also answers with the sharing as saved. */
async function setSharing(input: Input<"privacy.setSharing">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["privacy.setSharing"](tx, s, o, input),
	);
}
/** Used only by saveResidencySharing, which also answers with the consent as saved. */
async function setResidencySharing(input: Input<"residency.setSharing">) {
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
/** Used only by savePipelineConsent, which also answers with the choice as saved. */
async function setPipelineConsent(input: Input<"pipelineSharing.setConsent">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["pipelineSharing.setConsent"](tx, s, o, input),
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

/** One of this account's own residency links: the consent and the link revision a change must carry. One statement. */
export async function loadResidency(linkId: string): Promise<ResidencyRow> {
	const w = await who();
	const [link] = w ? await residencyLinks(w.mount.db, w.viewer, linkId) : [];
	return link ?? { sharing: { status: "unavailable" as const }, linkRevision: "0" };
}

/** One of this sending church's own network connections: its pipeline totals choice and revision. */
export async function loadPipelineConsent(
	relationshipId: string,
): Promise<Ops["pipelineSharing.readConsent"]["output"]> {
	const w = await who();
	const [row] = w ? await readPipelineConsents(w.mount.db, w.authority, relationshipId) : [];
	return row?.consent ?? { status: "unavailable" as const };
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

/**
 * Saves one residency sharing choice, then reads that link as saved, in the same request: the card shows the choice
 * and both revisions the next change must carry without another read.
 */
export async function saveResidencySharing(input: Input<"residency.setSharing">) {
	const reply = await setResidencySharing(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, row: null };
	return { reply, row: await loadResidency(input.input.linkId) };
}

/** Saves one pipeline totals choice, then reads it as saved, in the same request (the shape of saveSharing). */
export async function savePipelineConsent(input: Input<"pipelineSharing.setConsent">) {
	const reply = await setPipelineConsent(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, consent: null };
	return { reply, consent: await loadPipelineConsent(input.input.relationshipId) };
}
