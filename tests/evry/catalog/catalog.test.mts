import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { READ_DOMAINS, SELECT_RETURNED_ROWS } from "../../../packages/evry/src/catalog/catalog.ts";

const read = (path: string) =>
	JSON.parse(readFileSync(new URL(`../../../docs/catalog/${path}`, import.meta.url), "utf8"));
const operations = new Map<string, Record<string, unknown>>(
	(read("operations.json").operations ?? read("operations.json")).map((o: Record<string, unknown>) => [o.id, o]),
);
const generated = new Set<string>(read("evry-tools.json").operation_ids);

test("AC:INH-REGRESSION-CAPABILITIES INV-catalog: every installed model tool is a flagged, generated, read-only operation", () => {
	const installed = [
		...Object.values(READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation)),
		SELECT_RETURNED_ROWS,
	];
	assert.deepEqual(installed, ["people.listPeople", "people.getPerson", "evry.selectReturnedRows"]);
	for (const id of installed) {
		const op = operations.get(id);
		assert.ok(op, id);
		assert.deepEqual([op.model_tool, op.kind, op.durable_write, generated.has(id)], [true, "query", false, true], id);
	}
	// Runtime operations that are not model tools stay out of the model's reach.
	for (const id of ["evry.submitTurn", "evry.cancelTurn", "evry.selectQualifiedModel", "access.checkOperation"])
		assert.equal(operations.get(id)?.model_tool, false, id);
});
