import { z } from "zod";
const protocol = z.strictObject({
	source: z.string().regex(/^[a-f0-9]{40}$/),
	reference: z.string().regex(/^[a-f0-9]{64}$/),
	fixtureRelease: z.string().regex(/^synthetic-[a-z0-9-]+$/),
	cases: z
		.array(z.string().regex(/^[a-z0-9_]+$/))
		.min(1)
		.max(1000),
});
export function auditProofCoverage(input: unknown, result: unknown) {
	const p = protocol.parse(input);
	const r = z
		.strictObject({
			source: z.literal(p.source),
			reference: z.literal(p.reference),
			fixtureRelease: z.literal(p.fixtureRelease),
			executedAt: z.iso.datetime(),
			cases: z.array(z.strictObject({ name: z.string(), status: z.enum(["passed", "failed"]) })).max(1000),
		})
		.safeParse(result);
	if (!r.success) return { status: "not_run" as const, rollout_allowed: false, live_account_proven: false };
	const names = r.data.cases.map((c) => c.name);
	if (
		new Set(names).size !== names.length ||
		names.length !== p.cases.length ||
		p.cases.some((name) => !names.includes(name))
	)
		return { status: "incomplete" as const, rollout_allowed: false, live_account_proven: false };
	return {
		status: r.data.cases.every((c) => c.status === "passed") ? ("passed" as const) : ("failed" as const),
		rollout_allowed: false,
		live_account_proven: false,
	};
}
export function trackWork() {
	return { status: "skipped" as const, reason: "board_integration_unconfigured" as const, product_failed: false };
}
