"use server";

import { command, residentOwner, type Reply } from "./mount";
import type { OrganizationOperations as Ops } from "@everyfield/contracts/organizations";
import { loadHistoryPage, loadPipelineConsent, loadResidency, loadSharing, who } from "./connection-reads";

const refused: Reply<never> = { status: "refused", code: "unavailable" };
type Input<K extends keyof Ops> = Ops[K]["input"];

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
async function endAssociation(input: Input<"associations.end">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.end"](tx, s, o, input),
	);
}
async function setSharing(input: Input<"privacy.setSharing">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["privacy.setSharing"](tx, s, o, input),
	);
}
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
async function setPipelineConsent(input: Input<"pipelineSharing.setConsent">) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["pipelineSharing.setConsent"](tx, s, o, input),
	);
}
export async function endConnection(input: Input<"associations.end">) {
	const reply = await endAssociation(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, history: null };
	return { reply, history: await loadHistoryPage(await who(), null) };
}

export async function saveSharing(input: Input<"privacy.setSharing">) {
	const reply = await setSharing(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, row: null };
	const { organization, relationshipId } = input.input;
	return { reply, row: await loadSharing(await who(), relationshipId, organization.id) };
}

export async function saveResidencySharing(input: Input<"residency.setSharing">) {
	const reply = await setResidencySharing(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, row: null };
	return { reply, row: await loadResidency(await who(), input.input.linkId) };
}

export async function savePipelineConsent(input: Input<"pipelineSharing.setConsent">) {
	const reply = await setPipelineConsent(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, consent: null };
	return { reply, consent: await loadPipelineConsent(await who(), input.input.relationshipId) };
}
