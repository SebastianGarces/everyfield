import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mount } from "../evry/fake-dom.mts";

const noAction = async () => assert.fail("no action runs while rendering");
mock.module(new URL("../../../apps/web/src/features/people/actions.ts", import.meta.url).href, {
	namedExports: { reorderPipeline: noAction, changeStatus: noAction },
});
const { PipelineBoard } = await import("../../../apps/web/src/features/people/PipelineBoard.tsx");
const { parseQuery } = await import("../../../apps/web/src/features/people/model.ts");

const COLUMNS = ["prospect", "attendee", "following_up", "interviewed", "core_group"] as const;
const board = (revision: string, names: readonly string[]) => ({
	groups: COLUMNS.map((column) => ({
		column,
		revision,
		total: names.length,
		next: null,
		cards: names.map((displayName) => ({
			person: {
				id: `${column}-${displayName}`,
				revision,
				displayName,
				stage: column,
				createdAt: "2026-10-21T12:00:00Z",
			},
			activeParentDuties: [],
			inactivity: { lastActivityAt: "2026-10-21T12:00:00Z", level: "none" },
		})),
	})),
});

test("INV-pipeline-columns: a refreshed pipeline keeps every column's element, so focus and the last reorder message stay", async () => {
	const props = { query: parseQuery(new URLSearchParams()), canWrite: false };
	const page = await mount(PipelineBoard, { ...props, pipeline: board("1", ["Ana Lee"]) });
	const columns = () => page.all().filter((n) => n.getAttribute("data-revision") !== null);
	const messages = () => page.all().filter((n) => n.tagName === "P" && n.getAttribute("role") === "status");
	const before = { columns: columns(), messages: messages() };
	assert.equal(before.columns.length, COLUMNS.length);
	assert.equal(before.messages.length, COLUMNS.length);

	await page.update({ ...props, pipeline: board("2", ["Ana Lee", "Ben Cho"]) });
	assert.ok(page.text().includes("Ben Cho"), "the refreshed cards are shown");
	assert.deepEqual(
		columns().map((n) => n.getAttribute("data-revision")),
		COLUMNS.map(() => "2"),
	);
	assert.ok(
		columns().every((n, i) => n === before.columns[i]),
		"each column keeps its element",
	);
	assert.ok(
		messages().every((n, i) => n === before.messages[i]),
		"each column keeps its reorder message",
	);
	await page.unmount();
});
