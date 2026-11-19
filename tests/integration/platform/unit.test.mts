import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedBody } from "../../../packages/domain/src/operations/index.ts";
import { safeBoundary, safeResponse } from "../../../apps/web/src/server/platform/boundary.ts";
import { DrizzleQueryError } from "../../../packages/db/src/query.ts";
import { asLogId, asLogWord, logFailure, logLine } from "../../../packages/domain/src/log.ts";
import { createRequire } from "node:module";

const { DatabaseError } = createRequire(new URL("../../../packages/db/package.json", import.meta.url))("pg");

test("INV-request-boundary: bounded bodies and safe errors", async () => {
	const request = new Request("https://preview.localhost/path", { method: "POST" });
	assert.equal(
		Buffer.from(
			(await readBoundedBody(new Request(request.url, { method: "POST", body: "1234" }), 4)) ?? [],
		).toString(),
		"1234",
	);
	assert.equal(await readBoundedBody(new Request(request.url, { method: "POST", body: "12345" }), 4), null);
	const response = await safeBoundary(async () => {
		throw new Error("DB-SECRET-CANARY private-care details");
	});
	assert.equal(response.status, 503);
	assert.equal((await response.json()).code, "unavailable");
	const success = await safeBoundary(async () => safeResponse({ revision: "2" }));
	assert.deepEqual(await success.json(), { revision: "2" });
	assert.equal(success.headers.get("cache-control"), "private, no-store");
});

test("INV-privacy: a failed statement's values and an error's text never reach the server log", (t) => {
	const lines: string[] = [];
	t.mock.method(console, "error", (line: string) => void lines.push(line));
	const canary = "canary.person@example.test";
	const cause = Object.assign(
		new DatabaseError(`duplicate key value violates unique constraint ${canary}`, 0, "error"),
		{
			code: "23505",
			detail: `Key (email)=(${canary}) already exists.`,
		},
	);
	logFailure(
		{ component: "people", outcome: "write_failed" },
		new DrizzleQueryError(`insert ${canary}`, [canary], cause),
	);
	logFailure({ component: "people", outcome: "read_failed" }, new Error(`lookup ${canary}`));
	logFailure({ component: "people", outcome: "thrown" }, canary);
	logFailure({ component: "people", outcome: "named" }, Object.assign(new Error("x"), { name: canary, code: canary }));
	logLine({ component: asLogWord(canary), id: asLogId(canary), word: asLogWord("people-import") });
	assert.deepEqual(
		lines.map((line) => JSON.parse(line)),
		[
			{ component: "people", outcome: "write_failed", error: { name: "DrizzleQueryError", code: "23505" } },
			{ component: "people", outcome: "read_failed", error: { name: "Error", code: null } },
			{ component: "people", outcome: "thrown", error: { name: "string", code: null } },
			{ component: "people", outcome: "named", error: { name: "Error", code: null } },
			{ component: "not-a-word", id: "not-an-id", word: "people-import" },
		],
	);
	assert.equal(lines.join("\n").includes("canary"), false);
});
