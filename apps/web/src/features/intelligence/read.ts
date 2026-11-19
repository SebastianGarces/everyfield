import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { runAssessment } from "./assessment-server.ts";
import { careViewer, runAs } from "./server.ts";
import { runSignals } from "./signals-server.ts";

export const GET = defineReads(
	async () => ({ viewer: await careViewer() }),
	"access_denied",
	(get) => ({
		history: get(z.strictObject({ page: z.unknown() }), ({ viewer }, { page }) =>
			runAs(viewer, (care, db, authority) => care.readHistory(db, authority, { page })),
		),
		attestations: get(z.undefined(), () =>
			runSignals((signals, db, authority) => signals.readAttestations(db, authority, {})),
		),
		citation: get(z.strictObject({ runId: z.unknown(), key: z.unknown() }), (_, { runId, key }) =>
			runAssessment("citation", (a, db, actor) => a.resolveCitation(db, actor, { runId, key })),
		),
	}),
);
