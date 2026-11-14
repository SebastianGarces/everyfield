// INV-result-card-views (T-160): every read the catalog installs, and the catalog's own tools, has a result card of its
// own. Each operation is answered by its real adapter against the eval church (golden-church.mts, seeded on Postgres;
// this file runs in @everyfield/evry's test:db) and drawn with the card's view:
// no card may fall back to the generic "Records" title, and no card may count in "person/people" words unless every row
// it shows is a person. A new read operation or catalog tool fails here until it has a view and a probe below.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as catalog from "../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter, SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import { cardView, FALLBACK } from "../../../apps/web/src/features/evry/conversation/resultView.ts";
import { byName, goldenChurch, IMPORT_KEY, programId, taskId, teamId } from "../evals/golden-church.mts";
import { nativePorts } from "../evals/settings-ports.mts";

const church = await goldenChurch();
after(church.close);
const adapters = new Map<string, ReadAdapter<unknown>>(
	Object.values(catalog.READ_DOMAINS)
		.flat()
		.map((a) => [a.operation, a as ReadAdapter<unknown>]),
);
const read = (operation: string, input: unknown) =>
	invokeRead(church.db, church.actors.owner, adapters.get(operation)!, input);
const JAMES = byName("James Okafor").id;
/** Has a household, a tag and a skill. */
const MARK = byName("Mark Thompson").id;
const FILE = "first_name,last_name,email\r\nAda,Park,ada@example.test\r\n,,\r\nJames,Okafor,\r\n";
/**
 * The open task the Tasks list finds by `search` (the first open task when none is given), read with `operation` and
 * the input `build` makes from its id.
 */
const withTask =
	(operation: string, build: (taskId: string) => Record<string, unknown>, search?: string) => async () => {
		const found = (await read("tasks.list", search ? { search } : {})).rows[0];
		assert.ok(found, `the eval church has an open task${search ? ` "${search}"` : ""}`);
		return read(operation, build(found.id));
	};

