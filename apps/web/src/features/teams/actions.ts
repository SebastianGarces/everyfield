"use server";

import { getViewer } from "@/server/request-context";
import { teamsWriter } from "@everyfield/domain/teams";
import type { Transaction } from "@everyfield/db/client";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Outcome } from "./model.ts";
import { write } from "./server.ts";

const noSeat = { status: "refused", code: "unavailable" } as const;
type Context = Parameters<typeof teamsWriter.create>[1];
type Run<T> = (tx: Transaction, ctx: Context) => Promise<TeamsReply<T>>;

async function seat() {
	return (await getViewer()).people ?? null;
}
async function change<T>(run: Run<T>): Promise<Outcome<T>> {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, run);
}
const withIds = (fields: unknown, ids: Record<string, string>) =>
	fields && typeof fields === "object" && !Array.isArray(fields) ? { ...fields, ...ids } : fields;
const command = (requestKey: string, expectedRevision: string, input: unknown) => ({
	requestKey,
	expectedRevision,
	input,
});

export async function createTeam(requestKey: string, input: unknown) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) => teamsWriter.create(tx, ctx, { requestKey, input }));
}

export async function changeTeam(
	op: unknown,
	requestKey: string,
	expectedRevision: string,
	teamId: string,
	patch: unknown = {},
) {
	if (op !== "edit" && op !== "archive" && op !== "restore")
		return { status: "refused", code: "invalid_input" } as const;
	return change((tx, ctx) =>
		teamsWriter[op](tx, ctx, command(requestKey, expectedRevision, withIds(patch, { teamId }))),
	);
}

export async function appointLeader(requestKey: string, expectedRevision: string, teamId: string, personId: string) {
	return change((tx, ctx) =>
		teamsWriter.appointLeader(tx, ctx, command(requestKey, expectedRevision, { teamId, personId })),
	);
}

export async function createRole(requestKey: string, teamId: string, input: unknown) {
	return change((tx, ctx) => teamsWriter.createRole(tx, ctx, { requestKey, input: withIds(input, { teamId }) }));
}
export async function editRole(requestKey: string, expectedRevision: string, roleId: string, patch: unknown) {
	return change((tx, ctx) =>
		teamsWriter.editRole(tx, ctx, command(requestKey, expectedRevision, withIds(patch, { roleId }))),
	);
}
export async function retireRole(requestKey: string, expectedRevision: string, roleId: string) {
	return change((tx, ctx) => teamsWriter.retireRole(tx, ctx, command(requestKey, expectedRevision, { roleId })));
}
export async function assignRole(
	requestKey: string,
	expectedRevision: string,
	teamId: string,
	roleId: string,
	personId: string,
) {
	return change((tx, ctx) =>
		teamsWriter.assignRole(tx, ctx, command(requestKey, expectedRevision, { roleId, teamId, personId })),
	);
}
export async function endMembership(requestKey: string, expectedRevision: string, teamId: string, personId: string) {
	return change((tx, ctx) =>
		teamsWriter.endMembership(tx, ctx, command(requestKey, expectedRevision, { teamId, personId })),
	);
}
export async function reactivateMembership(
	requestKey: string,
	expectedRevision: string,
	roleId: string,
	personId: string,
) {
	return change((tx, ctx) =>
		teamsWriter.reactivateMembership(tx, ctx, command(requestKey, expectedRevision, { roleId, personId })),
	);
}

export async function correctTenure(requestKey: string, expectedRevision: string, input: unknown) {
	return change((tx, ctx) => teamsWriter.correctTenure(tx, ctx, command(requestKey, expectedRevision, input)));
}

export async function importTemplates(
	requestKey: string,
	version: string,
	selections: unknown,
): Promise<Outcome<{ newTeams: number; newRoles: number }>> {
	const v = await seat();
	if (!v) return noSeat;
	const done = await write(v, (tx, ctx) =>
		teamsWriter.initialize(tx, ctx, {
			requestKey,
			input: { expectedVersion: version, mode: "import", selections },
		}),
	);
	if (done.status !== "ok") return done;
	return { status: "ok", value: { newTeams: done.value.newTeams, newRoles: done.value.newSelectedRoles } };
}
