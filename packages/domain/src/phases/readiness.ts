import * as c from "@everyfield/contracts/phases";
import "server-only";

type CriterionResults = Partial<Record<c.CriterionKey, c.CriterionStatus>>;

/**
 * Advisory readiness for one phase's exit criteria (PHASE-004). The cluster is a conjunction without weights: ready only
 * when every criterion is met. Unknown and not tracked hold the verdict back without counting as failures. One open
 * criterion with the rest met is approaching; no measured criterion at all is unknown; anything else is not ready. A
 * person may always move the phase, whatever the verdict.
 */
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

/**
 * phases.readReadiness for every phase of the catalog. No criterion has a measured source until WP-040 ships, so every
 * result is Unknown and the read sends no statement; WP-040 passes its measured facts here.
 */
export function readReadiness(catalog: c.Catalog): c.Readiness[] {
	return catalog.phases.map((phase) => readinessOf(phase, {}));
}