/** The input each operation is probed with. A catalog tool has a function that builds its result instead. */
const PROBES: Record<string, Record<string, unknown> | (() => Promise<SourceResult>)> = {
	"people.listPeople": {},
	"people.getPerson": { personId: JAMES },
	"people.getPersonPhoto": { personId: JAMES },
	"people.checkForDuplicates": { displayName: "James Okafor" },
	"people.listDuplicatePairs": {},
	"people.exportPeople": {},
	"people.generateCsvTemplate": {},
	// Kevin Walsh has notes on record; James Okafor has no history yet.
	"people.getActivities": { personId: byName("Kevin Walsh").id },
	"people.getHousehold": { personId: JAMES },
	"people.getHouseholdMembers": { personId: JAMES },
	"people.getImportReceipt": { requestKey: IMPORT_KEY },
	"people.getPersonSkills": { personId: MARK },
	"people.getPersonTags": { personId: MARK },
	"people.getPipelineData": {},
	"people.listHouseholds": {},
	"people.listTags": {},
	"people.previewImport": { file: FILE },
	"communication.list": {},
	"tasks.list": {},
	"tasks.count": {},
	"tasks.get": withTask("tasks.get", (taskId) => ({ taskId })),
	// Lena completed the welcome packet; a settled task is not in the open list, so the probe names it by id.
	"tasks.statusHistory": { taskId: taskId("packet") },
	"tasks.listSubtasks": withTask("tasks.listSubtasks", (parentId) => ({ parentId }), "Prepare launch Sunday"),
	"tasks.listPrerequisites": withTask("tasks.listPrerequisites", (taskId) => ({ taskId }), "Prepare launch Sunday"),
	"tasks.prerequisiteCandidates": withTask("tasks.prerequisiteCandidates", (taskId) => ({ taskId })),
	"tasks.findOpenOccurrence": withTask("tasks.findOpenOccurrence", (taskId) => ({ taskId }), "Weekly team check-in"),
	"tasks.eligibleAssignees": {},
	"tasks.relationOptions": { kind: "person", search: "James" },
	"tasks.listTemplates": {},
	"tasks.previewTemplate": async () => {
		const first = (await read("tasks.listTemplates", {})).rows[0];
		assert.ok(first, "Everyfield has a phase checklist");
		return read("tasks.previewTemplate", { checklistKey: first.id });
	},
	"tasks.readPhaseOffer": {},
	"tasks.importReceipt": {},
	"tasks.listFollowUpOwners": {},
	"tasks.followUpCoverage": {},
	"tasks.planHandoff": { fromAccountId: church.actors.owner.accountId },
	"followups.readObligations": {},
	// Beth Johnson's follow-up was completed by a recorded call.
	"followups.listContactHistory": { personId: byName("Beth Johnson").id },
	"notifications.feed": { unread: true },
	"notifications.preferences.get": {},
	"notifications.previewPlanterDigest": {},
	"teams.list": {},
	"teams.get": { teamId: teamId("Worship") },
	"teams.searchMembers": { q: "Sam" },
	"teams.staffingSummary": {},
	"teams.personTeamCounts": { minTeams: 3 },
	"teams.staffingFacts": { teamId: teamId("Core team") },
	"teams.health": { teamId: teamId("Core team") },
	"teams.aggregateHealth": {},
	"teams.trainingMatrix": { teamId: teamId("Kids ministry") },
	"teams.readRequiredTrainingParticipants": { programId: programId("Kids ministry training") },
	"teams.previewRequiredTrainingParticipants": {
		programId: programId("Hospitality training"),
		personIds: [byName("Alex Rivera").id],
	},
	"teams.listTraining": {},
	"teams.personTraining": { personId: byName("Sam Patel").id },
	"teams.trainingHistory": { personId: byName("Alex Rivera").id },
	"teams.personAssignments": { personId: byName("Sam Patel").id },
	"teams.membershipHistory": { teamId: teamId("Hospitality") },
	"teams.history": { teamId: teamId("Hospitality") },
	"teams.listRoles": { teamId: teamId("Hospitality") },
	"teams.leaderCandidates": { q: "Casey" },
	"teams.orgChart": {},
	"teams.exportOrgChart": {},
	"teams.listImportTemplates": {},
	"teams.previewTemplateImport": { selections: [{ teamKey: "prayer", roleKeys: ["prayer_lead"] }] },
	"teams.listResponsibilities": { teamId: teamId("Worship") },
	"teams.previewResponsibilities": { teamId: teamId("Worship") },
	"teams.listMeetings": { teamId: teamId("Core team") },
	"seats.list": {},
	"seats.listInvitations": () =>
		invokeRead(church.db, church.actors.owner, adapters.get("seats.listInvitations")!, {}, nativePorts()),
	"privacy.getSharing": {},
	[catalog.SELECT_RETURNED_ROWS]: async () => {
		const list = await read("people.listPeople", {});
		return { ...list, operation: catalog.SELECT_RETURNED_ROWS, rows: list.rows.slice(0, 2), total: 2 };
	},
};

/** The catalog's own model tools: every exported "evry.…" name in catalog.ts, beside the adapters' reads. */
const catalogTools = Object.values(catalog).filter((v): v is string => typeof v === "string" && v.startsWith("evry."));
const installed = [
	...Object.values(catalog.READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation)),
	...catalogTools,
];

test("INV-result-card-views: every installed read and catalog tool has its own card title and count words", async () => {
	assert.ok(catalogTools.includes("evry.selectReturnedRows"));
	const problems: string[] = [];
	for (const operation of installed) {
		const probe = PROBES[operation];
		if (!probe) {
			problems.push(`${operation}: no probe in result-cards.test.mts`);
			continue;
		}
		const result = typeof probe === "function" ? await probe() : await read(operation, probe);
		if (!result.rows.length) problems.push(`${operation}: the probe returned no rows`);
		const view = cardView(operation, result, null);
		if (view.title === FALLBACK.title) problems.push(`${operation}: falls back to the "${FALLBACK.title}" card`);
		// "N people" counts the person rows the card shows; a count answer shows no rows and counts its total.
		const persons = view.rows.filter((r) => r.avatar === "person" || r.href?.startsWith("/people/")).length;
		const counted = /^([\d,]+) (?:person|people)$/.exec(view.summary);
		if (counted && view.rows.length && Number(counted[1]!.replaceAll(",", "")) !== persons)
			problems.push(`${operation}: "${view.summary}" but the card shows ${persons} person rows`);
		const words = [view.title, ...view.facts].join(" ");
		if (/\b(person|people)\b/i.test(words) && view.rows.length && !persons)
			problems.push(`${operation}: speaks of people but shows no person row: ${words}`);
	}
	assert.deepEqual(problems, []);
});
