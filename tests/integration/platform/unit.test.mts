import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedBody } from "../../../packages/domain/src/operations/index.ts";
import { safeBoundary, safeResponse } from "../../../apps/web/src/server/platform/boundary.ts";
import { DrizzleQueryError } from "../../../packages/db/src/query.ts";
import { asLogHost, asLogId, asLogWord, logFailure, logLine } from "../../../packages/domain/src/log.ts";
import { createRequire } from "node:module";
import { LOST, transient } from "../../../apps/web/src/server/platform/transient.ts";

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
	logLine({
		host: asLogHost(canary),
		named: asLogHost("cloud.langfuse.com"),
		local: asLogHost("127.0.0.1:3000"),
		v6: asLogHost("[::1]:3000"),
	});
	assert.deepEqual(
		lines.map((line) => JSON.parse(line)),
		[
			{ component: "people", outcome: "write_failed", error: { name: "DrizzleQueryError", code: "23505" } },
			{ component: "people", outcome: "read_failed", error: { name: "Error", code: null } },
			{ component: "people", outcome: "thrown", error: { name: "string", code: null } },
			{ component: "people", outcome: "named", error: { name: "Error", code: null } },
			{ component: "not-a-word", id: "not-an-id", word: "people-import" },
			{ host: "not-a-host", named: "cloud.langfuse.com", local: "127.0.0.1:3000", v6: "not-a-host" },
		],
	);
	assert.equal(lines.join("\n").includes("canary"), false);
});

test("INV-privacy: a failure that is not transient leaves the server without its statement, values or text", async (t) => {
	const lines: string[] = [];
	t.mock.method(console, "error", (line: string) => void lines.push(line));
	const canary = "typed.by.a.person@example.test";
	const statement = `insert into person (email) values ($1) returning ${canary}`;
	const cause = Object.assign(new DatabaseError(`permission denied for table person ${canary}`, 0, "error"), {
		code: "42501",
		detail: `Failing row contains (${canary}).`,
	});
	const thrown = await transient(
		{ component: "people", outcome: "write_failed" },
		() => Promise.reject(new DrizzleQueryError(statement, [canary], cause)),
		LOST,
	).then(
		() => assert.fail("a permission failure is not answered as lost"),
		(error: unknown) => error,
	);
	assert.ok(thrown instanceof Error);
	assert.deepEqual(
		[thrown.name, thrown.message, thrown.cause, thrown.stack?.includes(canary)],
		["ServerFailure", "server_failure", undefined, false],
	);
	assert.deepEqual(
		lines.map((line) => JSON.parse(line)),
		[{ component: "people", outcome: "write_failed", error: { name: "DrizzleQueryError", code: "42501" } }],
	);
	const transientCause = Object.assign(new DatabaseError("terminating connection", 0, "error"), { code: "57P01" });
	assert.deepEqual(
		await transient({ component: "people", outcome: "write_failed" }, () => Promise.reject(transientCause), LOST),
		LOST,
	);
	assert.equal([...lines, String(Object.keys(thrown))].join("\n").includes(canary), false);
	assert.equal(lines.join("\n").includes("insert into"), false);
});
