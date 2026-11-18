import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { machines } from "../../../packages/contracts/src/machines/index.ts";

const tool = resolve(import.meta.dirname, "../machines.ts");
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
	for (const m of machines) put(m.proof, "");
	put(writer, guarded);
	put(schema, tables(columns));
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", "main"], { cwd: root });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
	const cli = (...args: string[]) => spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
	return { root, put, cli, close: () => rmSync(root, { recursive: true, force: true }) };
}

const schema = "packages/db/src/schema/tables.ts";
const meetingStates = ["planning", "ready", "in_progress", "completed", "cancelled"];
const columns: Record<string, Record<string, string[]>> = {
	meeting: { status: meetingStates },
	launch: { state: ["draft", "open", "closed"] },
	task: { status: ["todo", "doing", "blocked", "done"] },
};
const tables = (shape: Record<string, Record<string, string[]>>) =>
	Object.entries(shape)
		.map(
			([table, cols]) =>
				`export const ${table} = pgTable("${table}", {\n\tid: uuid("id").notNull(),\n${Object.entries(cols)
					.map(([col, values]) => `\t${col}: text("${col}", { enum: ${JSON.stringify(values)} }).notNull(),\n`)
					.join("")}});\n`,
		)
		.join("");

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
				"drizzle update filtered inside or",
				a,
				"tx.update(tables.meeting).set({ status: to }).where(or(eq(tables.meeting.id, id), inArray(tables.meeting.status, fromStates(meetingStatusMachine, e, to, m))));",
				/a\.ts:1: drizzle writes/,
			],
			[
				"drizzle update filtered on another column",
				a,
				"tx.update(tables.meeting).set({ status: to }).where(inArray(tables.meeting.type, fromStates(meetingStatusMachine, e, to, m)));",
				/a\.ts:1: drizzle writes/,
			],
			[
				"drizzle insert whose spread comes after the initial state",
				a,
				"tx.insert(tables.meeting).values({ status: 'planning', ...row });",
				/a\.ts:1: drizzle writes/,
			],
			[
				"drizzle update with a computed key",
				a,
				"tx.update(tables.meeting).set({ ['status']: 'cancelled' });",
				/a\.ts:1: drizzle writes/,
			],
			[
				"unguarded update beside a guarded one in the same SQL text",
				a,
				"sql`WITH a AS (UPDATE meeting SET status = ${to} WHERE status = ANY(${sql.param(fromStates(meetingStatusMachine, e, to, m))}::text[]) RETURNING 1), b AS (UPDATE meeting SET status = 'ready' WHERE id = ${id} RETURNING 1) SELECT 1`",
				/a\.ts:1: update writes/,
			],
			[
				"update whose filter sits in a later statement",
				a,
				"sql`UPDATE meeting SET status = 'ready' WHERE id = ${id}; SELECT 1 FROM meeting WHERE status = ANY(${fromStates(meetingStatusMachine, e, to, m)})`",
				/a\.ts:1: update writes/,
			],
			[
				"filter for another target than the one written",
				a,
				"tx.update(tables.meeting).set({ status: 'ready' }).where(inArray(tables.meeting.status, fromStates(meetingStatusMachine, 'meetings.changeStatus', 'cancelled', m)));",
				/a\.ts:1: drizzle writes/,
			],
			[
				"filter for an event with no move to the state written",
				a,
				"sql`UPDATE meeting SET status = 'ready' WHERE status = ANY(${fromStates(meetingStatusMachine, 'meetings.completePractice', to, m)})`",
				/a\.ts:1: update writes/,
			],
			[
				"drizzle update through a table alias",
				a,
				"const mt = tables.meeting;\ntx.update(mt).set({ status: 'ready' });",
				/a\.ts:2: drizzle writes/,
			],
			[
				"drizzle update through a split chain",
				a,
				"const q = tx.update(tables.meeting);\nq.set({ status: 'ready' });",
				/a\.ts:2: drizzle writes/,
			],
			[
				"drizzle insert that updates the state on conflict",
				a,
				"tx.insert(tables.meeting).values({ ...row, status: 'planning' }).onConflictDoUpdate({ target: tables.meeting.id, set: { status: 'ready' } });",
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
		r.put(
			"packages/other/src/b.ts",
			[
				"tx.update(tables.meeting).set({ status: to }).where(and(eq(tables.meeting.id, id), inArray(tables.meeting.status, fromStates(meetingStatusMachine, e, to, m))));",
				"tx.insert(tables.meeting).values({ ...row, status: 'planning' });",
				"const mt = tables.meeting;",
				"tx.update(mt).set({ status: 'ready' }).where(inArray(mt.status, fromStates(meetingStatusMachine, 'meetings.changeStatus', 'ready', m)));",
			].join("\n"),
		);
		assert.equal(r.cli("--write").status, 0);
		assert.equal(r.cli("--check").status, 0, "a filtered Drizzle update and an initial Drizzle insert are guarded");
		const writers = r.cli("census").stdout;
		assert.match(writers, /packages\/other\/src\/b\.ts:1 drizzle guard=from-state filter/);
		assert.match(writers, /packages\/other\/src\/b\.ts:2 drizzle guard=initial state/);
		assert.match(writers, /packages\/other\/src\/b\.ts:4 drizzle guard=from-state filter/);
	} finally {
		r.close();
	}
});

