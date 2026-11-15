import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const tool = resolve(import.meta.dirname, "../machines.ts");
const proof = "tests/integration/meetings/status-machine.test.mts";
const writer = "packages/domain/src/meetings/meetings.ts";

const guarded = [
	"const insert = sql`INSERT INTO meeting (id, status) VALUES (${id}::uuid, 'planning')`;",
	"const move = sql`UPDATE meeting SET status = ${to}, ${set} WHERE id = ${id}",
	"\tAND status = ANY(${sql.param(fromStates(meetingStatusMachine, event, to, m))}::text[])`;",
	"const edit = sql`UPDATE meeting SET ${set} WHERE id = ${id}`;",
	"const title = sql`title = ${title}`;",
].join("\n");

function repo() {
	const root = mkdtempSync(join(tmpdir(), "machines-"));
	execFileSync("git", ["init", "--quiet", root]);
	const put = (file: string, source: string) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
		execFileSync("git", ["add", file], { cwd: root });
	};
	put(proof, "");
	put(writer, guarded);
	const cli = (...args: string[]) => spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
	return { root, put, cli, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("INV-machines: a guarded writer and a current chart pass; a stale chart and each unguarded writer fail", () => {
	const r = repo();
	try {
		assert.equal(r.cli("--write").status, 0);
		assert.equal(r.cli("--check").status, 0);

		appendFileSync(join(r.root, "docs/machines/meeting-status.md"), "\nedited by hand\n");
		const stale = r.cli("--check");
		assert.equal(stale.status, 1);
		assert.match(stale.stderr, /docs\/machines\/meeting-status\.md differs from its table/);
		assert.equal(r.cli("--write").status, 0);

		const a = "packages/other/src/a.ts";
		const unguarded: [string, string, string, RegExp][] = [
			["update", a, "sql`UPDATE meeting SET status = 'ready' WHERE id = ${id}`", /a\.ts:1: update writes/],
			[
				"update with an unrelated ANY filter",
				a,
				"sql`UPDATE meeting m SET status = ${to} WHERE m.status = ANY(${open})`",
				/a\.ts:1: update writes/,
			],
			[
				"update whose filter only contains a fromStates call",
				a,
				"sql`UPDATE meeting SET status = ${to} WHERE status = ANY(${[...fromStates(meetingStatusMachine, e, to, m), 'cancelled']})`",
				/a\.ts:1: update writes/,
			],
			[
				"update filtered by another machine's states",
				a,
				"sql`UPDATE meeting SET status = ${to} WHERE status = ANY(${sql.param(fromStates(otherMachine, e, to, m))})`",
				/a\.ts:1: update writes/,
			],
			[
				"schema-qualified update",
				a,
				"sql`UPDATE public.meeting SET status = 'ready' WHERE id = ${id}`",
				/a\.ts:1: update writes/,
			],
			[
				"update with a column name built at runtime",
				a,
				"sql`UPDATE meeting SET ${sql.identifier('status')} = 'ready' WHERE id = ${id}`",
				/a\.ts:1: update writes/,
			],
			[
				"update assembled by concatenation",
				a,
				"const q = 'UPDATE meeting SET ' + \"status = 'ready'\";",
				/a\.ts:1: update writes/,
			],
			[
				"insert of a non-initial state",
				a,
				"sql`INSERT INTO meeting (id, status) VALUES (${id}, 'completed')`",
				/a\.ts:1: insert writes/,
			],
			[
				"insert with a column list built at runtime",
				a,
				"sql`INSERT INTO meeting ${columns}`",
				/a\.ts:1: insert writes/,
			],
			[
				"set fragment beside a dynamic update",
				a,
				"sql`UPDATE meeting SET ${set} WHERE id = ${id}`;\nconst set = sql`status = ${to}`;",
				/a\.ts:2: set fragment writes/,
			],
			[
				"CASE set fragment beside a dynamic update",
				a,
				"sql`UPDATE meeting SET ${set} WHERE id = ${id}`;\nconst set = sql`status = CASE WHEN ${x} THEN 'ready' ELSE status END`;",
				/a\.ts:2: set fragment writes/,
			],
			[
				"drizzle update",
				a,
				"tx.update(tables.meeting).set({ status: 'cancelled' }).where(eq(tables.meeting.id, id));",
				/a\.ts:1: drizzle writes/,
			],
			["drizzle update from a variable", a, "tx.update(tables.meeting).set(patch);", /a\.ts:1: drizzle writes/],
			[
				"drizzle update with a computed key",
				a,
				"tx.update(tables.meeting).set({ ['status']: 'cancelled' });",
				/a\.ts:1: drizzle writes/,
			],
			[
				"migration",
				"packages/db/migrations/0999_status.sql",
				"SELECT 1;\nUPDATE meeting SET status = 'cancelled' WHERE retired_at IS NOT NULL;",
				/0999_status\.sql:2: update writes/,
			],
		];
		for (const [name, file, source, expected] of unguarded) {
			r.put(file, source);
			const result = r.cli("--check");
			assert.equal(result.status, 1, name);
			assert.match(result.stderr, expected, name);
			execFileSync("git", ["rm", "-q", "-f", file], { cwd: r.root });
		}
		r.put("packages/other/src/a.test.ts", "sql`UPDATE meeting SET status = 'ready' WHERE id = ${id}`");
		r.put("packages/other/src/a.ts", "sql`UPDATE meeting SET title = ${t} WHERE status = 'ready'`");
		assert.equal(r.cli("--check").status, 0, "test files and reads of the column are not writers");
	} finally {
		r.close();
	}
});

test("INV-machines: the coverage report fails until every declared edge, stay and refusal is observed", () => {
	const r = repo();
	try {
		const file = join(r.root, "observations.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ machine: "meeting-status", kind: "edge", subject: "vision", event: "meetings.schedule", from: null, to: "planning" })}\n`,
		);
		const partial = r.cli("coverage", file);
		assert.equal(partial.status, 1);
		assert.match(
			partial.stdout,
			/^meeting-status: edges 1\/26, stays 0\/1, refusals 0\/55, no-ops 0\/20, states 1\/5$/m,
		);
		assert.match(partial.stdout, /missing: edge meetings\.changeStatus planning ready/);
	} finally {
		r.close();
	}
});
