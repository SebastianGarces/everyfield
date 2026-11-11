import test from "node:test";
import assert from "node:assert/strict";
import { safeReturn } from "../../../packages/domain/src/access/security.ts";

test("INV-boundary: safe local returns", () => {
	assert.equal(safeReturn("/people?sort=name"), "/people?sort=name");
	for (const path of ["https://foreign.test", "//foreign.test", "/%255cforeign", "/%250aheader", "/\\foreign"])
		assert.equal(safeReturn(path), null);
});
