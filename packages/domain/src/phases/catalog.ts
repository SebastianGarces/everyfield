import * as c from "@everyfield/contracts/phases";
import { loadStarter } from "@everyfield/reference/playbook";
import "server-only";

/** Each criterion's label, as docs/reference/phase-exit-criteria.ts words it. The keys come from the frozen reference. */
const LABELS: Record<c.CriterionKey, string> = {
	values_documented: "Core values documented",
	foundations_complete: "Foundational modules complete",
	coach_assigned: "Coach assigned",
	committed_adults: "30 committed adults",
	growth_trajectory: "Growth still moving",
	financial_base: "Launch funding viable",
	worship_leader: "Worship leader identified",
	geographic_area: "Geographic area set",
	all_team_leaders: "All eight team leaders assigned",
	launch_date_set: "Launch date set",
	training_complete: "Team training complete",
	systems_tested: "Systems tested",
	launch_window: "Inside the final launch window",
	readiness_milestones: "Launch readiness checklist complete",
	prelaunch_services: "Pre-launch services held",
	promotion_executed: "Promotion executed",
	first_service_complete: "First service held",
	guest_data_entered: "Guest data entered",
	debrief_done: "Debrief done",
};
/** The methodology's `playbook_checklist`: the software checklist row, keyed `readiness_milestones` in the reference. */
const SOFTWARE_ONLY: ReadonlySet<c.CriterionKey> = new Set(["readiness_milestones"]);

/**
 * phases.readCatalog (PHASE-008): the seven phases and each one's Playbook exit criteria from the WP-032 reference
 * package. Static approved metadata: no plant data and no statement. Phase 6 is terminal with no criteria.
 */
export async function readCatalog(): Promise<c.Catalog> {
	const starter = await loadStarter();
	const criteria = starter.catalogs.criteria.map((row) => ({ phase: row.phase, key: c.criterionKey.parse(row.key) }));
	if (new Set(criteria.map((row) => row.key)).size !== c.CRITERION_KEYS.length) throw Error("criterion_keys_changed");
	return c.catalog.parse({
		phases: starter.catalogs.phases
			.toSorted((a, b) => a.phase - b.phase)
			.map(({ phase, name }) => ({
				phase,
				name,
				terminal: phase === c.TERMINAL_PHASE,
				criteria: criteria
					.filter((row) => row.phase === phase)
					.map(({ key }) => ({ key, label: LABELS[key], softwareOnly: SOFTWARE_ONLY.has(key) })),
			})),
	});
}
