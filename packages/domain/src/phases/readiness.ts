import * as c from "@everyfield/contracts/phases";
import "server-only";

type CriterionResults = Partial<Record<c.CriterionKey, c.CriterionStatus>>;

export function readinessOf(phase: c.CatalogPhase, results: CriterionResults): c.Readiness {
	const criteria = phase.criteria.map(({ key, label }) => ({ key, label, status: results[key] ?? "unknown" }));
	const met = criteria.filter((x) => x.status === "met").length;
	const measured = criteria.some((x) => x.status === "met" || x.status === "not_met");
	const verdict = phase.terminal
		? "terminal"
		: met === criteria.length
			? "ready"
			: !measured
				? "unknown"
				: met === criteria.length - 1
					? "approaching"
					: "not_ready";
	return c.readiness.parse({
		phase: phase.phase,
		verdict,
		ready: verdict === "ready",
		humanTransitionAllowed: true,
		measured,
		criteria,
	});
}

export function readReadiness(catalog: c.Catalog, results: CriterionResults): c.Readiness[] {
	return catalog.phases.map((phase) => readinessOf(phase, results));
}
