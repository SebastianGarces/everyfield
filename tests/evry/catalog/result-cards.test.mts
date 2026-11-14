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
import { byName, goldenChurch, IMPORT_KEY, MEETINGS } from "../evals/golden-church.mts";

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
	"meetings.list": { window: "upcoming" },
	"meetings.get": { meetingId: MEETINGS.thursday },
	"meetings.hasHistory": {},
	"meetings.readAgenda": { meetingId: MEETINGS.sunday },
	"meetings.listKit": { meetingId: MEETINGS.thursday, only: "unchecked" },
	"meetings.listGuests": { meetingId: MEETINGS.thursday },
	"meetings.listCards": { meetingId: MEETINGS.lastNight },
	"meetings.cardBreakdown": { meetingId: MEETINGS.lastNight },
	"meetings.invitationAttribution": { meetingId: MEETINGS.thursday },
	"meetings.communicationContext": { meetingId: MEETINGS.thursday },
	"meetings.listCompletedPreLaunchPractices": {},
	"meetings.getOwnRsvp": { meetingId: MEETINGS.thursday },
	"meetings.listAttendance": { meetingId: MEETINGS.lastWeek },
	"meetings.attendanceSummary": { meetingId: MEETINGS.lastNight },
	"meetings.getEvaluation": { meetingId: MEETINGS.earlier },
	"meetings.evaluationHistory": { meetingId: MEETINGS.earlier },
	"meetings.evaluationTrend": {},
	"meetings.compareEvaluation": { meetingId: MEETINGS.earlier },
	"meetings.attendanceTrend": { limit: 3 },
	"meetings.summaryStats": {},
	"meetings.linkedTaskProgress": { meetingId: MEETINGS.lastNight },
	"meetings.readAnalytics": { meetingId: MEETINGS.lastNight },
	"meetings.previewRosterImport": { meetingId: MEETINGS.training },
	"venues.list": {},
	"venues.get": { venueId: MEETINGS.coffee },
	"venues.history": { venueId: MEETINGS.coffee },
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