test("INV-machines: a SQL function writer is guarded only by its edge's locking read, and a copy only by entry states", () => {
	const r = repo();
	try {
		const fn = (lock: string, name = "settings_purge_subject", to = "purged", where = "id=witness") =>
			[
				`CREATE FUNCTION ${name}(witness uuid,request uuid,expected bigint) RETURNS void`,
				"LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$",
				"DECLARE w lifecycle_witness%ROWTYPE;",
				"BEGIN",
				` SELECT * INTO w FROM lifecycle_witness WHERE id=witness AND request_id=request AND ${lock} FOR UPDATE;`,
				" IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;",
				` UPDATE lifecycle_witness SET state='${to}',witness_checkpoint=witness_checkpoint+1 WHERE ${where};`,
				"END $$;",
			].join("\n");
		const migration = "packages/db/migrations/0999_purge.sql";
		const copy = "ops/maintenance/copy.mts";
		const guarded: Record<string, string> = {
			[migration]: fn("state='purging' AND cancel_until<=clock_timestamp()"),
			[copy]:
				"sql`INSERT INTO lifecycle_witness SELECT * FROM json_populate_recordset(NULL::lifecycle_witness, ${rows}::json) r WHERE r.state = ANY(${sql.param(entryStates(deletionMachine, OPERATION))}::text[])`;",
		};
		for (const [file, source] of Object.entries(guarded)) r.put(file, source);
		assert.equal(r.cli("--write").status, 0);
		assert.equal(r.cli("--check").status, 0, "the declared purge function and a filtered copy are guarded");
		const unguarded: [string, string, string, RegExp][] = [
			["function locking another state", migration, fn("state='pending_deletion'"), /0999_purge\.sql:7: update writes/],
			["function locking a state list", migration, fn("state IN ('purging','pending_deletion')"), /0999_purge\.sql:7/],
			["function no edge names", migration, fn("state='purging'", "settings_other"), /0999_purge\.sql:7/],
			["function writing another state", migration, fn("state='purging'", undefined, "cancelled"), /0999_purge\.sql:7/],
			[
				"copy filtered on from-states",
				copy,
				"sql`INSERT INTO lifecycle_witness SELECT * FROM json_populate_recordset(NULL::lifecycle_witness, ${rows}::json) r WHERE r.state = ANY(${fromStates(deletionMachine, e, to, w)})`;",
				/copy\.mts:1: insert writes/,
			],
			[
				"function updating rows other than the locked one",
				migration,
				fn("state='purging'", undefined, undefined, "kind='account'"),
				/0999_purge\.sql:7/,
			],
			[
				"copy whose filter belongs to another statement",
				copy,
				"sql`WITH c AS (INSERT INTO lifecycle_witness SELECT * FROM json_populate_recordset(NULL::lifecycle_witness, ${rows}::json) RETURNING 1) SELECT 1 FROM lifecycle_witness r WHERE r.state = ANY(${sql.param(entryStates(deletionMachine, OPERATION))}::text[])`;",
				/copy\.mts:1: insert writes/,
			],
			[
				"copy filtered on another event's entry states",
				copy,
				"sql`INSERT INTO lifecycle_witness SELECT * FROM json_populate_recordset(NULL::lifecycle_witness, ${rows}::json) r WHERE r.state = ANY(${entryStates(deletionMachine, 'lifecycle.purge')})`;",
				/copy\.mts:1: insert writes/,
			],
			[
				"copy with no filter",
				copy,
				"sql`INSERT INTO lifecycle_witness SELECT * FROM json_populate_recordset(NULL::lifecycle_witness, ${rows}::json)`;",
				/copy\.mts:1: insert writes/,
			],
		];
		for (const [name, file, source, expected] of unguarded) {
			r.put(file, source);
			const result = r.cli("--check");
			assert.equal(result.status, 1, name);
			assert.match(result.stderr, expected, name);
			assert.equal(result.stderr.match(/ writes lifecycle_witness\.state /g)?.length, 1, name);
			r.put(file, guarded[file]!);
		}
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

test("INV-machines: --check refuses a changed or new 4+ state column with no machine table, naming the column, its values and the file to add", () => {
	const r = repo();
	try {
		assert.equal(r.cli("--write").status, 0);
		r.put(schema, tables({ ...columns, launch: { state: ["draft", "open", "closed", "archived"] } }));
		const fourth = r.cli("--check");
		assert.equal(fourth.status, 1);
		assert.equal(
			fourth.stderr.trim(),
			`${schema}: launch.state has 4 states (draft, open, closed, archived) and no machine table. Add packages/contracts/src/machines/launch-state.ts with table "launch" and column "state", export it from packages/contracts/src/machines/index.ts, then run node tools/ci/machines.ts --write.`,
		);

		r.put(schema, tables({ ...columns, mail: { delivery_status: ["queued", "sent", "bounced", "failed"] } }));
		const added = r.cli("--check");
		assert.equal(added.status, 1);
		assert.match(
			added.stderr,
			/mail\.delivery_status has 4 states \(queued, sent, bounced, failed\) and no machine table\. Add packages\/contracts\/src\/machines\/mail-delivery-status\.ts/,
		);
	} finally {
		r.close();
	}
});

test("INV-machines: --check passes a 3-state column, a 4+ value column of another name, an unchanged unmachined column and a machined column's new values", () => {
	const r = repo();
	try {
		assert.equal(r.cli("--write").status, 0);
		const passing: [string, Record<string, Record<string, string[]>>][] = [
			["unchanged main", columns],
			["3-state column", { ...columns, launch: { state: ["draft", "open", "archived"] } }],
			[
				"4+ values under other names",
				{
					...columns,
					thing: {
						kind: ["a", "b", "c", "d"],
						category: ["a", "b", "c", "d"],
						priority: ["a", "b", "c", "d"],
						statuses: ["a", "b", "c", "d"],
					},
				},
			],
			[
				"reordered values of an unmachined column",
				{ ...columns, task: { status: ["done", "todo", "doing", "blocked"] } },
			],
			["machined column's values", { ...columns, meeting: { status: [...meetingStates, "postponed"] } }],
		];
		for (const [name, shape] of passing) {
			r.put(schema, tables(shape));
			const result = r.cli("--check");
			assert.equal(result.status, 0, `${name}: ${result.stderr}`);
		}
	} finally {
		r.close();
	}
});

test("INV-machines: --check fails and says so when there is no merge base with origin/main", () => {
	const r = repo();
	try {
		assert.equal(r.cli("--write").status, 0);
		execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: r.root });
		const result = r.cli("--check");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /no merge base with origin\/main \(run git fetch origin main\)/);
	} finally {
		r.close();
	}
});
