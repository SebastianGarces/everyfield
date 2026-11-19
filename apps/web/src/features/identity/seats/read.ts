import { invitationService } from "@/server/invitations";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../../server/platform/reads.ts";
import { answer } from "../server";
import { loadSeats, workspaceViewer } from "./server";

export const GET = defineReads(workspaceViewer, "unavailable", (get) => ({
	seats: get(z.undefined(), (w) => loadSeats(w)),
	page: get(z.strictObject({ list: z.enum(["seats", "invitations"]), after: z.string() }), async (w, v) => {
		const service = invitationService();
		const { mount, selected, authority } = w;
		return v.list === "seats"
			? answer(() => mount.seats.list(authority, { workspace: selected, after: v.after }))
			: answer(() => service.list(authority, { workspace: selected, after: v.after }));
	}),
	removal: get(z.strictObject({ seatId: z.string() }), (w, v) =>
		answer(() => w.mount.seats.readRemoval(w.viewer.session, w.selected, v)),
	),
}));
