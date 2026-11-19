"use server";

import { z } from "zod";
import { command, residentOwner, type Reply } from "./mount";
import { loadHistoryPage, loadPipelineConsent, loadResidency, loadSharing, who } from "./connection-reads";

const sharingSaved = z.object({
	input: z.object({ relationshipId: z.string(), organization: z.object({ id: z.string() }) }),
});
const residencySaved = z.object({ input: z.object({ linkId: z.string() }) });
const consentSaved = z.object({ input: z.object({ relationshipId: z.string() }) });

const refused: Reply<never> = { status: "refused", code: "unavailable" };

export async function inviteAssociation(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.invite"](tx, s, o, input),
	);
}
export async function resendAssociationInvitation(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.resendInvitation"](tx, s, o, input),
	);
}
export async function revokeAssociationInvitation(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.revokeInvitation"](tx, s, o, input),
	);
}
async function endAssociation(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.end"](tx, s, o, input),
	);
}
async function setSharing(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["privacy.setSharing"](tx, s, o, input),
	);
}
async function setResidencySharing(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, residentOwner(w.viewer), (tx, s, o) =>
		w.mount.adapter["residency.setSharing"](tx, s, o, input),
	);
}
export async function leaveResidency(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, residentOwner(w.viewer), (tx, s, o) =>
		w.mount.adapter["residency.leave"](tx, s, o, input),
	);
}
async function setPipelineConsent(input: unknown) {
	const w = await who();
	if (!w) return refused;
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["pipelineSharing.setConsent"](tx, s, o, input),
	);
}
export async function endConnection(input: unknown) {
	const reply = await endAssociation(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, history: null };
	return { reply, history: await loadHistoryPage(await who(), null) };
}

export async function saveSharing(input: unknown) {
	const reply = await setSharing(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, row: null };
	const saved = sharingSaved.safeParse(input);
	if (!saved.success) return { reply, row: null };
	const { relationshipId, organization } = saved.data.input;
	return { reply, row: await loadSharing(await who(), relationshipId, organization.id) };
}

export async function saveResidencySharing(input: unknown) {
	const reply = await setResidencySharing(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, row: null };
	const saved = residencySaved.safeParse(input);
	if (!saved.success) return { reply, row: null };
	return { reply, row: await loadResidency(await who(), saved.data.input.linkId) };
}

export async function savePipelineConsent(input: unknown) {
	const reply = await setPipelineConsent(input);
	if (reply.status !== "ok" || reply.value.status !== "committed") return { reply, consent: null };
	const saved = consentSaved.safeParse(input);
	if (!saved.success) return { reply, consent: null };
	return { reply, consent: await loadPipelineConsent(await who(), saved.data.input.relationshipId) };
}
