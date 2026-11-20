"use server";

import { seated } from "@/server/request-context";
import { responsibilityWriter } from "@everyfield/domain/teams";
import { write } from "../server.ts";

const command = (requestKey: string, expectedRevision: string, input: unknown) => ({
	requestKey,
	expectedRevision,
	input,
});

export async function offerResponsibilities(requestKey: string, expectedRevision: string, input: unknown) {
	return seated("unavailable", async (v) => {
		return write(v, (tx, ctx) =>
			responsibilityWriter.offerResponsibilities(tx, ctx, command(requestKey, expectedRevision, input)),
		);
	});
}

export async function addResponsibility(requestKey: string, expectedRevision: string, teamId: string, text: string) {
	return seated("unavailable", async (v) => {
		return write(v, (tx, ctx) =>
			responsibilityWriter.addResponsibility(tx, ctx, command(requestKey, expectedRevision, { teamId, text })),
		);
	});
}

export async function editResponsibility(
	requestKey: string,
	expectedRevision: string,
	responsibilityId: string,
	text: string,
) {
	return seated("unavailable", async (v) => {
		return write(v, (tx, ctx) =>
			responsibilityWriter.editResponsibility(
				tx,
				ctx,
				command(requestKey, expectedRevision, { responsibilityId, text }),
			),
		);
	});
}

export async function completeResponsibility(
	requestKey: string,
	expectedRevision: string,
	responsibilityId: string,
	done: boolean,
) {
	return seated("unavailable", async (v) => {
		return write(v, (tx, ctx) =>
			responsibilityWriter.completeResponsibility(
				tx,
				ctx,
				command(requestKey, expectedRevision, { responsibilityId, done }),
			),
		);
	});
}

export async function deleteResponsibility(requestKey: string, expectedRevision: string, responsibilityId: string) {
	return seated("unavailable", async (v) => {
		return write(v, (tx, ctx) =>
			responsibilityWriter.deleteResponsibility(tx, ctx, command(requestKey, expectedRevision, { responsibilityId })),
		);
	});
}
