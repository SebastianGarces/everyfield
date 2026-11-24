import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { pipelineGoals } from "../../../packages/contracts/src/organizations/pipeline.ts";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const noAction = () => assert.fail("no action runs while rendering");
mock.module(new URL("../../../apps/web/src/features/organizations/board/actions.ts", import.meta.url).href, {
	namedExports: { saveGoal: noAction },
});
const { GoalsArea } = await import("../../../apps/web/src/features/organizations/board/GoalsArea.tsx");

const unavailable = { status: "unavailable", reason: "deferred_stage_3" };

test("INV-counts: plants sent is only ever unavailable, with no number", () => {
	const { plantsSent } = pipelineGoals.shape;
	assert.deepEqual(plantsSent.parse(unavailable), unavailable);
	for (const bad of [0, null, { ...unavailable, count: 0 }, { status: "available", count: 0 }, { count: 0 }])
		assert.equal(plantsSent.safeParse(bad).success, false, JSON.stringify(bad));
});

test("INV-counts: a goal with a plant target and the counts card both read Plants sent as Not available yet, with no digit", () => {
	const data = pipelineGoals.parse({
		asOf: "2026-11-24",
		canEdit: false,
		goals: [
			{
				id: "6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
				revision: "1",
				leaderTarget: 6,
				plantTarget: 2,
				targetYear: 2028,
				rationale: "Develop leaders.",
				countingFrom: "2026-01-01",
				counts: [],
			},
		],
		kinds: [],
		activeResidents: 0,
		plantsSent: unavailable,
		conversations: {
			months: Array.from({ length: 6 }, (_, i) => ({ month: `2026-0${i + 1}`, count: 0 })),
			quarters: Array.from({ length: 4 }, (_, i) => ({ year: 2026, quarter: i + 1, count: 0 })),
		},
	});
	const html: string = renderToStaticMarkup(createElement(GoalsArea, { initial: data }));
	const goal = /<span[^>]*>Plants sent: ([^<]*)<\/span>([^<]*)/.exec(html);
	const card = /<dt[^>]*>Plants sent<\/dt><dd[^>]*>(.*?)<\/dd>/.exec(html);
	assert.equal(goal?.[1], "Not available yet.");
	assert.doesNotMatch(goal![2]!, /\d/);
	assert.equal(card?.[1], "Not available yet");
});
