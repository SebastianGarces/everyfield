import assert from "node:assert/strict";
import { test } from "node:test";
import {
	afterImport,
	importRequest,
	NOBODY,
	revised,
	type Review,
} from "../../../apps/web/src/features/organizations/import/model.ts";

const review: Review = {
	file: new File(["Name\nJordan Reyes\n"], "people.csv"),
	preview: {
		fileDigest: "f",
		reviewDigest: "r",
		columns: [{ title: "Name", choice: "name", locked: false }],
		rows: [],
		counts: { rows: 1, ready: 1, duplicates: 0, invalid: 0 },
	} as unknown as Review["preview"],
	stageId: "stage-1",
	seatId: NOBODY,
	decisions: new Map(),
	importId: "4a1f7c2e-0b3d-4e5f-8a9b-1c2d3e4f5a6b",
	checking: false,
	problem: null,
};

test("a retry after a lost reply sends the same import id", () => {
	const first = importRequest(review);
	const back = afterImport(review, { status: "lost" });
	assert.equal(back.step, "review");
	assert.ok(back.review.problem, "the lost reply is explained");
	assert.deepEqual(importRequest(back.review), first);
	const refused = afterImport(back.review, { status: "refused", refusal: { code: "review_stale" } });
	assert.equal(importRequest(refused.review).importId, first.importId);
});

test("a change to the stage, staff, decisions or preview makes a new import id", () => {
	const ids = new Set([
		review.importId,
		revised(review, { stageId: "stage-2" }).importId,
		revised(review, { seatId: "seat-1" }).importId,
		revised(review, { decisions: new Map([[1, "add"]]) }).importId,
		revised(review, { preview: review.preview }).importId,
	]);
	assert.equal(ids.size, 5);
	assert.equal(importRequest(revised(review, { seatId: "seat-1" })).responsibleSeatId, "seat-1");
});
