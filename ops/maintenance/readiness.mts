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
			missing: EvidenceItem[];
			live_evidence_verified: false;
			checked_at: string;
	  }
	| { refusal: "operator_unavailable" };

export function readiness(input: { capability: unknown; evidence: unknown; now: Date }): ReadinessReport {
	if (!capability.safeParse(input.capability).success) return { refusal: "operator_unavailable" };
	const evidence =
		input.evidence && typeof input.evidence === "object" ? (input.evidence as Record<string, unknown>) : {};
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
