import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { careViewer, runAs } from "./server.ts";

export const GET = defineReads(
	async () => ({ viewer: await careViewer() }),
	"access_denied",
	(get) => ({
		history: get(z.strictObject({ page: z.unknown() }), ({ viewer }, { page }) =>
			runAs(viewer, (care, db, authority) => care.readHistory(db, authority, { page })),
		),
	}),
);
