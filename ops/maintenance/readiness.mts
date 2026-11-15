// ops.readiness: the before-customer-data gate report (docs/architecture/recovery.md, "Before-customer-data gate";
// runbook.json "observability.readiness"). It reads only the evidence handed to it (a private evidence file on the
// CLI) and names each kind of evidence still missing: cost approval, the restricted host schedule, key exclusion from
// ordinary app/build/preview access, and a coherent restore that proved live recovery. A restore rehearsal never proves
// live recovery, so it never counts. No network, provider, spend or configuration call. WP-058 closes the gate with live
// evidence; in this slice the gate never reads ready and the build gate never rests on backup. Only the restricted CLI
// and tests import this file.
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const { z } = require("zod");

export const READINESS_OPERATION = "ops.readiness";
const capability = z.strictObject({
	authority: z.literal("explicit_scoped_operator"),
	verified: z.literal(true),
	operation_ids: z.array(z.string()).refine((ids: string[]) => ids.includes(READINESS_OPERATION)),
	environment: z.literal("isolated-test"),
});
const at = z.iso.datetime();
/** What each kind of evidence must state to count as supplied. Anything else counts as missing. */
const EVIDENCE = {
	cost_approval: z.looseObject({
		approved: z.literal(true),
		approved_at: at,
		monthly_usd: z.strictObject({ low: z.number(), expected: z.number(), high: z.number() }),
	}),
	host_schedule: z.looseObject({ host: z.string().min(1), schedule: z.string().min(1), verified_at: at }),
	key_exclusion: z.looseObject({
		denied: z.strictObject({ app: z.literal(true), build: z.literal(true), preview: z.literal(true) }),
		verified_at: at,
	}),
	coherent_restore: z.looseObject({ live_recovery_proven: z.literal(true), verified_at: at }),
};
export type EvidenceItem = keyof typeof EVIDENCE;

export type ReadinessReport =
	| {
			refusal: null;
			customer_data_gate: "blocked";
			build_gate_from_backup: false;
			/** The evidence still missing, in a fixed order. */
			missing: EvidenceItem[];
			/** Supplied evidence is a claim; no live check of it runs here. */
			live_evidence_verified: false;
			checked_at: string;
	  }
	| { refusal: "operator_unavailable" };

export function readiness(input: { capability: unknown; evidence: unknown; now: Date }): ReadinessReport {
	if (!capability.safeParse(input.capability).success) return { refusal: "operator_unavailable" };
	const evidence = input.evidence && typeof input.evidence === "object" ? (input.evidence as Record<string, unknown>) : {};
	const missing = (Object.keys(EVIDENCE) as EvidenceItem[]).filter(
		(item) => !EVIDENCE[item].safeParse(evidence[item]).success,
	);
	return {
		refusal: null,
		customer_data_gate: "blocked",
		build_gate_from_backup: false,
		missing,
		live_evidence_verified: false,
		checked_at: input.now.toISOString().replace(/\.000Z$/, "Z"),
	};
}
