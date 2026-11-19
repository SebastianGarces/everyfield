import { communicationWriter } from "@everyfield/domain/communication";
import "server-only";
import { z } from "zod";
import { canWrite } from "../../components/seat-role.ts";
import { defineReads } from "../../server/platform/reads.ts";
import type { Outcome, Recipient } from "./model.ts";
import { communicationViewer, read } from "./server.ts";

async function writer() {
	const { viewer } = await communicationViewer();
	return viewer && canWrite(viewer) ? viewer : null;
}

export const GET = defineReads(writer, "access_denied", (get) => ({
	recipients: get(z.string(), (viewer, query): Promise<Outcome<{ people: Recipient[] }>> =>
		read(viewer, (tx) => communicationWriter.readRecipients(tx, viewer.authority, { query })),
	),
}));
