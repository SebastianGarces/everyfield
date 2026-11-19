"use server";

import { z } from "zod";
import { pipelineActor, pipelineWrite } from "../pipeline-mount";
import { invitationService } from "@/server/invitations";
import { pipelineWriter, reviewWriter } from "@everyfield/domain/organizations";
import { answer, refused, type Reply } from "../../identity/server";

export async function addPerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.addPerson(db, authority, input));
}
export async function editPerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.editPerson(db, authority, input));
}
export async function movePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.movePerson(db, authority, input));
}
export async function recordAssessment(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.recordAssessment(db, authority, input));
}
export async function retirePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.retirePerson(db, authority, input));
}
export async function restorePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.restorePerson(db, authority, input));
}
export async function saveStages(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.saveStages(db, authority, input));
}
export async function addNote(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.addNote(db, authority, input));
}
export async function editNote(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.editNote(db, authority, input));
}
export async function removeNote(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.removeNote(db, authority, input));
}
export async function sendAnswers(input: unknown) {
	return pipelineWrite((db, authority) => reviewWriter.sendAnswers(db, authority, input));
}
export async function withdrawReview(input: unknown) {
	return pipelineWrite((db, authority) => reviewWriter.withdrawReview(db, authority, input));
}
export async function saveGoal(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.saveGoal(db, authority, input));
}
export async function logConversation(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.logConversation(db, authority, input));
}
export async function correctConversation(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.correctConversation(db, authority, input));
}

const linkInvite = z.looseObject({ input: z.looseObject({}) });

export async function runLinkInvitation(operation: unknown, command: unknown): Promise<Reply> {
	const who = await pipelineActor();
	const service = invitationService();
	if (who.kind !== "seat" || !service) return refused("unavailable");
	const organization = who.authority.actor.context.owner;
	if (operation === "invite") {
		const invite = linkInvite.safeParse(command);
		if (!invite.success) return refused("invalid_input");
		return answer(() =>
			service.inviteResident(who.authority, { ...invite.data, input: { ...invite.data.input, organization } }),
		);
	}
	if (operation === "resend") return answer(() => service.resend(who.authority, command));
	if (operation === "revoke") return answer(() => service.revoke(who.authority, command));
	return refused("invalid_input");
}
