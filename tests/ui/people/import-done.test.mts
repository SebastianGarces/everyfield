// BUG-551 (people/peo-7, people/peo-20): what a partial People CSV import says about its rows.
//   peo-20: the progress bar counts each row once. A row the job could not write is in both counts.failed and
//     counts.remaining, so the bar counts rows, not the sum of the counts.
//   peo-7: the Done screen's "Did not save" is every row still to write (the ones the job could not write and the
//     ones it never reached), and each of them is in "Rows not imported" with its row number and reason.
//
// It renders the real DoneStep in node, with no browser and no database. It runs from packages/domain's test:unit:
// tsx --tsconfig ../../tests/ui/render.tsconfig.json --test <this file>.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
// Go to People links through the app router; a router that goes nowhere stands in for the mounted one.
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const { DoneStep } = await import("../../../apps/web/src/features/people/import-export/ImportSteps.tsx");
const { progressOf } = await import("../../../apps/web/src/features/people/import-export/model.ts");

const PERSON = "0b6c3f1e-2a7d-4c3b-9f5e-1d2c3b4a5f60";
/** A job that ended partway: row 1 added, row 2 needs a fix, row 3 failed to write, rows 4 and 5 never reached, row 6
 * skipped. counts.remaining holds rows 3, 4 and 5; counts.failed holds rows 2 and 3. */
const receipt = {
	importId: "1c7d4f2a-3b8e-4d4c-8a6f-2e3d4c5b6a71",
	status: "partial",
	fileKept: true,
	rows: [
		{ row: 1, status: "created", personId: PERSON, reviewWith: null },
		{ row: 2, status: "failed", reason: "invalid", problems: [{ code: "name_required", column: null }] },
		{ row: 3, status: "failed", reason: "row_write_failed", problems: [] },
		{ row: 4, status: "remaining" },
		{ row: 5, status: "remaining" },
		{ row: 6, status: "skipped" },
	],
	remaining: [3, 4, 5],
	counts: { created: 1, skipped: 1, failed: 2, remaining: 3 },
} as const;

/** The visible text of the markup, tags dropped and whitespace collapsed. */
const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

test("BUG-PR551 (people/peo-20): the progress bar counts every row once, a failed-and-remaining row included", () => {
	assert.deepEqual(progressOf(receipt as never), { done: 4, total: 6 });
	const running = {
		...receipt,
		status: "in_progress",
		rows: receipt.rows.map((r) => ({ row: r.row, status: "remaining" })),
	};
	assert.deepEqual(progressOf(running as never), { done: 0, total: 6 });
});

test("BUG-PR551 (people/peo-7): a partial Done screen lists every row that did not save, unreached rows included", () => {
	const html: string = renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{ value: router },
			createElement(DoneStep, {
				heading: { current: null },
				receipt,
				review: null,
				working: false,
				problem: null,
				onRetry: () => {},
				onStartOver: () => {},
			}),
		),
	);
	const page = text(html);
	assert.match(page, /1 person added\. 3 rows did not save\./);
	assert.match(page, /Try 3 rows again/);
	for (const [label, value] of [
		["Added", 1],
		["Skipped", 1],
		["Did not save", 3],
		["Needed a fix", 1],
	])
		assert.match(page, new RegExp(`${label} ${value} `), label);

	const list = html.match(/<ul aria-label="Rows not imported"[^>]*>(.*?)<\/ul>/s);
	assert.ok(list, "the Rows not imported list shows");
	const items = [...list[1].matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => text(m[1]));
	assert.deepEqual(items, [
		"Row 2 Needs a fix Add a first or last name",
		"Row 3 Not saved Could not be saved. Try it again.",
		"Row 4 Not saved Not reached. Try it again.",
		"Row 5 Not saved Not reached. Try it again.",
	]);
});

// T-193 (people/peo-24): a complete import with flagged rows says how many to review and links to Duplicates; one with
// none keeps its plain line, and a partial import keeps its retry message.
const done = (r: unknown, problem: unknown = null) =>
	renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{ value: router },
			createElement(DoneStep, {
				heading: { current: null },
				receipt: r,
				review: null,
				working: false,
				problem,
				onRetry: () => {},
				onStartOver: () => {},
			}),
		),
	) as string;
const complete = (reviewWith: (string | null)[]) => ({
	importId: receipt.importId,
	status: "complete",
	fileKept: false,
	rows: reviewWith.map((w, i) => ({ row: i + 1, status: "created", personId: PERSON, reviewWith: w })),
	remaining: [],
	counts: { created: reviewWith.length, skipped: 0, failed: 0, remaining: 0 },
});

test("T-193 (people/peo-24): the Done screen says how many to review in Duplicates, or that everyone is in People", () => {
	const none = text(done(complete([null, null])));
	assert.match(none, /2 people added Everyone you chose is in People now\./);
	assert.doesNotMatch(none, /to review/);

	const one = done(complete([PERSON]));
	assert.match(text(one), /1 person added 1 to review in Duplicates ?\./);
	assert.match(one, /<a[^>]*href="\/people\/duplicates"[^>]*>Duplicates<\/a>\./);

	const three = text(done(complete([PERSON, PERSON, null, PERSON])));
	assert.match(three, /4 people added 3 to review in Duplicates ?\./);

	const partial = text(
		done({
			...receipt,
			rows: [{ row: 1, status: "created", personId: PERSON, reviewWith: PERSON }, ...receipt.rows.slice(1)],
		}),
	);
	assert.match(partial, /The other rows are saved\. Try the rows that did not save again; nobody is added twice\./);
	assert.doesNotMatch(partial, /to review|with a note/);
	for (const page of [none, text(one), three, partial]) assert.doesNotMatch(page, /with a note/);
});

// T-194 (people/peo-48): a partial import offers "Try N rows again" while the server keeps its file. Once the file is
// deleted, it says to upload the file again and offers the file chooser instead; a refused file shows why there.
const partialDone = (fileKept: boolean, problem: unknown = null) => done({ ...receipt, fileKept }, problem);

test("T-194 (people/peo-48): the expired Done screen says to upload the file again and offers the file, not the button", () => {
	const kept = text(partialDone(true));
	assert.match(kept, /Try 3 rows again/);
	assert.doesNotMatch(kept, /Upload the file again/);

	const html = partialDone(false);
	const expired = text(html);
	assert.match(
		expired,
		/1 person added\. 3 rows did not save\. Upload the file again to finish the remaining 3 rows\./,
	);
	assert.doesNotMatch(expired, /Try 3 rows again/);
	assert.match(html, /<input[^>]*type="file"[^>]*aria-label="Choose the file this import used"/);
	assert.match(expired, /Choose the file/);

	const refused = text(
		partialDone(false, {
			title: "This is not the file this import used",
			text: "Choose the same CSV file you imported, without changes. Nothing was saved.",
		}),
	);
	assert.match(refused, /This is not the file this import used/);
	assert.match(refused, /Upload the file again to finish the remaining 3 rows\./);
});
