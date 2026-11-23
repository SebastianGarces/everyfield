import { relationshipPair } from "@everyfield/contracts/organizations";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import {
	loadConnections,
	loadDisclosure,
	loadHistoryPage,
	loadPipelineConsent,
	loadResidency,
	loadSharing,
	who,
} from "./connection-reads";

const ok = async <T>(value: Promise<T>) => ({ status: "ok", value: await value }) as const;

export const GET = defineReads(
	async () => ({ w: await who() }),
	"unavailable",
	(get) => ({
		connections: get(z.undefined(), ({ w }) => ok(loadConnections(w))),
		history: get(z.strictObject({ after: z.string().nullable() }), ({ w }, v) => ok(loadHistoryPage(w, v.after))),
		disclosure: get(relationshipPair, ({ w }, pair) => ok(loadDisclosure(w, pair))),
		residency: get(z.strictObject({ linkId: z.string() }), ({ w }, v) => ok(loadResidency(w, v.linkId))),
		consent: get(z.strictObject({ relationshipId: z.string() }), ({ w }, v) =>
			ok(loadPipelineConsent(w, v.relationshipId)),
		),
		sharing: get(z.strictObject({ relationshipId: z.string(), organizationId: z.string() }), ({ w }, v) =>
			ok(loadSharing(w, v.relationshipId, v.organizationId)),
		),
	}),
);
