// INV-result-card-views (T-160): every read the catalog installs, and the catalog's own tools, has a result card of its
// own. Each operation is answered by the eval church (golden-church.mts, no database) and drawn with the card's view:
// no card may fall back to the generic "Records" title, and no card may count in "person/people" words unless every row
// it shows is a person. A new read operation or catalog tool fails here until it has a view and a probe below.
import test from "node:test";
import assert from "node:assert/strict";
import * as catalog from "../../../packages/evry/src/catalog/catalog.ts";
import type { SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import { cardView, FALLBACK } from "../../../apps/web/src/features/evry/conversation/resultView.ts";
import { ACTORS, answerRead, byName, IMPORT_KEY } from "../evals/golden-church.mts";

const { actor, church } = ACTORS.owner;
const JAMES = byName("James Okafor").id;
/** Has a household, a tag and a skill. */
const MARK = byName("Mark Thompson").id;
const FILE = "first_name,last_name,email\r\nAda,Park,ada@example.test\r\n,,\r\nJames,Okafor,\r\n";

/** The input each operation is probed with. A catalog tool has a function that builds its result instead. */
const PROBES: Record<string, Record<string, unknown> | (() => SourceResult)> = {
	"people.listPeople": {},
	"people.getPerson": { personId: JAMES },
	"people.getPersonPhoto": { personId: JAMES },
	"people.checkForDuplicates": { displayName: "James Okafor" },
	"people.exportPeople": {},
	"people.generateCsvTemplate": {},
	"people.getActivities": { personId: JAMES },
	"people.getHousehold": { personId: JAMES },
	"people.getHouseholdMembers": { personId: JAMES },
	"people.getImportReceipt": { requestKey: IMPORT_KEY },
	"people.getPersonSkills": { personId: MARK },
	"people.getPersonTags": { personId: MARK },
	"people.getPipelineData": {},
	"people.listHouseholds": {},
	"people.listTags": {},
	"people.previewImport": { file: FILE },
	[catalog.SELECT_RETURNED_ROWS]: () => {
		const list = answerRead(actor, church, "people.listPeople", {});
		return { ...list, operation: catalog.SELECT_RETURNED_ROWS, rows: list.rows.slice(0, 2), total: 2 };
	},
};

/** The catalog's own model tools: every exported "evry.…" name in catalog.ts, beside the adapters' reads. */
const catalogTools = Object.values(catalog).filter((v): v is string => typeof v === "string" && v.startsWith("evry."));
const installed = [
	...Object.values(catalog.READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation)),
	...catalogTools,
];

test("INV-result-card-views: every installed read and catalog tool has its own card title and count words", () => {
	assert.ok(catalogTools.includes("evry.selectReturnedRows"));
	const problems: string[] = [];
	for (const operation of installed) {
		const probe = PROBES[operation];
		if (!probe) {
			problems.push(`${operation}: no probe in result-cards.test.mts`);
			continue;
		}
		const result = typeof probe === "function" ? probe() : answerRead(actor, church, operation, probe);
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
