import type { Database } from "@everyfield/db/client";
import { createSeatService } from "@everyfield/domain/identity";
import { z } from "zod";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { plantAdmin, plantSeat } from "../../native.ts";
import { ROLE_LABEL } from "../../../catalog/labels.ts";

// Who has access to the church: its seats and its pending seat invitations, read through the same native reads the
// Settings > Seats screen uses. Any seat may read the roster; only an Owner or Admin sees the invitations. Only the
// fields Seats shows reach the model: a name and role, never a login address, and an invitation's typed address.

const roleLabel = (role: string) => ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role;

/** seats.list: the church's current seats with each person's role. The signed-in user's own seat is `you: true`. */
export const SEAT_READS = [
	{
		operation: "seats.list",
		description: "Who has a seat in this church, with each person's role (Owner, Admin or Member)",
		input: z.strictObject({}),
		allowed: plantSeat,
		async invoke(tx, actor): Promise<SourceResult> {
			// The seat service reads in one statement with the live check on the connection it is given.
			const list = await createSeatService(tx as unknown as Database).list(actor.authority, {
				workspace: actor.owner,
			});
			const rows = list.items
				.filter((s) => s.status === "active")
				.map((s) => ({
					kind: "seat" as const,
					id: s.seatId,
					label: s.displayName,
					fields: { role: roleLabel(s.role), ...(s.isSelf ? { you: true } : {}) },
				}));
			return {
				operation: "seats.list",
				status: "available",
				rows,
				total: list.completeness === "complete" ? rows.length : null,
				page: 1,
				next: null,
				completeness: list.completeness,
				exclusions: [],
			};
		},
	} satisfies ReadAdapter<Record<string, never>>,
	{
		operation: "seats.listInvitations",
		description: "The church's pending seat invitations: the invited address, the role and when the link expires",
		input: z.strictObject({}),
		allowed: plantAdmin,
		async invoke(tx, actor, _input, native): Promise<SourceResult> {
			if (!native) throw new EvryRefusal("source_unavailable");
			const list = await native.invitations(tx).list(actor.authority, { workspace: actor.owner });
			const rows = list.items.flatMap((i) =>
				i.subject.purpose === "seat"
					? [
							{
								kind: "invitation" as const,
								id: i.invitationId,
								label: i.recipientEmail,
								fields: { role: roleLabel(i.subject.role ?? "member"), expiresAt: i.expiresAt },
							},
						]
					: [],
			);
			return {
				operation: "seats.listInvitations",
				status: "available",
				rows,
				total: list.completeness === "complete" ? rows.length : null,
				page: 1,
				next: null,
				completeness: list.completeness,
				exclusions: [],
			};
		},
	} satisfies ReadAdapter<Record<string, never>>,
] as const;
